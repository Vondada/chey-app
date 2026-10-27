// Deterministic trading data for tests (no live market feed). The bars, markers and feed status are fixed, so the
// Trading Room's real widgets (chart, expand, order ticket) run the same way on a CI simulator as on a developer's Mac.
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> chartFixture({String account = 'alpaca_paper', bool stale = false, bool entries = true, List<Map<String, dynamic>> drawings = const [], String tf = '5m'}) {
  final start = DateTime.utc(2026, 10, 20, 14, 0);
  final bars = [
    for (var i = 0; i < 40; i++)
      {
        't': start.add(Duration(minutes: 5 * i)).toIso8601String(),
        'o': 100 + i * 0.5,
        'h': 101.5 + i * 0.5,
        'l': 99.5 + i * 0.5,
        'c': 100.8 + i * 0.5,
      },
  ];
  String at(int i) => start.add(Duration(minutes: 5 * i)).toIso8601String();
  return {
    'ok': true,
    'account': account,
    'state': 'verified',
    'symbol': account == 'alpaca_paper' ? 'AAPL' : 'MNQ',
    'timeframe': tf,
    'timeframes': ['1m', '5m', '15m', '1h', '1d'],
    'bars': bars,
    'feed': {'provider': account == 'alpaca_paper' ? 'Alpaca IEX' : 'Yahoo MNQ=F', 'status': account == 'alpaca_paper' ? 'REALTIME' : 'DELAYED', 'last_bar_time': at(39), 'age_s': stale ? 7200 : 60, 'stale': stale},
    'entries_allowed': entries,
    'market_orders_allowed': entries && !stale,
    'entries_blocked_reason': !entries
        ? 'No futures paper broker is connected (Tradovate is not signed in), so CHE takes no manual futures orders.'
        : stale
            ? 'The last bar is old (market closed or the feed stopped); market orders are blocked, limit orders queue for the next session.'
            : '',
    'markers': [
      {'source': 'che_forward', 'id': 'f1', 'kind': 'entry', 'time': at(5), 'price': 103.0, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed'},
      {'source': 'che_forward', 'id': 'f2', 'kind': 'entry', 'time': at(9), 'price': 105.0, 'side': 'long', 'strategy': 'vwap', 'status': 'closed'},
      {'source': 'che_sim', 'id': 's1', 'kind': 'entry', 'time': at(12), 'price': 106.5, 'side': 'long', 'strategy': 'ema_pullback', 'status': 'closed'},
      {'source': 'alpaca_order', 'id': 'o1', 'kind': 'order', 'time': at(20), 'price': 109.0, 'side': 'buy', 'qty': '2', 'status': 'new', 'order_id': 'order-0001-abcd'},
      {'source': 'alpaca_fill', 'id': 'x1', 'kind': 'fill', 'time': at(30), 'price': 115.2, 'side': 'buy', 'qty': '1', 'status': 'filled', 'order_id': 'order-0002-abcd'},
    ],
    'open_orders': account == 'alpaca_paper'
        ? [
            {'id': 'order-0001-abcd', 'symbol': 'AAPL', 'side': 'buy', 'qty': '2', 'type': 'limit', 'limit_price': '109.00', 'status': 'new'},
          ]
        : const [],
    'drawings': drawings,
  };
}

/// A client that answers the Trading Room's routes with the fixture above. Orders go to a fake PAPER broker and nothing
/// is sent anywhere real. [failChart] makes the chart route fail, to test the error path.
http.Client fixtureTradingClient({List<http.Request>? seen, bool failChart = false}) => MockClient((r) async {
      seen?.add(r);
      final p = r.url.path;
      if (p == '/api/trading/chart') {
        if (failChart) return http.Response('{"error":"feed offline"}', 503);
        final account = r.url.queryParameters['account'] ?? 'alpaca_paper';
        return http.Response(jsonEncode(chartFixture(account: account, tf: r.url.queryParameters['tf'] ?? '5m')), 200);
      }
      if (p == '/api/trading/chart/drawings') {
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'ok': true, 'drawings': body['drawings'] ?? []}), 200);
      }
      if (p == '/api/trading/alpaca/order/preview') {
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        final cost = (body['limit_price'] as num? ?? 120) * (body['qty'] as num);
        return http.Response(jsonEncode({'ok': true, 'mode': 'PAPER', 'estimated_cost': cost, 'buying_power': 100000, 'buying_power_after': 100000 - cost, 'last_trade': 120.3, 'blocked': ''}), 200);
      }
      if (p == '/api/trading/alpaca/order') {
        return http.Response(jsonEncode({'ok': true, 'receipt': {'id': 'order-9999-abcd', 'status': 'accepted'}}), 200);
      }
      if (p == '/api/trading/alpaca/order/cancel') {
        return http.Response(jsonEncode({'ok': true, 'receipt': {'id': 'order-0001-abcd', 'status': 'canceled'}}), 200);
      }
      return http.Response(jsonEncode({'ok': true}), 200);
    });
