// CHE's ear: measures a finished mix on the iPhone with plain signal processing, no network and no model. Each number
// is a measurement with a known method, and the report says which:
//   tempo    onset-energy flux, autocorrelated over 60 to 200 BPM (integer frame lags, so about 2 BPM resolution)
//   key      Goertzel energy at each pitch class over C2 to B5, matched to Krumhansl and Kessler key profiles (1982)
//   loudness RMS in dBFS over the whole mix. This is NOT LUFS (no K-weighting or gating yet), and it is labelled so
//   dynamics crest factor, peak minus RMS, in dB: low means squashed, high means open
//   balance (approximate: one-pole filters) share of energy below 250 Hz, between 250 Hz and 4 kHz, and above 4 kHz
// These measure the audio. They are not a judgement of taste; Lyra's notes say what the numbers suggest.
import 'dart:math' as math;
import 'dart:typed_data';

class CheEarReport {
  const CheEarReport({
    required this.peakDb,
    required this.rmsDb,
    required this.crestDb,
    required this.tempoBpm,
    required this.key,
    required this.keyStrength,
    required this.lowShare,
    required this.midShare,
    required this.highShare,
    required this.seconds,
  });

  final double peakDb;
  final double rmsDb;
  final double crestDb;
  final double tempoBpm;
  final String key;
  final double keyStrength;
  final double lowShare;
  final double midShare;
  final double highShare;
  final double seconds;

  /// Lyra's plain notes, from the numbers only: what the mix does, and what it might change. Never a verdict on taste.
  List<String> notes() {
    final out = <String>[];
    if (crestDb < 8) {
      out.add('The dynamics are tight (crest ${crestDb.toStringAsFixed(1)} dB). A track that stays this flat can feel tired; try less compression on the master.');
    } else if (crestDb > 16) {
      out.add('The dynamics are wide (crest ${crestDb.toStringAsFixed(1)} dB). Quiet passages may get lost on a phone; a gentle compressor on the master can keep the energy up.');
    }
    if (peakDb > -0.5) {
      out.add('The peak is ${peakDb.toStringAsFixed(1)} dBFS, too close to full scale. The limiter ceiling should sit near -1 dB.');
    }
    if (lowShare > 0.6) {
      out.add('Most of the energy is below 250 Hz (${(lowShare * 100).round()} percent). Check the low end is not muddying the vocal.');
    } else if (highShare > 0.35) {
      out.add('The top end is strong (${(highShare * 100).round()} percent above 4 kHz). Check for harshness on a phone speaker.');
    }
    return out;
  }

  String summary() {
    final tempo = tempoBpm > 0 ? '${tempoBpm.round()} BPM' : 'no clear pulse';
    return 'Tempo $tempo. Key $key, match ${(keyStrength * 100).round()} percent. Loudness ${rmsDb.toStringAsFixed(1)} dBFS RMS, '
        'peak ${peakDb.toStringAsFixed(1)} dBFS, crest ${crestDb.toStringAsFixed(1)} dB. Balance: low '
        '${(lowShare * 100).round()}, mid ${(midShare * 100).round()}, high ${(highShare * 100).round()} percent.';
  }
}

const _majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const _minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const _names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

double _rmsDb(Float64List x) {
  if (x.isEmpty) return -180;
  var s = 0.0;
  for (final v in x) {
    s += v * v;
  }
  final rms = math.sqrt(s / x.length);
  return rms <= 1e-9 ? -180 : 20 * math.log(rms) / math.ln10;
}

Float64List _mono(Float32List l, Float32List r) {
  final n = math.min(l.length, r.length);
  final m = Float64List(n);
  for (var i = 0; i < n; i++) {
    m[i] = (l[i] + r[i]) / 2;
  }
  return m;
}

/// Tempo from onset flux: positive energy change per 512-sample frame, autocorrelated over the lags of 60 to 200 BPM.
double earTempo(Float64List mono, int rate) {
  const hop = 512;
  final frames = mono.length ~/ hop;
  if (frames < 8) return 0;
  final energy = Float64List(frames);
  for (var f = 0; f < frames; f++) {
    var s = 0.0;
    for (var i = f * hop; i < (f + 1) * hop; i++) {
      s += mono[i] * mono[i];
    }
    energy[f] = s / hop;
  }
  final flux = Float64List(frames);
  for (var f = 1; f < frames; f++) {
    flux[f] = math.max(0, energy[f] - energy[f - 1]);
  }
  final framesPerSecond = rate / hop;
  final minLag = (framesPerSecond * 60 / 200).floor().clamp(1, frames - 2);
  final maxLag = (framesPerSecond * 60 / 60).ceil().clamp(minLag + 1, frames - 1);
  var bestLag = 0;
  var best = 0.0;
  for (var lag = minLag; lag <= maxLag; lag++) {
    var acc = 0.0;
    for (var f = lag; f < frames; f++) {
      acc += flux[f] * flux[f - lag];
    }
    if (acc > best) {
      best = acc;
      bestLag = lag;
    }
  }
  if (bestLag == 0) return 0;
  return 60 * framesPerSecond / bestLag;
}

/// Energy of one frequency, Goertzel over the whole signal.
double _goertzelPower(Float64List x, double hz, int rate) {
  final w = 2 * math.pi * hz / rate;
  final coeff = 2 * math.cos(w);
  var s1 = 0.0, s2 = 0.0;
  for (final v in x) {
    final s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/// Key from the energy of the twelve pitch classes over C2 to B5, matched against major and minor profiles.
(String, double) earKey(Float64List mono, int rate) {
  final n = math.min(mono.length, rate * 2); // the first two seconds are enough for a key
  final x = Float64List.sublistView(mono, 0, n);
  final chroma = List<double>.filled(12, 0);
  for (var midi = 36; midi <= 83; midi++) {
    final hz = 440 * math.pow(2, (midi - 69) / 12).toDouble();
    chroma[midi % 12] += _goertzelPower(x, hz, rate);
  }
  final total = chroma.fold<double>(0, (a, b) => a + b);
  if (total <= 0) return ('no clear key', 0);
  double corr(List<double> a, List<double> b) {
    final ma = a.reduce((p, q) => p + q) / a.length;
    final mb = b.reduce((p, q) => p + q) / b.length;
    var num = 0.0, da = 0.0, db = 0.0;
    for (var i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) * (a[i] - ma);
      db += (b[i] - mb) * (b[i] - mb);
    }
    return da <= 0 || db <= 0 ? 0 : num / math.sqrt(da * db);
  }

  var bestName = 'no clear key';
  var best = -2.0;
  for (var root = 0; root < 12; root++) {
    final maj = List<double>.generate(12, (i) => _majorProfile[(i - root + 12) % 12]);
    final min = List<double>.generate(12, (i) => _minorProfile[(i - root + 12) % 12]);
    final cm = corr(chroma, maj);
    final cn = corr(chroma, min);
    if (cm > best) {
      best = cm;
      bestName = '${_names[root]} major';
    }
    if (cn > best) {
      best = cn;
      bestName = '${_names[root]} minor';
    }
  }
  return (bestName, best.clamp(0, 1).toDouble());
}

/// Energy share of low (under 250 Hz), mid (250 Hz to 4 kHz) and high (above 4 kHz), with one-pole filters.
(double, double, double) earBalance(Float64List mono, int rate) {
  double lowE = 0, midE = 0, highE = 0;
  final aLow = 1 - math.exp(-2 * math.pi * 250 / rate);
  final aHigh = 1 - math.exp(-2 * math.pi * 4000 / rate);
  var lp250 = 0.0, lp4k = 0.0;
  for (final v in mono) {
    lp250 += aLow * (v - lp250);
    lp4k += aHigh * (v - lp4k);
    final low = lp250;
    final high = v - lp4k;
    final mid = lp4k - lp250;
    lowE += low * low;
    midE += mid * mid;
    highE += high * high;
  }
  final total = lowE + midE + highE;
  if (total <= 0) return (0, 0, 0);
  return (lowE / total, midE / total, highE / total);
}

/// Measures a stereo mix. Empty audio gives a report with zeros, never an error.
CheEarReport cheListen(Float32List left, Float32List right, {int rate = 44100}) {
  final mono = _mono(left, right);
  final seconds = mono.length / rate;
  if (mono.isEmpty) {
    return const CheEarReport(peakDb: -180, rmsDb: -180, crestDb: 0, tempoBpm: 0, key: 'no clear key', keyStrength: 0,
        lowShare: 0, midShare: 0, highShare: 0, seconds: 0);
  }
  var peak = 0.0;
  for (final v in mono) {
    peak = math.max(peak, v.abs());
  }
  final peakDb = peak <= 1e-9 ? -180.0 : 20 * math.log(peak) / math.ln10;
  final rmsDb = _rmsDb(mono);
  final (key, strength) = earKey(mono, rate);
  final (low, mid, high) = earBalance(mono, rate);
  return CheEarReport(
    peakDb: peakDb,
    rmsDb: rmsDb,
    crestDb: peakDb - rmsDb,
    tempoBpm: earTempo(mono, rate),
    key: key,
    keyStrength: strength,
    lowShare: low,
    midShare: mid,
    highShare: high,
    seconds: seconds,
  );
}
