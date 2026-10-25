// Vocal analysis for the Recording Studio: measures a recorded take (pitch range with YIN, average and peak level,
// sibilance energy, noise floor, dynamics, how far off-key it sits), suggests an effects chain from those numbers, and
// gives a before/after receipt when the chain is applied. Every number is measured from the samples; nothing is
// guessed or estimated by a model.
import 'dart:math' as math;
import 'dart:typed_data';

import 'che_dsp.dart';
import 'che_song.dart';

class CheVocalReport {
  const CheVocalReport({
    required this.seconds,
    required this.lowHz,
    required this.highHz,
    required this.medianHz,
    required this.voicedFraction,
    required this.rmsDb,
    required this.peakDb,
    required this.sibilanceDb,
    required this.noiseFloorDb,
    required this.dynamicRangeDb,
    required this.offKeyCents,
    required this.clippedSamples,
  });

  final double seconds;

  /// Sung range: the 5th and 95th percentile of the voiced frames' pitch (0 when nothing is pitched).
  final double lowHz, highHz, medianHz;
  final double voicedFraction;

  /// Average level of the active (non-silent) part, and the highest sample, in dBFS.
  final double rmsDb, peakDb;

  /// Energy between 5 and 10 kHz relative to the whole signal, over the active part, in dB ("s" and "sh" energy).
  final double sibilanceDb;

  /// The quietest tenth of 20 ms frames: the room and microphone hiss between phrases, in dBFS.
  final double noiseFloorDb;

  /// Spread between loud and soft phrases (90th minus 10th percentile of active frame levels), in dB.
  final double dynamicRangeDb;

  /// Mean distance of the voiced frames from the nearest semitone, in cents.
  final double offKeyCents;
  final int clippedSamples;

  static String note(double hz) {
    if (hz <= 0) return 'none';
    final m = cheMidiOf(hz).round();
    return '${cheNoteNames[m % 12]}${m ~/ 12 - 1}';
  }

  String get range => lowHz <= 0 ? 'no clear pitch' : '${note(lowHz)} to ${note(highHz)} (${lowHz.round()} to ${highHz.round()} Hz)';

  String describe() => 'Range $range; average ${rmsDb.toStringAsFixed(1)} dB, peak ${peakDb.toStringAsFixed(1)} dB; '
      'sibilance ${sibilanceDb.toStringAsFixed(1)} dB; noise floor ${noiseFloorDb.toStringAsFixed(1)} dB; '
      'dynamics ${dynamicRangeDb.toStringAsFixed(1)} dB; ${offKeyCents.toStringAsFixed(0)} cents off-key on average'
      '${clippedSamples > 0 ? '; $clippedSamples clipped samples' : ''}.';

  Map<String, dynamic> toJson() => {
        'seconds': seconds, 'low_hz': lowHz, 'high_hz': highHz, 'median_hz': medianHz, 'voiced': voicedFraction, 'rms_db': rmsDb,
        'peak_db': peakDb, 'sibilance_db': sibilanceDb, 'noise_floor_db': noiseFloorDb, 'dynamic_range_db': dynamicRangeDb,
        'off_key_cents': offKeyCents, 'clipped': clippedSamples,
      };
}

double _pct(List<double> sorted, double p) => sorted.isEmpty ? 0 : sorted[((sorted.length - 1) * p).round().clamp(0, sorted.length - 1)];

/// Measures one take (mono, at the studio rate).
CheVocalReport cheAnalyzeVocal(Float32List x, {int rate = cheStudioRate}) {
  final frame = (rate * 0.02).round();
  final levels = <double>[];
  for (var i = 0; i + frame <= x.length; i += frame) {
    levels.add(cheRmsDb(x, i, i + frame));
  }
  final sorted = [...levels]..sort();
  final floor = sorted.isEmpty ? -180.0 : _pct(sorted, 0.1);
  final activeGate = floor + 10;
  final active = <int>[for (var f = 0; f < levels.length; f++) if (levels[f] > activeGate && levels[f] > -70) f];

  // Level of the active part.
  var sum = 0.0, count = 0;
  for (final f in active) {
    for (var i = f * frame; i < (f + 1) * frame; i++) {
      sum += x[i] * x[i];
    }
    count += frame;
  }
  final rms = count == 0 ? -180.0 : cheDb(math.sqrt(sum / count));
  final activeLevels = [for (final f in active) levels[f]]..sort();
  final dyn = activeLevels.isEmpty ? 0.0 : _pct(activeLevels, 0.9) - _pct(activeLevels, 0.1);
  var clipped = 0;
  for (final v in x) {
    if (v.abs() >= 0.999) clipped++;
  }

  // Sibilance: band energy 5 to 10 kHz against the whole, over the active frames.
  final band = Float32List.fromList(x);
  CheBiquad.highPass(5000, rate: rate).run(band);
  CheBiquad.highPass(5000, rate: rate).run(band);
  CheBiquad.lowPass(10000, rate: rate).run(band);
  var eb = 0.0, et = 0.0;
  for (final f in active) {
    for (var i = f * frame; i < (f + 1) * frame; i++) {
      eb += band[i] * band[i];
      et += x[i] * x[i];
    }
  }
  final sib = et <= 0 ? -180.0 : 10 * math.log(math.max(eb, 1e-20) / et) / math.ln10;

  // Pitch every 2048 samples over active audio.
  const win = 2048, hop = 2048;
  final pitches = <double>[];
  var frames = 0;
  final activeSet = active.toSet();
  for (var s = 0; s + win < x.length; s += hop) {
    final f = (s + win ~/ 2) ~/ frame;
    if (!activeSet.contains(f)) continue;
    frames++;
    final hz = cheDetectPitch(x, s, win, rate: rate);
    if (hz > 0) pitches.add(hz);
  }
  pitches.sort();
  var cents = 0.0;
  for (final hz in pitches) {
    final m = cheMidiOf(hz);
    cents += (m - m.roundToDouble()).abs() * 100;
  }
  return CheVocalReport(
    seconds: x.length / rate,
    lowHz: _pct(pitches, 0.05),
    highHz: _pct(pitches, 0.95),
    medianHz: _pct(pitches, 0.5),
    voicedFraction: frames == 0 ? 0 : pitches.length / frames,
    rmsDb: rms,
    peakDb: chePeakDb(x),
    sibilanceDb: sib,
    noiseFloorDb: floor,
    dynamicRangeDb: dyn,
    offKeyCents: pitches.isEmpty ? 0 : cents / pitches.length,
    clippedSamples: clipped,
  );
}

/// A suggested chain for the measured voice, with the reason for each setting.
class CheVocalSuggestion {
  const CheVocalSuggestion(this.fx, this.reasons);
  final CheEffects fx;
  final List<String> reasons;
}

/// Turns a report into an effects chain. Thresholds are engineering rules of thumb, stated in each reason.
CheVocalSuggestion cheSuggestChain(CheVocalReport r) {
  final fx = CheEffects(preset: 'Personalized');
  final why = <String>[];
  if (r.noiseFloorDb > -60) {
    fx.noise = true;
    why.add('noise reduction, because the noise floor is ${r.noiseFloorDb.toStringAsFixed(0)} dB (above -60)');
  }
  final hp = r.lowHz > 0 ? (r.lowHz * 0.6 / 5).round() * 5.0 : 80.0;
  fx.highPass = hp.clamp(60, 120).toDouble();
  why.add(r.lowHz > 0
      ? 'high-pass at ${fx.highPass.round()} Hz, below your lowest note (${CheVocalReport.note(r.lowHz)}, ${r.lowHz.round()} Hz)'
      : 'high-pass at ${fx.highPass.round()} Hz');
  if (r.sibilanceDb > -16) {
    fx.deEss = 0.7;
  } else if (r.sibilanceDb > -22) {
    fx.deEss = 0.55;
  } else if (r.sibilanceDb > -28) {
    fx.deEss = 0.25;
  }
  if (fx.deEss > 0) {
    why.add('de-esser ${(fx.deEss * 100).round()}%, because sibilance is ${r.sibilanceDb.toStringAsFixed(0)} dB');
  } else {
    fx.eqHigh = 2;
    why.add('2 dB more air and no de-esser, because sibilance is low (${r.sibilanceDb.toStringAsFixed(0)} dB)');
  }
  fx.compress = r.dynamicRangeDb > 18 ? 0.6 : r.dynamicRangeDb > 10 ? 0.45 : 0.3;
  why.add('compression ${(fx.compress * 100).round()}%, for ${r.dynamicRangeDb.toStringAsFixed(0)} dB between loud and soft phrases');
  if (r.voicedFraction > 0.3 && r.offKeyCents > 18) {
    fx.pitch = r.offKeyCents > 30 ? 0.7 : 0.45;
    why.add('pitch correction ${(fx.pitch * 100).round()}%, since notes sit ${r.offKeyCents.round()} cents off on average');
  }
  fx
    ..reverb = 0.15
    ..room = 0.5;
  why.add('a light reverb (15%) for space');
  if (r.peakDb > -1) why.add('the take clips or nearly clips (peak ${r.peakDb.toStringAsFixed(1)} dB): record a little further from the mic');
  if (r.rmsDb < -32) why.add('the take is quiet (${r.rmsDb.toStringAsFixed(0)} dB average): raise its volume in the mixer or sing closer');
  return CheVocalSuggestion(fx, why);
}

/// A before/after receipt of the numbers that processing should change.
String cheVocalReceipt(CheVocalReport before, CheVocalReport after) {
  String row(String name, double a, double b, [String unit = 'dB']) => '$name ${a.toStringAsFixed(1)} to ${b.toStringAsFixed(1)} $unit';
  return [
    row('average level', before.rmsDb, after.rmsDb),
    row('peak', before.peakDb, after.peakDb),
    row('sibilance', before.sibilanceDb, after.sibilanceDb),
    row('noise floor', before.noiseFloorDb, after.noiseFloorDb),
    row('dynamics', before.dynamicRangeDb, after.dynamicRangeDb),
    row('off-key', before.offKeyCents, after.offKeyCents, 'cents'),
  ].join('; ');
}
