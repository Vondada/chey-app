// A read-only projection of trading_live's source-separated learning records.
import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../che_ui/che_theme.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : {};
List<Map<String, dynamic>> _rows(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : [];
String _value(Object? v, [String suffix = '']) => v == null ? 'Not measured' : '$v$suffix';
String _money(Object? v) => v is num ? '\$${v.toStringAsFixed(2)}' : 'Not measured';
const _teal = Color(0xFF3DDC97);
const _gold = CheColors.markets;

class CheStrategyLearningDashboard extends StatelessWidget {
  const CheStrategyLearningDashboard({super.key, required this.data, required this.onAsk, required this.onResearch, this.onRead, this.chart, this.timeframes = const {}, this.windows});
  final Map<String, dynamic> data;
  final void Function(String) onAsk;
  final VoidCallback? onResearch;
  final void Function(String)? onRead;
  final Widget? chart;

  /// Every timeframe's evidence bucket per strategy id (the research overview's `timeframes`, #109). Never a second store.
  final Map<String, List<Map<String, dynamic>>> timeframes;

  /// GET /api/trading/learning (7/30/90-day windows, old vs new), shown under the strategy cards when given.
  final Map<String, dynamic>? windows;

  @override
  Widget build(BuildContext context) {
    final strategies = _rows(data['strategies']);
    final research = _map(data['research']);
    final diagnostics = _map(data['diagnostics']);
    final leader = _map(data['leader']);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('Strategy Learning & Live Readiness', style: TextStyle(fontSize: 23, color: Colors.white, fontWeight: FontWeight.w800)),
      const SizedBox(height: 8),
      const Text('PAPER ONLY · 30 unique trades is a sample milestone, never permission to trade live.', style: TextStyle(color: _gold, fontSize: 16)),
      const SizedBox(height: 8),
      Text('${data['daily_report'] ?? 'Daily report unavailable.'}', style: const TextStyle(color: Colors.white, fontSize: 16)),
      Text(leader.isEmpty ? 'Best strategy: not established; insufficient forward sample.' : 'Provisional best by forward expectancy: ${leader['id']}. Independent validation still required.', style: const TextStyle(color: _teal, fontSize: 16)),
      Wrap(spacing: 8, children: [
        OutlinedButton.icon(onPressed: () {
          if (onRead != null) { onRead!('${data['daily_report']} ${strategies.map((r) => '${r['name']}: ${_map(r['forward'])['trades']} unique forward trades, ${_map(r['forward'])['wins']} wins, ${_map(r['forward'])['losses']} losses. Next: ${r['next_milestone']}.').join(' ')}'); }
          else { onAsk('Read my strategy learning progress and live readiness.'); }
        }, icon: const Icon(Icons.record_voice_over_outlined), label: const Text('Read learning report')),
        OutlinedButton.icon(onPressed: onResearch, icon: const Icon(Icons.fast_forward), label: const Text('Replay available history')),
      ]),
      ?chart,
      for (final strategy in strategies) _StrategyCard(row: strategy, timeframes: timeframes[strategy['id']] ?? const []),
      if (windows != null) CheLearningWindows(data: windows!),
      ExpansionTile(
        title: const Text('Research and slow-progress diagnostics'),
        childrenPadding: const EdgeInsets.all(12),
        children: [
          Text('Research target: ${research['target_per_strategy'] ?? 30} historical outcomes per strategy per research day, when genuine setups and usable data exist. No forced trades.'),
          Text(research['last_attempt'] == null ? 'Last research attempt: Not run' : 'Last research attempt: ${research['last_attempt']} · ${research['attempt_status'] ?? 'status not recorded'}'
            '${research['reused'] == true ? ' · reused the archived experiment (same dataset, no new evidence)' : ''}'),
          Text('Last successful research: ${research['last_success'] ?? 'Not run'}'),
          Text('${research['data'] ?? 'Historical data not yet available.'}'),
          if (research['error'] != null) Text('Last research attempt failed: ${research['error']}'),
          Text('${research['note'] ?? ''}'),
          SelectableText('Experiment: ${research['id'] ?? 'Not recorded'}\nDataset SHA-256: ${research['dataset_hash'] ?? 'Not recorded'}'),
          Text('Scheduler: ${diagnostics['scheduler'] ?? 'Unknown'}; poll ${diagnostics['poll_seconds'] ?? '?'} seconds; candles ${diagnostics['resolution'] ?? '?'}. ${diagnostics['explanation'] ?? ''}'),
          for (final error in _rows(diagnostics['errors'])) Text('${error['at']}: ${error['error'] ?? 'Failed pass'}'),
        ],
      ),
      const Divider(height: 28),
    ]);
  }
}

/// One strategy at rest (owner, 2026-10-23): name, a progress bar with bold numbers, and every timeframe's count on one
/// row. A tap expands the numbers, the equity line and the evidence; the info control explains the numbers. Every card
/// is compact, the featured one included.
class _StrategyCard extends StatefulWidget {
  const _StrategyCard({required this.row, required this.timeframes});
  final Map<String, dynamic> row;
  final List<Map<String, dynamic>> timeframes;

  @override
  State<_StrategyCard> createState() => _StrategyCardState();
}

class _StrategyCardState extends State<_StrategyCard> {
  bool _open = false;

  static const _bold = TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()]);

  void _explain(Map<String, dynamic> row) {
    final forward = _map(row['forward']);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${row['name']}'),
        content: SingleChildScrollView(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('Forward paper: ${forward['trades'] ?? 0} unique trades on five-minute bars (paper runs on five-minute bars only).'),
            const SizedBox(height: 8),
            const Text('Each timeframe shows forward paper trades first, then historical research trades from its evidence bucket. A timeframe with no research shows zero.'),
            const SizedBox(height: 8),
            Text('${row['duplicates'] ?? 0} duplicate variant outcomes excluded. ${row['correlated_entries'] ?? 0} entries have different variant outcomes; parameters are not pooled. Baseline: any filter, ${_map(row['params'])['target_r']} R.'),
            const SizedBox(height: 8),
            Text('Forward data quality: ${(row['data_quality'] as List? ?? []).join(', ')}'),
            const SizedBox(height: 8),
            Text('${row['stage']} · ${row['resolution']} · Live locked.'),
          ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Close'))],
      ),
    );
  }

  Widget _timeframeStrip() {
    if (widget.timeframes.isEmpty) {
      return const Text('Timeframes: not loaded yet', style: TextStyle(color: Colors.white, fontSize: 14));
    }
    return Wrap(spacing: 6, runSpacing: 6, children: [
      for (final t in widget.timeframes)
        Semantics(
          container: true,
          label: '${t['tf']}: ${t['forward_trades'] ?? 0} forward paper trades, ${t['historical_trades'] ?? 0} historical trades, evidence ${t['evidence'] ?? 'not run'}',
          excludeSemantics: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: (t['forward_trades'] as num? ?? 0) > 0 ? _teal : const Color(0xFF34505C))),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text('${t['tf']} ', style: const TextStyle(color: Colors.white, fontSize: 14)),
              Text('${t['forward_trades'] ?? 0}', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
              Text(' · ', style: const TextStyle(color: Colors.white, fontSize: 14)),
              Text('${t['historical_trades'] ?? 0}', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
            ]),
          ),
        ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final forward = _map(row['forward']);
    final progress = _map(row['progress']);
    final today = _map(row['today']);
    final featured = row['featured'] == true;
    final secondary = row['secondary'] == true;
    final points = _rows(row['equity']);
    final count = forward['trades'] ?? 0;
    final fraction = (progress['fraction'] as num? ?? 0).toDouble().clamp(0.0, 1.0).toDouble();
    final metrics = <String, String>{
      'Wins': '${forward['wins'] ?? 0}', 'Losses': '${forward['losses'] ?? 0}',
      'Win rate': _value(forward['win_rate'], '%'), 'Expectancy': _value(forward['expectancy_r'], ' R'),
      'Net P&L': _money(forward['net_pnl']), 'Profit factor': _value(forward['profit_factor']), 'Max drawdown': _money(forward['max_drawdown']),
    };
    final name = '${row['name']}';
    return Card(
      key: Key('strategy_card_${row['id']}'),
      color: featured ? const Color(0xFF102E2B) : const Color(0xFF101E24),
      shape: RoundedRectangleBorder(side: BorderSide(color: featured ? _teal : const Color(0xFF34505C)), borderRadius: BorderRadius.circular(14)),
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Semantics(
                button: true,
                expanded: _open,
                label: '$name: $count of 30 unique forward trades. ${_open ? 'Expanded' : 'Collapsed'}. Tap to ${_open ? 'collapse' : 'expand'}.',
                excludeSemantics: true,
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: () => setState(() => _open = !_open),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text([if (featured) 'FEATURED' else if (secondary) 'COMPARE', 'Live locked'].where((e) => e.isNotEmpty).join(' · '),
                        style: const TextStyle(color: _teal, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 0.8)),
                    Text(name, key: Key('strategy_name_${row['id']}'), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w800)),
                  ]),
                ),
              ),
            ),
            Semantics(
              button: true,
              label: 'About $name',
              child: IconButton(tooltip: 'About $name', icon: const Icon(Icons.help_outline_rounded, color: Colors.white), onPressed: () => _explain(row)),
            ),
            Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: Colors.white),
          ]),
          const SizedBox(height: 6),
          Semantics(container: true, label: '$name: $count of 30 unique forward trades', excludeSemantics: true,
            child: LinearProgressIndicator(value: fraction, minHeight: 8, color: _teal, backgroundColor: const Color(0xFF1B2E36))),
          const SizedBox(height: 4),
          // One text: the bold count, then its label. A Wrap-free Row would need a second line at large text, so the
          // Text itself wraps; the net P&L sits at the right in bold.
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(child: Text.rich(TextSpan(children: [
              TextSpan(text: '$count', style: _bold),
              const TextSpan(text: ' / 30 unique forward trades', style: TextStyle(color: Colors.white, fontSize: 15)),
            ]))),
            Text(_money(forward['net_pnl']), style: _bold.copyWith(fontSize: 16)),
          ]),
          const SizedBox(height: 8),
          _timeframeStrip(),
          if (_open) ...[
            const SizedBox(height: 10),
            Wrap(spacing: 14, runSpacing: 8, children: [
              for (final entry in metrics.entries)
                Semantics(
                  label: '${entry.key}: ${entry.value}',
                  excludeSemantics: true,
                  child: SizedBox(width: 130, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(entry.key, style: const TextStyle(color: Colors.white, fontSize: 13)),
                    Text(entry.value, style: _bold.copyWith(fontSize: 17)),
                  ])),
                ),
            ]),
            if (points.isNotEmpty) Semantics(label: 'Forward baseline equity curve. Last net P&L ${_money(points.last['value'])}.', excludeSemantics: true,
              child: SizedBox(height: 60, child: CustomPaint(painter: _LearningEquity(points)))),
            const SizedBox(height: 6),
            Text('Today: ${today['trades'] ?? 0} closed (${today['wins'] ?? 0} wins, ${today['losses'] ?? 0} losses). Next: ${row['next_milestone']}.',
                style: const TextStyle(color: Colors.white, fontSize: 15)),
            ExpansionTile(title: const Text('Separate evidence & live readiness', style: TextStyle(color: Colors.white)), tilePadding: EdgeInsets.zero, children: [
              _source('Historical backtest', _map(row['historical'])),
              _source('Out-of-sample (subset of history, never added)', _map(row['out_of_sample'])),
              _source('Forward paper', forward),
              const ListTile(title: Text('Broker paper'), subtitle: Text('Separate broker receipts; strategy attribution not verified.')),
              const ListTile(title: Text('Live execution'), subtitle: Text('Disabled. No live results or approval inferred.')),
              for (final milestone in _rows(row['milestones'])) ListTile(
                leading: Icon(milestone['status'] == 'review' ? Icons.fact_check_outlined : Icons.lock_outline, color: _gold),
                title: Text('${milestone['label']}: ${milestone['status']}'), subtitle: Text('${milestone['detail']}')),
              Text('Processed portfolio bars: ${_map(row['counts'])['bars']}; signals: ${_map(row['counts'])['signals']}; filled: ${_map(row['counts'])['filled']}; gap skips: ${_map(row['counts'])['gap_skipped']}.'),
              SelectableText('Version ${row['strategy_version']} · parameters ${row['params']}'),
              for (final variant in _rows(row['variants'])) ListTile(title: Text('${variant['version']}'), subtitle: Text('${variant['trades']} portfolio records; not independent of other variants.')),
            ]),
            ExpansionTile(title: const Text('Recent unique forward trades', style: TextStyle(color: Colors.white)), tilePadding: EdgeInsets.zero, children: [
              for (final trade in _rows(row['recent_trades'])) ListTile(
                leading: Icon((trade['net_pnl'] as num? ?? 0) > 0 ? Icons.trending_up : Icons.trending_down, color: (trade['net_pnl'] as num? ?? 0) > 0 ? _teal : Colors.redAccent),
                title: Text('${trade['side']} · ${_money(trade['net_pnl'])} · ${_map(trade['exit'])['reason']}'),
                subtitle: Text('Entry ${_map(trade['entry'])['time']} @ ${_map(trade['entry'])['fill']}\nExit ${_map(trade['exit'])['time']} @ ${_map(trade['exit'])['fill']}')),
            ]),
          ],
        ]),
      ),
    );
  }

  Widget _source(String label, Map<String, dynamic> stats) => ListTile(title: Text(label), subtitle: Text(stats.isEmpty ? 'Not recorded for this version.' : '${stats['trades']} outcomes · ${stats['wins']} wins / ${stats['losses']} losses · expectancy ${stats['expectancy_r']} R · net ${_money(stats['net_pnl'])}'));
}

/// One row of the portfolio-variant ranking (owner, 2026-10-23): the name gets the full width on its own line and never
/// breaks mid-word (it wraps at spaces, and a tap shows the full name); the numbers and the "small sample" tag sit on a
/// second line that wraps as needed.
class CheStrategyRankRow extends StatelessWidget {
  const CheStrategyRankRow({super.key, required this.row, required this.money});
  final Map<String, dynamic> row;
  final String Function(Object?) money;

  @override
  Widget build(BuildContext context) {
    final s = row;
    final ranked = s['ranked'] == true;
    final title = '${s['name']} · ${s['filter']} · ${s['target_r']}R';
    return Semantics(
      label: '$title: ${s['trades']} trades, win rate ${s['win_rate'] ?? 'not measured'} percent, net ${money(s['net_pnl'])}${ranked ? '' : ', too few trades to rank'}',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(key: Key('rank_row_${s['name']}_${s['filter']}'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          InkWell(
            onTap: () => showDialog<void>(context: context, builder: (ctx) => AlertDialog(content: Text(title), actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Close'))])),
            child: Text(title, key: Key('rank_name_${s['name']}_${s['filter']}'), maxLines: 2, overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
          ),
          Wrap(spacing: 10, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Text('${s['trades']} trades', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
            Text('${s['win_rate'] ?? '—'}% win', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
            Text(money(s['net_pnl']), style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
            if (!ranked)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(6), border: Border.all(color: CheColors.markets)),
                child: const Text('small sample', style: TextStyle(color: CheColors.markets, fontSize: 13, fontWeight: FontWeight.w700)),
              ),
          ]),
        ]),
      ),
    );
  }
}

class _LearningEquity extends CustomPainter {
  _LearningEquity(this.points);
  final List<Map<String, dynamic>> points;
  @override
  void paint(Canvas canvas, Size size) {
    final values = <double>[0, ...points.map((p) => (p['value'] as num).toDouble())];
    final lo = values.reduce(math.min); final hi = values.reduce(math.max);
    final range = math.max(1.0, hi - lo);
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = i * size.width / math.max(1, values.length - 1);
      final y = size.height - (values[i] - lo) * size.height / range;
      if (i == 0) { path.moveTo(x, y); } else { path.lineTo(x, y); }
    }
    canvas.drawPath(path, Paint()..color = _teal..strokeWidth = 2..style = PaintingStyle.stroke);
  }
  @override
  bool shouldRepaint(covariant _LearningEquity oldDelegate) => oldDelegate.points != points;
}

/// Is CHE improving? (owner, 2026-10-24): 7, 30 and 90-day results per strategy from GET /api/trading/learning,
/// each period beside the equal period before it. A change is named only when both periods hold enough trades;
/// otherwise the row says "insufficient evidence". Simulation is in R, forward paper in dollars; never mixed.
class CheLearningWindows extends StatelessWidget {
  const CheLearningWindows({super.key, required this.data});
  final Map<String, dynamic> data;

  static String _net(Object? v, Object? unit) => v is! num ? 'no trades' : unit == 'USD' ? '${v < 0 ? '−' : '+'}\$${v.abs().toStringAsFixed(2)}' : '${v < 0 ? '−' : '+'}${v.abs().toStringAsFixed(2)} R';

  Widget _window(Map<String, dynamic> r, Map<String, dynamic> w) {
    final now = _map(w['now']);
    final before = _map(w['before']);
    final verdict = '${w['verdict']}';
    return Semantics(
      container: true,
      label: '${w['days']} days: ${now['trades']} trades, net ${_net(now['net'], r['unit'])}, win rate ${_value(now['win_rate'], ' percent')}, '
          'profit factor ${_value(now['profit_factor'])}, average R ${_value(now['avg_r'])}, max drawdown ${_value(now['max_drawdown'])}. '
          'The ${w['days']} days before: ${before['trades']} trades, net ${_net(before['net'], r['unit'])}. $verdict.',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${w['days']} days — $verdict'.toUpperCase(),
              style: TextStyle(color: verdict == 'improving' ? _teal : verdict == 'worse' ? Colors.redAccent : _gold, fontSize: 13, fontWeight: FontWeight.w800)),
          Text('Now: ${now['trades']} trades, ${_net(now['net'], r['unit'])}, win ${_value(now['win_rate'], '%')}, PF ${_value(now['profit_factor'])}, avg ${_value(now['avg_r'])} R, DD ${_value(now['max_drawdown'])}',
              style: const TextStyle(color: Colors.white, fontSize: 14)),
          Text('Before: ${before['trades']} trades, ${_net(before['net'], r['unit'])}, win ${_value(before['win_rate'], '%')}, PF ${_value(before['profit_factor'])}',
              style: const TextStyle(color: Colors.white70, fontSize: 14)),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows(data['rows']);
    if (rows.isEmpty) {
      return const Padding(padding: EdgeInsets.all(8), child: Text('No closed simulation or forward paper trades are stored yet, so there is nothing to compare.', style: TextStyle(color: Colors.white, fontSize: 16)));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('${data['rule'] ?? ''}', style: const TextStyle(color: _gold, fontSize: 15)),
      const SizedBox(height: 8),
      for (final r in rows)
        if (r['error'] != null)
          Text('${r['source_label']}: could not be read (${r['error']}).', style: const TextStyle(color: Colors.redAccent, fontSize: 15))
        else
          Card(
            key: Key('learning_${r['source']}_${r['strategy']}'),
            color: const Color(0xFF0E1418),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${r['strategy']}', style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700)),
                Text('${r['source_label']} · ${r['total_trades']} trades · out of sample: ${_map(r['out_of_sample'])['basis'] ?? 'not recorded'}', style: const TextStyle(color: Colors.white70, fontSize: 14)),
                for (final w in _rows(r['windows'])) _window(r, w),
                for (final f in (r['failures'] is List ? r['failures'] as List : const [])) Text('Failure: $f', style: const TextStyle(color: Colors.redAccent, fontSize: 14)),
              ]),
            ),
          ),
    ]);
  }
}
