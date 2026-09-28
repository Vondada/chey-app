// CHE conversation log — every conversation (typed AND spoken) saved word for
// word with timestamps. Survives app restarts. Readable three ways:
//   1. Inside CHE: Insights → "Conversation Log" card (search everything, tap a
//      conversation for the exact transcript, "Copy all"). Also reachable from
//      the chat's Conversations sheet (document icon).
//   2. iPhone Files app → On My iPhone → CHE → che_logs  (plain-text .md files,
//      one per conversation) — needs the two Info.plist keys in the ChatGPT
//      instructions.
//   3. Optional: the Worker can also receive each finished turn (logUrl) so
//      logs are readable from any device.
// No extra packages (dart:io only).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_agent_chat.dart' show CheAgentController;
import 'che_models.dart';
import 'che_transitions.dart';
import 'che_theme.dart';
import 'che_widgets.dart';

class CheConversationStore {
  CheConversationStore({this.logUrl, this.logHeaders = const {}, this.resolveLogUrl, this.resolveLogHeaders});

  /// Optional Worker endpoint that receives each finished turn (POST JSON).
  final Uri? logUrl;
  final Map<String, String> logHeaders;

  /// Dynamic versions (the server address / pairing token can change).
  final Uri? Function()? resolveLogUrl;
  final Map<String, String> Function()? resolveLogHeaders;

  static Future<Directory> _dir() async {
    final home = Platform.environment['HOME'];
    final dir = (home != null && home.isNotEmpty)
        ? Directory('$home/Documents/che_logs')
        : Directory('${Directory.systemTemp.path}/che_logs');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  static String _safe(String id) => id.replaceAll(RegExp(r'[^A-Za-z0-9_\-]'), '_');

  /// Saves JSON (for restoring) + a readable .md transcript.
  Future<void> save(CheConversation c) async {
    if (c.messages.isEmpty) return;
    try {
      final dir = await _dir();
      final base = '${dir.path}/${_safe(c.id)}';
      final json = File('$base.json.tmp');
      await json.writeAsString(jsonEncode(conversationToJson(c)));
      await json.rename('$base.json');
      await File('$base.md').writeAsString(transcript(c));
    } catch (_) {/* logging must never crash CHE */}
  }

  Future<void> delete(CheConversation c) async {
    try {
      final dir = await _dir();
      for (final ext in ['json', 'md']) {
        final f = File('${dir.path}/${_safe(c.id)}.$ext');
        if (await f.exists()) await f.delete();
      }
    } catch (_) {}
  }

  Future<List<CheConversation>> loadAll() async {
    final out = <CheConversation>[];
    try {
      final dir = await _dir();
      await for (final e in dir.list()) {
        if (e is File && e.path.endsWith('.json')) {
          try {
            out.add(conversationFromJson(jsonDecode(await e.readAsString()) as Map<String, dynamic>));
          } catch (_) {}
        }
      }
    } catch (_) {}
    out.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return out;
  }

  /// Sends one finished turn to the Worker (fire-and-forget).
  static final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 6);
  Future<void> remoteLog(CheConversation c, CheMessage user, CheMessage reply, {String source = 'chat'}) async {
    final url = resolveLogUrl?.call() ?? logUrl;
    if (url == null) return;
    try {
      final r = await _http.postUrl(url);
      final headers = resolveLogHeaders?.call() ?? logHeaders;
      headers.forEach((k, v) {
        if (k.toLowerCase() != 'content-type') r.headers.set(k, v);
      });
      r.headers.contentType = ContentType.json;
      r.add(utf8.encode(jsonEncode({
        'conversationId': c.id,
        'title': c.title,
        'source': source, // "chat" or "voice"
        'user': {'text': user.text, 'at': user.createdAt.toIso8601String()},
        'che': {'text': reply.text, 'at': DateTime.now().toIso8601String(), 'error': reply.isError},
      })));
      final res = await r.close().timeout(const Duration(seconds: 10));
      await res.drain<void>();
    } catch (_) {}
  }

  // ── formats ──
  static Map<String, dynamic> conversationToJson(CheConversation c) => {
        'id': c.id,
        'title': c.title,
        'updatedAt': c.updatedAt.toIso8601String(),
        'messages': [
          for (final m in c.messages)
            {
              'role': m.isUser ? 'user' : 'che',
              'text': m.text,
              'at': m.createdAt.toIso8601String(),
              if (m.attachments.isNotEmpty) 'attachments': m.attachments.length,
              if (m.thoughtMs != null) 'thoughtMs': m.thoughtMs,
              if (m.isError) 'error': m.errorText,
              if (m.steps.isNotEmpty) 'steps': [for (final s in m.steps) s.label],
            }
        ],
      };

  static CheConversation conversationFromJson(Map<String, dynamic> j) {
    final c = CheConversation(j['id'].toString())
      ..title = (j['title'] ?? 'Conversation').toString()
      ..updatedAt = DateTime.tryParse(j['updatedAt']?.toString() ?? '') ?? DateTime.now();
    for (final m in (j['messages'] as List? ?? const [])) {
      final mm = (m as Map).cast<String, dynamic>();
      final isUser = mm['role'] == 'user';
      final msg = isUser ? CheMessage.user(mm['text']?.toString() ?? '') : CheMessage.assistant();
      msg.createdAt = DateTime.tryParse(mm['at']?.toString() ?? '') ?? c.updatedAt;
      if (!isUser) {
        msg.text = mm['text']?.toString() ?? '';
        msg.thoughtMs = (mm['thoughtMs'] as num?)?.toInt();
        if (mm['error'] != null) {
          msg.isError = true;
          msg.errorText = mm['error'].toString();
        }
        for (final s in (mm['steps'] as List? ?? const [])) {
          msg.steps.add(CheStep(s.toString(), StepStatus.done));
        }
      }
      c.messages.add(msg);
    }
    return c;
  }

  /// Exact, human-readable transcript.
  static String transcript(CheConversation c) {
    final b = StringBuffer()
      ..writeln('# ${c.title}')
      ..writeln('Conversation ${c.id} · last updated ${_stamp(c.updatedAt)}')
      ..writeln();
    for (final m in c.messages) {
      b.writeln('[${_stamp(m.createdAt)}] ${m.isUser ? 'YOU' : 'CHE'}:');
      if (m.attachments.isNotEmpty) b.writeln('(${m.attachments.length} attachment(s))');
      b.writeln(m.text.isEmpty && m.isError ? '(error: ${m.errorText})' : m.text);
      b.writeln();
    }
    return b.toString();
  }

  static String _stamp(DateTime t) {
    String two(int n) => n.toString().padLeft(2, '0');
    final l = t.toLocal();
    return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}:${two(l.second)}';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Insights → "Conversation Log" card (drop into the EXISTING Insights screen)
// ─────────────────────────────────────────────────────────────────────────

class CheConversationLogCard extends StatelessWidget {
  const CheConversationLogCard({super.key, required this.controller});
  final CheAgentController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final convs = controller.conversations.where((c) => c.messages.isNotEmpty).toList();
        final total = convs.fold<int>(0, (n, c) => n + c.messages.length);
        final recent = convs.take(3).toList();
        return GlowCard(
          radius: CheRadius.lg,
          padding: const EdgeInsets.all(CheSpace.lg),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.forum_outlined, color: CheColors.accent, size: 20),
              const SizedBox(width: 8),
              const Expanded(child: Text('Conversation Log', style: CheType.headline)),
              TextButton(
                onPressed: () => Navigator.of(context)
                    .push(CheRoute(builder: (_) => CheConversationLogScreen(controller: controller))),
                child: Text('See all', style: CheType.label.copyWith(color: CheColors.accent)),
              ),
            ]),
            Text('${convs.length} conversations · $total messages · saved word for word',
                style: CheType.caption),
            const SizedBox(height: CheSpace.md),
            if (recent.isEmpty)
              const Text('Nothing yet — talk to CHE and it shows up here.', style: CheType.bodyDim)
            else
              for (final c in recent) _LogRow(conversation: c),
          ]),
        );
      },
    );
  }
}

class _LogRow extends StatelessWidget {
  const _LogRow({required this.conversation, this.snippet});
  final CheConversation conversation;
  final String? snippet;
  @override
  Widget build(BuildContext context) {
    final c = conversation;
    final last = c.messages.isNotEmpty ? c.messages.last.text : '';
    return InkWell(
      borderRadius: BorderRadius.circular(CheRadius.sm),
      onTap: () => Navigator.of(context).push(CheRoute(builder: (_) => CheTranscriptScreen(conversation: c))),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          const Icon(Icons.description_outlined, size: 18, color: CheColors.textDim),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
              Text(snippet ?? last.replaceAll('\n', ' '),
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
            ]),
          ),
          const SizedBox(width: 8),
          Text(CheConversationStore._stamp(c.updatedAt).substring(5, 16), style: CheType.caption),
        ]),
      ),
    );
  }
}

/// Every conversation, newest first, with search across ALL messages.
class CheConversationLogScreen extends StatefulWidget {
  const CheConversationLogScreen({super.key, required this.controller});
  final CheAgentController controller;
  @override
  State<CheConversationLogScreen> createState() => _CheConversationLogScreenState();
}

class _CheConversationLogScreenState extends State<CheConversationLogScreen> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.toLowerCase();
    final convs = widget.controller.conversations.where((c) => c.messages.isNotEmpty).toList();
    final rows = <Widget>[];
    for (final c in convs) {
      if (q.isEmpty) {
        rows.add(_LogRow(conversation: c));
      } else {
        final hit = c.messages.where((m) => m.text.toLowerCase().contains(q)).toList();
        if (hit.isNotEmpty || c.title.toLowerCase().contains(q)) {
          rows.add(_LogRow(conversation: c, snippet: hit.isNotEmpty ? hit.first.text.replaceAll('\n', ' ') : null));
        }
      }
    }
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        child: SafeArea(
          bottom: false,
          child: Column(children: [
            CheHeader(
              compact: true,
              title: 'LOG',
              subtitle: 'EVERY CONVERSATION WITH CHE',
              status: null,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.sm),
              child: TextField(
                onChanged: (v) => setState(() => _q = v),
                style: CheType.body,
                decoration: InputDecoration(
                  isDense: true,
                  prefixIcon: const Icon(Icons.search_rounded, color: CheColors.textDim, size: 20),
                  hintText: 'Search everything you and CHE said',
                  hintStyle: CheType.bodyDim,
                  filled: true,
                  fillColor: CheColors.surface,
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(CheRadius.md),
                      borderSide: const BorderSide(color: CheColors.stroke)),
                  enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(CheRadius.md),
                      borderSide: const BorderSide(color: CheColors.stroke)),
                ),
              ),
            ),
            Expanded(
              child: rows.isEmpty
                  ? const Center(child: Text('No matches.', style: CheType.bodyDim))
                  : ListView(
                      padding: EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter,
                          CheSpace.xxl + MediaQuery.of(context).viewPadding.bottom),
                      children: rows,
                    ),
            ),
          ]),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Transcript viewer
// ─────────────────────────────────────────────────────────────────────────

class CheTranscriptScreen extends StatefulWidget {
  const CheTranscriptScreen({super.key, required this.conversation});
  final CheConversation conversation;
  @override
  State<CheTranscriptScreen> createState() => _CheTranscriptScreenState();
}

class _CheTranscriptScreenState extends State<CheTranscriptScreen> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final c = widget.conversation;
    final msgs = _q.isEmpty
        ? c.messages
        : c.messages.where((m) => m.text.toLowerCase().contains(_q.toLowerCase())).toList();
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        child: SafeArea(
          bottom: false,
          child: Column(children: [
            CheHeader(
              compact: true,
              title: 'LOG',
              subtitle: c.title.toUpperCase(),
              status: null,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              trailing: CheIconButton(
                icon: Icons.copy_all_rounded,
                size: 40,
                tooltip: 'Copy all',
                onTap: () {
                  Clipboard.setData(ClipboardData(text: CheConversationStore.transcript(c)));
                  ScaffoldMessenger.maybeOf(context)
                      ?.showSnackBar(const SnackBar(content: Text('Full transcript copied')));
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.sm),
              child: TextField(
                onChanged: (v) => setState(() => _q = v),
                style: CheType.body,
                decoration: InputDecoration(
                  isDense: true,
                  prefixIcon: const Icon(Icons.search_rounded, color: CheColors.textDim, size: 20),
                  hintText: 'Search this conversation',
                  hintStyle: CheType.bodyDim,
                  filled: true,
                  fillColor: CheColors.surface,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(CheRadius.md),
                    borderSide: const BorderSide(color: CheColors.stroke),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(CheRadius.md),
                    borderSide: const BorderSide(color: CheColors.stroke),
                  ),
                ),
              ),
            ),
            Expanded(
              child: ListView.builder(
                padding: EdgeInsets.fromLTRB(
                    CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl + MediaQuery.of(context).viewPadding.bottom),
                itemCount: msgs.length,
                itemBuilder: (context, i) {
                  final m = msgs[i];
                  return Padding(
                    padding: const EdgeInsets.only(bottom: CheSpace.lg),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Text(m.isUser ? 'YOU' : 'CHE',
                            style: CheType.overline.copyWith(color: m.isUser ? CheColors.textDim : CheColors.accent)),
                        const SizedBox(width: 8),
                        Text(CheConversationStore._stamp(m.createdAt), style: CheType.caption),
                      ]),
                      const SizedBox(height: 4),
                      SelectableText(
                        m.text.isEmpty && m.isError ? '(error: ${m.errorText})' : m.text,
                        style: CheType.body,
                      ),
                    ]),
                  );
                },
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
