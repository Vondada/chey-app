// The Markets chart with BTC/ETH live trades (owner, 2026-10-25): streamed ticks update the newest candle over the
// Worker's REST candles; a visible LIVE / STALE / DELAYED / DISCONNECTED line with a VoiceOver label says which; other
// tickers never open a stream; nothing speaks by itself. Every message is a FORMAT fixture with made-up values.
import 'dart:async';
import 'dart:convert';

import 'package:chey/rooms/che_ticker_selector.dart';
import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/trading/che_crypto_stream.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSocket implements CryptoSocket {
  final _in = StreamController<dynamic>();
  final sent = <String>[];
  bool closed = false;
  @override
  Stream<dynamic> get messages => _in.stream;
  @override
  void send(String text) => sent.add(text);
  @override
  Future<void> close() async {
    closed = true;
    if (!_in.isClosed) unawaited(_in.close());
  }

  void push(Object json) => _in.add(jsonEncode(json));
}

void main() {
  final minute = DateTime.fromMillisecondsSinceEpoch(DateTime.now().toUtc().millisecondsSinceEpoch ~/ 60000 * 60000, isUtc: true);
  late DateTime clock;
  late List<_FakeSocket> sockets;
  late List<String> products;
  late CheCryptoStreamHub hub;
  final spoken = <String>[];

  setUp(() {
    clock = minute.add(const Duration(seconds: 30));
    sockets = [];
    products = [];
    spoken.clear();
    hub = CheCryptoStreamHub(create: (p, v) {
      products.add(p);
      return CheCryptoStream(product: p, firstVenue: v, now: () => clock, open: (uri, t) async {
        final s = _FakeSocket();
        sockets.add(s);
        return s;
      });
    });
  });

  /// The Worker's REST answer: 1-minute Coinbase Exchange candles ending with the current minute.
  Map<String, dynamic> rest(String id) => {
        'ok': true, 'account': 'market', 'timeframe': '1m', 'timeframes': ['1m', '5m', '15m', '1h', '1d'], 'symbol': id.split(':').last,
        'ticker': {'id': id, 'symbol': id.split(':').last, 'category': 'crypto', 'exchange': 'Coinbase Exchange', 'market': 'Coinbase Exchange spot ${id.split(':').last}'},
        'bars': [
          for (var i = 20; i >= 0; i--)
            {'t': minute.subtract(Duration(minutes: i)).toIso8601String(), 'o': 67000, 'h': 67010, 'l': 66990, 'c': 67005, 'v': 2},
        ],
        'feed': {'provider': 'Coinbase Exchange', 'status': 'LIVE', 'age_s': 20, 'stale': false},
        'markers': [], 'entries_allowed': false, 'entries_blocked_reason': 'Research chart on Coinbase Exchange public data.',
      };

  Future<CheTradingChartState> pump(WidgetTester tester, String id) async {
    SharedPreferences.setMockInitialValues({'trading_ticker_last': id, 'trading_ticker_tf': '1m'});
    CheTickerPrefs.instance.reset();
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final client = MockClient((r) async => http.Response(jsonEncode(rest(r.url.queryParameters['symbol'] ?? id)), 200));
    final key = GlobalKey<CheTradingChartState>();
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(
        body: SingleChildScrollView(
          child: CheTradingChart(key: key, baseUrl: () => 'https://che.example', headers: () => const {}, client: client, initialAccount: 'market', cryptoStreams: hub, onSpeak: spoken.add),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return key.currentState!;
  }

  String line(WidgetTester tester) => (tester.widget(find.byKey(const ValueKey('chart-crypto-stream'))) as Text).data!;

  testWidgets('BTC streams: DELAYED on REST first, LIVE with ticks that update the newest candle, labelled for VoiceOver, silent', (tester) async {
    final semantics = tester.ensureSemantics();
    final chart = await pump(tester, 'coinbase:BTC-USD');
    expect(products, ['BTC-USD']);
    expect(sockets.single.sent.map((m) => jsonDecode(m)['channel']), ['market_trades', 'heartbeats']);
    expect(line(tester), startsWith('DELAYED · Coinbase Exchange candles · stream: subscribed'), reason: 'subscribed is not live until a message arrives');

    sockets.single.push({
      'channel': 'market_trades',
      'events': [
        {
          'type': 'update',
          'trades': [
            {'trade_id': 'f1', 'product_id': 'BTC-USD', 'price': '67100.25', 'size': '0.5', 'side': 'BUY', 'time': minute.add(const Duration(seconds: 28)).toIso8601String()},
          ],
        },
      ],
    });
    await tester.pump(const Duration(milliseconds: 300)); // stream notify and chart redraw are each coalesced to 250 ms
    await tester.pump(const Duration(milliseconds: 300));
    expect(line(tester), 'LIVE · Coinbase trades · last trade 2s ago');
    expect(find.bySemanticsLabel(RegExp(r'^BTC live stream: LIVE from Coinbase trades\. Last trade 67100\.25')), findsOneWidget);
    expect(chart.summary, contains('BTC live stream: LIVE'), reason: 'Read chart includes it, when asked');
    expect(spoken, isEmpty, reason: 'a live tick never speaks');

    // The newest REST candle (this minute) joined the streamed one: REST open, streamed close, wider high.
    expect(chart.summary, contains('Last close 67,100.25'));
    await tester.pumpWidget(const SizedBox());
    expect(hub.watchers('BTC-USD'), 0, reason: 'leaving the chart closes the stream');
    expect(sockets.single.closed, isTrue);
    semantics.dispose();
  });

  testWidgets('a silent connection shows STALE with its age', (tester) async {
    await pump(tester, 'coinbase:ETH-USD');
    expect(products, ['ETH-USD']);
    sockets.single.push({'channel': 'heartbeats', 'events': [{'heartbeat_counter': 1}]});
    await tester.pump(const Duration(milliseconds: 300));
    for (var i = 0; i < 12; i++) {
      clock = clock.add(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
    }
    await tester.pump(const Duration(milliseconds: 300));
    expect(line(tester), startsWith('STALE · Coinbase silent 12s'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('other tickers never open a stream and keep the REST feed line', (tester) async {
    await pump(tester, 'coinbase:DOGE-USD');
    expect(products, isEmpty);
    expect(find.byKey(const ValueKey('chart-crypto-stream')), findsNothing);
    expect(find.textContaining('Coinbase Exchange: LIVE'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
