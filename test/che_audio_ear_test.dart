import 'dart:math' as math;
import 'dart:typed_data';

import 'package:chey/music/che_audio_ear.dart';
import 'package:flutter_test/flutter_test.dart';

const _rate = 44100;

Float32List _tone(double seconds, List<(double, double)> partials) {
  final n = (seconds * _rate).round();
  final out = Float32List(n);
  for (var i = 0; i < n; i++) {
    var v = 0.0;
    for (final (hz, amp) in partials) {
      v += amp * math.sin(2 * math.pi * hz * i / _rate);
    }
    out[i] = v;
  }
  return out;
}

Float32List _clicks(double seconds, double bpm) {
  final n = (seconds * _rate).round();
  final out = Float32List(n);
  final every = (60 / bpm * _rate).round();
  for (var s = 0; s < n; s += every) {
    for (var k = 0; k < 220 && s + k < n; k++) {
      out[s + k] = 0.9 * math.exp(-k / 25) * math.sin(2 * math.pi * 1500 * k / _rate);
    }
  }
  return out;
}

void main() {
  test('a 120 BPM click track is measured at about 120 BPM', () {
    final clicks = _clicks(8, 120);
    final r = cheListen(clicks, clicks, rate: _rate);
    expect(r.tempoBpm, closeTo(120, 3));
  });

  test('an A major chord is read as A major', () {
    final chord = _tone(3, [(220, 0.3), (277.18, 0.3), (329.63, 0.3)]);
    final r = cheListen(chord, chord, rate: _rate);
    expect(r.key, 'A major');
    expect(r.keyStrength, greaterThan(0.5));
  });

  test('a 1 kHz sine at 0.5 amplitude reads -9.0 dB RMS, -6.0 dB peak and a 3 dB crest', () {
    final sine = _tone(2, [(1000, 0.5)]);
    final r = cheListen(sine, sine, rate: _rate);
    expect(r.rmsDb, closeTo(-9.03, 0.15));
    expect(r.peakDb, closeTo(-6.02, 0.15));
    expect(r.crestDb, closeTo(3.01, 0.2));
  });

  test('a 100 Hz tone is mostly low energy, a 10 kHz tone is mostly high energy', () {
    final bass = _tone(2, [(100, 0.5)]);
    final hiss = _tone(2, [(10000, 0.5)]);
    // One-pole filters leak, so the band split is approximate: a pure 100 Hz tone measures about 88 percent low.
    expect(cheListen(bass, bass, rate: _rate).lowShare, greaterThan(0.8));
    // A pure 10 kHz tone measures about 77 percent high, for the same reason.
    expect(cheListen(hiss, hiss, rate: _rate).highShare, greaterThan(0.7));
  });

  test('empty audio gives a zero report, not an error', () {
    final r = cheListen(Float32List(0), Float32List(0), rate: _rate);
    expect(r.seconds, 0);
    expect(r.tempoBpm, 0);
    expect(r.key, 'no clear key');
  });

  test('a flat signal gets a tight-dynamics note from the numbers alone', () {
    final sine = _tone(2, [(1000, 0.5)]);
    final notes = cheListen(sine, sine, rate: _rate).notes();
    expect(notes.any((n) => n.contains('tight')), isTrue);
  });
}
