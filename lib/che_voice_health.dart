// What CHE's microphone is actually doing, in words (owner report 2026-10-20:
// the wake word did nothing and the mic froze). One place decides the
// microphone owner and the wake-listener status from the real engine flags, so
// the home screen and Voice diagnostics never claim CHE is listening when no
// engine is running.

/// Who holds the iPhone microphone right now. At most one owner at a time.
enum CheMicOwner { none, connecting, realtime, wakeWord, nativeRecognizer, speechRecognizer }

class CheVoiceHealth {
  const CheVoiceHealth({
    required this.handsFree,
    required this.sleeping,
    required this.porcupineRunning,
    required this.nativeActive,
    required this.speechListening,
    required this.realtimeConnected,
    required this.realtimeConnecting,
    this.permissionDenied = false,
    this.lastFailure,
  });

  final bool handsFree;
  final bool sleeping;
  final bool porcupineRunning;
  final bool nativeActive;
  final bool speechListening;
  final bool realtimeConnected;
  final bool realtimeConnecting;
  final bool permissionDenied;
  final String? lastFailure;

  CheMicOwner get owner {
    if (realtimeConnected) return CheMicOwner.realtime;
    if (realtimeConnecting) return CheMicOwner.connecting;
    if (porcupineRunning) return CheMicOwner.wakeWord;
    if (nativeActive) return CheMicOwner.nativeRecognizer;
    if (speechListening) return CheMicOwner.speechRecognizer;
    return CheMicOwner.none;
  }

  String get ownerLabel => switch (owner) {
        CheMicOwner.none => 'Nobody: the microphone is closed',
        CheMicOwner.connecting => 'Connecting to live voice',
        CheMicOwner.realtime => 'Live voice (OpenAI Realtime)',
        CheMicOwner.wakeWord => 'On-device wake word (Porcupine)',
        CheMicOwner.nativeRecognizer => 'iPhone speech recognizer',
        CheMicOwner.speechRecognizer => 'Backup speech recognizer',
      };

  /// True only when an engine is running that can hear the wake word.
  bool get hearsWakeWord => sleeping && (owner == CheMicOwner.wakeWord || owner == CheMicOwner.nativeRecognizer || owner == CheMicOwner.speechRecognizer);

  /// The status shown under the chat (muted, never spoken on its own).
  String get wakeStatus {
    if (permissionDenied) return 'Microphone permission is off. Turn it on in iPhone Settings, CHE, Microphone. Typing still works.';
    switch (owner) {
      case CheMicOwner.connecting:
        return 'Connecting… Tap the microphone to cancel.';
      case CheMicOwner.realtime:
        return 'Awake: listening to you. Say "stand down" to stop.';
      case CheMicOwner.none:
        if (!handsFree) return 'Hands-free is off: tap the microphone to talk.';
        final why = lastFailure;
        return why == null || why.isEmpty ? 'Not listening yet. Tap the microphone to talk.' : 'Not listening: $why Tap the microphone to try again.';
      case CheMicOwner.wakeWord:
      case CheMicOwner.nativeRecognizer:
      case CheMicOwner.speechRecognizer:
        return sleeping ? 'Listening for "Chay".' : 'Awake: listening to you. Say "stand down" to stop.';
    }
  }
}

/// Paid live voice is tried only when the server says it is set up and no
/// recent failure put it on hold; otherwise the free iPhone recognizer starts
/// at once (owner rule: voice startup never depends on a paid provider).
bool cheUseLiveVoice({required bool liveConfigured, required DateTime skipUntil, required DateTime now}) =>
    liveConfigured && !now.isBefore(skipUntil);

/// How long a live-voice connection may take before CHE falls back to the
/// free recognizer.
const cheLiveVoiceConnectTimeout = Duration(seconds: 10);
