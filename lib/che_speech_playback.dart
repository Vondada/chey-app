// The playback controller for one spoken CHE reply (owner, 2026-10-22): play, pause, resume from the exact
// position, stop, seek across clip boundaries, and speed changes, all on audio that already exists.
//
// Credit rules (ElevenLabs is paid per character):
// - Pausing, resuming, seeking, replaying and changing speed never synthesize speech. Only a cache miss on
//   an explicit Play starts a request, and a seek into missing audio is reported, never silently re-bought.
// - Requests for the same text, voice, model and settings share one future and one cache entry.
// - Stop cancels the queue and stops new requests. Audio already requested still arrives, is cached (it was
//   paid for) and is never played after Stop. Provider charges are not refunded by any action here.
//
// This file is pure Dart. The native player is injected through [CheClipPlayer]; its capabilities say what
// the build can really do, so the controller never claims a pause the iPhone cannot perform.
import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'che_stream_batcher.dart' show cheReadAloudChunks;

/// Most generated speech kept for replay and seeking. Memory only: it is cleared when CHE closes.
const int kSpeechCacheMaxBytes = 16 * 1024 * 1024;

/// How many clips beyond the one playing may be requested at once.
const int kSpeechPrefetchLimit = 2;

/// Playback speeds the owner can choose.
const List<double> kSpeechRates = [0.75, 1.0, 1.25, 1.5, 2.0];

/// The voice a reply is locked to. A seek, resume or replay uses the same values, never another voice.
class CheSpeechVoice {
  const CheSpeechVoice({required this.voiceId, required this.model, this.settings = ''});
  final String voiceId;
  final String model;
  final String settings;

  String cacheKey(String text) => '$voiceId\u001f$model\u001f$settings\u001f$text';
}

/// The chunks a reply is spoken in. Uses the shared chunker, so the bounds match the live voice path.
List<String> speechClipsFor(String text) => cheReadAloudChunks(text);

/// Generated audio kept in memory, least recently used first out, with a byte cap.
class CheSpeechCache {
  CheSpeechCache({this.maxBytes = kSpeechCacheMaxBytes});
  final int maxBytes;
  final LinkedHashMap<String, Uint8List> _items = LinkedHashMap();
  int _bytes = 0;

  int get bytes => _bytes;
  int get count => _items.length;

  Uint8List? get(String key) {
    final value = _items.remove(key);
    if (value != null) _items[key] = value;
    return value;
  }

  void put(String key, Uint8List value) {
    if (value.length > maxBytes) return;
    final old = _items.remove(key);
    if (old != null) _bytes -= old.length;
    _items[key] = value;
    _bytes += value.length;
    while (_bytes > maxBytes && _items.isNotEmpty) {
      final oldest = _items.keys.first;
      _bytes -= _items.remove(oldest)!.length;
    }
  }

  /// Privacy: called when CHE closes, so generated speech does not outlive the app session.
  void clear() {
    _items.clear();
    _bytes = 0;
  }
}

/// What the owner's ElevenLabs use was, counted honestly. "Generated" means the provider returned audio.
class CheSpeechUsage {
  int requested = 0;
  int generated = 0;
  int generatedBytes = 0;
  int cacheHits = 0;
  int sharedInFlight = 0;
  int cancelledAfterRequest = 0;
  int failed = 0;
}

/// Synthesizes one clip. Returns null when the provider gave no audio.
typedef CheSynthesizeClip = Future<Uint8List?> Function(String text, CheSpeechVoice voice);

/// Gives the controller audio for a clip. Caches it, shares requests, and only spends on an explicit allowance.
class CheSpeechSource {
  CheSpeechSource({required this.synthesize, CheSpeechCache? cache, CheSpeechUsage? usage})
      : cache = cache ?? CheSpeechCache(),
        usage = usage ?? CheSpeechUsage();

  final CheSynthesizeClip synthesize;
  final CheSpeechCache cache;
  final CheSpeechUsage usage;
  final Map<String, Future<Uint8List?>> _inFlight = {};
  final Set<String> _cancelled = {};

  /// Cached audio only. Never requests anything.
  Uint8List? cached(String text, CheSpeechVoice voice) => cache.get(voice.cacheKey(text));

  /// Audio for [text]. A cache hit or an in-flight request is reused. A new request needs [allowSpend], which is true
  /// only for an explicit Play on a clip that has no audio yet.
  Future<Uint8List?> clip(String text, CheSpeechVoice voice, {bool allowSpend = false}) {
    final key = voice.cacheKey(text);
    final hit = cache.get(key);
    if (hit != null) {
      usage.cacheHits++;
      return Future.value(hit);
    }
    final pending = _inFlight[key];
    if (pending != null) {
      usage.sharedInFlight++;
      return pending;
    }
    if (!allowSpend) return Future.value(null);
    usage.requested++;
    final request = synthesize(text, voice).then<Uint8List?>((bytes) {
      _inFlight.remove(key);
      if (bytes == null || bytes.isEmpty) {
        usage.failed++;
        return null;
      }
      // Paid for, so it is kept even when the reply was stopped while it was on its way.
      cache.put(key, bytes);
      usage.generated++;
      usage.generatedBytes += bytes.length;
      if (_cancelled.remove(key)) usage.cancelledAfterRequest++;
      return bytes;
    }, onError: (Object _) {
      _inFlight.remove(key);
      usage.failed++;
      return null;
    });
    _inFlight[key] = request;
    return request;
  }

  /// Stop: nothing new is requested. Requests already in flight are marked, so the meter reports them honestly.
  void cancelPending(Iterable<String> texts, CheSpeechVoice voice) {
    for (final text in texts) {
      final key = voice.cacheKey(text);
      if (_inFlight.containsKey(key)) _cancelled.add(key);
    }
  }
}

/// The native player, behind an interface. [CheClipPlayerCapabilities] says what this build can really do.
class CheClipPlayerCapabilities {
  const CheClipPlayerCapabilities({this.pause = false, this.seek = false, this.rate = false});
  final bool pause;
  final bool seek;
  final bool rate;
}

abstract class CheClipPlayer {
  CheClipPlayerCapabilities get capabilities;

  /// Loads [bytes] and starts at [offset]. Returns the clip's duration when the player knows it.
  Future<Duration?> load(Uint8List bytes, {Duration offset = Duration.zero, double rate = 1.0});
  Future<void> resume();
  Future<void> pause();
  Future<void> stop();
  Future<void> setRate(double rate);

  /// Position within the loaded clip.
  Future<Duration> position();

  /// The length of [bytes] without playing it, or null when the player cannot tell. Lets a seek cross into a
  /// clip that was prefetched but never played.
  Future<Duration?> durationOf(Uint8List bytes);
}

enum CheSpeechState { idle, loading, playing, paused, stopped, finished }

/// The outcome of a seek or a replay, so the UI can say exactly what happened.
enum CheSeekResult { moved, unknownLength, audioMissing, unsupported }

/// One reply's playback. Clips come from [clips]; their audio comes from [source]; the native player plays it.
class CheSpeechPlayback extends ChangeNotifier {
  CheSpeechPlayback({
    required this.clips,
    required this.voice,
    required this.source,
    required this.player,
    this.prefetchLimit = kSpeechPrefetchLimit,
  })  : assert(clips.isNotEmpty),
        _durations = List<Duration?>.filled(clips.length, null);

  final List<String> clips;
  final CheSpeechVoice voice;
  final CheSpeechSource source;
  final CheClipPlayer player;
  final int prefetchLimit;

  final List<Duration?> _durations;
  CheSpeechState _state = CheSpeechState.idle;
  String _message = '';

  /// The last thing the owner needs to read on screen (a seek that could not happen, for example).
  String get message => _message;
  void reportMessage(String value) {
    _message = value;
    notifyListeners();
  }

  CheSpeechState get state => _state;
  void _setState(CheSpeechState value) {
    if (_state == value) return;
    _state = value;
    _message = '';
    notifyListeners();
  }

  int _index = 0;
  Duration _offset = Duration.zero;
  double rate = 1.0;
  bool _prefetchOpen = true;

  int get clipIndex => _index;
  bool get prefetchOpen => _prefetchOpen;

  /// Total length when every clip's duration is known, else null (never estimated).
  Duration? get total {
    var sum = Duration.zero;
    for (final d in _durations) {
      if (d == null) return null;
      sum += d;
    }
    return sum;
  }

  /// Where playback is, from the start of the reply, when every earlier clip's length is known.
  Duration? get position {
    var sum = Duration.zero;
    for (var i = 0; i < _index; i++) {
      final d = _durations[i];
      if (d == null) return null;
      sum += d;
    }
    return sum + _offset;
  }

  /// Play, or resume after a pause from the saved position. Starting a clip with no audio yet is the one explicit spend.
  Future<void> play() async {
    if (state == CheSpeechState.playing || state == CheSpeechState.loading) return;
    if (state == CheSpeechState.paused && player.capabilities.pause) {
      _prefetchOpen = true;
      _setState(CheSpeechState.playing);
      await player.resume();
      unawaited(_prefetchAhead());
      return;
    }
    if (state == CheSpeechState.finished || state == CheSpeechState.stopped) {
      _index = 0;
      _offset = Duration.zero;
    }
    await _loadCurrent(allowSpend: true);
  }

  /// Pause keeps the exact position and stops synthesis. Only a player that can pause is paused; otherwise the
  /// caller must be told (see [player.capabilities]) and nothing here pretends the audio is paused.
  Future<bool> pause() async {
    if (state != CheSpeechState.playing) return false;
    if (!player.capabilities.pause) return false;
    _offset = await _safePosition();
    await player.pause();
    _setState(CheSpeechState.paused);
    _prefetchOpen = false;
    return true;
  }

  /// Stop: the queue is cancelled, nothing auto-continues, and the next Play starts again from the top.
  Future<void> stop() async {
    _prefetchOpen = false;
    source.cancelPending(clips.skip(_index), voice);
    _setState(CheSpeechState.stopped);
    _index = 0;
    _offset = Duration.zero;
    await player.stop();
  }

  /// "Skip the remaining response": stop the reply where it is and mark it finished, with no further synthesis.
  Future<void> skipRemaining() async {
    _prefetchOpen = false;
    source.cancelPending(clips.skip(_index + 1), voice);
    _setState(CheSpeechState.finished);
    await player.stop();
  }

  Future<CheSeekResult> replay() => seekTo(Duration.zero);

  /// Moves [delta] from the current position (negative rewinds). Works across clip boundaries, from audio that already exists.
  Future<CheSeekResult> seekBy(Duration delta) async {
    // While playing, the native player knows where it is; ask it rather than trust the last saved offset.
    if (state == CheSpeechState.playing) _offset = await _safePosition();
    final now = position;
    if (now == null) return CheSeekResult.unknownLength;
    return seekTo(now + delta);
  }

  Future<CheSeekResult> seekTo(Duration target) async {
    if (!player.capabilities.seek) return CheSeekResult.unsupported;
    var remaining = target < Duration.zero ? Duration.zero : target;
    for (var i = 0; i < clips.length; i++) {
      final length = await _lengthOf(i);
      if (length == null) {
        // Missing audio is reported as missing; it is never generated again without an explicit Play.
        return source.cached(clips[i], voice) == null ? CheSeekResult.audioMissing : CheSeekResult.unknownLength;
      }
      if (remaining < length || i == clips.length - 1) {
        final audio = source.cached(clips[i], voice)!;
        final wasPlaying = state == CheSpeechState.playing;
        _index = i;
        _offset = remaining > length ? length : remaining;
        final loaded = await player.load(audio, offset: _offset, rate: rate);
        _durations[i] = loaded ?? length;
        _setState(wasPlaying ? CheSpeechState.playing : CheSpeechState.paused);
        if (wasPlaying) unawaited(_prefetchAhead());
        return CheSeekResult.moved;
      }
      remaining -= length;
    }
    return CheSeekResult.unknownLength;
  }

  /// The length of clip [i]: known from playback, or read from its cached audio. Null when neither is available.
  Future<Duration?> _lengthOf(int i) async {
    final known = _durations[i];
    if (known != null) return known;
    final audio = source.cached(clips[i], voice);
    if (audio == null) return null;
    return _durations[i] = await player.durationOf(audio);
  }

  /// Local playback speed on the audio already held. Never synthesizes.
  Future<bool> setRate(double value) async {
    if (!kSpeechRates.contains(value)) return false;
    rate = value;
    if (!player.capabilities.rate) return false;
    await player.setRate(value);
    return true;
  }

  Future<void> _loadCurrent({required bool allowSpend}) async {
    final text = clips[_index];
    final cached = source.cached(text, voice);
    if (cached == null) {
      _setState(CheSpeechState.loading);
      final bytes = await source.clip(text, voice, allowSpend: allowSpend);
      if (bytes == null) {
        _setState(CheSpeechState.stopped);
        return;
      }
      if (_state != CheSpeechState.loading) return; // stopped while the audio was on its way
      await _start(bytes);
    } else {
      await _start(cached);
    }
  }

  Future<void> _start(Uint8List bytes) async {
    _setState(CheSpeechState.playing);
    final loaded = await player.load(bytes, offset: _offset, rate: rate);
    _durations[_index] = loaded ?? _durations[_index];
    unawaited(_prefetchAhead());
  }

  /// Requests clips after the current one, up to [prefetchLimit], and only while playing (never while paused).
  Future<void> _prefetchAhead() async {
    if (!_prefetchOpen || state != CheSpeechState.playing) return;
    for (var i = _index + 1; i <= _index + prefetchLimit && i < clips.length; i++) {
      if (!_prefetchOpen) return;
      unawaited(source.clip(clips[i], voice, allowSpend: true));
    }
  }

  Future<Duration> _safePosition() async {
    try {
      return await player.position();
    } catch (_) {
      return _offset;
    }
  }
}

/// A spoken playback command, read from a short utterance. Long sentences are conversation, not playback.
class CheSpeechCommand {
  const CheSpeechCommand(this.kind, {this.seconds = 0, this.rate = 1.0});
  final String kind; // pause, resume, stop, rewind, forward, replay, speed
  final int seconds;
  final double rate;

  @override
  String toString() => 'CheSpeechCommand($kind, seconds: $seconds, rate: $rate)';
}

const _numberWords = {
  'ten': 10, 'fifteen': 15, 'thirty': 30, 'five': 5, 'twenty': 20,
};

/// The playback command in a spoken or typed phrase, or null. Stop and pause are never sent to the model.
CheSpeechCommand? parseSpeechCommand(String utterance) {
  var text = utterance.toLowerCase().replaceAll(RegExp(r'[^a-z0-9 ]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  text = text.replaceFirst(RegExp(r'^(che|chey|chay)\s+'), '');
  if (text.isEmpty || text.split(' ').length > 8) return null;
  if (RegExp(r'^(pause|pause (it|that|talking|playing)|hold on)$').hasMatch(text)) return const CheSpeechCommand('pause');
  if (RegExp(r'^(resume|resume (playing|talking|reading)|keep going|continue|play)$').hasMatch(text)) return const CheSpeechCommand('resume');
  if (RegExp(r'^(stop|stop talking|stop speaking|be quiet|stop reading|stop playing)$').hasMatch(text)) return const CheSpeechCommand('stop');
  if (RegExp(r'^(play that again|play it again|read that again|replay|play from the start|from the beginning)$').hasMatch(text)) {
    return const CheSpeechCommand('replay');
  }
  final rewind = RegExp(r'^rewind (\d+|ten|fifteen|thirty|five|twenty) seconds?$').firstMatch(text);
  if (rewind != null) return CheSpeechCommand('rewind', seconds: _seconds(rewind.group(1)!));
  final skip = RegExp(r'^(skip|skip ahead|fast forward|forward) (\d+|ten|fifteen|thirty|five|twenty) seconds?( ahead)?$').firstMatch(text);
  if (skip != null) return CheSpeechCommand('forward', seconds: _seconds(skip.group(2)!));
  if (RegExp(r'^(read this|read that|play this|play that)? ?at (double speed|two times|2x|2 times)$|^double speed$').hasMatch(text)) {
    return const CheSpeechCommand('speed', rate: 2.0);
  }
  return null;
}

int _seconds(String raw) => int.tryParse(raw) ?? _numberWords[raw] ?? 0;
