// Trading Intelligence (owner, 2026-10-22): the panel shows the Worker's stored historical study as it is,
// never speaks by itself, reads aloud only through CHE, and its Run button asks the Worker, which places no order.
import 'dart:convert';

import 'package:chey/rooms/che_trading_intelligence.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> view({String status = 'complete'}) => {
      'version': 'hist-1',
      'state': {'status': status, 'finished_at': '2026-10-22T09:00:00Z', 'done': 7, 'total': 7, 'errors': []},
      'datasets': [
        {
          'id': 'MNQ', 'label': 'Micro E-mini Nasdaq-100 futures (MNQ)', 'ok': true, 'bars': 1850, 'from': '2019-05-06T04:00:00Z', 'to': '2026-10-21T04:00:00Z',
          'provider': 'Yahoo Finance chart (public, free)', 'provider_symbol': 'MNQ=F', 'adjustment': 'none: unadjusted front-month prices; roll jumps are kept and counted',
          'gaps': {'count': 3}, 'jumps': {'count': 9}, 'checksum_sha256': 'ab' * 32, 'proxy': null,
        },
        {'id': 'NQ', 'label': 'E-mini Nasdaq-100 futures (NQ)', 'ok': false, 'error': 'Yahoo Finance chart (public, free) answered HTTP 429'},
        {
          'id': 'NDX', 'label': 'Nasdaq-100 index (proxy)', 'ok': true, 'bars': 10350, 'from': '1985-10-01T04:00:00Z', 'to': '2026-10-21T04:00:00Z',
          'provider': 'Yahoo Finance chart (public, free)', 'provider_symbol': '^NDX', 'adjustment': 'price index', 'gaps': {'count': 2}, 'jumps': {'count': 40},
          'checksum_sha256': 'cd' * 32, 'proxy': 'The cash index is not tradable.',
        },
      ],
      'results': [
        {
          'dataset': 'MNQ', 'configs': 30, 'ranked': 4, 'edge_shown': 0,
          'leakage': {'pdh-break': true, 'sweep-reclaim': true, 'fvg-retest': true, 'displacement-continuation': true, 'order-block-retest': true},
          'top': [
            {
              'rank': 1, 'name': 'liquidity sweep and reclaim', 'filter': 'above the 50-day average', 'target_r': 2, 'edge_shown': false, 'folds_positive': 3, 'folds_total': 5,
              'oos': {'trades': 41, 'expectancy_r': 0.08, 'expectancy_r_95ci': {'low': -0.21, 'high': 0.37}},
              'regimes': {'trend': {'bull (above 200-day)': {'trades': 50, 'expectancy_r': 0.1}}, 'volatility': {'high volatility': {'trades': 12, 'expectancy_r': -0.3}}},
            },
          ],
        },
      ],
      'compare': {'year': 2026, 'paper_trades': 81, 'duplicates_removed': 2},
      'signals': [],
      'not_tested': [{'name': 'Dirty Trez', 'why': 'CHE has no written rules for Dirty Trez.'}],
      'safety': 'Research and paper only. No order is sent, nothing is bought, and real-money trading stays disabled.',
    };

void main() {
  testWidgets('the stored study is shown as it is, accessible, and nothing speaks by itself', (tester) async {
    final asked = <String>[];
    final read = <String>[];
    final posts = <http.Request>[];
    final semantics = tester.ensureSemantics();
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        posts.add(r);
        return http.Response(jsonEncode({'ok': true, 'status': 'complete', 'spoken': 'The last historical study finished 2026-10-22.', 'view': view()}), 200);
      }
      return http.Response(jsonEncode(view()), 200);
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingIntelligencePanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, onRead: read.add, client: client))),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Trading Intelligence'), findsOneWidget);
    expect(find.text('Micro E-mini Nasdaq-100 futures (MNQ)'), findsWidgets);
    expect(find.textContaining('1850 daily bars, 2019-05-06 to 2026-10-21'), findsOneWidget);
    expect(find.textContaining('Not verified: Yahoo Finance chart (public, free) answered HTTP 429'), findsOneWidget, reason: 'a refused source is said, not filled in');
    expect(find.textContaining('Proxy: The cash index is not tradable.'), findsOneWidget);
    expect(find.textContaining('Every rule passed the look-ahead audit'), findsOneWidget);
    expect(find.text('NO EDGE'), findsOneWidget);
    expect(find.textContaining('81 paper trades in 2026, after removing 2 duplicates'), findsOneWidget);
    expect(find.textContaining('Not tested: Dirty Trez'), findsOneWidget);
    expect(asked, isEmpty, reason: 'the panel never speaks by itself');
    expect(read, isEmpty, reason: 'loading the study is silent');

    expect(find.bySemanticsLabel(RegExp(r'^Micro E-mini Nasdaq-100 futures \(MNQ\)\. Verified\. 1850 daily bars')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'1\. liquidity sweep and reclaim, above the 50-day average, 2 R: 41 out-of-sample trades, 0\.08 R per trade')), findsOneWidget);
    for (final label in ['Read the historical study aloud', 'Run the historical study. Free data, no orders.', 'Refresh the historical study']) {
      expect(find.bySemanticsLabel(label), findsOneWidget, reason: label);
    }
    final buttons = find.byWidgetPredicate((w) => w is OutlinedButton);
    expect(buttons, findsNWidgets(4));
    for (var i = 0; i < 4; i++) {
      expect(tester.getSize(buttons.at(i)).height, greaterThanOrEqualTo(44), reason: 'touch targets are at least 44 points');
    }

    await tester.tap(find.text('Read aloud'));
    expect(asked, [kReadIntelligenceAloud]);
    await tester.tap(find.text('Run study'));
    await tester.pumpAndSettle();
    expect(posts, hasLength(1));
    expect(jsonDecode(posts.single.body), {'action': 'run'});
    expect(find.text('The historical study finished.'), findsOneWidget);
    expect(read, ['The historical study finished. The last historical study finished 2026-10-22.'], reason: 'the action the owner started is reported aloud');
    expect(asked, [kReadIntelligenceAloud]);
    semantics.dispose();
  });

  testWidgets('a Run that fails is reported aloud with its reason, and nothing changes', (tester) async {
    final read = <String>[];
    final client = MockClient((r) async => r.method == 'POST'
        ? http.Response(jsonEncode({'detail': 'Only the CHE owner can view or run the historical trading study.'}), 403)
        : http.Response(jsonEncode(view()), 200));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingIntelligencePanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, onRead: read.add, client: client))),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Run study'));
    await tester.pumpAndSettle();
    expect(read, ['The study did not start: Only the CHE owner can view or run the historical trading study.']);
    expect(find.textContaining('The study did not start'), findsOneWidget);
  });

  testWidgets('before any study and for a guest, the panel says so instead of showing numbers', (tester) async {
    final client = MockClient((r) async => http.Response(jsonEncode({'detail': 'Only the CHE owner can view or run the historical trading study.'}), 403));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingIntelligencePanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: client))),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Only the CHE owner can view or run the historical trading study.'), findsOneWidget);

    final fresh = MockClient((r) async => http.Response(jsonEncode({...view(status: 'never run'), 'datasets': [], 'results': [], 'compare': null}), 200));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheTradingIntelligencePanel(key: const Key('fresh'), baseUrl: () => 'https://che.test', headers: () => {}, onAsk: (_) {}, client: fresh))),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('No historical study has run yet'), findsOneWidget);
    expect(find.textContaining('OOS trades'), findsNothing);
  });
}
