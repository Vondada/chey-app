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

const _ev = {'kind': 'SIMULATED BACKTEST', 'provider': 'Yahoo Finance chart (public, free, delayed)', 'first': '2026-08-25T13:30:00Z', 'last': '2026-10-22T20:00:00Z', 'days': 58, 'incomplete': false, 'incomplete_why': <String>[], 'proxy': false};

Map<String, dynamic> _cell() => {
      'strategy_id': 'ema-pullback', 'name': 'EMA Pullback', 'market': 'MNQ', 'timeframe': '5m', 'available': true, 'state': 'Strong',
      'reason': 'Strong: +0.38R per trade on 38 unseen trades, profit factor 1.5 (Strong needs +0.30R and 1.3).', 'evidence': _ev,
      'all': {'trades': 143, 'win_rate': 0.48, 'expectancy_r': 0.31, 'pf': 1.4, 'max_dd_r': 6.5}, 'oos': {'trades': 38, 'win_rate': 0.5, 'expectancy_r': 0.38, 'pf': 1.5, 'max_dd_r': 3},
      'folds_positive': 3, 'folds_total': 4, 'look_ahead': 'passed', 'period': {'first': '2026-08-25T13:30:00Z', 'last': '2026-10-22T20:00:00Z'},
      'cost_profile': 'NORMAL', 'costs': {'spreadTicks': 1, 'slippageTicks': 1, 'commissionPerSide': 1.5, 'feePerSide': 0.5}, 'point_value': 2,
      'trades_total': 143, 'trades_kept': 2, 'dollars_recorded': true,
      'dollars_note': 'Dollar figures cover the 2 stored trades, 1 MNQ contract at \$2 a point, after the NORMAL cost model.',
      'money': {'all': {'net_pnl': 31.5, 'costs': 9.0, 'trades': 2}, 'oos': {'net_pnl': 40.25, 'costs': 4.5, 'trades': 1}},
      'trades': [
        {'t': '2026-10-22T14:35:00Z', 'x': '2026-10-22T14:50:00Z', 'r': -0.4, 'side': 'long', 'ep': 21450.25, 'xp': 21446.5, 'pnl': -8.75, 'c': 4.5, 'oos': false, 'reason': 'stop'},
        {'t': '2026-10-22T15:05:00Z', 'x': '2026-10-22T15:30:00Z', 'r': 1.9, 'side': 'short', 'ep': 21470.0, 'xp': 21450.0, 'pnl': 40.25, 'c': 4.5, 'oos': true, 'reason': 'target'},
      ],
      'bars': [
        for (var i = 0; i < 20; i++) {'t': DateTime.utc(2026, 10, 22, 14, 30).add(Duration(minutes: 5 * i)).toIso8601String(), 'o': 21450.0 + i, 'h': 21455.0 + i, 'l': 21445.0 + i, 'c': 21452.0 + i},
      ],
    };

Map<String, dynamic> _matrix() => {
      'min_closed_trades': 30,
      'min_oos_trades': 15,
      'timeframes': ['15s', '1m', '5m', '4h', '1W'],
      'rows': [
        {
          'strategy_id': 'ema-pullback',
          'name': 'EMA Pullback',
          'cells': {
            '15s': {'state': 'Learning', 'trades': 29, 'reason': 'Learning: 29 of 30 backtest trades needed before any rating.'},
            '1m': {'state': 'Fair', 'trades': 217, 'oos_trades': 60, 'expectancy_r': -0.01, 'oos_expectancy_r': -0.01, 'reason': 'Fair: −0.01R per trade on 60 unseen trades, about break-even after costs (Good needs above 0).', 'evidence': _ev},
            '5m': {'state': 'Strong', 'trades': 143, 'oos_trades': 38, 'expectancy_r': 0.38, 'oos_expectancy_r': 0.38, 'pf': 1.5, 'reason': 'Strong: +0.38R per trade on 38 unseen trades, profit factor 1.5 (Strong needs +0.30R and 1.3).', 'evidence': _ev},
            '4h': {'state': 'Not enough unseen data', 'trades': 154, 'oos_trades': 4, 'expectancy_r': 0.2, 'oos_expectancy_r': null, 'reason': 'Not rated: only 4 unseen trades; a rating needs at least 15 trades the strategy was not tuned on.', 'evidence': {..._ev, 'incomplete': true, 'incomplete_why': ['12 expected bars missing from the data']}},
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
    if (p == '/api/trading/research/cell') return _json(_cell());
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
    expect(find.bySemanticsLabel(RegExp(r'^Mode: PAPER$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Regime: Trending bullish · normal volatility$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Data: Yahoo NQ=F \(delayed\)$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Win Rate: 55%$')), findsOneWidget);
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
    // The live feed is MNQ only: the chart stays on futures and the page says so instead of pairing NQ research with an unlabeled MNQ chart.
    final chartCalls = api.at('/api/trading/chart').toList();
    expect(chartCalls.last.url.queryParameters['account'], 'futures_paper');
    expect(find.byKey(const Key('nq_chart_note')), findsOneWidget);
    expect(find.bySemanticsLabel('NQ market, selected'), findsOneWidget);
    await tester.tap(find.text('15m').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.at('/api/trading/chart').last.url.queryParameters['tf'], '15m');
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
    await _pump(tester, api, size: const Size(390, 3200));
    await _scrollTo(tester, find.byKey(const Key('open_matrix'), skipOffstage: false));
    await tester.tap(find.byKey(const Key('open_matrix')));
    await tester.pumpAndSettle();
    expect(find.text('Strategy Matrix · MNQ'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 5 minute, Strong, 143 backtest trades, 38 tested on unseen data, plus 0\.38 R per unseen trade, Strong: \+0\.38R per trade on 38 unseen trades.*simulated$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 15 second, Learning, 29 of 30 trades needed, Learning: 29 of 30')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 4 hour, Not enough unseen data, 154 backtest trades, 4 tested on unseen data, Not rated: only 4 unseen trades.*simulated, incomplete$')), findsOneWidget,
        reason: 'too few unseen trades is not rated, never shown as Weak');
    expect(find.bySemanticsLabel(RegExp(r'^EMA Pullback, weekly, no data')), findsOneWidget);
    expect(find.text('143 backtest trades'), findsOneWidget, reason: 'the number says what it counts');
    expect(find.text('29 of 30 trades needed'), findsOneWidget);
    expect(find.text('38 tested on unseen data'), findsOneWidget);
    expect(find.textContaining('Strong: +0.38R per trade on 38 unseen trades'), findsOneWidget, reason: 'the phone list shows the reason');
    expect(find.text('SIMULATED · INCOMPLETE'), findsOneWidget);
    expect(find.byIcon(Icons.trending_up_rounded), findsWidgets, reason: 'status has an icon, not color alone');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Strategy Matrix: the legend explains the numbers in plain words; filters and the grid layout work', (tester) async {
    final api = _Api();
    final read = <String>[];
    await _pump(tester, api, read: read, size: const Size(390, 3200));
    await _scrollTo(tester, find.byKey(const Key('open_matrix'), skipOffstage: false));
    await tester.tap(find.byKey(const Key('open_matrix')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('matrix_help')));
    await tester.pumpAndSettle();
    expect(find.text('What do these mean?'), findsOneWidget);
    expect(find.textContaining('How many trades the strategy took in that backtest'), findsOneWidget);
    expect(find.textContaining('never Weak'), findsOneWidget);
    await tester.tap(find.byTooltip('Read the legend aloud'));
    expect(read.single, startsWith('Each box: One strategy on one timeframe'));
    Navigator.of(tester.element(find.text('What do these mean?'))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rating_Not rated')));
    await tester.pumpAndSettle();
    expect(find.text('143 backtest trades'), findsNothing, reason: 'Strong is filtered out');
    expect(find.text('154 backtest trades'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rating_All')));
    await tester.tap(find.byKey(const Key('matrix_enough')));
    await tester.pumpAndSettle();
    expect(find.text('29 of 30 trades needed'), findsNothing, reason: 'only boxes with 30 trades and 15 unseen');
    expect(find.text('154 backtest trades'), findsNothing);
    expect(find.text('143 backtest trades'), findsOneWidget);
    await tester.tap(find.byKey(const Key('matrix_layout')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Strong: +0.38R'), findsNothing, reason: 'the grid keeps boxes short; the reason is in the label and the detail');
    expect(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 5 minute, Strong, 143 backtest trades')), findsOneWidget);
    await tester.tap(find.byTooltip('Read the matrix aloud'));
    expect(read.last, contains('Every box is a simulated backtest'));
    expect(read.last, contains('1 strong, 1 fair, 1 not enough unseen data, 1 learning'));
    await tester.pumpWidget(const SizedBox());
  });

  for (final (size, scale, label) in [(const Size(390, 844), 2.0, 'iPhone with the largest text'), (const Size(1024, 1366), 1.0, 'iPad grid')]) {
    testWidgets('Strategy Matrix lays out without overflow: $label', (tester) async {
      final api = _Api();
      await _pump(tester, api, size: size, textScale: scale);
      await _scrollTo(tester, find.byKey(const Key('open_matrix'), skipOffstage: false));
      await tester.tap(find.byKey(const Key('open_matrix')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('matrix_help')), findsOneWidget);
      await tester.tap(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 1 minute, Fair')).first);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('cell_reason')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('Strategy Matrix: a box opens its reason, evidence, all vs unseen results in R and dollars, the chart with entries and exits, and the trades', (tester) async {
    final api = _Api();
    final read = <String>[];
    await _pump(tester, api, read: read, size: const Size(390, 3200));
    await _scrollTo(tester, find.byKey(const Key('open_matrix'), skipOffstage: false));
    await tester.tap(find.byKey(const Key('open_matrix')));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel(RegExp(r'^EMA Pullback, 5 minute, Strong')));
    await tester.pumpAndSettle();
    expect(api.requests.any((r) => r.url.path == '/api/trading/research/cell' && r.url.queryParameters['id'] == 'ema-pullback' && r.url.queryParameters['tf'] == '5m'), isTrue);
    expect(find.text('EMA Pullback · 5m'), findsOneWidget);
    expect(find.byKey(const Key('cell_reason')), findsOneWidget);
    expect(find.textContaining('SIMULATED BACKTEST'), findsOneWidget);
    expect(find.textContaining('Yahoo Finance chart (public, free, delayed), 2026-08-25 → 2026-10-22, 58 days'), findsOneWidget);
    expect(find.textContaining('not broker executions'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Trades\s*143\s*38')), findsOneWidget, reason: 'all trades beside unseen trades');
    expect(find.bySemanticsLabel(RegExp(r'Net P&L\s*\+\$31\.50\s*\+\$40\.25')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Commissions, fees, slippage\s*\$9\.00\s*\$4\.50')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Walk-forward folds positive\s*3 of 4')), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('cell_chart')), 300, scrollable: find.byType(Scrollable).last);
    expect(find.bySemanticsLabel('Chart of 20 5 minute bars from 2026-10-22 to 2026-10-22, with 2 simulated entries and 2 exits.'), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('cell_truncated')), 300, scrollable: find.byType(Scrollable).last);
    expect(find.text('Showing the last 2 of 143 trades; all 143 are in the figures above.'), findsOneWidget);
    expect(find.textContaining('Short'), findsWidgets);
    expect(find.textContaining('entry 21470.0 → exit 21450.0 · +1.90R · +\$40.25 · unseen · target'), findsOneWidget);
    await tester.tap(find.byTooltip('Read this box aloud'));
    expect(read.single, startsWith('EMA Pullback, 5 minute. Strong: +0.38R'));
    expect(read.single, contains('Simulated backtest on Yahoo Finance'));
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
    await tester.tap(find.byKey(const Key('paper_learning_switch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Paper learning is on for MNQ. PAPER only.'), findsOneWidget);
    expect(api.learning, isTrue);
    await tester.tap(find.byKey(const Key('profile_DEEP')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Resource profile is DEEP.'), findsOneWidget);
    expect(find.bySemanticsLabel('DEEP resource profile, selected'), findsOneWidget);
    // A refusal is reported as a refusal, and nothing changes.
    api.fail = true;
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
