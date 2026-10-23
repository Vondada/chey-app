// MNQ PAPER chart with Rithmic (owner, 2026-10-23): live candles from real Rithmic trades; Yahoo stays labelled
// delayed history; the header shows the active source, the connection status and the last update.
import 'dart:async';
import 'dart:convert';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/rooms/che_trading_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Feed implements RithmicMarketFeed {
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  bool closed = false;
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => const Stream.empty();
  @override
  bool get subscriptionConfirmed => true;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {}
  @override
  Future<void> close() async => closed = true;
  void trade(double price, DateTime at) => _trades.add(RithmicLastTrade(
      symbol: 'MNQZ6', exchange: 'CME', price: price, size: 1, ssboe: at.millisecondsSinceEpoch ~/ 1000, usecs: (at.millisecondsSinceEpoch % 1000) * 1000));
}

/// The Worker's MNQ answer today: 5-minute Yahoo bars, DELAYED, ending well before now.
Map<String, dynamic> _futures(DateTime end) {
  final start = end.subtract(const Duration(minutes: 5 * 30));
  return {
    'ok': true,
    'account': 'futures_paper',
    'state': 'verified',
    'symbol': 'MNQ',
    'timeframe': '5m',
    'timeframes': ['5m', '15m', '1h', '1d'],
    'bars': [
      for (var i = 0; i < 30; i++) {'t': start.add(Duration(minutes: 5 * i)).toIso8601String(), 'o': 21000, 'h': 21004, 'l': 20996, 'c': 21002},
    ],
    'feed': {'provider': 'Yahoo MNQ=F', 'status': 'DELAYED', 'last_bar_time': start.add(const Duration(minutes: 5 * 29)).toIso8601String(), 'age_s': 900, 'stale': false},
    'entries_allowed': false,
    'market_orders_allowed': false,
    'entries_blocked_reason': 'No futures paper broker is connected (Tradovate is not signed in), so CHE takes no manual futures orders.',
    'markers': const [],
    'drawings': const [],
  };
}

void main() {
  final now = DateTime.now().toUtc();
  // Whole minutes back from now, so the test's candles never straddle a boundary differently on a slow machine.
  final minute = DateTime.fromMillisecondsSinceEpoch(now.millisecondsSinceEpoch ~/ 60000 * 60000, isUtc: true);
  final requests = <Uri>[];

  Future<CheTradingChartState> pump(WidgetTester tester, CheRithmicLive live) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final client = MockClient((r) async {
      requests.add(r.url);
      return http.Response(jsonEncode(_futures(minute.subtract(const Duration(minutes: 20)))), 200);
    });
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: SingleChildScrollView(
          child: CheTradingChart(baseUrl: () => 'https://che.example', headers: () => const {}, client: client, initialAccount: 'futures_paper', live: live),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return tester.state<CheTradingChartState>(find.byType(CheTradingChart));
  }

  String text(WidgetTester tester, String key) => (tester.widget(find.byKey(ValueKey(key))) as Text).data!;

  testWidgets('without Rithmic the MNQ chart says Yahoo Finance (delayed), never live', (tester) async {
    final chart = await pump(tester, CheRithmicLive());
    // Layout unchanged before Rithmic is in play: the feed line names the delayed provider.
    expect(find.byKey(const ValueKey('chart-source')), findsNothing);
    expect(find.textContaining('Yahoo MNQ=F: DELAYED'), findsOneWidget);
    expect(chart.sourceLabel, 'Source: Yahoo Finance (delayed)');
    expect(chart.summary, contains('Source: Yahoo Finance (delayed). Rithmic not connected'));
    expect(chart.summary, isNot(contains('Rithmic live')));
    expect(find.textContaining('live', findRichText: true).evaluate().where((e) => (e.widget as Text).data!.contains('Yahoo') && (e.widget as Text).data!.contains('live')), isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Rithmic trades become the newest 5m and 1m candles; source, status and last update are shown', (tester) async {
    final live = CheRithmicLive();
    final feed = _Feed();
    live.attach(feed, symbol: 'MNQZ6', exchange: 'CME');
    final chart = await pump(tester, live);
    expect(text(tester, 'chart-rithmic'), contains('waiting for the first trade'));

    final t0 = minute.subtract(const Duration(minutes: 2)).add(const Duration(seconds: 5));
    feed.trade(21100, t0);
    feed.trade(21110, t0.add(const Duration(seconds: 20)));
    feed.trade(21095, minute.subtract(const Duration(minutes: 1)).add(const Duration(seconds: 3)));
    await tester.pump(const Duration(milliseconds: 300)); // the chart redraws at most 4 times a second

    expect(text(tester, 'chart-source'), startsWith('Source: Rithmic live — MNQZ6 from '));
    expect(text(tester, 'chart-source'), endsWith('earlier bars Yahoo Finance (delayed)'));
    final status = text(tester, 'chart-rithmic');
    expect(status, startsWith('Rithmic live — MNQZ6 · connected'));
    expect(status, contains('last trade '));
    expect(status, contains('Live feed pauses when CHE is in the background'));
    expect(status, contains('updated '));
    expect(chart.summary, contains('Rithmic live — MNQZ6'));

    // 1m is offered once Rithmic is connected, and is drawn from Rithmic candles alone (no stretched 5m history).
    expect(find.bySemanticsLabel('Timeframe 1m'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Timeframe 1m'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(requests.last.queryParameters['tf'], '1m');
    expect(text(tester, 'chart-source'), startsWith('Source: Rithmic live — MNQZ6'));
    expect(text(tester, 'chart-source'), isNot(contains('Yahoo')), reason: 'the Worker answered 5m history, which never fills a 1m chart');
    expect(chart.summary, contains('1m candles'));

    // The feed drops: the header says so, and the recorded candles are no longer called live.
    await live.disconnect();
    await tester.pump(const Duration(milliseconds: 300));
    expect(feed.closed, isTrue);
    expect(text(tester, 'chart-rithmic'), startsWith('Rithmic MNQZ6 · disconnected'));
    expect(text(tester, 'chart-source'), contains('recorded on this phone'));
    expect(text(tester, 'chart-source'), isNot(contains('live')));
    // Orders stay as the Worker set them: blocked for futures.
    expect(find.textContaining('New entries blocked'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
