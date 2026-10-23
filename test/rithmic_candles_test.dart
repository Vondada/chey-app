// Rithmic → chart candles (owner, 2026-10-23): real trades only, exchange timestamps, gaps stay gaps.
import 'dart:async';

import 'package:chey/rithmic/rithmic_candles.dart';
import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:flutter_test/flutter_test.dart';

final _base = DateTime.utc(2026, 10, 23, 14, 30);

RithmicLastTrade trade(double? price, DateTime? at, {int size = 1, String symbol = 'MNQZ6'}) => RithmicLastTrade(
      symbol: symbol,
      exchange: 'CME',
      price: price,
      size: size,
      ssboe: at == null ? null : at.millisecondsSinceEpoch ~/ 1000,
      usecs: at == null ? null : (at.microsecondsSinceEpoch % 1000000),
    );

DateTime t(int minute, [int second = 0, int ms = 0]) => _base.add(Duration(minutes: minute, seconds: second, milliseconds: ms));

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
  void add(RithmicLastTrade t) => _trades.add(t);
}

void main() {
  test('the exchange timestamp places a trade, microseconds included', () {
    final at = t(0, 59, 999);
    expect(rithmicTradeTime(trade(21000, at)), at);
    expect(rithmicTradeTime(const RithmicLastTrade(symbol: 'X', exchange: 'CME', price: 1, size: 1, ssboe: 0)), isNull, reason: 'no timestamp, no candle');
  });

  test('1-minute OHLCV from real trades, boundaries exact', () {
    final book = RithmicCandleBook();
    book.addTrade(trade(21000, t(0, 0), size: 2));
    book.addTrade(trade(21010, t(0, 20)));
    book.addTrade(trade(20990, t(0, 40)));
    book.addTrade(trade(21005, t(0, 59, 999)));
    book.addTrade(trade(21007, t(1, 0)));
    final bars = book.candles(1);
    expect(bars.length, 2);
    expect([bars[0].t, bars[0].o, bars[0].h, bars[0].l, bars[0].c, bars[0].v, bars[0].trades], [t(0), 21000, 21010, 20990, 21005, 5, 4]);
    expect([bars[1].t, bars[1].o, bars[1].c], [t(1), 21007, 21007]);
  });

  test('a minute with no trades has no candle: the gap stays a gap', () {
    final book = RithmicCandleBook();
    book.addTrade(trade(21000, t(0, 5)));
    book.addTrade(trade(21020, t(3, 5)));
    expect(book.candles(1).map((c) => c.t), [t(0), t(3)]);
  });

  test('an out-of-order trade lands in its own minute and is open or close only by its timestamp', () {
    final book = RithmicCandleBook();
    book.addTrade(trade(21000, t(0, 30)));
    book.addTrade(trade(21050, t(1, 10)));
    book.addTrade(trade(20980, t(0, 10))); // late, earlier in minute 0: the new open
    book.addTrade(trade(21001, t(0, 20))); // late, in the middle: neither open nor close
    final m0 = book.candles(1).first;
    expect([m0.o, m0.h, m0.l, m0.c, m0.trades], [20980, 21001, 20980, 21000, 3]);
    expect(book.lastTradeAt, t(1, 10), reason: 'last update is the newest trade, not the last one received');
  });

  test('5-minute candles roll up only the minutes that traded', () {
    final book = RithmicCandleBook();
    book.addTrade(trade(21000, t(0, 1), size: 1)); // 14:30 bucket
    book.addTrade(trade(21030, t(2, 0), size: 2));
    book.addTrade(trade(20970, t(3, 0), size: 3));
    book.addTrade(trade(21010, t(4, 59), size: 4));
    book.addTrade(trade(21100, t(11, 0), size: 5)); // 14:40 bucket; 14:35 had nothing
    final five = book.candles(5);
    expect(five.map((c) => c.t), [t(0), t(10)]);
    expect([five[0].o, five[0].h, five[0].l, five[0].c, five[0].v], [21000, 21030, 20970, 21010, 10]);
    expect([five[1].o, five[1].c, five[1].v], [21100, 21100, 5]);
    // Rolling up never changes the 1-minute candles it came from.
    expect(book.candles(1).first.c, 21000);
  });

  test('trades without a price or timestamp are refused and counted, never invented', () {
    final book = RithmicCandleBook();
    expect(book.addTrade(trade(null, t(0))), isFalse);
    expect(book.addTrade(trade(21000, null)), isFalse);
    expect(book.addTrade(trade(-1, t(0))), isFalse);
    expect(book.isEmpty, isTrue);
    expect(book.refused, 3);
  });

  test('the forming candle is the one whose period has not ended', () {
    final book = RithmicCandleBook()..addTrade(trade(21000, t(0, 30)));
    final c = book.candles(1).single;
    expect(RithmicCandleBook.forming(c, 1, t(0, 59)), isTrue);
    expect(RithmicCandleBook.forming(c, 1, t(1, 0)), isFalse);
  });

  test('old minutes fall off the left past the retention limit', () {
    final book = RithmicCandleBook(maxMinutes: 3);
    for (var i = 0; i < 5; i++) {
      book.addTrade(trade(21000.0 + i, t(i)));
    }
    expect(book.candles(1).map((c) => c.t), [t(2), t(3), t(4)]);
  });

  group('live session status says only what the evidence shows', () {
    test('waiting, connected, quiet, disconnected; other contracts ignored', () async {
      var now = t(0);
      final live = CheRithmicLive(clock: () => now);
      expect(live.status, RithmicLiveStatus.off);
      expect(live.statusLabel, 'Rithmic not connected');
      final feed = _Feed();
      live.attach(feed, symbol: 'MNQZ6', exchange: 'CME');
      expect(live.status, RithmicLiveStatus.waiting);
      expect(live.isLive, isFalse, reason: 'connected but no trade yet is not live data');
      feed.add(trade(21000, t(0, 1)));
      feed.add(trade(99, t(0, 2), symbol: 'MESZ6'));
      await Future<void>.delayed(Duration.zero);
      expect(live.status, RithmicLiveStatus.connected);
      expect(live.statusLabel, 'Rithmic live — MNQZ6 · connected');
      expect(live.book.candles(1).single.h, 21000, reason: 'another contract never enters this book');
      now = t(5);
      expect(live.status, RithmicLiveStatus.quiet);
      expect(live.statusLabel, contains('no trades for'));
      await live.disconnect();
      expect(feed.closed, isTrue);
      expect(live.status, RithmicLiveStatus.disconnected);
      expect(live.isLive, isFalse);
      expect(live.book.isEmpty, isFalse, reason: 'recorded candles stay, labelled as recorded');
    });

    test('a refused login reads as not connected, and does not override a running session', () {
      final live = CheRithmicLive();
      live.loginFailed('Rithmic rejected the username or password.');
      expect(live.status, RithmicLiveStatus.loginFailed);
      expect(live.statusLabel, startsWith('Rithmic did not connect'));
      live.attach(_Feed(), symbol: 'MNQZ6', exchange: 'CME');
      live.loginFailed('second attempt refused');
      expect(live.status, RithmicLiveStatus.waiting);
    });

    test('a real client whose connection closes reads as disconnected', () async {
      final client = RithmicClient(uri: Uri.parse('wss://example.invalid'), open: (_, _) async => throw UnimplementedError());
      final live = CheRithmicLive();
      live.attach(client, symbol: 'MNQZ6', exchange: 'CME');
      await client.close();
      await Future<void>.delayed(Duration.zero);
      expect(live.status, RithmicLiveStatus.disconnected);
    });
  });
}
