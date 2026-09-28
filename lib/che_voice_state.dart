enum CheVoicePhase {
  sleeping,
  wakeListening,
  connecting,
  listening,
  userSpeaking,
  thinking,
  speaking,
  interrupted,
  fallback,
  disconnected,
}

enum CheVoiceEngine {
  none,
  realtime,
  nativeFallback,
}

class CheVoiceSnapshot {
  const CheVoiceSnapshot({
    required this.phase,
    required this.engine,
    required this.connectionState,
    required this.microphoneActive,
    required this.lastInterruptionReason,
    required this.lastLatencyMs,
    required this.lastError,
    required this.selectedModel,
    required this.selectedVoice,
    required this.audioReturned,
    required this.audioVerified,
    required this.sessionReady,
  });

  final CheVoicePhase phase;
  final CheVoiceEngine engine;
  final String connectionState;
  final bool microphoneActive;
  final String? lastInterruptionReason;
  final int? lastLatencyMs;
  final String? lastError;
  final String? selectedModel;
  final String? selectedVoice;
  final bool audioReturned;
  final bool audioVerified;
  final bool sessionReady;

  String get phaseLabel {
    switch (phase) {
      case CheVoicePhase.sleeping:
        return 'Sleeping';
      case CheVoicePhase.wakeListening:
        return 'Say “Chay”';
      case CheVoicePhase.connecting:
        return 'Connecting';
      case CheVoicePhase.listening:
        return 'Listening';
      case CheVoicePhase.userSpeaking:
        return 'Listening';
      case CheVoicePhase.thinking:
        return 'Thinking';
      case CheVoicePhase.speaking:
        return 'Speaking';
      case CheVoicePhase.interrupted:
        return 'Interrupted';
      case CheVoicePhase.fallback:
        return 'Native fallback';
      case CheVoicePhase.disconnected:
        return 'Disconnected';
    }
  }

  String get engineLabel {
    switch (engine) {
      case CheVoiceEngine.realtime:
        return audioVerified
            ? 'OpenAI Realtime'
            : 'OpenAI Realtime (audio not yet verified)';
      case CheVoiceEngine.nativeFallback:
        return 'Native fallback';
      case CheVoiceEngine.none:
        if (phase == CheVoicePhase.wakeListening) return 'Wake listener';
        if (phase == CheVoicePhase.sleeping) return 'Sleeping';
        return 'Disconnected';
    }
  }
}

/// Small, deterministic state machine for CHE voice.
///
/// It intentionally contains no silence timer. Realtime turn completion is
/// driven by OpenAI Semantic VAD. This class only records events that have
/// already been decided by the active audio engine.
class CheVoiceStateMachine {
  CheVoicePhase phase = CheVoicePhase.sleeping;
  CheVoiceEngine engine = CheVoiceEngine.none;
  String connectionState = 'idle';
  bool microphoneActive = false;
  String? lastInterruptionReason;
  int? lastLatencyMs;
  String? lastError;
  String? selectedModel;
  String? selectedVoice;
  bool audioReturned = false;
  bool audioVerified = false;
  bool sessionReady = false;

  String? _activeResponseId;
  final Set<String> _cancelledResponseIds = <String>{};
  final Set<String> _finalTranscriptItemIds = <String>{};
  DateTime? _speechStoppedAt;
  DateTime? _lastAnonymousTranscriptAt;
  String? _lastAnonymousTranscript;

  CheVoiceSnapshot get snapshot => CheVoiceSnapshot(
        phase: phase,
        engine: engine,
        connectionState: connectionState,
        microphoneActive: microphoneActive,
        lastInterruptionReason: lastInterruptionReason,
        lastLatencyMs: lastLatencyMs,
        lastError: lastError,
        selectedModel: selectedModel,
        selectedVoice: selectedVoice,
        audioReturned: audioReturned,
        audioVerified: audioVerified,
        sessionReady: sessionReady,
      );

  void startWakeListening() {
    phase = CheVoicePhase.wakeListening;
    engine = CheVoiceEngine.none;
    connectionState = 'wake-listener';
    microphoneActive = true;
    _activeResponseId = null;
    sessionReady = false;
    audioReturned = false;
    audioVerified = false;
  }

  void beginRealtimeConnect({String? model, String? voice}) {
    phase = CheVoicePhase.connecting;
    engine = CheVoiceEngine.realtime;
    connectionState = 'connecting';
    microphoneActive = false;
    lastError = null;
    sessionReady = false;
    audioReturned = false;
    audioVerified = false;
    if (model != null && model.trim().isNotEmpty) selectedModel = model.trim();
    if (voice != null && voice.trim().isNotEmpty) selectedVoice = voice.trim();
  }

  void configureRealtime({String? model, String? voice}) {
    if (model != null && model.trim().isNotEmpty) selectedModel = model.trim();
    if (voice != null && voice.trim().isNotEmpty) selectedVoice = voice.trim();
  }

  void realtimeReady() {
    phase = CheVoicePhase.listening;
    engine = CheVoiceEngine.realtime;
    connectionState = 'connected';
    microphoneActive = true;
    lastError = null;
    sessionReady = true;
  }

  void markAudioReturned() {
    audioReturned = true;
  }

  void markAudioVerified() {
    audioReturned = true;
    audioVerified = true;
  }

  void connectionChanged(String value) {
    connectionState = value;
  }

  void userSpeechStarted() {
    if (phase == CheVoicePhase.speaking && _activeResponseId != null) {
      _cancelledResponseIds.add(_activeResponseId!);
      lastInterruptionReason = 'owner speech';
      phase = CheVoicePhase.interrupted;
    }
    phase = CheVoicePhase.userSpeaking;
    microphoneActive = true;
    _activeResponseId = null;
  }

  void userSpeechStopped([DateTime? now]) {
    phase = CheVoicePhase.thinking;
    _speechStoppedAt = now ?? DateTime.now();
  }

  void responseCreated(String? responseId) {
    if (responseId != null && responseId.isNotEmpty) {
      _activeResponseId = responseId;
    }
  }

  bool acceptResponseEvent(String? responseId) {
    if (responseId == null || responseId.isEmpty) return true;
    return !_cancelledResponseIds.contains(responseId);
  }

  void assistantAudioStarted({String? responseId, DateTime? now}) {
    if (!acceptResponseEvent(responseId)) return;
    if (responseId != null && responseId.isNotEmpty) {
      _activeResponseId = responseId;
    }
    final stoppedAt = _speechStoppedAt;
    if (stoppedAt != null) {
      lastLatencyMs = (now ?? DateTime.now()).difference(stoppedAt).inMilliseconds;
    }
    phase = CheVoicePhase.speaking;
    audioReturned = true;
  }

  void assistantDone({String? responseId}) {
    if (!acceptResponseEvent(responseId)) return;
    if (responseId == null || responseId == _activeResponseId) {
      _activeResponseId = null;
    }
    phase = CheVoicePhase.listening;
    microphoneActive = true;
  }

  void interrupted([String reason = 'owner interruption']) {
    if (_activeResponseId != null) {
      _cancelledResponseIds.add(_activeResponseId!);
    }
    _activeResponseId = null;
    lastInterruptionReason = reason;
    phase = CheVoicePhase.interrupted;
  }

  void fallback([String? error]) {
    phase = CheVoicePhase.fallback;
    engine = CheVoiceEngine.nativeFallback;
    connectionState = 'fallback';
    microphoneActive = true;
    sessionReady = false;
    audioVerified = false;
    if (error != null && error.trim().isNotEmpty) {
      lastError = error.trim();
    }
  }

  void reportError(String error) {
    lastError = error.trim();
  }

  void disconnected([String? error]) {
    phase = CheVoicePhase.disconnected;
    engine = CheVoiceEngine.none;
    connectionState = 'disconnected';
    microphoneActive = false;
    sessionReady = false;
    audioVerified = false;
    if (error != null && error.trim().isNotEmpty) {
      lastError = error.trim();
    }
  }

  void sleep() {
    phase = CheVoicePhase.sleeping;
    engine = CheVoiceEngine.none;
    connectionState = 'sleeping';
    microphoneActive = false;
    sessionReady = false;
    audioVerified = false;
    _activeResponseId = null;
  }

  /// Accept finalized transcription events exactly once.
  ///
  /// OpenAI supplies stable item IDs. If an event arrives without an item ID,
  /// only an immediate duplicate is suppressed so the owner can intentionally
  /// say the exact same sentence again on the next turn.
  bool acceptFinalTranscript({
    required String text,
    String? itemId,
    DateTime? now,
  }) {
    final cleaned = text.trim();
    if (cleaned.isEmpty) return false;

    if (itemId != null && itemId.isNotEmpty) {
      if (_finalTranscriptItemIds.contains(itemId)) return false;
      _finalTranscriptItemIds.add(itemId);
      if (_finalTranscriptItemIds.length > 200) {
        _finalTranscriptItemIds.remove(_finalTranscriptItemIds.first);
      }
      return true;
    }

    final current = now ?? DateTime.now();
    if (_lastAnonymousTranscript != null &&
        _lastAnonymousTranscript!.toLowerCase() == cleaned.toLowerCase() &&
        _lastAnonymousTranscriptAt != null &&
        current.difference(_lastAnonymousTranscriptAt!).inMilliseconds < 350) {
      return false;
    }
    _lastAnonymousTranscript = cleaned;
    _lastAnonymousTranscriptAt = current;
    return true;
  }
}
