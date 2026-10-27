// More → Brain Ledger: what entered CHE's brain, when, in which category, from where, what it became, and whether it
// is usable yet (/api/brain/ledger, server/cloudflare/brain_ledger.js). Category first; time is metadata on every
// item. Loading is quiet; Read Aloud and the owner's own actions speak. Every question here also works in chat:
// "what entered your brain today", "what entered your trading brain", "what knowledge is still pending",
// "when did you learn that", "do you know how to ...".
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheBrainLedgerClient {
  CheBrainLedgerClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<Map<String, dynamic>> _decode(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await send().timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw Exception('CHE did not answer within 20 seconds.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? map['said']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return map;
  }

  Uri _uri(Map<String, String> q) => Uri.parse('$baseUrl/api/brain/ledger').replace(queryParameters: q.isEmpty ? null : q);
  Future<Map<String, dynamic>> overview() => _decode(() => _client.get(_uri(const {}), headers: headers()));
  Future<Map<String, dynamic>> category(String name, {String subcategory = ''}) =>
      _decode(() => _client.get(_uri({'category': name, if (subcategory.isNotEmpty) 'subcategory': subcategory}), headers: headers()));
  Future<Map<String, dynamic>> event(String id) => _decode(() => _client.get(_uri({'event': id}), headers: headers()));
  Future<Map<String, dynamic>> batch(String id) => _decode(() => _client.get(_uri({'batch': id}), headers: headers()));
  Future<Map<String, dynamic>> decide(String recordId, String decision) => _decode(() => _client.post(
        Uri.parse('$baseUrl/api/brain/ledger/decide'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'record_id': recordId, 'decision': decision}),
      ));
}

/// The spoken overview, the same facts the page shows: totals, then the most recently populated categories.
String cheBrainLedgerSummary(Map<String, dynamic> v) {
  final t = Map<String, dynamic>.from(v['totals'] as Map? ?? const {});
  final cats = [for (final c in (v['categories'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
  final active = cats.where((c) => c['last_populated'] != null).toList();
  if (active.isEmpty) return 'Nothing has entered my brain yet.';
  final parts = <String>[
    'My brain holds ${t['knowledge'] ?? 0} knowledge items, ${t['procedures'] ?? 0} procedures and ${t['capabilities'] ?? 0} verified capabilities.',
    if (((t['pending'] as num?) ?? 0) > 0) '${t['pending']} pending, not yet learned.',
    if (((t['failed'] as num?) ?? 0) > 0) '${t['failed']} failed to index.',
    'Most recent: ${active.take(3).map((c) => '${c['category']}, ${c['last_populated_label']}').join('; ')}.',
  ];
  return parts.join(' ');
}

String _cardLabel(Map<String, dynamic> c) =>
    '${c['category']}. ${c['items']} knowledge items, ${c['procedures']} procedures, ${c['capabilities']} verified capabilities'
    '${((c['pending'] as num?) ?? 0) > 0 ? ', ${c['pending']} pending' : ''}. Last populated ${c['last_populated_label']}.';

class CheBrainLedgerScreen extends StatefulWidget {
  const CheBrainLedgerScreen({super.key, required this.client, this.onSpeak, this.onListen});
  final CheBrainLedgerClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheBrainLedgerScreen> createState() => _CheBrainLedgerScreenState();
}

class _CheBrainLedgerScreenState extends State<CheBrainLedgerScreen> {
  Map<String, dynamic>? _view;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.overview();
      if (!mounted) return;
      setState(() { _view = v; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load the brain ledger: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  Future<void> _openCategory(String name) async {
    HapticFeedback.selectionClick();
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheBrainLedgerCategoryScreen(client: widget.client, category: name, onSpeak: widget.onSpeak),
    ));
    unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final theme = Theme.of(context).textTheme;
    final cats = [for (final c in (v?['categories'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    final recent = [for (final e in (v?['recent'] as List? ?? const [])) Map<String, dynamic>.from(e as Map)];
    final summary = v == null ? '' : cheBrainLedgerSummary(v);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Brain Ledger'),
        actions: [
          IconButton(tooltip: 'Ask CHE what entered her brain', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Reload the brain ledger', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
        ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: theme.titleMedium)))
          : v == null
              // Passive loading stays quiet: muted text, no announcement.
              ? Center(child: Text('Loading the brain ledger…', style: theme.bodyLarge?.copyWith(color: Theme.of(context).hintColor)))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(summary, style: theme.titleMedium),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      icon: const Icon(Icons.record_voice_over_rounded),
                      label: const Text('Read Aloud'),
                      onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(summary),
                    ),
                    const SizedBox(height: 20),
                    Text('Categories', style: theme.titleLarge),
                    for (final c in cats) _card(c),
                    if (recent.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      Text('Recently entered', style: theme.titleLarge),
                      for (final e in recent) CheBrainLedgerEventTile(event: e, client: widget.client, onSpeak: widget.onSpeak),
                    ],
                  ],
                ),
    );
  }

  Widget _card(Map<String, dynamic> c) {
    final empty = c['last_populated'] == null;
    return Semantics(
      container: true,
      button: true,
      label: _cardLabel(c),
      onTap: () => unawaited(_openCategory('${c['category']}')),
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(empty ? Icons.hourglass_empty_rounded : Icons.psychology_rounded),
          title: Text('${c['category']}'),
          subtitle: Text('${c['items']} knowledge · ${c['procedures']} procedures · ${c['capabilities']} capabilities'
              '${((c['pending'] as num?) ?? 0) > 0 ? ' · ${c['pending']} pending' : ''}\nLast populated: ${c['last_populated_label']}'),
          isThreeLine: true,
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => unawaited(_openCategory('${c['category']}')),
        ),
      ),
    );
  }
}

/// One category: its subcategories, then events newest first; a batch is one grouped entry.
class CheBrainLedgerCategoryScreen extends StatefulWidget {
  const CheBrainLedgerCategoryScreen({super.key, required this.client, required this.category, this.onSpeak});
  final CheBrainLedgerClient client;
  final String category;
  final ValueChanged<String>? onSpeak;

  @override
  State<CheBrainLedgerCategoryScreen> createState() => _CheBrainLedgerCategoryScreenState();
}

class _CheBrainLedgerCategoryScreenState extends State<CheBrainLedgerCategoryScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  String _sub = '';
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.category(widget.category, subcategory: _sub);
      if (!mounted) return;
      setState(() { _view = v; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load ${widget.category}: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  /// An owner action: visible text, a haptic pattern and a VoiceOver announcement with the real outcome.
  Future<void> _decide(Map<String, dynamic> e, String decision) async {
    if (_busy) return;
    setState(() => _busy = true);
    var ok = false;
    String said;
    try {
      final out = await widget.client.decide('${e['record_id']}', decision);
      said = '${out['said'] ?? 'Done.'}';
      ok = out['ok'] == true;
    } catch (err) {
      said = 'That did not work: ${err.toString().replaceFirst('Exception: ', '')}';
    }
    if (!mounted) return;
    ok ? HapticFeedback.mediumImpact() : HapticFeedback.heavyImpact();
    setState(() { _busy = false; _status = said; });
    unawaited(SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final v = _view;
    final subs = [for (final s in (v?['subcategories'] as List? ?? const [])) '$s'];
    final events = [for (final e in (v?['events'] as List? ?? const [])) Map<String, dynamic>.from(e as Map)];
    final readable = events.isEmpty
        ? 'Nothing has entered my ${widget.category} brain yet.'
        : '${widget.category}. ${events.take(8).map((e) => e['kind'] == 'batch' ? '${e['title']}, ${e['items']} items, ${e['time']}' : '${e['spoken']}').join(' ')}';
    return Scaffold(
      appBar: AppBar(title: Text(widget.category)),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: theme.titleMedium)))
          : v == null
              ? Center(child: Text('Loading ${widget.category}…', style: theme.bodyLarge?.copyWith(color: Theme.of(context).hintColor)))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      ChoiceChip(label: const Text('All'), selected: _sub.isEmpty, onSelected: (_) { setState(() => _sub = ''); unawaited(_load()); }),
                      for (final s in subs)
                        ChoiceChip(label: Text(s), selected: _sub == s, onSelected: (_) { setState(() => _sub = s); unawaited(_load()); }),
                    ]),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      icon: const Icon(Icons.record_voice_over_rounded),
                      label: const Text('Read Aloud'),
                      onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(readable),
                    ),
                    if (_status.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Semantics(liveRegion: true, child: Text(_status, style: theme.titleMedium)),
                      ),
                    const SizedBox(height: 12),
                    if (events.isEmpty) Text('Nothing has entered this part of my brain yet.', style: theme.bodyLarge),
                    for (final e in events)
                      if (e['kind'] == 'batch') _batch(e) else ...[
                        CheBrainLedgerEventTile(event: e, client: widget.client, onSpeak: widget.onSpeak),
                        if (e['status'] == 'Pending')
                          Wrap(spacing: 8, children: [
                            TextButton.icon(
                              icon: const Icon(Icons.check_rounded),
                              label: Text('Commit ${e['title']}'),
                              onPressed: _busy ? null : () => unawaited(_decide(e, 'commit')),
                            ),
                            TextButton.icon(
                              icon: const Icon(Icons.close_rounded),
                              label: Text('Reject ${e['title']}'),
                              onPressed: _busy ? null : () => unawaited(_decide(e, 'reject')),
                            ),
                          ]),
                      ],
                  ],
                ),
    );
  }

  Widget _batch(Map<String, dynamic> b) {
    final groups = [for (final g in (b['groups'] as List? ?? const [])) Map<String, dynamic>.from(g as Map)];
    final label = '${b['title']}, ${b['time']}. ${b['items']} items: ${groups.map((g) => '${g['name']} ${g['count']}').join(', ')}.';
    return Semantics(
      container: true,
      button: true,
      label: label,
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.inventory_2_outlined),
          title: Text('${b['title']}'),
          subtitle: Text('${b['time']} · ${b['items']} items\n${groups.map((g) => '${g['name']}: ${g['count']}').join(' · ')}'),
          isThreeLine: true,
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => unawaited(_openBatch(b)),
        ),
      ),
    );
  }

  Future<void> _openBatch(Map<String, dynamic> b) async {
    HapticFeedback.selectionClick();
    final Map<String, dynamic> out;
    try {
      out = await widget.client.batch('${b['batch_id']}');
    } catch (e) {
      if (mounted) setState(() => _status = 'That batch did not load: ${e.toString().replaceFirst('Exception: ', '')}');
      return;
    }
    if (!mounted) return;
    final members = [for (final e in (out['events'] as List? ?? const [])) Map<String, dynamic>.from(e as Map)].where((e) => e['event_type'] != 'BATCH_RECEIPT').toList();
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        appBar: AppBar(title: Text('${b['title']}')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          for (final e in members) CheBrainLedgerEventTile(event: e, client: widget.client, onSpeak: widget.onSpeak),
        ]),
      ),
    ));
  }
}

/// One ledger event. VoiceOver reads the Worker's `spoken` sentence; opening it shows the full history and links.
class CheBrainLedgerEventTile extends StatelessWidget {
  const CheBrainLedgerEventTile({super.key, required this.event, required this.client, this.onSpeak});
  final Map<String, dynamic> event;
  final CheBrainLedgerClient client;
  final ValueChanged<String>? onSpeak;

  @override
  Widget build(BuildContext context) {
    final e = event;
    final status = '${e['status'] ?? ''}';
    return Semantics(
      container: true,
      button: true,
      label: '${e['spoken'] ?? '${e['category']}. ${e['title']}. $status.'}',
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(status == 'Verified capability'
              ? Icons.verified_rounded
              : status == 'Procedure'
                  ? Icons.school_rounded
                  : status == 'Pending'
                      ? Icons.hourglass_empty_rounded
                      : status == 'Failed'
                          ? Icons.error_outline_rounded
                          : Icons.psychology_rounded),
          title: Text('${e['title']}'),
          subtitle: Text('${e['time']} · ${e['category']} → ${e['subcategory']}\n$status'),
          isThreeLine: true,
          onTap: () => unawaited(_open(context)),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    HapticFeedback.selectionClick();
    final Map<String, dynamic> d;
    try {
      d = await client.event('${event['brain_event_id']}');
    } catch (_) {
      return;
    }
    if (!context.mounted) return;
    final theme = Theme.of(context).textTheme;
    final history = [for (final h in (d['history'] as List? ?? const [])) Map<String, dynamic>.from(h as Map)];
    final usedBy = [for (final w in (d['used_by'] as List? ?? const [])) Map<String, dynamic>.from(w as Map)];
    final cap = d['capability'] is Map ? Map<String, dynamic>.from(d['capability'] as Map) : null;
    final lines = <String>[
      '${d['title']}',
      'Entered: ${d['full_time']}',
      'Category: ${d['category']} → ${d['subcategory']}',
      'Status: ${d['status']}',
      if ('${d['source_type'] ?? ''}'.isNotEmpty) 'Source: ${'${d['source_type']}'.toLowerCase()}${'${d['source_reference'] ?? ''}'.isNotEmpty ? ' (${d['source_reference']})' : ''}',
      if ('${d['reason_saved'] ?? ''}'.isNotEmpty) 'Why saved: ${d['reason_saved']}',
      if ('${d['summary'] ?? ''}'.isNotEmpty) '${d['summary']}',
      if (d['detail'] is Map && (d['detail'] as Map)['original'] != null) 'Original: ${(d['detail'] as Map)['original']}. Corrected: ${(d['detail'] as Map)['corrected']}.',
      if (cap != null) 'Capability: ${cap['name']}, ${'${cap['status']}'.toLowerCase()}${cap['usable'] == true ? ', usable' : ', not usable yet'}.',
      if (usedBy.isNotEmpty) 'Used by: ${usedBy.map((w) => w['name']).join(', ')}.',
      if (history.length > 1) 'History: ${history.map((h) => '${h['time']} ${h['event']}${'${h['state']}'.isNotEmpty ? ' (${'${h['state']}'.toLowerCase()})' : ''}').join('; ')}.',
    ];
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              for (final (i, l) in lines.indexed) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(l, style: i == 0 ? theme.titleLarge : theme.bodyLarge)),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.record_voice_over_rounded),
                label: const Text('Read Aloud'),
                onPressed: onSpeak == null ? null : () => onSpeak!(lines.join('. ')),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
