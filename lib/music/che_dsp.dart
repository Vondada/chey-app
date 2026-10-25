// The Recording Studio's sound processing, in pure Dart over real PCM samples (no plugin, no network, nothing
// simulated). Filters follow Robert Bristow-Johnson's Audio EQ Cookbook; the reverb is Jezar's public-domain
// Freeverb structure; pitch detection is the YIN method (de Cheveigné and Kawahara, 2002); pitch shifting is a
// windowed granular overlap-add. Every effect works on a mono plane at the studio rate.
import 'dart:math' as math;
import 'dart:typed_data';

const int cheStudioRate = 44100;

double cheDb(double gain) => gain <= 1e-9 ? -180 : 20 * math.log(gain) / math.ln10;
double cheGain(double db) => math.pow(10, db / 20).toDouble();

/// Peak level of [x] in dBFS.
double chePeakDb(Float32List x) {
  var p = 0.0;
  for (final v in x) {
    final a = v.abs();
    if (a > p) p = a;
  }
  return cheDb(p);
}

/// RMS level of [x] in dBFS (over the whole plane, or [from]..[to]).
double cheRmsDb(Float32List x, [int from = 0, int? to]) {
  final end = (to ?? x.length).clamp(0, x.length);
  if (end <= from) return -180;
  var s = 0.0;
  for (var i = from; i < end; i++) {
    s += x[i] * x[i];
  }
  return cheDb(math.sqrt(s / (end - from)));
}

/// One biquad section (Audio EQ Cookbook). Process with [run].
class CheBiquad {
  CheBiquad._(this.b0, this.b1, this.b2, this.a1, this.a2);
  final double b0, b1, b2, a1, a2;

  factory CheBiquad._norm(double b0, double b1, double b2, double a0, double a1, double a2) =>
      CheBiquad._(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);

  static double _w(double f, int rate) => 2 * math.pi * f / rate;

  factory CheBiquad.lowPass(double f, {double q = 0.7071, int rate = cheStudioRate}) {
    final w = _w(f, rate), c = math.cos(w), al = math.sin(w) / (2 * q);
    return CheBiquad._norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  factory CheBiquad.highPass(double f, {double q = 0.7071, int rate = cheStudioRate}) {
    final w = _w(f, rate), c = math.cos(w), al = math.sin(w) / (2 * q);
    return CheBiquad._norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  factory CheBiquad.bandPass(double f, {double q = 1, int rate = cheStudioRate}) {
    final w = _w(f, rate), c = math.cos(w), al = math.sin(w) / (2 * q);
    return CheBiquad._norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  factory CheBiquad.peak(double f, double db, {double q = 1, int rate = cheStudioRate}) {
    final a = math.pow(10, db / 40).toDouble(), w = _w(f, rate), c = math.cos(w), al = math.sin(w) / (2 * q);
    return CheBiquad._norm(1 + al * a, -2 * c, 1 - al * a, 1 + al / a, -2 * c, 1 - al / a);
  }

  factory CheBiquad.lowShelf(double f, double db, {int rate = cheStudioRate}) {
    final a = math.pow(10, db / 40).toDouble(), w = _w(f, rate), c = math.cos(w);
    final al = math.sin(w) / 2 * math.sqrt(2), sa = 2 * math.sqrt(a) * al;
    return CheBiquad._norm(a * ((a + 1) - (a - 1) * c + sa), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - sa),
        (a + 1) + (a - 1) * c + sa, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - sa);
  }

  factory CheBiquad.highShelf(double f, double db, {int rate = cheStudioRate}) {
    final a = math.pow(10, db / 40).toDouble(), w = _w(f, rate), c = math.cos(w);
    final al = math.sin(w) / 2 * math.sqrt(2), sa = 2 * math.sqrt(a) * al;
    return CheBiquad._norm(a * ((a + 1) + (a - 1) * c + sa), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sa),
        (a + 1) - (a - 1) * c + sa, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sa);
  }

  /// Filters [x] in place (direct form I).
  void run(Float32List x) {
    var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
    for (var i = 0; i < x.length; i++) {
      final v = x[i];
      final y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
  }
}

/// Three-band EQ: low shelf at 120 Hz, a bell at [midHz], high shelf at 8 kHz. Gains in dB; 0 leaves the band alone.
void cheEq(Float32List x, {double lowDb = 0, double midDb = 0, double midHz = 1500, double highDb = 0, double highPassHz = 0}) {
  if (highPassHz > 0) CheBiquad.highPass(highPassHz).run(x);
  if (lowDb != 0) CheBiquad.lowShelf(120, lowDb).run(x);
  if (midDb != 0) CheBiquad.peak(midHz, midDb, q: 0.9).run(x);
  if (highDb != 0) CheBiquad.highShelf(8000, highDb).run(x);
}

/// Feed-forward compressor with a peak envelope. Above [thresholdDb] the level rises 1/[ratio] as fast.
void cheCompress(Float32List x,
    {double thresholdDb = -18, double ratio = 3, double attackMs = 8, double releaseMs = 120, double makeupDb = 0, int rate = cheStudioRate}) {
  final att = math.exp(-1 / (rate * attackMs / 1000));
  final rel = math.exp(-1 / (rate * releaseMs / 1000));
  final makeup = cheGain(makeupDb);
  var env = 0.0;
  for (var i = 0; i < x.length; i++) {
    final a = x[i].abs();
    env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
    final lvl = cheDb(env);
    final over = lvl - thresholdDb;
    final g = over > 0 ? cheGain(-over * (1 - 1 / ratio)) : 1.0;
    x[i] = x[i] * g * makeup;
  }
}

/// Peak limiter: nothing leaves above [ceilingDb]. Instant attack, smooth release.
void cheLimit(Float32List x, {double ceilingDb = -1, double releaseMs = 60, int rate = cheStudioRate}) {
  final ceil = cheGain(ceilingDb);
  final rel = math.exp(-1 / (rate * releaseMs / 1000));
  var g = 1.0;
  for (var i = 0; i < x.length; i++) {
    final a = x[i].abs();
    final need = a > ceil ? ceil / a : 1.0;
    g = need < g ? need : rel * g + (1 - rel) * need;
    x[i] = (x[i] * g).clamp(-ceil, ceil);
  }
}

/// Feedback echo: [ms] apart, each repeat [feedback] as loud, blended at [mix].
Float32List cheDelay(Float32List x, {double ms = 350, double feedback = 0.35, double mix = 0.25, int rate = cheStudioRate}) {
  final d = (rate * ms / 1000).round().clamp(1, rate * 4);
  final tail = (d * (math.log(0.001) / math.log(feedback.clamp(0.01, 0.95)))).ceil().clamp(d, rate * 6);
  final out = Float32List(x.length + tail);
  final line = Float32List(x.length + tail);
  for (var i = 0; i < out.length; i++) {
    final dry = i < x.length ? x[i] : 0.0;
    final echo = i >= d ? line[i - d] : 0.0;
    line[i] = dry + echo * feedback;
    out[i] = dry + echo * mix;
  }
  return out;
}

/// Freeverb (Jezar, public domain): eight damped combs into four allpasses. [room] 0..1 sets the decay, [mix] the
/// wet level. The tail past the end of [x] is kept.
Float32List cheReverb(Float32List x, {double room = 0.6, double damp = 0.4, double mix = 0.25, int rate = cheStudioRate}) {
  const combTune = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apTune = [556, 441, 341, 225];
  final scale = rate / 44100;
  final fb = 0.7 + 0.28 * room.clamp(0, 1);
  final tail = (rate * (0.6 + 2.4 * room.clamp(0, 1))).round();
  final n = x.length + tail;
  final wet = Float32List(n);
  for (final t in combTune) {
    final len = (t * scale).round();
    final buf = Float32List(len);
    var idx = 0;
    var store = 0.0;
    for (var i = 0; i < n; i++) {
      final input = i < x.length ? x[i] * 0.015 : 0.0;
      final y = buf[idx];
      store = y * (1 - damp) + store * damp;
      buf[idx] = input + store * fb;
      wet[i] += y;
      idx = idx + 1 == len ? 0 : idx + 1;
    }
  }
  for (final t in apTune) {
    final len = (t * scale).round();
    final buf = Float32List(len);
    var idx = 0;
    for (var i = 0; i < n; i++) {
      final b = buf[idx];
      final v = wet[i];
      buf[idx] = v + b * 0.5;
      wet[i] = b - v;
      idx = idx + 1 == len ? 0 : idx + 1;
    }
  }
  final out = Float32List(n);
  for (var i = 0; i < n; i++) {
    out[i] = (i < x.length ? x[i] : 0.0) + wet[i] * mix * 3;
  }
  return out;
}

/// Noise reduction: a high-pass at 80 Hz and a downward expander whose threshold comes from the quietest tenth of the
/// take (the room tone), so breaths and hiss between phrases drop by [depthDb] while singing passes untouched.
/// Returns the measured noise floor in dBFS.
double cheReduceNoise(Float32List x, {double depthDb = 18, int rate = cheStudioRate}) {
  CheBiquad.highPass(80).run(x);
  final frame = (rate * 0.02).round();
  final levels = <double>[];
  for (var i = 0; i + frame <= x.length; i += frame) {
    levels.add(cheRmsDb(x, i, i + frame));
  }
  if (levels.isEmpty) return -180;
  final sorted = [...levels]..sort();
  final floor = sorted[(sorted.length * 0.1).floor().clamp(0, sorted.length - 1)];
  final open = floor + 9;
  final cut = cheGain(-depthDb);
  final att = math.exp(-1 / (rate * 0.002)), rel = math.exp(-1 / (rate * 0.08));
  var g = 1.0;
  for (var i = 0; i < x.length; i++) {
    final f = (i ~/ frame).clamp(0, levels.length - 1);
    final target = levels[f] >= open ? 1.0 : cut;
    g = target > g ? att * g + (1 - att) * target : rel * g + (1 - rel) * target;
    x[i] *= g;
  }
  return floor;
}

/// YIN fundamental frequency of one window, or 0 when nothing pitched is there.
double cheDetectPitch(Float32List x, int from, int size, {int rate = cheStudioRate, double minHz = 70, double maxHz = 1000, double threshold = 0.15}) {
  final maxLag = (rate / minHz).floor(), minLag = (rate / maxHz).floor();
  final w = math.min(size, x.length - from) - maxLag;
  if (w < 64) return 0;
  final d = Float64List(maxLag + 1);
  for (var tau = 1; tau <= maxLag; tau++) {
    var s = 0.0;
    for (var j = 0; j < w; j++) {
      final diff = x[from + j] - x[from + j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  var running = 0.0;
  final cmnd = Float64List(maxLag + 1)..[0] = 1;
  for (var tau = 1; tau <= maxLag; tau++) {
    running += d[tau];
    cmnd[tau] = running == 0 ? 1 : d[tau] * tau / running;
  }
  var best = -1;
  for (var tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) {
        tau++;
      }
      best = tau;
      break;
    }
  }
  if (best < 0) return 0;
  // Parabolic interpolation around the dip for sub-sample accuracy.
  var t = best.toDouble();
  if (best > 1 && best < maxLag) {
    final a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    final den = a - 2 * b + c;
    if (den.abs() > 1e-12) t = best + 0.5 * (a - c) / den;
  }
  return rate / t;
}

const cheNoteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const cheScales = {
  'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'major': [0, 2, 4, 5, 7, 9, 11],
  'minor': [0, 2, 3, 5, 7, 8, 10],
};

double cheMidiOf(double hz) => 69 + 12 * math.log(hz / 440) / math.ln2;
double cheHzOf(double midi) => 440 * math.pow(2, (midi - 69) / 12).toDouble();

/// The nearest note of [scale] in [key] (0 = C) to [hz].
double cheNearestNoteHz(double hz, {int key = 0, String scale = 'chromatic'}) {
  final steps = cheScales[scale] ?? cheScales['chromatic']!;
  final m = cheMidiOf(hz);
  var best = m.roundToDouble(), bestDist = 99.0;
  for (var octave = (m / 12).floor() - 1; octave <= (m / 12).floor() + 1; octave++) {
    for (final s in steps) {
      final cand = (octave * 12 + key + s).toDouble();
      final dist = (cand - m).abs();
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }
  return cheHzOf(best);
}

/// How far past the midpoint between two notes (in semitones) the voice must go before the correction changes note
/// at once; nearer than that, it changes only if the voice stays there.
const cheNoteSwitchSemitones = 0.3;

/// What pitch correction did to one take.
class ChePitchReport {
  const ChePitchReport(this.frames, this.pitched, this.meanCorrectionCents);
  final int frames;
  final int pitched;
  final double meanCorrectionCents;
}

/// Pitch correction ("Auto-Tune" style): YIN finds the sung pitch every 512 samples (11.6 ms), each frame is pulled
/// toward the nearest note of the scale by [strength] (1 = hard snap, 0.5 = natural), and TD-PSOLA re-pitches it:
/// two-period grains taken one input period apart are laid down one corrected period apart, so the pitch moves and
/// the timing does not. Unpitched frames (breaths, consonants) are copied through unchanged.
///
/// Note hysteresis keeps a held note on one target: a sung vibrato that swings past the midpoint between two notes
/// would otherwise flip the correction between them inside one note. The target moves to another note only when the
/// voice is clearly nearer it ([cheNoteSwitchSemitones] beyond the midpoint) or stays nearer it for about 70 ms.
ChePitchReport chePitchCorrect(Float32List x, {double strength = 1, int key = 0, String scale = 'chromatic', int rate = cheStudioRate}) {
  const win = 2048, hop = 512, flat = 256, holdFrames = 6;
  if (x.length < win * 2 || strength <= 0) return const ChePitchReport(0, 0, 0);
  // Pitch and correction ratio per frame.
  final frames = (x.length / hop).ceil();
  final hzAt = Float64List(frames), ratioAt = Float64List(frames)..fillRange(0, frames, 1);
  var pitched = 0;
  var cents = 0.0;
  double? held; // the note (MIDI) the current sung note is being corrected to
  double? pending;
  var pendingFrames = 0;
  for (var f = 0; f < frames; f++) {
    // The analysis window is centred on the frame it corrects. Starting it at the frame measured the pitch about
    // 20 ms late, which on a sung vibrato (5 to 6 Hz) left most of the wobble uncorrected.
    final start = (f * hop + hop ~/ 2 - win ~/ 2).clamp(0, math.max(0, x.length - win)).toInt();
    final hz = cheDetectPitch(x, start, win, rate: rate);
    if (hz <= 0) {
      held = null; // a breath or consonant ends the note
      pending = null;
      pendingFrames = 0;
      continue;
    }
    final m = cheMidiOf(hz);
    final nearest = cheMidiOf(cheNearestNoteHz(hz, key: key, scale: scale));
    if (held == null) {
      held = nearest;
    } else if (nearest != held) {
      final clearly = (m - held).abs() - (m - nearest).abs() > 2 * cheNoteSwitchSemitones;
      pendingFrames = pending == nearest ? pendingFrames + 1 : 1;
      pending = nearest;
      if (clearly || pendingFrames >= holdFrames) {
        held = nearest;
        pending = null;
        pendingFrames = 0;
      }
    } else {
      pending = null;
      pendingFrames = 0;
    }
    final target = cheHzOf(held);
    final r = math.pow(target / hz, strength.clamp(0, 1)).toDouble();
    hzAt[f] = hz;
    ratioAt[f] = r;
    pitched++;
    cents += (1200 * math.log(r) / math.ln2).abs();
  }
  int frameOf(num t) => (t ~/ hop).clamp(0, frames - 1);

  // Input pitch marks: one period apart through voiced frames, a fixed step through unvoiced ones.
  final marks = <double>[];
  for (var t = 0.0; t < x.length;) {
    marks.add(t);
    final hz = hzAt[frameOf(t)];
    t += hz > 0 ? rate / hz : flat;
  }
  final out = Float64List(x.length), norm = Float64List(x.length);
  var m = 0;
  for (var t = 0.0; t < x.length;) {
    final f = frameOf(t);
    final hz = hzAt[f];
    final period = hz > 0 ? rate / hz : flat.toDouble();
    // The input mark nearest this output time keeps the timing.
    while (m + 1 < marks.length && (marks[m + 1] - t).abs() <= (marks[m] - t).abs()) {
      m++;
    }
    final src = marks[m];
    final half = period.round();
    for (var i = -half; i < half; i++) {
      final o = (t + i).round();
      final s = (src + i).round();
      if (o < 0 || o >= x.length || s < 0 || s >= x.length) continue;
      final w = 0.5 + 0.5 * math.cos(math.pi * i / half);
      out[o] += x[s] * w;
      norm[o] += w;
    }
    t += hz > 0 ? period / ratioAt[f] : flat;
  }
  for (var i = 0; i < x.length; i++) {
    if (norm[i] > 1e-3) x[i] = out[i] / norm[i];
  }
  return ChePitchReport(frames, pitched, pitched == 0 ? 0 : cents / pitched);
}

/// Equal-power pan of a mono plane into left/right, [pan] -1 (left) .. 1 (right).
(double, double) chePanGains(double pan) {
  final a = (pan.clamp(-1, 1) + 1) * math.pi / 4;
  return (math.cos(a), math.sin(a));
}

// ---- Drum and click synthesis for the Beat Maker and metronome (synthesised here, so no sample licences). ----

final _rng = math.Random(7);

Float32List _noise(int n) => Float32List.fromList([for (var i = 0; i < n; i++) _rng.nextDouble() * 2 - 1]);

/// One drum hit. Instruments: kick, snare, clap, hat, open_hat, perc, bass (an 808-style tone at [hz]).
Float32List cheDrum(String instrument, {int rate = cheStudioRate, double hz = 55}) {
  switch (instrument) {
    case 'kick':
      final n = (rate * 0.45).round();
      final out = Float32List(n);
      var phase = 0.0;
      for (var i = 0; i < n; i++) {
        final t = i / rate;
        final f = 45 + 105 * math.exp(-t * 28);
        phase += 2 * math.pi * f / rate;
        out[i] = math.sin(phase) * math.exp(-t * 7) * 0.95;
      }
      return out;
    case 'snare':
      final n = (rate * 0.22).round();
      final noise = _noise(n);
      CheBiquad.highPass(1200).run(noise);
      return Float32List.fromList([
        for (var i = 0; i < n; i++)
          (noise[i] * 0.7 * math.exp(-i / rate * 22) + math.sin(2 * math.pi * 185 * i / rate) * 0.45 * math.exp(-i / rate * 30))
      ]);
    case 'clap':
      final n = (rate * 0.25).round();
      final noise = _noise(n);
      CheBiquad.bandPass(1300, q: 1.2).run(noise);
      return Float32List.fromList([
        for (var i = 0; i < n; i++)
          noise[i] * 1.4 * (i < rate * 0.03 ? (math.sin(i / rate * 2 * math.pi * 100).abs()) : math.exp(-(i / rate - 0.03) * 18))
      ]);
    case 'hat':
    case 'open_hat':
      final decay = instrument == 'hat' ? 60.0 : 9.0;
      final n = (rate * (instrument == 'hat' ? 0.06 : 0.35)).round();
      final noise = _noise(n);
      CheBiquad.highPass(7000).run(noise);
      return Float32List.fromList([for (var i = 0; i < n; i++) noise[i] * 0.5 * math.exp(-i / rate * decay)]);
    case 'perc':
      final n = (rate * 0.12).round();
      return Float32List.fromList([
        for (var i = 0; i < n; i++) math.sin(2 * math.pi * 820 * i / rate) * 0.5 * math.exp(-i / rate * 40)
      ]);
    case 'bass':
      final n = (rate * 0.6).round();
      return Float32List.fromList([
        for (var i = 0; i < n; i++) _tanh(2 * math.sin(2 * math.pi * hz * i / rate)) * 0.6 * math.exp(-i / rate * 3.2)
      ]);
  }
  return Float32List(0);
}

double _tanh(double x) {
  final e = math.exp(2 * x);
  return (e - 1) / (e + 1);
}

/// One metronome click: higher and louder on the first beat of the bar.
Float32List cheClick({bool accent = false, int rate = cheStudioRate}) {
  final n = (rate * 0.03).round();
  final f = accent ? 1600.0 : 1000.0;
  return Float32List.fromList([
    for (var i = 0; i < n; i++) math.sin(2 * math.pi * f * i / rate) * (accent ? 0.7 : 0.45) * math.exp(-i / rate * 120)
  ]);
}

/// Adds [src] into [dst] starting at sample [at], scaled by [gain].
void cheMixInto(Float32List dst, Float32List src, int at, [double gain = 1]) {
  for (var i = 0; i < src.length; i++) {
    final j = at + i;
    if (j < 0) continue;
    if (j >= dst.length) break;
    dst[j] += src[i] * gain;
  }
}
