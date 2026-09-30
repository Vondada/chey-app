// Keys & Mailbox: CHE's AI Mailbox (letters in per-AI trays) and a safe
// place to add free API keys. Keys are sent straight to CHE's server, tested
// there, and never shown again, spoken, or kept on the phone.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_ui/che_theme.dart';

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
  List<Map<String, dynamic>> _claude = const [];
  bool _loading = true;
  String _status = '';

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
        http.get(Uri.parse('${widget.baseUrl}/api/mailbox?peer=claude'), headers: widget.headers()),
      ]).timeout(const Duration(seconds: 20));
      final claude = jsonDecode(responses[4].body);
      final letters = jsonDecode(responses[0].body);
      final keys = jsonDecode(responses[1].body);
      final flag = jsonDecode(responses[2].body);
      final archive = jsonDecode(responses[3].body);
      if (!mounted) return;
      setState(() {
        _flag = flag is Map ? Map<String, dynamic>.from(flag) : const {};
        _claude = claude is Map && claude['messages'] is List
            ? (claude['messages'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
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
      final board = (_flag['messages'] as List?)?.length ?? 0;
      _say('Flagstaff is ${_flag['open'] == true ? 'open' : 'locked'} with $board messages. '
          '${_archive.length} saved sessions. ${unread == 0 ? 'No new letters.' : '$unread unread letters.'}');
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
          const Text('Free. One account in your name. CHE stops for anything only you can do (captcha, codes, terms).', style: CheType.bodyDim),
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

  Widget _message(Map m) {
    final fromChe = '${m['from']}' == 'che';
    return Semantics(
      label: '${m['from']} said: ${m['text']}',
      child: Align(
        alignment: fromChe ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.all(10),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
          decoration: BoxDecoration(
            color: fromChe ? CheColors.accent.withValues(alpha: 0.14) : CheColors.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: fromChe ? CheColors.accent.withValues(alpha: 0.4) : CheColors.stroke),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${m['from']} → ${m['to']}', style: CheType.caption),
            const SizedBox(height: 4),
            SelectableText('${m['text']}', style: CheType.body),
          ]),
        ),
      ),
    );
  }

  Widget _flagstaffTab() {
    final open = _flag['open'] == true;
    final link = '${_flag['link'] ?? ''}';
    final messages = (_flag['messages'] as List?)?.whereType<Map>().toList() ?? const <Map>[];
    return ListView(padding: const EdgeInsets.all(12), children: [
      Card(
        color: CheColors.surface,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(open ? Icons.lock_open_rounded : Icons.lock_rounded, color: open ? CheColors.success : CheColors.warning),
              const SizedBox(width: 8),
              Text('Flagstaff 369 is ${open ? 'OPEN' : 'LOCKED'}', style: CheType.title),
            ]),
            const SizedBox(height: 10),
            SelectableText(link, style: CheType.mono),
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [
              Semantics(
                button: true,
                label: 'Copy the Flagstaff link',
                child: FilledButton.icon(
                  onPressed: link.isEmpty
                      ? null
                      : () {
                          Clipboard.setData(ClipboardData(text: link));
                          _say('Flagstaff link copied. Paste it into any AI.');
                        },
                  icon: const Icon(Icons.copy_rounded),
                  label: const Text('Copy link'),
                ),
              ),
              Semantics(
                button: true,
                label: open ? 'Lock Flagstaff and save the conversation' : 'Open Flagstaff',
                child: OutlinedButton.icon(
                  onPressed: () => _flagAction(open ? 'lock' : 'open'),
                  icon: Icon(open ? Icons.lock_rounded : Icons.lock_open_rounded),
                  label: Text(open ? 'Lock & save' : 'Open'),
                ),
              ),
              Semantics(
                button: true,
                label: 'Make a new Flagstaff link. The old one stops working.',
                child: TextButton(onPressed: () => _flagAction('new-link'), child: const Text('New link')),
              ),
            ]),
          ]),
        ),
      ),
      const SizedBox(height: 8),
      if (messages.isEmpty)
        const Padding(padding: EdgeInsets.all(20), child: Text('No messages on the board yet.', style: CheType.bodyDim))
      else
        ...messages.map(_message),
      const SizedBox(height: 16),
      Semantics(
        header: true,
        child: const Text('CHE and Claude (repo mailbox)', style: CheType.title),
      ),
      const SizedBox(height: 6),
      if (_claude.isEmpty)
        const Text('No messages with Claude yet.', style: CheType.bodyDim)
      else
        ..._claude.map(_message),
    ]);
  }

  Widget _archiveTab() {
    if (_archive.isEmpty) {
      return const Center(child: Text('No saved sessions yet. Lock Flagstaff to save one.', style: CheType.bodyDim));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: _archive.length,
      itemBuilder: (_, i) {
        final session = _archive[i];
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
      },
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
                    ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _providers.length,
                      itemBuilder: (_, i) {
                        final p = _providers[i];
                        final status = '${p['status']}';
                        final ok = status == 'healthy' || status == 'rate-limited';
                        return Semantics(
                          button: true,
                          label: '${p['name']}: ${_statusWords(status)}. Double tap to add or replace the key.',
                          child: Card(
                            color: CheColors.surface,
                            child: ListTile(
                              leading: Icon(ok ? Icons.vpn_key_rounded : Icons.key_off_rounded, color: ok ? CheColors.success : CheColors.warning),
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
                  ]),
                ),
              ]),
      ),
    );
  }
}
