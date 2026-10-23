// Strategy comparison (owner, 2026-10-23): every strategy CHE has backtested on one shared period, with in-sample
// beside out-of-sample, intervals after costs and the conditions where a strategy did better. Read from the Worker
// (/api/trading/research/compare, strategy_research.js); the phone computes nothing. "Insufficient evidence" is an
// answer, not a gap to fill. Silent on open; Read Aloud is the owner's choice. Live trading stays off.
import 'dart:async';

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';
import 'che_trading_research.dart';

const _gold = CheColors.markets;
const _dim = Color(0xFF9AA6AE);
const _card = Color(0xFF151B20);

/// Timeframes the research engine compares; the Worker refuses nothing here, it just has no results for some.
const kCompareTimeframes = ['5m', '1m', '15m', '30m', '1h', '1D'];

num? _n(Object? v) => v is num ? v : (v is String ? num.tryParse(v) : null);
String _s(Object? v, [String d = '']) => v == null ? d : '$v';
Map<String, dynamic> _m(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
List<Map<String, dynamic>> _l(Object? v) => v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : const [];
String _r(Object? v) {
  final n = _n(v);
  if (n == null) return '—';
  return '${n >= 0 ? '+' : ''}${n.toStringAsFixed(2)} R';
}

/// One strategy's comparison row, as the Worker sent it.
class CompareRow {
  CompareRow(Map<String, dynamic> j)
      : id = _s(j['strategy_id']),
        name = _s(j['name'], _s(j['strategy_id'])),
        research = j['research'] == true,
        all = _m(j['all']),
        inSample = _m(j['in_sample']),
        outOfSample = _m(j['out_of_sample']),
        foldsPositive = _n(j['folds_positive'])?.toInt(),
        foldsTotal = _n(j['folds_total'])?.toInt(),
        verdict = _s(j['verdict'], 'no trades'),
        oosVerdict = _s(j['oos_verdict'], 'no trades'),
        overfit = j['overfit_warning'] == null ? null : _s(j['overfit_warning']),
        lookAhead = _s(j['look_ahead'], 'unknown');
  final String id, name, verdict, oosVerdict, lookAhead;
  final bool research;
  final Map<String, dynamic> all, inSample, outOfSample;
  final int? foldsPositive, foldsTotal;
  final String? overfit;

  int get trades => _n(all['trades'])?.toInt() ?? 0;
  int get oosTrades => _n(outOfSample['trades'])?.toInt() ?? 0;

  String spoken() => '$name${research ? ', a research strategy' : ''}: $trades trades, ${_r(all['expectancy_r'])} per trade after costs, $verdict. '
      'Out of sample: $oosTrades trades, ${_r(outOfSample['expectancy_r'])}, $oosVerdict.${overfit == null ? '' : ' Warning: $overfit.'}';
}

/// Plain words for a comparison, for Read Aloud.
String compareSummary(Map<String, dynamic> d, List<CompareRow> rows, String tf) {
  if (d['available'] == false) return 'No ${researchTfSpoken(tf)} comparison yet: ${_s(d['reason'])}';
  final p = _m(d['same_period']);
  final b = StringBuffer('${rows.length} strategies on the same ${researchTfSpoken(tf)} period, ${_s(p['first']).split('T').first} to ${_s(p['last']).split('T').first}, from ${_s(p['provider'], 'an unnamed source')}. ');
  for (final r in rows) {
    b.write('${r.spoken()} ');
  }
  b.write(_s(d['multiple_comparisons']));
  b.write(' Live trading is off.');
  return b.toString();
}

class CheStrategyComparePage extends StatefulWidget {
  const CheStrategyComparePage({super.key, required this.client, required this.market, this.onRead, this.initialTf = '5m'});
  final CheTradingResearchClient client;
  final String market;
  final String initialTf;
  final void Function(String text)? onRead;

  @override
  State<CheStrategyComparePage> createState() => _CheStrategyComparePageState();
}

class _CheStrategyComparePageState extends State<CheStrategyComparePage> {
  late String _tf = widget.initialTf;
  Map<String, dynamic>? _data;
  Map<String, dynamic>? _flow;
  String? _error;
  final Set<String> _picked = {};
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final seq = ++_seq;
    setState(() { _data = null; _error = null; });
    try {
      final d = await widget.client.compare(widget.market, _tf);
      Map<String, dynamic>? flow;
      try { flow = await widget.client.orderFlow(); } catch (_) { flow = null; }
      if (!mounted || seq != _seq) return;
      setState(() { _data = d; _flow = flow; _picked.clear(); });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() { _error = '$e'; });
    }
  }

  List<CompareRow> get _rows => _l(_data?['rows']).map(CompareRow.new).toList();
  List<CompareRow> get _shown => _picked.isEmpty ? _rows : _rows.where((r) => _picked.contains(r.id)).toList();

  @override
  Widget build(BuildContext context) {
    final d = _data;
    return Scaffold(
      backgroundColor: CheColors.screen,
      appBar: AppBar(
        title: Semantics(header: true, child: Text('Compare strategies · ${widget.market}')),
        actions: [
          if (widget.onRead != null && d != null)
            IconButton(
              key: const Key('compare_read'),
              tooltip: 'Read this comparison aloud',
              icon: const Icon(Icons.record_voice_over_rounded),
              onPressed: () => widget.onRead!(compareSummary(d, _shown, _tf)),
            ),
        ],
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(12, 8, 12, 24), children: [
        Semantics(
          label: 'Timeframe',
          child: Wrap(spacing: 8, runSpacing: 6, children: [
            for (final tf in kCompareTimeframes)
              ChoiceChip(
                key: Key('compare_tf_$tf'),
                label: Text(researchTfLabel(tf), semanticsLabel: '${researchTfSpoken(tf)} bars${tf == _tf ? ', selected' : ''}'),
                selected: tf == _tf,
                onSelected: (_) { if (tf != _tf) { setState(() => _tf = tf); unawaited(_load()); } },
              ),
          ]),
        ),
        const SizedBox(height: 10),
        if (d == null)
          Text(_error == null ? 'Loading the comparison…' : 'The comparison is unavailable: $_error', style: const TextStyle(color: _dim, fontSize: 15))
        else if (d['available'] == false)
          Text('No ${researchTfSpoken(_tf)} comparison yet: ${_s(d['reason'])}', key: const Key('compare_empty'), style: const TextStyle(color: _dim, fontSize: 15))
        else ..._body(d),
        if (_flow != null) ...[const SizedBox(height: 16), _orderFlow(_flow!)],
        const SizedBox(height: 12),
        const Text('Backtest and paper research only. Live trading is off.', style: TextStyle(color: _dim, fontSize: 13)),
      ]),
    );
  }

  List<Widget> _body(Map<String, dynamic> d) {
    final p = _m(d['same_period']);
    final rows = _rows;
    return [
      Semantics(
        container: true,
        label: 'Same period for every strategy: ${_s(p['first']).split('T').first} to ${_s(p['last']).split('T').first}, ${_s(p['bars'])} bars from ${_s(p['provider'])}',
        child: ExcludeSemantics(
          child: Text('SAME PERIOD · ${_s(p['first']).split('T').first} → ${_s(p['last']).split('T').first} · ${_s(p['bars'])} bars · ${_s(p['provider'])}${p['proxy'] != null ? ' · PROXY' : ''}',
              style: const TextStyle(color: _gold, fontWeight: FontWeight.w700, fontSize: 13)),
        ),
      ),
      const SizedBox(height: 8),
      Text(_s(d['multiple_comparisons']), style: const TextStyle(color: _dim, fontSize: 13)),
      const SizedBox(height: 10),
      Semantics(
        label: 'Choose strategies to compare',
        child: Wrap(spacing: 6, runSpacing: 6, children: [
          for (final r in rows)
            FilterChip(
              key: Key('compare_pick_${r.id}'),
              label: Text(r.name, semanticsLabel: '${r.name}${_picked.contains(r.id) ? ', selected' : ''}'),
              selected: _picked.contains(r.id),
              onSelected: (on) => setState(() => on ? _picked.add(r.id) : _picked.remove(r.id)),
            ),
        ]),
      ),
      const SizedBox(height: 12),
      LayoutBuilder(builder: (context, box) {
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
        final perRow = box.maxWidth / scale >= 700 ? 2 : 1;
        final w = (box.maxWidth - (perRow - 1) * 10) / perRow;
        return Wrap(spacing: 10, runSpacing: 10, children: [for (final r in _shown) SizedBox(width: w, child: _rowCard(r))]);
      }),
      const SizedBox(height: 16),
      Semantics(header: true, child: const Text('WHICH CONDITIONS', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1))),
      const SizedBox(height: 6),
      for (final c in _l(d['conditions']))
        Semantics(
          container: true,
          label: '${_s(c['dimension'])} ${researchWords(c['condition'])}: ${_s(c['answer'])}',
          child: ExcludeSemantics(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Text('${_s(c['dimension'])} · ${researchWords(c['condition'])}: ${_s(c['answer'])}', style: const TextStyle(color: Colors.white, fontSize: 14)),
            ),
          ),
        ),
      const SizedBox(height: 12),
      Text(_m(d['events'])['available'] == true ? 'Event days are broken down per strategy.' : _s(_m(d['events'])['reason'], 'No event calendar connected.'),
          key: const Key('compare_events'), style: const TextStyle(color: _dim, fontSize: 13)),
    ];
  }

  Widget _rowCard(CompareRow r) {
    final warn = r.overfit;
    return Semantics(
      container: true,
      label: r.spoken(),
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: _card, borderRadius: BorderRadius.circular(12), border: Border.all(color: Colors.white12)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text(r.name, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800)),
              if (r.research) const Text('RESEARCH · BACKTEST ONLY', style: TextStyle(color: _gold, fontSize: 11, fontWeight: FontWeight.w800)),
            ]),
            const SizedBox(height: 6),
            _line('All', r.all, r.verdict),
            _line('In-sample', r.inSample, null),
            _line('Out-of-sample', r.outOfSample, r.oosVerdict),
            if (r.foldsTotal != null && r.foldsTotal! > 0) Text('Walk-forward folds positive: ${r.foldsPositive}/${r.foldsTotal}', style: const TextStyle(color: _dim, fontSize: 13)),
            Text('Look-ahead audit: ${r.lookAhead}', style: const TextStyle(color: _dim, fontSize: 13)),
            if (warn != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Icon(Icons.warning_amber, color: Color(0xFFFFC857), size: 18),
                  const SizedBox(width: 6),
                  Expanded(child: Text('Warning: $warn', style: const TextStyle(color: Colors.white, fontSize: 13))),
                ]),
              ),
          ]),
        ),
      ),
    );
  }

  Widget _line(String label, Map<String, dynamic> s, String? verdict) => Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Text('$label: ${_s(s['trades'], '0')} trades · ${_r(s['expectancy_r'])}${s['pf'] == null ? '' : ' · PF ${_s(s['pf'])}'}${verdict == null ? '' : ' · $verdict'}',
            style: const TextStyle(color: Colors.white, fontSize: 14)),
      );

  Widget _orderFlow(Map<String, dynamic> f) => Semantics(
        container: true,
        label: 'Order flow data: ${_s(f['status'])}',
        child: ExcludeSemantics(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('ORDER FLOW DATA', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1)),
            const SizedBox(height: 4),
            Text(_s(f['status']), key: const Key('compare_order_flow'), style: const TextStyle(color: Colors.white, fontSize: 14)),
          ]),
        ),
      );
}
