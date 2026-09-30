import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_local_voice_loop.dart';

void main() {
  group('CheLocalVoiceLoop', () {
    test('phase machine idle → listening → thinking → speaking → listening', () {
      final loop = CheLocalVoiceLoop();
      expect(loop.isIdle, isTrue);

      expect(loop.goListening(), isTrue);
      expect(loop.isListening, isTrue);

      loop.goThinking();
      expect(loop.isThinking, isTrue);

      final gen = loop.goSpeaking();
      expect(loop.isSpeaking, isTrue);
      expect(gen, 1);

      // Cannot enter listening while speaking.
      expect(loop.goListening(), isFalse);
      expect(loop.isSpeaking, isTrue);

      loop.finishSpeakingToListening(continuous: true);
      expect(loop.isListening, isTrue);
    });

    test('barge-in bumps generation and returns to listening', () {
      final loop = CheLocalVoiceLoop();
      final gen = loop.goSpeaking();
      final after = loop.bargeIn();
      expect(after, greaterThan(gen));
      expect(loop.isListening, isTrue);
      expect(loop.speechGeneration, after);
    });

    test('mic ops serialize', () async {
      final loop = CheLocalVoiceLoop();
      final order = <int>[];
      final first = loop.runMicOp(() async {
        order.add(1);
        await Future<void>.delayed(const Duration(milliseconds: 30));
        order.add(2);
        return 'a';
      });
      final second = loop.runMicOp(() async {
        order.add(3);
        return 'b';
      });
      expect(await first, 'a');
      expect(await second, 'b');
      expect(order, [1, 2, 3]);
    });

    test('audio session setup claimed once', () {
      final loop = CheLocalVoiceLoop();
      expect(loop.claimAudioSessionSetup(), isTrue);
      expect(loop.claimAudioSessionSetup(), isFalse);
      loop.audioSessionReady = false;
      expect(loop.claimAudioSessionSetup(), isTrue);
    });

    test('server voice cooldown window', () {
      final loop = CheLocalVoiceLoop();
      expect(loop.serverVoiceCoolingDown, isFalse);
      loop.markServerVoiceCooldown(const Duration(minutes: 15));
      expect(loop.serverVoiceCoolingDown, isTrue);
    });

    test('acceptSpeak drops near-duplicates', () {
      final loop = CheLocalVoiceLoop();
      final t0 = DateTime.utc(2026, 9, 30, 14, 0, 0);
      expect(loop.acceptSpeak('Hello there', now: t0), isTrue);
      expect(
        loop.acceptSpeak('  hello   there ', now: t0.add(const Duration(milliseconds: 200))),
        isFalse,
      );
      expect(
        loop.acceptSpeak('Hello there', now: t0.add(const Duration(milliseconds: 1000))),
        isTrue,
      );
      expect(loop.acceptSpeak('Different line', now: t0.add(const Duration(milliseconds: 1100))), isTrue);
      expect(loop.acceptSpeak('   ', now: t0), isFalse);
    });
  });
}
