import 'dart:async';

/// Local (non-Realtime) CHE voice loop.
///
/// One phase at a time: idle → listening → thinking → speaking → listening.
/// Mic start/stop is serialized so concurrent calls cannot thrash the session.
enum CheLocalVoicePhase { idle, listening, thinking, speaking }

class CheLocalVoiceLoop {
  CheLocalVoicePhase phase = CheLocalVoicePhase.idle;

  Future<void> _micChain = Future<void>.value();
  bool audioSessionReady = false;
  DateTime? serverVoiceCooldownUntil;
  String? _lastSpokenNormalized;
  DateTime? _lastSpokenAt;

  /// Bumped on barge-in / cancel so in-flight speakText finally blocks bail out.
  int speechGeneration = 0;

  bool get isIdle => phase == CheLocalVoicePhase.idle;
  bool get isListening => phase == CheLocalVoicePhase.listening;
  bool get isThinking => phase == CheLocalVoicePhase.thinking;
  bool get isSpeaking => phase == CheLocalVoicePhase.speaking;

  bool get serverVoiceCoolingDown {
    final until = serverVoiceCooldownUntil;
    return until != null && DateTime.now().isBefore(until);
  }

  void goIdle() {
    speechGeneration++;
    phase = CheLocalVoicePhase.idle;
  }

  /// Enter listening only from idle/listening (or after speak/think ends).
  bool goListening() {
    if (phase == CheLocalVoicePhase.speaking) return false;
    phase = CheLocalVoicePhase.listening;
    return true;
  }

  void goThinking() {
    phase = CheLocalVoicePhase.thinking;
  }

  int goSpeaking() {
    phase = CheLocalVoicePhase.speaking;
    return ++speechGeneration;
  }

  /// After CHE finishes talking, resume open conversation listening.
  void finishSpeakingToListening({required bool continuous}) {
    phase = continuous ? CheLocalVoicePhase.listening : CheLocalVoicePhase.idle;
  }

  /// Owner barge-in while CHE is speaking.
  int bargeIn() {
    phase = CheLocalVoicePhase.listening;
    return ++speechGeneration;
  }

  /// Serialize microphone start/stop so overlapping calls cannot fight.
  Future<T> runMicOp<T>(Future<T> Function() op) {
    final done = Completer<T>();
    _micChain = _micChain
        .catchError((_) {})
        .then((_) async {
      try {
        done.complete(await op());
      } catch (e, st) {
        done.completeError(e, st);
      }
    });
    return done.future;
  }

  /// Configure the iOS playAndRecord session at most once per process.
  bool claimAudioSessionSetup() {
    if (audioSessionReady) return false;
    audioSessionReady = true;
    return true;
  }

  void markServerVoiceCooldown([
    Duration duration = const Duration(minutes: 15),
  ]) {
    serverVoiceCooldownUntil = DateTime.now().add(duration);
  }

  /// Drop near-duplicate speak requests (server + native race).
  bool acceptSpeak(String text, {DateTime? now}) {
    final cleaned = text.trim().toLowerCase().replaceAll(RegExp(r'\s+'), ' ');
    if (cleaned.isEmpty) return false;
    final t = now ?? DateTime.now();
    if (_lastSpokenNormalized == cleaned &&
        _lastSpokenAt != null &&
        t.difference(_lastSpokenAt!).inMilliseconds < 900) {
      return false;
    }
    _lastSpokenNormalized = cleaned;
    _lastSpokenAt = t;
    return true;
  }
}
