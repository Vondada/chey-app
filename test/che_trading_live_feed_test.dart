// The real trading data connection (owner, 2026-10-27: test the live connection separately from CI). It asks the real
// Worker for the chart and checks the answer is a verified feed with bars. It needs the Worker's address, given with
//   flutter test --dart-define=CHE_LIVE_BASE_URL=https://<worker> test/che_trading_live_feed_test.dart
// Without that define the check reports that it did not run, so it cannot pass by accident. It is not part of the CI gate,
// because CI has no market data access. It sends nothing to any broker: it only reads the chart.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

const _base = String.fromEnvironment('CHE_LIVE_BASE_URL');

void main() {
  // Without the define this check is skipped (it cannot run in CI: no market data access), and the skip says why.
  test('the live Worker chart answers with a verified feed and real bars', skip: _base.isEmpty ? 'Not run: pass --dart-define=CHE_LIVE_BASE_URL=https://<worker>. This check needs the real Worker.' : false, () async {
    expect(_base, isNotEmpty);
    final uri = Uri.parse('$_base/api/trading/chart').replace(queryParameters: {'account': 'alpaca_paper', 'tf': '5m'});
    final r = await http.get(uri).timeout(const Duration(seconds: 25));
    expect(r.statusCode, 200, reason: 'The chart route answered ${r.statusCode}: ${r.body}');
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    expect(j['ok'], isNot(false), reason: 'The chart said: ${j['error'] ?? j['detail']}');
    final bars = j['bars'];
    expect(bars, isA<List>(), reason: 'The chart has no bars list');
    expect((bars as List).length, greaterThan(0), reason: 'The chart returned zero bars. The market feed may be closed or unreachable.');
  });
}
