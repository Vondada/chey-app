// Keys & Mailbox: CHE's AI Mailbox (letters in per-AI trays) and a safe
// place to add free API keys. Keys are sent straight to CHE's server, tested
// there, and never shown again, spoken, or kept on the phone.
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_theme.dart';
import 'che_message_split.dart';

class CheMailboxScreen extends StatefulWidget {
  const CheMailboxScreen({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.onSpeak,
    this.initialTab = 0,
  });

  /// 0 Flagstaff, 1 Archive, 2 Letters, 3 Keys.
  final int initialTab;
  final String baseUrl;
  final Map<String, String> Function() headers;

  /// Reads text aloud in CHE's voice (voice-first owner).
  final void Function(String text)? onSpeak;

  @override
  State<CheMailboxScreen> createState() => _CheMailboxScreenState();
}

class _CheMailboxScreenState extends State<CheMailboxScreen> {
  List<Map<String, dynamic>> _letters = const [];
  List<Map<String, dynamic>> _providers = const [];
  Map<String, dynamic> _flag = const {};
  List<Map<String, dynamic>> _archive = const [];
  String? _openThread;
  bool _loading = true;
  String _status = '';
  String _keyQuery = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _say(String text) {
    setState(() => _status = text);
    widget.onSpeak?.call(text);
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final responses = await Future.wait([
        http.get(Uri.parse('${widget.baseUrl}/api/letters'), headers: widget.headers()),
        http.get(Uri.parse('${widget.baseUrl}/api/keys'), headers: widget.headers()),
        http.get(Uri.parse('${widget.baseUrl}/api/flagstaff'), headers: widget.headers()),
        http.get(Uri.parse('${widget.baseUrl}/api/flagstaff/archive'), headers: widget.headers()),
      ]).timeout(const Duration(seconds: 20));
      final letters = jsonDecode(responses[0].body);
      final keys = jsonDecode(responses[1].body);
      final flag = jsonDecode(responses[2].body);
      final archive = jsonDecode(responses[3].body);
      if (!mounted) return;
      setState(() {
        _flag = flag is Map ? Map<String, dynamic>.from(flag) : const {};
        _archive = archive is Map && archive['sessions'] is List
            ? (archive['sessions'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
        _letters = letters is Map && letters['letters'] is List
            ? (letters['letters'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
        _providers = keys is Map && keys['providers'] is List
            ? (keys['providers'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
        _loading = false;
      });
      final unread = _letters.where((l) => l['read'] != true).length;
      final newMail = (_flag['unread'] as num?)?.toInt() ?? 0;
      _say('${newMail == 0 ? 'No new messages.' : '$newMail new messages.'} '
          '${unread == 0 ? 'No new letters.' : '$unread new letters.'}');
      // Opening the mailbox counts as reading it, so the badge clears.
      http.post(
        Uri.parse('${widget.baseUrl}/api/flagstaff'),
        headers: {...widget.headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'action': 'mark-seen'}),
      ).catchError((_) => http.Response('', 500));
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
      _say('I could not open the mailbox. Check the connection and try again.');
    }
  }

  Future<void> _openLetter(Map<String, dynamic> letter) async {
    final text = 'From ${letter['tray']}. ${letter['subject']}. ${letter['body'] ?? ''}';
    _say(text);
    if (letter['read'] != true) {
      setState(() => letter['read'] = true);
      await http.post(
        Uri.parse('${widget.baseUrl}/api/letters'),
        headers: {...widget.headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'id': letter['id'], 'read': true}),
      ).catchError((_) => http.Response('', 500));
    }
  }

  Future<void> _deleteLetter(Map<String, dynamic> letter) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Delete this letter?'),
        content: Text('${letter['subject']}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    await http.post(
      Uri.parse('${widget.baseUrl}/api/letters'),
      headers: {...widget.headers(), 'Content-Type': 'application/json'},
      body: jsonEncode({'id': letter['id'], 'delete': true}),
    ).catchError((_) => http.Response('', 500));
    if (!mounted) return;
    setState(() => _letters = _letters.where((l) => l['id'] != letter['id']).toList());
    _say('Letter deleted.');
  }

  Future<void> _addKey(Map<String, dynamic> provider) async {
    final controller = TextEditingController();
    final name = '${provider['name']}';
    _say('Adding a $name key. Open the official page, create a key, then paste it here.');
    final key = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.viewInsetsOf(c).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Add $name key', style: CheType.title),
          const SizedBox(height: 8),
          const Text('Tap the button to create a key on the official page, then paste it here. CHE tests it and starts using it right away. One account in your name.', style: CheType.bodyDim),
          const SizedBox(height: 12),
          Semantics(
            button: true,
            label: 'Open the official $name key page',
            child: OutlinedButton.icon(
              onPressed: () => launchUrl(Uri.parse('${provider['page']}'), mode: LaunchMode.externalApplication),
              icon: const Icon(Icons.open_in_new_rounded),
              label: const Text('Open official key page'),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(labelText: 'Paste the key here', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: () => Navigator.pop(c, controller.text.trim()),
              child: const Text('Save and test'),
            ),
          ),
        ]),
      ),
    );
    controller.dispose();
    if (key == null || key.isEmpty) return;
    _say('Testing the $name key.');
    try {
      final response = await http.post(
        Uri.parse('${widget.baseUrl}/api/keys'),
        headers: {...widget.headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'provider': provider['id'], 'key': key}),
      ).timeout(const Duration(seconds: 25));
      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data is Map) {
        HapticFeedback.mediumImpact();
        _say('$name key saved and tested. It ends in ${data['last4']} and is now in my rotation.');
      } else {
        HapticFeedback.heavyImpact();
        _say(data is Map ? '${data['detail'] ?? 'That key did not work.'}' : 'That key did not work.');
      }
    } catch (_) {
      _say('I could not reach my server to test the key. Nothing was saved.');
    }
    await _load();
  }

  Future<void> _flagAction(String action) async {
    try {
      final response = await http.post(
        Uri.parse('${widget.baseUrl}/api/flagstaff'),
        headers: {...widget.headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'action': action}),
      ).timeout(const Duration(seconds: 20));
      if (response.statusCode != 200) {
        _say('That did not work. Try again.');
        return;
      }
      HapticFeedback.mediumImpact();
      await _load();
      _say(switch (action) {
        'open' => 'Flagstaff is open. Same link as always.',
        'lock' => 'Flagstaff is locked. The conversation is saved in your Archive and the board is clear.',
        _ => 'New Flagstaff link made. The old one no longer works.',
      });
    } catch (_) {
      _say('I could not reach my server.');
    }
  }

  /// One message as iMessage-style bubbles: CHE on the right in her teal,
  /// the other AI on the left in a dark grey. A long message becomes several
  /// bubbles in order; the name and time sit above the first bubble only.
  Widget _message(Map m) {
    final fromChe = '${m['from']}' == 'che';
    final who = fromChe ? 'CHE' : _nice('${m['from']}');
    final parts = cheSplitMessage('${m['text']}');
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: fromChe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            child: Text('$who · ${_when(m['at'])}', style: CheType.caption),
          ),
          for (var i = 0; i < parts.length; i++) _bubble(m, fromChe, parts[i], i, parts.length),
        ],
      ),
    );
  }

  Widget _bubble(Map m, bool fromChe, String text, int index, int count) {
    final who = fromChe ? 'CHE' : _nice('${m['from']}');
    final part = count > 1 ? ', part ${index + 1} of $count' : '';
    // Tail corner on the last bubble of a run, like Messages.
    final last = index == count - 1;
    const round = Radius.circular(18);
    const tail = Radius.circular(4);
    return Semantics(
      label: index == 0 ? '$who said$part: $text' : 'Continued$part: $text',
      child: Align(
        alignment: fromChe ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: EdgeInsets.only(top: index == 0 ? 0 : 2),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.72),
          decoration: BoxDecoration(
            color: fromChe ? CheColors.accent : CheColors.surfaceHi,
            borderRadius: BorderRadius.only(
              topLeft: round,
              topRight: round,
              bottomLeft: fromChe || !last ? round : tail,
              bottomRight: !fromChe || !last ? round : tail,
            ),
          ),
          child: SelectableText(
            text,
            style: CheType.body.copyWith(color: fromChe ? CheColors.bg : CheColors.text),
          ),
        ),
      ),
    );
  }

  /// Messages grouped into one conversation per AI, newest conversation first.
  Map<String, List<Map>> _threads(List<Map> messages) {
    final out = <String, List<Map>>{};
    for (final m in messages) {
      final from = '${m['from']}';
      final peer = from == 'che' ? '${m['to']}' : from;
      out.putIfAbsent(peer, () => []).add(m);
    }
    final ordered = out.entries.toList()
      ..sort((a, b) => '${b.value.last['at']}'.compareTo('${a.value.last['at']}'));
    return {for (final e in ordered) e.key: e.value};
  }

  String _nice(String peer) => peer.isEmpty ? 'Unknown' : '${peer[0].toUpperCase()}${peer.substring(1)}';

  String _when(Object? at) {
    final t = DateTime.tryParse('$at')?.toLocal();
    if (t == null) return '';
    final now = DateTime.now();
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    final clock = '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
    if (t.year == now.year && t.month == now.month && t.day == now.day) return clock;
    return '${t.month}/${t.day}';
  }

  Widget _flagstaffTab() {
    final open = _flag['open'] == true;
    final link = '${_flag['link'] ?? ''}';
    final messages = (_flag['messages'] as List?)?.whereType<Map>().toList() ?? const <Map>[];
    final threads = _threads(messages);
    final thread = _openThread == null ? null : threads[_openThread];
    if (thread != null) {
      return Column(children: [
        ListTile(
          leading: IconButton(
            tooltip: 'Back to all conversations',
            icon: const Icon(Icons.arrow_back_rounded),
            onPressed: () => setState(() => _openThread = null),
          ),
          title: Text(_nice(_openThread!), style: CheType.title),
          trailing: IconButton(
            tooltip: 'Read this conversation aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: () => _say(thread.reversed.take(3).toList().reversed.map((m) => '${_nice('${m['from']}')} said: ${m['text']}').join('. ')),
          ),
        ),
        Expanded(
          // Opens at the newest message, like Messages; older ones are a
          // scroll up.
          child: ListView(
            reverse: true,
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            children: thread.reversed.map(_message).toList(),
          ),
        ),
      ]);
    }
    return ListView(padding: const EdgeInsets.all(12), children: [
      Row(children: [
        Icon(open ? Icons.lock_open_rounded : Icons.lock_rounded, color: open ? CheColors.success : CheColors.warning, size: 20),
        const SizedBox(width: 8),
        Expanded(child: Text('Flagstaff 369 · ${open ? 'Open' : 'Locked'}', style: CheType.label)),
        IconButton(
          tooltip: 'Copy the Flagstaff link',
          icon: const Icon(Icons.copy_rounded),
          onPressed: link.isEmpty
              ? null
              : () {
                  Clipboard.setData(ClipboardData(text: link));
                  _say('Link copied. Paste it into any AI.');
                },
        ),
        IconButton(
          tooltip: open ? 'Lock Flagstaff and save the conversation' : 'Open Flagstaff',
          icon: Icon(open ? Icons.lock_rounded : Icons.lock_open_rounded),
          onPressed: () => _flagAction(open ? 'lock' : 'open'),
        ),
        PopupMenuButton<String>(
          tooltip: 'More',
          onSelected: _flagAction,
          itemBuilder: (_) => const [PopupMenuItem(value: 'new-link', child: Text('Make a new link'))],
        ),
      ]),
      const Divider(height: 16),
      if (threads.isEmpty)
        const Padding(padding: EdgeInsets.all(20), child: Text('No messages yet.', style: CheType.bodyDim))
      else
        for (final entry in threads.entries)
          Semantics(
            button: true,
            label: '${_nice(entry.key)}. ${entry.value.length} messages. Last: ${entry.value.last['text']}',
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              leading: _AiLogo(name: entry.key, size: 42),
              title: Text(_nice(entry.key), style: CheType.label),
              subtitle: Text(
                '${entry.value.last['text']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: CheType.caption,
              ),
              trailing: Text(_when(entry.value.last['at']), style: CheType.caption),
              onTap: () => setState(() => _openThread = entry.key),
            ),
          ),
    ]);
  }

  Map<String, int> _archiveConnections() {
    final counts = <String, int>{};
    for (final session in _archive) {
      final messages = (session['messages'] as List?)?.whereType<Map>() ?? const <Map>[];
      for (final m in messages) {
        final from = '${m['from'] ?? ''}'.trim().toLowerCase();
        final to = '${m['to'] ?? ''}'.trim().toLowerCase();
        final peer = from == 'che' ? to : from;
        if (peer.isEmpty || peer == 'che') continue;
        counts[peer] = (counts[peer] ?? 0) + 1;
      }
    }
    return counts;
  }

  Widget _archiveBrain() {
    final connections = _archiveConnections();
    final total = _archive.fold<int>(0, (sum, s) => sum + ((s['messages'] as List?)?.length ?? 0));
    return Semantics(
      label: connections.isEmpty
          ? 'Saved AI root network. CHE is the center. No archived AI connections yet.'
          : 'Saved AI root network. CHE is the center, connected to ${connections.length} AIs across $total saved messages.',
      child: Card(
        color: CheColors.surface,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('CONNECTED AI ROOT NETWORK', style: CheType.overline),
            const SizedBox(height: 4),
            Text(
              connections.isEmpty
                  ? 'Lock a mailbox conversation and its connection grows here.'
                  : '${connections.length} AI connections · $total saved messages',
              style: CheType.caption,
            ),
            const SizedBox(height: 12),
            _AiNeuralWeb(connections: connections),
          ]),
        ),
      ),
    );
  }

  Widget _archiveTab() {
    if (_archive.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _archiveBrain(),
          const Padding(
            padding: EdgeInsets.all(20),
            child: Text('No saved sessions yet. Lock Flagstaff to save one.', style: CheType.bodyDim),
          ),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _archiveBrain(),
        const SizedBox(height: 8),
        for (final session in _archive)
          Builder(builder: (_) {
            final messages = (session['messages'] as List?)?.whereType<Map>().toList() ?? const <Map>[];
            final when = '${session['locked_at'] ?? ''}'.replaceFirst('T', ' ');
            final shown = when.length > 16 ? when.substring(0, 16) : when;
            return Card(
              color: CheColors.surface,
              child: ExpansionTile(
                leading: const Icon(Icons.inventory_2_rounded, color: CheColors.accentAlt),
                title: Text('Session $shown', style: CheType.label),
                subtitle: Text('${messages.length} messages', style: CheType.caption),
                onExpansionChanged: (open) {
                  if (open) {
                    _say(messages.map((m) => '${m['from']} said: ${m['text']}').join('. '));
                  }
                },
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: Column(children: messages.map(_message).toList()),
                  ),
                ],
              ),
            );
          }),
      ],
    );
  }

  Color _severityColor(String? s) => switch (s) {
        'danger' => CheColors.danger,
        'action' => CheColors.warning,
        _ => CheColors.accent,
      };

  String _statusWords(String s) => switch (s) {
        'healthy' => 'Working',
        'rate-limited' => 'Resting (not dead)',
        'unauthorized' => 'Dead: needs a new key',
        'network' => 'Unreachable right now',
        'not set up' => 'Not set up',
        _ => s,
      };

  Widget _keysTab() {
    final query = _keyQuery.trim().toLowerCase();
    final providers = query.isEmpty
        ? _providers
        : _providers
            .where((provider) =>
                '${provider['name'] ?? ''}'.toLowerCase().contains(query))
            .toList(growable: false);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
          child: Semantics(
            textField: true,
            label: 'Search keys by provider name',
            child: TextField(
              onChanged: (value) => setState(() => _keyQuery = value),
              decoration: const InputDecoration(
                labelText: 'Search keys',
                hintText: 'Provider name',
                prefixIcon: Icon(Icons.search_rounded),
                border: OutlineInputBorder(),
              ),
            ),
          ),
        ),
        Expanded(
          child: providers.isEmpty
              ? const Center(
                  child: Text('No matching key providers.',
                      style: CheType.bodyDim),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: providers.length,
                  itemBuilder: (_, i) {
                    final p = providers[i];
                    final status = '${p['status']}';
                    final ok =
                        status == 'healthy' || status == 'rate-limited';
                    return Semantics(
                      button: true,
                      label:
                          '${p['name']}: ${_statusWords(status)}. Double tap to add or replace the key.',
                      child: Card(
                        color: CheColors.surface,
                        child: ListTile(
                          leading: Icon(
                            ok
                                ? Icons.vpn_key_rounded
                                : Icons.key_off_rounded,
                            color:
                                ok ? CheColors.success : CheColors.warning,
                          ),
                          title: Text('${p['name']}', style: CheType.label),
                          subtitle: Text(
                            '${_statusWords(status)}${'${p['last4']}'.isNotEmpty ? ' · ends ${p['last4']}' : ''}',
                            style: CheType.caption,
                          ),
                          trailing: const Icon(Icons.add_rounded),
                          onTap: () => _addKey(p),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      initialIndex: widget.initialTab.clamp(0, 3),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(
          backgroundColor: CheColors.bg,
          title: const Text('Mailbox'),
          actions: [
            IconButton(
              tooltip: 'Refresh',
              onPressed: _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
          bottom: const TabBar(
            isScrollable: true,
            tabs: [Tab(text: 'Flagstaff'), Tab(text: 'Archive'), Tab(text: 'Letters'), Tab(text: 'Keys')],
          ),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : Column(children: [
                if (_status.isNotEmpty)
                  Semantics(
                    liveRegion: true,
                    child: Container(
                      width: double.infinity,
                      color: CheColors.surfaceHi,
                      padding: const EdgeInsets.all(12),
                      child: Text(_status, style: CheType.body),
                    ),
                  ),
                Expanded(
                  child: TabBarView(children: [
                    _flagstaffTab(),
                    _archiveTab(),
                    _letters.isEmpty
                        ? const Center(child: Text('No letters yet.', style: CheType.bodyDim))
                        : ListView.builder(
                            padding: const EdgeInsets.all(12),
                            itemCount: _letters.length,
                            itemBuilder: (_, i) {
                              final l = _letters[i];
                              final unread = l['read'] != true;
                              final color = _severityColor('${l['severity']}');
                              return Semantics(
                                button: true,
                                label: '${unread ? 'Unread. ' : ''}From ${l['tray']}. ${l['subject']}. Double tap to read aloud.',
                                child: Card(
                                  color: CheColors.surface,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(14),
                                    side: BorderSide(color: unread ? color : CheColors.stroke),
                                  ),
                                  child: ListTile(
                                    leading: Icon(unread ? Icons.mail_rounded : Icons.drafts_rounded, color: color),
                                    title: Text('${l['subject']}', style: unread ? CheType.label : CheType.bodyDim),
                                    subtitle: Text('${l['tray']} · ${l['tag']}', style: CheType.caption),
                                    trailing: IconButton(
                                      tooltip: 'Delete letter',
                                      icon: const Icon(Icons.delete_outline_rounded),
                                      onPressed: () => _deleteLetter(l),
                                    ),
                                    onTap: () => _openLetter(l),
                                  ),
                                ),
                              );
                            },
                          ),
                    _keysTab(),
                  ]),
                ),
              ]),
      ),
    );
  }
}


String _aiDomain(String raw) {
  final name = raw.toLowerCase();
  if (name.contains('claude') || name.contains('anthropic')) return 'claude.ai';
  if (name.contains('grok') || name == 'xai' || name.contains('x.ai')) return 'x.ai';
  if (name.contains('gemini') || name.contains('google')) return 'gemini.google.com';
  if (name.contains('copilot') || name.contains('github')) return 'github.com';
  if (name.contains('mistral')) return 'mistral.ai';
  if (name.contains('perplexity')) return 'perplexity.ai';
  if (name.contains('deepseek')) return 'deepseek.com';
  if (name.contains('meta') || name.contains('llama')) return 'meta.ai';
  if (name.contains('chatgpt') || name.contains('openai')) return 'chatgpt.com';
  return '';
}

String _aiLabel(String raw) {
  final value = raw.trim();
  if (value.isEmpty) return 'AI';
  final lower = value.toLowerCase();
  if (lower == 'xai') return 'Grok';
  if (lower == 'openai') return 'ChatGPT';
  return '${value[0].toUpperCase()}${value.substring(1)}';
}

class _AiLogo extends StatelessWidget {
  const _AiLogo({required this.name, this.size = 40});
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final lower = name.toLowerCase();
    final domain = _aiDomain(name);
    final label = lower == 'che' ? 'CHE' : _aiLabel(name);
    if (lower == 'che') {
      return Semantics(
        image: true,
        label: 'CHE app icon, central intelligence',
        child: Container(
          width: size,
          height: size,
          padding: EdgeInsets.all(size * 0.06),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.black,
            border: Border.all(color: CheColors.accent.withValues(alpha: 0.82), width: 1.4),
            boxShadow: [
              BoxShadow(
                color: CheColors.accent.withValues(alpha: 0.38),
                blurRadius: size * 0.45,
                spreadRadius: size * 0.05,
              ),
            ],
          ),
          child: ClipOval(
            child: Image.asset(
              'assets/avatars/che.png',
              width: size,
              height: size,
              fit: BoxFit.cover,
            ),
          ),
        ),
      );
    }
    final fallback = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: CheColors.surfaceHi,
        border: Border.all(color: CheColors.accent.withValues(alpha: 0.45)),
      ),
      child: Text(label.substring(0, math.min(2, label.length)).toUpperCase(), style: CheType.caption),
    );
    return Semantics(
      image: true,
      label: '$label AI logo',
      child: domain.isEmpty
          ? fallback
          : ClipOval(
              child: Image.network(
                'https://www.google.com/s2/favicons?domain=$domain&sz=128',
                width: size,
                height: size,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => fallback,
              ),
            ),
    );
  }
}

class _AiNeuralWeb extends StatelessWidget {
  const _AiNeuralWeb({required this.connections});
  final Map<String, int> connections;

  @override
  Widget build(BuildContext context) {
    final peers = connections.keys.toList()..sort();
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.sizeOf(context).width - 48;
        final height = math.max(260.0, math.min(360.0, width * 0.82));
        final center = Offset(width / 2, height / 2);
        const edgeInset = 42.0;
        final radiusX = math.max(44.0, width / 2 - edgeInset);
        final radiusY = math.max(44.0, height / 2 - edgeInset);
        final positions = <String, Offset>{};

        for (var i = 0; i < peers.length; i++) {
          final hash = peers[i].hashCode & 0x7fffffff;
          final angle =
              -math.pi / 2 + i * 2.399963229728653 + ((hash % 17) - 8) * 0.018;
          final density = peers.length <= 6
              ? 0.80
              : 0.62 + 0.20 * ((i % 3) / 2);
          positions[peers[i]] = Offset(
            center.dx + math.cos(angle) * radiusX * density,
            center.dy + math.sin(angle) * radiusY * density,
          );
        }

        return SizedBox(
          height: height,
          width: double.infinity,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(18),
            child: Stack(
              clipBehavior: Clip.hardEdge,
              children: [
                Positioned.fill(
                  child: CustomPaint(
                    painter: _AiNeuralPainter(
                      center: center,
                      positions: positions,
                      weights: connections,
                    ),
                  ),
                ),
                Positioned(
                  left: center.dx - 36,
                  top: center.dy - 43,
                  child: Semantics(
                    image: true,
                    label: 'CHE at the center of the saved AI root network',
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const _AiLogo(name: 'che', size: 72),
                        const SizedBox(height: 3),
                        Text(
                          'CHE',
                          style: CheType.caption.copyWith(
                            color: CheColors.accent,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                for (final peer in peers)
                  Positioned(
                    left: positions[peer]!.dx - 28,
                    top: positions[peer]!.dy - 31,
                    width: 56,
                    child: Semantics(
                      label:
                          '${_aiLabel(peer)} connected to CHE through ${connections[peer]} saved messages',
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _AiLogo(name: peer, size: 50),
                          const SizedBox(height: 2),
                          Text(
                            _aiLabel(peer),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.center,
                            style: CheType.caption,
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _AiNeuralPainter extends CustomPainter {
  const _AiNeuralPainter({required this.center, required this.positions, required this.weights});
  final Offset center;
  final Map<String, Offset> positions;
  final Map<String, int> weights;

  @override
  void paint(Canvas canvas, Size size) {
    for (final entry in positions.entries) {
      final count = math.max(1, weights[entry.key] ?? 1);
      final strength = math.min(1.0, 0.24 + math.log(count + 1) / 4);
      final target = entry.value;
      final dx = target.dx - center.dx;
      final dy = target.dy - center.dy;
      final bend = ((entry.key.hashCode & 0x7fffffff) % 41) - 20.0;
      final normal = Offset(-dy, dx);
      final normLen = math.max(1.0, normal.distance);
      final unitNormal = normal / normLen;
      final c1 = center + Offset(dx * 0.24, dy * 0.24) + unitNormal * bend;
      final c2 = center + Offset(dx * 0.68, dy * 0.68) - unitNormal * (bend * 0.55);
      final root = Path()
        ..moveTo(center.dx, center.dy)
        ..cubicTo(c1.dx, c1.dy, c2.dx, c2.dy, target.dx, target.dy);

      // A dim outer root + bright inner vein creates depth without expensive
      // shaders or offscreen WebViews.
      canvas.drawPath(
        root,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round
          ..color = CheColors.accent.withValues(alpha: 0.10 + strength * 0.18)
          ..strokeWidth = 5.0 + math.min(7.0, math.log(count + 1) * 1.8),
      );
      canvas.drawPath(
        root,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round
          ..color = CheColors.accent.withValues(alpha: 0.34 + strength * 0.46)
          ..strokeWidth = 0.9 + math.min(3.6, math.log(count + 1)),
      );

      // Fine rootlets branch near each AI. More saved interactions = denser
      // growth, but the count is capped so painting stays cheap.
      final rootlets = math.min(7, 2 + (math.log(count + 1) * 2).round());
      final baseAngle = math.atan2(dy, dx);
      for (var i = 0; i < rootlets; i++) {
        final spread = (i - (rootlets - 1) / 2) * 0.24;
        final length = 18.0 + strength * 22 + (i % 3) * 4;
        final end = target + Offset(
          math.cos(baseAngle + spread) * length,
          math.sin(baseAngle + spread) * length,
        );
        final twig = Path()
          ..moveTo(target.dx, target.dy)
          ..quadraticBezierTo(
            target.dx + math.cos(baseAngle + spread * 0.45) * length * 0.45,
            target.dy + math.sin(baseAngle + spread * 0.45) * length * 0.45,
            end.dx,
            end.dy,
          );
        canvas.drawPath(
          twig,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeCap = StrokeCap.round
            ..color = CheColors.accentAlt.withValues(alpha: 0.16 + strength * 0.28)
            ..strokeWidth = 0.7 + strength,
        );
      }

      final beads = math.min(9, count);
      for (var i = 1; i <= beads; i++) {
        final t = i / (beads + 1);
        final p = Offset(
          center.dx + dx * t,
          center.dy + dy * t,
        );
        canvas.drawCircle(
          p,
          1.2 + strength,
          Paint()..color = CheColors.accentAlt.withValues(alpha: 0.30 + strength * 0.42),
        );
      }
    }

    canvas.drawCircle(
      center,
      88,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = CheColors.accent.withValues(alpha: 0.22),
    );
  }

  @override
  bool shouldRepaint(covariant _AiNeuralPainter oldDelegate) =>
      oldDelegate.positions.length != positions.length || oldDelegate.weights.toString() != weights.toString();
}
