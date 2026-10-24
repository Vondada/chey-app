import 'package:chey/mailbox/che_mail_time.dart';
import 'package:flutter_test/flutter_test.dart';

/// America/Chicago's UTC offset at an instant (US rules since 2007): CDT from the second Sunday of March at
/// 2:00 AM CST (08:00Z) to the first Sunday of November at 2:00 AM CDT (07:00Z). Injected so the result does not
/// depend on the test machine's zone.
Duration chicago(DateTime utc) {
  DateTime nthSunday(int year, int month, int n) {
    final first = DateTime.utc(year, month, 1);
    final offset = (DateTime.sunday - first.weekday) % 7;
    return DateTime.utc(year, month, 1 + offset + 7 * (n - 1));
  }

  final y = utc.year;
  final start = nthSunday(y, 3, 2).add(const Duration(hours: 8));
  final end = nthSunday(y, 11, 1).add(const Duration(hours: 7));
  final dst = !utc.isBefore(start) && utc.isBefore(end);
  return Duration(hours: dst ? -5 : -6);
}

String when(String at, String now) => cheMailWhen({'at': at}, now: DateTime.parse(now), offsetOf: chicago);

void main() {
  test('owner case: a Claude message created at 2026-10-24T17:16:00Z reads 12:16 PM in Chicago', () {
    expect(when('2026-10-24T17:16:00Z', '2026-10-24T17:16:30Z'), '12:16 PM');
    expect(when('2026-10-24T17:16:00.000Z', '2026-10-24T17:16:30Z'), '12:16 PM');
    // The line as typed by hand would have read 2:30 PM; the Worker now sends the bounded time instead.
    expect(when('2026-10-24T19:30:00Z', '2026-10-24T17:16:30Z'), '2:30 PM');
    expect(when('2026-10-24T16:50:28.700Z', '2026-10-24T17:16:30Z'), '11:50 AM');
  });

  test('delayed delivery keeps the creation time, not the sync time', () {
    final m = {'at': '2026-10-24T17:16:00.000Z', 'received_at': '2026-10-24T19:30:00.000Z'};
    expect(cheMailWhen(m, now: DateTime.parse('2026-10-24T19:31:00Z'), offsetOf: chicago), '12:16 PM');
  });

  test('DST: the 2026-11-01 fall-back and the 2026-03-08 spring-forward', () {
    expect(when('2026-11-01T06:30:00Z', '2026-11-01T18:00:00Z'), '1:30 AM'); // CDT
    expect(when('2026-11-01T07:30:00Z', '2026-11-01T18:00:00Z'), '1:30 AM'); // CST, an hour later
    expect(when('2026-11-01T18:00:00Z', '2026-11-01T18:00:00Z'), '12:00 PM');
    expect(when('2026-11-01T04:30:00Z', '2026-11-01T18:00:00Z'), '10/31'); // 11:30 PM CDT the day before
    expect(when('2026-03-08T07:59:00Z', '2026-03-08T18:00:00Z'), '1:59 AM'); // CST
    expect(when('2026-03-08T08:00:00Z', '2026-03-08T18:00:00Z'), '3:00 AM'); // CDT
    expect(when('2026-03-08T17:16:00Z', '2026-03-08T18:00:00Z'), '12:16 PM');
    expect(cheMailStamp('2026-11-01T07:30:00Z', offsetOf: chicago), '11/1 1:30 AM');
  });

  test('today is the device-zone day, not the UTC day', () {
    // 9:30 PM CDT on 10/24 is already 10/25 in UTC; the owner's now (10:00 PM CDT) is the same Chicago day.
    expect(when('2026-10-25T02:30:00Z', '2026-10-25T03:00:00Z'), '9:30 PM');
    expect(when('2026-10-24T17:16:00Z', '2026-10-25T06:00:00Z'), '10/24');
  });

  test('ordering is by instant across zone formats, stable on ties, unknown last', () {
    final rows = <Map>[
      {'id': 'b', 'at': '2026-10-24T17:16:00.000000+00:00'},
      {'id': 'x', 'at': 'not a time'},
      {'id': 'c', 'at': '2026-10-24T17:15:59Z'},
      {'id': 'a', 'at': '2026-10-24T12:16:00-05:00'},
      {'id': 'd', 'at': '2026-10-24T18:00:00+02:00'},
    ];
    expect(cheSortMail(rows).map((m) => m['id']), ['d', 'c', 'b', 'a', 'x']);
  });

  test('zone-less legacy values: a bare clock time is UTC, a bare date is not shifted', () {
    expect(cheMailInstant('2026-10-24T17:16:00'), DateTime.utc(2026, 10, 24, 17, 16));
    expect(when('2026-10-24T17:16:00', '2026-10-24T18:00:00Z'), '12:16 PM');
    expect(cheMailWhen({'at': '2026-10-18'}, now: DateTime.parse('2026-10-18T12:00:00Z'), offsetOf: chicago), '10/18');
    expect(cheMailWhen({'at': '2026-10-18T00:00:00.000Z', 'at_precision': 'day'}, offsetOf: chicago), '10/18');
    expect(cheMailWhen({'at': ''}), '');
    expect(cheMailWhen({'at': null}), '');
  });
}
