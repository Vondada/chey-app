// The Alpaca PAPER dashboard (owner, 2026-10-20): the fixture is the Worker's own
// alpacaPaperDashboard output (server/cloudflare/broker_alpaca.js) over a fake
// Alpaca with one order in every status and two FILL activities. Executions are
// drawn only from fills; an unfilled order is never an execution; a marker opens
// its receipt; an empty or unconnected account is shown honestly; it never speaks.
import 'dart:convert';
import 'dart:io';

import 'package:chey/rooms/che_alpaca_paper.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> fixture() => (jsonDecode(File('test/fixtures/alpaca_dashboard.json').readAsStringSync()) as Map).cast<String, dynamic>();

Widget host(http.Client client, List<String> asked) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: CheAlpacaPaperPanel(baseUrl: () => 'https://che.test', headers: () => {}, onAsk: asked.add, client: client, refresh: const Duration(hours: 1)))),
    );

http.Client serve(Map<String, dynamic> body, {List<Uri>? seen}) => MockClient((r) async {
      seen?.add(r.url);
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

void main() {
  test('markers: fills come only from Alpaca fills; unfilled orders are rings at their limit price; market orders without a fill are not drawn', () {
    final d = fixture();
    final m = alpacaMarkers(d, 'AAPL');
    expect(m.where((x) => x.fill).length, 2);
    expect(m.where((x) => x.fill).map((x) => x.order['id']), containsAll(['o-filled', 'o-partial']));
    // The partially filled limit order also shows as its own unfilled-remainder ring at its limit price.
    expect(m.where((x) => !x.fill).map((x) => x.order['id']), ['o-partial']);
    final msft = alpacaMarkers(d, 'MSFT');
    expect(msft.every((x) => !x.fill), isTrue, reason: 'no MSFT order filled, so nothing is drawn as an execution');
    expect(msft.length, 2);
    expect(msft.first.label, contains('not an execution'));
    expect(alpacaMarkers(d, 'TSLA').map((x) => x.order['id']), ['o-can'], reason: 'the rejected market order has no price to draw');
  });

  testWidgets('the dashboard shows the PAPER badge, freshness, account tiles with words for profit and loss, every status, and opens a receipt from a marker', (tester) async {
    tester.view.physicalSize = const Size(900, 5000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final asked = <String>[];
    final seen = <Uri>[];
    await tester.pumpWidget(host(serve(fixture(), seen: seen), asked));
    await tester.pumpAndSettle();
    expect(seen.single.path, '/api/trading/alpaca/dashboard');
    expect(find.text('PAPER'), findsOneWidget);
    expect(find.bySemanticsLabel('Paper account. No real money.'), findsOneWidget);
    expect(find.textContaining('Read from Alpaca'), findsOneWidget);
    expect(find.textContaining('Separate from CHE\'s MNQ/NQ futures paper simulations'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Equity \$100,250\.50$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Today: up \$250\.50')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Unrealized: up \$10\.00')), findsOneWidget);
    for (final label in ['Submitted: 1', 'Accepted, waiting: 1', 'Partially filled: 1', 'Filled: 1', 'Canceled: 1', 'Rejected: 1', 'Expired: 1']) {
      expect(find.textContaining(label), findsOneWidget, reason: label);
    }
    expect(find.textContaining('AAPL, 5-minute candles'), findsOneWidget);
    expect(find.textContaining('confirmed by Alpaca'), findsNWidgets(2));
    expect(asked, isEmpty, reason: 'opening the dashboard is silent');

    await tester.tap(find.textContaining('Buy fill, 5 shares of AAPL'));
    await tester.pumpAndSettle();
    expect(find.text('Order receipt (Alpaca PAPER)'), findsOneWidget);
    expect(find.text('o-filled'), findsOneWidget);
    expect(find.textContaining('5 shares at \$200.00'), findsWidgets);
    await tester.tap(find.text('Close receipt'));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('Buy 2 MSFT · limit · \$300.00'));
    await tester.pumpAndSettle();
    expect(find.text('Fills: none confirmed by Alpaca.'), findsOneWidget);
    await tester.tap(find.text('Close receipt'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Read aloud'));
    expect(asked, [kReadAlpacaAloud]);
  });

  testWidgets('an empty paper account and an unconnected one are shown honestly, with no invented numbers', (tester) async {
    final empty = {...fixture(), 'orders': [], 'fills': [], 'positions': [], 'order_counts': {}, 'chart': {'symbol': null, 'bars': []}};
    await tester.pumpWidget(host(serve(empty), []));
    await tester.pumpAndSettle();
    expect(find.textContaining('No trades yet on this paper account'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(host(serve({'state': 'not_configured', 'mode': 'paper'}), []));
    await tester.pumpAndSettle();
    expect(find.textContaining('Alpaca paper is not connected'), findsOneWidget);
    expect(find.textContaining(r'$'), findsNothing);
  });
}
