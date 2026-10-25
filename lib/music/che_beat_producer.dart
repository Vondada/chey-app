// The Recording Studio's Beat Producer: genre, tempo and key in, a drum pattern and a bass line out, rendered as real
// PCM through the studio's own drum synthesis (che_dsp.dart). Generation is deterministic: the same genre, tempo,
// key and variation always give the same pattern and the same samples (every random choice comes from one seeded
// generator), so "make another one" means the next variation number, and a saved song can rebuild its beat exactly.
// The rendered beat becomes an ordinary clip on a beat track, so the mixer, effects, mastering and export use it like
// any recording. No samples, loops or network: everything is synthesised here.
import 'dart:math' as math;
import 'dart:typed_data';

import 'che_dsp.dart';

/// One genre's groove: drum steps (16 per bar) with their velocities, the bass rhythm, a chord-root progression in
/// scale degrees (one per bar), the default tempo and key, and how much swing it has.
class CheGenre {
  const CheGenre({
    required this.name,
    required this.bpm,
    required this.key,
    required this.minor,
    required this.kick,
    required this.snare,
    this.clap = const [],
    required this.hat,
    this.openHat = const [],
    this.perc = const [],
    required this.bass,
    required this.progression,
    this.swing = 0,
    this.bassLong = false,
    this.hatRolls = false,
    this.aliases = const [],
  });
  final String name;
  final double bpm;
  final int key;
  final bool minor;
  final List<int> kick, snare, clap, hat, openHat, perc;

  /// Steps where a bass note starts.
  final List<int> bass;

  /// Chord roots as scale degrees (0 = the key's root), one per bar, repeated.
  final List<int> progression;
  final double swing;

  /// 808-style notes that ring until the next note (trap, drill) instead of short plucks.
  final bool bassLong;

  /// Hi-hat rolls (16th and 32nd bursts) on some beats, as trap and drill use.
  final bool hatRolls;
  final List<String> aliases;
}

const _eighths = [0, 2, 4, 6, 8, 10, 12, 14];
const _sixteenths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// The genres CHE can produce. Patterns are common textbook grooves for each style, not copies of any record.
const cheGenres = <String, CheGenre>{
  'hip hop': CheGenre(
      name: 'Hip hop', bpm: 90, key: 9, minor: true, kick: [0, 7, 10], snare: [4, 12], hat: _eighths, openHat: [14],
      bass: [0, 7, 10], progression: [0, 0, 5, 4], swing: 0.12, aliases: ['hiphop', 'hip-hop', 'rap']),
  'boom bap': CheGenre(
      name: 'Boom bap', bpm: 92, key: 2, minor: true, kick: [0, 3, 10], snare: [4, 12], hat: _eighths, perc: [15],
      bass: [0, 3, 10], progression: [0, 3, 4, 0], swing: 0.2, aliases: ['boombap', 'old school']),
  'trap': CheGenre(
      name: 'Trap', bpm: 140, key: 5, minor: true, kick: [0, 7, 11], snare: [8], clap: [8], hat: _eighths, openHat: [],
      bass: [0, 7, 11], progression: [0, 0, 5, 6], bassLong: true, hatRolls: true),
  'drill': CheGenre(
      name: 'Drill', bpm: 142, key: 1, minor: true, kick: [0, 6, 10], snare: [8], clap: [8], hat: [0, 3, 6, 8, 11, 14], perc: [13],
      bass: [0, 6, 10, 14], progression: [0, 5, 3, 4], bassLong: true, hatRolls: true, aliases: ['uk drill']),
  'pop': CheGenre(
      name: 'Pop', bpm: 110, key: 0, minor: false, kick: [0, 8], snare: [4, 12], clap: [4, 12], hat: _eighths,
      bass: [0, 2, 4, 6, 8, 10, 12, 14], progression: [0, 4, 5, 3]),
  'house': CheGenre(
      name: 'House', bpm: 124, key: 7, minor: true, kick: [0, 4, 8, 12], snare: [], clap: [4, 12], hat: [2, 6, 10, 14],
      openHat: [2, 6, 10, 14], bass: [2, 6, 10, 14], progression: [0, 0, 5, 3], aliases: ['dance', 'edm']),
  'lofi': CheGenre(
      name: 'Lo-fi', bpm: 80, key: 4, minor: true, kick: [0, 7, 10], snare: [4, 12], hat: _eighths, perc: [6],
      bass: [0, 10], progression: [0, 3, 6, 4], swing: 0.28, aliases: ['lo fi', 'lo-fi', 'chill']),
  'r&b': CheGenre(
      name: 'R&B', bpm: 95, key: 10, minor: false, kick: [0, 3, 10], snare: [4, 12], hat: _sixteenths, perc: [11],
      bass: [0, 3, 8, 10], progression: [0, 5, 3, 4], swing: 0.1, aliases: ['rnb', 'r and b', 'r b', 'soul']),
};

/// What to produce. [variation] picks a different but repeatable set of fills and ghost notes.
class CheBeatSpec {
  const CheBeatSpec({required this.genre, required this.bpm, required this.key, required this.minor, this.bars = 4, this.variation = 0});
  final String genre;
  final double bpm;
  final int key;
  final bool minor;
  final int bars;
  final int variation;

  factory CheBeatSpec.of(String genre, {double? bpm, int? key, bool? minor, int bars = 4, int variation = 0}) {
    final g = cheGenres[genre] ?? cheGenres['hip hop']!;
    return CheBeatSpec(
      genre: cheGenres.containsKey(genre) ? genre : 'hip hop',
      bpm: (bpm ?? g.bpm).clamp(60, 200).toDouble(),
      key: (key ?? g.key) % 12,
      minor: minor ?? g.minor,
      bars: bars.clamp(1, 16),
      variation: variation,
    );
  }

  CheGenre get style => cheGenres[genre]!;
  String get keyName => '${cheNoteNames[key]} ${minor ? 'minor' : 'major'}';
  String describe() => '${style.name} in $keyName at ${bpm.round()} BPM, $bars bars';

  /// The seed every random choice comes from: a fixed function of the settings (not Dart's hashCode, which may
  /// change between runs).
  int get seed {
    var h = 0x811c9dc5;
    for (final c in '$genre|${bpm.round()}|$key|$minor|$bars|$variation'.codeUnits) {
      h = ((h ^ c) * 0x01000193) & 0x7fffffff;
    }
    return h;
  }

  CheBeatSpec next() => CheBeatSpec(genre: genre, bpm: bpm, key: key, minor: minor, bars: bars, variation: variation + 1);

  Map<String, dynamic> toJson() => {'genre': genre, 'bpm': bpm, 'key': key, 'minor': minor, 'bars': bars, 'variation': variation};
  factory CheBeatSpec.fromJson(Map j) => CheBeatSpec.of('${j['genre']}',
      bpm: (j['bpm'] as num?)?.toDouble(), key: (j['key'] as num?)?.toInt(), minor: j['minor'] as bool?,
      bars: (j['bars'] as num? ?? 4).toInt(), variation: (j['variation'] as num? ?? 0).toInt());
}

/// One bass note: starts on [step] (16ths over the whole beat), lasts [steps] 16ths, at MIDI [midi].
class CheBassNote {
  const CheBassNote(this.step, this.steps, this.midi);
  final int step, steps, midi;
  double get hz => cheHzOf(midi.toDouble());
  List<int> toJson() => [step, steps, midi];
}

/// A produced beat: per-instrument velocities on every 16th of every bar (0 = no hit), and the bass line.
class CheProducedBeat {
  CheProducedBeat(this.spec, this.drums, this.bass);
  final CheBeatSpec spec;
  final Map<String, Float64List> drums;
  final List<CheBassNote> bass;

  static const drumNames = ['kick', 'snare', 'clap', 'hat', 'open_hat', 'perc'];

  int get steps => spec.bars * 16;

  /// Builds the pattern for [spec]. Same spec, same pattern, every time.
  factory CheProducedBeat.generate(CheBeatSpec spec) {
    final g = spec.style;
    final rng = math.Random(spec.seed);
    final n = spec.bars * 16;
    final drums = {for (final d in drumNames) d: Float64List(n)};
    final base = {'kick': g.kick, 'snare': g.snare, 'clap': g.clap, 'hat': g.hat, 'open_hat': g.openHat, 'perc': g.perc};
    for (var bar = 0; bar < spec.bars; bar++) {
      final fill = bar == spec.bars - 1; // the last bar turns around
      for (final e in base.entries) {
        for (final s in e.value) {
          final accent = e.key == 'hat' ? (s % 4 == 0 ? 0.9 : 0.62) : 1.0;
          drums[e.key]![bar * 16 + s] = (accent * (0.88 + rng.nextDouble() * 0.12)).clamp(0, 1).toDouble();
        }
      }
      // Ghost kicks and snares: one or two quiet extra hits, on steps the groove leaves empty.
      final ghosts = 1 + rng.nextInt(2);
      for (var k = 0; k < ghosts; k++) {
        final inst = rng.nextBool() ? 'kick' : 'snare';
        final s = bar * 16 + rng.nextInt(16);
        if (drums[inst]![s] == 0 && drums['snare']![s] == 0 && drums['clap']![s] == 0) drums[inst]![s] = 0.35 + rng.nextDouble() * 0.15;
      }
      if (g.hatRolls) {
        // A 16th roll into one of beats 2 to 4 (32nds are rendered as doubled 16ths below).
        final beat = 1 + rng.nextInt(3);
        for (var s = beat * 4 - 2; s < beat * 4; s++) {
          drums['hat']![bar * 16 + s] = 0.55 + rng.nextDouble() * 0.2;
        }
      }
      if (fill) {
        for (final s in [13, 14, 15]) {
          if (rng.nextDouble() < 0.6) drums['snare']![bar * 16 + s] = math.max(drums['snare']![bar * 16 + s], 0.5 + rng.nextDouble() * 0.3);
        }
      }
    }
    // Bass: the chord root of each bar, on the genre's bass rhythm, sometimes stepping to the fifth or the octave.
    final scale = cheScales[spec.minor ? 'minor' : 'major']!;
    var root = 36 + spec.key; // C2..B2
    if (root > 43) root -= 12; // keep it between G1 and G2 (49 to 98 Hz): low, but still heard on small speakers
    final bass = <CheBassNote>[];
    for (var bar = 0; bar < spec.bars; bar++) {
      final degree = g.progression[bar % g.progression.length];
      final chordRoot = root + scale[degree % scale.length] + 12 * (degree ~/ scale.length);
      final starts = g.bass;
      for (var i = 0; i < starts.length; i++) {
        final s = starts[i];
        final nextStart = i + 1 < starts.length ? starts[i + 1] : 16;
        final len = g.bassLong ? nextStart - s : math.min(2, nextStart - s);
        var midi = chordRoot;
        if (i > 0) {
          final r = rng.nextDouble();
          if (r < 0.18) {
            midi = chordRoot + 7; // the fifth
          } else if (r < 0.26) {
            midi = chordRoot + 12; // the octave
          }
        }
        bass.add(CheBassNote(bar * 16 + s, math.max(1, len), midi));
      }
    }
    return CheProducedBeat(spec, drums, bass);
  }

  /// The sample where 16th [step] lands (swing delays every second 16th).
  int stepSample(int step, {int rate = cheStudioRate}) {
    final len = rate * 60 / spec.bpm / 4;
    final late = step.isOdd ? spec.style.swing * len : 0;
    return (step * len + late).round();
  }

  int length({int rate = cheStudioRate}) => (spec.bars * 16 * rate * 60 / spec.bpm / 4).round();

  /// The drums alone, as real audio, exactly [length] samples long.
  Float32List renderDrums({int rate = cheStudioRate}) {
    final total = length(rate: rate);
    final out = Float32List(total + rate);
    final rng = math.Random(spec.seed ^ 0x5eed);
    final hits = {for (final d in drumNames) d: cheDrum(d, rate: rate, rng: rng)};
    final half = (rate * 60 / spec.bpm / 8).round();
    for (final d in drumNames) {
      final v = drums[d]!;
      for (var s = 0; s < v.length; s++) {
        if (v[s] <= 0) continue;
        final at = stepSample(s, rate: rate);
        cheMixInto(out, hits[d]!, at, 0.8 * v[s]);
        // In a roll, the quieter hats get a 32nd in between.
        if (d == 'hat' && spec.style.hatRolls && v[s] < 0.8 && v[s] > 0.5) cheMixInto(out, hits[d]!, at + half, 0.5 * v[s]);
      }
    }
    return Float32List.sublistView(out, 0, total);
  }

  /// The bass line alone: a sine with soft saturation (808 style when the genre rings, short plucks otherwise),
  /// faded at each note's end so nothing clicks.
  Float32List renderBass({int rate = cheStudioRate}) {
    final total = length(rate: rate);
    final out = Float32List(total);
    final long = spec.style.bassLong;
    for (final note in bass) {
      final start = stepSample(note.step, rate: rate);
      final end = math.min(total, stepSample(note.step + note.steps, rate: rate));
      final n = end - start;
      if (n <= 0) continue;
      final fade = math.min(n ~/ 2, (rate * 0.012).round());
      final hz = note.hz;
      var phase = 0.0;
      for (var i = 0; i < n; i++) {
        final t = i / rate;
        phase += 2 * math.pi * hz / rate;
        final env = long ? math.exp(-t * 1.2) : math.exp(-t * 6);
        final attack = math.min(1.0, i / (rate * 0.004));
        final release = i >= n - fade ? (n - i) / fade : 1.0;
        final v = math.sin(phase);
        out[start + i] += (_softClip(1.8 * v) * 0.55 * env * attack * release);
      }
    }
    return out;
  }

  /// Drums and bass together: the beat as it goes on the track.
  Float32List render({int rate = cheStudioRate}) {
    final d = renderDrums(rate: rate), b = renderBass(rate: rate);
    final out = Float32List(d.length);
    for (var i = 0; i < out.length; i++) {
      out[i] = d[i] + b[i] * 0.9;
    }
    cheLimit(out, ceilingDb: -1);
    return out;
  }

  /// The pattern as data (what the song keeps alongside its rendered audio).
  Map<String, dynamic> toJson() => {
        'spec': spec.toJson(),
        'drums': {for (final e in drums.entries) e.key: [for (final v in e.value) (v * 100).round()]},
        'bass': [for (final b in bass) b.toJson()],
      };

  /// In words, for CHE to say: what plays where.
  String describe() {
    String where(String d) {
      final on = [for (var s = 0; s < 16; s++) if (drums[d]![s] >= 0.6) s + 1];
      return on.isEmpty ? '' : '${d == 'open_hat' ? 'open hat' : d} on ${on.join(', ')}';
    }

    final parts = [for (final d in drumNames) where(d)].where((p) => p.isNotEmpty).join('; ');
    final notes = bass.where((b) => b.step < 16).map((b) => cheNoteNames[b.midi % 12]).toSet().join(', ');
    return '${spec.describe()}. First bar: $parts. Bass notes: $notes.';
  }
}

double _softClip(double x) {
  final e = math.exp(2 * x);
  return (e - 1) / (e + 1);
}

/// Reads a Beat Producer request: genre, key ("in F sharp minor", "in E flat"), tempo ("at 140", "140 BPM").
/// Returns null when the words name no beat to produce.
CheBeatSpec? cheParseBeatRequest(String said) {
  final s = said.toLowerCase().replaceAll(RegExp(r"[^a-z0-9&# ]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (!RegExp(r'\b(make|produce|generate|build|create|cook up|give me)\b').hasMatch(s) || !RegExp(r'\bbeats?\b|\binstrumental\b').hasMatch(s)) return null;
  String? genre;
  for (final e in cheGenres.entries) {
    for (final name in [e.key, ...e.value.aliases]) {
      if (RegExp('\\b${RegExp.escape(name)}\\b').hasMatch(s)) {
        genre ??= e.key;
      }
    }
  }
  final key = RegExp(r'\bin (?:the key of )?([a-g])(?: (sharp|flat)|(#))?(?: (minor|major|min|maj))?\b').firstMatch(s);
  int? root;
  bool? minor;
  if (key != null) {
    const names = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11};
    root = names[key.group(1)!]! + (key.group(2) == 'sharp' || key.group(3) == '#' ? 1 : key.group(2) == 'flat' ? -1 : 0);
    final q = key.group(4);
    if (q != null) minor = q.startsWith('min');
  }
  final tempo = RegExp(r'\b(?:at|tempo|bpm)\s*(\d{2,3})\b|\b(\d{2,3}) ?bpm\b').firstMatch(s);
  final bpm = tempo == null ? null : double.parse(tempo.group(1) ?? tempo.group(2)!);
  final bars = RegExp(r'\b(\d{1,2}) bars?\b').firstMatch(s);
  // "Make me a beat" alone stays with the Beat Maker's starter groove; the producer answers when a genre, key or
  // tempo is named, or the owner says produce or generate.
  if (genre == null && key == null && tempo == null && !RegExp(r'\b(produce|generate|cook up)\b').hasMatch(s)) return null;
  return CheBeatSpec.of(genre ?? 'hip hop', bpm: bpm, key: root == null ? null : root % 12, minor: minor, bars: bars == null ? 4 : int.parse(bars.group(1)!));
}
