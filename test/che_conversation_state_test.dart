import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_conversation_state.dart';

void main() {
  group('CHE conversation state machine', () {
    test('long pause does not prematurely commit a turn', () {
      final state = CheConversationStateMachine()
        ..onRealtimeConnected()
        ..onUserSpeechStarted();

      state.onNoiseOnly();
      state.onNoiseOnly();

      expect(state.phase, CheConversationPhase.userSpeaking);
      expect(state.commitUserText('I am still talking'), isTrue);
      expect(state.phase, CheConversationPhase.thinking);
    });

    test('duplicate final event is suppressed but same sentence later is allowed', () {
      final state = CheConversationStateMachine()..onRealtimeConnected();
      final t0 = DateTime(2026, 9, 27, 20);

      expect(state.commitUserText('same sentence', at: t0), isTrue);
      expect(
        state.commitUserText(
          'same sentence',
          at: t0.add(const Duration(milliseconds: 500)),
        ),
        isFalse,
      );
      expect(
        state.commitUserText(
          'same sentence',
          at: t0.add(const Duration(seconds: 2)),
        ),
        isTrue,
      );
    });

    test('owner speech interrupts CHE and stale speaking state is cleared', () {
      final state = CheConversationStateMachine()
        ..onRealtimeConnected()
        ..onAssistantSpeechStarted();

      state.onUserSpeechStarted();

      expect(state.phase, CheConversationPhase.userSpeaking);
      expect(state.lastInterruptionReason, 'owner speech');
    });

    test('background noise alone never interrupts CHE', () {
      final state = CheConversationStateMachine()
        ..onRealtimeConnected()
        ..onAssistantSpeechStarted();

      state.onNoiseOnly();

      expect(state.phase, CheConversationPhase.cheSpeaking);
      expect(state.lastInterruptionReason, isNull);
    });

    test('stand down returns to sleeping state', () {
      final state = CheConversationStateMachine()
        ..onRealtimeConnected()
        ..standDown();

      expect(state.phase, CheConversationPhase.sleeping);
      expect(state.engine, CheVoiceEngine.disconnected);
      expect(state.micActive, isFalse);
    });

    test('realtime failure enters visible native fallback', () {
      final state = CheConversationStateMachine()
        ..onRealtimeConnected()
        ..onFallback('network');

      expect(state.phase, CheConversationPhase.fallback);
      expect(state.engine, CheVoiceEngine.nativeFallback);
      expect(state.lastError, 'network');
    });
  });
}
