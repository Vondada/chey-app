// End to end, OFFLINE (reliability lane R2, 2026-10-25): exchange messages in the shape of the official documentation
// examples go through the real stream (a fake socket, a fake clock), become candles, join the REST history and set
// the status line. Not production verification and not market data: this container's proxy refuses every exchange
// host (Coinbase, Kraken, Binance, Bitstamp REST and WebSocket all answered 403 to CONNECT on 2026-10-25), and the
// documentation hosts too, so the examples below are transcribed from the docs as last read, not re-fetched today:
//   Coinbase Advanced Trade WebSocket channels (market_trades, heartbeats, subscriptions):
//     https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
//   Kraken WebSocket v2 trade: https://docs.kraken.com/api/docs/websocket-v2/trade
// What these examples exercise that the hand-written fixtures do not: Coinbase prices, sizes and the heartbeat counter
// as strings, nanosecond envelope timestamps, a "subscriptions" acknowledgement; Kraken numeric trade ids, microsecond
// timestamps, the status message and the subscribe acknowledgement before any trade.
// The live run is test/che_crypto_stream_live_smoke_test.dart (CHE_LIVE_SMOKE=1), from a network that reaches them.
import 'dart:async';
import 'dart:convert';

import 'package:chey/trading/che_crypto_candles.dart';
import 'package:chey/trading/che_crypto_stream.dart';
import 'package:flutter_test/flutter_test.dart';

class _Socket implements CryptoSocket {
  final _in = StreamController<dynamic>();
  final sent = <String>[];
  @override
  Stream<dynamic> get messages => _in.stream;
  @override
  void send(String text) => sent.add(text);
  @override
  Future<void> close() async {
    if (!_in.isClosed) unawaited(_in.close());
  }

  void push(String raw) => _in.add(raw);
}

// Coinbase documentation examples (subscriptions acknowledgement, market_trades snapshot, heartbeats), with the docs'
// trailing comma removed so the text is valid JSON. Second and third trades follow the same shape a minute later.
const _cbSubscriptions =
    '{"channel":"subscriptions","client_id":"","timestamp":"2023-02-09T20:19:35.401480064Z","sequence_num":0,"events":[{"subscriptions":{"market_trades":["ETH-USD"]}}]}';
const _cbSnapshot =
    '{"channel":"market_trades","client_id":"","timestamp":"2023-02-09T20:19:35.39625135Z","sequence_num":0,"events":[{"type":"snapshot","trades":[{"trade_id":"000000000","product_id":"ETH-USD","price":"1260.01","size":"0.3","side":"BUY","time":"2019-08-14T20:42:27.265Z"}]}]}';
const _cbUpdate =
    '{"channel":"market_trades","client_id":"","timestamp":"2019-08-14T20:43:05.000000001Z","sequence_num":1,"events":[{"type":"update","trades":[{"trade_id":"000000002","product_id":"ETH-USD","price":"1262.50","size":"0.1","side":"SELL","time":"2019-08-14T20:43:04.5Z"},{"trade_id":"000000001","product_id":"ETH-USD","price":"1259.00","size":"0.2","side":"BUY","time":"2019-08-14T20:42:59.1Z"}]}]}';
const _cbHeartbeat =
    '{"channel":"heartbeats","client_id":"","timestamp":"2023-06-23T20:31:26.122969572Z","sequence_num":0,"events":[{"current_time":"2023-06-23 20:31:56.121961769 +0000 UTC m=+91717.525857105","heartbeat_counter":"3049"}]}';

// Kraken documentation examples (status, subscribe acknowledgement, trade snapshot and update), symbol MATIC/USD.
const _krStatus = '{"channel":"status","data":[{"api_version":"v2","connection_id":12393906104898154338,"system":"online","version":"2.0.4"}],"type":"update"}';
const _krAck =
    '{"method":"subscribe","result":{"channel":"trade","snapshot":true,"symbol":"MATIC/USD"},"success":true,"time_in":"2023-09-25T09:04:31.742599Z","time_out":"2023-09-25T09:04:31.742648Z"}';
const _krSnapshot =
    '{"channel":"trade","type":"snapshot","data":[{"symbol":"MATIC/USD","side":"buy","price":0.5147,"qty":6423.46326,"ord_type":"limit","trade_id":4665846,"timestamp":"2023-09-25T07:48:36.925533Z"},{"symbol":"MATIC/USD","side":"buy","price":0.5147,"qty":1136.19677815,"ord_type":"limit","trade_id":4665847,"timestamp":"2023-09-25T07:48:36.925533Z"}]}';
const _krUpdate =
    '{"channel":"trade","type":"update","data":[{"symbol":"MATIC/USD","side":"sell","price":0.5117,"qty":40.0,"ord_type":"market","trade_id":4665906,"timestamp":"2023-09-25T07:49:37.708706Z"}]}';

void main() {
  testWidgets('e2e (offline): Coinbase doc-shaped messages → trades → 1m/5m candles → merged over REST → LIVE line', (tester) async {
    var clock = DateTime.utc(2019, 8, 14, 20, 43, 6);
    final socket = _Socket();
    final s = CheCryptoStream(product: 'ETH-USD', now: () => clock, open: (uri, t) async => socket);
    s.start();
    await tester.pump();
    expect(socket.sent.map((m) => jsonDecode(m)['channel']), ['market_trades', 'heartbeats']);
    for (final m in [_cbSubscriptions, _cbSnapshot, _cbUpdate, _cbHeartbeat]) {
      socket.push(m);
    }
    await tester.pump();
    expect(s.book.accepted, 3, reason: 'string prices and sizes parsed; the acknowledgement and heartbeat make no trade');
    final one = s.candles(1);
    expect(one.map((c) => c.start), [DateTime.utc(2019, 8, 14, 20, 42), DateTime.utc(2019, 8, 14, 20, 43)]);
    // 20:42 holds the snapshot trade (27.3 s) and #1 (59.1 s), which arrived after #2 but belongs to 20:42.
    expect([one[0].open, one[0].high, one[0].low, one[0].close, one[0].trades], [1260.01, 1260.01, 1259.0, 1259.0, 2]);
    expect(one[0].volume, closeTo(0.5, 1e-12));
    expect([one[1].open, one[1].close, one[1].volume], [1262.5, 1262.5, 0.1]);
    final five = s.candles(5).single;
    expect([five.start, five.open, five.high, five.low, five.close], [DateTime.utc(2019, 8, 14, 20, 40), 1260.01, 1262.5, 1259.0, 1262.5]);

    // The REST history ends with the 20:42 bar, fetched while it was forming; 20:43 exists only in the stream.
    final rest = [
      CryptoBar(DateTime.utc(2019, 8, 14, 20, 41), 1258, 1261, 1257.5, 1260, 4),
      CryptoBar(DateTime.utc(2019, 8, 14, 20, 42), 1260.2, 1260.5, 1259.5, 1259.8, 0.4),
    ];
    final merged = mergeCryptoHistory(rest, one);
    expect(merged.map((b) => b.t.minute), [41, 42, 43]);
    expect([merged[0].o, merged[0].c, merged[0].streamed], [1258.0, 1260.0, false], reason: 'a finished REST bar stays');
    expect([merged[1].o, merged[1].h, merged[1].l, merged[1].c, merged[1].v, merged[1].streamed], [1260.2, 1260.5, 1259.0, 1259.0, 0.5, true],
        reason: 'the forming bar: REST open, the wider high and low, the streamed close, the larger volume');
    expect([merged[2].o, merged[2].streamed], [1262.5, true]);

    final view = s.describe(restAvailable: true);
    expect(view.state, CryptoFeedState.live);
    expect(view.label, 'LIVE · Coinbase trades · last trade 1s ago');
    clock = clock.add(const Duration(seconds: 75)); // heartbeats would continue, the trades did not
    socket.push(_cbHeartbeat);
    await tester.pump();
    expect(s.describe(restAvailable: true).state, CryptoFeedState.stale);
    await s.stop();
    s.dispose();
  });

  test('e2e (offline): Kraken v2 doc-shaped messages parse to trades with numeric ids and microsecond times; nothing else is a trade', () {
    final agg = CryptoCandleAggregator();
    final kinds = <String>[];
    for (final raw in [_krStatus, _krAck, _krSnapshot, _krUpdate, _krSnapshot]) {
      final m = parseCryptoMessage(CryptoVenue.kraken, 'MATIC-USD', raw);
      kinds.add(m.trades.isNotEmpty ? 'trades' : m.heartbeat ? 'beat' : m.error != null ? 'error' : 'none');
      for (final t in m.trades) {
        agg.add(t);
      }
    }
    expect(kinds, ['none', 'none', 'trades', 'trades', 'trades']);
    expect(agg.accepted, 3);
    expect(agg.duplicates, 2, reason: 'the snapshot re-sent on reconnect is not counted twice');
    final c = agg.candles(1);
    expect(c.map((x) => x.start), [DateTime.utc(2023, 9, 25, 7, 48), DateTime.utc(2023, 9, 25, 7, 49)]);
    expect(c[0].volume, closeTo(6423.46326 + 1136.19677815, 1e-9));
    expect(c[0].openAt, DateTime.utc(2023, 9, 25, 7, 48, 36, 925, 533), reason: 'microseconds kept');
    expect([c[1].open, c[1].close, c[1].volume], [0.5117, 0.5117, 40.0]);
    expect(agg.last!.tradeId, '4665906');
  });
}
