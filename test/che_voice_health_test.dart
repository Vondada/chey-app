// Owner report 2026-10-20: the wake word did nothing and pressing the mic froze
// CHE. These pin the fixes: a hung mic operation cannot block the next one,
// voice startup never waits on paid live voice, and the visible status never
// claims CHE is listening when no engine runs.
import 'dart:async';

import 'package:chey/che_local_voice_loop.dart';
import 'package:chey/che_voice_health.dart';
import 'package:flutter_test/flutter_test.dart';

CheVoiceHealth h({
  bool handsFree = true,
  bool sleeping = true,
  bool porcupine = false,
  bool native = false,
  bool speech = false,
  bool realtime = false,
  bool connecting = false,
  bool denied = false,
  String? failure,
}) =>
    CheVoiceHealth(
      handsFree: handsFree, sleeping: sleeping, porcupineRunning: porcupine, nativeActive: native,
      speechListening: speech, realtimeConnected: realtime, realtimeConnecting: connecting,
      permissionDenied: denied, lastFailure: failure,
    );

void main() {
  test('a native mic call that never returns times out, and the next mic operation still runs', () async {
    final loop = CheLocalVoiceLoop();
    final hung = loop.runMicOp(() => Completer<bool>().future, timeout: const Duration(milliseconds: 50));
    final next = loop.runMicOp(() async => true, timeout: const Duration(milliseconds: 50));
    await expectLater(hung, throwsA(isA<TimeoutException>()));
    expect(await next, isTrue, reason: 'the chain moved on after the stall');
    expect(loop.lastMicFailure, contains('did not finish'));
    expect(loop.lastMicFailureAt, isNotNull);
  });

  test('rapid mic presses run one at a time and every one completes', () async {
    final loop = CheLocalVoiceLoop();
    var running = 0;
    var maxRunning = 0;
    final presses = [
      for (var i = 0; i < 20; i++)
        loop.runMicOp(() async {
          running++;
          maxRunning = running > maxRunning ? running : maxRunning;
          await Future<void>.delayed(const Duration(milliseconds: 2));
          running--;
          return i;
        }),
    ];
    expect(await Future.wait(presses), List.generate(20, (i) => i));
    expect(maxRunning, 1);
  });

  test('a failing mic operation is recorded and does not poison the chain', () async {
    final loop = CheLocalVoiceLoop();
    await expectLater(loop.runMicOp<void>(() async => throw StateError('recognizer failed')), throwsStateError);
    expect(loop.lastMicFailure, contains('recognizer failed'));
    expect(await loop.runMicOp(() async => 'ok'), 'ok');
  });

  test('voice startup tries paid live voice only when it is set up and not on hold', () {
    final now = DateTime(2026, 10, 20, 12);
    final never = DateTime.fromMillisecondsSinceEpoch(0);
    expect(cheUseLiveVoice(liveConfigured: false, skipUntil: never, now: now), isFalse, reason: 'free recognizer when live voice is not configured');
    expect(cheUseLiveVoice(liveConfigured: true, skipUntil: now.add(const Duration(hours: 1)), now: now), isFalse, reason: 'a recent failure holds it');
    expect(cheUseLiveVoice(liveConfigured: true, skipUntil: never, now: now), isTrue);
    expect(cheLiveVoiceConnectTimeout, lessThanOrEqualTo(const Duration(seconds: 10)));
  });

  test('the status never claims listening without a running engine', () {
    expect(h().owner, CheMicOwner.none);
    expect(h().hearsWakeWord, isFalse);
    expect(h().wakeStatus, isNot(contains('Listening')));
    expect(h(failure: 'The iPhone speech recognizer did not start.').wakeStatus, 'Not listening: The iPhone speech recognizer did not start. Tap the microphone to try again.');
    expect(h(handsFree: false).wakeStatus, 'Hands-free is off: tap the microphone to talk.');
    expect(h(porcupine: true).wakeStatus, 'Listening for "Chay".');
    expect(h(porcupine: true).ownerLabel, contains('Porcupine'));
    expect(h(native: true).hearsWakeWord, isTrue);
    expect(h(native: true, sleeping: false).wakeStatus, startsWith('Awake'));
    expect(h(connecting: true, native: true).owner, CheMicOwner.connecting, reason: 'one owner at a time, connecting first');
    expect(h(connecting: true).wakeStatus, contains('Tap the microphone to cancel'));
    expect(h(realtime: true, porcupine: true).owner, CheMicOwner.realtime);
    expect(h(denied: true, native: true).wakeStatus, contains('permission is off'));
  });
}
