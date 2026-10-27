// The trading engines' feed (lib/trading/che_market_feed.dart): forming updates, each closed candle exactly once,
// on time only, from real Rithmic trades.
import 'dart:async';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:flutter_test/flutter_test.dart';

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
  void trade(double price, DateTime at) =>
      _trades.add(RithmicLastTrade(symbol: 'MNQZ6', exchange: 'CME', price: price, size: 1, ssboe: at.millisecondsSinceEpoch ~/ 1000, usecs: (at.millisecondsSinceEpoch % 1000) * 1000));
}

void main() {
  final base = DateTime.utc(2026, 10, 23, 14, 30);

  test('no session: not live, no price, no candles', () {
    final feed = CheMarketFeed(live: CheRithmicLive());
    expect(feed.current.isLive, isFalse);
    expect(feed.current.sourceLabel, 'No live feed');
    expect(feed.current.lastPrice, isNull);
    expect(feed.history(1), isEmpty);
    expect(() => feed.candles(15), throwsArgumentError);
  });

  test('forming updates, then each closed candle once, only after its period and grace', () async {
    var now = base;
    final live = CheRithmicLive(clock: () => now);
    final feed = CheMarketFeed(live: live, clock: () => now, closeGrace: const Duration(seconds: 2));
    final one = <CheCandle>[], five = <CheCandle>[];
    final snaps = <CheMarketSnapshot>[];
    feed.candles(1).listen(one.add);
    feed.candles(5).listen(five.add);
    feed.snapshots.listen(snaps.add);
    final rithmic = _Feed();
    live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');

    now = base.add(const Duration(seconds: 10));
    rithmic.trade(21000, now);
    await Future<void>.delayed(Duration.zero);
    expect(one.single.closed, isFalse);
    expect(one.single.close, 21000);

    now = base.add(const Duration(seconds: 61)); // minute 14:30 over, still inside the grace
    rithmic.trade(21004, base.add(const Duration(seconds: 59, milliseconds: 500))); // late trade for 14:30
    await Future<void>.delayed(Duration.zero);
    expect(one.where((c) => c.closed), isEmpty, reason: 'grace not over: not final yet');

    now = base.add(const Duration(seconds: 70));
    rithmic.trade(21010, now); // 14:31 trade; 14:30 is now past its grace
    await Future<void>.delayed(Duration.zero);
    final closed = one.where((c) => c.closed).toList();
    expect(closed.length, 1);
    expect([closed.single.start, closed.single.open, closed.single.close, closed.single.trades], [base, 21000, 21004, 2]);
    expect(one.last.closed, isFalse);
    expect(one.last.start, base.add(const Duration(minutes: 1)));

    rithmic.trade(21011, now.add(const Duration(milliseconds: 1)));
    await Future<void>.delayed(Duration.zero);
    expect(one.where((c) => c.closed).length, 1, reason: 'a closed candle arrives exactly once');
    expect(five.every((c) => !c.closed), isTrue);

    final s = feed.current;
    expect([s.isLive, s.sourceLabel, s.lastPrice, s.connection], [true, 'Rithmic live — MNQZ6', 21011, CheFeedConnection.connected]);
    expect(s.lastTradeAt, now.add(const Duration(milliseconds: 1)));
    expect(s.lastUpdate, now);
    expect(snaps, isNotEmpty);
    expect(feed.history(1).map((c) => c.closed), [true, false]);
    await feed.dispose();
  });

  test('a quiet period closes on its timer with no further trade', () async {
    final live = CheRithmicLive();
    final feed = CheMarketFeed(live: live, closeGrace: Duration.zero);
    final one = <CheCandle>[];
    feed.candles(1).listen(one.add);
    final rithmic = _Feed();
    live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');
    // A trade from two minutes ago: its period is already over, so it closes at once.
    rithmic.trade(21000, DateTime.now().toUtc().subtract(const Duration(minutes: 2)));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(one.where((c) => c.closed).length, 1);
    await feed.dispose();
  });
}
