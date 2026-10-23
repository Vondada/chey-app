// The live chart on Home and the shared connection states (owner, 2026-10-23): live by default, every state in words,
// delayed only by choice and never called live, one subscription per timeframe, stable zoom on live ticks.
import 'dart:async';

import 'package:chey/che_ui/che_chrome_status.dart';
import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/trading/che_live_chart_card.dart';
import 'package:chey/trading/che_live_feed_hub.dart';
import 'package:chey/trading/che_live_status.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

// Thursday 2026-10-22, 10:00 New York: futures open.
final _open = DateTime.utc(2026, 10, 22, 14, 0);
// Saturday 2026-10-24, noon New York: futures closed.
final _closed = DateTime.utc(2026, 10, 24, 16, 0);

CheMarketSnapshot _snap(CheFeedConnection c, {String label = '', DateTime? last}) => CheMarketSnapshot(
      symbol: 'MNQZ6',
      exchange: 'CME',
      source: 'rithmic',
      sourceLabel: '',
      connection: c,
      statusLabel: label,
      isLive: c == CheFeedConnection.connected,
      lastPrice: 21000,
      lastTradeAt: last,
      lastUpdate: last,
    );

Widget _app(Widget child, {bool reduceMotion = false}) => MaterialApp(
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
          child: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: child))),
        ),
      ),
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('states', () {
    test('each feed state maps to its own word, never stronger than the evidence', () {
      String word(CheFeedConnection c, {bool candles = false, DateTime? now, String label = ''}) =>
          CheLiveStatus.fromFeed(_snap(c, label: label, last: _open), hasCandles: candles, now: now ?? _open).word;
      expect(word(CheFeedConnection.connected), 'LIVE');
      expect(word(CheFeedConnection.waiting), 'CONNECTING');
      expect(word(CheFeedConnection.waiting, candles: true), 'RECONNECTING');
      expect(word(CheFeedConnection.quiet), 'NO TRADES');
      expect(word(CheFeedConnection.quiet, now: _closed), 'MARKET CLOSED');
      expect(word(CheFeedConnection.off), 'DISCONNECTED');
      expect(word(CheFeedConnection.disconnected, label: 'Rithmic MNQZ6 · disconnected: the connection closed'), 'DISCONNECTED');
      expect(word(CheFeedConnection.failed), 'DISCONNECTED');
    });

    test('a disconnect says why and when; off says Rithmic is not connected', () {
      final off = CheLiveStatus.fromFeed(_snap(CheFeedConnection.off), hasCandles: false, now: _open);
      expect(off.detail, 'Rithmic not connected');
      final dropped = CheLiveStatus.fromFeed(_snap(CheFeedConnection.disconnected, label: 'Rithmic MNQZ6 · disconnected: the connection closed', last: _open),
          hasCandles: true, now: _open);
      expect(dropped.detail, startsWith('the connection closed · last update'));
      final closed = CheLiveStatus.fromFeed(_snap(CheFeedConnection.quiet, last: _open), hasCandles: true, now: _closed);
      expect(closed.detail, startsWith('Market closed · last update'));
      expect(closed.isCurrent, isFalse);
    });

    test('only LIVE is live or current; delayed is never live', () {
      for (final c in CheFeedConnection.values) {
        final s = CheLiveStatus.fromFeed(_snap(c), hasCandles: true, now: _open);
        expect(s.isLive, c == CheFeedConnection.connected, reason: c.name);
        expect(s.isCurrent, c == CheFeedConnection.connected, reason: c.name);
      }
      final d = CheLiveStatus.delayed(symbol: 'MNQ', provider: 'Yahoo MNQ=F', lastPrice: 21000);
      expect(d.isLive, isFalse);
      expect(d.word, 'DELAYED');
      expect(d.detail, startsWith('Not live'), reason: 'delayed data says it is not live');
    });

    test('each state has its chrome status tone, and only changing states pulse', () {
      expect(CheLiveTone.tone(CheLiveState.live), CheStatusTone.success);
      expect(CheLiveTone.tone(CheLiveState.connecting), CheStatusTone.active);
      expect(CheLiveTone.tone(CheLiveState.reconnecting), CheStatusTone.warning);
      expect(CheLiveTone.tone(CheLiveState.delayed), CheStatusTone.warning);
      expect(CheLiveTone.tone(CheLiveState.disconnected), CheStatusTone.failure);
      expect(CheLiveTone.activity(CheLiveState.disconnected), CheActivity.disconnected);
      expect(CheLiveTone.pulses(CheLiveState.disconnected), isFalse);
      expect(CheLiveTone.pulses(CheLiveState.delayed), isFalse);
      expect(CheLiveTone.pulses(CheLiveState.quiet), isFalse);
    });
  });

  group('shared subscriptions', () {
    test('two screens share one channel; the last to leave closes it', () {
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: CheRithmicLive()), throttle: Duration.zero);
      final home = hub.acquire(1);
      final room = hub.acquire(1);
      expect(identical(home.channel, room.channel), isTrue);
      expect(hub.activeRefs, {1: 2});
      expect(hub.subscriptionCount, 2, reason: 'one candle and one status subscription');
      home.release();
      home.release(); // a second release is ignored
      expect(hub.activeRefs, {1: 1});
      room.release();
      expect(hub.activeRefs, isEmpty);
      expect(hub.subscriptionCount, 0);
      expect(() => hub.acquire(15), throwsArgumentError);
    });

    test('a Rithmic drop and reconnect adds no subscriptions and keeps the candles', () async {
      var now = _open;
      final live = CheRithmicLive(clock: () => now);
      final feed = CheMarketFeed(live: live, clock: () => now);
      final hub = CheLiveFeedHub(feed: feed, throttle: Duration.zero);
      final lease = hub.acquire(1);
      final first = _Feed();
      live.attach(first, symbol: 'MNQZ6', exchange: 'CME');
      now = _open.add(const Duration(seconds: 5));
      first.trade(21000, now);
      await Future<void>.delayed(Duration.zero);
      expect(lease.channel.candles, hasLength(1));
      expect(CheLiveStatus.fromFeed(lease.channel.current, hasCandles: true, now: now).word, 'LIVE');

      await live.disconnect();
      expect(CheLiveStatus.fromFeed(lease.channel.current, hasCandles: true, now: now).word, 'DISCONNECTED');
      final second = _Feed();
      live.attach(second, symbol: 'MNQZ6', exchange: 'CME');
      expect(hub.subscriptionCount, 2);
      expect(lease.channel.candles, hasLength(1), reason: 'the last live candles stay while reconnecting');
      now = _open.add(const Duration(seconds: 70));
      second.trade(21002, now);
      await Future<void>.delayed(Duration.zero);
      expect(lease.channel.candles.map((c) => c.start).toSet(), hasLength(lease.channel.candles.length), reason: 'no duplicate candles');
      lease.release();
      expect(hub.subscriptionCount, 0);
    });
  });

  group('card', () {
    testWidgets('opens on the live feed and says what it is in words', (tester) async {
      var now = _open;
      final live = CheRithmicLive(clock: () => now);
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: live, clock: () => now), throttle: Duration.zero);
      final rithmic = _Feed();
      live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');
      await tester.pumpWidget(_app(CheLiveChartCard(hub: hub, now: () => now)));
      expect(find.text('CONNECTING'), findsOneWidget);
      await tester.runAsync(() async {
        rithmic.trade(21000.25, now.add(const Duration(seconds: 1)));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pump();
      expect(find.text('LIVE'), findsOneWidget);
      expect(find.text('MNQZ6 · RITHMIC'), findsOneWidget);
      expect(find.textContaining('MCP'), findsNothing, reason: 'there is no MCP source; never claim one');
      await tester.pumpWidget(const SizedBox());
      now = now.add(const Duration(hours: 1)); // the test clock moves on, so the feed's candle-close timers finish
      await tester.pump(const Duration(minutes: 10));
    });

    testWidgets('disconnected: the reason, Connect, and delayed only on request, labelled DELAYED', (tester) async {
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: CheRithmicLive()), throttle: Duration.zero);
      var connects = 0;
      await tester.pumpWidget(_app(CheLiveChartCard(
        hub: hub,
        now: () => _open,
        onConnect: () => connects++,
        delayedBuilder: (_) => const Text('delayed view'),
      )));
      expect(find.text('DISCONNECTED'), findsOneWidget);
      expect(find.text('Rithmic not connected'), findsOneWidget);
      expect(find.text('delayed view'), findsNothing, reason: 'never delayed on its own');
      await tester.tap(find.text('Connect'));
      expect(connects, 1);
      await tester.tap(find.text('Delayed'));
      await tester.pump();
      expect(find.text('delayed view'), findsOneWidget);
      expect(find.text('DELAYED'), findsOneWidget);
      expect(find.text('MNQ · DELAYED'), findsOneWidget, reason: 'the header names it delayed too');
      expect(find.text('LIVE'), findsNothing);
      await tester.tap(find.text('Back to live'));
      await tester.pump();
      expect(find.text('DISCONNECTED'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('live ticks keep the size, the zoom and a scrolled-back view', (tester) async {
      var now = _open;
      final live = CheRithmicLive(clock: () => now);
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: live, clock: () => now, closeGrace: Duration.zero), throttle: Duration.zero);
      final rithmic = _Feed();
      live.attach(rithmic, symbol: 'MNQZ6', exchange: 'CME');
      Future<void> trade(double p, int minute) async {
        now = _open.add(Duration(minutes: minute, seconds: 1));
        await tester.runAsync(() async {
          rithmic.trade(p, now);
          await Future<void>.delayed(Duration.zero);
        });
        await tester.pump();
      }

      for (var i = 0; i < 30; i++) {
        await trade(21000 + i.toDouble(), i);
      }
      await tester.pumpWidget(_app(CheLiveChartCard(hub: hub, now: () => now)));
      final card = find.byType(CheLiveChartCard);
      final state = tester.state<CheLiveChartCardState>(card);
      final size = tester.getSize(card);
      state.zoom(1.5);
      state.panFromRight = 3;
      final visible = state.visible;
      await trade(22000.75, 31);
      await trade(9.5, 32);
      expect(tester.getSize(card), size, reason: 'a longer or shorter price never resizes the card');
      expect(state.visible, visible, reason: 'zoom kept');
      expect(state.panFromRight, 5, reason: 'the same candles stay in view');
      await tester.pumpWidget(const SizedBox());
      now = now.add(const Duration(hours: 1)); // the test clock moves on, so the feed's candle-close timers finish
      await tester.pump(const Duration(minutes: 10));
    });

    testWidgets('the timeframe is remembered; the source never is', (tester) async {
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: CheRithmicLive()), throttle: Duration.zero);
      await tester.pumpWidget(_app(CheLiveChartCard(hub: hub, now: () => _open)));
      await tester.tap(find.byKey(const ValueKey('che-live-tf-5')));
      await tester.pump();
      expect(hub.activeRefs, {5: 1}, reason: 'the 1-minute channel was released');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt(kLiveChartMinutesPref), 5);
      expect(prefs.getKeys().where((k) => k.contains('source') || k.contains('delayed')), isEmpty);
      await tester.pumpWidget(const SizedBox());
      expect(hub.activeRefs, isEmpty, reason: 'a disposed card releases its channel');
    });

    testWidgets('reduced motion: the dot stays still', (tester) async {
      var now = _open;
      final live = CheRithmicLive(clock: () => now);
      final hub = CheLiveFeedHub(feed: CheMarketFeed(live: live, clock: () => now), throttle: Duration.zero);
      live.attach(_Feed(), symbol: 'MNQZ6', exchange: 'CME');
      await tester.pumpWidget(_app(CheLiveChartCard(hub: hub, now: () => now), reduceMotion: true));
      expect(find.text('CONNECTING'), findsOneWidget);
      expect(tester.hasRunningAnimations, isFalse);
      await tester.pumpWidget(const SizedBox());
    });

    for (final size in const [Size(375, 667), Size(393, 852), Size(430, 932), Size(820, 1180), Size(1440, 900), Size(852, 393)]) {
      testWidgets('fits ${size.width.toInt()}×${size.height.toInt()} without overflow', (tester) async {
        tester.view.physicalSize = size * 3;
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final hub = CheLiveFeedHub(feed: CheMarketFeed(live: CheRithmicLive()), throttle: Duration.zero);
        await tester.pumpWidget(_app(CheLiveChartCard(hub: hub, now: () => _open, onConnect: () {}, delayedBuilder: (_) => const SizedBox())));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    }
  });
}
