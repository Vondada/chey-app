enum CheConversationPhase {
  sleeping,
  wakeListening,
  userSpeaking,
  thinking,
  toolUse,
  cheSpeaking,
  interrupted,
  fallback,
}

enum CheVoiceEngine {
  realtime,
  nativeFallback,
  disconnected,
}

class CheConversationSnapshot {
  const CheConversationSnapshot({
    required this.phase,
    required this.engine,
    required this.micActive,
    required this.serverOnline,
    required this.realtimeConnected,
    required this.lastInterruptionReason,
    required this.lastError,
    required this.latencyMs,
  });

  final CheConversationPhase phase;
  final CheVoiceEngine engine;
  final bool micActive;
  final bool serverOnline;
  final bool realtimeConnected;
  final String? lastInterruptionReason;
  final String? lastError;
  final int? latencyMs;
}

class CheConversationStateMachine {
  CheConversationPhase phase = CheConversationPhase.sleeping;
  CheVoiceEngine engine = CheVoiceEngine.disconnected;
  bool micActive = false;
  bool serverOnline = false;
  bool realtimeConnected = false;
  String? lastInterruptionReason;
  String? lastError;
  int? latencyMs;

  String? _lastCommittedUserText;
  DateTime? _lastCommittedAt;

  CheConversationSnapshot get snapshot => CheConversationSnapshot(
        phase: phase,
        engine: engine,
        micActive: micActive,
        serverOnline: serverOnline,
        realtimeConnected: realtimeConnected,
        lastInterruptionReason: lastInterruptionReason,
        lastError: lastError,
        latencyMs: latencyMs,
      );

  void enterWakeListening() {
    phase = CheConversationPhase.wakeListening;
    engine = CheVoiceEngine.nativeFallback;
    micActive = true;
    realtimeConnected = false;
  }

  void onWakeDetected() {
    phase = CheConversationPhase.thinking;
    micActive = false;
  }

  void onRealtimeConnected() {
    engine = CheVoiceEngine.realtime;
    realtimeConnected = true;
    serverOnline = true;
    micActive = true;
    phase = CheConversationPhase.wakeListening;
    lastError = null;
  }

  void onUserSpeechStarted() {
    if (phase == CheConversationPhase.cheSpeaking) {
      onInterrupted('owner speech');
    }
    phase = CheConversationPhase.userSpeaking;
    micActive = true;
  }

  bool commitUserText(String text, {DateTime? at}) {
    final cleaned = text.trim();
    if (cleaned.isEmpty) return false;

    final now = at ?? DateTime.now();
    if (_lastCommittedUserText != null &&
        _lastCommittedUserText!.toLowerCase() == cleaned.toLowerCase() &&
        _lastCommittedAt != null &&
        now.difference(_lastCommittedAt!).inMilliseconds < 1100) {
      return false;
    }

    _lastCommittedUserText = cleaned;
    _lastCommittedAt = now;
    phase = CheConversationPhase.thinking;
    micActive = true;
    return true;
  }

  void onToolStarted() {
    phase = CheConversationPhase.toolUse;
  }

  void onAssistantSpeechStarted({int? latency}) {
    phase = CheConversationPhase.cheSpeaking;
    if (latency != null) latencyMs = latency;
    micActive = true;
  }

  void onAssistantSpeechEnded() {
    if (engine == CheVoiceEngine.realtime) {
      phase = CheConversationPhase.wakeListening;
      micActive = true;
    } else {
      phase = CheConversationPhase.fallback;
    }
  }

  void onInterrupted(String reason) {
    phase = CheConversationPhase.interrupted;
    lastInterruptionReason = reason;
    micActive = true;
  }

  void onFallback(String? error) {
    engine = CheVoiceEngine.nativeFallback;
    realtimeConnected = false;
    phase = CheConversationPhase.fallback;
    micActive = true;
    lastError = error;
  }

  void onDisconnected([String? error]) {
    engine = CheVoiceEngine.disconnected;
    realtimeConnected = false;
    phase = CheConversationPhase.fallback;
    micActive = false;
    lastError = error;
  }

  void standDown() {
    phase = CheConversationPhase.sleeping;
    engine = CheVoiceEngine.disconnected;
    realtimeConnected = false;
    micActive = false;
  }

  void markServerOnline(bool online) {
    serverOnline = online;
  }

  void markLatency(int? milliseconds) {
    latencyMs = milliseconds;
  }

  // Background noise does not change conversational state. This is deliberate:
  // only confirmed speech-start events may barge into CHE.
  void onNoiseOnly() {}
}
