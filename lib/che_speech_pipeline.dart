// Gapless speech for one assistant turn.
//
// Root cause this replaces: each sentence used to run its own full
// stop-mic -> synthesize -> play -> restart-mic cycle, strictly one after
// another, so every sentence boundary cost a whole TTS network round trip
// plus a microphone stop/start (multi-second dead air).
//
// Here, synthesis of chunk N+1 (and up to [prefetch] chunks ahead) starts as
// soon as the chunk arrives, while chunk N is still playing. Playback drains
// a FIFO queue in order. The turn's setup ([ready]) and teardown
// ([onComplete], where listening resumes) run exactly once per turn, never
// between chunks. [cancel] (barge-in / stop) drops everything immediately.

import 'dart:async';
import 'dart:typed_data';

/// One synthesized server-voice clip and the engine that produced it.
class CheVoiceClip {
  const CheVoiceClip(this.bytes, this.engine);
  final Uint8List bytes;
  final String engine;
}

typedef CheSynthesize<A> = Future<A?> Function(String text);
typedef ChePlayAudio<A> = Future<bool> Function(A audio);
typedef CheSpeakFallback = Future<bool> Function(String text);

class CheSpeechPipeline<A> {
  CheSpeechPipeline({
    required this.synthesize,
    required this.play,
    required this.fallback,
    Future<void>? ready,
    this.onComplete,
    this.log,
    this.prefetch = 2,
    DateTime Function()? clock,
  })  : _ready = ready ?? Future<void>.value(),
        _clock = clock ?? DateTime.now {
    _start = _clock();
  }

  final CheSynthesize<A> synthesize;
  final ChePlayAudio<A> play;
  final CheSpeakFallback fallback;

  /// Runs once after the last chunk (or on cancel), before [done] completes.
  final Future<void> Function(bool cancelled)? onComplete;
  final void Function(String message)? log;

  /// How many chunks beyond the one playing may be synthesizing at once.
  final int prefetch;

  final Future<void> _ready;
  final DateTime Function() _clock;
  late final DateTime _start;
  final List<_Chunk<A>> _chunks = [];
  final Completer<void> _done = Completer<void>();
  final Completer<void> _cancelSignal = Completer<void>();
  Completer<void>? _wake;
  int _next = 0;
  bool _closed = false;
  bool _cancelled = false;
  bool _running = false;
  int? _lastPlaybackEndMs;

  /// Silence between the end of one chunk and the start of the next (ms).
  final List<int> gapsMs = [];

  bool get cancelled => _cancelled;
  Future<void> get done => _done.future;

  int get _nowMs => _clock().difference(_start).inMilliseconds;

  void _mark(String event) => log?.call('+${_nowMs}ms $event');

  /// Queues [text]; its synthesis may start right away.
  void add(String text) {
    if (_closed || _cancelled || text.trim().isEmpty) return;
    final chunk = _Chunk<A>(_chunks.length, text);
    _chunks.add(chunk);
    _mark('chunk ${chunk.index} received (${text.length} chars)');
    _prefetch();
    _wake?.complete();
    _wake = null;
    if (!_running) {
      _running = true;
      unawaited(_run());
    }
  }

  /// No more chunks will arrive; [done] completes after the queue drains.
  void close() {
    if (_closed) return;
    _closed = true;
    _wake?.complete();
    _wake = null;
    if (!_running) {
      _running = true;
      unawaited(_run());
    }
  }

  /// Barge-in / stop: drop queued audio and finish now.
  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    _mark('cancelled');
    if (!_cancelSignal.isCompleted) _cancelSignal.complete();
    _wake?.complete();
    _wake = null;
  }

  void _prefetch() {
    if (_cancelled) return;
    final limit = _next + prefetch;
    for (var i = _next; i < _chunks.length && i <= limit; i++) {
      final chunk = _chunks[i];
      if (chunk.audio != null) continue;
      _mark('tts ${chunk.index} request started');
      final started = _nowMs;
      chunk.audio = synthesize(chunk.text).then((audio) {
        _mark('tts ${chunk.index} response ${audio == null ? 'failed' : 'received'} '
            'after ${_nowMs - started}ms');
        return audio;
      }, onError: (Object _) {
        _mark('tts ${chunk.index} error after ${_nowMs - started}ms');
        return null;
      });
    }
  }

  Future<void> _run() async {
    try {
      await Future.any<void>([_ready, _cancelSignal.future]);
      while (!_cancelled) {
        if (_next >= _chunks.length) {
          if (_closed) break;
          _wake = Completer<void>();
          await _wake!.future;
          continue;
        }
        final chunk = _chunks[_next];
        _prefetch();
        // Waiting on synthesis never delays a barge-in.
        final audio = await Future.any<A?>([
          chunk.audio!,
          _cancelSignal.future.then((_) => null),
        ]);
        if (_cancelled) break;
        _mark('audio ${chunk.index} queued');
        final startMs = _nowMs;
        if (_lastPlaybackEndMs != null) {
          final gap = startMs - _lastPlaybackEndMs!;
          gapsMs.add(gap);
          _mark('gap before chunk ${chunk.index}: ${gap}ms');
        }
        _mark('playback ${chunk.index} started');
        var played = false;
        if (audio != null) {
          try {
            played = await play(audio);
          } catch (_) {
            played = false;
          }
        }
        if (!played && !_cancelled) {
          _mark('fallback voice for chunk ${chunk.index}');
          try {
            await fallback(chunk.text);
          } catch (_) {}
        }
        _lastPlaybackEndMs = _nowMs;
        _mark('playback ${chunk.index} ended');
        _next++;
      }
    } finally {
      if (gapsMs.isNotEmpty) {
        final worst = gapsMs.reduce((a, b) => a > b ? a : b);
        _mark('turn finished; inter-chunk gaps ms $gapsMs (max $worst)');
      }
      try {
        await onComplete?.call(_cancelled);
      } catch (_) {}
      if (!_done.isCompleted) _done.complete();
    }
  }
}

class _Chunk<A> {
  _Chunk(this.index, this.text);
  final int index;
  final String text;
  Future<A?>? audio;
}
