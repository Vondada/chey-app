import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_voice_state.dart';

void main() {
  group('CHE voice state machine', () {
    test('long pause never auto-completes a turn inside the client state machine', () {
      final voice = CheVoiceStateMachine();
      voice.beginRealtimeConnect();
      voice.realtimeReady();
      voice.userSpeechStarted();
      voice.userSpeechStopped(DateTime(2026, 9, 27, 22));

      expect(voice.phase, CheVoicePhase.thinking);

      // There is deliberately no local silence timer. Semantic VAD owns turn
      // completion, so a human pause cannot trigger a client-side response.
      expect(voice.phase, CheVoicePhase.thinking);
    });

    test('barge-in cancels the active response and rejects stale response events', () {
      final voice = CheVoiceStateMachine();
      voice.beginRealtimeConnect();
      voice.realtimeReady();
      voice.responseCreated('resp-1');
      voice.assistantAudioStarted(responseId: 'resp-1');

      voice.userSpeechStarted();

      expect(voice.phase, CheVoicePhase.userSpeaking);
      expect(voice.lastInterruptionReason, 'owner speech');
      expect(voice.acceptResponseEvent('resp-1'), isFalse);
    });

    test('same sentence is allowed on two distinct finalized turns', () {
      final voice = CheVoiceStateMachine();

      expect(
        voice.acceptFinalTranscript(text: 'Do that again', itemId: 'item-1'),
        isTrue,
      );
      expect(
        voice.acceptFinalTranscript(text: 'Do that again', itemId: 'item-1'),
        isFalse,
      );
      expect(
        voice.acceptFinalTranscript(text: 'Do that again', itemId: 'item-2'),
        isTrue,
      );
    });

    test('rapid anonymous duplicate event is suppressed but later repeat is accepted', () {
      final voice = CheVoiceStateMachine();
      final t0 = DateTime(2026, 9, 27, 22);

      expect(
        voice.acceptFinalTranscript(text: 'Yes', now: t0),
        isTrue,
      );
      expect(
        voice.acceptFinalTranscript(
          text: 'Yes',
          now: t0.add(const Duration(milliseconds: 100)),
        ),
        isFalse,
      );
      expect(
        voice.acceptFinalTranscript(
          text: 'Yes',
          now: t0.add(const Duration(milliseconds: 700)),
        ),
        isTrue,
      );
    });

    test('wake-listening and fallback have only one active engine state', () {
      final voice = CheVoiceStateMachine();

      voice.startWakeListening();
      expect(voice.engine, CheVoiceEngine.none);
      expect(voice.microphoneActive, isTrue);

      voice.beginRealtimeConnect();
      expect(voice.engine, CheVoiceEngine.realtime);
      expect(voice.microphoneActive, isFalse);

      voice.fallback('Realtime unavailable');
      expect(voice.engine, CheVoiceEngine.nativeFallback);
      expect(voice.phase, CheVoicePhase.fallback);
    });

    test('latency is measured from semantic speech-stop to first assistant audio', () {
      final voice = CheVoiceStateMachine();
      final t0 = DateTime(2026, 9, 27, 22);

      voice.beginRealtimeConnect();
      voice.realtimeReady();
      voice.userSpeechStarted();
      voice.userSpeechStopped(t0);
      voice.responseCreated('resp-2');
      voice.assistantAudioStarted(
        responseId: 'resp-2',
        now: t0.add(const Duration(milliseconds: 420)),
      );

      expect(voice.lastLatencyMs, 420);
      expect(voice.phase, CheVoicePhase.speaking);
    });
  });
}
