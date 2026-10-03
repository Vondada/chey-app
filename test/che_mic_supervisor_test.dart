import 'dart:async';

import 'package:chey/che_mic_supervisor.dart';
import 'package:chey/che_speech_pipeline.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeTimer implements Timer {
  _FakeTimer(this.callback);
  final void Function() callback;
  bool active = true;
  @override
  void cancel() => active = false;
  @override
  bool get isActive => active;
  @override
  int get tick => 0;
  void fire() {
    if (!active) return;
    active = false;
    callback();
  }
}

void main() {
  late List<_FakeTimer> timers;
  late CheMicSupervisor mic;
  late int starts;
  Future<void> start() async => starts++;

  setUp(() {
    timers = [];
    starts = 0;
    mic = CheMicSupervisor(timer: (d, cb) {
      final t = _FakeTimer(cb);
      timers.add(t);
      return t;
    });
    mic.ownerOn('test');
  });

  bool schedule({bool Function()? canStart}) => mic.scheduleRestart(
        reason: 'stt done',
        delay: const Duration(milliseconds: 450),
        canStart: canStart ?? () => true,
        start: start,
      );

  test('repeated done/notListening callbacks schedule only one restart', () async {
    expect(schedule(), isTrue);
    expect(schedule(), isFalse);
    expect(schedule(), isFalse);
    expect(timers.length, 1);
    timers.single.fire();
    await Future<void>.delayed(Duration.zero);
    expect(starts, 1);
  });

  test('owner turning the mic off cancels the pending restart and blocks new ones', () async {
    schedule();
    mic.ownerOff('mic button');
    timers.single.fire();
    await Future<void>.delayed(Duration.zero);
    expect(starts, 0);
    expect(schedule(), isFalse, reason: 'no timer may silently turn it back on');
  });

  test('native/realtime voice ownership or speaking blocks Flutter STT at fire time', () async {
    var nativeOwnsMic = true;
    schedule(canStart: () => !nativeOwnsMic);
    timers.single.fire();
    await Future<void>.delayed(Duration.zero);
    expect(starts, 0);
  });

  test('a stale restart from before a state change cannot start the mic', () async {
    schedule();
    mic.invalidate('TTS_START');
    timers.single.fire();
    await Future<void>.delayed(Duration.zero);
    expect(starts, 0);
  });

  test('one mic start never runs twice concurrently', () async {
    final gate = Completer<void>();
    var calls = 0;
    Future<void> slow() async {
      calls++;
      await gate.future;
    }

    final first = mic.runStart('button', slow);
    final second = await mic.runStart('callback', slow);
    expect(second, isFalse);
    gate.complete();
    expect(await first, isTrue);
    expect(calls, 1);
  });

  test('a start superseded while in flight reports stale', () async {
    final gate = Completer<void>();
    final result = mic.runStart('button', () => gate.future);
    mic.ownerOff('owner changed mind');
    gate.complete();
    expect(await result, isFalse);
  });

  test('speaking a multi-sentence reply resumes the mic once, not per sentence', () async {
    final turn = CheSpeechPipeline<String>(
      synthesize: (t) async => t,
      play: (a) async => true,
      fallback: (t) async => true,
      onComplete: (cancelled) async {
        if (!cancelled) schedule();
      },
    );
    mic.invalidate('TTS_START');
    for (final s in ['One.', 'Two.', 'Three.', 'Four.', 'Five.']) {
      turn.add(s);
    }
    turn.close();
    await turn.done;
    expect(timers.length, 1);
    timers.single.fire();
    await Future<void>.delayed(Duration.zero);
    expect(starts, 1);
  });
}
