import 'package:flutter/services.dart';

/// Compatibility layer for CHE's optional local neural voice.
///
/// Sherpa/Kokoro native TTS is intentionally disabled on the current iPhone
/// sideload path. A real-device crash report showed a native SIGABRT inside
/// SherpaOnnxCreateOfflineTts, which cannot be caught by Dart try/catch.
///
/// CHE therefore falls through to its existing server voice / iPhone-native
/// voice path instead of risking a process-level crash.
class CheKokoroVoice {
  CheKokoroVoice(this._nativeAudio);

  // Keep the channel reference so this class can be re-enabled later without
  // changing CheNativeVoice's public contract.
  // ignore: unused_field
  final MethodChannel _nativeAudio;

  int _speakerId = 0;
  double _speed = 0.94;
  double _pauseScale = 0.12;

  bool get isReady => false;

  void configure({
    required int speakerId,
    required double speed,
    required double pauseScale,
  }) {
    _speakerId = speakerId.clamp(0, 10).toInt();
    _speed = speed.clamp(0.70, 1.35).toDouble();
    _pauseScale = pauseScale.clamp(0.05, 0.35).toDouble();
  }

  Future<bool> prepare() async => false;

  Future<bool> speak(String text) async => false;
}
