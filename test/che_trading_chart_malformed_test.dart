// Regression for the owner's chart crash (handoff 2026-10-20, ChatGPT PR #395: "type 'int' is not a subtype of
// 'List'"): a Worker answer whose collection fields arrive as scalars must draw an honest empty chart, never throw.
// The guards are in lib/rooms/che_trading_chart.dart; the handoff asked for this regression test, which did not exist.
import 'dart:convert';

import 'package:chey/rooms/che_ticker_selector.dart';
import 'package:chey/rooms/che_trading_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  for (final account in ['market', 'futures_paper', 'alpaca_paper']) {
    testWidgets('$account: scalar bars, timeframes, markers, drawings, orders, positions and points do not crash the chart', (tester) async {
      SharedPreferences.setMockInitialValues({'trading_ticker_last': 'coinbase:SOL-USD', 'trading_ticker_tf': '5m'});
      CheTickerPrefs.instance.reset();
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final malformed = {
        'ok': true, 'account': account, 'timeframe': '5m', 'symbol': 'SOL-USD', 'state': 'verified',
        'timeframes': 5, 'bars': 12, 'markers': 3, 'drawings': 1, 'open_orders': 2, 'positions': 'none', 'points': 7,
        'levels': 4, 'feed': {'provider': 'Coinbase Exchange', 'status': 'LIVE', 'age_s': 20, 'stale': false},
        'entries_allowed': false,
      };
      final client = MockClient((r) async => http.Response(jsonEncode(malformed), 200));
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: CheTradingChart(baseUrl: () => 'https://che.example', headers: () => const {}, client: client, initialAccount: account),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.takeException(), isNull);
      expect(find.byType(CheTradingChart), findsOneWidget);
      // load() catches what _apply throws, so a cast failure would surface as the error text, not an exception.
      expect(find.textContaining('subtype'), findsNothing, reason: 'a scalar field must not become a cast error shown to the owner');
      expect(find.textContaining('_TypeError'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  }
}
