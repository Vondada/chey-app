// Trading connections in the Trading Room (owner directive, issue #344): every broker as its
// own system reports it, from /api/trading/connections. Nothing here reads "connected" until
// the provider proved it, and nothing changes a trading mode. It loads quietly and never speaks
// by itself; "Read aloud" asks CHE, who answers from the same view.
//
// The Alpaca paper key pair is typed into masked fields, sent once to CHE (which checks it with
// Alpaca's paper service before saving), and cleared from the screen. CHE never sends it back.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

const _dim = Color(0xFF8FA4A1);
const _panel = Color(0xFF0A1214);
const _stroke = Color(0xFF1B2A2D);
const _good = Color(0xFF3DDC97);
const _warn = Color(0xFFE8B04A);
const _bad = Color(0xFFFF5C7A);

/// The words for each state, the same ones CHE says aloud.
const cheConnectionStateWords = {
  'on': 'on', 'off': 'off', 'not_configured': 'not set up', 'configured': 'set up, not signed in',
  'signed_in': 'signed in', 'expired': 'sign-in expired', 'verified': 'verified', 'rejected': 'key rejected',
  'refused': 'live key refused', 'unavailable': 'could not be checked', 'unsupported': 'not supported',
};

Color _tone(String state) => switch (state) {
      'on' || 'signed_in' || 'verified' => _good,
      'rejected' || 'refused' || 'expired' => _bad,
      _ => _warn,
    };

class CheTradingConnectionsPanel extends StatefulWidget {
  const CheTradingConnectionsPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<CheTradingConnectionsPanel> createState() => _CheTradingConnectionsPanelState();
}

class _CheTradingConnectionsPanelState extends State<CheTradingConnectionsPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _view;
  String _error = '';
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/connections'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map || j['cards'] is! List) {
        setState(() => _error = j is Map && j['detail'] != null ? '${j['detail']}' : 'Trading connections are not available from CHE yet (${r.statusCode}).');
        return;
      }
      setState(() { _view = Map<String, dynamic>.from(j); _error = ''; });
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach CHE for the trading connections.');
    }
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final r = await _http.post(Uri.parse('${widget.baseUrl()}$path'),
        headers: {...widget.headers(), 'content-type': 'application/json'}, body: jsonEncode(body)).timeout(const Duration(seconds: 30));
    final j = jsonDecode(utf8.decode(r.bodyBytes));
    return j is Map ? Map<String, dynamic>.from(j) : {'detail': 'CHE answered ${r.statusCode}.'};
  }

  Future<void> _addAlpacaKeys() async {
    final id = TextEditingController();
    final secret = TextEditingController();
    final send = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Alpaca paper keys'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Paper keys only: the key ID starts with PK. CHE checks them with Alpaca\'s paper service before saving and refuses live keys.'),
          const SizedBox(height: 12),
          TextField(controller: id, autocorrect: false, enableSuggestions: false, decoration: const InputDecoration(labelText: 'Paper key ID')),
          TextField(controller: secret, obscureText: true, autocorrect: false, enableSuggestions: false, decoration: const InputDecoration(labelText: 'Paper secret')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Check and save')),
        ],
      ),
    );
    final keyId = id.text.trim();
    final keySecret = secret.text.trim();
    // The pair leaves the screen as soon as it is read (the fields may still be animating closed,
    // so the controllers are cleared, not disposed, here).
    id.clear();
    secret.clear();
    if (send != true || keyId.isEmpty || keySecret.isEmpty) return;
    await _act(() => _post('/api/trading/alpaca/keys', {'key_id': keyId, 'secret': keySecret}),
        ok: (j) => 'Alpaca paper keys saved: key ending ${j['key_last4'] ?? ''} verified.');
  }

  Future<void> _removeAlpacaKeys() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove the Alpaca paper keys?'),
        content: const Text('CHE will stop reading your Alpaca paper account until you add keys again. Your Alpaca account itself is not changed.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep them')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Remove')),
        ],
      ),
    );
    if (yes != true) return;
    await _act(() => _post('/api/trading/alpaca/keys', {'action': 'remove', 'confirm': true}), ok: (j) => '${j['detail'] ?? 'Removed.'}');
  }

  Future<void> _act(Future<Map<String, dynamic>> Function() call, {required String Function(Map<String, dynamic>) ok}) async {
    if (_busy) return;
    setState(() { _busy = true; _status = ''; });
    try {
      final j = await call();
      final done = j['ok'] == true;
      if (done) {
        HapticFeedback.mediumImpact();
      } else {
        HapticFeedback.heavyImpact();
      }
      if (mounted) setState(() => _status = done ? ok(j) : 'Not changed: ${j['detail'] ?? 'CHE refused it.'}');
      if (done) await _load();
    } catch (_) {
      HapticFeedback.heavyImpact();
      if (mounted) setState(() => _status = 'Not changed: CHE did not answer.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _card(Map<String, dynamic> c) {
    final state = '${c['state'] ?? ''}';
    final word = cheConnectionStateWords[state] ?? state;
    final mode = c['mode'] == null ? '' : '${c['mode']}';
    final detail = '${c['detail'] ?? ''}';
    final blocked = (c['blocked_by'] as List?)?.map((e) => '$e').toList() ?? const <String>[];
    final data = c['data'] is Map ? Map<String, dynamic>.from(c['data'] as Map) : null;
    final feed = data == null || data['label'] == null ? '' : '${data['label']} data from ${data['source'] ?? 'an unnamed source'}${data['lag_minutes'] == null ? '' : ', about ${data['lag_minutes']} minutes behind'}';
    return Semantics(
      container: true,
      label: '${c['name']}: $word${mode.isEmpty ? '' : ', mode $mode'}. ${feed.isEmpty ? '' : '$feed. '}$detail',
      excludeSemantics: c['id'] != 'alpaca',
      child: Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(10)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('${c['name']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16))),
            if (mode.isNotEmpty) Padding(padding: const EdgeInsets.only(right: 6), child: Text(mode, style: const TextStyle(color: _dim, fontWeight: FontWeight.w700, fontSize: 12))),
            Text(word, style: TextStyle(color: _tone(state), fontWeight: FontWeight.w800, fontSize: 13)),
          ]),
          if (feed.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(feed, style: const TextStyle(color: _dim, fontSize: 13))),
          if (detail.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(detail, style: const TextStyle(color: Colors.white70, fontSize: 14))),
          for (final b in blocked) Padding(padding: const EdgeInsets.only(top: 2), child: Text('• $b', style: const TextStyle(color: _dim, fontSize: 13))),
          if (c['open_account'] != null && blocked.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: SelectableText('Open an account: ${c['open_account']}', style: const TextStyle(color: _dim, fontSize: 13))),
          if (c['id'] == 'alpaca')
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                OutlinedButton(onPressed: _busy ? null : _addAlpacaKeys, child: Text(state == 'not_configured' ? 'Add paper keys' : 'Replace paper keys')),
                if (state != 'not_configured') TextButton(onPressed: _busy ? null : _removeAlpacaKeys, child: const Text('Remove keys')),
              ]),
            ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final cards = (v?['cards'] as List?)?.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() ?? const <Map<String, dynamic>>[];
    final permissions = v?['permissions'] is Map ? Map<String, dynamic>.from(v!['permissions'] as Map) : const <String, dynamic>{};
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Expanded(child: Text('Trading connections', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
        IconButton(tooltip: 'Refresh trading connections', onPressed: _busy ? null : _load, icon: const Icon(Icons.refresh, color: _dim)),
        TextButton(onPressed: () => widget.onAsk('What are my trading connections?'), child: const Text('Read aloud')),
      ]),
      if (v != null)
        Semantics(
          label: 'Trading mode ${v['mode']}. Live orders: ${permissions['live_orders'] ?? 'off'}.',
          excludeSemantics: true,
          child: Text('Mode ${v['mode']} · Live orders: ${permissions['live_orders'] ?? 'off'}', style: const TextStyle(color: _dim, fontSize: 13)),
        ),
      if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error, style: const TextStyle(color: _dim, fontSize: 13))),
      for (final c in cards) _card(c),
      if (_status.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_status, style: const TextStyle(color: Colors.white70, fontSize: 14))),
    ]);
  }
}
