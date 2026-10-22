// Trading Intelligence in the Trading Room (owner, 2026-10-22): the historical study of
// /api/trading/intelligence. It shows each dataset with its source, range, gaps and checksum,
// the out-of-sample ranking per dataset, the look-ahead audit, regimes for the best measured rule,
// this year's paper comparison and the journalled paper signals. Every number comes from the
// Worker's stored tests; nothing is computed or invented here, and nothing speaks by itself.
// "Read aloud" asks CHE, who answers from the same stored tests. Paper only.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../che_ui/che_theme.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = CheColors.markets;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;

/// The spoken requests behind the Read aloud and Run buttons (the Worker's che_trading_intelligence route).
const kReadIntelligenceAloud = 'How did your strategies do historically on Nasdaq futures?';
const kReadIntelligenceReport = 'Read the historical trading intelligence report.';

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');
String _r(Object? v) {
  final x = _num(v);
  if (x == null) return '—';
  return '${x >= 0 ? '+' : '−'}${x.abs().toStringAsFixed(2)} R';
}

String _spokenR(Object? v) {
  final x = _num(v);
  if (x == null) return 'not measured';
  return '${x < 0 ? 'minus ' : ''}${x.abs().toStringAsFixed(2)} R';
}

String _day(Object? iso) {
  final s = '${iso ?? ''}';
  return s.length >= 10 ? s.substring(0, 10) : '—';
}

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
List<Map<String, dynamic>> _list(Object? v) => ((v as List?) ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();

class CheTradingIntelligencePanel extends StatefulWidget {
  const CheTradingIntelligencePanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<CheTradingIntelligencePanel> createState() => _CheTradingIntelligencePanelState();
}

class _CheTradingIntelligencePanelState extends State<CheTradingIntelligencePanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _d;
  String _error = '';
  String _action = '';
  bool _running = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/intelligence'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map || j['state'] is! Map) {
        setState(() => _error = j is Map && j['detail'] != null ? '${j['detail']}' : 'The historical study is not available from CHE yet (${r.statusCode}).');
        return;
      }
      setState(() { _d = Map<String, dynamic>.from(j); _error = ''; });
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach CHE for the historical study.');
    }
  }

  // The owner pressed Run: the result is shown as quiet text; it is read aloud only from Read aloud.
  Future<void> _run() async {
    setState(() { _running = true; _action = 'Running the historical study. Free public data only; no order is placed.'; });
    try {
      final r = await _http
          .post(Uri.parse('${widget.baseUrl()}/api/trading/intelligence'), headers: {...widget.headers(), 'content-type': 'application/json'}, body: jsonEncode({'action': 'run'}))
          .timeout(const Duration(seconds: 60));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode == 200 && j is Map && j['view'] is Map) {
        setState(() {
          _d = Map<String, dynamic>.from(j['view'] as Map);
          _action = j['status'] == 'complete' ? 'The historical study finished.' : 'The historical study is running; it continues on its own.';
        });
      } else {
        setState(() => _action = 'The study did not start: ${j is Map ? j['detail'] ?? r.statusCode : r.statusCode}.');
      }
    } catch (_) {
      if (mounted) setState(() => _action = 'Could not reach CHE to run the study. Nothing was changed.');
    } finally {
      if (mounted) setState(() => _running = false);
    }
  }

  Widget _button(String label, String semantics, IconData icon, VoidCallback? onPressed) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: OutlinedButton.icon(onPressed: onPressed, icon: Icon(icon), label: Text(label)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final state = _map(d?['state']);
    final status = '${state['status'] ?? ''}';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Expanded(child: Text('Trading Intelligence', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
        Semantics(
          label: 'Research and paper only',
          excludeSemantics: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(border: Border.all(color: _gold), borderRadius: BorderRadius.circular(6), color: _gold.withValues(alpha: 0.12)),
            child: const Text('PAPER', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 0.6)),
          ),
        ),
      ]),
      const SizedBox(height: 4),
      Text('Decades of free Nasdaq-100 history, each strategy tested with fills at the next open and ranked on out-of-sample results only.',
          style: TextStyle(color: _dim, fontSize: 13)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        _button('Read aloud', 'Read the historical study aloud', Icons.record_voice_over_outlined, () => widget.onAsk(kReadIntelligenceAloud)),
        _button('Report', 'Read the auditable report with sources and checksums aloud', Icons.fact_check_outlined, () => widget.onAsk(kReadIntelligenceReport)),
        _button(_running ? 'Running…' : 'Run study', 'Run the historical study. Free data, no orders.', Icons.play_arrow_rounded, _running ? null : () => unawaited(_run())),
        _button('Refresh', 'Refresh the historical study', Icons.refresh, () => unawaited(_load())),
      ]),
      if (_action.isNotEmpty) Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(_action, style: TextStyle(color: _dim, fontSize: 15)),
      ),
      const SizedBox(height: 10),
      if (d == null)
        Text(_error.isEmpty ? 'Loading the historical study…' : _error, style: TextStyle(color: _dim, fontSize: 16))
      else ...[
        Text(
          switch (status) {
            'never run' => 'No historical study has run yet. Run study fetches the free histories, verifies them and tests every daily rule.',
            'running' => 'Running: ${state['done']} of ${state['total']} steps done.',
            _ => 'Last study finished ${_day(state['finished_at'])}.',
          },
          style: const TextStyle(color: Colors.white, fontSize: 15),
        ),
        for (final e in ((state['errors'] as List?) ?? const [])) Text('$e', style: const TextStyle(color: _down, fontSize: 13)),
        const SizedBox(height: 10),
        for (final ds in _list(d['datasets'])) Padding(padding: const EdgeInsets.only(bottom: 10), child: _DatasetCard(ds)),
        for (final r in _list(d['results'])) Padding(padding: const EdgeInsets.only(bottom: 10), child: _ResultCard(r, _list(d['datasets']))),
        if (d['intraday'] is Map) _NoteCard(
          title: 'Intraday rules',
          text: 'VWAP, opening range, EMA and the ICT 5-minute rules come from the five-minute research of ${_day(_map(d['intraday'])['at'])}: about 60 days of free data, a small sample.',
        ),
        if (d['compare'] is Map) _NoteCard(
          title: 'This year\'s paper trades',
          text: '${_map(d['compare'])['paper_trades']} paper trades in ${_map(d['compare'])['year']}, after removing ${_map(d['compare'])['duplicates_removed']} duplicates. Each set is compared, never added to the history.',
        ),
        _SignalsCard(_list(d['signals'])),
        for (final n in _list(d['not_tested'])) _NoteCard(title: 'Not tested: ${n['name']}', text: '${n['why']}'),
        _NoteCard(title: 'Safety', text: '${d['safety'] ?? 'Research and paper only.'}'),
      ],
    ]);
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.label, required this.children});
  final String label;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        container: true,
        child: ExcludeSemantics(
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(12)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
          ),
        ),
      );
}

class _NoteCard extends StatelessWidget {
  const _NoteCard({required this.title, required this.text});
  final String title, text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: _Card(label: '$title. $text', children: [
          Text(title, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text(text, style: TextStyle(color: _dim, fontSize: 13)),
        ]),
      );
}

class _DatasetCard extends StatelessWidget {
  const _DatasetCard(this.ds);
  final Map<String, dynamic> ds;

  @override
  Widget build(BuildContext context) {
    final ok = ds['ok'] == true;
    final label = '${ds['label'] ?? ds['id']}';
    final gaps = _map(ds['gaps']);
    final jumps = _map(ds['jumps']);
    final sum = '${ds['checksum_sha256'] ?? ''}';
    final lines = ok
        ? [
            '${ds['bars']} daily bars, ${_day(ds['from'])} to ${_day(ds['to'])}',
            '${ds['provider_symbol']} from ${ds['provider']}',
            '${ds['adjustment']}',
            '${gaps['count'] ?? 0} gaps and ${jumps['count'] ?? 0} large opening jumps recorded',
            'Checksum SHA-256 ${sum.length > 16 ? sum.substring(0, 16) : sum}…',
            if (ds['proxy'] != null) 'Proxy: ${ds['proxy']}',
            if (ds['start_note'] != null) '${ds['start_note']}',
          ]
        : ['Not verified: ${ds['error'] ?? 'not fetched yet'}'];
    return _Card(label: '$label. ${ok ? 'Verified' : 'Not verified'}. ${lines.join('. ')}.', children: [
      Row(children: [
        Expanded(child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800))),
        Text(ok ? 'VERIFIED' : 'NOT VERIFIED', style: TextStyle(color: ok ? _up : _down, fontWeight: FontWeight.w800, fontSize: 11, letterSpacing: 0.6)),
      ]),
      for (final l in lines) Text(l, style: TextStyle(color: _dim, fontSize: 13)),
    ]);
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard(this.r, this.datasets);
  final Map<String, dynamic> r;
  final List<Map<String, dynamic>> datasets;

  @override
  Widget build(BuildContext context) {
    final id = '${r['dataset']}';
    final name = '${datasets.firstWhere((d) => d['id'] == id, orElse: () => {'label': id})['label']}';
    final leakage = _map(r['leakage']);
    final failed = leakage.entries.where((e) => e.value != true).map((e) => e.key).toList();
    final top = _list(r['top']);
    final head = '$name: ${r['configs']} configurations tested, ${r['ranked']} ranked, ${r['edge_shown'] ?? 0} with an out-of-sample edge. '
        '${failed.isEmpty ? 'Every rule passed the look-ahead audit.' : 'Look-ahead audit failed for ${failed.join(', ')}.'}';
    final rows = [
      for (final t in top)
        '${t['rank']}. ${t['name']}, ${t['filter']}, ${t['target_r']} R: ${_map(t['oos'])['trades']} out-of-sample trades, '
            '${_spokenR(_map(t['oos'])['expectancy_r'])} per trade, ${t['folds_positive']} of ${t['folds_total']} windows profitable'
            '${t['edge_shown'] == true ? ', edge shown' : ', no edge shown'}',
    ];
    final best = top.isEmpty ? null : top.first;
    final regimes = best == null ? <String, dynamic>{} : {..._map(_map(best['regimes'])['trend']), ..._map(_map(best['regimes'])['volatility'])};
    return _Card(label: '$head ${rows.join('. ')}.', children: [
      Text(name, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
      Text(head, style: TextStyle(color: _dim, fontSize: 13)),
      const SizedBox(height: 6),
      if (top.isEmpty) Text('No configuration had enough out-of-sample trades to rank.', style: TextStyle(color: _dim, fontSize: 13)),
      for (final t in top)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 28, child: Text('${t['rank']}', style: const TextStyle(color: _gold, fontWeight: FontWeight.w800))),
            Expanded(
              child: Text('${t['name']} · ${t['filter']} · ${t['target_r']} R\n'
                  '${_map(t['oos'])['trades']} OOS trades · ${_r(_map(t['oos'])['expectancy_r'])} '
                  '(95% ${_r(_map(_map(t['oos'])['expectancy_r_95ci'])['low'])} to ${_r(_map(_map(t['oos'])['expectancy_r_95ci'])['high'])}) · '
                  '${t['folds_positive']}/${t['folds_total']} windows',
                  style: const TextStyle(color: Colors.white, fontSize: 13)),
            ),
            Text(t['edge_shown'] == true ? 'EDGE' : 'NO EDGE', style: TextStyle(color: t['edge_shown'] == true ? _up : _dim, fontSize: 11, fontWeight: FontWeight.w800)),
          ]),
        ),
      if (regimes.isNotEmpty) ...[
        const SizedBox(height: 6),
        Text('Regimes for #1', style: TextStyle(color: _dim, fontSize: 12, fontWeight: FontWeight.w700)),
        for (final e in regimes.entries)
          Text('${e.key}: ${_map(e.value)['trades']} trades, ${_r(_map(e.value)['expectancy_r'])}', style: TextStyle(color: _dim, fontSize: 12)),
      ],
    ]);
  }
}

class _SignalsCard extends StatelessWidget {
  const _SignalsCard(this.signals);
  final List<Map<String, dynamic>> signals;

  @override
  Widget build(BuildContext context) {
    final lines = [
      for (final s in signals.take(5))
        '${s['name']}, ${s['side']} from the ${_day(s['time'])} close, stop ${s['stop']}, target ${s['target']}. ${s['status']}',
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: _Card(label: 'Paper signals. ${lines.isEmpty ? 'None journalled yet.' : lines.join(' ')}', children: [
        const Text('Paper signals', style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
        if (lines.isEmpty) Text('None journalled yet. No order is ever placed from a signal.', style: TextStyle(color: _dim, fontSize: 13)),
        for (final l in lines) Text(l, style: TextStyle(color: _dim, fontSize: 13)),
      ]),
    );
  }
}
