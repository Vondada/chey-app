// Build 1 (owner, 2026-10-20): the four-section Trading Room and its interactive PAPER chart.
import 'dart:convert';
import 'dart:async';

import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _chart({String account = 'alpaca_paper', bool stale = false, bool entries = true, List<Map<String, dynamic>> drawings = const []}) {
  final start = DateTime.utc(2026, 10, 20, 14, 0);
  final bars = [
    for (var i = 0; i < 40; i++)
      {
        't': start.add(Duration(minutes: 5 * i)).toIso8601String(),
        'o': 100 + i * 0.5,
        'h': 101.5 + i * 0.5,
        'l': 99.5 + i * 0.5,
        'c': 100.8 + i * 0.5,
      },
  ];
  String at(int i) => start.add(Duration(minutes: 5 * i)).toIso8601String();
  return {
    'ok': true,
    'account': account,
    'state': 'verified',
    'symbol': account == 'alpaca_paper' ? 'AAPL' : 'MNQ',
    'timeframe': '5m',
    'timeframes': ['1m', '5m', '15m', '1h', '1d'],
    'bars': bars,
    'feed': {'provider': account == 'alpaca_paper' ? 'Alpaca IEX' : 'Yahoo MNQ=F', 'status': account == 'alpaca_paper' ? 'REALTIME' : 'DELAYED', 'last_bar_time': at(39), 'age_s': stale ? 7200 : 60, 'stale': stale},
    'entries_allowed': entries,
    'market_orders_allowed': entries && !stale,
    'entries_blocked_reason': !entries
        ? 'No futures paper broker is connected (Tradovate is not signed in), so CHE takes no manual futures orders.'
        : stale
            ? 'The last bar is old (market closed or the feed stopped); market orders are blocked, limit orders queue for the next session.'
            : '',
    'markers': [
      {'source': 'che_forward', 'id': 'f1', 'kind': 'entry', 'time': at(5), 'price': 103.0, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed'},
      {'source': 'che_forward', 'id': 'f2', 'kind': 'entry', 'time': at(9), 'price': 105.0, 'side': 'long', 'strategy': 'vwap', 'status': 'closed'},
      {'source': 'che_sim', 'id': 's1', 'kind': 'entry', 'time': at(12), 'price': 106.5, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed'},
      {'source': 'alpaca_order', 'id': 'o1', 'kind': 'order', 'time': at(20), 'price': 109.0, 'side': 'buy', 'qty': '2', 'status': 'new', 'order_id': 'order-0001-abcd'},
      {'source': 'alpaca_fill', 'id': 'x1', 'kind': 'fill', 'time': at(30), 'price': 115.2, 'side': 'buy', 'qty': '1', 'status': 'filled', 'order_id': 'order-0002-abcd'},
    ],
    'open_orders': account == 'alpaca_paper'
        ? [
            {'id': 'order-0001-abcd', 'symbol': 'AAPL', 'side': 'buy', 'qty': '2', 'type': 'limit', 'limit_price': '109.00', 'status': 'new'},
          ]
        : const [],
    'drawings': drawings,
  };
}

class _Server {
  _Server({this.stale = false});
  final bool stale;
  bool failChart = false;
  Completer<http.Response>? pendingPreview;
  final requests = <http.Request>[];
  List<Map<String, dynamic>> drawings = [];

  late final client = MockClient((r) async {
    requests.add(r);
    final p = r.url.path;
    if (p == '/api/trading/chart') {
      if (failChart) return http.Response('{"error":"feed offline"}', 503);
      final account = r.url.queryParameters['account'] ?? 'alpaca_paper';
      return http.Response(jsonEncode(_chart(account: account, stale: stale, entries: account == 'alpaca_paper', drawings: drawings)), 200);
    }
    if (p == '/api/trading/chart/drawings') {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      drawings = [for (final d in body['drawings'] as List) Map<String, dynamic>.from(d as Map)];
      return http.Response(jsonEncode({'ok': true, 'drawings': drawings}), 200);
    }
    if (p == '/api/trading/alpaca/order/preview') {
      if (pendingPreview != null) return pendingPreview!.future;
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      final cost = (body['limit_price'] as num? ?? 120) * (body['qty'] as num);
      return http.Response(jsonEncode({'ok': true, 'mode': 'PAPER', 'estimated_cost': cost, 'buying_power': 100000, 'buying_power_after': 100000 - cost, 'last_trade': 120.3, 'blocked': ''}), 200);
    }
    if (p == '/api/trading/alpaca/order') {
      return http.Response(jsonEncode({'ok': true, 'receipt': {'id': 'order-9999-abcd', 'status': 'accepted'}}), 200);
    }
    if (p == '/api/trading/alpaca/order/cancel') {
      return http.Response(jsonEncode({'ok': true, 'receipt': {'id': 'order-0001-abcd', 'status': 'canceled'}}), 200);
    }
    return http.Response(jsonEncode({'ok': true}), 200);
  });

  Iterable<http.Request> to(String path) => requests.where((r) => r.url.path == path && r.method != 'GET');
}

Future<void> _pumpRoom(WidgetTester tester, _Server s, {CheTradingSection section = CheTradingSection.chart, List<String>? spoken, String? strategy, String account = 'alpaca_paper'}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      body: CheTradingRoom(
        baseUrl: () => 'https://che.example',
        headers: () => const {},
        onAsk: (_) {},
        onRead: spoken?.add,
        client: s.client,
        initialSection: section,
        initialAccount: account,
        initialStrategy: strategy,
      ),
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f.first);
  await tester.pump();
  await tester.tap(f.first);
}

Finder _chartArea() => find.byWidgetPredicate((w) => w is CustomPaint && w.painter.runtimeType.toString() == '_ChartPainter');

void main() {
  testWidgets('four sections; the chart opens first, silent, with every marker source, feed health and PAPER', (tester) async {
    final s = _Server();
    final spoken = <String>[];
    await _pumpRoom(tester, s, spoken: spoken);
    for (final label in ['CHART', 'SETUPS', 'CHE TRADES', 'STRATEGIES', 'ACCOUNT']) {
      expect(find.text(label), findsWidgets);
    }
    expect(find.text('PAPER'), findsOneWidget);
    expect(_chartArea(), findsOneWidget);
    expect(find.textContaining('Alpaca IEX: REALTIME'), findsOneWidget);
    expect(find.text('CHE forward paper 2'), findsOneWidget);
    expect(find.text('CHE simulation 1'), findsOneWidget);
    expect(find.text('Alpaca order 1'), findsOneWidget);
    expect(find.text('Alpaca fill 1'), findsOneWidget);
    expect(find.textContaining('BUY 2 AAPL · limit @ 109.00'), findsOneWidget);
    // Silent on open: nothing is read until the owner asks.
    expect(spoken, isEmpty);
    final state = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    expect(state.summary, contains('2 CHE forward paper'));
    expect(state.summary, contains('Paper entries allowed'));
    await _tap(tester, find.byTooltip('Read chart aloud'));
    expect(spoken.single, contains('Alpaca PAPER, AAPL, 5m candles'));

    // The legend hides a source.
    await _tap(tester, find.text('CHE simulation 1'));
    await tester.pump();
    expect(state.summary, isNot(contains('CHE strategy simulation')));
    expect(state.summary, isNot(contains('1 CHE simulation')));
  });

  testWidgets('a chart price opens a PAPER ticket; nothing is sent until "Yes, place paper order"', (tester) async {
    final s = _Server();
    final spoken = <String>[];
    await _pumpRoom(tester, s, spoken: spoken);
    await tester.ensureVisible(_chartArea());
    await tester.pump();
    await tester.tapAt(tester.getCenter(_chartArea()));
    await tester.pumpAndSettle();
    expect(find.text('AAPL order ticket'), findsOneWidget);
    expect(find.text('PAPER · no real money'), findsOneWidget);
    expect(s.to('/api/trading/alpaca/order'), isEmpty);
    await _tap(tester, find.text('Preview order'));
    await tester.pumpAndSettle();
    expect(s.to('/api/trading/alpaca/order/preview'), hasLength(1));
    expect(find.textContaining('Buying power after'), findsOneWidget);
    expect(s.to('/api/trading/alpaca/order'), isEmpty);
    await _tap(tester, find.textContaining('Yes, place paper order'));
    await tester.pumpAndSettle();
    final placed = s.to('/api/trading/alpaca/order').single;
    final body = jsonDecode(placed.body) as Map<String, dynamic>;
    expect(body['symbol'], 'AAPL');
    expect(body['type'], 'limit');
    expect(body['side'], 'buy');
    expect(body['client_order_id'], startsWith('che-'));
    expect(find.textContaining('Alpaca PAPER accepted BUY 1 AAPL'), findsWidgets);
    expect(spoken.last, contains('Alpaca PAPER accepted BUY 1 AAPL'));
  });

  testWidgets('a refresh outage revokes trading freshness while keeping historical bars visible', (tester) async {
    final server = _Server();
    await _pumpRoom(tester, server);
    server.failChart = true;
    final state = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    await state.load();
    await tester.pump();
    expect(_chartArea(), findsOneWidget);
    expect(find.textContaining('Alpaca IEX: UNAVAILABLE'), findsOneWidget);
    expect(find.textContaining('feed offline'), findsWidgets);
    expect(state.summary, isNot(contains('Paper entries allowed')));
    await state.openTicket();
    await tester.pump();
    expect(find.text('AAPL order ticket'), findsNothing);
    expect(server.to('/api/trading/alpaca/order'), isEmpty);
  });

  testWidgets('dismissing a pending preview causes no state update after disposal', (tester) async {
    final server = _Server()..pendingPreview = Completer<http.Response>();
    await _pumpRoom(tester, server);
    final state = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    unawaited(state.openTicket());
    await tester.pumpAndSettle();
    await _tap(tester, find.text('Preview order'));
    await tester.pump();
    Navigator.of(tester.element(find.text('AAPL order ticket'))).pop();
    await tester.pumpAndSettle();
    server.pendingPreview!.complete(http.Response('{"ok":true}', 200));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(server.to('/api/trading/alpaca/order'), isEmpty);
  });

  testWidgets('a stale feed allows limit orders only; "No, cancel" sends nothing', (tester) async {
    final s = _Server(stale: true);
    await _pumpRoom(tester, s);
    expect(find.textContaining('Limit orders only'), findsOneWidget);
    await _tap(tester, find.text('Order ticket'));
    await tester.pumpAndSettle();
    final market = tester.widget<SegmentedButton<String>>(find.byType(SegmentedButton<String>).last);
    expect(market.segments.firstWhere((x) => x.value == 'market').enabled, isFalse);
    await _tap(tester, find.text('No, cancel. Nothing is sent.'));
    await tester.pumpAndSettle();
    expect(s.to('/api/trading/alpaca/order'), isEmpty);
    expect(s.to('/api/trading/alpaca/order/preview'), isEmpty);
  });

  testWidgets('MNQ futures: no futures broker, so a chart tap sends nothing and says why', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s, account: 'futures_paper');
    expect(find.textContaining('Yahoo MNQ=F: DELAYED'), findsOneWidget);
    expect(find.textContaining('New entries blocked'), findsOneWidget);
    expect(find.text('Order ticket'), findsNothing);
    await tester.ensureVisible(_chartArea());
    await tester.pump();
    await tester.tapAt(tester.getCenter(_chartArea()));
    await tester.pumpAndSettle();
    expect(find.text('MNQ order ticket'), findsNothing);
    expect(s.to('/api/trading/alpaca/order'), isEmpty);
  });

  testWidgets('"show EMA trades" keeps only that strategy among CHE markers', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s, strategy: 'ema', account: 'futures_paper');
    expect(find.textContaining('Showing CHE trades for EMA only'), findsOneWidget);
    final state = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    expect(state.summary, contains('1 CHE forward paper'));
    await _tap(tester, find.text('Show all strategies'));
    await tester.pump();
    expect(state.summary, contains('2 CHE forward paper'));
  });

  testWidgets('a level is drawn by tapping, saved to the Worker, and clearing asks first', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s);
    await _tap(tester, find.text('Level'));
    await tester.pump();
    await tester.ensureVisible(_chartArea());
    await tester.pump();
    await tester.tapAt(tester.getCenter(_chartArea()));
    await tester.pumpAndSettle();
    final put = s.to('/api/trading/chart/drawings').single;
    final body = jsonDecode(put.body) as Map<String, dynamic>;
    expect(body['account'], 'alpaca_paper');
    expect(body['symbol'], 'AAPL');
    expect((body['drawings'] as List).single['kind'], 'hline');
    expect(find.text('AAPL order ticket'), findsNothing);
    await _tap(tester, find.text('Clear'));
    await tester.pumpAndSettle();
    expect(find.text('Remove every drawing?'), findsOneWidget);
    await _tap(tester, find.text('Keep them'));
    await tester.pumpAndSettle();
    expect(s.to('/api/trading/chart/drawings'), hasLength(1));
    // Voice: "Draw a line at 21,450" reaches the chart through its controller.
  });

  testWidgets('an open order is cancelled and the broker receipt is shown', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s);
    await _tap(tester, find.text('Cancel'));
    await tester.pumpAndSettle();
    // Cancelling removes an order: the owner is asked first, and "Keep it" sends nothing.
    expect(find.text('Cancel BUY 2 AAPL on Alpaca PAPER?'), findsOneWidget);
    await tester.tap(find.text('Keep it'));
    await tester.pumpAndSettle();
    expect(s.to('/api/trading/alpaca/order/cancel'), isEmpty);
    await _tap(tester, find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, cancel it'));
    await tester.pumpAndSettle();
    expect(jsonDecode(s.to('/api/trading/alpaca/order/cancel').single.body), {'id': 'order-0001-abcd', 'confirm': true});
    expect(find.textContaining('Alpaca reports the order canceled'), findsWidgets);
  });

  testWidgets('zoom and scroll work by button, and the sections switch', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s);
    final state = tester.state<CheTradingChartState>(find.byType(CheTradingChart));
    final before = state.summary;
    await _tap(tester, find.byTooltip('Zoom in'));
    await tester.pump();
    await _tap(tester, find.byTooltip('Scroll to earlier bars'));
    await tester.pump();
    expect(find.byTooltip('Jump to the latest bar'), findsOneWidget);
    expect(state.summary, before); // the summary speaks of the latest bar, not the window
    await tester.drag(find.byType(ListView).first, const Offset(0, 3000));
    await tester.pumpAndSettle();
    await _tap(tester, find.text('STRATEGIES'));
    await tester.pump();
    expect(find.byType(CheTradingChart), findsNothing);
    await tester.drag(find.byType(ListView).first, const Offset(0, 3000));
    await tester.pumpAndSettle();
    await _tap(tester, find.text('CHART'));
    await tester.pump();
    expect(find.byType(CheTradingChart), findsOneWidget);
  });

  testWidgets('a voice reply naming a section switches the open room to it', (tester) async {
    final s = _Server();
    await _pumpRoom(tester, s);
    expect(find.byType(CheTradingChart), findsOneWidget);
    CheTradingRoom.requestedSection.value = CheTradingSection.strategies;
    await tester.pump();
    expect(find.byType(CheTradingChart), findsNothing);
    expect(CheTradingRoom.requestedSection.value, isNull);
  });

  test('a Worker reply names the section', () {
    expect(cheTradingSectionNamed('strategies'), CheTradingSection.strategies);
    expect(cheTradingSectionNamed('che_trades'), CheTradingSection.cheTrades);
    expect(cheTradingSectionNamed(null), CheTradingSection.chart);
    expect(cheTradingSectionNamed('setups'), CheTradingSection.setups);
  });
}
