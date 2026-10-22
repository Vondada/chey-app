import 'dart:convert';

import 'package:chey/home/che_home_tiles.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> bar(DateTime t, double o, double c) => {'t': t.millisecondsSinceEpoch, 'o': o, 'c': c};

void main() {
  test('MNQ change counts from the 6 PM New York session open, across UTC midnight', () {
    // 2026-10-21 22:05 UTC is 6:05 PM New York (EDT): the session that trades on Thursday the 22nd.
    final q = CheHomeQuote.fromChart({
      'bars': [
        bar(DateTime.utc(2026, 10, 21, 20, 0), 90, 95), // Wednesday's session, before the 5 PM break
        bar(DateTime.utc(2026, 10, 21, 22, 5), 100, 101),
        bar(DateTime.utc(2026, 10, 22, 1, 0), 101, 104),
        bar(DateTime.utc(2026, 10, 22, 14, 0), 104, 110),
      ],
      'feed': {'status': 'delayed'},
    })!;
    expect(q.changePct, closeTo(10, 1e-9), reason: 'from the 100 open at 6:05 PM, not the first bar after 00:00 UTC');
    expect(q.status, 'DELAYED');
  });

  testWidgets('A failed refresh keeps the last price but marks it stale', (tester) async {
    var calls = 0;
    final client = MockClient((_) async {
      calls++;
      if (calls > 1) return http.Response('down', 503);
      return http.Response(
          jsonEncode({
            'bars': [bar(DateTime.utc(2026, 10, 22, 14), 100, 101), bar(DateTime.utc(2026, 10, 22, 14, 5), 101, 102)],
            'feed': {'status': 'delayed'},
          }),
          200);
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheHomeMarketTile(baseUrl: () => 'https://x', headers: () => const {}, onOpen: () {}, client: client),
      ),
    ));
    await tester.pump();
    await tester.pump();
    expect(find.text('MNQ · DELAYED'), findsOneWidget);

    await tester.pump(const Duration(seconds: 61));
    await tester.pump();
    expect(calls, 2);
    expect(find.text('MNQ · STALE'), findsOneWidget);
    expect(find.text('102.00'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('stale data')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
