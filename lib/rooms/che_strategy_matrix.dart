// Strategy Matrix (Trading Room V3, owner 2026-10-25): every strategy × market × timeframe from
// GET /api/trading/strategy-matrix (server/cloudflare/strategy_matrix.js), docs/CHE_TRADING_STRATEGY_V3.md.
//
// A read-only projection of the Worker's view: no number is computed or invented here. Silent on open (AGENTS.md):
// nothing is spoken until the owner chooses Read aloud; every row has a VoiceOver label that carries its numbers, and
// the voice routes ("what's the best strategy for BTC", "explain the EMA 20 pullback") are offered as buttons too.
// A row with too few out-of-sample trades says "insufficient sample" and is never shown as ranked.
import 'package:flutter/material.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : {};
List<Map<String, dynamic>> _rows(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : [];
String _num(Object? v, [int digits = 2]) => v is num ? v.toStringAsFixed(digits) : 'n/a';
String _money(Object? v) => v is num ? '${v < 0 ? '-' : ''}\$${v.abs().toStringAsFixed(2)}' : 'n/a';
const _tfWords = {'5m': '5-minute', '15m': '15-minute', '1h': 'hourly'};
String _hour(Object? h) {
  if (h is! num) return 'n/a';
  final n = h.toInt();
  return '${n % 12 == 0 ? 12 : n % 12} ${n < 12 ? 'AM' : 'PM'}';
}

const _gold = Color(0xFFFFC857);
const _teal = Color(0xFF3DDC97);
const _red = Color(0xFFFF6B6B);
const _muted = Color(0xFFB8C0CC);
const _body = TextStyle(color: Colors.white, fontSize: 18, height: 1.35);

class CheStrategyMatrix extends StatefulWidget {
  const CheStrategyMatrix({super.key, required this.data, this.onRead, this.onAsk});

  /// The Worker's GET /api/trading/strategy-matrix body.
  final Map<String, dynamic> data;

  /// Speaks text aloud (the owner's explicit Read aloud). Never called on open.
  final void Function(String text)? onRead;

  /// Sends a spoken or typed request through CHE's chat (the same route as saying it).
  final void Function(String request)? onAsk;

  @override
  State<CheStrategyMatrix> createState() => _CheStrategyMatrixState();
}

class _CheStrategyMatrixState extends State<CheStrategyMatrix> {
  String _market = 'All';

  static String rowLabel(Map<String, dynamic> r) {
    final where = '${r['name']}, ${r['market']} ${_tfWords[r['tf']] ?? r['tf']}';
    if (r['status'] != 'ok') return '$where. Not tested: ${r['reason'] ?? 'not applicable'}.';
    final o = _map(r['oos']);
    final tier = '${r['tier'] ?? ''}';
    if (tier == 'insufficient sample') return '$where. Insufficient sample: ${o['trades'] ?? 0} out-of-sample trades. Not ranked.';
    final rank = tier == 'ranked' ? 'Paper priority ${r['paper_priority']}' : tier == 'demoted' ? 'Demoted' : tier;
    return '$where. $rank. ${o['trades']} out-of-sample trades, ${o['win_rate']}% winners after costs, '
        '${_num(o['expectancy_r'], 3)}R per trade, net ${_money(o['net_pnl'])}. Confidence ${r['confidence']}. Live disabled.';
  }

  String _readText(List<Map<String, dynamic>> rows) {
    final groups = _rows(widget.data['groups']);
    final parts = <String>['Strategy matrix. Paper and research only; live trading is disabled.'];
    for (final g in groups) {
      final run = _map(g['run']);
      parts.add(g['pending'] == true ? '${g['group']}: no real research run yet.' : '${g['group']}: run ${run['run_id']}, ${_map(g['freshness'])['state']}.');
    }
    final ranked = rows.where((r) => r['tier'] == 'ranked').toList();
    if (ranked.isEmpty) {
      parts.add('No combination here has enough out-of-sample evidence to rank.');
    } else {
      for (var i = 0; i < ranked.length && i < 3; i++) {
        parts.add('${i + 1}. ${ranked[i]['sentence']}');
      }
    }
    final thin = rows.where((r) => r['tier'] == 'insufficient sample').length;
    if (thin > 0) parts.add('$thin combinations have an insufficient sample and are not ranked.');
    return parts.join(' ');
  }

  @override
  Widget build(BuildContext context) {
    final data = widget.data;
    final all = _rows(data['rows']);
    final markets = ['All', ...{for (final r in all) '${r['market']}'}];
    final rows = _market == 'All' ? all : all.where((r) => r['market'] == _market).toList();
    final groups = _rows(data['groups']);
    final costs = _map(data['cost_models']);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Semantics(header: true, child: const Text('Strategy Matrix', style: TextStyle(fontSize: 24, color: Colors.white, fontWeight: FontWeight.w800))),
      const SizedBox(height: 6),
      Semantics(
        label: 'Paper and research only. Live trading is disabled.',
        excludeSemantics: true,
        child: const Row(children: [
          Icon(Icons.lock_outline, color: _gold, size: 22),
          SizedBox(width: 8),
          Expanded(child: Text('PAPER AND RESEARCH ONLY · LIVE DISABLED', style: TextStyle(color: _gold, fontSize: 17, fontWeight: FontWeight.w700))),
        ]),
      ),
      const SizedBox(height: 8),
      for (final g in groups) _GroupLine(group: g),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        Semantics(
          button: true,
          label: 'Read aloud: the strategy matrix${_market == 'All' ? '' : ' for $_market'}',
          excludeSemantics: true,
          child: OutlinedButton.icon(
            onPressed: widget.onRead == null ? null : () => widget.onRead!(_readText(rows)),
            icon: const Icon(Icons.record_voice_over_outlined),
            label: const Text('Read aloud', style: TextStyle(fontSize: 17)),
          ),
        ),
        for (final m in const ['BTC', 'ETH', 'MNQ', 'NQ'])
          Semantics(
            button: true,
            label: 'Ask CHE: what is the best strategy for $m',
            excludeSemantics: true,
            child: OutlinedButton.icon(
              onPressed: widget.onAsk == null ? null : () => widget.onAsk!("What's the best strategy for $m?"),
              icon: const Icon(Icons.mic_rounded),
              label: Text('Best for $m', style: const TextStyle(fontSize: 17)),
            ),
          ),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: [
        for (final m in markets)
          Semantics(
            button: true,
            selected: _market == m,
            label: 'Show ${m == 'All' ? 'all markets' : m}',
            excludeSemantics: true,
            child: ChoiceChip(label: Text(m, style: const TextStyle(fontSize: 17)), selected: _market == m, onSelected: (_) => setState(() => _market = m)),
          ),
      ]),
      const SizedBox(height: 8),
      if (all.isEmpty)
        Semantics(
          label: 'No research results yet. The numbers are pending a real research run.',
          excludeSemantics: true,
          child: const Text('No research results yet. The numbers are pending a real research run on GitHub with public market data.', style: _body),
        ),
      for (final r in rows) _MatrixRow(row: r, label: rowLabel(r), onRead: widget.onRead, onAsk: widget.onAsk),
      ExpansionTile(
        title: const Text('Costs on every fill', style: TextStyle(color: Colors.white, fontSize: 18)),
        childrenPadding: const EdgeInsets.all(12),
        children: [for (final e in costs.entries) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('${e.value}', style: _body))],
      ),
      Text('${data['note'] ?? ''}', style: const TextStyle(color: _muted, fontSize: 16)),
    ]);
  }
}

class _GroupLine extends StatelessWidget {
  const _GroupLine({required this.group});
  final Map<String, dynamic> group;

  @override
  Widget build(BuildContext context) {
    final run = _map(group['run']);
    final fresh = _map(group['freshness']);
    final pending = group['pending'] == true;
    final text = pending
        ? '${group['group']}: no real research run yet; numbers pending.'
        : '${group['group']}: run ${run['run_id']} at ${run['generated_at']} (${fresh['state']}).';
    final coverage = _rows(group['coverage']).where((c) => c['ok'] == true).map((c) => '${c['market']} ${c['tf']}: ${c['bars']} bars, ${'${c['from']}'.split('T').first} to ${'${c['to']}'.split('T').first}').join('; ');
    return Semantics(
      label: coverage.isEmpty ? text : '$text Data: $coverage.',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Text(coverage.isEmpty ? text : '$text\n$coverage', style: TextStyle(color: pending ? _gold : _muted, fontSize: 16)),
      ),
    );
  }
}

class _MatrixRow extends StatelessWidget {
  const _MatrixRow({required this.row, required this.label, this.onRead, this.onAsk});
  final Map<String, dynamic> row;
  final String label;
  final void Function(String)? onRead;
  final void Function(String)? onAsk;

  @override
  Widget build(BuildContext context) {
    final o = _map(row['oos']);
    final tier = '${row['tier'] ?? row['status']}';
    final colour = tier == 'ranked' ? ((o['expectancy_r'] is num && (o['expectancy_r'] as num) > 0) ? _teal : _muted) : tier == 'demoted' ? _red : _gold;
    final badge = tier == 'ranked' ? '#${row['paper_priority']}' : tier == 'insufficient sample' ? 'Insufficient sample' : tier == 'demoted' ? 'Demoted' : 'Not tested';
    final wf = _map(row['walk_forward']);
    final hours = _map(row['hours']);
    final status = _map(row['status_detail']);
    final details = <String>[
      if (row['sentence'] != null) '${row['sentence']}',
      'Rules: ${row['rules'] ?? 'not recorded'}',
      if (row['status'] == 'ok') ...[
        'Trades tested: ${row['trades_tested']}. Out-of-sample (qualified) trades: ${o['trades']}.',
        'Win rate after costs: ${o['win_rate'] ?? 'n/a'}%. Average win ${_money(o['avg_winner'])}, average loss ${_money(o['avg_loser'])}.',
        'Net P&L after costs: ${_money(o['net_pnl'])}. Expectancy ${_num(o['expectancy_r'], 3)}R (${_money(o['expectancy_dollars'])}) per trade; '
            '95% range ${_num(_map(o['expectancy_r_95ci'])['low'], 3)} to ${_num(_map(o['expectancy_r_95ci'])['high'], 3)}R. Before costs ${_num(row['gross_expectancy_r'], 3)}R.',
        'Profit factor ${o['profit_factor'] ?? 'n/a'}. Max drawdown ${_money(o['max_drawdown'])} (${_num(o['max_drawdown_r'], 1)}R).',
        'Best New York hour ${_hour(_map(hours['best'])['hour'])}, worst ${_hour(_map(hours['worst'])['hour'])} (${hours['basis'] ?? ''}).',
        'Walk-forward: ${wf['folds_positive']} of ${wf['folds']} test windows profitable. ${wf['method'] ?? ''}',
        'Regime stability: ${row['regime_stability'] == null ? 'not measured' : '${((row['regime_stability'] as num) * 100).round()}% of volatility regimes positive'}. Look-ahead audit: ${row['look_ahead']}.',
        'Confidence: ${row['confidence']}.',
      ] else
        'Not tested: ${row['reason'] ?? ''}',
      'Status: backtest ${status['backtest'] ?? 'tested'}; forward paper ${status['forward_paper'] ?? 'no paper trades yet'}; live ${status['live'] ?? 'disabled'}.',
      for (final reason in (row['reasons'] is List ? row['reasons'] as List : const [])) 'Why: $reason',
    ];
    return Semantics(
      label: label,
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 4),
        title: Text('${row['name']} · ${row['market']} ${row['tf']}', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
        subtitle: Text(
          row['status'] == 'ok' && tier != 'insufficient sample' ? '$badge · ${_num(o['expectancy_r'], 3)}R · ${o['trades']} OOS trades · ${row['confidence']}' : badge,
          style: TextStyle(color: colour, fontSize: 16),
        ),
        childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final d in details) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(d, style: _body)),
          Wrap(spacing: 8, children: [
            Semantics(
              button: true,
              label: 'Read aloud: ${row['name']} on ${row['market']}',
              excludeSemantics: true,
              child: TextButton.icon(onPressed: onRead == null ? null : () => onRead!(details.join(' ')), icon: const Icon(Icons.record_voice_over_outlined), label: const Text('Read aloud', style: TextStyle(fontSize: 17))),
            ),
            Semantics(
              button: true,
              label: 'Ask CHE to explain ${row['name']}',
              excludeSemantics: true,
              child: TextButton.icon(onPressed: onAsk == null ? null : () => onAsk!('Explain the ${row['name']}'), icon: const Icon(Icons.help_outline_rounded), label: const Text('Explain', style: TextStyle(fontSize: 17))),
            ),
          ]),
        ],
      ),
    );
  }
}
