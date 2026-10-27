// Phase 1 chart math (owner, 2026-10-26): MACD, ATR and Heikin-Ashi, checked against values worked out by hand.
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/rooms/che_chart_indicators.dart';

CheIndicatorBar bar(int i, double o, double h, double l, double c) =>
    CheIndicatorBar(DateTime.utc(2026, 10, 26, 14, i), o, h, l, c);

void main() {
  test('MACD of a flat price is zero, and each part starts only once it has history', () {
    final closes = List<double>.filled(40, 5);
    final m = macd(closes);
    expect(m.macd[24], isNull, reason: 'EMA 26 has no value before bar 25');
    expect(m.macd[25], closeTo(0, 1e-9));
    expect(m.signal[32], isNull, reason: 'the signal needs 9 MACD values, so the first is at bar 33');
    expect(m.signal[33], closeTo(0, 1e-9));
    expect(m.hist[39], closeTo(0, 1e-9));
  });

  test('MACD line is EMA 12 minus EMA 26 on a rising series', () {
    final closes = [for (var i = 0; i < 40; i++) 100.0 + i];
    final m = macd(closes);
    final f = ema(closes, 12), s = ema(closes, 26);
    expect(m.macd[39], closeTo(f[39]! - s[39]!, 1e-9));
    expect(m.macd[39]! > 0, isTrue, reason: 'a rising series puts the fast average above the slow one');
  });

  test('ATR of bars with a true range of 2 is 2 once seeded', () {
    final bars = [for (var i = 0; i < 6; i++) bar(i, 10, 11, 9, 10)];
    final a = atr(bars, 3);
    expect(a[0], isNull);
    expect(a[1], isNull);
    expect(a[2], closeTo(2, 1e-9));
    expect(a[5], closeTo(2, 1e-9));
  });

  test('ATR reaches back to the previous close when it is outside the bar', () {
    // Bar 1 gaps up: high 16 against a previous close of 10 gives a true range of 6, not 2.
    final bars = [bar(0, 10, 11, 9, 10), bar(1, 15, 16, 14, 15), bar(2, 15, 16, 14, 15)];
    final a = atr(bars, 2);
    expect(a[1], closeTo((2 + 6) / 2, 1e-9));
  });

  test('Heikin-Ashi averages the prices and keeps the time and volume', () {
    final ha = heikinAshi([
      CheIndicatorBar(DateTime.utc(2026, 10, 26, 14, 0), 10, 12, 9, 11, 500),
      CheIndicatorBar(DateTime.utc(2026, 10, 26, 14, 1), 11, 13, 10, 12, 700),
    ]);
    expect(ha[0].c, closeTo(10.5, 1e-9));
    expect(ha[0].o, closeTo(10.5, 1e-9));
    expect(ha[0].h, closeTo(12, 1e-9));
    expect(ha[0].l, closeTo(9, 1e-9));
    expect(ha[1].o, closeTo(10.5, 1e-9));
    expect(ha[1].c, closeTo(11.5, 1e-9));
    expect(ha[1].h, closeTo(13, 1e-9));
    expect(ha[1].l, closeTo(10, 1e-9));
    expect(ha[1].v, 700);
    expect(ha[1].t, DateTime.utc(2026, 10, 26, 14, 1));
  });

  test('Heikin-Ashi high is never below the open or close, and low never above them', () {
    final ha = heikinAshi([for (var i = 0; i < 30; i++) bar(i, 10 + i % 4, 14 + i % 3, 8 + i % 5, 11 + i % 2)]);
    for (final b in ha) {
      expect(b.h >= b.o && b.h >= b.c, isTrue);
      expect(b.l <= b.o && b.l <= b.c, isTrue);
    }
  });
}
