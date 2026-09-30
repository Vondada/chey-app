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
  });

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
      ]).timeout(const Duration(seconds: 20));
      final letters = jsonDecode(responses[0].body);
      final keys = jsonDecode(responses[1].body);
      if (!mounted) return;
      setState(() {
        _letters = letters is Map && letters['letters'] is List
            ? (letters['letters'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
        _providers = keys is Map && keys['providers'] is List
            ? (keys['providers'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : const [];
        _loading = false;
      });
      final unread = _letters.where((l) => l['read'] != true).length;
      _say(unread == 0 ? 'Mailbox open. No new letters.' : 'Mailbox open. $unread unread letters.');
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
      length: 2,
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(
          backgroundColor: CheColors.bg,
          title: const Text('Keys & Mailbox'),
          actions: [
            IconButton(
              tooltip: 'Refresh',
              onPressed: _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
          bottom: const TabBar(tabs: [Tab(text: 'Mailbox'), Tab(text: 'Keys')]),
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
