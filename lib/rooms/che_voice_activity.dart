import 'package:flutter/foundation.dart';

/// What CHE's voice is really doing right now, for the 3D crew page (assets/characters/app): the words and
/// audio length she is speaking, or that the microphone is listening. Published by the voice pipeline
/// (home_state/voice.dart) from the same flags it already keeps, so the character's mouth, gestures and eye
/// contact follow real speech timing, never a timer. Presentation only: nothing here grants a permission.
class CheVoiceActivity {
  const CheVoiceActivity({this.speaking = false, this.listening = false, this.text = '', this.durationMs = 0, this.startedAt});

  final bool speaking;
  final bool listening;

  /// The words of the clip being spoken (empty while silent).
  final String text;

  /// The clip's audio length in milliseconds (an estimate from its bytes when the engine gives none).
  final int durationMs;
  final DateTime? startedAt;

  Map<String, Object?> toJson() => {'speaking': speaking, 'listening': listening, 'text': text, 'durationMs': durationMs};

  @override
  bool operator ==(Object other) =>
      other is CheVoiceActivity && other.speaking == speaking && other.listening == listening && other.text == text && other.durationMs == durationMs && other.startedAt == startedAt;

  @override
  int get hashCode => Object.hash(speaking, listening, text, durationMs, startedAt);
}

/// The one live value the voice pipeline writes and the crew page reads.
final ValueNotifier<CheVoiceActivity> cheVoiceActivity = ValueNotifier<CheVoiceActivity>(const CheVoiceActivity());

/// Audio length from the clip's bytes: ElevenLabs and Fish return MP3 at 128 kbit/s on CHE's route, so bytes × 8
/// / 128 000 is the duration in seconds. Falls back to the words at a spoken pace (2.6 words per second).
int cheVoiceClipDurationMs(int bytes, String text) {
  if (bytes > 0) return (bytes * 8 / 128).round();
  final words = RegExp(r"[A-Za-z0-9']+").allMatches(text).length;
  return (words / 2.6 * 1000).round();
}
