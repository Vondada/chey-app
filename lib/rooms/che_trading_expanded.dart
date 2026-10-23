// The expanded chart (owner, 2026-10-23): one large PORTRAIT chart, and under it P&L, win rate, open positions and the
// recent trades, each expandable to its recorded details. It never rotates the phone: the layout follows the screen the
// owner holds. Every number comes from recorded markers (CHE's forward paper journal, simulation labelled as such);
// nothing is inferred from candles. Silent on open.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_hud.dart';
import 'che_trading_chart.dart';
import 'che_trading_hud.dart';

/// P&L, win rate and open positions from recorded CHE paper exits and open positions (simulation excluded).
class CheRecordedTradeStats {
  const CheRecordedTradeStats({required this.wins, required this.losses, required this.open, required this.netPnl});
  final int wins, losses, open;

  /// Null when no recorded exit carries a net P&L.
  final double? netPnl;

  int get closed => wins + losses;
  double? get winRate => closed == 0 ? null : wins * 100 / closed;

  static CheRecordedTradeStats of(Iterable<ChartMarker> markers) {
    var wins = 0, losses = 0, open = 0;
    double? pnl;
    final seen = <String>{};
    for (final m in markers) {
      if (m.isSim || !m.source.startsWith('che_')) continue;
      // One record per trade, even if a marker arrives twice.
      if (!seen.add('${m.source}|${m.tradeId}|${m.kind}')) continue;
      switch (m.outcome) {
        case 'win':
          wins++;
        case 'loss':
          losses++;
        case 'open':
          open++;
      }
      final n = m.raw['net_pnl'];
      if (m.kind == 'exit' && n is num) pnl = (pnl ?? 0) + n.toDouble();
    }
    return CheRecordedTradeStats(wins: wins, losses: losses, open: open, netPnl: pnl);
  }
}

String _money(double? v) => v == null ? '—' : '${v >= 0 ? '+' : '−'}\$${v.abs().toStringAsFixed(2)}';

class CheTradingChartExpandedPage extends StatefulWidget {
  const CheTradingChartExpandedPage({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onRead,
    this.account = 'futures_paper',
    this.symbol = 'MNQ',
    this.strategy,
    this.signalMarkers,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String text)? onRead;
  final String account, symbol;
  final String? strategy;
  final ValueListenable<List<Map<String, dynamic>>>? signalMarkers;

  @override
  State<CheTradingChartExpandedPage> createState() => _CheTradingChartExpandedPageState();
}

class _CheTradingChartExpandedPageState extends State<CheTradingChartExpandedPage> {
  List<ChartMarker> _markers = const [];
  final _chartKey = GlobalKey<CheTradingChartState>();

  @override
  Widget build(BuildContext context) {
    final stats = CheRecordedTradeStats.of(_markers);
    final exits = [for (final m in _markers) if (m.kind == 'exit' || m.outcome == 'open') m]
      ..sort((a, b) => (b.time ?? DateTime(0)).compareTo(a.time ?? DateTime(0)));
    final recent = exits.take(12).toList();
    return Scaffold(
      backgroundColor: cheTradingPage(const Color(0xFF05080A)),
      appBar: AppBar(
        backgroundColor: cheTradingPage(Colors.black),
        foregroundColor: Colors.white,
        title: CheChromeText('${widget.symbol} chart', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        leading: IconButton(tooltip: 'Close the expanded chart', icon: const Icon(Icons.close), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(
        child: LayoutBuilder(builder: (context, box) {
          // Portrait-first: the chart takes most of the height the owner's screen gives, whatever its orientation.
          final chartH = (box.maxHeight * 0.5).clamp(240.0, 640.0);
          return ListView(padding: const EdgeInsets.fromLTRB(10, 8, 10, 24), children: [
            CheTradingChart(
              key: _chartKey,
              baseUrl: widget.baseUrl,
              headers: widget.headers,
              client: widget.client,
              onSpeak: widget.onRead,
              initialAccount: widget.account,
              initialSymbol: widget.symbol,
              initialStrategy: widget.strategy,
              signalMarkers: widget.signalMarkers,
              height: chartH,
              onMarkers: (m) {
                if (mounted) setState(() => _markers = m);
              },
            ),
            const SizedBox(height: 10),
            Semantics(
              container: true,
              label: 'Recorded CHE paper trades: net ${_money(stats.netPnl)}, win rate ${stats.winRate == null ? 'not measured' : '${stats.winRate!.toStringAsFixed(0)} percent'}, '
                  '${stats.wins} wins, ${stats.losses} losses, ${stats.open} open.',
              excludeSemantics: true,
              child: Row(children: [
                for (final (k, v) in [
                  ('P&L', _money(stats.netPnl)),
                  ('WIN RATE', stats.winRate == null ? '—' : '${stats.winRate!.toStringAsFixed(0)}%'),
                  ('W / L', '${stats.wins} / ${stats.losses}'),
                  ('OPEN', '${stats.open}'),
                ])
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: CheTradingPanel(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(k, maxLines: 1, style: CheHud.label.copyWith(fontSize: 10)),
                          const SizedBox(height: 2),
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            alignment: Alignment.centerLeft,
                            child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
                          ),
                        ]),
                      ),
                    ),
                  ),
              ]),
            ),
            const SizedBox(height: 12),
            Text('RECENT TRADES', style: CheHud.label),
            const SizedBox(height: 4),
            if (recent.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No recorded trades on this chart yet.', style: TextStyle(color: Colors.white70, fontSize: 15)),
              ),
            for (final m in recent)
              CheTradingPanel(
                margin: const EdgeInsets.only(bottom: 6),
                child: ExpansionTile(
                  key: Key('recent_${m.source}_${m.tradeId}_${m.kind}'),
                  minTileHeight: 52,
                  iconColor: Colors.white,
                  collapsedIconColor: Colors.white70,
                  title: Text(cheMarkerTitle(m), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    [if (m.strategy.isNotEmpty) m.strategy, if (m.raw['r'] is num) '${(m.raw['r'] as num).toStringAsFixed(2)} R', if (m.raw['net_pnl'] is num) _money((m.raw['net_pnl'] as num).toDouble())].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: CheHud.label.copyWith(fontSize: 11),
                  ),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  expandedCrossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final (k, v) in [
                      ('Record', m.tradeId),
                      ('Side', m.side),
                      ('Price', m.price?.toStringAsFixed(2) ?? ''),
                      ('Time', m.time == null ? '' : '${m.time!.toLocal()}'.split('.').first),
                      ('Stop', '${m.raw['stop'] ?? ''}'),
                      ('Target', '${m.raw['target'] ?? ''}'),
                      ('Exit reason', '${m.raw['reason'] ?? ''}'),
                      ('Kind', m.isSim ? 'Simulation (not a paper or broker execution)' : 'CHE forward paper (no broker order)'),
                    ])
                      if (v.isNotEmpty && v != 'null') Text('$k: $v', style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.4)),
                    const SizedBox(height: 6),
                    OutlinedButton.icon(
                      onPressed: () => unawaited(_chartKey.currentState?.openRecord(m)),
                      icon: const Icon(Icons.receipt_long_rounded),
                      label: const Text('Open trade record'),
                    ),
                  ],
                ),
              ),
          ]);
        }),
      ),
    );
  }
}
