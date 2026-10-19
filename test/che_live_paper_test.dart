import 'dart:convert';

import 'package:chey/rooms/che_live_paper.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> dashboard({bool enabled = true, List<Map<String, dynamic>> trades = const [], List<Map<String, dynamic>> positions = const []}) => {
      'account': 'PAPER',
      'isolation': 'Paper portfolios are research records only.',
      'state': {'enabled': enabled, 'started_at': '2026-10-18T22:00:00Z'},
      'session': {'open': true, 'state': 'open'},
      'contract': {'code': 'MNQZ6'},
      'feed': {'status': 'DELAYED', 'provider': 'Yahoo Finance chart (public)', 'provider_symbol': 'MNQ=F', 'latency_s': 600, 'last_bar_time': '2026-10-18T22:30:00Z'},
      'feed_blocker': 'LIVE CME data needs your Tradovate sign-in.',
      'bars': [
        for (var i = 0; i < 20; i++) {'t': '2026-10-18T22:${(i * 5 ~/ 60).toString().padLeft(2, '0')}:00Z', 'o': 20000 + i, 'h': 20005 + i, 'l': 19995 + i, 'c': 20002 + i},
      ],
      'signals': [],
      'positions': positions,
      'trades': trades,
      'totals': {'trades': trades.length, 'wins': trades.where((t) => (t['net_pnl'] as num) > 0).length, 'losses': trades.where((t) => (t['net_pnl'] as num) < 0).length, 'win_rate': trades.isEmpty ? null : 100.0, 'net_pnl': trades.fold<num>(0, (a, t) => a + (t['net_pnl'] as num)), 'profit_factor': null, 'expectancy_r': 0, 'max_drawdown': 0},
      'counts': {'signals': 3, 'filled': 1, 'skipped': 0},
      'by_strategy': [],
      'min_trades': 30,
      'broker': {'tradovate': {'app_configured': true, 'signed_in': false}, 'fundyouredge': {'linked': false, 'why': 'Rithmic needs a licence.'}, 'live_orders': 'disabled: paper only.'},
    };

final trade = {
  'portfolio': 'pdhl-sweep-5m|any@v-1', 'side': 'long', 'qty': 1, 'contract': 'MNQ', 'strategy': 'pdhl-sweep-5m', 'strategy_version': 'v-1', 'filter': 'any',
  'session': 'close-and-overnight', 'signal': {'time': '2026-10-18T22:10:00Z', 'why': 'swept the previous day low'},
  'entry': {'time': '2026-10-18T22:15:00Z', 'fill': 19996.37, 'raw': 19996}, 'exit': {'time': '2026-10-18T22:20:00Z', 'fill': 20026.37, 'reason': 'target'},
  'stop': 19979.75, 'target': 20026.5, 'net_pnl': 55.5, 'gross_before_costs': 60, 'costs': {'spread': 0.5, 'slippage': 0, 'commissions': 3, 'fees': 1}, 'r_net': 1.7,
  'data': {'label': 'intraday 5m bars', 'feed': {'status': 'DELAYED', 'provider_symbol': 'MNQ=F'}},
  'review': {'facts': ['The target 20026.5 was reached.'], 'hypotheses': []},
};

void main() {
  testWidgets('the panel shows PAPER, the delayed feed and recorded trades only; it never speaks by itself', (tester) async {
    final asked = <String>[];
    final client = MockClient((r) async => http.Response(jsonEncode(dashboard(trades: [trade])), 200, headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheLivePaperPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: client, refresh: const Duration(hours: 1))))));
    await tester.pumpAndSettle();
    expect(find.text('PAPER'), findsOneWidget);
    expect(find.text('DELAYED'), findsOneWidget);
    expect(find.textContaining('MNQZ6'), findsOneWidget);
    expect(find.text('CHE PAPER CHART'), findsOneWidget);
    expect(find.textContaining('Prices are delayed'), findsOneWidget);
    expect(find.textContaining('LIVE CME data needs your Tradovate sign-in.'), findsNothing);
    await tester.tap(find.text('Why are prices delayed?'));
    await tester.pumpAndSettle();
    expect(find.textContaining('LIVE CME data needs your Tradovate sign-in.'), findsOneWidget);
    await tester.ensureVisible(find.text('Trade history'));
    await tester.tap(find.text('Trade history'));
    await tester.pumpAndSettle();
    expect(find.textContaining('pdhl-sweep-5m'), findsWidgets);
    expect(find.textContaining('not yet evidence'), findsOneWidget);
    expect(asked, isEmpty, reason: 'opening the Trading Room is silent');
    await tester.tap(find.text('Read aloud'));
    expect(asked, ['Read me your trading performance.']);
  });

  testWidgets('with no trade yet it says so, and Start posts the start action', (tester) async {
    final posted = <String>[];
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posted.add(r.body);
        return http.Response(jsonEncode({'ok': true, 'dashboard': dashboard(enabled: true)}), 200);
      }
      return http.Response(jsonEncode(dashboard(enabled: false)), 200);
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheLivePaperPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: client, refresh: const Duration(hours: 1))))));
    await tester.pumpAndSettle();
    expect(find.textContaining('No paper trade has closed yet'), findsOneWidget);
    await tester.tap(find.text('Start paper trading'));
    await tester.pumpAndSettle();
    expect(jsonDecode(posted.single)['action'], 'start');
    expect(find.text('Paper trading is on.'), findsOneWidget);
  });
}
