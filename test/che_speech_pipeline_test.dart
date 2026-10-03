import 'dart:async';

import 'package:chey/che_speech_pipeline.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the order of synthesis / playback events with controllable timing.
class _Harness {
  final events = <String>[];
  final synth = <String, Completer<String?>>{};
  final plays = <String, Completer<bool>>{};
  int completes = 0;
  bool? completedCancelled;

  late final CheSpeechPipeline<String> pipeline = CheSpeechPipeline<String>(
    synthesize: (text) {
      events.add('synth:$text');
      return (synth[text] = Completer<String?>()).future;
    },
    play: (audio) {
      events.add('play:$audio');
      return (plays[audio] = Completer<bool>()).future;
    },
    fallback: (text) async {
      events.add('fallback:$text');
      return true;
    },
    onComplete: (cancelled) async {
      completes++;
      completedCancelled = cancelled;
      events.add('complete');
    },
  );
}

Future<void> _flush() => Future<void>.delayed(Duration.zero);

void main() {
  test('next chunk is synthesized while the current chunk is still playing', () async {
    final h = _Harness();
    h.pipeline
      ..add('one')
      ..add('two')
      ..add('three');
    await _flush();
    // All three requested up front (prefetch 2 beyond the head), before any play.
    expect(h.events, ['synth:one', 'synth:two', 'synth:three']);
    h.synth['one']!.complete('A1');
    await _flush();
    expect(h.events.last, 'play:A1');
    // Chunk two's audio is ready before chunk one finishes playing.
    h.synth['two']!.complete('A2');
    await _flush();
    expect(h.plays.containsKey('A2'), isFalse, reason: 'must not overlap playback');
    h.plays['A1']!.complete(true);
    await _flush();
    expect(h.events.last, 'play:A2', reason: 'starts immediately, no new TTS round trip');
    expect(h.pipeline.gapsMs.single, lessThan(50));
  });

  test('playback keeps FIFO order even if later audio arrives first', () async {
    final h = _Harness();
    h.pipeline
      ..add('one')
      ..add('two')
      ..close();
    await _flush();
    h.synth['two']!.complete('A2');
    await _flush();
    expect(h.plays, isEmpty);
    h.synth['one']!.complete('A1');
    await _flush();
    h.plays['A1']!.complete(true);
    await _flush();
    h.plays['A2']!.complete(true);
    await h.pipeline.done;
    expect(h.events.where((e) => e.startsWith('play:')), ['play:A1', 'play:A2']);
  });

  test('turn completes (mic may resume) exactly once, only after the last chunk', () async {
    final h = _Harness();
    for (final t in ['a', 'b', 'c', 'd']) {
      h.pipeline.add(t);
    }
    await _flush();
    for (final t in ['a', 'b', 'c', 'd']) {
      h.synth[t]!.complete('X$t');
    }
    for (final t in ['a', 'b', 'c']) {
      await _flush();
      h.plays['X$t']!.complete(true);
      await _flush();
      expect(h.completes, 0, reason: 'no mic resume between chunks');
    }
    h.pipeline.close();
    await _flush();
    h.plays['Xd']!.complete(true);
    await h.pipeline.done;
    expect(h.completes, 1);
    expect(h.completedCancelled, isFalse);
    expect(h.events.last, 'complete');
  });

  test('server TTS failure falls back to the device voice for that chunk only', () async {
    final h = _Harness();
    h.pipeline
      ..add('one')
      ..add('two')
      ..close();
    await _flush();
    h.synth['one']!.complete(null);
    h.synth['two']!.complete('A2');
    await _flush();
    expect(h.events, contains('fallback:one'));
    await _flush();
    h.plays['A2']!.complete(true);
    await h.pipeline.done;
    expect(h.events.where((e) => e.startsWith('play:')), ['play:A2']);
  });

  test('barge-in cancels queued audio immediately, even mid-synthesis', () async {
    final h = _Harness();
    h.pipeline
      ..add('one')
      ..add('two');
    await _flush();
    h.pipeline.cancel();
    await h.pipeline.done;
    expect(h.completes, 1);
    expect(h.completedCancelled, isTrue);
    h.synth['one']!.complete('A1');
    await _flush();
    expect(h.plays, isEmpty, reason: 'nothing plays after cancel');
  });
}
