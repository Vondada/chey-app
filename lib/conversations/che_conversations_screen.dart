// Every conversation between CHE's AIs and agents, as phone group chats:
// War Room meetings, Office agent threads and coding-crew discussions (from
// the Worker's /api/conversations), plus a shortcut to the Flagstaff AI
// mailbox. Real records only; an empty list says so.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';

class CheChatMessage {
  const CheChatMessage({required this.from, this.to, this.kind = '', required this.text, this.at});
  final String from;
  final String? to;
  final String kind;
  final String text;
  final DateTime? at;

  static CheChatMessage fromJson(Map j) => CheChatMessage(
        from: '${j['from'] ?? 'Agent'}',
        to: (j['to'] == null || '${j['to']}'.isEmpty) ? null : '${j['to']}',
        kind: '${j['kind'] ?? ''}',
        text: '${j['text'] ?? ''}',
        at: DateTime.tryParse('${j['at'] ?? ''}'),
      );
}

class CheChatThread {
  const CheChatThread({required this.id, required this.kind, required this.title, required this.participants, required this.status, required this.messages, this.updatedAt});
  final String id;
  final String kind; // war_room | office | crew
  final String title;
  final List<String> participants;
  final String status;
  final List<CheChatMessage> messages;
  final DateTime? updatedAt;

  String get kindLabel => switch (kind) {
        'war_room' => 'War Room',
        'office' => 'Office',
        'crew' => 'Coding crew',
        _ => 'Agents',
      };

  static CheChatThread fromJson(Map j) => CheChatThread(
        id: '${j['id']}',
        kind: '${j['kind'] ?? ''}',
        title: '${j['title'] ?? 'Conversation'}',
        participants: [for (final p in (j['participants'] as List? ?? const [])) '$p'],
        status: '${j['status'] ?? ''}',
        messages: [for (final m in (j['messages'] as List? ?? const [])) if (m is Map) CheChatMessage.fromJson(m)],
        updatedAt: DateTime.tryParse('${j['updated_at'] ?? ''}'),
      );
}

/// Stable color per speaker, so each AI is recognizable at a glance.
Color cheSpeakerColor(String name) {
  const palette = [Color(0xFF39E6C5), Color(0xFF4CC9F0), Color(0xFFB17CFF), Color(0xFFFFC857), Color(0xFFFF7EB6), Color(0xFF6EA8FF), Color(0xFF8DE969), Color(0xFFFF9F68)];
  if (name.toUpperCase() == 'CHE') return CheColors.accent;
  var h = 0;
  for (final c in name.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return palette[h % palette.length];
}

String cheChatTime(DateTime? at, {DateTime? now}) {
  if (at == null) return '';
  final t = at.toLocal();
  final n = (now ?? DateTime.now()).toLocal();
  final hour = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final clock = '$hour:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
  if (t.year == n.year && t.month == n.month && t.day == n.day) return clock;
  return '${t.month}/${t.day} $clock';
}

class CheConversationsScreen extends StatefulWidget {
  const CheConversationsScreen({super.key, required this.baseUrl, required this.headers, this.client, this.onOpenFlagstaff, this.onReadAloud});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final VoidCallback? onOpenFlagstaff;
  final Future<void> Function(String text)? onReadAloud;

  static Future<void> open(BuildContext context, {required String Function() baseUrl, required Map<String, String> Function() headers, VoidCallback? onOpenFlagstaff, Future<void> Function(String)? onReadAloud}) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Theme(
          data: CheTheme.dark(),
          child: CheConversationsScreen(baseUrl: baseUrl, headers: headers, onOpenFlagstaff: onOpenFlagstaff, onReadAloud: onReadAloud),
        ),
      ));

  @override
  State<CheConversationsScreen> createState() => _CheConversationsScreenState();
}

class _CheConversationsScreenState extends State<CheConversationsScreen> {
  List<CheChatThread> _threads = const [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final c = widget.client ?? http.Client();
      final r = await c.get(Uri.parse('${widget.baseUrl()}/api/conversations'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      if (r.statusCode != 200 || j is! Map) throw Exception(j is Map ? '${j['detail'] ?? 'Unavailable'}' : 'Unavailable');
      _threads = [for (final t in (j['threads'] as List? ?? const [])) if (t is Map) CheChatThread.fromJson(t)];
      _error = null;
    } catch (e) {
      _error = 'Conversations could not load: ${'$e'.replaceFirst('Exception: ', '')}';
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Conversations'), toolbarHeight: 48),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          if (widget.onOpenFlagstaff != null)
            _ThreadRow(
              title: 'Flagstaff · AI mailbox',
              subtitle: 'CHE with Claude, ChatGPT, Gemini and the other AIs',
              badge: 'AIs',
              time: '',
              color: CheColors.accentAlt,
              initials: 'FS',
              onTap: widget.onOpenFlagstaff!,
            ),
          if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
          if (_error != null) Padding(padding: const EdgeInsets.all(16), child: Text(_error!, style: CheType.caption.copyWith(color: CheColors.warning))),
          if (!_loading && _error == null && _threads.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No agent conversations yet. War Room meetings, Office work and coding jobs appear here as they happen.', textAlign: TextAlign.center, style: CheType.caption),
            ),
          for (final t in _threads)
            _ThreadRow(
              title: t.title,
              subtitle: t.messages.isEmpty ? '' : '${t.messages.last.from}: ${t.messages.last.text}',
              badge: t.kindLabel,
              time: cheChatTime(t.updatedAt),
              color: cheSpeakerColor(t.participants.isEmpty ? t.title : t.participants.first),
              initials: t.participants.length > 1 ? '${t.participants.length}' : (t.participants.isEmpty ? '?' : t.participants.first.substring(0, 1).toUpperCase()),
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => Theme(data: CheTheme.dark(), child: CheThreadScreen(thread: t, onReadAloud: widget.onReadAloud)),
              )),
            ),
        ]),
      ),
    );
  }
}

class _ThreadRow extends StatelessWidget {
  const _ThreadRow({required this.title, required this.subtitle, required this.badge, required this.time, required this.color, required this.initials, required this.onTap});
  final String title, subtitle, badge, time, initials;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '$badge conversation: $title. ${time.isEmpty ? '' : 'Last message $time. '}$subtitle',
      excludeSemantics: true,
      child: ListTile(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        leading: CircleAvatar(backgroundColor: color.withValues(alpha: .22), child: Text(initials, style: TextStyle(color: color, fontWeight: FontWeight.w700))),
        title: Row(children: [
          Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white))),
          Text(time, style: CheType.caption.copyWith(fontSize: 12)),
        ]),
        subtitle: Text('$badge · $subtitle', maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption),
      ),
    );
  }
}

/// One group chat: who said what, to whom, in order.
class CheThreadScreen extends StatelessWidget {
  const CheThreadScreen({super.key, required this.thread, this.onReadAloud});
  final CheChatThread thread;
  final Future<void> Function(String text)? onReadAloud;

  String get _spoken => [
        '${thread.kindLabel}: ${thread.title}.',
        for (final m in thread.messages) '${m.from}${m.to == null ? '' : ' to ${m.to}'}: ${m.text}',
      ].join('\n');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 52,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(thread.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
          Text('${thread.kindLabel} · ${thread.participants.join(', ')}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(fontSize: 12)),
        ]),
        actions: [
          if (onReadAloud != null)
            IconButton(tooltip: 'Read this conversation aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => onReadAloud!(_spoken)),
        ],
      ),
      body: ListView.builder(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        itemCount: thread.messages.length + (thread.status.isEmpty ? 0 : 1),
        itemBuilder: (context, i) {
          if (i == thread.messages.length) {
            return Padding(padding: const EdgeInsets.only(top: 12), child: Center(child: Text(thread.status, style: CheType.caption)));
          }
          final m = thread.messages[i];
          final prev = i > 0 ? thread.messages[i - 1] : null;
          return _Bubble(message: m, showName: prev?.from != m.from || prev?.to != m.to);
        },
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.showName});
  final CheChatMessage message;
  final bool showName;

  @override
  Widget build(BuildContext context) {
    final mine = message.from.toUpperCase() == 'CHE';
    final color = cheSpeakerColor(message.from);
    final width = MediaQuery.sizeOf(context).width * .78;
    return Semantics(
      label: '${message.from}${message.to == null ? '' : ' to ${message.to}'}${message.kind.isEmpty ? '' : ', ${message.kind}'}${message.at == null ? '' : ', ${cheChatTime(message.at)}'}: ${message.text}',
      excludeSemantics: true,
      child: Padding(
        padding: EdgeInsets.only(top: showName ? 10 : 3),
        child: Column(crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
          if (showName)
            Padding(
              padding: const EdgeInsets.only(left: 10, right: 10, bottom: 2),
              child: Text(
                '${message.from}${message.to == null ? '' : ' → ${message.to}'}${message.kind.isEmpty ? '' : ' · ${message.kind}'}',
                style: CheType.caption.copyWith(color: color, fontWeight: FontWeight.w700, fontSize: 12),
              ),
            ),
          GestureDetector(
            onLongPress: () {
              Clipboard.setData(ClipboardData(text: message.text));
              HapticFeedback.lightImpact();
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Copied')));
            },
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: width),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: mine ? CheColors.accent.withValues(alpha: .22) : color.withValues(alpha: .13),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: (mine ? CheColors.accent : color).withValues(alpha: .35)),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: SelectableText(message.text, style: CheType.body.copyWith(fontSize: 15, height: 1.35)),
                ),
              ),
            ),
          ),
          if (message.at != null)
            Padding(padding: const EdgeInsets.only(top: 2, left: 10, right: 10), child: Text(cheChatTime(message.at), style: CheType.caption.copyWith(fontSize: 10))),
        ]),
      ),
    );
  }
}
