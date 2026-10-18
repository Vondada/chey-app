import 'package:chey/brain/che_frame_budget.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a run of slow frames enters economy, which paints every other tick; cheap frames bring full rate back', () {
    final b = CheFrameBudget();
    for (var i = 0; i < 19; i++) {
      b.observe(25);
    }
    expect(b.level, CheRenderLevel.full, reason: 'not yet twenty slow frames');
    b.observe(25);
    expect(b.level, CheRenderLevel.economy);
    expect(b.switches, 1);
    final admitted = [for (var i = 0; i < 6; i++) b.admitTick()];
    expect(admitted.where((a) => a).length, 3, reason: 'every other tick paints');
    for (var i = 0; i < 119; i++) {
      b.observe(8);
    }
    expect(b.level, CheRenderLevel.economy, reason: '120 cheap frames are needed');
    b.observe(8);
    expect(b.level, CheRenderLevel.full);
    expect(b.switches, 2);
    expect([for (var i = 0; i < 4; i++) b.admitTick()], everyElement(isTrue));
  });

  test('every re-entry doubles the recovery wait, so the level never flickers', () {
    final b = CheFrameBudget();
    void slow() {
      for (var i = 0; i < 20; i++) {
        b.observe(30);
      }
    }
    void fast(int n) {
      for (var i = 0; i < n; i++) {
        b.observe(6);
      }
    }
    slow();
    fast(120);
    expect(b.level, CheRenderLevel.full);
    slow();
    expect(b.level, CheRenderLevel.economy);
    fast(120);
    expect(b.level, CheRenderLevel.economy, reason: 'the second recovery needs twice as many cheap frames');
    fast(120);
    expect(b.level, CheRenderLevel.full);
    slow();
    fast(479);
    expect(b.level, CheRenderLevel.economy, reason: 'the third recovery needs four times as many');
    fast(1);
    expect(b.level, CheRenderLevel.full);
  });

  test('frames between the two thresholds change nothing, and one slow frame among fast ones does not', () {
    final b = CheFrameBudget();
    for (var i = 0; i < 500; i++) {
      b.observe(15);
    }
    expect(b.level, CheRenderLevel.full);
    for (var i = 0; i < 500; i++) {
      b.observe(i % 10 == 0 ? 40 : 8);
    }
    expect(b.level, CheRenderLevel.full);
    expect(b.switches, 0);
    expect(b.describe(), 'Rendering at full rate.');
    for (var i = 0; i < 20; i++) {
      b.observe(33.3);
    }
    expect(b.describe(), contains('economy'));
  });
}
