// Trade records by source (owner, 2026-10-20): the panel shows each record set
// separately with its own count and never adds them together; a set CHE could
// not read says so instead of showing a number; it never speaks by itself.
import 'dart:convert';

import 'package:chey/rooms/che_trading_ledgers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> ledger(String id, String label, {Object? trades = 0, bool unavailable = false, Map<String, dynamic> extra = const {}}) => {
      'id': id, 'label': label, 'what': 'what $label holds', 'storage_keys': ['${id}_state'], 'module': '$id.js', 'rule': 'rule for $label',
      'unavailable': unavailable, 'trades': trades, 'status': 'running', 'by_strategy': [], 'feeds': [], 'equity': {'unit': 'R', 'points': [], 'trades': 0},
      ...extra,
    };

Map<String, dynamic> view({bool simUnreadable = false}) => {
      'paper_only': true, 'separate': true, 'note': 'Each count is that record set\'s own closed trades; the sets are never summed.',
      'ledgers': [
        ledger('strategy_simulation', 'strategy simulation', trades: simUnreadable ? null : 172, unavailable: simUnreadable, extra: {
          'wins': 100, 'losses': 72, 'open': 1, 'profitable': 0, 'strategies': 10, 'expectancy_r': 0.12,
          'best': {'name': 'Breakout over the 20-bar high', 'trades': 40, 'win_rate': 55, 'out_of_sample_expectancy_r': 0.2, 'label': 'not proven yet'},
          'feeds': [{'symbol': 'BTCUSDT', 'status': 'LIVE', 'last_bar': '2026-10-20T04:40:00Z'}, {'symbol': 'MNQ', 'status': 'waiting for the first tick'}],
          'by_strategy': [{'name': 'Breakout over the 20-bar high', 'trades': 40, 'win_rate': 55, 'expectancy_r': 0.2, 'label': 'not proven yet'}],
          'equity_basis': 'The curve is the running sum of net R over every closed simulated trade, across all strategies and instruments.',
          'by_instrument': [{'symbol': 'BTCUSDT', 'trades': 120, 'win_rate': 41.7, 'net_r': -180.5, 'expectancy_r': -1.5}, {'symbol': 'MNQ', 'trades': 52, 'win_rate': 50, 'net_r': 4.25, 'expectancy_r': 0.08}],
          'equity': {'unit': 'R', 'points': [{'t': '2026-10-19T14:10:00Z', 'v': 0.6}, {'t': '2026-10-19T14:11:00Z', 'v': 1.2}, {'t': '2026-10-19T14:12:00Z', 'v': 0.2}], 'trades': 3},
        }),
        ledger('forward_paper_journal', 'forward paper journal', trades: 81, extra: {
          'wins': 50, 'losses': 31, 'win_rate': 61.73, 'net_pnl': 1250.5, 'open': 0, 'status': 'on',
          'best': {'name': 'Fair value gap retest', 'trades': 81, 'win_rate': 61.73, 'net_pnl': 1250.5, 'ranked': true},
          'feeds': [{'symbol': 'MNQ=F', 'status': 'DELAYED', 'provider': 'Yahoo', 'last_bar': '2026-10-20T04:35:00Z'}],
          'equity': {'unit': r'$', 'points': [{'t': '2026-10-19T15:00:00Z', 'v': 25}, {'t': '2026-10-19T15:05:00Z', 'v': 50}], 'trades': 2},
        }),
        ledger('daily_evidence', 'daily evidence pass', extra: {'status': 'not run yet', 'runs': 0}),
        ledger('lab_paper_book', 'Trading Lab paper book', trades: 3, extra: {'status': 'learning', 'open': 0}),
        ledger('broker_alpaca_paper', 'Alpaca PAPER account', trades: null, extra: {'status': 'read live on request', 'equity': null, 'rule': 'not a CHE ledger: say "check my Alpaca paper orders" to read it from Alpaca'}),
      ],
    };

Widget host(http.Client client, List<String> asked) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingLedgersPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: client))),
    );

void main() {
  testWidgets('every record set is shown separately with its own count, feed health and curve; nothing is summed; it never speaks by itself', (tester) async {
    final asked = <String>[];
    final semantics = tester.ensureSemantics();
    final client = MockClient((r) async => http.Response(jsonEncode(view()), 200, headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(host(client, asked));
    await tester.pumpAndSettle();
    expect(find.text('Trade records by source'), findsOneWidget);
    expect(find.text('Strategy simulation'), findsOneWidget);
    expect(find.text('Forward paper journal'), findsOneWidget);
    expect(find.text('Daily evidence pass'), findsOneWidget);
    expect(find.text('Trading Lab paper book'), findsOneWidget);
    expect(find.text('Alpaca PAPER account'), findsOneWidget);
    expect(find.text('172'), findsOneWidget);
    expect(find.text('81'), findsOneWidget);
    expect(find.textContaining('253'), findsNothing, reason: 'the sets are never added together');
    expect(find.textContaining('never summed'), findsOneWidget);
    expect(find.textContaining('BTCUSDT · LIVE'), findsOneWidget);
    expect(find.textContaining('MNQ · waiting'), findsOneWidget);
    expect(find.textContaining('MNQ=F · DELAYED'), findsOneWidget);
    expect(find.text('NOT RUN YET'), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);
    expect(find.textContaining('Leading, not proven: Breakout over the 20-bar high'), findsOneWidget);
    expect(find.textContaining('Best: Fair value gap retest'), findsOneWidget);
    expect(find.textContaining('read it from Alpaca'), findsOneWidget);
    // The curve's total is explained and split per instrument (owner, 2026-10-24: "what is −226.98 R?").
    expect(find.byKey(const Key('ledger_equity_basis')), findsOneWidget);
    expect(find.byKey(const Key('ledger_instrument_BTCUSDT')), findsOneWidget);
    expect(find.byKey(const Key('ledger_instrument_MNQ')), findsOneWidget);
    expect(asked, isEmpty, reason: 'opening the room is silent');
    await tester.tap(find.text('Read aloud'));
    expect(asked, [kReadLedgersAloud]);
    // VoiceOver hears each set as one labelled card, with its count and status.
    expect(find.bySemanticsLabel(RegExp(r'Strategy simulation\. .*172 closed trades, status running')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Strategy simulation\. .*across all strategies and instruments\. BTCUSDT: 120 trades, net ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Forward paper journal\. .*81 closed trades.*Net \$1250\.50')), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('a record set CHE could not read shows no number, and an older server is reported in one line', (tester) async {
    final client = MockClient((r) async => http.Response(jsonEncode(view(simUnreadable: true)), 200, headers: {'content-type': 'application/json'}));
    await tester.pumpWidget(host(client, []));
    await tester.pumpAndSettle();
    expect(find.text('UNREADABLE'), findsOneWidget);
    expect(find.textContaining('Could not read this record set'), findsOneWidget);
    expect(find.text('172'), findsNothing);
    expect(find.text('81'), findsOneWidget, reason: 'the other sets still show their own numbers');

    final old = MockClient((r) async => http.Response(jsonEncode({'detail': 'Not found'}), 404));
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(host(old, []));
    await tester.pumpAndSettle();
    expect(find.text('Not found'), findsOneWidget);
  });

  testWidgets('a refresh that fails after a good load keeps the numbers but says they are stale', (tester) async {
    var calls = 0;
    final client = MockClient((r) async {
      calls += 1;
      if (calls == 1) return http.Response(jsonEncode(view()), 200, headers: {'content-type': 'application/json'});
      throw Exception('offline');
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheTradingLedgersPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: client, refresh: const Duration(milliseconds: 50))))));
    await tester.pumpAndSettle();
    expect(find.text('172'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 80));
    await tester.pumpAndSettle();
    expect(find.text('172'), findsOneWidget, reason: 'the last good numbers stay');
    expect(find.textContaining('Last refresh failed'), findsOneWidget);
  });

  test('the equity painter repaints only when its points or unit change', () {
    final a = EquityCurvePainter(points: [0.5, 1.0], unit: 'R');
    expect(a.shouldRepaint(EquityCurvePainter(points: [0.5, 1.0], unit: 'R')), isFalse, reason: 'the same series again is not a change');
    expect(a.shouldRepaint(EquityCurvePainter(points: [0.5, 1.5], unit: 'R')), isTrue);
    expect(a.shouldRepaint(EquityCurvePainter(points: [0.5, 1.0], unit: r'$')), isTrue);
  });
}
