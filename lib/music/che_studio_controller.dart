// The Recording Studio's engine room: one song open at a time, the transport, recording takes with latency
// compensation, editing, effects, the Beat Maker, mixing, mastering, autosave and export. Every action returns the
// sentence CHE says (or shows) about what really happened. The screen (che_recording_studio.dart) and the voice
// routes both call these methods, so voice and touch do exactly the same thing.
import 'dart:async';
import 'dart:isolate';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';

import 'che_dsp.dart';
import 'che_song.dart';
import 'che_studio_audio.dart';
import 'che_wav.dart';

enum CheTransport { stopped, playing, paused, countIn, recording }

String cheClock(int samples) {
  final s = samples / cheStudioRate;
  final m = s ~/ 60;
  final rest = s - m * 60;
  return '$m:${rest.toStringAsFixed(1).padLeft(4, '0')}';
}

class CheStudioController extends ChangeNotifier {
  CheStudioController({required this.audio, required this.store, Future<List<Float32List>> Function(CheRenderJob job)? render, this.autosaveDelay = const Duration(milliseconds: 800)})
      : _render = render ?? ((job) => Isolate.run(() => cheRenderMix(job)));

  final CheStudioAudio audio;
  final CheSongStore store;
  final Future<List<Float32List>> Function(CheRenderJob job) _render;
  final Duration autosaveDelay;

  CheSong song = CheSong(title: 'New song');
  final Map<String, Float32List> sources = {};
  List<CheSong> songs = [];

  CheTransport transport = CheTransport.stopped;
  int playhead = 0;
  String? selectedTrack;
  String? selectedClip;
  bool metronome = false;
  int countInBars = 1;
  bool loop = false;
  bool punch = false;
  String status = '';
  String warning = '';
  double? inputLevel;
  bool busy = false;

  /// The take being recorded: where it lands on the timeline and how much count-in precedes it.
  int _takeStart = 0;
  int _takePreroll = 0;
  String? _takeTrack;
  Map<String, dynamic> _takeLatency = const {};
  Timer? _meter;
  Timer? _save;
  Stopwatch? _clock;
  int _playFrom = 0;
  int _playGen = 0;
  String? _lastTakeClip;

  /// Set by the voice route: CHE says the sentence before the sound starts, because her own voice would stop the
  /// music (one audio player) and would be recorded into a take.
  Future<void> Function(String sentence)? speakFirst;
  bool _spokeAhead = false;

  Future<void> _ahead(String sentence) async {
    final f = speakFirst;
    if (f == null) return;
    _spokeAhead = true;
    await f(sentence);
  }

  /// True once after an action said its result ahead of starting the sound.
  bool takeSpokeAhead() {
    final v = _spokeAhead;
    _spokeAhead = false;
    return v;
  }

  bool get playing => transport == CheTransport.playing;
  bool get recording => transport == CheTransport.recording || transport == CheTransport.countIn;

  /// Where the playhead is right now (moves while playing).
  int get position {
    final c = _clock;
    if (c != null && (playing || recording)) return _playFrom + (c.elapsedMicroseconds * cheStudioRate ~/ 1000000);
    return playhead;
  }

  CheTrack? get track => selectedTrack == null ? null : song.track(selectedTrack!);
  CheClip? get clip {
    for (final t in song.tracks) {
      for (final c in t.clips) {
        if (c.id == selectedClip) return c;
      }
    }
    return null;
  }

  String _say(String s) {
    status = s;
    notifyListeners();
    return s;
  }

  void _changed() {
    notifyListeners();
    _save?.cancel();
    _save = Timer(autosaveDelay, () => unawaited(saveNow()));
  }

  Future<String> saveNow() async {
    _save?.cancel();
    try {
      await store.save(song, sources);
      return 'Saved "${song.title}".';
    } catch (e) {
      return _say('I could not save "${song.title}": $e');
    }
  }

  // ---- Songs ----

  /// Opens the last song (autosave resume) or starts a new one; also loads the song list.
  Future<String> open() async {
    songs = await store.list();
    final last = await store.lastId();
    if (last != null) {
      final loaded = await store.load(last);
      if (loaded != null) {
        _use(loaded.$1, loaded.$2);
        return _say('Resumed "${song.title}": ${song.tracks.length} tracks, ${cheClock(song.end)} long.');
      }
    }
    await route();
    notifyListeners();
    return '';
  }

  void _use(CheSong s, Map<String, Float32List> src) {
    song = s;
    sources
      ..clear()
      ..addAll(src);
    playhead = 0;
    selectedTrack = s.tracks.where((t) => t.kind == 'vocal').firstOrNull?.id ?? s.tracks.firstOrNull?.id;
    selectedClip = null;
    notifyListeners();
  }

  Future<String> newSong({String? title}) async {
    await stop();
    if (song.tracks.isNotEmpty) await saveNow();
    final n = songs.length + 1;
    _use(CheSong(title: title ?? 'Song $n', tracks: [CheTrack(name: 'Vocals', kind: 'vocal')]), {});
    _changed();
    songs = [song, ...songs.where((s) => s.id != song.id)];
    return _say('New recording "${song.title}" at ${song.bpm.round()} BPM. Say record my vocals when you are ready.');
  }

  Future<String> openSong(String id) async {
    await stop();
    if (song.tracks.isNotEmpty) await saveNow();
    final loaded = await store.load(id);
    if (loaded == null) return _say('That song is not on this iPhone any more.');
    _use(loaded.$1, loaded.$2);
    return _say('Opened "${song.title}": ${song.tracks.length} tracks, ${cheClock(song.end)}.');
  }

  String rename(String title) {
    if (title.trim().isEmpty) return _say('The song needs a name.');
    song.title = title.trim();
    _changed();
    return _say('Renamed to "${song.title}".');
  }

  String setBpm(double bpm) {
    final b = bpm.clamp(40, 240).toDouble();
    song.bpm = b;
    _changed();
    return _say('Tempo ${b.round()} BPM.${song.tracks.any((t) => t.kind == 'beat') ? ' Say use the beat to rebuild the beat track at this tempo.' : ''}');
  }

  // ---- Output route and latency ----

  Future<String> route() async {
    final r = await audio.route();
    warning = cheLatencyWarning(r);
    notifyListeners();
    return warning;
  }

  // ---- Transport ----

  Future<String> play({String? onlyTrack, int? from}) async {
    if (recording) return _say('Recording is running. Say stop first.');
    if (song.end == 0 && onlyTrack == null) return _say('Nothing to play yet. Record a take, build a beat, or import a WAV.');
    final start = from ?? (loop && song.loopStart != null ? song.loopStart! : playhead);
    final to = loop && song.loopEnd != null ? song.loopEnd : null;
    final gen = ++_playGen;
    busy = true;
    notifyListeners();
    final mix = await _render(CheRenderJob(song: song.toJson(), sources: sources, from: start, to: to, metronome: metronome, onlyTrack: onlyTrack));
    busy = false;
    if (gen != _playGen) return '';
    final wav = cheEncodeWav(mix, cheStudioRate);
    final what = onlyTrack == null ? 'the song' : 'the ${song.track(onlyTrack)?.name ?? 'track'}';
    final said = _say('Playing $what from ${cheClock(start)}${loop ? ', looping' : ''}.');
    await _ahead(said);
    if (gen != _playGen) return said;
    _playFrom = start;
    _clock = Stopwatch()..start();
    transport = CheTransport.playing;
    notifyListeners();
    unawaited(_playLoop(wav, gen, start));
    return said;
  }

  Future<void> _playLoop(Uint8List wav, int gen, int start) async {
    while (true) {
      final ok = await audio.play(wav);
      if (gen != _playGen || transport != CheTransport.playing) return;
      if (!ok) {
        transport = CheTransport.stopped;
        _clock = null;
        _say('Playback stopped before the end${song.end == 0 ? '' : ' at ${cheClock(position)}'}.');
        return;
      }
      if (!loop) {
        transport = CheTransport.stopped;
        _clock = null;
        playhead = start;
        _say('Finished playing.');
        return;
      }
      _playFrom = start;
      _clock = Stopwatch()..start();
    }
  }

  Future<String> pause() async {
    if (!playing) return _say('Nothing is playing.');
    playhead = position;
    _playGen++;
    _clock = null;
    transport = CheTransport.paused;
    await audio.stop();
    return _say('Paused at ${cheClock(playhead)}.');
  }

  /// Stops playback or a take. A take in progress is kept and placed on its track.
  Future<String> stop() async {
    if (recording) return stopRecording();
    final was = playing;
    _playGen++;
    _clock = null;
    transport = CheTransport.stopped;
    if (was) await audio.stop();
    notifyListeners();
    return was ? _say('Stopped at ${cheClock(position)}.') : '';
  }

  String seek(int samples) {
    playhead = samples.clamp(0, math.max(song.end, samples)).toInt();
    if (playhead < 0) playhead = 0;
    notifyListeners();
    return _say('Playhead at ${cheClock(playhead)}.');
  }

  Future<String> nudge(double seconds) async {
    final wasPlaying = playing;
    if (wasPlaying) await pause();
    final s = seek(math.max(0, position + (seconds * cheStudioRate).round()));
    if (wasPlaying) return play();
    return s;
  }

  Future<String> rewind() async {
    if (playing) await pause();
    return seek(0);
  }

  String toggleLoop([bool? on]) {
    loop = on ?? !loop;
    if (loop && (song.loopStart == null || song.loopEnd == null)) {
      song.loopStart = (playhead ~/ song.barSamples) * song.barSamples;
      song.loopEnd = song.loopStart! + 4 * song.barSamples;
    }
    _changed();
    return _say(loop ? 'Loop on: ${cheClock(song.loopStart!)} to ${cheClock(song.loopEnd!)}.' : 'Loop off.');
  }

  String setLoop(int from, int to) {
    if (to - from < cheStudioRate ~/ 4) return _say('The loop must be at least a quarter second.');
    song.loopStart = from;
    song.loopEnd = to;
    loop = true;
    _changed();
    return _say('Loop ${cheClock(from)} to ${cheClock(to)}.');
  }

  String togglePunch([bool? on]) {
    punch = on ?? !punch;
    if (punch && (song.punchIn == null || song.punchOut == null)) {
      song.punchIn = playhead;
      song.punchOut = playhead + 2 * song.barSamples;
    }
    _changed();
    return _say(punch ? 'Punch on: the next take replaces ${cheClock(song.punchIn!)} to ${cheClock(song.punchOut!)}, with a bar of pre-roll.' : 'Punch off.');
  }

  String setPunch(int from, int to) {
    song.punchIn = from;
    song.punchOut = to;
    punch = true;
    _changed();
    return _say('Punch in ${cheClock(from)}, out ${cheClock(to)}.');
  }

  String toggleMetronome([bool? on]) {
    metronome = on ?? !metronome;
    notifyListeners();
    return _say(metronome ? 'Metronome on at ${song.bpm.round()} BPM.' : 'Metronome off.');
  }

  String setCountIn(int bars) {
    countInBars = bars.clamp(0, 2);
    notifyListeners();
    return _say(countInBars == 0 ? 'Count-in off.' : 'Count-in ${countInBars == 1 ? 'one bar' : 'two bars'}.');
  }

  String setLatency(double ms) {
    song.latencyMs = ms.clamp(-300, 300).toDouble();
    _changed();
    return _say('Take alignment ${song.latencyMs.round()} ms on top of what the iPhone measures.');
  }

  // ---- Recording ----

  CheTrack _vocalTrack() {
    final sel = track;
    if (sel != null && sel.kind == 'vocal') return sel;
    final t = song.tracks.where((t) => t.kind == 'vocal').firstOrNull ?? (CheTrack(name: 'Vocals', kind: 'vocal'));
    if (!song.tracks.contains(t)) song.tracks.add(t);
    selectedTrack = t.id;
    return t;
  }

  Future<String> addTrack({String kind = 'vocal'}) async {
    final n = song.tracks.where((t) => t.kind == kind).length + 1;
    final t = CheTrack(name: kind == 'vocal' ? 'Vocals $n' : kind == 'beat' ? 'Beat $n' : 'Track $n', kind: kind);
    song.tracks.add(t);
    selectedTrack = t.id;
    _changed();
    return _say('Added track ${song.tracks.length}, "${t.name}".');
  }

  /// Starts a take on the selected vocal track: count-in, then the song (and clicks) in the headphones while the
  /// microphone records. With punch on, it starts a bar before punch-in and keeps only punch-in to punch-out.
  Future<String> record() async {
    if (recording) return _say('Already recording.');
    await stop();
    final t = _vocalTrack();
    final start = punch && song.punchIn != null ? math.max(0, song.punchIn! - song.barSamples) : playhead;
    final countIn = countInBars * song.barSamples;
    busy = true;
    notifyListeners();
    final backing = await _render(CheRenderJob(
      song: song.toJson(), sources: sources, from: start, to: song.end > start ? null : start + 64 * song.barSamples,
      metronome: metronome || song.end <= start, countInBars: countInBars,
    ));
    busy = false;
    await _ahead('Recording on ${t.name}${countIn > 0 ? ' after a ${countInBars == 1 ? 'one' : 'two'} bar count-in' : ''}. Say stop when you are done.');
    try {
      _takeLatency = await audio.startRecording();
    } on CheAudioUnavailable catch (e) {
      notifyListeners();
      return _say(e.message);
    }
    final gen = ++_playGen;
    _takeStart = start;
    _takePreroll = countIn;
    _takeTrack = t.id;
    _playFrom = start - countIn;
    _clock = Stopwatch()..start();
    transport = countIn > 0 ? CheTransport.countIn : CheTransport.recording;
    warning = cheLatencyWarning(_takeLatency, measuredOutput: (_takeLatency['output_latency'] as num?)?.toDouble() ?? 0);
    _meter?.cancel();
    _meter = Timer.periodic(const Duration(milliseconds: 120), (_) async {
      inputLevel = await audio.level();
      if (transport == CheTransport.countIn && position >= start) transport = CheTransport.recording;
      notifyListeners();
    });
    unawaited(audio.play(cheEncodeWav(backing, cheStudioRate)).then((_) {
      if (gen == _playGen && recording) unawaited(stopRecording());
    }));
    final input = '${_takeLatency['input'] ?? ''}';
    return _say('Recording on ${t.name}${countIn > 0 ? ' after a ${countInBars == 1 ? 'one' : 'two'} bar count-in' : ''}'
        '${input.isEmpty ? '' : ' from $input'}. Say stop when you are done.');
  }

  /// Ends the take: the WAV is saved at once, lined up by the measured latency, and placed on its track.
  Future<String> stopRecording() async {
    if (!recording) return _say('Nothing is recording.');
    _playGen++;
    _meter?.cancel();
    inputLevel = null;
    _clock = null;
    transport = CheTransport.stopped;
    await audio.stop();
    CheTake? take;
    try {
      take = await audio.stopRecording();
    } on CheAudioUnavailable catch (e) {
      return _say(e.message);
    }
    if (take == null) return _say('The take came back empty, so nothing was added.');
    final CheAudio decoded;
    try {
      decoded = cheDecodeWav(take.wav);
    } on CheWavException catch (e) {
      return _say('The take could not be read: $e');
    }
    final samples = cheResample(decoded.mono(), decoded.sampleRate, cheStudioRate);
    final latency = take.inputLatency + take.outputLatency + song.latencyMs / 1000;
    final skip = _takePreroll + (latency * cheStudioRate).round();
    final t = song.track(_takeTrack ?? '') ?? _vocalTrack();
    if (samples.length - skip < cheStudioRate ~/ 10) return _say('The take was too short to keep.');
    final audioId = 'take_${DateTime.now().millisecondsSinceEpoch}';
    sources[audioId] = samples;
    await store.saveSource(song.id, audioId, samples);
    final c = CheClip(audioId: audioId, start: _takeStart, offset: math.max(0, skip), length: samples.length - math.max(0, skip));
    if (punch && song.punchIn != null && song.punchOut != null) {
      if (!cheTrimClip(c, from: song.punchIn, to: song.punchOut)) return _say('The take did not reach the punch range, so nothing changed.');
      _cutRange(t, song.punchIn!, song.punchOut!);
    }
    t.clips.add(c);
    t.clips.sort((a, b) => a.start.compareTo(b.start));
    selectedClip = c.id;
    _lastTakeClip = c.id;
    _changed();
    await saveNow();
    final peak = chePeakDb(Float32List.sublistView(samples, math.min(skip, samples.length)));
    return _say('Take saved on ${t.name}: ${(c.length / cheStudioRate).toStringAsFixed(1)} seconds at ${cheClock(c.start)}, '
        'peak ${peak.toStringAsFixed(1)} dB${peak > -1 ? ' (it clipped; move back from the mic)' : peak < -30 ? ' (very quiet; move closer)' : ''}. '
        'Lined up by ${(latency * 1000).round()} ms of measured delay.');
  }

  /// Removes what is under from..to on [t] (punch-in replaces that part of the older takes).
  void _cutRange(CheTrack t, int from, int to) {
    for (final c in [...t.clips]) {
      if (c.end <= from || c.start >= to) continue;
      if (c.start < from && c.end > to) {
        final right = cheSplitClip(t, c, to);
        cheTrimClip(c, to: from);
        if (right != null) cheTrimClip(right, from: to);
      } else if (c.start < from) {
        cheTrimClip(c, to: from);
      } else if (c.end > to) {
        cheTrimClip(c, from: to);
      } else {
        t.clips.remove(c);
      }
    }
  }

  /// Plays the last take (or the selected clip) from where it starts.
  Future<String> playBack() async {
    final id = selectedClip ?? _lastTakeClip;
    CheClip? c;
    for (final t in song.tracks) {
      c ??= t.clips.where((x) => x.id == id).firstOrNull;
    }
    if (c == null) return play(from: 0);
    return play(from: c.start);
  }

  // ---- Import ----

  Future<String> importWav(Uint8List bytes, {String name = 'Imported'}) async {
    final CheAudio a;
    try {
      a = cheDecodeWav(bytes);
    } on CheWavException catch (e) {
      return _say(e.message);
    }
    final samples = cheResample(a.mono(), a.sampleRate, cheStudioRate);
    final id = 'import_${DateTime.now().millisecondsSinceEpoch}';
    sources[id] = samples;
    await store.saveSource(song.id, id, samples);
    final t = CheTrack(name: name, kind: 'beat', clips: [CheClip(audioId: id, start: 0, length: samples.length)]);
    song.tracks.add(t);
    selectedTrack = t.id;
    _changed();
    return _say('Imported "$name": ${a.seconds.toStringAsFixed(1)} seconds, ${a.channels.length == 1 ? 'mono' : 'stereo'} ${a.sampleRate} Hz, on track ${song.tracks.length}.');
  }

  // ---- Editing (on the selected clip, at the playhead) ----

  String _needClip() => _say('Select a clip on the timeline first.');

  String select(String trackId, [String? clipId]) {
    selectedTrack = trackId;
    selectedClip = clipId;
    notifyListeners();
    final t = song.track(trackId);
    final c = clip;
    return _say(c == null ? 'Track ${t?.name} selected.' : 'Clip on ${t?.name}: ${cheClock(c.start)} to ${cheClock(c.end)}.');
  }

  CheTrack? _trackOf(CheClip c) => song.tracks.where((t) => t.clips.contains(c)).firstOrNull;

  String trimStart() {
    final c = clip;
    if (c == null) return _needClip();
    if (!cheTrimClip(c, from: position)) return _say('The playhead is not inside the clip.');
    _changed();
    return _say('Trimmed the start to ${cheClock(c.start)}.');
  }

  String trimEnd() {
    final c = clip;
    if (c == null) return _needClip();
    if (!cheTrimClip(c, to: position)) return _say('The playhead is not inside the clip.');
    _changed();
    return _say('Trimmed the end to ${cheClock(c.end)}.');
  }

  String split() {
    final c = clip;
    if (c == null) return _needClip();
    final t = _trackOf(c)!;
    final right = cheSplitClip(t, c, position);
    if (right == null) return _say('Move the playhead inside the clip to split it.');
    _changed();
    return _say('Split at ${cheClock(position)}. The clip is now two.');
  }

  String move(double beats) {
    final c = clip;
    if (c == null) return _needClip();
    cheMoveClip(c, (beats * song.beatSamples).round());
    _changed();
    return _say('Moved to ${cheClock(c.start)}.');
  }

  String duplicate() {
    final c = clip;
    if (c == null) return _needClip();
    final d = cheDuplicateClip(_trackOf(c)!, c);
    selectedClip = d.id;
    _changed();
    return _say('Duplicated: the copy starts at ${cheClock(d.start)}.');
  }

  /// Removes the selected clip from the timeline. Its recording stays on the iPhone with the song.
  String deleteClip() {
    final c = clip;
    if (c == null) return _needClip();
    _trackOf(c)!.clips.remove(c);
    selectedClip = null;
    _changed();
    return _say('Removed the clip from the timeline. The recording itself is still saved with the song.');
  }

  // ---- Mixer ----

  String setVolume(CheTrack t, double v) {
    t.volume = v.clamp(0, 1.5).toDouble();
    _changed();
    return _say('${t.name} volume ${(t.volume * 100).round()}%.');
  }

  String setPan(CheTrack t, double p) {
    t.pan = p.clamp(-1, 1).toDouble();
    _changed();
    final side = t.pan.abs() < 0.05 ? 'centre' : '${(t.pan.abs() * 100).round()}% ${t.pan < 0 ? 'left' : 'right'}';
    return _say('${t.name} panned $side.');
  }

  String toggleMute(CheTrack t) {
    t.mute = !t.mute;
    _changed();
    return _say('${t.name} ${t.mute ? 'muted' : 'unmuted'}.');
  }

  String toggleSolo(CheTrack t) {
    t.solo = !t.solo;
    _changed();
    return _say('${t.name} ${t.solo ? 'soloed' : 'solo off'}.');
  }

  /// Balances the mix from real measurements: every track's RMS is read and vocals are set about 3 dB over the beat.
  Future<String> balance() async {
    final levels = <CheTrack, double>{};
    for (final t in song.tracks) {
      if (t.clips.isEmpty) continue;
      final x = await Isolate.run(() => cheRenderTrack(t, sources));
      levels[t] = cheRmsDb(x);
    }
    if (levels.isEmpty) return _say('There is nothing to balance yet.');
    final parts = <String>[];
    for (final e in levels.entries) {
      final target = e.key.kind == 'vocal' ? -17.0 : -20.0;
      final g = cheGain((target - e.value).clamp(-18, 12)).clamp(0.05, 1.5).toDouble();
      e.key.volume = g;
      parts.add('${e.key.name} measured ${e.value.toStringAsFixed(1)} dB, set to ${(g * 100).round()}%');
    }
    _changed();
    return _say('Balanced: ${parts.join('; ')}.');
  }

  // ---- Effects ----

  CheTrack? _fxTrack() => track ?? song.tracks.where((t) => t.kind == 'vocal').firstOrNull;

  String applyPreset(String name) {
    final t = _fxTrack();
    if (t == null) return _say('Add a track first.');
    final make = CheEffects.presets[name];
    if (make == null) return _say('There is no preset called $name. Presets: ${CheEffects.presets.keys.join(', ')}.');
    final key = t.fx.key, scale = t.fx.scale;
    t.fx = make()
      ..key = key
      ..scale = scale;
    _changed();
    return _say('${t.name}: $name preset, ${t.fx.describe()}.');
  }

  String setEffect(String effect, double amount, {CheTrack? on}) {
    final t = on ?? _fxTrack();
    if (t == null) return _say('Add a track first.');
    final a = amount.clamp(0, 1).toDouble();
    final fx = t.fx..preset = 'Custom';
    switch (effect) {
      case 'reverb':
        fx.reverb = a;
      case 'delay':
        fx.delay = a;
      case 'pitch':
        fx.pitch = a;
      case 'compress':
        fx.compress = a;
      case 'noise':
        fx.noise = a > 0;
      default:
        return _say('I do not have an effect called $effect.');
    }
    _changed();
    return _say('${t.name}: ${fx.describe()}.');
  }

  String setEq(CheTrack t, {double? low, double? mid, double? high}) {
    t.fx
      ..preset = 'Custom'
      ..eqLow = (low ?? t.fx.eqLow).clamp(-12, 12).toDouble()
      ..eqMid = (mid ?? t.fx.eqMid).clamp(-12, 12).toDouble()
      ..eqHigh = (high ?? t.fx.eqHigh).clamp(-12, 12).toDouble();
    _changed();
    return _say('${t.name} EQ: low ${t.fx.eqLow.round()}, mid ${t.fx.eqMid.round()}, high ${t.fx.eqHigh.round()} dB.');
  }

  String setKey(CheTrack t, int key, String scale) {
    t.fx
      ..key = key % 12
      ..scale = cheScales.containsKey(scale) ? scale : 'chromatic';
    _changed();
    return _say('${t.name} pitch correction key: ${cheNoteNames[t.fx.key]} ${t.fx.scale}.');
  }

  // ---- Beat Maker ----

  String toggleStep(String instrument, int step) {
    final s = song.beat.steps[instrument];
    if (s == null || step < 0 || step >= 16) return '';
    s[step] = !s[step];
    _changed();
    return _say('${CheBeat.labels[instrument]} step ${step + 1} ${s[step] ? 'on' : 'off'}.');
  }

  String starterBeat() {
    song.beat = CheBeat.starter();
    _changed();
    return _say('Loaded a starter groove: kick, snare on two and four, eighth-note hats and an 808. Say play the beat.');
  }

  String clearBeat() {
    song.beat = CheBeat(bars: song.beat.bars, swing: song.beat.swing);
    _changed();
    return _say('Pattern cleared.');
  }

  String setSwing(double s) {
    song.beat.swing = s.clamp(0, 0.5).toDouble();
    _changed();
    return _say('Swing ${(song.beat.swing * 200).round()}%.');
  }

  /// Puts the pattern in the song as audio on the Beat track (rebuilt at the song's tempo each time).
  Future<String> useBeat() async {
    if (song.beat.empty) song.beat = CheBeat.starter();
    final beat = song.beat, bpm = song.bpm;
    final samples = await Isolate.run(() => beat.render(bpm));
    final id = 'beat_${DateTime.now().millisecondsSinceEpoch}';
    sources[id] = samples;
    await store.saveSource(song.id, id, samples);
    var t = song.tracks.where((t) => t.kind == 'beat' && t.name.startsWith('Beat')).firstOrNull;
    if (t == null) {
      t = CheTrack(name: 'Beat', kind: 'beat', volume: 0.8);
      song.tracks.insert(0, t);
    }
    t.clips
      ..clear()
      ..add(CheClip(audioId: id, start: 0, length: samples.length));
    _changed();
    return _say('The beat is on the Beat track: ${beat.bars} bars at ${bpm.round()} BPM, ${cheClock(samples.length)}.');
  }

  /// Plays the Beat Maker pattern (putting it in the song first if needed).
  Future<String> playBeat() async {
    var t = song.tracks.where((t) => t.kind == 'beat' && t.name.startsWith('Beat')).firstOrNull;
    if (t == null || t.clips.isEmpty) {
      await useBeat();
      t = song.tracks.where((t) => t.kind == 'beat' && t.name.startsWith('Beat')).first;
    }
    return play(onlyTrack: t.id, from: 0);
  }

  // ---- Master and export ----

  Future<String> master({bool? on}) async {
    song.master.enabled = on ?? true;
    _changed();
    if (!song.master.enabled) return _say('Mastering off.');
    if (song.end == 0) return _say('Mastering is on; it will apply once there is audio.');
    final job = CheRenderJob(song: song.toJson(), sources: sources, applyMaster: false);
    final m = song.master;
    final report = await Isolate.run(() {
      final mix = cheRenderMix(job);
      return cheMasterStereo(mix[0], mix[1], m);
    });
    return _say('Mastered: peak ${report.peakBefore.toStringAsFixed(1)} to ${report.peakAfter.toStringAsFixed(1)} dB, '
        'average level ${report.rmsBefore.toStringAsFixed(1)} to ${report.rmsAfter.toStringAsFixed(1)} dB RMS. Play it to hear the master.');
  }

  /// Renders the whole song and saves it as a WAV in Files, On My iPhone, CHE, CHE Songs, Exports.
  Future<String> export() async {
    if (song.end == 0) return _say('There is nothing to export yet.');
    await stop();
    busy = true;
    notifyListeners();
    try {
      final mix = await _render(CheRenderJob(song: song.toJson(), sources: sources));
      final wav = cheEncodeWav(mix, cheStudioRate);
      final f = await store.export(song, wav);
      await saveNow();
      return _say('Exported "${song.title}" as a WAV: ${cheClock(mix.first.length)}, ${(wav.length / 1048576).toStringAsFixed(1)} MB, '
          'in Files, On My iPhone, CHE, CHE Songs, Exports (${f.path.split('/').last}). MP3 and M4A export are not available yet.');
    } catch (e) {
      return _say('Export failed: $e');
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  /// A short, true summary of the song for CHE's writing help (lyrics, melody, arrangement).
  String brief() {
    final parts = [
      '"${song.title}" at ${song.bpm.round()} BPM, ${cheClock(song.end)} long',
      for (final t in song.tracks) '${t.name} (${t.kind}, ${t.clips.length} clips, ${t.fx.describe()})',
    ];
    return parts.join('; ');
  }

  @override
  void dispose() {
    _meter?.cancel();
    if (_save?.isActive == true) unawaited(saveNow());
    _save?.cancel();
    super.dispose();
  }
}

/// The studio's voice routes. Returns what CHE says, or null when the words are not for the studio. With
/// [speakFirst], sound-starting actions (play, record) say their sentence before the sound and return ''.
Future<String?> cheStudioVoice(CheStudioController c, String said,
    {void Function(int tab)? showTab, Future<void> Function(String prompt)? ask, Future<void> Function(String sentence)? speakFirst}) async {
  c.speakFirst = speakFirst;
  try {
    final reply = await _studioVoice(c, said, showTab: showTab, ask: ask);
    return c.takeSpokeAhead() && reply != null ? '' : reply;
  } finally {
    c.speakFirst = null;
  }
}

Future<String?> _studioVoice(CheStudioController c, String said, {void Function(int tab)? showTab, Future<void> Function(String prompt)? ask}) async {
  final s = said.toLowerCase().replaceAll(RegExp(r"[^a-z0-9 ']"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  bool has(String p) => RegExp(p).hasMatch(s);
  final pct = RegExp(r'(\d{1,3})\s*(?:percent|%)').firstMatch(s);
  double amount(double d) => pct == null ? d : int.parse(pct.group(1)!) / 100;

  if (has(r'\b(record|recording)\b') && has(r'\b(vocals?|voice|me|take|start|again|new take)\b|^record$|^start recording$')) {
    showTab?.call(0);
    return c.record();
  }
  if (has(r'^(stop|stop recording|stop it|stop playing|that s it|done|cut)$') || has(r'\bstop (recording|playback|the music|playing)\b')) {
    final r = await c.stop();
    return r.isEmpty ? 'Nothing is playing or recording.' : r;
  }
  if (has(r'\b(play|hear) (that|it) back\b|\bplayback\b|\blet me hear (it|that)\b|\bplay (my|the) (last )?take\b')) return c.playBack();
  if (has(r'\bplay (the |my )?beat\b|\bhear the beat\b')) {
    showTab?.call(2);
    return c.playBeat();
  }
  if (has(r'^(play|play the song|play it|resume|play from here)$')) return c.play();
  if (has(r'^pause\b')) return c.pause();
  if (has(r'\b(rewind|back to the start|go to the start|from the top)\b')) {
    final r = await c.rewind();
    return has(r'from the top') ? c.play() : r;
  }
  if (has(r'\b(fast forward|skip ahead|forward)\b')) return c.nudge(10);
  if (has(r'\bback (ten|10|five|5) seconds\b|\bgo back\b')) return c.nudge(has(r'five|5') ? -5 : -10);
  if (has(r'\bloop (on|it|this)\b|\bturn on (the )?loop\b')) return c.toggleLoop(true);
  if (has(r'\bloop off\b|\bturn off (the )?loop\b|\bstop looping\b')) return c.toggleLoop(false);
  if (has(r'\bpunch (in|on)\b')) return c.togglePunch(true);
  if (has(r'\bpunch off\b')) return c.togglePunch(false);
  if (has(r'\bmetronome (on|please)\b|\bturn on (the )?(metronome|click)\b|\bclick track on\b')) return c.toggleMetronome(true);
  if (has(r'\bmetronome off\b|\bturn off (the )?(metronome|click)\b')) return c.toggleMetronome(false);
  if (has(r'\bno count ?in\b|\bcount ?in off\b')) return c.setCountIn(0);
  if (has(r'\bcount ?in\b')) return c.setCountIn(has(r'two|2') ? 2 : 1);
  final bpm = RegExp(r'\b(?:tempo|bpm)\D{0,12}(\d{2,3})\b|\b(\d{2,3}) ?bpm\b').firstMatch(s);
  if (bpm != null) return c.setBpm(double.parse(bpm.group(1) ?? bpm.group(2)!));
  if (has(r'\b(new (recording|song|track)|start a new song)\b')) {
    showTab?.call(0);
    return has(r'new track') ? c.addTrack() : c.newSong();
  }
  if (has(r'\b(remove|no|turn off|take off) (the )?reverb\b')) return c.setEffect('reverb', 0);
  if (has(r'\breverb\b')) {
    showTab?.call(4);
    return c.setEffect('reverb', amount(has(r'\b(more|lots|big|huge)\b') ? 0.6 : 0.3));
  }
  if (has(r'\b(remove|no|turn off) (the )?(delay|echo)\b')) return c.setEffect('delay', 0);
  if (has(r'\b(delay|echo)\b')) {
    showTab?.call(4);
    return c.setEffect('delay', amount(0.3));
  }
  if (has(r'\b(remove|no|turn off) (the )?(auto ?tune|pitch correction|tuning)\b')) return c.setEffect('pitch', 0);
  if (has(r'\b(auto ?tune|pitch correct|pitch correction|tune my vocals?|tune it)\b')) {
    showTab?.call(4);
    return c.setEffect('pitch', amount(has(r'\b(hard|heavy|strong|robot)\b') ? 1 : 0.7));
  }
  if (has(r'\b(compress|compression|compressor)\b')) {
    showTab?.call(4);
    return c.setEffect('compress', amount(0.5));
  }
  if (has(r'\b(noise reduction|reduce (the )?noise|remove (the )?(noise|hiss|background))\b')) {
    showTab?.call(4);
    return c.setEffect('noise', 1);
  }
  for (final p in CheEffects.presets.keys) {
    if (p != 'None' && s.contains(p.toLowerCase())) {
      showTab?.call(4);
      return c.applyPreset(p);
    }
  }
  if (has(r'\b(balance|mix) (the |my )?(mix|song|tracks?)\b|\bmix it\b')) {
    showTab?.call(3);
    return c.balance();
  }
  if (has(r'\bmaster (the |my |it|this)?\b|\bmastering\b')) {
    showTab?.call(5);
    return c.master();
  }
  if (has(r'\bexport\b|\bsave (it )?as (a )?wav\b')) return c.export();
  if (has(r'\b(use|add) the beat\b|\bput the beat in\b')) return c.useBeat();
  if (has(r'\bstarter beat\b|\bmake (me )?a beat\b')) {
    showTab?.call(2);
    return c.starterBeat();
  }
  if (has(r'\bsplit\b')) return c.split();
  if (has(r'\bduplicate\b')) return c.duplicate();
  if (has(r'\bsave\b')) return c.saveNow();
  const tabs = {'timeline': 0, 'record': 0, 'my songs': 1, 'songs': 1, 'beat maker': 2, 'mixer': 3, 'effects': 4, 'mastering': 5, 'master': 5};
  for (final e in tabs.entries) {
    if (has('\\b(open|show|go to)( the| my)? ${e.key}\\b')) {
      showTab?.call(e.value);
      return 'Showing ${e.key}.';
    }
  }
  if (ask != null && has(r'\b(lyrics|melody|chorus|verse|hook|rhymes?)\b')) {
    await ask('Help me with my song in the CHE Recording Studio. $said\nWhat the song really has now: ${c.brief()}.');
    return '';
  }
  return null;
}
