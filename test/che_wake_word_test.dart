// Wake-word reliability (docs/failure_inventory/infra_app_voice.md VOI-02): a Porcupine listener that died
// (audio interruption, microphone taken) only printed a status nobody listened to; the app kept showing wake
// listening while nothing listened. Now the engine stops claiming to run, reports the error, and Porcupine
// cools down so recovery hands the microphone to the native listener instead of retrying in a loop.
import 'dart:io';

import 'package:chey/che_wake_word.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(CheWakeWordEngine.resetListenerErrors);

  test('a listener error stops the engine, reports it once and starts the cooldown', () async {
    final statuses = <String>[];
    final errors = <String>[];
    final engine = CheWakeWordEngine(
      baseUrl: 'https://example.invalid',
      deviceToken: 't',
      onWake: () {},
      onStatus: statuses.add,
      onListenerError: errors.add,
    );
    expect(CheWakeWordEngine.recentlyFailed(), isFalse);

    engine.handleListenerError('audio interrupted');
    await Future<void>.delayed(Duration.zero);

    expect(engine.running, isFalse);
    expect(errors, ['audio interrupted']);
    expect(statuses.single, contains('audio interrupted'));
    expect(CheWakeWordEngine.recentlyFailed(), isTrue);
    expect(
      CheWakeWordEngine.recentlyFailed(DateTime.now().add(CheWakeWordEngine.errorCooldown + const Duration(seconds: 1))),
      isFalse,
      reason: 'Porcupine is tried again after the cooldown',
    );
  });

  test('during the cooldown start() falls back without touching the keychain or network', () async {
    final statuses = <String>[];
    final engine = CheWakeWordEngine(baseUrl: 'https://example.invalid', deviceToken: 't', onWake: () {}, onStatus: statuses.add);
    engine.handleListenerError('mic taken');
    statuses.clear();

    expect(await engine.start(), isFalse);
    expect(statuses.single, contains('native wake fallback'));
  });

  test('the home screen recovers from a dead listener through the existing wake stack', () {
    final security = File('lib/home_state/security.dart').readAsStringSync();
    expect(security, contains('onListenerError: (_) => _recoverFromPorcupineError(wake)'));
    final start = security.indexOf('Future<void> _recoverFromPorcupineError(');
    final body = security.substring(start, security.indexOf('\n  }\n', start));
    expect(body, contains('identical(_porcupineWake, failed)'), reason: 'a stale engine must not restart the stack');
    expect(body, contains('_stopPorcupineWake(disposeEngine: true)'));
    expect(body, contains('_restartWakeListener()'), reason: 'one wake stack; no second listener');
  });
}
