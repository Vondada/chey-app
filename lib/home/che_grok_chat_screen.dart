// Native in-app Grok chat — talks to CHE's Worker /api/chat with
// che_provider: 'xai' so routing prefers Grok. Not a WebView of grok.com.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';

class CheGrokChatScreen extends StatefulWidget {
  const CheGrokChatScreen({
    super.key,
    required this.baseUrl,
    required this.deviceToken,
    this.onOpenWeb,
  });

  final String baseUrl;
  final String deviceToken;

  /// Optional overflow action to still open grok.com in the in-app browser.
  final VoidCallback? onOpenWeb;

  static Future<void> open(
    BuildContext context, {
    required String baseUrl,
    required String deviceToken,
    VoidCallback? onOpenWeb,
  }) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => CheGrokChatScreen(
          baseUrl: baseUrl,
          deviceToken: deviceToken,
          onOpenWeb: onOpenWeb,
        ),
      ),
    );
  }

  @override
  State<CheGrokChatScreen> createState() => _CheGrokChatScreenState();
}

class _GrokMessage {
  _GrokMessage({required this.role, required this.text, this.streaming = false});
  final String role; // user | assistant
  String text;
  bool streaming;
}

class _CheGrokChatScreenState extends State<CheGrokChatScreen> {
  final _input = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();
  final List<_GrokMessage> _messages = [];
  bool _busy = false;
  bool _stopRequested = false;
  String? _error;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson, application/json, text/plain',
        'Authorization': 'Bearer ${widget.deviceToken}',
      };

  @override
  void dispose() {
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _stickBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty || _busy) return;
    if (widget.baseUrl.trim().isEmpty || widget.deviceToken.trim().isEmpty) {
      setState(() => _error = 'Pair this device to CHE before chatting with Grok.');
      return;
    }

    setState(() {
      _error = null;
      _busy = true;
      _stopRequested = false;
      _messages.add(_GrokMessage(role: 'user', text: text));
      _messages.add(_GrokMessage(role: 'assistant', text: '', streaming: true));
      _input.clear();
    });
    _stickBottom();
    HapticFeedback.lightImpact();

    final history = <Map<String, String>>[];
    for (final m in _messages) {
      if (m.streaming) continue;
      if (m.role != 'user' && m.role != 'assistant') continue;
      if (m.text.trim().isEmpty) continue;
      history.add({'role': m.role, 'content': m.text});
    }
    // Drop the user turn we just added — Worker treats `message` as current.
    if (history.isNotEmpty &&
        history.last['role'] == 'user' &&
        history.last['content'] == text) {
      history.removeLast();
    }
    if (history.length > 12) history.removeRange(0, history.length - 12);

    final assistant = _messages.last;
    try {
      final request = http.Request('POST', Uri.parse('${widget.baseUrl}/api/chat'));
      request.headers.addAll(_headers);
      request.body = jsonEncode({
        'message': text,
        'history': history,
        'che_provider': 'xai',
        'provider': 'xai',
        'agent_mode': 'chat',
        'owner_mode': true,
        'wake_phrase': 'Chay',
        'client': {
          'platform': 'flutter',
          'surface': 'native_grok_chat',
        },
        'client_time': {
          'local_iso': DateTime.now().toIso8601String(),
          'timezone_name': DateTime.now().timeZoneName,
          'utc_offset_minutes': DateTime.now().timeZoneOffset.inMinutes,
        },
      });

      final response = await request.send().timeout(const Duration(seconds: 75));
      if (response.statusCode == 401) {
        throw Exception('Pair this device again, sir.');
      }
      if (response.statusCode != 200) {
        final body = await response.stream.bytesToString();
        throw Exception('CHE Agent error ${response.statusCode}: $body');
      }

      final complete = StringBuffer();
      await for (final line in response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())) {
        if (_stopRequested) break;
        final trimmed = line.trim();
        if (trimmed.isEmpty) continue;
        dynamic data;
        try {
          data = jsonDecode(trimmed);
        } catch (_) {
          complete.write(trimmed);
          setState(() => assistant.text = complete.toString());
          _stickBottom();
          continue;
        }
        if (data is! Map) continue;
        final type = data['type']?.toString();
        if (type == 'error') {
          throw Exception(data['message']?.toString() ?? 'Grok chat failed.');
        }
        if (type == 'delta') {
          final delta = data['delta']?.toString() ?? '';
          if (delta.isEmpty) continue;
          complete.write(delta);
          setState(() => assistant.text = complete.toString());
          _stickBottom();
        }
        if (type == 'tool_result') {
          final toolText = data['text']?.toString() ?? '';
          if (toolText.isEmpty) continue;
          if (complete.isNotEmpty) complete.write('\n');
          complete.write(toolText);
          setState(() => assistant.text = complete.toString());
          _stickBottom();
        }
      }

      if (assistant.text.trim().isEmpty) {
        assistant.text = _stopRequested ? '(stopped)' : 'No reply from Grok this turn.';
      }
    } catch (e) {
      setState(() {
        assistant.text = e.toString().replaceFirst('Exception: ', '');
        _error = assistant.text;
      });
    } finally {
      if (mounted) {
        setState(() {
          assistant.streaming = false;
          _busy = false;
        });
        _stickBottom();
      }
    }
  }

  void _stop() {
    _stopRequested = true;
    setState(() => _busy = false);
  }

  void _newChat() {
    if (_busy) _stop();
    setState(() {
      _messages.clear();
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final paired = widget.baseUrl.trim().isNotEmpty && widget.deviceToken.trim().isNotEmpty;
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.surface,
        foregroundColor: CheColors.text,
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Grok', style: TextStyle(fontWeight: FontWeight.w800)),
            Text(
              'via CHE Worker · xAI',
              style: TextStyle(fontSize: 12, color: CheColors.textDim, fontWeight: FontWeight.w500),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'New chat',
            onPressed: _newChat,
            icon: const Icon(Icons.add_rounded),
          ),
          if (widget.onOpenWeb != null)
            PopupMenuButton<String>(
              tooltip: 'More',
              onSelected: (v) {
                if (v == 'web') widget.onOpenWeb!();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: 'web',
                  child: Text('Open grok.com in browser'),
                ),
              ],
            ),
        ],
      ),
      body: Column(
        children: [
          if (!paired)
            MaterialBanner(
              content: const Text('Pair this device to CHE to use native Grok chat.'),
              backgroundColor: CheColors.surfaceHi,
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  child: const Text('Back'),
                ),
              ],
            ),
          Expanded(
            child: _messages.isEmpty
                ? _EmptyState(onPrompt: paired ? _send : null)
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.md),
                    itemCount: _messages.length,
                    itemBuilder: (context, i) {
                      final m = _messages[i];
                      final isUser = m.role == 'user';
                      return Padding(
                        padding: const EdgeInsets.only(bottom: CheSpace.md),
                        child: Align(
                          alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                          child: ConstrainedBox(
                            constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.86),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              decoration: BoxDecoration(
                                color: isUser ? CheColors.accent.withValues(alpha: 0.18) : CheColors.surface,
                                borderRadius: BorderRadius.circular(CheRadius.md),
                                border: Border.all(
                                  color: isUser ? CheColors.accent.withValues(alpha: 0.35) : CheColors.stroke,
                                ),
                              ),
                              child: SelectableText(
                                m.text.isEmpty && m.streaming ? 'Thinking…' : m.text,
                                style: TextStyle(
                                  color: CheColors.text,
                                  height: 1.35,
                                  fontStyle: m.streaming && m.text.isEmpty ? FontStyle.italic : FontStyle.normal,
                                ),
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
          if (_error != null && _messages.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
              child: Text(_error!, style: const TextStyle(color: CheColors.danger)),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 8, CheSpace.gutter, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      focusNode: _focus,
                      enabled: paired && !_busy,
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      style: const TextStyle(color: CheColors.text),
                      decoration: InputDecoration(
                        hintText: paired ? 'Message Grok…' : 'Pair to chat',
                        hintStyle: const TextStyle(color: CheColors.textFaint),
                        filled: true,
                        fillColor: CheColors.surface,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(CheRadius.lg),
                          borderSide: const BorderSide(color: CheColors.stroke),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(CheRadius.lg),
                          borderSide: const BorderSide(color: CheColors.stroke),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(CheRadius.lg),
                          borderSide: const BorderSide(color: CheColors.accent),
                        ),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Semantics(
                    button: true,
                    label: _busy ? 'Stop' : 'Send',
                    child: CheIconButton(
                      icon: _busy ? Icons.stop_rounded : Icons.arrow_upward_rounded,
                      glow: !_busy,
                      size: 48,
                      onTap: _busy ? _stop : () { _send(); },
                      tooltip: _busy ? 'Stop' : 'Send',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({this.onPrompt});
  final Future<void> Function([String?])? onPrompt;

  @override
  Widget build(BuildContext context) {
    const prompts = [
      'What can you help me with?',
      'Summarize today\'s top tech news',
      'Help me draft a short plan',
    ];
    return ListView(
      padding: const EdgeInsets.all(CheSpace.xl),
      children: [
        const SizedBox(height: 24),
        const Icon(Icons.smart_toy_outlined, size: 48, color: CheColors.accent),
        const SizedBox(height: 12),
        const Text(
          'Native Grok chat',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: CheColors.text),
        ),
        const SizedBox(height: 6),
        const Text(
          'Runs through CHE\'s Cloudflare Worker with xAI preferred — not grok.com in a WebView.',
          textAlign: TextAlign.center,
          style: TextStyle(color: CheColors.textDim, height: 1.35),
        ),
        const SizedBox(height: 24),
        if (onPrompt != null)
          for (final p in prompts)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: OutlinedButton(
                onPressed: () => onPrompt!(p),
                style: OutlinedButton.styleFrom(
                  foregroundColor: CheColors.text,
                  side: const BorderSide(color: CheColors.strokeHi),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  alignment: Alignment.centerLeft,
                ),
                child: Text(p),
              ),
            ),
      ],
    );
  }
}
