// Market context in the Trading Room (owner, 2026-10-23): scheduled and unscheduled events that may move NQ/MNQ,
// shown as possible catalysts, never predictions. Everything comes from the Worker's /api/trading/context routes; this
// file only shows it. Every event carries its source; every stage is spelled out in text with an icon, never color
// alone; nothing speaks unless the owner presses Read aloud. No order path exists here.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheContextException implements Exception {
  const CheContextException(this.message);
  final String message;
  @override
  String toString() => message;
}

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
List<Map<String, dynamic>> _list(Object? v) => [for (final x in (v is List ? v : const [])) if (x is Map) Map<String, dynamic>.from(x)];
String _s(Object? v, [String fallback = '']) => v == null ? fallback : '$v';
List<String> _strings(Object? v) => [for (final x in (v is List ? v : const [])) '$x'];

class CheMarketContextClient {
  CheMarketContextClient({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _http;

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() req) async {
    final http.Response r;
    try {
      r = await req().timeout(const Duration(seconds: 25));
    } on TimeoutException {
      throw const CheContextException('CHE did not answer within 25 seconds.');
    } catch (_) {
      throw const CheContextException('The connection to CHE failed.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final m = _map(body);
    if (r.statusCode >= 400) throw CheContextException(_s(m['detail'], 'CHE answered ${r.statusCode}.'));
    return m;
  }

  Uri _u(String path, [Map<String, String>? q]) => Uri.parse('${baseUrl()}$path').replace(queryParameters: q);
  Future<Map<String, dynamic>> view() => _send(() => _http.get(_u('/api/trading/context'), headers: headers()));
  Future<Map<String, dynamic>> upcoming() => _send(() => _http.get(_u('/api/trading/context/upcoming'), headers: headers()));
  Future<List<CheEventAnnotation>> annotations({required String market, DateTime? from, DateTime? to}) async {
    final m = await _send(() => _http.get(
        _u('/api/trading/context/annotations', {'market': market, if (from != null) 'from': from.toUtc().toIso8601String(), if (to != null) 'to': to.toUtc().toIso8601String()}),
        headers: headers()));
    return [for (final a in _list(m['annotations'])) ?CheEventAnnotation.fromJson(a)];
  }

  Future<Map<String, dynamic>> post(String action, Map<String, dynamic> body) => _send(() => _http.post(_u('/api/trading/context/$action'),
      headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body)));
}

/// One event marker for a chart: when the information became public, what it was, and where it came from.
class CheEventAnnotation {
  const CheEventAnnotation({required this.id, required this.time, required this.kind, required this.label, required this.title,
      required this.sourceName, required this.sourceUrl, required this.verified, required this.reaction, required this.scheduled, required this.dateOnly});
  final String id, kind, label, title, sourceName, sourceUrl, verified, reaction;
  final DateTime time;
  final bool scheduled, dateOnly;

  static CheEventAnnotation? fromJson(Map<String, dynamic> j) {
    final t = DateTime.tryParse(_s(j['t']));
    if (t == null) return null;
    return CheEventAnnotation(
      id: _s(j['id']), time: t, kind: _s(j['kind']), label: _s(j['label'], _s(j['kind'])), title: _s(j['title']),
      sourceName: _s(j['source_name'], 'unknown source'), sourceUrl: _s(j['source_url']), verified: _s(j['verified'], 'unverified'),
      reaction: _s(j['reaction_label'], 'no measured reaction'), scheduled: j['scheduled'] == true, dateOnly: j['date_only'] == true,
    );
  }

  /// A two- or three-letter tag drawn on the chart above the event line.
  String get tag => switch (kind) {
        'fomc_decision' || 'fomc_presser' || 'fomc_minutes' => 'FED',
        'cpi' => 'CPI',
        'ppi' => 'PPI',
        'pce' => 'PCE',
        'nfp' => 'NFP',
        'jobless_claims' => 'JC',
        'gdp' => 'GDP',
        'opex_monthly' || 'opex_quarterly' => 'EXP',
        'index_rebalance' => 'RB',
        'earnings' => 'ER',
        'holiday' || 'early_close' => 'HOL',
        'geopolitical' => 'GEO',
        'political_statement' => 'POL',
        _ => 'EV',
      };

  String get receipt => '$label. $title. ${dateOnly ? 'Date only; time not established.' : ''} '
          'Source: $sourceName ($verified). ${scheduled ? 'Scheduled.' : 'Unscheduled.'} Observed reaction: $reaction.'
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
}

class CheUpcomingEvent {
  CheUpcomingEvent(Map<String, dynamic> j)
      : label = _s(j['label']),
        minutes = (j['minutes_until'] is num) ? (j['minutes_until'] as num).round() : 0,
        highImpact = j['high_impact'] == true,
        source = _s(j['source_name']).split(' — ').first;
  final String label, source;
  final int minutes;
  final bool highImpact;
  String get when => minutes < 120 ? 'in $minutes min' : 'in ${(minutes / 60).round()} h';
  String get spoken => '$label ${minutes < 120 ? 'in $minutes minutes' : 'in ${(minutes / 60).round()} hours'}, from $source.';
}

/// "CPI in 25 min": an event-dependency warning for strategy cards and the chart. Text and icon, never color alone.
class CheEventWarningChip extends StatelessWidget {
  const CheEventWarningChip({super.key, required this.event});
  final CheUpcomingEvent event;

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Event warning: ${event.spoken} A possible catalyst, not a prediction.',
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: event.highImpact ? const Color(0xFF3A2A10) : const Color(0xFF1C2433),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: event.highImpact ? const Color(0xFFE0A030) : Colors.white38),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(event.highImpact ? Icons.priority_high_rounded : Icons.event_note_rounded, size: 18, color: Colors.white),
            const SizedBox(width: 6),
            Flexible(
              child: Text('${event.highImpact ? 'HIGH IMPACT · ' : ''}${event.label} ${event.when}',
                  style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
            ),
          ]),
        ),
      );
}

/// The strip under the live chart: upcoming-event warnings for every strategy, and the way into the full page.
class CheMarketContextStrip extends StatefulWidget {
  const CheMarketContextStrip({super.key, required this.client, this.onRead});
  final CheMarketContextClient client;
  final void Function(String text)? onRead;

  @override
  State<CheMarketContextStrip> createState() => _CheMarketContextStripState();
}

class _CheMarketContextStripState extends State<CheMarketContextStrip> {
  List<CheUpcomingEvent> _up = const [];
  String _spoken = '';
  String _error = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final m = await widget.client.upcoming();
      if (!mounted) return;
      setState(() {
        _up = [for (final u in _list(m['upcoming'])) CheUpcomingEvent(u)];
        _spoken = _s(m['spoken']);
        _error = '';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Market events could not be loaded: $e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final soon = _up.where((u) => u.minutes <= 120).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 4, children: [
          Semantics(header: true, child: const Text('MARKET EVENTS', style: TextStyle(color: Color(0xFFE0A030), fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1))),
          if (widget.onRead != null && _spoken.isNotEmpty)
            IconButton(
              key: const Key('context_read'),
              tooltip: 'Read market events aloud',
              onPressed: () => widget.onRead!(_spoken),
              icon: const Icon(Icons.volume_up_rounded, color: Colors.white),
            ),
          TextButton.icon(
            key: const Key('context_open'),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheMarketContextPage(client: widget.client, onRead: widget.onRead))),
            icon: const Icon(Icons.public_rounded, color: Colors.white),
            label: const Text('Market context', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          ),
        ]),
        if (_loading)
          const Text('Loading market events…', style: TextStyle(color: Colors.white70, fontSize: 14))
        else if (_error.isNotEmpty)
          Text(_error, style: const TextStyle(color: Colors.white, fontSize: 14))
        else if (_up.isEmpty)
          const Text('No scheduled event with a known time in the next 24 hours.', key: Key('context_none'), style: TextStyle(color: Colors.white70, fontSize: 14))
        else ...[
          Wrap(spacing: 8, runSpacing: 6, children: [for (final u in _up.take(4)) CheEventWarningChip(event: u)]),
          if (soon.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Applies to every intraday strategy: ${soon.first.label} ${soon.first.when}. Possible catalyst, not a prediction.',
                  key: const Key('context_dependency'), style: const TextStyle(color: Colors.white, fontSize: 14)),
            ),
        ],
      ]),
    );
  }
}

/// The text and icon of a lifecycle stage. Every stage has its own icon so color is never the only cue.
(String, IconData) cheStageBadge(String stage) => switch (stage) {
      'discovered' => ('DISCOVERED', Icons.travel_explore_rounded),
      'rules_documented' => ('RULES DOCUMENTED', Icons.description_outlined),
      'implemented' => ('IMPLEMENTED', Icons.build_circle_outlined),
      'backtested' => ('BACKTESTED', Icons.insights_rounded),
      'forward_tested' => ('FORWARD TESTED', Icons.show_chart_rounded),
      'paper_active' => ('PAPER ACTIVE', Icons.play_circle_outline_rounded),
      _ => (stage.toUpperCase(), Icons.help_outline_rounded),
    };

/// The full Market Context page: models with their stage and why they are not running, events by kind with sources,
/// studies, and forms to add an event or a source. Refresh fetches official calendars only when pressed.
class CheMarketContextPage extends StatefulWidget {
  const CheMarketContextPage({super.key, required this.client, this.onRead});
  final CheMarketContextClient client;
  final void Function(String text)? onRead;

  @override
  State<CheMarketContextPage> createState() => _CheMarketContextPageState();
}

class _CheMarketContextPageState extends State<CheMarketContextPage> {
  Map<String, dynamic>? _view;
  String _error = '';
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.view();
      if (!mounted) return;
      setState(() {
        _view = v;
        _error = '';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Market context could not be loaded: $e');
    }
  }

  Future<void> _act(String action, Map<String, dynamic> body, String doing) async {
    setState(() {
      _busy = true;
      _status = doing;
    });
    unawaited(HapticFeedback.selectionClick());
    try {
      final r = await widget.client.post(action, body);
      final report = _map(r['report']);
      final text = _s(r['spoken']).isNotEmpty
          ? _s(r['spoken'])
          : action == 'refresh'
              ? 'Refreshed: ${_map(report['rules'])['added'] ?? 0} rule-based dates added. ${_list(report['sources']).map((x) => '${_s(x['name']).split(' — ').first}: ${_s(x['status'])}${x['error'] != null ? ' (${x['error']})' : ''}').join('. ')}.'
              : 'Done.';
      if (!mounted) return;
      setState(() => _status = text);
      unawaited(HapticFeedback.mediumImpact());
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = 'Not done: $e');
      unawaited(HapticFeedback.heavyImpact());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _spoken {
    final v = _view;
    if (v == null) return _error;
    final models = _list(v['models']);
    final byStage = <String, int>{};
    for (final m in models) {
      byStage[_s(m['stage_label'])] = (byStage[_s(m['stage_label'])] ?? 0) + 1;
    }
    return 'Market context. ${v['events_total'] ?? 0} events stored. ${models.length} context models: '
        '${byStage.entries.map((e) => '${e.value} ${e.key.toLowerCase()}').join(', ')}. Events are possible catalysts, not predictions. Live trading is disabled.';
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    return Scaffold(
      backgroundColor: const Color(0xFF0B0F17),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0B0F17),
        foregroundColor: Colors.white,
        title: const Text('Market context'),
        actions: [
          if (widget.onRead != null)
            IconButton(key: const Key('context_page_read'), tooltip: 'Read this page aloud', onPressed: () => widget.onRead!(_spoken), icon: const Icon(Icons.volume_up_rounded)),
        ],
      ),
      body: v == null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error.isEmpty ? 'Loading…' : _error, style: const TextStyle(color: Colors.white, fontSize: 16))))
          : ListView(padding: const EdgeInsets.fromLTRB(14, 8, 14, 32), children: [
              const Text('Events are possible catalysts, never predictions. Reactions shown are associations, not causes. Live trading is disabled.',
                  key: Key('context_disclaimer'), style: TextStyle(color: Colors.white, fontSize: 15, height: 1.35)),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                FilledButton.icon(
                  key: const Key('context_refresh'),
                  onPressed: _busy ? null : () => _act('refresh', {}, 'Fetching the official calendars…'),
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('Refresh calendars'),
                ),
                OutlinedButton.icon(
                  key: const Key('context_add_event'),
                  onPressed: _busy ? null : _addEvent,
                  icon: const Icon(Icons.add_rounded, color: Colors.white),
                  label: const Text('Add event', style: TextStyle(color: Colors.white)),
                ),
                OutlinedButton.icon(
                  key: const Key('context_add_source'),
                  onPressed: _busy ? null : _addSource,
                  icon: const Icon(Icons.link_rounded, color: Colors.white),
                  label: const Text('Add source', style: TextStyle(color: Colors.white)),
                ),
              ]),
              if (_status.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Semantics(liveRegion: true, child: Text(_status, key: const Key('context_status'), style: const TextStyle(color: Colors.white, fontSize: 14))),
                ),
              _heading('UPCOMING'),
              if (_list(v['upcoming']).isEmpty)
                const Text('No scheduled event with a known time in the next 24 hours.', style: TextStyle(color: Colors.white70, fontSize: 14))
              else
                Wrap(spacing: 8, runSpacing: 6, children: [for (final u in _list(v['upcoming'])) CheEventWarningChip(event: CheUpcomingEvent(u))]),
              _heading('CONTEXT MODELS'),
              for (final m in _list(v['models'])) _ModelCard(model: m),
              _heading('REGIME TAGS'),
              for (final c in _list(v['classifiers']))
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text('• ${_s(c['name'])}. ${_s(c['note'])}', style: const TextStyle(color: Colors.white, fontSize: 14)),
                ),
              _heading('EVENTS STORED'),
              for (final e in _map(v['events_by_kind']).entries)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text('${_s(_map(e.value)['label'])}: ${_map(e.value)['count'] ?? 0}'
                      '${_strings(_map(e.value)['sources']).isEmpty ? '' : ' — ${_strings(_map(e.value)['sources']).join('; ')}'}',
                      style: const TextStyle(color: Colors.white, fontSize: 14)),
                ),
              _heading('STUDIES'),
              if (_list(v['studies']).isEmpty)
                const Text('No event study has been run yet. Studies use only CHE\'s verified bars.', style: TextStyle(color: Colors.white70, fontSize: 14))
              else
                for (final s in _list(v['studies']))
                  Text('${_s(s['kind'])} on ${_s(s['market'])} ${_s(s['timeframe'])}: ${s['events_measured'] ?? 0} events measured (${_s(s['sample'])} sample).',
                      style: const TextStyle(color: Colors.white, fontSize: 14)),
            ]),
    );
  }

  Widget _heading(String t) => Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 8),
        child: Semantics(header: true, child: Text(t, style: const TextStyle(color: Color(0xFFE0A030), fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1))),
      );

  Future<void> _addEvent() async {
    final r = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => const _AddEventDialog());
    if (r != null) await _act('event', r, 'Checking and storing the event…');
  }

  Future<void> _addSource() async {
    final r = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => const _AddSourceDialog());
    if (r != null) await _act('source', r, 'Checking the source…');
  }
}

class _ModelCard extends StatelessWidget {
  const _ModelCard({required this.model});
  final Map<String, dynamic> model;

  @override
  Widget build(BuildContext context) {
    final (stage, icon) = cheStageBadge(_s(model['stage']));
    final sources = _list(model['sources']);
    final reason = _s(model['reason_not_running']);
    final limits = _s(model['source_limits']);
    return Semantics(
      container: true,
      label: '${_s(model['name'])}. Stage: $stage. ${model['events_stored'] ?? 0} events stored. Not running because: $reason'
          '${limits.isEmpty ? '' : ' Source limits: $limits'}',
      excludeSemantics: true,
      child: Container(
        key: Key('context_model_${_s(model['id'])}'),
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: const Color(0xFF131A26), borderRadius: BorderRadius.circular(12), border: Border.all(color: Colors.white24)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_s(model['name']), style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          Row(children: [
            Icon(icon, size: 18, color: Colors.white),
            const SizedBox(width: 6),
            Text(stage, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w800, letterSpacing: 0.6)),
            const SizedBox(width: 10),
            Text('${model['events_stored'] ?? 0} events', style: const TextStyle(color: Colors.white70, fontSize: 13)),
          ]),
          const SizedBox(height: 6),
          Text('Not running: $reason', style: const TextStyle(color: Colors.white, fontSize: 14)),
          if (limits.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Source limits: $limits', style: const TextStyle(color: Colors.white, fontSize: 13))),
          const SizedBox(height: 4),
          Text('Rules: ${_s(model['rules'])}', style: const TextStyle(color: Colors.white70, fontSize: 13)),
          if (sources.isNotEmpty) Text('Sources: ${sources.map((x) => _s(x['name'])).join('; ')}', style: const TextStyle(color: Colors.white70, fontSize: 13)),
          Text('Limits: ${_strings(model['limitations']).join(' ')}', style: const TextStyle(color: Colors.white70, fontSize: 13)),
        ]),
      ),
    );
  }
}

const kContextEventKinds = <String, String>{
  'political_statement': 'Statement or post by a political figure',
  'geopolitical': 'Geopolitical development',
  'earnings': 'Large-company earnings',
  'fomc_decision': 'FOMC decision',
  'cpi': 'CPI',
  'nfp': 'Payrolls',
  'pce': 'PCE',
  'major_release': 'Other major release',
  'other': 'Other documented event',
};

class _AddEventDialog extends StatefulWidget {
  const _AddEventDialog();
  @override
  State<_AddEventDialog> createState() => _AddEventDialogState();
}

class _AddEventDialogState extends State<_AddEventDialog> {
  String _kind = 'political_statement';
  final _title = TextEditingController();
  final _time = TextEditingController();
  final _source = TextEditingController();
  final _reported = TextEditingController();

  @override
  void dispose() {
    for (final c in [_title, _time, _source, _reported]) {
      c.dispose();
    }
    super.dispose();
  }

  InputDecoration _d(String label, String hint) => InputDecoration(labelText: label, hintText: hint);

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Add a market event'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<String>(
              initialValue: _kind,
              decoration: const InputDecoration(labelText: 'Kind'),
              items: [for (final e in kContextEventKinds.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
              onChanged: (v) => setState(() => _kind = v ?? _kind),
            ),
            TextField(key: const Key('ev_title'), controller: _title, decoration: _d('What happened', 'e.g. Post about tariffs')),
            TextField(key: const Key('ev_time'), controller: _time, decoration: _d('Original time (UTC, ISO)', '2026-04-02T14:05:00Z')),
            TextField(key: const Key('ev_source'), controller: _source, decoration: _d('Source link (https)', 'link to the post or a news report')),
            TextField(key: const Key('ev_reported'), controller: _reported, decoration: _d('Report time, if from a news report (optional)', '2026-04-02T14:20:00Z')),
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('CHE stores the time and link you give and labels the event owner-cited and unverified. It is measured from the later of the post and report times.',
                  style: TextStyle(fontSize: 13)),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            key: const Key('ev_save'),
            onPressed: () => Navigator.pop(context, {
              'kind': _kind,
              'title': _title.text.trim(),
              'event_time': _time.text.trim(),
              'source_url': _source.text.trim(),
              'source_name': 'Owner-cited source',
              if (_reported.text.trim().isNotEmpty) ...{'reported_at': _reported.text.trim(), 'report_url': _source.text.trim()},
            }),
            child: const Text('Save'),
          ),
        ],
      );
}

class _AddSourceDialog extends StatefulWidget {
  const _AddSourceDialog();
  @override
  State<_AddSourceDialog> createState() => _AddSourceDialogState();
}

class _AddSourceDialogState extends State<_AddSourceDialog> {
  String _type = 'ics';
  final _name = TextEditingController();
  final _url = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Add a calendar or news source'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          DropdownButtonFormField<String>(
            initialValue: _type,
            decoration: const InputDecoration(labelText: 'Type'),
            items: const [
              DropdownMenuItem(value: 'ics', child: Text('Calendar file (iCalendar)')),
              DropdownMenuItem(value: 'calendar', child: Text('Calendar web page (reference)')),
              DropdownMenuItem(value: 'news', child: Text('News source (reference)')),
              DropdownMenuItem(value: 'other', child: Text('Other (reference)')),
            ],
            onChanged: (v) => setState(() => _type = v ?? _type),
          ),
          TextField(key: const Key('src_name'), controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          TextField(key: const Key('src_url'), controller: _url, decoration: const InputDecoration(labelText: 'Link (https)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            key: const Key('src_save'),
            onPressed: () => Navigator.pop(context, {'type': _type, 'name': _name.text.trim(), 'url': _url.text.trim()}),
            child: const Text('Add'),
          ),
        ],
      );
}
