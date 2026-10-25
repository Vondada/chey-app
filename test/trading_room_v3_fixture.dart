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

List<Map<String, dynamic>> fixtureSimTrades() => [
      {'id': 'T0SIM000000001', 'kind': 'simulation', 'symbol': 'MNQ', 'market': 'futures', 'strategy': 'ORB', 'side': 'long', 'entry_time': '2026-10-22T13:31:00Z', 'exit_time': '2026-10-22T13:52:00Z', 'net': null, 'r': 2.0, 'result': 'win', 'unit': 'R'},
      {'id': 'T0SIM000000002', 'kind': 'simulation', 'symbol': 'BTC', 'market': 'crypto', 'strategy': 'ORB', 'side': 'short', 'entry_time': '2026-10-22T16:00:00Z', 'exit_time': '2026-10-22T16:12:00Z', 'net': null, 'r': -1.0, 'result': 'loss', 'unit': 'R'},
    ];

Map<String, dynamic> fixtureAccounts({bool empty = false}) {
  final paper = empty ? <Map<String, dynamic>>[] : fixturePaperTrades();
  Map<String, dynamic> account(String id, String label, String kind, String unit, List<Map<String, dynamic>> trades, int open, List<Map<String, dynamic>> journal) => {
        'id': id, 'label': label, 'kind': kind, 'unit': unit, 'trades': trades, 'open_positions': open,
        'updated_at': trades.isEmpty ? null : trades.last['exit_time'], 'read': true, 'error': null, 'journal': journal,
      };
  return {
    'ok': true,
    'view': 'accounts',
    'time_zone': 'America/New_York',
    'checked_at': '2026-10-23T15:40:00Z',
    'excluded': ['historical_backtest'],
    'accounts': [
      account('forward_paper_futures', 'CHE forward paper · futures', 'forward_paper', 'USD', [for (final t in paper) if (t['market'] == 'futures') t], empty ? 0 : 1, empty
          ? const []
          : [
              {'time': '2026-10-23T14:55:00Z', 'strategy': 'VWAP Reversion', 'reason': 'Skipped: the feed was 12 minutes old.'},
            ]),
      account('forward_paper_crypto', 'CHE forward paper · crypto', 'forward_paper', 'USD', [for (final t in paper) if (t['market'] == 'crypto') t], empty ? 0 : 16, const []),
      account('simulation', 'Strategy simulation (R)', 'simulation', 'R', empty ? const [] : fixtureSimTrades(), 0, const []),
    ],
  };
}

String _nyDate(String iso, String market) {
  final t = DateTime.parse(iso).toUtc();
  // October 2026 is daylight time in New York (UTC−4) until November 1.
  final ny = t.subtract(const Duration(hours: 4));
  final d = market == 'futures' && ny.hour >= 18 ? DateTime.utc(ny.year, ny.month, ny.day + 1) : DateTime.utc(ny.year, ny.month, ny.day);
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

/// GET /api/trading/calendar?view=unified for October 2026 (or one [day]), built from the same records.
Map<String, dynamic> fixtureUnified({bool empty = false, String market = 'all', String day = ''}) {
  final rows = <Map<String, dynamic>>[
    if (!empty)
      for (final t in [...fixturePaperTrades(), ...fixtureSimTrades()])
        if (market == 'all' || t['market'] == market)
          {
            ...t,
            'kind_label': t['kind'] == 'simulation' ? 'Strategy simulation' : 'CHE forward paper',
            'unit': t['kind'] == 'simulation' ? 'R' : 'USD',
            'date': _nyDate('${t['exit_time']}', '${t['market']}'),
            'date_basis': t['market'] == 'futures' ? 'CME trading date' : 'New York calendar date',
            'replay': true,
          },
  ];
  Map<String, dynamic> totals(List<Map<String, dynamic>> list) {
    final kinds = <String, dynamic>{};
    for (final kind in ['forward_paper', 'simulation']) {
      final ks = list.where((t) => t['kind'] == kind).toList();
      if (ks.isEmpty) continue;
      final unit = kind == 'simulation' ? 'R' : 'USD';
      final vals = [for (final t in ks) (unit == 'R' ? t['r'] : t['net']) as num];
      kinds[kind] = {'label': kind == 'simulation' ? 'Strategy simulation' : 'CHE forward paper', 'unit': unit, 'trades': ks.length,
        'wins': ks.where((t) => t['result'] == 'win').length, 'losses': ks.where((t) => t['result'] == 'loss').length,
        'net': (vals.fold<num>(0, (a, b) => a + b) * 100).round() / 100};
    }
    final net = kinds['forward_paper']?['net'] as num?;
    return {
      'trades': list.length, 'wins': list.where((t) => t['result'] == 'win').length, 'losses': list.where((t) => t['result'] == 'loss').length,
      'instruments': ({for (final t in list) '${t['symbol']}'}.toList()..sort()), 'strategies': ({for (final t in list) '${t['strategy']}'}.toList()..sort()), 'kinds': kinds,
      'color': list.isEmpty ? null : (net == null ? null : (net.abs() <= 25 ? 'yellow' : (net > 0 ? 'green' : 'red'))),
    };
  }

  final base = {'ok': true, 'view': 'unified', 'market': market, 'time_zone': 'America/New_York', 'errors': const []};
  if (day.isNotEmpty) {
    final list = rows.where((t) => t['date'] == day).toList();
    return {...base, 'day': day, 'totals': totals(list), 'trades': list};
  }
  final weeks = <Map<String, dynamic>>[];
  var week = <Map<String, dynamic>>[];
  for (var d = 1; d <= 31; d++) {
    final date = DateTime.utc(2026, 10, d);
    final key = '2026-10-${d.toString().padLeft(2, '0')}';
    final t = totals(rows.where((r) => r['date'] == key).toList());
    week.add({'date': key, ...t});
    if (date.weekday == DateTime.sunday || d == 31) {
      weeks.add({'days': week});
      week = [];
    }
  }
  return {...base, 'month': '2026-10', 'prev': '2026-09', 'next': '2026-11', 'weeks': weeks, 'totals': totals(rows), 'empty': rows.isEmpty};
}

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
      } else if (p == '/api/trading/calendar' && q['view'] == 'unified') {
        body = fixtureUnified(empty: empty, market: q['market'] ?? 'all', day: q['day'] ?? '');
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
      // UTF-8, as the Worker sends it (labels carry '·' and '—').
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    });
