// A read-only projection of trading_live's source-separated learning records.
import 'dart:math' as math;
import 'package:flutter/material.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : {};
List<Map<String, dynamic>> _rows(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : [];
String _value(Object? v, [String suffix = '']) => v == null ? 'Not measured' : '$v$suffix';
String _money(Object? v) => v is num ? '\$${v.toStringAsFixed(2)}' : 'Not measured';
const _teal = Color(0xFF3DDC97);
const _gold = Color(0xFFE8B04A);

class CheStrategyLearningDashboard extends StatelessWidget {
  const CheStrategyLearningDashboard({super.key, required this.data, required this.onAsk, required this.onResearch, this.onRead, this.chart});
  final Map<String, dynamic> data;
  final void Function(String) onAsk;
  final VoidCallback? onResearch;
  final void Function(String)? onRead;
  final Widget? chart;

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
      if (chart != null) chart!,
      for (final strategy in strategies) _StrategyCard(row: strategy),
      ExpansionTile(
        title: const Text('Research and slow-progress diagnostics'),
        childrenPadding: const EdgeInsets.all(12),
        children: [
          Text('Research target: ${research['target_per_strategy'] ?? 30} historical outcomes per strategy per research day, when genuine setups and usable data exist. No forced trades.'),
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

class _StrategyCard extends StatelessWidget {
  const _StrategyCard({required this.row});
  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final forward = _map(row['forward']);
    final progress = _map(row['progress']);
    final today = _map(row['today']);
    final featured = row['featured'] == true;
    final points = _rows(row['equity']);
    final count = forward['trades'] ?? 0;
    final fraction = (progress['fraction'] as num? ?? 0).toDouble().clamp(0.0, 1.0).toDouble();
    final metrics = <String, String>{
      'Unique trades': '$count', 'Wins': '${forward['wins'] ?? 0}', 'Losses': '${forward['losses'] ?? 0}',
      'Win rate': _value(forward['win_rate'], '%'), 'Expectancy': _value(forward['expectancy_r'], ' R'),
      'Net P&L': _money(forward['net_pnl']), 'Profit factor': _value(forward['profit_factor']), 'Max drawdown': _money(forward['max_drawdown']),
    };
    return Card(
      color: featured ? const Color(0xFF102E2B) : const Color(0xFF101E24),
      shape: RoundedRectangleBorder(side: BorderSide(color: featured ? _teal : const Color(0xFF34505C)), borderRadius: BorderRadius.circular(14)),
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('${featured ? 'FEATURED · EMA Pullback · ' : row['secondary'] == true ? 'COMPARE · VWAP · ' : ''}${row['name']}', style: TextStyle(fontSize: featured ? 22 : 19, color: Colors.white, fontWeight: FontWeight.bold)),
        Text('${row['stage']} · ${row['resolution']} · Live locked', style: const TextStyle(color: _gold, fontSize: 16)),
        const SizedBox(height: 10),
        Semantics(label: '${row['name']}: $count of 30 unique forward trades. Live trading locked.', child: LinearProgressIndicator(value: fraction, minHeight: 10, color: _teal)),
        Text('$count / 30 unique forward trades', style: const TextStyle(color: Colors.white, fontSize: 16)),
        Wrap(spacing: 14, runSpacing: 8, children: [for (final entry in metrics.entries) Semantics(label: '${entry.key}: ${entry.value}', excludeSemantics: true, child: SizedBox(width: 135, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(entry.key, style: const TextStyle(color: Colors.white70, fontSize: 13)),
          Text(entry.value, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w600)),
        ])))]),
        const SizedBox(height: 8),
        Text('Today: ${today['studied'] ?? 0} historical outcomes studied; ${today['trades'] ?? 0} newly closed forward trades (${today['wins'] ?? 0} wins, ${today['losses'] ?? 0} losses). Expectancy change: ${_value(today['expectancy_change_r'], ' R')}.', style: const TextStyle(color: Colors.white70, fontSize: 15)),
        Text('Next: ${row['next_milestone']}', style: const TextStyle(color: _teal, fontSize: 16)),
        Text('${row['duplicates'] ?? 0} duplicate variant outcomes excluded. ${row['correlated_entries'] ?? 0} entries have different variant outcomes; parameters are not pooled. Baseline: any filter, ${_map(row['params'])['target_r']} R.', style: const TextStyle(color: Colors.white70, fontSize: 13)),
        Text('Forward data quality: ${(row['data_quality'] as List? ?? []).join(', ')}', style: const TextStyle(color: Colors.white70)),
        if (points.isNotEmpty) Semantics(label: 'Forward baseline equity curve. Last net P&L ${_money(points.last['value'])}.', excludeSemantics: true,
          child: SizedBox(height: 70, child: CustomPaint(painter: _LearningEquity(points)))),
        ExpansionTile(title: const Text('Separate evidence & live readiness'), children: [
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
        ExpansionTile(title: const Text('Recent unique forward trades'), children: [
          for (final trade in _rows(row['recent_trades'])) ListTile(
            leading: Icon((trade['net_pnl'] as num? ?? 0) > 0 ? Icons.trending_up : Icons.trending_down, color: (trade['net_pnl'] as num? ?? 0) > 0 ? _teal : Colors.redAccent),
            title: Text('${trade['side']} · ${_money(trade['net_pnl'])} · ${_map(trade['exit'])['reason']}'),
            subtitle: Text('Entry ${_map(trade['entry'])['time']} @ ${_map(trade['entry'])['fill']}\nExit ${_map(trade['exit'])['time']} @ ${_map(trade['exit'])['fill']}')),
          const Text('The five-minute chart below marks recorded entries and exits.'),
        ]),
      ])),
    );
  }

  Widget _source(String label, Map<String, dynamic> stats) => ListTile(title: Text(label), subtitle: Text(stats.isEmpty ? 'Not recorded for this version.' : '${stats['trades']} outcomes · ${stats['wins']} wins / ${stats['losses']} losses · expectancy ${stats['expectancy_r']} R · net ${_money(stats['net_pnl'])}'));
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
