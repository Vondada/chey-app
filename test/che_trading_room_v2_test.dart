// Trading Room v2 (owner, 2026-10-23): W / L / OPEN markers from recorded trades only, clustering, filters, a tap that
// opens the right record, a portrait expanded chart that never rotates the phone, a chart whose size never moves with
// live ticks, and no overflow at real device sizes in portrait and landscape.
import 'dart:async';
import 'dart:convert';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/rooms/che_trading_expanded.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:chey/trading/che_trade_replay.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Feed implements RithmicMarketFeed {
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => const Stream.empty();
  @override
  bool get subscriptionConfirmed => true;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {}
  @override
  Future<void> close() async {}
  void trade(double price, DateTime at) => _trades.add(RithmicLastTrade(
      symbol: 'MNQZ6', exchange: 'CME', price: price, size: 1, ssboe: at.millisecondsSinceEpoch ~/ 1000, usecs: (at.millisecondsSinceEpoch % 1000) * 1000));
}

final _now = DateTime.now().toUtc();
final _start = DateTime.fromMillisecondsSinceEpoch(_now.millisecondsSinceEpoch ~/ 300000 * 300000, isUtc: true).subtract(const Duration(minutes: 5 * 40));
String _at(int i) => _start.add(Duration(minutes: 5 * i)).toIso8601String();

Map<String, dynamic> _chart() => {
      'ok': true,
      'account': 'futures_paper',
      'state': 'verified',
      'symbol': 'MNQ',
      'timeframe': '5m',
      'timeframes': ['1m', '5m', '15m', '1h', '1d'],
      'bars': [
        for (var i = 0; i < 40; i++) {'t': _at(i), 'o': 21000 + i, 'h': 21006 + i, 'l': 20994 + i, 'c': 21002 + i},
      ],
      'feed': {'provider': 'Yahoo MNQ=F', 'status': 'DELAYED', 'last_bar_time': _at(39), 'age_s': 900, 'stale': false},
      'entries_allowed': false,
      'entries_blocked_reason': 'No futures paper broker is connected.',
      'markers': [
        {'source': 'che_forward', 'id': 'win-1', 'kind': 'entry', 'time': _at(5), 'price': 21004.0, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed'},
        {'source': 'che_forward', 'id': 'win-1', 'kind': 'exit', 'time': _at(10), 'price': 21012.0, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed', 'net_pnl': 16.0, 'r': 1.6},
        {'source': 'che_forward', 'id': 'loss-1', 'kind': 'exit', 'time': _at(25), 'price': 21022.0, 'side': 'long', 'strategy': 'vwap', 'status': 'closed', 'net_pnl': -10.0, 'r': -1.0},
        {'source': 'che_forward', 'id': 'open-1', 'kind': 'open', 'time': _at(35), 'price': 21037.0, 'side': 'long', 'strategy': 'orb', 'status': 'open'},
        {'source': 'che_sim', 'id': 'sim-1', 'kind': 'exit', 'time': _at(30), 'price': 21031.0, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed', 'r': -0.5},
      ],
      'drawings': const [],
    };

http.Client _client() => MockClient((r) async {
      if (r.url.path == '/api/trading/chart') return http.Response(jsonEncode(_chart()), 200);
      return http.Response(jsonEncode({'ok': true}), 200);
    });

ChartMarker _m(Map<String, dynamic> raw) => ChartMarker(raw);

class _Routes extends NavigatorObserver {
  _Routes(this.names);
  final List<String> names;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (route.settings.name != null) names.add(route.settings.name!);
  }
}

void main() {
  group('markers', () {
    test('W, L and OPEN come only from recorded results; nothing is inferred', () {
      expect(_m({'source': 'che_forward', 'kind': 'exit', 'r': 1.2}).outcome, 'win');
      expect(_m({'source': 'che_forward', 'kind': 'exit', 'net_pnl': -3}).outcome, 'loss');
      expect(_m({'source': 'che_forward', 'kind': 'open', 'status': 'open'}).outcome, 'open');
      expect(_m({'source': 'che_sim', 'kind': 'entry', 'status': 'open'}).outcome, 'open');
      expect(_m({'source': 'che_forward', 'kind': 'exit'}).outcome, '', reason: 'an exit without a recorded R or P&L claims nothing');
      expect(_m({'source': 'che_forward', 'kind': 'entry', 'status': 'closed', 'price': 1}).outcome, '');
      expect(_m({'source': 'alpaca_fill', 'kind': 'fill'}).outcome, '');
    });

    test('filters: wins, losses, open, paper, simulation and one strategy', () {
      final all = [for (final raw in _chart()['markers'] as List) ChartMarker(raw as Map<String, dynamic>)];
      List<String> ids(CheMarkerFilter f) => [for (final m in f.apply(all)) '${m.tradeId}:${m.kind}'];
      expect(ids(const CheMarkerFilter()), ['win-1:exit', 'loss-1:exit', 'open-1:open', 'sim-1:exit'],
          reason: 'a closed entry is not drawn when its own exit carries the W');
      expect(ids(const CheMarkerFilter(wins: false)), ['loss-1:exit', 'open-1:open', 'sim-1:exit']);
      expect(ids(const CheMarkerFilter(losses: false)), ['win-1:exit', 'open-1:open']);
      expect(ids(const CheMarkerFilter(open: false)), ['win-1:exit', 'loss-1:exit', 'sim-1:exit']);
      expect(ids(const CheMarkerFilter(sim: false)), ['win-1:exit', 'loss-1:exit', 'open-1:open']);
      expect(ids(const CheMarkerFilter(paper: false)), ['sim-1:exit']);
      expect(ids(const CheMarkerFilter(strategy: 'vwap')), ['loss-1:exit']);
      // A closed entry whose exit is missing is still drawn: nothing recorded disappears.
      final orphan = [ChartMarker({'source': 'che_forward', 'id': 'x', 'kind': 'entry', 'status': 'closed'})];
      expect(const CheMarkerFilter().apply(orphan), hasLength(1));
    });

    test('crowded markers cluster into one counted badge; separate ones stay apart', () {
      final a = _m({'id': 'a'}), b = _m({'id': 'b'}), c = _m({'id': 'c'}), d = _m({'id': 'd'});
      final clusters = cheClusterMarkers([(a, const Offset(100, 50)), (b, const Offset(106, 54)), (c, const Offset(110, 48)), (d, const Offset(200, 50))]);
      expect(clusters, hasLength(2));
      expect([for (final m in clusters.first.members) m.tradeId], ['a', 'b', 'c']);
      expect(clusters.last.members.single.tradeId, 'd');
      expect(cheClusterMarkers([(a, const Offset(0, 0)), (b, const Offset(0, 40))]), hasLength(2), reason: 'far apart vertically');
    });

    test('expanded-chart stats count recorded CHE paper trades only, once each', () {
      final all = [for (final raw in _chart()['markers'] as List) ChartMarker(raw as Map<String, dynamic>)];
      final s = CheRecordedTradeStats.of([...all, all[1]]);
      expect(s.wins, 1);
      expect(s.losses, 1);
      expect(s.open, 1);
      expect(s.netPnl, 6.0, reason: 'simulation never counts as paper P&L');
      expect(s.winRate, 50);
      expect(CheRecordedTradeStats.of(const []).netPnl, isNull);
    });
  });

  testWidgets('tapping a W marker opens that trade\'s record id', (tester) async {
    tester.view.physicalSize = const Size(1179, 2556);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final opened = <String>[];
    CheTradingChart.openTradeRecord = (_, m) => opened.add(m.tradeId);
    addTearDown(() => CheTradingChart.openTradeRecord = null);
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: CheTradingChart(baseUrl: () => 'https://che.example', headers: () => const {}, client: _client(), initialAccount: 'futures_paper', live: CheRithmicLive(), compact: true, height: 260),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final chart = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    final area = find.byKey(const Key('chart_area'));
    final win = chart.shownMarkers.firstWhere((m) => m.tradeId == 'win-1');
    final at = chart.markerOffset(win, tester.getSize(area));
    expect(at, isNotNull);
    await tester.tapAt(tester.getTopLeft(area) + at!);
    await tester.pump();
    expect(opened, ['win-1']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('without an override a marker opens Trade Replay on its record; REPLAY opens the latest closed trade', (tester) async {
    tester.view.physicalSize = const Size(1179, 2556);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final pushed = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      navigatorObservers: [_Routes(pushed)],
      home: Scaffold(
        body: CheTradingRoom(baseUrl: () => 'https://che.example', headers: () => const {}, onAsk: (_) {}, client: _client(), setupDesk: CheSetupDesk()),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final chart = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    final area = find.byKey(const Key('chart_area'));
    final win = chart.shownMarkers.firstWhere((m) => m.tradeId == 'win-1');
    await tester.tapAt(tester.getTopLeft(area) + chart.markerOffset(win, tester.getSize(area))!);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(pushed.last, 'trade_replay/win-1');
    expect(cheMarkerSummary(win), containsPair('result', 'win'));
    expect(cheMarkerSummary(win), isNot(contains('entry_price')), reason: 'an exit marker never invents its entry');
    Navigator.of(tester.element(find.byType(CheTradeReplayPage))).pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byType(CheTradeReplayPage), findsNothing);
    final before = pushed.length;
    // The section row scrolls sideways on a phone (Trading Room v3); REPLAY is its last button.
    await tester.ensureVisible(find.byKey(const Key('trading_nav_replay')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('trading_nav_replay')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(pushed.length, before + 1);
    expect(pushed.last, 'trade_replay/sim-1', reason: 'the latest recorded exit on the chart');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Expand opens a large PORTRAIT chart and never asks the phone to rotate', (tester) async {
    tester.view.physicalSize = const Size(1179, 2556);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final platformCalls = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      platformCalls.add(call.method);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: CheTradingRoom(baseUrl: () => 'https://che.example', headers: () => const {}, onAsk: (_) {}, client: _client(), setupDesk: CheSetupDesk()),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('chart_compact')), findsOneWidget);
    await tester.tap(find.byTooltip('Expand the chart'));
    await tester.pumpAndSettle();
    expect(find.byType(CheTradingChartExpandedPage), findsOneWidget);
    final size = tester.getSize(find.byKey(const Key('chart_area')));
    expect(size.height, greaterThan(size.width * 0.8), reason: 'a tall portrait chart');
    await tester.scrollUntilVisible(find.text('RECENT TRADES'), 300, scrollable: find.descendant(of: find.byType(CheTradingChartExpandedPage), matching: find.byType(Scrollable)).first);
    expect(find.text('RECENT TRADES'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('Win · CHE forward paper'), 200,
        scrollable: find.descendant(of: find.byType(CheTradingChartExpandedPage), matching: find.byType(Scrollable)).first);
    expect(find.textContaining('Win · CHE forward paper'), findsWidgets);
    expect(find.textContaining('Loss · CHE forward paper'), findsWidgets);
    expect(platformCalls.where((m) => m == 'SystemChrome.setPreferredOrientations'), isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('live ticks never resize the chart, move the page or reset the zoom', (tester) async {
    tester.view.physicalSize = const Size(1179, 2556);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final live = CheRithmicLive();
    final feed = _Feed();
    live.attach(feed, symbol: 'MNQZ6', exchange: 'CME');
    final scroll = ScrollController();
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: ListView(controller: scroll, children: [
          CheTradingChart(baseUrl: () => 'https://che.example', headers: () => const {}, client: _client(), initialAccount: 'futures_paper', live: live, compact: true, height: 240),
          const SizedBox(key: Key('below'), height: 1200),
        ]),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final chart = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    chart.zoom(1.5);
    scroll.jumpTo(60);
    await tester.pump();
    final box = tester.getSize(find.byType(CheTradingChart));
    final area = tester.getSize(find.byKey(const Key('chart_area')));
    final below = tester.getTopLeft(find.byKey(const Key('below')));
    final summaryBefore = chart.summary;
    final minute = DateTime.fromMillisecondsSinceEpoch(DateTime.now().toUtc().millisecondsSinceEpoch ~/ 60000 * 60000, isUtc: true);
    for (final (i, price) in [21000.0, 99999.75, 1.25, 21123.5, 123456.25].indexed) {
      feed.trade(price, minute.subtract(const Duration(minutes: 1)).add(Duration(seconds: 5 + i * 5)));
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.getSize(find.byType(CheTradingChart)), box, reason: 'tick $price');
      expect(tester.getSize(find.byKey(const Key('chart_area'))), area);
      expect(tester.getTopLeft(find.byKey(const Key('below'))), below, reason: 'the page never jumps');
      expect(scroll.offset, 60);
    }
    expect(chart.summary, isNot(summaryBefore), reason: 'the ticks did reach the chart');
    expect(tester.takeException(), isNull);
    await live.disconnect();
    await tester.pumpWidget(const SizedBox());
  });

  group('no overflow at real device sizes, portrait and landscape', () {
    for (final (name, size) in const [
      ('iPhone SE', Size(375, 667)),
      ('iPhone 15', Size(393, 852)),
      ('iPhone Pro Max', Size(430, 932)),
      ('iPad', Size(820, 1180)),
      ('desktop', Size(1440, 900)),
    ]) {
      for (final landscape in [false, true]) {
        final s = landscape ? Size(size.height, size.width) : size;
        testWidgets('$name ${landscape ? 'landscape' : 'portrait'}', (tester) async {
          tester.view.physicalSize = s * 3;
          tester.view.devicePixelRatio = 3;
          addTearDown(tester.view.reset);
          await tester.pumpWidget(MaterialApp(
            theme: ThemeData.dark(),
            home: Scaffold(
              body: CheTradingRoom(baseUrl: () => 'https://che.example', headers: () => const {}, onAsk: (_) {}, client: _client(), setupDesk: CheSetupDesk()),
            ),
          ));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(tester.takeException(), isNull);
          final chart = tester.getSize(find.byKey(const Key('chart_area')));
          expect(chart.height, lessThan(s.height * 0.6), reason: 'a compact preview, not a full screen');
          for (final section in CheTradingSection.values) {
            CheTradingRoom.requestedSection.value = section;
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));
            expect(tester.takeException(), isNull, reason: '$section');
          }
          await tester.pumpWidget(const SizedBox());
        });
      }
    }
  });
}
