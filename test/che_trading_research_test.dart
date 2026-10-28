// Trading page consolidation (owner, 2026-10-22): live market first, BEST NOW, per-timeframe evidence
// cards, the strategy drill-down, the Strategy Matrix and the research dashboard. Every number comes from
// the research API; none is computed or invented on the phone.
import 'dart:convert';

import 'package:chey/rooms/che_trading_chart.dart';
import 'package:chey/rooms/che_trading_research.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

// Shapes follow docs/CHE_TRADING_RESEARCH_API.md (claude/che-trading-research).
Map<String, dynamic> _overview(String market, {bool best = true, bool learning = false, String profile = 'NORMAL'}) => {
      'markets': ['MNQ', 'NQ'],
      'live': {
        'symbol': market, 'price': 21034.25, 'stale': false, 'mode': 'PAPER', 'data_source': 'Yahoo NQ=F (delayed)', 'pnl_today': 42.5,
        'win_rate': 0.55, 'open_positions': 1, 'regime': {'label': 'Trending bullish · normal volatility'},
      },
      'best_now': best
          ? [
              {'strategy_id': 'ema-pullback', 'name': 'EMA Pullback', 'market': market, 'timeframe': '5m', 'session': 'ny_morning', 'regime': 'trend_up', 'evidence_score': 84, 'expectancy_r': 0.31, 'sample': 143, 'confidence': 'moderate'},
              {'strategy_id': 'orb-15', 'name': '15-minute Opening Range Breakout', 'timeframe': '15m', 'session': 'ny_open', 'evidence_score': 61, 'sample': 61},
            ]
          : [],
      'best_now_reason': best ? null : 'No strategy currently meets your threshold. Every candidate has fewer than 30 trades on this timeframe.',
      'strategies': [
        {'strategy_id': 'ema-pullback', 'name': 'EMA Pullback', 'defined': true, 'best_timeframe': '5m', 'best_trades': 143, 'qualified_buckets': 4, 'expectancy_r': 0.38, 'win_rate': 0.55, 'status': 'ACTIVE', 'readiness': 'OOS VERIFIED'},
        {'strategy_id': 'orb-15', 'name': '15-minute Opening Range Breakout', 'defined': true, 'best_timeframe': '15m', 'qualified_buckets': 1, 'expectancy_r': -0.04, 'win_rate': 0.47, 'status': 'MONITOR', 'readiness': '30+ SAMPLE'},
        {'strategy_id': 'liq-sweep', 'name': 'Liquidity Sweep + Reclaim', 'defined': true, 'best_timeframe': '', 'qualified_buckets': 0, 'expectancy_r': null, 'win_rate': null, 'status': 'ACTIVE', 'readiness': 'LEARNING'},
        {'strategy_id': 'dirty-trez', 'name': 'Dirty Trez', 'defined': false, 'status': 'UNDEFINED'},
        // The same strategy twice in one answer still shows one card.
        {'strategy_id': 'ema-pullback', 'name': 'EMA Pullback', 'defined': true, 'best_timeframe': '5m', 'best_trades': 143, 'qualified_buckets': 4, 'expectancy_r': 0.38, 'win_rate': 0.55, 'status': 'ACTIVE', 'readiness': 'OOS VERIFIED'},
      ],
      'dashboard': {
        'strategies_tested': 7,
        'buckets_qualified': 46,
        'backtest_trades': 2418,
        'forward_paper_trades': 312,
        'coverage': [
          {'market': market, 'resolution': '1D', 'years': 7.4, 'first': '2019-05-06', 'last': '2026-10-22', 'provider': 'Yahoo MNQ=F', 'proxy': false},
          {'market': 'NQ', 'resolution': '1D', 'years': 20, 'first': '2006-10-23', 'last': '2026-10-22', 'provider': 'Stooq nq.f', 'proxy': false},
        ],
      },
      'jobs': [
        {'id': 'job1', 'name': 'NQ historical · EMA · 30m', 'status': 'running', 'progress': 0.4, 'completed': ['a', 'b', 'c', 'd'], 'remaining': ['e', 'f', 'g', 'h', 'i', 'j'], 'errors': []},
      ],
      'profile': profile,
      'paper_learning': {'enabled': learning},
    };

Map<String, dynamic> _strategy() => {
      'strategy': {'strategy_id': 'ema-pullback', 'version': 1, 'name': 'EMA Pullback', 'defined': true, 'look_ahead_audit': 'passed', 'readiness': 'OOS VERIFIED'},
      'overview': {'best_timeframe': '5m', 'best_session': 'ny_morning', 'best_regime': 'trend_up', 'historical_expectancy_r': 0.31, 'recent_expectancy_r': -0.05, 'paper': {'trades': 87, 'expectancy_r': 0.18, 'win_rate': 0.52}},
      'timeframes': [
        {'tf': '15s', 'trades': 29, 'min_required': 30, 'evidence': 'NOT READY', 'available': true},
        {'tf': '1m', 'trades': 217, 'min_required': 30, 'win_rate': 0.48, 'avg_r': 0.11, 'pf': 1.12, 'max_dd_r': -9.4, 'evidence': 'MONITOR', 'available': true},
        {'tf': '5m', 'trades': 143, 'min_required': 30, 'win_rate': 0.55, 'avg_r': 0.38, 'pf': 1.46, 'max_dd_r': -6.2, 'evidence': 'QUALIFIED', 'available': true},
        {'tf': '4h', 'trades': 18, 'min_required': 30, 'evidence': 'NOT READY', 'available': true},
        {'tf': '1W', 'trades': 0, 'min_required': 30, 'evidence': 'NO DATA', 'available': false, 'why': 'weekly history not cached yet'},
      ],
      'sessions': [
        {'session': 'ny_morning', 'trades': 53, 'expectancy_r': 0.42, 'win_rate': 0.58},
        {'session': 'overnight', 'trades': 61, 'expectancy_r': -0.08, 'win_rate': 0.44},
      ],
      'regimes': [{'regime': 'trend_up', 'trades': 40, 'expectancy_r': 0.35}],
      'periods': [
        {'window': 'max', 'available': true, 'years_available': 7.4, 'trades': 400, 'expectancy_r': 0.2},
        {'window': '20Y', 'available': false, 'years_available': 7.4},
        {'window': '5Y', 'available': true, 'trades': 120, 'expectancy_r': 0.29},
        {'window': '90D', 'available': true, 'trades': 14, 'expectancy_r': -0.05},
      ],
      'decay': 'WEAKENING',
      'receipts': [{'id': 'r1', 'timeframe': '5m', 'provider': 'Yahoo MNQ=F', 'data_hash': 'abc', 'cost_model': 'NORMAL', 'look_ahead': 'passed'}],
    };

Map<String, dynamic> _matrix() => {
      'timeframes': ['15s', '1m', '5m', '4h', '1W'],
      'rows': [
        {
          'strategy_id': 'ema-pullback',
          'name': 'EMA Pullback',
          'cells': {
            '15s': {'state': 'Learning', 'trades': 29},
            '1m': {'state': 'Fair', 'trades': 217, 'expectancy_r': 0.11},
            '5m': {'state': 'Strong', 'trades': 143, 'expectancy_r': 0.38},
            '1W': {'state': 'No data', 'trades': 0},
          },
        },
      ],
    };

class _Api {
  final requests = <http.Request>[];
  bool learning = false;
  String profile = 'NORMAL';
  bool best = true;
  bool fail = false;
  bool failNq = false;

  late final client = MockClient((r) async {
    requests.add(r);
    final p = r.url.path;
    if (p == '/api/trading/research' && failNq && r.url.queryParameters['market'] == 'NQ') return _json({'detail': 'NQ history not cached yet'}, 503);
    if (p == '/api/trading/research') return _json(_overview(r.url.queryParameters['market'] ?? 'MNQ', best: best, learning: learning, profile: profile));
    if (p == '/api/trading/research/strategy') return _json(_strategy());
    if (p == '/api/trading/research/matrix') return _json(_matrix());
    if (p == '/api/trading/research/paper_learning') {
      if (fail) return _json({'detail': 'No futures feed is connected'}, 409);
      learning = (jsonDecode(r.body) as Map)['enabled'] == true;
      return _json({'ok': true, 'spoken': 'Paper learning is ${learning ? 'on' : 'off'} for MNQ. PAPER only.', 'view': _overview('MNQ', learning: learning, profile: profile)});
    }
    if (p == '/api/trading/research/profile') {
      profile = '${(jsonDecode(r.body) as Map)['profile']}';
      return _json({'ok': true});
    }
    if (p == '/api/trading/chart') {
      final start = DateTime.utc(2026, 10, 22, 14);
      return _json({
        'ok': true,
        'account': r.url.queryParameters['account'],
        'symbol': r.url.queryParameters['symbol'] ?? 'MNQ',
        'timeframe': r.url.queryParameters['tf'] ?? '5m',
        'timeframes': ['1m', '5m', '15m', '1h', '1d'],
        'bars': [
          for (var i = 0; i < 20; i++) {'t': start.add(Duration(minutes: 5 * i)).toIso8601String(), 'o': 100.0 + i, 'h': 102.0 + i, 'l': 99.0 + i, 'c': 101.0 + i},
        ],
        'feed': {'provider': 'Yahoo', 'status': 'DELAYED', 'age_s': 60, 'stale': false},
        'markers': const [],
      });
    }
    return _json({'ok': true});
  });

  Iterable<http.Request> at(String path) => requests.where((r) => r.url.path == path);
}

Future<void> _pump(WidgetTester tester, _Api api, {Size size = const Size(390, 844), double textScale = 1, CheTradingSection section = CheTradingSection.chart, List<String>? read}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: MediaQuery(
      data: MediaQueryData(size: size, textScaler: TextScaler.linear(textScale)),
      child: Scaffold(
        body: CheTradingRoom(
          baseUrl: () => 'https://che.test',
          headers: () => const {},
          onAsk: (_) {},
          onRead: read?.add,
          client: api.client,
          initialSection: section,
          initialAccount: 'futures_paper',
          initialSymbol: 'MNQ',
        ),
      ),
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _scrollTo(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 30 && f.evaluate().isEmpty; i++) {
    await tester.drag(find.byType(ListView).first, const Offset(0, -300));
    await tester.pump();
  }
  await tester.ensureVisible(f.first);
  await tester.pump();
}

void main() {
  testWidgets('the live market comes first: NQ | MNQ above the chart, then status, BEST NOW and one card per strategy', (tester) async {
    final api = _Api();
    final read = <String>[];
    await _pump(tester, api, read: read);
    final liveY = tester.getTopLeft(find.text('LIVE MARKET')).dy;
    final chartY = tester.getTopLeft(find.byType(CheTradingChart)).dy;
    expect(liveY, lessThan(chartY), reason: 'the live market toggle leads the page');
    await _scrollTo(tester, find.byKey(const Key('best_now'), skipOffstage: false));
    final chartNow = find.byType(CheTradingChart, skipOffstage: false);
    if (chartNow.evaluate().isNotEmpty) {
      expect(tester.getTopLeft(chartNow).dy, lessThan(tester.getTopLeft(find.byKey(const Key('best_now'))).dy), reason: 'the chart is above the research');
    }
    expect(find.text('EMA Pullback'), findsWidgets);
    expect(find.text('5m · NY Morning · Trend up'), findsOneWidget);
    expect(find.text('Evidence 84/100 · 143 trades · +0.31R'), findsOneWidget);
    // One status row: P&L, win rate, open, drawdown (mode and data source live in the chart header, not repeated).
    expect(find.bySemanticsLabel(RegExp(r'^Win Rate: 55%$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^P&L: ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Open: ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Drawdown: ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Mode: ')), findsNothing);
    expect(read, isEmpty, reason: 'nothing is spoken on open');
    // One card per strategy even when the answer repeats one; the count is per timeframe, never global.
    await _scrollTo(tester, find.byKey(const Key('strategy_card_dirty-trez'), skipOffstage: false));
    expect(find.byKey(const Key('strategy_card_ema-pullback'), skipOffstage: false), findsOneWidget);
    expect(find.text('Rules not defined; not tested', skipOffstage: false), findsOneWidget);
    expect(find.text('Best 15m · 1 timeframe qualified', skipOffstage: false), findsOneWidget);
    expect(find.text('Best 5m · 143 trades', skipOffstage: false), findsOneWidget);
    expect(find.text('No qualified timeframe yet', skipOffstage: false), findsOneWidget);
    expect(find.textContaining('30 trades', skipOffstage: false), findsNothing);
    expect(
      find.bySemanticsLabel(RegExp(r'^EMA Pullback\. Best on 5 minute, 143 trades on that timeframe, plus 0\.38 R, 55% win rate\. Evidence oos verified\.')),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('NQ | MNQ switches the research market and the chart contract; the timeframe selector changes the chart', (tester) async {
    final api = _Api();
    await _pump(tester, api);
    expect(api.at('/api/trading/research').last.url.queryParameters['market'], 'MNQ');
    await tester.tap(find.byKey(const Key('market_NQ')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.at('/api/trading/research').last.url.queryParameters['market'], 'NQ');
    // NQ has its own chart now (owner, 2026-10-24): the Markets chart on NQ's delayed public data, never MNQ relabelled.
    final chartCalls = api.at('/api/trading/chart').toList();
    expect(chartCalls.last.url.queryParameters['account'], 'market');
    expect(chartCalls.last.url.queryParameters['symbol'], 'futures:NQ');
    expect(find.bySemanticsLabel('NQ market, selected'), findsOneWidget);
    // The compact chart offers 1m and 5m; every other timeframe is in the expanded chart.
    await tester.tap(find.text('1m').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.at('/api/trading/chart').last.url.queryParameters['tf'], '1m');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('no qualified strategy is said plainly, with the reason', (tester) async {
    final api = _Api()..best = false;
    await _pump(tester, api);
    await _scrollTo(tester, find.byKey(const Key('best_now'), skipOffstage: false));
    expect(find.text('No strategy currently meets your threshold. Every candidate has fewer than 30 trades on this timeframe.'), findsOneWidget);
    expect(find.byKey(const Key('best_now_open')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('strategy drill-down: per-timeframe "x / 30", no 20Y label without 20 years, decay, ladder, all readable', (tester) async {
    final api = _Api();
    final read = <String>[];
    await _pump(tester, api, read: read);
    await _scrollTo(tester, find.byKey(const Key('best_now_open'), skipOffstage: false));
    await tester.tap(find.byKey(const Key('best_now_open')));
    await tester.pumpAndSettle();
    expect(find.text('OVERVIEW · MNQ'), findsOneWidget);
    expect(find.bySemanticsLabel('Historical expectancy: +0.31R'), findsOneWidget);
    expect(find.bySemanticsLabel('Recent expectancy: −0.05R'), findsOneWidget);
    expect(find.bySemanticsLabel('Edge trend: WEAKENING'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Readiness ladder: .*Current: oos verified\.$')), findsOneWidget);
    // Every timeframe has its own count; below 30 it is NOT READY.
    await _scrollTo(tester, find.byKey(const Key('tf_row_15s'), skipOffstage: false));
    expect(find.text('29 / 30 trades · NOT READY'), findsOneWidget);
    await _scrollTo(tester, find.byKey(const Key('tf_row_4h'), skipOffstage: false));
    expect(find.text('18 / 30 trades · NOT READY'), findsOneWidget);
    expect(find.text('143 trades · QUALIFIED', skipOffstage: false), findsOneWidget);
    expect(find.text('0 / 30 trades · NOT READY', skipOffstage: false), findsWidgets, reason: 'timeframes with no trades yet say so');
    for (final (tf, said) in const [
      ('5m', 'EMA Pullback, 5 minute, qualified, 143 trades, plus 0.38 R, 55% win rate'),
      ('4h', 'EMA Pullback, 4 hour, not ready, 18 of 30 trades'),
      ('1W', 'EMA Pullback, weekly, no data available for this timeframe, weekly history not cached yet'),
    ]) {
      await tester.ensureVisible(find.byKey(Key('tf_row_$tf'), skipOffstage: false));
      await tester.pump();
      expect(find.bySemanticsLabel(said), findsOneWidget, reason: tf);
    }
    await _scrollTo(tester, find.text('HISTORY', skipOffstage: false));
    await tester.drag(find.byType(ListView).first, const Offset(0, -600));
    await tester.pump();
    expect(find.bySemanticsLabel('Maximum available: 7.4 years'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^20Y')), findsNothing, reason: 'no 20-year window without 20 years of data');
    expect(find.bySemanticsLabel('5Y: 120 trades · +0.29R'), findsOneWidget);
    expect(find.bySemanticsLabel('Overnight: 61 trades · −0.08R · 44% WR'), findsOneWidget);
    expect(find.bySemanticsLabel('Trend up: 40 trades · +0.35R'), findsOneWidget);
    await tester.tap(find.byTooltip('Read this strategy aloud'));
    expect(read.single, contains('Historical expectancy plus 0.31 R, recent minus 0.05 R'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Strategy Matrix: every cell reads its strategy, timeframe, state, trades and expectancy', (tester) async {
    final api = _Api();
    await _pump(tester, api);
    await _scrollTo(tester, find.byKey(const Key('open_matrix'), skipOffstage: false));
    await tester.tap(find.byKey(const Key('open_matrix')));
    await tester.pumpAndSettle();
    expect(find.text('Strategy Matrix · MNQ'), findsOneWidget);
    expect(find.bySemanticsLabel('EMA Pullback, 5 minute, Strong, 143 trades, plus 0.38 R'), findsOneWidget);
    expect(find.bySemanticsLabel('EMA Pullback, 15 second, learning, 29 of 30 trades'), findsOneWidget);
    expect(find.bySemanticsLabel('EMA Pullback, 4 hour, learning, 0 of 30 trades'), findsOneWidget);
    expect(find.bySemanticsLabel('EMA Pullback, weekly, no data'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('RESEARCH dashboard: real totals, coverage with real years, jobs, and controls that report their real result', (tester) async {
    final api = _Api();
    await _pump(tester, api, section: CheTradingSection.strategies);
    expect(find.byType(CheTradingChart), findsNothing, reason: 'the chart is not built off its section');
    expect(find.bySemanticsLabel(RegExp(r'^7 strategies tested\. 46 strategy and timeframe buckets qualified\. 2418 backtest trades\. 312 forward paper trades\.$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^MNQ daily data: 7\.4 years, from 2019-05-06')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^NQ daily data: 20 years, from 2006-10-23')), findsOneWidget);
    expect(find.textContaining('NQ historical · EMA · 30m: running, 4 of 10'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('paper_learning_switch')));
    await tester.tap(find.byKey(const Key('paper_learning_switch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Paper learning is on for MNQ. PAPER only.'), findsOneWidget);
    expect(api.learning, isTrue);
    await tester.ensureVisible(find.byKey(const Key('profile_DEEP')));
    await tester.tap(find.byKey(const Key('profile_DEEP')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Resource profile is DEEP.'), findsOneWidget);
    expect(find.bySemanticsLabel('DEEP resource profile, selected'), findsOneWidget);
    // A refusal is reported as a refusal, and nothing changes.
    api.fail = true;
    await tester.ensureVisible(find.byKey(const Key('paper_learning_switch')));
    await tester.tap(find.byKey(const Key('paper_learning_switch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('That did not work: No futures feed is connected. Nothing was changed.'), findsOneWidget);
    expect(api.learning, isTrue);
    await tester.pumpWidget(const SizedBox());
  });

  for (final width in const [320.0, 390.0]) {
    for (final scale in const [1.0, 1.6]) {
      testWidgets('no clipped or overflowing labels at ${width.toInt()} pt, text ×$scale', (tester) async {
        final api = _Api();
        await _pump(tester, api, size: Size(width, 844), textScale: scale);
        await _scrollTo(tester, find.byKey(const Key('strategy_card_dirty-trez'), skipOffstage: false));
        expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
        await tester.ensureVisible(find.byKey(const Key('strategy_card_ema-pullback')));
        await tester.pump();
        await tester.tap(find.byKey(const Key('strategy_card_ema-pullback')));
        await tester.pump();
        expect(tester.takeException(), isNull, reason: 'the expanded card fits');
        await tester.ensureVisible(find.byKey(const Key('strategy_open_ema-pullback')));
        await tester.pump();
        await tester.tap(find.byKey(const Key('strategy_open_ema-pullback')));
        await tester.pumpAndSettle();
        await _scrollTo(tester, find.byKey(const Key('tf_row_1M'), skipOffstage: false));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    }
  }

  testWidgets('scrolling the whole page is smooth: no exceptions, and settling is bounded', (tester) async {
    final api = _Api();
    await _pump(tester, api);
    for (var i = 0; i < 12; i++) {
      await tester.fling(find.byType(ListView).first, const Offset(0, -500), 2000);
      await tester.pumpAndSettle(const Duration(milliseconds: 16), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('off the CHART section nothing ticks: no chart, no market overview, no running animation', (tester) async {
    final api = _Api();
    await _pump(tester, api, section: CheTradingSection.strategies);
    await tester.pumpAndSettle();
    expect(find.byType(CheTradingChart), findsNothing);
    expect(SchedulerBinding.instance.transientCallbackCount, 0, reason: 'no ticker is active on the hidden chart');
    await tester.pumpWidget(const SizedBox());
  });

  test('numbers are formatted from what the Worker sends, never invented', () {
    expect(fmtR(0.38), '+0.38R');
    expect(fmtR(-0.08), '−0.08R');
    expect(fmtR(null), '—');
    expect(fmtPct(0.55), '55%');
    expect(fmtPct(55), '55%');
    expect(fmtPct(null), '—');
    expect(spokenR(-0.05), 'minus 0.05 R');
    expect(ResearchBucket({'tf': '4h', 'trades': 18}).evidenceLine, '18 / 30 trades · NOT READY');
    expect(ResearchBucket({'tf': '5m', 'trades': 30, 'status': 'QUALIFIED'}).evidenceLine, '30 trades · QUALIFIED');
  });

  testWidgets('switching market clears the old evidence; a failed load says so instead of showing the wrong contract', (tester) async {
    final api = _Api()..failNq = true;
    final client = api.client;
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(),
      home: Scaffold(body: CheTradingRoom(baseUrl: () => 'https://che.test', headers: () => const {}, onAsk: (_) {}, client: client, initialAccount: 'futures_paper', initialSymbol: 'MNQ')),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await _scrollTo(tester, find.text('BEST NOW · MNQ', skipOffstage: false));
    expect(find.text('BEST NOW · MNQ'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, 5000));
    await tester.pump();
    await tester.tap(find.byKey(const Key('market_NQ')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await _scrollTo(tester, find.text('Strategy research is unavailable: NQ history not cached yet', skipOffstage: false));
    expect(find.text('Strategy research is unavailable: NQ history not cached yet'), findsOneWidget);
    expect(find.text('BEST NOW · NQ', skipOffstage: false), findsNothing, reason: 'MNQ evidence is never relabeled NQ');
    expect(find.byKey(const Key('best_now'), skipOffstage: false), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
