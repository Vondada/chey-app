import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_ui/che_clock.dart';

Map<String, bool> _open(DateTime at) => {for (final s in cheMarketSessions(at)) s.name: s.open};

void main() {
  test('Louisiana time: CDT in October, CST in January, and the March switch happens at 08:00 UTC', () {
    final october = CheChicagoTime.at(DateTime.utc(2026, 10, 22, 2, 30));
    expect(october.text, '9:30 PM CDT');
    expect(october.local.day, 21);
    expect(CheChicagoTime.at(DateTime.utc(2027, 1, 15, 5, 30)).text, '11:30 PM CST');
    expect(CheChicagoTime.at(DateTime.utc(2026, 3, 8, 7, 59)).text, '1:59 AM CST');
    expect(CheChicagoTime.at(DateTime.utc(2026, 3, 8, 8, 0)).text, '3:00 AM CDT');
  });

  test('12-hour text: never 24-hour, midnight and noon named by their hour', () {
    expect(cheTwelveHour(0, 5), '12:05 AM');
    expect(cheTwelveHour(12, 0), '12:00 PM');
    expect(cheTwelveHour(9, 30), '9:30 AM');
    expect(cheTwelveHour(15, 15), '3:15 PM');
  });

  test('a Wednesday afternoon in October: New York and London open, Tokyo closed, MNQ open', () {
    expect(_open(DateTime.utc(2026, 10, 21, 14, 0)), {'Tokyo': false, 'London': true, 'New York': true, 'MNQ futures': true});
  });

  test('New York is still closed at 9:00 AM in winter time, while London is open', () {
    expect(_open(DateTime.utc(2027, 1, 15, 14, 0)), {'Tokyo': false, 'London': true, 'New York': false, 'MNQ futures': true});
  });

  test('Friday evening: New York closed, and MNQ futures closed from 5:00 PM New York time', () {
    expect(cheFuturesOpen(DateTime.utc(2026, 10, 23, 22, 0)), isFalse);
    expect(_open(DateTime.utc(2026, 10, 23, 22, 0))['New York'], isFalse);
  });

  test('the daily futures break is 5:00 to 6:00 PM New York time, and Sunday trading starts at 6:00 PM', () {
    // 2026-10-21 21:30 UTC is 5:30 PM in New York (EDT): the break.
    expect(cheFuturesOpen(DateTime.utc(2026, 10, 21, 21, 30)), isFalse);
    // 2026-10-21 22:30 UTC is 6:30 PM: trading again.
    expect(cheFuturesOpen(DateTime.utc(2026, 10, 21, 22, 30)), isTrue);
    // Sunday 2026-10-25 at 7:30 PM New York (23:30 UTC).
    expect(cheFuturesOpen(DateTime.utc(2026, 10, 25, 23, 30)), isTrue);
  });

  testWidgets('the clock strip shows the Chicago time and every session in one readable line', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheClockStrip(now: () => DateTime.utc(2026, 10, 22, 2, 30)),
      ),
    ));
    expect(find.textContaining('9:30 PM CDT'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Clock and markets: 9:30 PM CDT\.')), findsOneWidget);
  });
}
