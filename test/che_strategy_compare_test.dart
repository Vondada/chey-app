// Strategy comparison page (owner, 2026-10-23). The Worker's comparison is fixture JSON here; the page shows it,
// computes nothing, never speaks on its own, and says "insufficient evidence" and "no comparison yet" in words.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:chey/rooms/che_strategy_compare.dart';
import 'package:chey/rooms/che_trading_research.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _row(String id, String name, {bool research = false, int trades = 40, int oos = 18, String verdict = 'not distinguishable from zero after costs', String? warn}) => {
      'strategy_id': id, 'name': name, 'research': research, 'timeframe': '5m', 'market': 'MNQ',
      'all': {'trades': trades, 'expectancy_r': 0.12, 'pf': 1.1}, 'in_sample': {'trades': trades - oos, 'expectancy_r': 0.2}, 'out_of_sample': {'trades': oos, 'expectancy_r': 0.01},
      'folds_positive': 2, 'folds_total': 4, 'look_ahead': 'passed', 'verdict': verdict, 'oos_verdict': 'insufficient evidence (12 trades; 15 needed)', 'overfit_warning': warn,
    };

void main() {
  final requests = <http.Request>[];
  bool empty = false;
  CheTradingResearchClient client() => CheTradingResearchClient(
        baseUrl: () => 'https://che.test',
        headers: () => const {},
        client: MockClient((r) async {
          requests.add(r);
          if (r.url.path == '/api/trading/research/order-flow') return _json({'sessions': 0, 'status': 'No recorded Rithmic order-flow session is stored yet.'});
          if (r.url.path == '/api/trading/research/compare') {
            if (empty) return _json({'available': false, 'reason': 'No backtest results to compare yet.', 'live_trading': 'disabled'});
            return _json({
              'available': true, 'ok': true,
              'same_period': {'sha256': 'abc', 'provider': 'Yahoo Finance (DELAYED)', 'first': '2026-08-25T13:30:00Z', 'last': '2026-10-22T20:55:00Z', 'bars': 11000},
              'rows': [_row('supertrend-5m', 'Supertrend (10, 3) flip', research: true, warn: 'out-of-sample result is under half of in-sample'), _row('orb-15m', 'opening range breakout', trades: 12, oos: 5, verdict: 'insufficient evidence (12 trades; 30 needed)')],
              'conditions': [{'dimension': 'session', 'condition': 'ny_open', 'answer': 'insufficient evidence (no strategy has 30 trades here)'}],
              'events': {'available': false, 'reason': 'No event calendar is connected to the comparison yet (the market-context lane adds it).'},
              'multiple_comparisons': '2 strategies are compared on one period: the best in-sample result is partly luck.',
              'live_trading': 'disabled',
            });
          }
          return _json({'detail': 'not found'}, 404);
        }),
      );

  testWidgets('shows both samples, honest verdicts, warnings in words and the shared period; silent until Read Aloud', (tester) async {
    final spoken = <String>[];
    requests.clear();
    empty = false;
    tester.view.physicalSize = const Size(900, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: CheStrategyComparePage(client: client(), market: 'MNQ', onRead: spoken.add)));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'nothing speaks on open');
    expect(find.textContaining('SAME PERIOD'), findsOneWidget);
    expect(find.textContaining('In-sample: 22 trades'), findsOneWidget);
    expect(find.textContaining('Out-of-sample: 18 trades'), findsOneWidget);
    expect(find.textContaining('insufficient evidence (12 trades; 30 needed)'), findsWidgets);
    expect(find.textContaining('Warning: out-of-sample result is under half of in-sample'), findsOneWidget);
    expect(find.textContaining('RESEARCH · BACKTEST ONLY'), findsOneWidget);
    expect(find.textContaining('No event calendar is connected'), findsOneWidget);
    expect(find.textContaining('No recorded Rithmic order-flow session'), findsOneWidget);
    expect(find.textContaining('Live trading is off'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Supertrend \\(10, 3\\) flip, a research strategy: 40 trades')), findsOneWidget);
    await tester.tap(find.byKey(const Key('compare_read')));
    expect(spoken.single, contains('2 strategies on the same 5 minute period'));
    expect(spoken.single, contains('Live trading is off.'));
  });

  testWidgets('choosing strategies narrows the cards; another timeframe asks the Worker again', (tester) async {
    requests.clear();
    empty = false;
    await tester.pumpWidget(MaterialApp(home: CheStrategyComparePage(client: client(), market: 'MNQ')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('compare_pick_orb-15m')));
    await tester.pumpAndSettle();
    expect(find.textContaining('RESEARCH · BACKTEST ONLY'), findsNothing, reason: 'only the chosen strategy is shown');
    await tester.tap(find.byKey(const Key('compare_tf_15m')));
    await tester.pumpAndSettle();
    expect(requests.where((r) => r.url.path == '/api/trading/research/compare').map((r) => r.url.queryParameters['tf']), ['5m', '15m']);
  });

  testWidgets('no backtests yet is an answer in words, not an error', (tester) async {
    empty = true;
    await tester.pumpWidget(MaterialApp(home: CheStrategyComparePage(client: client(), market: 'MNQ')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('compare_empty')), findsOneWidget);
    expect(find.textContaining('No backtest results to compare yet.'), findsOneWidget);
  });
}
