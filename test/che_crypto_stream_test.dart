// The BTC/ETH live trade stream (lib/trading/che_crypto_stream.dart) against a fake socket and a fake clock: status
// transitions, heartbeat watchdog, backoff with jitter, resubscribe, duplicate snapshots and Coinbase→Kraken failover.
// Every message here is a FORMAT fixture with made-up values, never market data.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:chey/trading/che_crypto_stream.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeSocket implements CryptoSocket {
  _FakeSocket(this.uri);
  final Uri uri;
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

  /// The exchange drops the connection.
  void drop() => unawaited(_in.close());
}

class _FixedRandom implements math.Random {
  _FixedRandom(this.value);
  double value;
  @override
  double nextDouble() => value;
  @override
  int nextInt(int max) => (value * max).floor();
  @override
  bool nextBool() => value >= 0.5;
}

Map<String, Object> _cbTrades(String type, List<(String, double, DateTime)> trades) => {
      'channel': 'market_trades',
      'events': [
        {
          'type': type,
          'trades': [
            for (final (id, price, at) in trades) {'trade_id': id, 'product_id': 'BTC-USD', 'price': '$price', 'size': '0.01', 'side': 'BUY', 'time': at.toIso8601String()},
          ],
        },
      ],
    };

const _cbHeartbeat = {
  'channel': 'heartbeats',
  'events': [
    {'current_time': 'fixture', 'heartbeat_counter': 1},
  ],
};

void main() {
  late DateTime clock;
  late List<_FakeSocket> sockets;
  late List<Uri> attempts;
  late bool refuse;

  CheCryptoStream make({double jitter = 1.0}) {
    clock = DateTime.utc(2026, 10, 25, 14);
    sockets = [];
    attempts = [];
    refuse = false;
    return CheCryptoStream(
      product: 'BTC-USD',
      now: () => clock,
      random: _FixedRandom(jitter),
      open: (uri, timeout) async {
        attempts.add(uri);
        if (refuse) throw const SocketException('fixture: network unreachable');
        final s = _FakeSocket(uri);
        sockets.add(s);
        return s;
      },
    );
  }

  Future<void> advance(WidgetTester tester, Duration d) async {
    // Move the stream's clock and the test's timers together, a second at a time.
    var left = d;
    while (left > Duration.zero) {
      final step = left > const Duration(seconds: 1) ? const Duration(seconds: 1) : left;
      clock = clock.add(step);
      await tester.pump(step);
      left -= step;
    }
  }

  testWidgets('connects, subscribes within the deadline, LIVE only with a recent trade, STALE when silent, and reconnects past the watchdog', (tester) async {
    final s = make();
    s.start();
    await tester.pump();
    expect(attempts.single, kCoinbaseMarketWs);
    expect(sockets.single.sent.map((m) => jsonDecode(m)['channel']), ['market_trades', 'heartbeats'], reason: 'sent at once: Coinbase closes after 5 s');
    expect(s.describe(restAvailable: true).state, CryptoFeedState.delayed, reason: 'subscribed is not live: no message yet');

    // Regression (reliability lane, 2026-10-25): a heartbeat proves the socket, not the trades. Before the fix the
    // chart said LIVE on heartbeats alone, so a silent trade channel (a failed market_trades subscription) showed LIVE
    // over minutes-old candles.
    sockets.single.push(_cbHeartbeat);
    await tester.pump();
    final beatOnly = s.describe(restAvailable: true);
    expect(beatOnly.state, CryptoFeedState.stale, reason: 'heartbeats without a trade are not live candles');
    expect(beatOnly.label, 'STALE · Coinbase connected, no trade yet');

    sockets.single.push(_cbTrades('update', [('1', 67000.5, clock.subtract(const Duration(seconds: 1)))]));
    await tester.pump();
    final live = s.describe(restAvailable: true);
    expect(live.label, 'LIVE · Coinbase trades · last trade 1s ago');
    expect(live.spoken, contains('BTC live stream: LIVE from Coinbase trades. Last trade 67000.5'));

    await advance(tester, const Duration(seconds: 15));
    final stale = s.describe(restAvailable: true);
    expect(stale.state, CryptoFeedState.stale);
    expect(stale.label, startsWith('STALE · Coinbase silent 15s'));

    await advance(tester, const Duration(seconds: 15)); // 30 s silent: the watchdog drops and reconnects
    expect(sockets.first.closed, isTrue);
    expect(s.reason, contains('sent nothing for 30 seconds'));
    expect(s.describe(restAvailable: true).state, CryptoFeedState.delayed);
    expect(s.describe(restAvailable: false).state, CryptoFeedState.disconnected);
    await advance(tester, const Duration(seconds: 1)); // first retry after 1 s (full jitter value 1.0)
    expect(sockets.length, 2);
    expect(sockets.last.sent.length, 2, reason: 'resubscribed on the new connection');
    await s.stop();
    s.dispose();
  });

  testWidgets('heartbeats over an old last trade are STALE, never LIVE: the label says how old the last trade is', (tester) async {
    final s = make();
    s.start();
    await tester.pump();
    // The snapshot's newest trade is five minutes old; heartbeats keep arriving every second.
    sockets.single.push(_cbTrades('snapshot', [('50', 67000, clock.subtract(const Duration(minutes: 5)))]));
    for (var i = 0; i < 3; i++) {
      sockets.single.push(_cbHeartbeat);
      await advance(tester, const Duration(seconds: 1));
    }
    final v = s.describe(restAvailable: true);
    expect(v.state, CryptoFeedState.stale);
    expect(v.label, startsWith('STALE · Coinbase connected, no trade for 5m'));
    expect(v.spoken, contains('connected, but no trade has arrived for 5 minutes'));
    // A fresh trade makes it LIVE again.
    sockets.single.push(_cbTrades('update', [('51', 67001, clock)]));
    await tester.pump();
    expect(s.describe(restAvailable: true).state, CryptoFeedState.live);
    await s.stop();
    s.dispose();
  });

  testWidgets('a snapshot re-sent after a reconnect counts nothing twice', (tester) async {
    final s = make();
    s.start();
    await tester.pump();
    final t0 = clock;
    sockets.last.push(_cbTrades('snapshot', [('10', 100, t0), ('11', 101, t0.add(const Duration(seconds: 5)))]));
    await tester.pump();
    sockets.last.drop();
    await tester.pump();
    expect(s.connected, isFalse);
    await advance(tester, const Duration(seconds: 1));
    expect(sockets.length, 2);
    sockets.last.push(_cbTrades('snapshot', [('10', 100, t0), ('11', 101, t0.add(const Duration(seconds: 5)))]));
    sockets.last.push(_cbTrades('update', [('12', 102, t0.add(const Duration(seconds: 9)))]));
    await tester.pump();
    expect(s.book.accepted, 3);
    expect(s.book.duplicates, 2);
    expect(s.candles(1).single.trades, 3);
    await s.stop();
    s.dispose();
  });

  testWidgets('backoff doubles to a cap with jitter, and fails over to Kraken after three failures', (tester) async {
    final s = make(jitter: 0.0); // jitter 0: half of each delay
    expect([for (var i = 1; i <= 7; i++) s.backoffFor(i).inSeconds], [1, 2, 4, 8, 16, 30, 30]);
    refuse = true;
    s.start();
    await tester.pump();
    expect(attempts.length, 1);
    expect(s.retryAt, clock.add(const Duration(milliseconds: 500)), reason: 'jitter keeps the delay between half and all of 1 s');
    expect(s.describe(restAvailable: true).label, contains('could not reach Coinbase'));
    await advance(tester, const Duration(milliseconds: 500));
    expect(attempts.length, 2);
    await advance(tester, const Duration(seconds: 1)); // second failure waited half of 2 s
    expect(attempts.length, 3);
    expect(s.venue, CryptoVenue.kraken, reason: 'three Coinbase failures switch to Kraken');
    expect(s.failovers, 1);
    expect(s.reason, contains('switching to Kraken'));
    refuse = false;
    await advance(tester, const Duration(milliseconds: 500));
    expect(attempts.last, kKrakenMarketWs);
    expect(jsonDecode(sockets.last.sent.single)['params']['symbol'], ['BTC/USD']);
    sockets.last.push({'channel': 'heartbeat'});
    await tester.pump();
    expect(s.failures, 0, reason: 'a message ends the failure streak');
    expect(s.describe(restAvailable: true).state, CryptoFeedState.stale, reason: 'a heartbeat alone is not live');
    sockets.last.push({'channel': 'trade', 'type': 'update', 'data': [
      {'symbol': 'BTC/USD', 'side': 'buy', 'price': 67000.1, 'qty': 0.01, 'ord_type': 'market', 'trade_id': 1, 'timestamp': clock.toIso8601String()},
    ]});
    await tester.pump();
    final v = s.describe(restAvailable: true);
    expect(v.state, CryptoFeedState.live);
    expect(v.label, startsWith('LIVE · Kraken trades'));
    await s.stop();
    s.dispose();
  });

  testWidgets('an exchange error reconnects instead of being shown as data', (tester) async {
    final s = make();
    s.start();
    await tester.pump();
    sockets.last.push({'type': 'error', 'message': 'fixture: failure to subscribe'});
    await tester.pump();
    expect(s.connected, isFalse);
    expect(s.reason, 'Coinbase said: fixture: failure to subscribe');
    await s.stop();
    s.dispose();
  });

  testWidgets('the hub shares one stream per product and closes it when the last chart leaves', (tester) async {
    final made = <CheCryptoStream>[];
    clock = DateTime.utc(2026, 10, 25, 14);
    final hub = CheCryptoStreamHub(create: (p, v) {
      final s = CheCryptoStream(product: p, firstVenue: v, now: () => clock, open: (uri, t) async => _FakeSocket(uri));
      made.add(s);
      return s;
    });
    final a = hub.acquire('BTC-USD');
    final b = hub.acquire('BTC-USD');
    await tester.pump();
    expect(identical(a, b), isTrue);
    expect(made.length, 1);
    expect(a.running, isTrue);
    hub.release(a);
    expect(hub.watchers('BTC-USD'), 1);
    expect(a.running, isTrue);
    hub.release(b);
    expect(hub.watchers('BTC-USD'), 0);
    expect(a.running, isFalse);
    await tester.pump(const Duration(seconds: 1));
  });
}
