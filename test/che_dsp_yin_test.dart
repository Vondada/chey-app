// The FFT form of YIN's difference function must equal the direct double loop it replaced (2026-10-25: pitch
// correction of a 3-minute take went from ~26 s to ~2.6 s). Signals here are synthetic test inputs, not recordings.
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:chey/music/che_dsp.dart';
import 'package:flutter_test/flutter_test.dart';

Float32List _signal(int n, {required double hz, double noise = 0, int seed = 1}) {
  final r = math.Random(seed);
  return Float32List.fromList(List.generate(n, (i) {
    final t = i / cheStudioRate;
    final f = hz * (1 + 0.01 * math.sin(2 * math.pi * 5 * t));
    return 0.5 * math.sin(2 * math.pi * f * t) + 0.2 * math.sin(4 * math.pi * f * t) + noise * (r.nextDouble() * 2 - 1);
  }));
}

void main() {
  test('FFT difference function equals the direct loop to float rounding, on voiced, noisy and silent windows', () {
    final cases = {
      'voiced 220 Hz': _signal(8000, hz: 220),
      'voiced 880 Hz + noise': _signal(8000, hz: 880, noise: 0.1, seed: 3),
      'pure noise': _signal(8000, hz: 0, noise: 0.5, seed: 9),
      'silence': Float32List(8000),
    };
    final maxLag = (cheStudioRate / 70).floor();
    for (final MapEntry(key: name, value: x) in cases.entries) {
      for (final (from, size) in [(0, 2048), (1500, 4096), (3000, 2048)]) {
        final w = size - maxLag;
        final fast = cheYinDifference(x, from, w, maxLag), direct = cheYinDifferenceDirect(x, from, w, maxLag);
        var scale = 1e-9;
        for (var tau = 1; tau <= maxLag; tau++) {
          scale = math.max(scale, direct[tau]);
        }
        for (var tau = 1; tau <= maxLag; tau++) {
          expect((fast[tau] - direct[tau]).abs() / scale, lessThan(1e-9), reason: '$name from $from tau $tau');
        }
      }
    }
  });

  test('pitch detection gives the same answer as before on every frame of a sung-voice stand-in', () {
    final x = _signal(cheStudioRate, hz: 196, noise: 0.02);
    const win = 2048;
    final maxLag = (cheStudioRate / 70).floor();
    for (var from = 0; from + win < x.length; from += 512) {
      final w = win - maxLag;
      // Same dip search on the direct difference function, as cheDetectPitch did before.
      final d = cheYinDifferenceDirect(x, from, w, maxLag);
      var running = 0.0;
      var best = -1;
      final cmnd = Float64List(maxLag + 1);
      for (var tau = 1; tau <= maxLag; tau++) {
        running += d[tau];
        cmnd[tau] = running == 0 ? 1 : d[tau] * tau / running;
      }
      for (var tau = (cheStudioRate / 1000).floor(); tau <= maxLag; tau++) {
        if (cmnd[tau] < 0.15) {
          while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) {
            tau++;
          }
          best = tau;
          break;
        }
      }
      final hz = cheDetectPitch(x, from, win);
      expect(best > 0, hz > 0, reason: 'voicing decision at $from');
      if (best > 0) expect((cheStudioRate / hz - best).abs(), lessThan(1), reason: 'period at $from');
    }
  });
}
