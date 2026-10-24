// A Recording Studio song: tracks of clips on one timeline (positions in samples at the studio rate), each track's
// mixer and effects, the Beat Maker pattern, loop and punch ranges, and mastering. Pure data plus the renderer that
// turns it into real audio, and the store that autosaves it to the iPhone (Documents/CHE Songs, visible in Files).
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'che_dsp.dart';
import 'che_wav.dart';

String _id(String prefix) => '$prefix${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}${math.Random().nextInt(1 << 20).toRadixString(36)}';

/// One placed piece of audio: [length] samples of source [audioId] from [offset], heard at timeline [start].
class CheClip {
  CheClip({String? id, required this.audioId, required this.start, this.offset = 0, required this.length, this.gain = 1})
      : id = id ?? _id('c');
  final String id;
  String audioId;
  int start;
  int offset;
  int length;
  double gain;

  int get end => start + length;

  CheClip copy({int? start}) => CheClip(audioId: audioId, start: start ?? this.start, offset: offset, length: length, gain: gain);

  Map<String, dynamic> toJson() => {'id': id, 'audio': audioId, 'start': start, 'offset': offset, 'length': length, 'gain': gain};
  factory CheClip.fromJson(Map j) => CheClip(
      id: '${j['id']}', audioId: '${j['audio']}', start: (j['start'] as num).toInt(), offset: (j['offset'] as num? ?? 0).toInt(),
      length: (j['length'] as num).toInt(), gain: (j['gain'] as num? ?? 1).toDouble());
}

/// A track's effects, applied in this order: noise reduction, pitch correction, EQ, compression, delay, reverb.
class CheEffects {
  CheEffects({
    this.preset = 'None',
    this.noise = false,
    this.pitch = 0,
    this.key = 0,
    this.scale = 'chromatic',
    this.eqLow = 0,
    this.eqMid = 0,
    this.eqHigh = 0,
    this.compress = 0,
    this.delay = 0,
    this.delayMs = 350,
    this.reverb = 0,
    this.room = 0.6,
  });
  String preset;
  bool noise;

  /// Pitch correction strength 0 (off) .. 1 (hard snap).
  double pitch;
  int key;
  String scale;
  double eqLow, eqMid, eqHigh;

  /// Compression amount 0 (off) .. 1 (heavy).
  double compress;

  /// Delay and reverb wet levels 0 (off) .. 1.
  double delay;
  double delayMs;
  double reverb;
  double room;

  bool get any => noise || pitch > 0 || eqLow != 0 || eqMid != 0 || eqHigh != 0 || compress > 0 || delay > 0 || reverb > 0;

  /// What is on, in words ("pitch correction 80%, reverb 30%").
  String describe() {
    final on = <String>[
      if (noise) 'noise reduction',
      if (pitch > 0) 'pitch correction ${(pitch * 100).round()}% in ${cheNoteNames[key]} $scale',
      if (eqLow != 0 || eqMid != 0 || eqHigh != 0) 'EQ low ${eqLow.round()}, mid ${eqMid.round()}, high ${eqHigh.round()} dB',
      if (compress > 0) 'compression ${(compress * 100).round()}%',
      if (delay > 0) 'delay ${(delay * 100).round()}% at ${delayMs.round()} ms',
      if (reverb > 0) 'reverb ${(reverb * 100).round()}%',
    ];
    return on.isEmpty ? 'no effects' : on.join(', ');
  }

  CheEffects copy() => CheEffects.fromJson(toJson());

  Map<String, dynamic> toJson() => {
        'preset': preset, 'noise': noise, 'pitch': pitch, 'key': key, 'scale': scale, 'eq_low': eqLow, 'eq_mid': eqMid,
        'eq_high': eqHigh, 'compress': compress, 'delay': delay, 'delay_ms': delayMs, 'reverb': reverb, 'room': room,
      };
  factory CheEffects.fromJson(Map j) => CheEffects(
        preset: '${j['preset'] ?? 'None'}', noise: j['noise'] == true, pitch: (j['pitch'] as num? ?? 0).toDouble(),
        key: (j['key'] as num? ?? 0).toInt(), scale: '${j['scale'] ?? 'chromatic'}', eqLow: (j['eq_low'] as num? ?? 0).toDouble(),
        eqMid: (j['eq_mid'] as num? ?? 0).toDouble(), eqHigh: (j['eq_high'] as num? ?? 0).toDouble(),
        compress: (j['compress'] as num? ?? 0).toDouble(), delay: (j['delay'] as num? ?? 0).toDouble(),
        delayMs: (j['delay_ms'] as num? ?? 350).toDouble(), reverb: (j['reverb'] as num? ?? 0).toDouble(),
        room: (j['room'] as num? ?? 0.6).toDouble(),
      );

  /// Vocal presets: starting points the owner can adjust.
  static final Map<String, CheEffects Function()> presets = {
    'None': () => CheEffects(),
    'Clean vocal': () => CheEffects(preset: 'Clean vocal', noise: true, eqLow: -2, eqHigh: 2, compress: 0.35, reverb: 0.12),
    'Pop vocal': () => CheEffects(preset: 'Pop vocal', noise: true, pitch: 0.6, eqLow: -3, eqMid: 1, eqHigh: 4, compress: 0.55, delay: 0.12, reverb: 0.25),
    'Hard tune': () => CheEffects(preset: 'Hard tune', noise: true, pitch: 1, eqLow: -3, eqHigh: 3, compress: 0.6, reverb: 0.15),
    'Rap vocal': () => CheEffects(preset: 'Rap vocal', noise: true, eqLow: -2, eqMid: 2, eqHigh: 3, compress: 0.7, reverb: 0.06),
    'Ballad': () => CheEffects(preset: 'Ballad', noise: true, pitch: 0.4, eqHigh: 2, compress: 0.4, delay: 0.15, delayMs: 480, reverb: 0.45, room: 0.85),
  };
}

class CheTrack {
  CheTrack({String? id, required this.name, this.kind = 'vocal', this.volume = 0.9, this.pan = 0, this.mute = false, this.solo = false, CheEffects? fx, List<CheClip>? clips})
      : id = id ?? _id('t'),
        fx = fx ?? CheEffects(),
        clips = clips ?? [];
  final String id;
  String name;

  /// vocal, beat or instrument.
  String kind;
  double volume;
  double pan;
  bool mute;
  bool solo;
  CheEffects fx;
  final List<CheClip> clips;

  int get end => clips.fold(0, (m, c) => math.max(m, c.end));

  Map<String, dynamic> toJson() => {
        'id': id, 'name': name, 'kind': kind, 'volume': volume, 'pan': pan, 'mute': mute, 'solo': solo, 'fx': fx.toJson(),
        'clips': [for (final c in clips) c.toJson()],
      };
  factory CheTrack.fromJson(Map j) => CheTrack(
        id: '${j['id']}', name: '${j['name']}', kind: '${j['kind'] ?? 'vocal'}', volume: (j['volume'] as num? ?? 0.9).toDouble(),
        pan: (j['pan'] as num? ?? 0).toDouble(), mute: j['mute'] == true, solo: j['solo'] == true,
        fx: CheEffects.fromJson((j['fx'] as Map?) ?? const {}),
        clips: [for (final c in (j['clips'] as List? ?? const [])) CheClip.fromJson(c as Map)],
      );
}

/// The Beat Maker: a 16-step pattern per instrument, looped for [bars] bars.
class CheBeat {
  CheBeat({Map<String, List<bool>>? steps, this.bars = 4, this.swing = 0, this.bassHz = 55})
      : steps = steps ?? {for (final i in instruments) i: List.filled(16, false)};
  static const instruments = ['kick', 'snare', 'clap', 'hat', 'open_hat', 'perc', 'bass'];
  static const labels = {'kick': 'Kick', 'snare': 'Snare', 'clap': 'Clap', 'hat': 'Hi-hat', 'open_hat': 'Open hat', 'perc': 'Percussion', 'bass': '808 bass'};
  final Map<String, List<bool>> steps;
  int bars;

  /// 0 (straight) .. 0.5 (heavy swing): how late every second 16th lands.
  double swing;
  double bassHz;

  bool get empty => steps.values.every((s) => !s.contains(true));

  /// The sample where step [step] (0-based over all bars) lands at [bpm].
  static int stepSample(int step, double bpm, {double swing = 0, int rate = cheStudioRate}) {
    final len = rate * 60 / bpm / 4;
    final late = step.isOdd ? swing * len : 0;
    return (step * len + late).round();
  }

  /// A starter groove so "play the beat" has something to play.
  static CheBeat starter() {
    final b = CheBeat();
    for (final s in [0, 6, 8, 10]) {
      b.steps['kick']![s] = true;
    }
    for (final s in [4, 12]) {
      b.steps['snare']![s] = true;
    }
    for (var s = 0; s < 16; s += 2) {
      b.steps['hat']![s] = true;
    }
    b.steps['open_hat']![14] = true;
    b.steps['bass']![0] = true;
    b.steps['bass']![8] = true;
    return b;
  }

  /// The pattern as real audio, [bars] bars long at [bpm].
  Float32List render(double bpm, {int rate = cheStudioRate}) {
    final total = stepSample(16 * bars, bpm, rate: rate);
    final out = Float32List(total + rate);
    final hits = {for (final i in instruments) i: cheDrum(i, rate: rate, hz: bassHz)};
    for (var bar = 0; bar < bars; bar++) {
      for (final e in steps.entries) {
        for (var s = 0; s < 16; s++) {
          if (e.value[s]) cheMixInto(out, hits[e.key]!, stepSample(bar * 16 + s, bpm, swing: swing, rate: rate), 0.8);
        }
      }
    }
    return Float32List.sublistView(out, 0, total);
  }

  Map<String, dynamic> toJson() => {
        'steps': {for (final e in steps.entries) e.key: [for (final v in e.value) v ? 1 : 0]},
        'bars': bars, 'swing': swing, 'bass_hz': bassHz,
      };
  factory CheBeat.fromJson(Map j) {
    final raw = (j['steps'] as Map?) ?? const {};
    return CheBeat(
      steps: {
        for (final i in instruments)
          i: [for (var s = 0; s < 16; s++) ((raw[i] as List?)?.elementAtOrNull(s) ?? 0) == 1]
      },
      bars: (j['bars'] as num? ?? 4).toInt(),
      swing: (j['swing'] as num? ?? 0).toDouble(),
      bassHz: (j['bass_hz'] as num? ?? 55).toDouble(),
    );
  }
}

class CheMaster {
  CheMaster({this.enabled = false, this.low = 0, this.high = 0, this.glue = 0.4, this.ceilingDb = -1, this.targetRmsDb = -14});
  bool enabled;
  double low, high;

  /// Bus compression 0..1.
  double glue;
  double ceilingDb;

  /// Loudness target as RMS dBFS (an RMS level, not a LUFS measurement).
  double targetRmsDb;

  Map<String, dynamic> toJson() => {'enabled': enabled, 'low': low, 'high': high, 'glue': glue, 'ceiling_db': ceilingDb, 'target_rms_db': targetRmsDb};
  factory CheMaster.fromJson(Map j) => CheMaster(
        enabled: j['enabled'] == true, low: (j['low'] as num? ?? 0).toDouble(), high: (j['high'] as num? ?? 0).toDouble(),
        glue: (j['glue'] as num? ?? 0.4).toDouble(), ceilingDb: (j['ceiling_db'] as num? ?? -1).toDouble(),
        targetRmsDb: (j['target_rms_db'] as num? ?? -14).toDouble(),
      );
}

class CheSong {
  CheSong({String? id, required this.title, this.bpm = 90, List<CheTrack>? tracks, CheBeat? beat, CheMaster? master, int? created, int? updated, this.latencyMs = 0, this.loopStart, this.loopEnd, this.punchIn, this.punchOut})
      : id = id ?? _id('song_'),
        tracks = tracks ?? [],
        beat = beat ?? CheBeat(),
        master = master ?? CheMaster(),
        created = created ?? DateTime.now().millisecondsSinceEpoch,
        updated = updated ?? DateTime.now().millisecondsSinceEpoch;
  final String id;
  String title;
  double bpm;
  final List<CheTrack> tracks;
  CheBeat beat;
  CheMaster master;
  final int created;
  int updated;

  /// Extra take alignment the owner set by ear (added to the measured latency), in milliseconds.
  double latencyMs;
  int? loopStart, loopEnd, punchIn, punchOut;

  int get end => tracks.fold(0, (m, t) => math.max(m, t.end));
  int get barSamples => (cheStudioRate * 60 / bpm * 4).round();
  int get beatSamples => (cheStudioRate * 60 / bpm).round();

  CheTrack? track(String id) => tracks.where((t) => t.id == id).firstOrNull;

  Map<String, dynamic> toJson() => {
        'id': id, 'title': title, 'bpm': bpm, 'created': created, 'updated': updated, 'latency_ms': latencyMs,
        'loop': [loopStart, loopEnd], 'punch': [punchIn, punchOut], 'beat': beat.toJson(), 'master': master.toJson(),
        'tracks': [for (final t in tracks) t.toJson()],
      };
  factory CheSong.fromJson(Map j) {
    int? at(List? l, int i) => (l?.elementAtOrNull(i) as num?)?.toInt();
    return CheSong(
      id: '${j['id']}', title: '${j['title']}', bpm: (j['bpm'] as num? ?? 90).toDouble(),
      created: (j['created'] as num?)?.toInt(), updated: (j['updated'] as num?)?.toInt(),
      latencyMs: (j['latency_ms'] as num? ?? 0).toDouble(),
      loopStart: at(j['loop'] as List?, 0), loopEnd: at(j['loop'] as List?, 1),
      punchIn: at(j['punch'] as List?, 0), punchOut: at(j['punch'] as List?, 1),
      beat: CheBeat.fromJson((j['beat'] as Map?) ?? const {}), master: CheMaster.fromJson((j['master'] as Map?) ?? const {}),
      tracks: [for (final t in (j['tracks'] as List? ?? const [])) CheTrack.fromJson(t as Map)],
    );
  }
}

// ---- Clip editing (each returns what it did, so the studio can say it). ----

/// Trims [clip] to timeline [from]..[to]. False when that leaves nothing.
bool cheTrimClip(CheClip clip, {int? from, int? to}) {
  final s = math.max(clip.start, from ?? clip.start);
  final e = math.min(clip.end, to ?? clip.end);
  if (e - s < 64) return false;
  clip.offset += s - clip.start;
  clip.start = s;
  clip.length = e - s;
  return true;
}

/// Splits [clip] at timeline sample [at]; returns the new right-hand clip (already added to [track]) or null.
CheClip? cheSplitClip(CheTrack track, CheClip clip, int at) {
  if (at <= clip.start + 64 || at >= clip.end - 64) return null;
  final right = CheClip(audioId: clip.audioId, start: at, offset: clip.offset + (at - clip.start), length: clip.end - at, gain: clip.gain);
  clip.length = at - clip.start;
  track.clips.insert(track.clips.indexOf(clip) + 1, right);
  return right;
}

/// Duplicates [clip] right after itself.
CheClip cheDuplicateClip(CheTrack track, CheClip clip) {
  final c = clip.copy(start: clip.end);
  track.clips.insert(track.clips.indexOf(clip) + 1, c);
  return c;
}

/// Moves [clip] by [delta] samples (never before zero).
void cheMoveClip(CheClip clip, int delta) => clip.start = math.max(0, clip.start + delta);

// ---- Rendering ----

/// Everything a render needs, copyable to a background isolate.
class CheRenderJob {
  CheRenderJob({required this.song, required this.sources, this.from = 0, this.to, this.metronome = false, this.countInBars = 0, this.onlyTrack, this.applyMaster = true});
  final Map<String, dynamic> song;
  final Map<String, Float32List> sources;
  final int from;
  final int? to;
  final bool metronome;
  final int countInBars;
  final String? onlyTrack;
  final bool applyMaster;
}

/// The processed sound of one track over its whole length (effects applied), mono.
Float32List cheRenderTrack(CheTrack t, Map<String, Float32List> sources) {
  var x = Float32List(t.end);
  for (final c in t.clips) {
    final src = sources[c.audioId];
    if (src == null) continue;
    final end = math.min(c.offset + c.length, src.length);
    if (end <= c.offset) continue;
    cheMixInto(x, Float32List.sublistView(src, c.offset, end), c.start, c.gain);
  }
  final fx = t.fx;
  if (fx.noise) cheReduceNoise(x);
  if (fx.pitch > 0) chePitchCorrect(x, strength: fx.pitch, key: fx.key, scale: fx.scale);
  if (fx.eqLow != 0 || fx.eqMid != 0 || fx.eqHigh != 0) cheEq(x, lowDb: fx.eqLow, midDb: fx.eqMid, highDb: fx.eqHigh);
  if (fx.compress > 0) {
    cheCompress(x, thresholdDb: -10 - 20 * fx.compress, ratio: 1.5 + 4.5 * fx.compress, makeupDb: 6 * fx.compress);
  }
  if (fx.delay > 0) x = cheDelay(x, ms: fx.delayMs, mix: fx.delay * 0.6);
  if (fx.reverb > 0) x = cheReverb(x, room: fx.room, mix: fx.reverb * 0.6);
  return x;
}

/// What a mastering pass measured.
class CheMasterReport {
  const CheMasterReport(this.peakBefore, this.rmsBefore, this.peakAfter, this.rmsAfter);
  final double peakBefore, rmsBefore, peakAfter, rmsAfter;
}

/// Masters a stereo mix in place: tone, bus compression, gain toward the RMS target, then the peak limiter.
CheMasterReport cheMasterStereo(Float32List left, Float32List right, CheMaster m) {
  double peak() => math.max(chePeakDb(left), chePeakDb(right));
  double rms() => (cheRmsDb(left) + cheRmsDb(right)) / 2;
  final pb = peak(), rb = rms();
  for (final x in [left, right]) {
    cheEq(x, lowDb: m.low, highDb: m.high, highPassHz: 25);
    if (m.glue > 0) cheCompress(x, thresholdDb: -8 - 14 * m.glue, ratio: 1.5 + 2 * m.glue, attackMs: 20, releaseMs: 200);
  }
  final rNow = rms();
  if (rNow > -120) {
    final g = cheGain((m.targetRmsDb - rNow).clamp(-12, 18));
    for (final x in [left, right]) {
      for (var i = 0; i < x.length; i++) {
        x[i] *= g;
      }
      cheLimit(x, ceilingDb: m.ceilingDb);
    }
  }
  return CheMasterReport(pb, rb, peak(), rms());
}

/// The stereo mix of [job] as two planes: muted tracks silent, a soloed track alone, volume and pan applied, the
/// count-in and metronome clicks added when asked, then mastering when it is on.
List<Float32List> cheRenderMix(CheRenderJob job) {
  final song = CheSong.fromJson(job.song);
  final countIn = job.countInBars * song.barSamples;
  // Room for reverb and echo tails past the last clip.
  final tail = song.tracks.any((t) => t.fx.reverb > 0 || t.fx.delay > 0) ? cheStudioRate * 2 : 0;
  final songEnd = math.max(song.end == 0 ? 0 : song.end + tail, job.to ?? 0);
  final to = math.min(job.to ?? songEnd, songEnd);
  final int from = job.from.clamp(0, math.max(0, to)).toInt();
  final len = math.max(0, to - from) + countIn;
  final left = Float32List(len), right = Float32List(len);
  final soloed = song.tracks.any((t) => t.solo);
  for (final t in song.tracks) {
    if (job.onlyTrack != null ? t.id != job.onlyTrack : (t.mute || (soloed && !t.solo))) continue;
    final x = cheRenderTrack(t, job.sources);
    final (gl, gr) = chePanGains(t.pan);
    for (var i = from; i < math.min(x.length, to); i++) {
      final j = i - from + countIn;
      left[j] += x[i] * t.volume * gl * math.sqrt2;
      right[j] += x[i] * t.volume * gr * math.sqrt2;
    }
  }
  if (job.metronome || countIn > 0) {
    final beat = song.beatSamples;
    final clickA = cheClick(accent: true), click = cheClick();
    // Count-in clicks, then (when the metronome is on) clicks on every song beat.
    for (var b = 0; b * beat < countIn; b++) {
      cheMixInto(left, b % 4 == 0 ? clickA : click, b * beat);
      cheMixInto(right, b % 4 == 0 ? clickA : click, b * beat);
    }
    if (job.metronome) {
      for (var b = (from / beat).ceil(); ; b++) {
        final at = b * beat - from + countIn;
        if (at >= len) break;
        cheMixInto(left, b % 4 == 0 ? clickA : click, at);
        cheMixInto(right, b % 4 == 0 ? clickA : click, at);
      }
    }
  }
  if (job.applyMaster && song.master.enabled && job.onlyTrack == null) cheMasterStereo(left, right, song.master);
  return [left, right];
}

/// WAV bytes of a mix (what Play, Export and playback all hear).
Uint8List cheRenderWav(CheRenderJob job) => cheEncodeWav(cheRenderMix(job), cheStudioRate);

// ---- Store: Documents/CHE Songs/<song id>/song.json + one WAV per recorded or imported source. ----

class CheSongStore {
  CheSongStore(this.root);
  final Directory root;

  Directory _dir(String id) => Directory('${root.path}/$id');

  Future<void> save(CheSong song, Map<String, Float32List> sources) async {
    final dir = _dir(song.id);
    await dir.create(recursive: true);
    song.updated = DateTime.now().millisecondsSinceEpoch;
    final used = {for (final t in song.tracks) for (final c in t.clips) c.audioId};
    for (final id in used) {
      final f = File('${dir.path}/$id.wav');
      final src = sources[id];
      if (src != null && !await f.exists()) await f.writeAsBytes(cheEncodeWav([src], cheStudioRate), flush: true);
    }
    final tmp = File('${dir.path}/song.json.tmp');
    await tmp.writeAsString(jsonEncode(song.toJson()), flush: true);
    await tmp.rename('${dir.path}/song.json');
    await File('${root.path}/last.txt').writeAsString(song.id);
  }

  /// Writes a source as soon as it exists (a take is on disk before anything else happens to it).
  Future<void> saveSource(String songId, String audioId, Float32List samples) async {
    final dir = _dir(songId);
    await dir.create(recursive: true);
    await File('${dir.path}/$audioId.wav').writeAsBytes(cheEncodeWav([samples], cheStudioRate), flush: true);
  }

  Future<List<CheSong>> list() async {
    if (!await root.exists()) return [];
    final out = <CheSong>[];
    await for (final e in root.list()) {
      if (e is! Directory) continue;
      final f = File('${e.path}/song.json');
      if (!await f.exists()) continue;
      try {
        out.add(CheSong.fromJson(jsonDecode(await f.readAsString()) as Map));
      } catch (_) {
        // A damaged song file is skipped, never deleted.
      }
    }
    out.sort((a, b) => b.updated.compareTo(a.updated));
    return out;
  }

  Future<String?> lastId() async {
    final f = File('${root.path}/last.txt');
    return await f.exists() ? (await f.readAsString()).trim() : null;
  }

  Future<(CheSong, Map<String, Float32List>)?> load(String id) async {
    final f = File('${_dir(id).path}/song.json');
    if (!await f.exists()) return null;
    final song = CheSong.fromJson(jsonDecode(await f.readAsString()) as Map);
    final sources = <String, Float32List>{};
    for (final t in song.tracks) {
      for (final c in t.clips) {
        if (sources.containsKey(c.audioId)) continue;
        final w = File('${_dir(id).path}/${c.audioId}.wav');
        if (await w.exists()) {
          final a = cheDecodeWav(await w.readAsBytes());
          sources[c.audioId] = cheResample(a.mono(), a.sampleRate, cheStudioRate);
        }
      }
    }
    return (song, sources);
  }

  /// Exports [wav] as "<title>.wav" next to the songs, where the Files app shows it. Returns the file.
  Future<File> export(CheSong song, Uint8List wav) async {
    final safe = song.title.replaceAll(RegExp(r'[^A-Za-z0-9 _-]'), '').trim();
    final dir = Directory('${root.path}/Exports');
    await dir.create(recursive: true);
    final f = File('${dir.path}/${safe.isEmpty ? song.id : safe}.wav');
    await f.writeAsBytes(wav, flush: true);
    return f;
  }
}
