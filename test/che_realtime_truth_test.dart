import 'dart:convert';

import 'package:chey/che_realtime_voice.dart';
import 'package:chey/che_voice_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

void main() {
  test('provider transcripts and function calls cannot bypass guarded chat output', () {
    final user = <String>[];
    final assistant = <String>[];
    var toolCalls = 0;
    final engine = CheRealtimeVoiceEngine(
      baseUrl: 'https://che.invalid',
      deviceToken: 'fixture',
      state: CheVoiceStateMachine(),
      onSnapshot: (_) {},
      onUserTranscript: (text, _) => user.add(text),
      onAssistantTranscript: (text, _, _) => assistant.add(text),
      onCapabilityRequest: (_, _) async {
        toolCalls++;
        return 'invented success';
      },
      onStandDown: () async {},
    );
    for (final type in [
      'response.output_audio_transcript.delta',
      'response.output_audio_transcript.done',
      'response.output_text.done',
      'response.function_call_arguments.done',
      'response.done',
    ]) {
      engine.handleServerEvent(RTCDataChannelMessage(jsonEncode({
        'type': type,
        'delta': 'I executed gh api. PR #356 is unmerged. SHA: 1234567890abcdef',
        'text': 'John Doe verified the deployment.',
        'transcript': 'I executed git -C /path/to/repo checkout che-mailbox',
        'name': 'che_capability_router',
        'arguments': '{"request":"dispatch a job"}',
      })));
    }
    expect(assistant, isEmpty);
    expect(toolCalls, 0);
    engine.handleServerEvent(RTCDataChannelMessage(jsonEncode({
      'type': 'conversation.item.input_audio_transcription.completed',
      'item_id': 'owner-turn',
      'transcript': 'Check PR #356. Do not guess.',
    })));
    expect(user, ['Check PR #356. Do not guess.']);
  });
}
