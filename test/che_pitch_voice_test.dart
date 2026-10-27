// Pitch correction measured on a sung, voice-like take rather than on pure tones.
//
// A real CC0 or public-domain recording could not be fetched from the development machine (its network proxy
// refuses Wikimedia Commons, OpenSLR and Hugging Face), so this take is synthesised the way a voice is produced:
// a glottal pulse train (Rosenberg pulses) with cycle-to-cycle jitter and shimmer, vibrato and slow drift, portamento
// between notes, three vowel formants (an "ah": 800, 1150 and 2900 Hz), breath noise, and unvoiced consonant bursts
// between the notes. The sung notes are deliberately out of tune by 18 to 32 cents. The test measures, frame by frame
// with YIN, how far the voiced frames are from the nearest note before and after correction.
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:chey/music/che_dsp.dart';
import 'package:flutter_test/flutter_test.dart';

const sr = cheStudioRate;

/// A sung phrase: (MIDI note, cents off, seconds) per note, with a consonant burst before each.
Float32List singVoice(List<(int, double, double)> notes, {int seed = 3, double vibratoCents = 35}) {
  final rng = math.Random(seed);
  final out = <double>[];
  // Formant resonators (two-pole), "ah".
  const formants = [(800.0, 80.0, 1.0), (1150.0, 90.0, 0.5), (2900.0, 120.0, 0.18)];
  final state = [for (final _ in formants) [0.0, 0.0]];
  double resonate(int k, double input) {
    final (f, bw, gain) = formants[k];
    final r = math.exp(-math.pi * bw / sr);
    final a1 = 2 * r * math.cos(2 * math.pi * f / sr), a2 = -r * r;
    final y = (1 - r) * input + a1 * state[k][0] + a2 * state[k][1];
    state[k][1] = state[k][0];
    state[k][0] = y;
    return y * gain;
  }

  var prevMidi = notes.first.$1 + notes.first.$2 / 100;
  for (final (note, off, seconds) in notes) {
    // An unvoiced consonant ("s"/"t") burst: 70 ms of filtered noise, nothing pitched.
    for (var i = 0; i < (0.07 * sr).round(); i++) {
      out.add((rng.nextDouble() * 2 - 1) * 0.05 * math.sin(math.pi * i / (0.07 * sr)));
    }
    final target = note + off / 100;
    final n = (seconds * sr).round();
    var phase = 0.0;
    var periodJitter = 1.0, amp = 1.0;
    for (var i = 0; i < n; i++) {
      final t = i / sr;
      // 60 ms portamento from the last note, then vibrato that fades in after 150 ms, plus a slow wander.
      final glide = math.min(1.0, t / 0.06);
      final vib = vibratoCents * math.min(1.0, math.max(0.0, (t - 0.15) / 0.2)) * math.sin(2 * math.pi * 5.5 * t);
      final wander = 6 * math.sin(2 * math.pi * 0.7 * t + seed);
      final midi = prevMidi + (target - prevMidi) * glide + (vib + wander) / 100;
      final hz = 440 * math.pow(2, (midi - 69) / 12) * periodJitter;
      phase += hz / sr;
      if (phase >= 1) {
        phase -= 1;
        periodJitter = 1 + (rng.nextDouble() - 0.5) * 0.01; // about 0.5% jitter
        amp = 1 + (rng.nextDouble() - 0.5) * 0.1; // about 5% shimmer
      }
      // Rosenberg glottal pulse: opening over 40% of the cycle, closing over 16%, closed for the rest.
      final g = phase < 0.4
          ? 0.5 * (1 - math.cos(math.pi * phase / 0.4))
          : phase < 0.56
              ? math.cos(math.pi * (phase - 0.4) / 0.32)
              : 0.0;
      final source = amp * (g - 0.3) + (rng.nextDouble() - 0.5) * 0.02; // breath
      var s = 0.0;
      for (var k = 0; k < formants.length; k++) {
        s += resonate(k, source);
      }
      final env = math.min(1.0, math.min(i / (0.02 * sr), (n - i) / (0.03 * sr)));
      out.add(s * env);
    }
    prevMidi = target;
  }
  var peak = 1e-9;
  for (final v in out) {
    peak = math.max(peak, v.abs());
  }
  return Float32List.fromList([for (final v in out) 0.6 * v / peak]);
}

/// Mean and 90th-percentile distance, in cents, of voiced frames from the nearest note of the scale.
(double mean, double p90, int frames) offTune(Float32List x, {int key = 0, String scale = 'chromatic'}) {
  const win = 2048, hop = 1024;
  final d = <double>[];
  for (var s = 0; s + win * 2 < x.length; s += hop) {
    final hz = cheDetectPitch(x, s, win);
    if (hz <= 0) continue;
    final near = cheNearestNoteHz(hz, key: key, scale: scale);
    d.add((1200 * math.log(hz / near) / math.ln2).abs());
  }
  d.sort();
  final mean = d.isEmpty ? 0.0 : d.reduce((a, b) => a + b) / d.length;
  return (mean, d.isEmpty ? 0.0 : d[(d.length * 0.9).floor().clamp(0, d.length - 1)], d.length);
}

void main() {
  // A3 +25, C4 -30, D4 +18, E4 -22, D4 +32, C4 -20: an out-of-tune phrase sung with vibrato.
  final phrase = [(57, 25.0, 0.6), (60, -30.0, 0.6), (62, 18.0, 0.5), (64, -22.0, 0.6), (62, 32.0, 0.5), (60, -20.0, 0.7)];

  test('hard pitch correction pulls a sung, vibrato voice onto the notes and keeps its length', () {
    final take = singVoice(phrase);
    final (before, before90, n) = offTune(take);
    final fixed = Float32List.fromList(take);
    final report = chePitchCorrect(fixed, strength: 1);
    final (after, after90, m) = offTune(fixed);
    // ignore: avoid_print
    print('voice-like take, hard correction: off-tune mean ${before.toStringAsFixed(1)} -> ${after.toStringAsFixed(1)} cents, '
        '90th percentile ${before90.toStringAsFixed(1)} -> ${after90.toStringAsFixed(1)} cents, voiced frames $n -> $m, '
        'mean correction ${report.meanCorrectionCents.toStringAsFixed(1)} cents');
    expect(before, greaterThan(18), reason: 'the take really is out of tune');
    expect(after, lessThan(before / 3), reason: 'hard correction removes most of the error');
    expect(after90, lessThan(20));
    expect(m, greaterThan(n * 0.8), reason: 'the voice stays pitched (no warbling into unvoiced noise)');
    expect(fixed.length, take.length, reason: 'timing is untouched');
  });

  test('natural correction (70%) moves a sung voice part way and keeps the vibrato', () {
    final take = singVoice(phrase, seed: 11);
    final (before, _, _) = offTune(take);
    final fixed = Float32List.fromList(take);
    chePitchCorrect(fixed, strength: 0.7);
    final (after, _, _) = offTune(fixed);
    // ignore: avoid_print
    print('voice-like take, natural 70%: off-tune mean ${before.toStringAsFixed(1)} -> ${after.toStringAsFixed(1)} cents');
    expect(after, lessThan(before * 0.75));
    expect(after, greaterThan(2), reason: 'natural correction leaves some of the singer\'s own movement');
  });

  test('in C major, a sung F# that is 40 cents flat goes to G or F, never stays between them', () {
    final take = singVoice([(66, -40.0, 0.8)], seed: 5, vibratoCents: 10);
    final fixed = Float32List.fromList(take);
    chePitchCorrect(fixed, strength: 1, key: 0, scale: 'major');
    final (after, _, _) = offTune(fixed, scale: 'major');
    // ignore: avoid_print
    print('voice-like F# in C major: off-scale mean after ${after.toStringAsFixed(1)} cents');
    expect(after, lessThan(15));
  });
}
