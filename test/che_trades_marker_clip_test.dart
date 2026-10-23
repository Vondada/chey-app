// CHE Trades (owner, 2026-10-23): a marker whose price is off the visible chart drew a column of glyphs over the text.
// Markers are placed only inside the chart box.
import 'dart:ui';

import 'package:chey/rooms/che_trading_chart.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const size = Size(400, 300);

  test('a marker above or below the chart box is not drawn', () {
    expect(markerOnChart(const Offset(100, -40), size), isFalse);
    expect(markerOnChart(const Offset(100, 340), size), isFalse);
    expect(markerOnChart(const Offset(-5, 100), size), isFalse);
  });

  test('a marker inside the chart box is drawn', () {
    expect(markerOnChart(const Offset(0, 0), size), isTrue);
    expect(markerOnChart(const Offset(120, 150), size), isTrue);
    expect(markerOnChart(const Offset(400, 300), size), isTrue);
  });
}
