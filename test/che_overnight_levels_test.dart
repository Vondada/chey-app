import 'package:chey/rooms/che_trading_chart.dart';
import 'package:flutter_test/flutter_test.dart';

// The chart's 86-style overnight levels come from the Worker's chart API (`levels`). These maps mirror its shape.
void main() {
  test('levels: overnight high and low, plus entry, stop and target only when a signal exists', () {
    final forming = CheOvernightLevels.fromJson({
      'onHigh': 21450.5, 'onLow': 21310.25, 'bias': 'buy-side: the overnight high', 'stage': 'forming',
      'reason': 'Waiting for a close above the New York open.', 'signal': null,
    });
    expect(forming.levels.map((l) => l.kind), ['overnight_high', 'overnight_low']);
    expect(forming.levels.first.label, contains('86-style approx.'));
    expect(forming.spoken, contains('CHE approximation, not the P2P indicator'));
    expect(forming.spoken, contains('high 21,450.50, low 21,310.25'));
    expect(forming.spoken, contains('stage forming'));

    final fired = CheOvernightLevels.fromJson({
      'onHigh': 140, 'onLow': 100, 'bias': 'buy-side: the overnight high', 'stage': 'triggered',
      'signal': {'side': 'long', 'ref': 127, 'stop': 120.25, 'target': 140},
    });
    expect(fired.levels.map((l) => l.kind), ['overnight_high', 'overnight_low', 'entry', 'stop', 'target']);
    expect(fired.levels.firstWhere((l) => l.kind == 'stop').price, 120.25);
  });

  test('no range yet: an honest reason, no lines', () {
    final waiting = CheOvernightLevels.fromJson({'stage': 'waiting', 'reason': 'The overnight range is complete at 9:30 New York.'});
    expect(waiting.levels, isEmpty);
    expect(waiting.spoken, contains('approximation'));
    expect(CheOvernightLevels.fromJson(null).levels, isEmpty);
    expect(CheOvernightLevels.fromJson(null).spoken, isEmpty);
  });
}
