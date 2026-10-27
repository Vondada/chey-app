// BTC/ETH candles from streamed trades (lib/trading/che_crypto_candles.dart). The fixtures in
// test/fixtures/crypto_stream are FORMAT fixtures: the exchanges' message shapes with made-up values, never market data.
import 'dart:convert';
import 'dart:io';

import 'package:chey/trading/che_crypto_candles.dart';
import 'package:chey/trading/che_crypto_stream.dart';
import 'package:flutter_test/flutter_test.dart';

List<Object?> _messages(String name) => (jsonDecode(File('test/fixtures/crypto_stream/$name').readAsStringSync()) as Map)['messages'] as List;

DateTime _t(String s) => DateTime.parse(s).toUtc();

CryptoTrade _trade(String id, double price, String at, {double size = 1, String venue = 'coinbase'}) =>
    CryptoTrade(venue: venue, product: 'BTC-USD', tradeId: id, price: price, size: size, time: _t(at));

void main() {
  test('the Coinbase format fixture builds exact 1m and 5m candles: out of order, duplicates, other products and a gap', () {
    final agg = CryptoCandleAggregator();
    var heartbeats = 0;
    for (final m in _messages('coinbase_market_trades.fixture.json')) {
      final parsed = parseCryptoMessage(CryptoVenue.coinbase, 'BTC-USD', jsonEncode(m));
      if (parsed.heartbeat && parsed.trades.isEmpty) heartbeats++;
      for (final t in parsed.trades) {
        agg.add(t);
      }
    }
    expect(heartbeats, 1);
    expect(agg.accepted, 7, reason: 'ETH and the trade without a time are left out');
    expect(agg.duplicates, 2, reason: 'the snapshot re-sent after a reconnect counts nothing twice');

    final one = agg.candles(1);
    expect(one.map((c) => c.start), [_t('2026-10-25T14:00:00Z'), _t('2026-10-25T14:01:00Z'), _t('2026-10-25T14:03:00Z')],
        reason: '14:02 had no trade, so it has no candle');
    expect([one[0].open, one[0].high, one[0].low, one[0].close, one[0].trades], [67000.0, 67010.5, 67000.0, 67005.0, 3]);
    expect(one[0].volume, closeTo(0.035, 1e-12));
    // 104 (14:01:20) arrived after 105 (14:01:50): it sets the low but not the close.
    expect([one[1].open, one[1].high, one[1].low, one[1].close, one[1].trades], [67020.0, 67030.0, 66990.0, 67030.0, 3]);
    expect(one[1].volume, closeTo(0.35, 1e-12));
    expect([one[2].open, one[2].close, one[2].volume], [67100.0, 67100.0, 0.3]);

    final five = agg.candles(5).single;
    expect([five.open, five.high, five.low, five.close, five.trades], [67000.0, 67100.0, 66990.0, 67100.0, 7]);
    expect(five.volume, closeTo(0.685, 1e-12));
    expect(agg.last!.tradeId, '106');
  });

  test('the Kraken v2 format fixture parses trades and heartbeats for the right symbol only', () {
    final agg = CryptoCandleAggregator();
    var heartbeats = 0;
    for (final m in _messages('kraken_trade.fixture.json')) {
      final parsed = parseCryptoMessage(CryptoVenue.kraken, 'ETH-USD', m);
      if (parsed.heartbeat && parsed.trades.isEmpty) heartbeats++;
      expect(parsed.error, isNull);
      for (final t in parsed.trades) {
        expect(t.venue, 'kraken');
        agg.add(t);
      }
    }
    expect(heartbeats, 1);
    expect(agg.accepted, 3);
    final c = agg.candles(1);
    expect(c.length, 2);
    expect([c[0].open, c[0].high, c[0].low, c[0].close], [2500.1, 2500.1, 2499.9, 2499.9]);
    expect(c[0].volume, closeTo(1.75, 1e-12));
  });

  test('exchange errors and refused subscriptions are reported, never read as data', () {
    expect(parseCryptoMessage(CryptoVenue.coinbase, 'BTC-USD', '{"type":"error","message":"rate limited"}').error, 'rate limited');
    expect(parseCryptoMessage(CryptoVenue.kraken, 'BTC-USD', '{"method":"subscribe","success":false,"error":"Currency pair not supported"}').error,
        'Currency pair not supported');
    expect(parseCryptoMessage(CryptoVenue.coinbase, 'BTC-USD', 'not json').isEmpty, isTrue);
  });

  test('subscribe messages match the documented formats', () {
    expect(cryptoSubscribeMessages(CryptoVenue.coinbase, 'BTC-USD').map(jsonDecode), [
      {'type': 'subscribe', 'product_ids': ['BTC-USD'], 'channel': 'market_trades'},
      {'type': 'subscribe', 'product_ids': ['BTC-USD'], 'channel': 'heartbeats'},
    ]);
    expect(jsonDecode(cryptoSubscribeMessages(CryptoVenue.kraken, 'ETH-USD').single), {
      'method': 'subscribe',
      'params': {'channel': 'trade', 'symbol': ['ETH/USD'], 'snapshot': true},
    });
  });

  test('only BTC and ETH against USD stream', () {
    expect(cryptoStreamProduct('coinbase:BTC-USD'), 'BTC-USD');
    expect(cryptoStreamProduct('coinbase:ETH-USD'), 'ETH-USD');
    expect(cryptoStreamProduct('kraken:XBT-USD'), 'BTC-USD');
    expect(cryptoStreamVenue('kraken:ETH-USD'), CryptoVenue.kraken);
    expect(cryptoStreamProduct('coinbase:DOGE-USD'), isNull);
    expect(cryptoStreamProduct('coinbase:BTC-USDT'), isNull);
    expect(cryptoStreamProduct('futures:MNQ'), isNull);
    expect(cryptoStreamProduct('BTC-USD'), isNull);
  });

  test('periods start on UTC boundaries; 1d at midnight UTC', () {
    final at = _t('2026-10-25T14:37:42.5Z');
    expect(cryptoPeriodStart(at, 1), _t('2026-10-25T14:37:00Z'));
    expect(cryptoPeriodStart(at, 15), _t('2026-10-25T14:30:00Z'));
    expect(cryptoPeriodStart(at, 60), _t('2026-10-25T14:00:00Z'));
    expect(cryptoPeriodStart(at, 1440), _t('2026-10-25T00:00:00Z'));
  });

  test('a trade older than every kept candle is dropped, never placed in a candle that left', () {
    final agg = CryptoCandleAggregator(minutes: const [1], maxCandles: 2);
    agg.add(_trade('1', 10, '2026-10-25T14:00:10Z'));
    agg.add(_trade('2', 11, '2026-10-25T14:01:10Z'));
    agg.add(_trade('3', 12, '2026-10-25T14:02:10Z'));
    expect(agg.candles(1).map((c) => c.close), [11.0, 12.0]);
    expect(agg.add(_trade('4', 9, '2026-10-25T14:00:30Z')), isFalse);
    expect(agg.tooOld, 1);
    expect(agg.add(_trade('5', 13, '2026-10-25T14:01:40Z')), isTrue, reason: 'a late trade inside the kept window still counts');
    expect(agg.candles(1).first.close, 13.0);
  });

  group('mergeCryptoHistory', () {
    final rest = [
      CryptoBar(_t('2026-10-25T14:00:00Z'), 100, 110, 95, 105, 50),
      CryptoBar(_t('2026-10-25T14:01:00Z'), 105, 108, 101, 102, 40),
      CryptoBar(_t('2026-10-25T14:02:00Z'), 102, 104, 100, 103, 10), // newest REST bar, still forming when fetched
    ];

    test('without streamed trades the REST bars are shown unchanged', () {
      expect(mergeCryptoHistory(rest, const []), same(rest));
    });

    test('the newest REST bar joins the streamed candle; later periods are streamed; finished REST bars stay', () {
      final agg = CryptoCandleAggregator(minutes: const [1]);
      agg.add(_trade('a', 999, '2026-10-25T14:01:30Z', size: 1)); // the stream joined late: REST keeps 14:01
      agg.add(_trade('b', 106, '2026-10-25T14:02:20Z', size: 2));
      agg.add(_trade('c', 99, '2026-10-25T14:02:40Z', size: 3));
      agg.add(_trade('d', 107, '2026-10-25T14:04:05Z', size: 1));
      final out = mergeCryptoHistory(rest, agg.candles(1));
      expect(out.map((b) => b.t.minute), [0, 1, 2, 4], reason: '14:03 had no trade and no REST bar: no bar');
      expect(out[1].c, 102, reason: 'a finished REST candle is complete; the stream only saw part of it');
      expect(out[1].streamed, isFalse);
      final joined = out[2];
      expect([joined.o, joined.h, joined.l, joined.c, joined.v, joined.streamed], [102.0, 106.0, 99.0, 99.0, 10.0, true],
          reason: 'REST open, wider high and low, streamed close, the larger volume (never a sum)');
      expect([out[3].o, out[3].c, out[3].streamed], [107.0, 107.0, true]);
    });
  });
}
