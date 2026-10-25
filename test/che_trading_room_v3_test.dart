// Trading Room v3 regressions (owner, 2026-10-25: "fix, simplify and verify"). Each test reproduces a failure the
// owner recorded, first failing on the old code.
import 'dart:async';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/rooms/che_trading_connections.dart';
import 'package:chey/rooms/che_trading_dashboard.dart';
import 'package:chey/rooms/che_trading_hud.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_account_stats.dart';
import 'package:chey/trading/che_crypto_desk.dart';
import 'package:chey/trading/che_live_status.dart';
import 'package:chey/trading/che_market_feed.dart';
import 'package:chey/trading/che_paper_account.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:chey/trading/che_trading_calendar.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'trading_room_v3_fixture.dart';

Future<void> pumpRoom(WidgetTester tester, {http.Client? client, CheTradingSection section = CheTradingSection.chart}) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  ChePaperEngine.sharedForTest = ChePaperEngine.load(ChePaperMemoryStore(), clock: () => kFixtureNow);
  addTearDown(() => ChePaperEngine.sharedForTest = null);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      body: CheTradingRoom(
        baseUrl: () => 'https://che.test',
        headers: () => const {},
        onAsk: (_) {},
        onRead: (_) {},
        client: client ?? fixtureWorker(),
        initialSection: section,
        setupDesk: CheSetupDesk(),
      ),
    ),
  ));
  await settle(tester);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
  }
}

/// No widget in the tree threw while building: a release build paints a thrown build as a flat gray box.
void expectNoGrayBox(WidgetTester tester) {
  expect(tester.takeException(), isNull);
  expect(find.byType(ErrorWidget), findsNothing);
}

void main() {
  // Owner recording 2026-10-25 06:16: a flat gray box under "CHE positions" and under the crypto desk's
  // "R per trade" line. Both sit right above an ExpansionTile. The room's ListView carried the app's only
  // PageStorageKey, so its saved scroll offset (a double) and every ExpansionTile inside it (which restores a bool)
  // shared one storage slot: after the owner scrolled, the tile's `as bool?` threw and release builds painted gray.
  testWidgets('scrolling the room, then opening the crypto desk and the journal, builds without a gray box', (tester) async {
    await pumpRoom(tester, client: fixtureWorker(overrides: {'/api/trading/crypto': fixtureCryptoOwner()}));
    await tester.drag(find.byType(ListView).first, const Offset(0, -400));
    await settle(tester);
    CheTradingRoom.requestedSection.value = CheTradingSection.crypto; // the voice route; the nav row is scrolled away
    await settle(tester);
    expectNoGrayBox(tester);
    expect(find.textContaining('Recent simulated trades'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, -300));
    await settle(tester);
    CheTradingRoom.requestedSection.value = CheTradingSection.cheTrades;
    await settle(tester);
    expectNoGrayBox(tester);
    expect(find.byKey(const Key('paper_journal')), findsOneWidget);
  });

  // Owner recording: "Open 16" on the crypto desk beside "No open CHE paper positions", and "-6.5935 R per trade".
  // Two different accounts, now named; R to two decimals with the reason it is so negative (fees vs a 5-minute stop:
  // the math in trading_evidence.settleTrade is right, 1 R being the stop distance before costs).
  testWidgets('the crypto desk names its account and shows R to two decimals with the fee explanation', (tester) async {
    await pumpRoom(tester, section: CheTradingSection.crypto, client: fixtureWorker(overrides: {'/api/trading/crypto': fixtureCryptoOwner()}));
    expectNoGrayBox(tester);
    expect(find.text('ORION CRYPTO PAPER · WORKER'), findsOneWidget);
    expect(find.text('−6.59 R per trade'), findsOneWidget);
    expect(find.textContaining('6.5935'), findsNothing);
    expect(find.byKey(const Key('crypto_r_note')), findsOneWidget);
    expect(cheCryptoR(-6.5935), '−6.59 R');
    expect(cheCryptoR(0.4, spoken: true), 'plus 0.40 R');
    expect(cheCryptoRNote(-0.5), isEmpty);
  });

  testWidgets('the CHE paper account says which account has no open positions', (tester) async {
    await pumpRoom(tester, section: CheTradingSection.cheTrades);
    expectNoGrayBox(tester);
    expect(find.textContaining('No open positions in the CHE PAPER ACCOUNT (MNQ on this iPhone)'), findsOneWidget);
  });

  group('account dashboard', () {
    Future<void> pumpDash(WidgetTester tester, {bool empty = false, ChePaperEngine? engine, http.Client? client}) async {
      await tester.binding.setSurfaceSize(const Size(440, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final e = engine ?? await ChePaperEngine.load(ChePaperMemoryStore(), clock: () => kFixtureNow);
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: CheTradingDashboard(baseUrl: () => 'https://che.test', headers: () => const {}, client: client ?? fixtureWorker(empty: empty), engine: e, onRead: (_) {}),
          ),
        ),
      ));
      await settle(tester);
    }

    // Owner recording: "P&L +$0.00" and dashes for win rate, open and drawdown from the research overview's `live`
    // block (today's paper only, open always null). Before the fix the room showed that row; now an empty account
    // says "No recorded trades" and never a bare 0 or a dash.
    testWidgets('stats from an empty journal show "No recorded trades", not 0 or a dash', (tester) async {
      await pumpDash(tester, empty: true);
      expectNoGrayBox(tester);
      expect(find.text('No recorded trades'), findsNWidgets(3));
      expect(find.text('+\$0.00'), findsNothing);
      expect(find.text('—'), findsNothing);
      expect(find.byKey(const Key('dash_no_trades')), findsOneWidget);
    });

    testWidgets('the selected account\'s stats; futures, crypto and simulation never mixed', (tester) async {
      await pumpDash(tester);
      // The first account with trades: forward paper futures (the iPhone CHE paper account has none).
      expect(CheTradingDashboard.latest.value!.source, CheAccountSource.forwardPaperFutures);
      // Futures only: +31.50 − 22.00 + 18.00 = +27.50; 2 wins, 1 loss; drawdown 22.00; open 1.
      expect(find.text('+\$27.50'), findsOneWidget);
      expect(find.text('67% · 2W 1L'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Max drawdown: −\$22\.00\.')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Open positions: 1\.')), findsOneWidget);
      expect(find.textContaining('ETH'), findsNothing, reason: 'no crypto record in the futures account');
      await tester.ensureVisible(find.byKey(const Key('dash_account_forwardPaperCrypto')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('dash_account_forwardPaperCrypto')));
      await settle(tester);
      // Crypto only: −4.10 + 6.30 = +2.20; 16 open (the Orion desk's own count).
      expect(find.text('+\$2.20'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Open positions: 16\.')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('dash_account_simulation')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('dash_account_simulation')));
      await settle(tester);
      expect(find.text('+1.00 R'), findsOneWidget, reason: 'the simulation is in R, never dollars');
      expectNoGrayBox(tester);
    });

    testWidgets('each stat explains itself on tap, and the voice route reads the same words', (tester) async {
      await pumpDash(tester);
      await tester.tap(find.byKey(const Key('dash_stat_winRate')));
      await tester.pump();
      expect(find.byKey(const Key('dash_explain')), findsOneWidget);
      expect(find.textContaining('2 wins divided by 3 closed trades'), findsOneWidget);
      final s = CheTradingDashboard.latest.value!;
      expect(cheStatExplain(s, CheStat.drawdown), contains('largest fall from a peak'));
      // Every button-like control in the dashboard carries a VoiceOver label.
      final handle = tester.ensureSemantics();
      for (final stat in CheStat.values) {
        expect(find.bySemanticsLabel(RegExp('^${RegExp.escape(cheStatTitle(stat))}: ')), findsOneWidget);
      }
      handle.dispose();
    });

    testWidgets('a backtest row from the Worker would never be counted (refused by the one stats function)', (tester) async {
      expect(() => cheComputeAccountStats(CheAccountSource.forwardPaperFutures, [CheStatTrade(id: 'bt', instrument: 'MNQ', market: 'futures', value: 999, exitAt: kFixtureNow, kind: 'historical_backtest')]), throwsArgumentError);
    });

    testWidgets('the CHE paper figures update the moment a trade closes', (tester) async {
      final e = await ChePaperEngine.load(ChePaperMemoryStore(), clock: () => kFixtureNow);
      e.setLimits(const ChePaperRiskLimits(maxRiskPerTradePct: 25, maxOpenRiskPct: 50, maxDailyLossPct: 50), confirmed: true);
      await pumpDash(tester, engine: e, client: fixtureWorker(empty: true));
      await tester.ensureVisible(find.byKey(const Key('dash_account_chePaper')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('dash_account_chePaper')));
      await settle(tester);
      expect(find.text('No recorded trades'), findsNWidgets(3));
      final t0 = kFixtureNow;
      ChePriceTick tick(double price, int sec) => ChePriceTick(symbol: 'MNQZ6', price: price, time: t0.add(Duration(seconds: sec)), source: 'rithmic');
      final d = e.onSignal(ChePaperSignal(id: 's1', symbol: 'MNQZ6', side: CheSide.long, entry: 21000, stop: 20995, target: 21010, strategy: 'EMA 20 pullback', timeframe: '5m', stage: 'ready', detectedAt: t0, dataSource: 'rithmic'));
      expect(d.accepted, isTrue, reason: d.reason);
      e.onTick(tick(21000.5, 1));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp(r'^Open positions: 1\.')), findsOneWidget, reason: 'an opened trade counts at once');
      e.onTick(tick(21010.25, 3));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp(r'^Open positions: 0\.')), findsOneWidget);
      expect(find.textContaining('100% · 1W 0L'), findsOneWidget, reason: 'the closed trade is in the win rate without a refresh');
      expect(find.text('No recorded trades'), findsNothing);
    });
  });

  group('unified calendar', () {
    testWidgets('ALL | FUTURES | CRYPTO over the same dates; each kind kept apart; a date opens its records', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final seen = <Uri>[];
      final routes = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark(),
        navigatorObservers: [_Routes(routes)],
        home: Scaffold(body: SingleChildScrollView(child: CheUnifiedCalendar(baseUrl: () => 'https://che.test', headers: () => const {}, client: fixtureWorker(seen: seen)))),
      ));
      await settle(tester);
      expectNoGrayBox(tester);
      expect(seen.last.queryParameters, containsPair('view', 'unified'));
      expect(find.textContaining('New York time'), findsWidgets);
      expect(find.textContaining('Forward paper: 5 trades, 3W 2L, +\$29.70'), findsOneWidget);
      expect(find.textContaining('Simulation: 2 trades, 1W 1L, +1.00R'), findsOneWidget);
      // Oct 22 holds the overnight MNQ trade (CME trading date), BTC, the ETH trade that closed 11:30 PM New York, and
      // the simulation's trades.
      expect(find.bySemanticsLabel(RegExp(r'October 22.*Instruments BTC, ETH, MNQ\.')), findsOneWidget);
      final allDates = [for (final e in tester.widgetList<InkWell>(find.byWidgetPredicate((w) => w is InkWell && '${w.key}'.contains('calendar_day_')))) '${e.key}'];
      await tester.tap(find.byKey(const Key('unified_market_crypto')));
      await settle(tester);
      expect(seen.last.queryParameters, containsPair('market', 'crypto'));
      expect(find.textContaining('Instruments: BTC, ETH.'), findsOneWidget);
      final cryptoDates = [for (final e in tester.widgetList<InkWell>(find.byWidgetPredicate((w) => w is InkWell && '${w.key}'.contains('calendar_day_')))) '${e.key}'];
      expect(cryptoDates, allDates, reason: 'the same dates under every filter');
      await tester.tap(find.byKey(const Key('unified_market_all')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('calendar_day_2026-10-22')));
      await settle(tester);
      expect(routes.last, 'trading_day/2026-10-22');
      expect(find.byKey(const Key('unified_trade_T0FUT000000003')), findsOneWidget);
      expect(find.textContaining('MNQ · CHE FORWARD PAPER'), findsWidgets);
      expect(find.textContaining('CME trading date'), findsWidgets);
      await tester.tap(find.byKey(const Key('unified_trade_T0FUT000000003')));
      await tester.pump();
      expect(routes.last, 'trade_replay/T0FUT000000003');
    });

    test('day totals equal the sum of that day\'s trades in the fixture the screen reads', () {
      final month = fixtureUnified();
      for (final w in (month['weeks'] as List)) {
        for (final d in ((w as Map)['days'] as List)) {
          final day = fixtureUnified(day: '${(d as Map)['date']}');
          final trades = (day['trades'] as List).cast<Map>();
          expect(d['trades'], trades.length);
          final paper = trades.where((t) => t['kind'] == 'forward_paper').fold<num>(0, (a, t) => a + (t['net'] as num));
          final kinds = (d['kinds'] as Map);
          if (kinds['forward_paper'] != null) expect((kinds['forward_paper'] as Map)['net'], closeTo(paper, 0.001));
        }
      }
    });
  });

  group('first-screen layout', () {
    testWidgets('chart → account stats → calendar → strategy slot → folded research, replay and advanced controls', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 4000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await pumpRoom(tester);
      await tester.binding.setSurfaceSize(const Size(440, 4000));
      await settle(tester);
      double y(Key k) => tester.getTopLeft(find.byKey(k)).dy;
      final chart = tester.getTopLeft(find.byKey(const Key('chart_area'))).dy;
      expect(chart, lessThan(y(const Key('trading_dashboard'))));
      expect(y(const Key('trading_dashboard')), lessThan(y(const Key('card_calendar'))));
      expect(y(const Key('card_calendar')), lessThan(y(const Key('strategy_matrix_slot'))));
      expect(y(const Key('strategy_matrix_slot')), lessThan(y(const Key('fold_research'))));
      expect(y(const Key('fold_research')), lessThan(y(const Key('fold_replay'))));
      expect(y(const Key('fold_replay')), lessThan(y(const Key('fold_advanced'))));
      // Collapsed by default, each with a VoiceOver label.
      for (final f in ['RESEARCH & BACKTESTING', 'REPLAY', 'ADVANCED CONTROLS']) {
        expect(find.bySemanticsLabel(RegExp('^${RegExp.escape(f)}\\. .*\\. Expand\\.\$')), findsOneWidget);
      }
      expect(find.byKey(const Key('trading_status_row')), findsNothing, reason: 'the research overview row is not account stats');
      expectNoGrayBox(tester);
    });

    testWidgets('"open advanced controls" opens that fold by voice', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 4000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await pumpRoom(tester);
      await tester.binding.setSurfaceSize(const Size(440, 4000));
      await settle(tester);
      expect(find.bySemanticsLabel(RegExp(r'^ADVANCED CONTROLS\. .*Expand\.$')), findsOneWidget);
      CheTradingFold.requested.value = 'advanced';
      await settle(tester);
      expect(find.bySemanticsLabel(RegExp(r'^ADVANCED CONTROLS\. .*Collapse\.$')), findsOneWidget);
      expect(CheTradingFold.requested.value, isNull);
    });

    testWidgets('no gray placeholder in the tree and every button has a VoiceOver label, realistic and empty', (tester) async {
      for (final empty in [false, true]) {
        for (final section in CheTradingSection.values) {
          await pumpRoom(tester, client: fixtureWorker(empty: empty), section: section);
          expectNoGrayBox(tester);
          final handle = tester.ensureSemantics();
          expect(tester, meetsGuideline(labeledTapTargetGuideline), reason: '$section empty=$empty');
          handle.dispose();
          await tester.pumpWidget(const SizedBox());
        }
      }
    });
  });

  group('market data status', () {
    // Thursday Oct 22 2026, 10:00 AM New York (open); Saturday Oct 24, noon (closed).
    final open = DateTime.utc(2026, 10, 22, 14);
    final closed = DateTime.utc(2026, 10, 24, 16);

    test('Rithmic authenticated but with no data is never LIVE, and says why', () async {
      var now = open;
      final live = CheRithmicLive(clock: () => now);
      final feed = _Feed();
      live.attach(feed, symbol: 'MNQZ6', exchange: 'CME');
      final rows = Map.fromEntries(cheRithmicChecklist(live, now).map((r) => MapEntry(r.$1, r.$2)));
      expect(rows['Session'], 'Signed in · MNQZ6');
      expect(rows['Market-data subscription'], 'Requested, not confirmed yet');
      expect(rows['First trade received'], 'None yet');
      expect(rows['Freshness'], 'WAITING · no market data received yet');
      expect(rows.containsKey('Error'), isFalse, reason: 'error text only when an actual error exists');
      expect(live.isLive, isFalse);
      final s = CheLiveStatus.fromFeed(CheMarketFeed(live: live, clock: () => now).current, hasCandles: false, now: now);
      expect(s.word, 'WAITING');
      expect(s.kind, CheFeedKind.waiting);
      expect(s.detail, 'Signed in to Rithmic — no market data received yet. Market-data subscription not confirmed yet.');
      expect(s.detail.toLowerCase(), isNot(contains('connected')));
      // Closed market: the reason is the CME schedule.
      now = closed;
      final c = CheLiveStatus.fromFeed(CheMarketFeed(live: live, clock: () => now).current, hasCandles: false, now: now);
      expect(c.detail, endsWith('CME is closed until Sunday 6:00 PM ET.'));
      expect(Map.fromEntries(cheRithmicChecklist(live, now).map((r) => MapEntry(r.$1, r.$2)))['Freshness'], 'WAITING · no market data received yet; CME is closed until Sunday 6:00 PM ET');
      // The first received trade makes it LIVE, and records when it arrived.
      now = open;
      feed.confirmed = true;
      feed.trade(21000.25, now);
      await Future<void>.delayed(Duration.zero);
      final after = Map.fromEntries(cheRithmicChecklist(live, now).map((r) => MapEntry(r.$1, r.$2)));
      expect(after['Market-data subscription'], 'Confirmed by Rithmic');
      expect(after['Instrument entitlement'], 'Permitted (MNQZ6)');
      expect(after['First trade received'], startsWith('10:00 AM ET'));
      expect(after['Freshness'], startsWith('LIVE'));
      // Five quiet minutes while the market is open: STALE with its age.
      now = open.add(const Duration(minutes: 5));
      final stale = CheLiveStatus.fromFeed(CheMarketFeed(live: live, clock: () => now).current, hasCandles: true, now: now);
      expect(stale.word, 'STALE');
      expect(stale.detail, 'No trade for 5 min · last trade 10:00 AM ET');
    });

    test('a refused login shows the actual error; the shared model maps every state to five words', () {
      final live = CheRithmicLive();
      live.loginFailed('Rithmic refused the market data permission for MNQZ6 (rp 13).');
      final rows = Map.fromEntries(cheRithmicChecklist(live, open).map((r) => MapEntry(r.$1, r.$2)));
      expect(rows['Session'], 'Not signed in (login refused)');
      expect(rows['Error'], contains('market data permission'));
      expect(rows['Instrument entitlement'], startsWith('Not permitted'));
      CheMarketSnapshot snap(CheFeedConnection c) => CheMarketSnapshot(symbol: 'MNQZ6', exchange: 'CME', source: 'rithmic', sourceLabel: '', connection: c,
          statusLabel: '', isLive: c == CheFeedConnection.connected, lastPrice: null, lastTradeAt: open, lastUpdate: open);
      final words = {
        for (final c in CheFeedConnection.values)
          for (final at in [open, closed]) CheLiveStatus.fromFeed(snap(c), hasCandles: false, now: at).word,
      };
      expect(words.difference({'LIVE', 'DELAYED', 'WAITING', 'STALE', 'DISCONNECTED'}), isEmpty);
      expect(CheLiveStatus.delayed(symbol: 'MNQ').kind, CheFeedKind.delayed);
    });

    testWidgets('the feeds card shows Coinbase as public market data with no trading account', (tester) async {
      await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: Scaffold(body: SingleChildScrollView(child: CheMarketDataFeedsCard(live: CheRithmicLive(), now: () => open)))));
      expectNoGrayBox(tester);
      expect(find.textContaining('Public market data — no trading account'), findsWidgets);
      expect(find.bySemanticsLabel(RegExp(r'^Account: None — public market data needs no login$')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Freshness: DISCONNECTED$')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Error: ')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });
}

class _Feed implements RithmicMarketFeed {
  bool confirmed = false;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => const Stream.empty();
  @override
  bool get subscriptionConfirmed => confirmed;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {}
  @override
  Future<void> close() async {}
  void trade(double price, DateTime at) => _trades.add(RithmicLastTrade(
      symbol: 'MNQZ6', exchange: 'CME', price: price, size: 1, ssboe: at.millisecondsSinceEpoch ~/ 1000, usecs: (at.millisecondsSinceEpoch % 1000) * 1000));
}

class _Routes extends NavigatorObserver {
  _Routes(this.names);
  final List<String> names;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (route.settings.name != null) names.add(route.settings.name!);
  }
}