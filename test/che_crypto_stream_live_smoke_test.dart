// Live smoke for the BTC/ETH trade stream against the REAL public exchange WebSockets. Skipped unless asked:
//   CHE_LIVE_SMOKE=1 flutter test test/che_crypto_stream_live_smoke_test.dart
// It connects for about 20 seconds, prints what actually arrived, and fails if no message came. Market data only.
import 'dart:io';

import 'package:chey/trading/che_crypto_stream.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final enabled = Platform.environment['CHE_LIVE_SMOKE'] == '1';
  for (final venue in CryptoVenue.values) {
    test('live ${venue.label} BTC-USD trades for 20 seconds', () async {
      final s = CheCryptoStream(product: 'BTC-USD', firstVenue: venue, failoverAfter: 1000);
      s.start();
      await Future<void>.delayed(const Duration(seconds: 20));
      final b = s.book;
      final view = s.describe(restAvailable: false);
      // ignore: avoid_print
      print('${venue.label}: ${view.label}; trades ${b.accepted}, duplicates ${b.duplicates}, 1m candles ${b.candles(1).length}'
          '${b.candles(1).isEmpty ? '' : ', newest ${b.candles(1).last}'}; reason: ${s.reason}');
      await s.stop();
      s.dispose();
      expect(s.lastMessageAt, isNotNull, reason: 'no message from ${venue.label}: ${s.reason}');
    }, skip: enabled ? false : 'live network smoke: set CHE_LIVE_SMOKE=1', timeout: const Timeout(Duration(seconds: 60)));
  }
}
