// Worker answers for the Trading Room v3 screenshots and regression tests (owner, 2026-10-25). Two shapes, both with
// the real field names the Worker sends: realistic (a paper journal with closed futures and crypto trades, a simulation
// in R, a delayed MNQ chart) and empty (a fresh install: nothing recorded yet). Sample records only.
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final kFixtureNow = DateTime.utc(2026, 10, 23, 15, 40);

String _at(DateTime t) => t.toUtc().toIso8601String();

Map<String, dynamic> fixtureChart() {
  final start = kFixtureNow.subtract(const Duration(minutes: 5 * 60));
  return {
    'ok': true,
    'account': 'futures_paper',
    'state': 'verified',
    'symbol': 'MNQ',
    'timeframe': '5m',
    'timeframes': ['1m', '5m', '15m', '1h', '1d'],
    'bars': [
      for (var i = 0; i < 60; i++)
        {
          't': _at(start.add(Duration(minutes: 5 * i))),
          'o': 21000 + i * 1.5 + (i % 4 == 0 ? 3 : 0),
          'h': 21008 + i * 1.5,
          'l': 20994 + i * 1.5,
          'c': 21002 + i * 1.5 + (i % 3 == 0 ? -4 : 2),
        },
    ],
    'feed': {'provider': 'Yahoo MNQ=F', 'status': 'DELAYED', 'last_bar_time': _at(start.add(const Duration(minutes: 5 * 59))), 'age_s': 900, 'stale': false},
    'entries_allowed': false,
    'entries_blocked_reason': 'No futures paper broker is connected.',
    'markers': const [],
    'open_orders': const [],
    'drawings': const [],
  };
}

Map<String, dynamic> fixtureResearch({bool empty = false}) => {
      'ok': true,
      'markets': ['MNQ', 'NQ'],
      // What the Worker really sends: today's paper P&L only (0 when nothing closed today) and no open count.
      'live': {'symbol': 'MNQ', 'price': 21090.5, 'mode': 'PAPER', 'pnl_today': 0, 'win_rate': null, 'open_positions': null},
      'best_now': const [],
      'best_now_reason': 'No strategy currently meets your threshold: no timeframe has 30 out-of-sample trades yet.',
      'strategies': empty
          ? const []
          : [
              {'strategy_id': 'ema_pullback', 'name': 'EMA Pullback', 'status': 'LEARNING', 'best_timeframe': '5m', 'qualified_buckets': 0, 'expectancy_r': 0.12, 'win_rate': 0.48, 'sample_trades': 22},
              {'strategy_id': 'vwap_reversion', 'name': 'VWAP Reversion', 'status': 'LEARNING', 'best_timeframe': '15m', 'qualified_buckets': 0, 'expectancy_r': -0.05, 'win_rate': 0.41, 'sample_trades': 17},
            ],
      'dashboard': {'strategies_tested': empty ? 0 : 2, 'buckets_qualified': 0, 'backtest_trades': empty ? 0 : 412, 'forward_paper_trades': empty ? 0 : 5},
      'jobs': const [],
    };

/// Closed CHE forward paper records, as GET /api/trading/calendar?view=accounts returns them.
List<Map<String, dynamic>> fixturePaperTrades() => [
      {'id': 'T0FUT000000001', 'kind': 'forward_paper', 'symbol': 'MNQ', 'market': 'futures', 'strategy': 'EMA Pullback', 'side': 'long', 'entry_time': '2026-10-21T14:05:00Z', 'exit_time': '2026-10-21T14:40:00Z', 'net': 31.5, 'r': 1.4, 'result': 'win'},
      {'id': 'T0FUT000000002', 'kind': 'forward_paper', 'symbol': 'MNQ', 'market': 'futures', 'strategy': 'VWAP Reversion', 'side': 'short', 'entry_time': '2026-10-21T19:10:00Z', 'exit_time': '2026-10-21T19:25:00Z', 'net': -22.0, 'r': -1.0, 'result': 'loss'},
      // Overnight: opened 7:30 PM New York on Oct 21, closed 1:15 AM Oct 22; its CME trading date is Oct 22.
      {'id': 'T0FUT000000003', 'kind': 'forward_paper', 'symbol': 'MNQ', 'market': 'futures', 'strategy': 'EMA Pullback', 'side': 'long', 'entry_time': '2026-10-21T23:30:00Z', 'exit_time': '2026-10-22T05:15:00Z', 'net': 18.0, 'r': 0.9, 'result': 'win'},
      {'id': 'T0CRY000000001', 'kind': 'forward_paper', 'symbol': 'BTC', 'market': 'crypto', 'strategy': 'Opening Range', 'side': 'long', 'entry_time': '2026-10-22T13:00:00Z', 'exit_time': '2026-10-22T15:00:00Z', 'net': -4.1, 'r': -0.6, 'result': 'loss'},
      {'id': 'T0CRY000000002', 'kind': 'forward_paper', 'symbol': 'ETH', 'market': 'crypto', 'strategy': 'Opening Range', 'side': 'short', 'entry_time': '2026-10-23T02:00:00Z', 'exit_time': '2026-10-23T03:30:00Z', 'net': 6.3, 'r': 1.1, 'result': 'win'},
    ];

Map<String, dynamic> fixtureAccounts({bool empty = false}) => {
      'ok': true,
      'view': 'accounts',
      'time_zone': 'America/New_York',
      'excluded': ['historical_backtest'],
      'accounts': [
        {
          'id': 'forward_paper', 'label': 'CHE forward paper', 'kind': 'forward_paper', 'unit': 'USD',
          'trades': empty ? const [] : fixturePaperTrades(), 'open_positions': empty ? 0 : 1, 'updated_at': empty ? null : '2026-10-23T03:30:00Z', 'read': true,
          'journal': empty
              ? const []
              : [
                  {'time': '2026-10-23T14:55:00Z', 'strategy': 'VWAP Reversion', 'reason': 'Skipped: the feed was 12 minutes old.'},
                ],
        },
        {
          'id': 'simulation', 'label': 'Strategy simulation', 'kind': 'simulation', 'unit': 'R',
          'trades': empty
              ? const []
              : [
                  {'id': 'T0SIM000000001', 'kind': 'simulation', 'symbol': 'MNQ', 'market': 'futures', 'strategy': 'ORB', 'side': 'long', 'entry_time': '2026-10-22T13:31:00Z', 'exit_time': '2026-10-22T13:52:00Z', 'net': null, 'r': 2.0, 'result': 'win'},
                  {'id': 'T0SIM000000002', 'kind': 'simulation', 'symbol': 'BTC', 'market': 'crypto', 'strategy': 'ORB', 'side': 'short', 'entry_time': '2026-10-22T16:00:00Z', 'exit_time': '2026-10-22T16:12:00Z', 'net': null, 'r': -1.0, 'result': 'loss'},
                ],
          'open_positions': 0, 'updated_at': empty ? null : '2026-10-22T16:12:00Z', 'read': true, 'journal': const [],
        },
      ],
    };

Map<String, dynamic> fixtureLedgers({bool empty = false}) => {
      'paper_only': true,
      'separate': true,
      'note': 'Each count is that record set\'s own closed trades; the sets are never summed.',
      'ledgers': [
        {'id': 'strategy_simulation', 'label': 'strategy simulation', 'what': 'Paper strategies on 1-minute bars', 'status': 'running', 'trades': empty ? 0 : 2, 'by_strategy': const [], 'feeds': const []},
        {'id': 'forward_paper_journal', 'label': 'forward paper journal', 'what': 'CHE forward paper on delayed 5-minute bars', 'status': 'on', 'trades': empty ? 0 : 5, 'win_rate': empty ? null : 60, 'net_pnl': empty ? 0 : 29.7, 'by_strategy': const [], 'feeds': const []},
      ],
    };

Map<String, dynamic> fixtureCrypto({bool empty = false}) => {
      'market': 'crypto',
      'desk': 'Orion',
      'enabled': !empty,
      'never_started': empty,
      'schedule': {'runs_on': 'the Worker alarm', 'last_run_at': empty ? null : '2026-10-23T15:35:20Z', 'runs_recorded': empty ? 0 : 140, 'model_calls': 0},
      'budget': {'requests': 12, 'limit': 2000},
      'feeds': [
        for (final coin in ['BTC', 'ETH'])
          {'coin': coin, 'tf': '5m', 'product': '$coin-USD', 'source': 'Coinbase Exchange', 'status': empty ? 'NOT STARTED' : 'DELAYED', 'last_bar': empty ? null : '2026-10-23T15:30:00Z', 'last_close': coin == 'BTC' ? 67250.5 : 2580.25, 'bars': empty ? 0 : 300},
      ],
      'simulated': {'open_positions': const [], 'closed_trades': empty ? 0 : 2, 'wins': empty ? null : 1, 'losses': empty ? null : 1, 'net_pnl': empty ? 0 : 2.2, 'expectancy_r': null, 'enough_data': false, 'recent': const []},
      'performance': const [],
      'research': const [],
      'funding': {'status': 'MISSING'},
      'live_trading': 'disabled: no exchange account, key or order path exists',
      'spoken': 'Orion crypto desk.',
    };

Map<String, dynamic> fixtureConnections() => {
      'mode': 'PAPER',
      'cards': [
        {'id': 'che_paper', 'name': 'CHE Paper', 'state': 'on', 'mode': 'PAPER', 'data': {'source': 'Yahoo MNQ=F', 'label': 'DELAYED', 'lag_minutes': 15}, 'detail': '4 isolated paper portfolios; no broker is reachable from the paper engine.'},
        {'id': 'alpaca', 'name': 'Alpaca (stock paper)', 'state': 'not_configured', 'mode': 'PAPER', 'detail': 'Not set up.'},
      ],
      'permissions': {'live_orders': 'off'},
    };

/// The crypto desk as the owner's recording showed it (2026-10-25 06:16): 37 closed, 16 open, net −$274.20.
Map<String, dynamic> fixtureCryptoOwner() {
  final d = fixtureCrypto();
  d['feeds'] = [
    {'coin': 'BTC', 'tf': '5m', 'product': 'BTC-USD', 'source': 'Coinbase Exchange', 'status': 'LIVE', 'last_bar': '2026-10-25T10:10:00Z', 'last_close': 80228, 'bars': 300},
    {'coin': 'ETH', 'tf': '5m', 'product': 'ETH-USD', 'source': 'Coinbase Exchange', 'status': 'LIVE', 'last_bar': '2026-10-25T10:10:00Z', 'last_close': 2326.29, 'bars': 300},
  ];
  d['schedule'] = {'runs_on': 'the Worker alarm', 'last_run_at': '2026-10-25T10:15:20Z', 'next_at': '2026-10-25T10:20:20Z', 'runs_recorded': 900, 'model_calls': 0};
  d['budget'] = {'requests': 322, 'limit': 3000};
  d['simulated'] = {
    'open_positions': [
      for (var i = 0; i < 16; i++)
        {'coin': i.isEven ? 'BTC' : 'ETH', 'tf': '5m', 'strategy': 'orb', 'side': 'long', 'entry_time': '2026-10-25T09:${(10 + i).toString().padLeft(2, '0')}:00Z', 'entry': i.isEven ? 80100.0 : 2320.0, 'stop': i.isEven ? 79900.0 : 2310.0, 'target': i.isEven ? 80500.0 : 2340.0, 'qty': 0.01},
    ],
    'closed_trades': 37, 'wins': 11, 'losses': 26, 'net_pnl': -274.2, 'expectancy_r': -6.5935, 'enough_data': true,
    'recent': [
      for (var i = 0; i < 10; i++)
        {'coin': 'BTC', 'tf': '5m', 'strategy': 'orb', 'side': 'long', 'entry_time': '2026-10-25T0${i % 9}:00:00Z', 'entry': 80000 + i, 'exit_time': '2026-10-25T0${i % 9}:30:00Z', 'exit': 79950 + i, 'reason': 'stop', 'net_pnl': -7.4, 'costs': {'fees': 4.8, 'slippage': 0.3}, 'why': 'range break'},
    ],
  };
  return d;
}

/// A fake Worker. [overrides] replaces the answer for a path; [seen] collects every request URL.
http.Client fixtureWorker({bool empty = false, List<Uri>? seen, Map<String, Object> overrides = const {}}) => MockClient((r) async {
      seen?.add(r.url);
      final p = r.url.path;
      final q = r.url.queryParameters;
      Object? body;
      if (overrides.containsKey(p)) {
        body = overrides[p];
      } else if (p == '/api/trading/chart') {
        body = fixtureChart();
      } else if (p == '/api/trading/research') {
        body = fixtureResearch(empty: empty);
      } else if (p == '/api/trading/calendar' && q['view'] == 'accounts') {
        body = fixtureAccounts(empty: empty);
      } else if (p == '/api/trading/ledgers') {
        body = fixtureLedgers(empty: empty);
      } else if (p == '/api/trading/crypto') {
        body = fixtureCrypto(empty: empty);
      } else if (p == '/api/trading/connections') {
        body = fixtureConnections();
      } else if (p == '/api/markets/universe') {
        body = {'ok': true, 'results': const [], 'defaults': const []};
      } else {
        return http.Response(jsonEncode({'ok': false, 'detail': 'Not served in this test.'}), 404);
      }
      return http.Response(jsonEncode(body), 200);
    });
