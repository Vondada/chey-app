import 'dart:async';

import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_kokoro_voice.dart';

/// On-device iPhone text fallback for CHE.
class CheLocalAI {
  static const MethodChannel _channel = MethodChannel('che/local_ai');

  static Future<String?> respond(
    String prompt, {
    List<Map<String, String>> history = const [],
    List<String> memoryContext = const [],
  }) async {
    final clean = prompt.trim();
    if (clean.isEmpty) return null;
    try {
      final value = await _channel.invokeMethod<String>('respond', {
        'prompt': clean,
        'history': history.take(14).toList(growable: false),
        'memory_context': memoryContext.take(12).toList(growable: false),
      });
      final text = value?.trim();
      return text == null || text.isEmpty ? null : text;
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  static Future<bool> get available async {
    try {
      return (await _channel.invokeMethod<bool>('available')) ?? false;
    } catch (_) {
      return false;
    }
  }
}

class CheNativeVoice {
  static const MethodChannel _methods = MethodChannel('che/native_voice');
  static const EventChannel _events = EventChannel('che/native_voice_events');
  static final CheKokoroVoice _kokoro = CheKokoroVoice(_methods);

  static const String _speakerKey = 'che.voice.kokoroSpeaker';
  static const String _speedKey = 'che.voice.kokoroSpeed';
  static const String _pauseKey = 'che.voice.kokoroPause';
  static const String _nativePitchKey = 'che.voice.nativePitch';
  static const String _nativeRateKey = 'che.voice.nativeRate';
  static const String _signatureVersionKey = 'che.voice.chazeSignatureVersion';

  static const List<Map<String, Object>> localVoiceOptions = [
    {'id': 0, 'name': 'Chaze — Signature (Local)', 'speaker': 'af'},
    {'id': 1, 'name': 'American Feminine — Bella', 'speaker': 'af_bella'},
    {'id': 2, 'name': 'American Feminine — Nicole', 'speaker': 'af_nicole'},
    {'id': 3, 'name': 'American Feminine — Sarah', 'speaker': 'af_sarah'},
    {'id': 4, 'name': 'American Feminine — Sky', 'speaker': 'af_sky'},
    {'id': 5, 'name': 'American Masculine — Adam', 'speaker': 'am_adam'},
    {'id': 6, 'name': 'American Masculine — Michael', 'speaker': 'am_michael'},
    {'id': 7, 'name': 'British Feminine — Emma', 'speaker': 'bf_emma'},
    {'id': 8, 'name': 'British Feminine — Isabella', 'speaker': 'bf_isabella'},
    {'id': 9, 'name': 'British Masculine — George', 'speaker': 'bm_george'},
    {'id': 10, 'name': 'British Masculine — Lewis', 'speaker': 'bm_lewis'},
  ];

  static Stream<Map<String, dynamic>>? _cachedEvents;

  static Stream<Map<String, dynamic>> get events {
    _cachedEvents ??= _events
        .receiveBroadcastStream()
        .where((event) => event is Map)
        .map((event) => Map<String, dynamic>.from(event as Map))
        .asBroadcastStream();
    return _cachedEvents!;
  }

  static Future<Map<String, dynamic>> voiceSettings() async {
    final prefs = await SharedPreferences.getInstance();

    // One-time migration to CHE's Chaze signature profile. This is fully
    // on-device and unmetered: no account, API key, or per-character billing.
    if ((prefs.getInt(_signatureVersionKey) ?? 0) < 1) {
      await prefs.setInt(_speakerKey, 0);
      await prefs.setDouble(_speedKey, 0.94);
      await prefs.setDouble(_pauseKey, 0.12);
      await prefs.setDouble(_nativePitchKey, 0.96);
      await prefs.setDouble(_nativeRateKey, 0.96);
      await prefs.setInt(_signatureVersionKey, 1);
    }

    return {
      'speakerId': prefs.getInt(_speakerKey) ?? 0,
      'speed': prefs.getDouble(_speedKey) ?? 0.94,
      'pauseScale': prefs.getDouble(_pauseKey) ?? 0.12,
      'nativePitch': prefs.getDouble(_nativePitchKey) ?? 0.96,
      'nativeRate': prefs.getDouble(_nativeRateKey) ?? 0.96,
    };
  }

  static Future<void> configureVoice({
    int? speakerId,
    double? speed,
    double? pauseScale,
    double? nativePitch,
    double? nativeRate,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final current = await voiceSettings();

    final sid =
        (speakerId ?? current['speakerId'] as int).clamp(0, 10).toInt();
    final localSpeed =
        (speed ?? current['speed'] as double).clamp(0.70, 1.35).toDouble();
    final localPause = (pauseScale ?? current['pauseScale'] as double)
        .clamp(0.05, 0.35)
        .toDouble();
    final fallbackPitch = (nativePitch ?? current['nativePitch'] as double)
        .clamp(0.75, 1.25)
        .toDouble();
    final fallbackRate = (nativeRate ?? current['nativeRate'] as double)
        .clamp(0.70, 1.25)
        .toDouble();

    await prefs.setInt(_speakerKey, sid);
    await prefs.setDouble(_speedKey, localSpeed);
    await prefs.setDouble(_pauseKey, localPause);
    await prefs.setDouble(_nativePitchKey, fallbackPitch);
    await prefs.setDouble(_nativeRateKey, fallbackRate);

    _kokoro.configure(
      speakerId: sid,
      speed: localSpeed,
      pauseScale: localPause,
    );

    try {
      await _methods.invokeMethod('configureVoice', {
        'pitch': fallbackPitch,
        'rate': fallbackRate,
      });
    } catch (_) {}
  }

  static Future<void> _applyStoredSettings() async {
    final s = await voiceSettings();
    _kokoro.configure(
      speakerId: s['speakerId'] as int,
      speed: s['speed'] as double,
      pauseScale: s['pauseScale'] as double,
    );
    try {
      await _methods.invokeMethod('configureVoice', {
        'pitch': s['nativePitch'],
        'rate': s['nativeRate'],
      });
    } catch (_) {}
  }

  static Future<bool> start() async {
    await _applyStoredSettings();
    unawaited(_kokoro.prepare());
    return (await _methods.invokeMethod<bool>('start')) ?? false;
  }

  static Future<bool> stop() async =>
      (await _methods.invokeMethod<bool>('stop')) ?? false;

  static Future<bool> sleep() async =>
      (await _methods.invokeMethod<bool>('sleep')) ?? false;

  static Future<bool> wake() async {
    await _applyStoredSettings();
    unawaited(_kokoro.prepare());
    return (await _methods.invokeMethod<bool>('wake')) ?? false;
  }

  static Future<void> setAssistantSpeaking(bool value) async {
    await _methods.invokeMethod('assistantSpeaking', value);
  }

  static Future<bool> speakText(String text) async {
    final clean = text.trim();
    if (clean.isEmpty) return false;

    await _applyStoredSettings();
    try {
      if (await _kokoro.speak(clean)) return true;
    } catch (_) {}

    return (await _methods.invokeMethod<bool>('speakText', {'text': clean})) ??
        false;
  }

  /// Speaks with the on-device Kokoro neural voice only. Returns false (and
  /// starts preparing the voice pack in the background) until it is ready,
  /// so callers can use a smooth cloud voice instead of the basic one.
  static Future<bool> speakNeural(String text) async {
    final clean = text.trim();
    if (clean.isEmpty) return false;
    await _applyStoredSettings();
    if (!_kokoro.isReady) {
      unawaited(_kokoro.prepare());
      return false;
    }
    try {
      return await _kokoro.speak(clean);
    } catch (_) {
      return false;
    }
  }

  static Future<bool> previewVoice() => speakText(
        'Hey, I’m CHE. You’re hearing my Chaze signature voice, sir.',
      );

  static Future<bool> playAudio(Uint8List bytes) async =>
      (await _methods.invokeMethod<bool>('playAudio', bytes)) ?? false;

  static Future<bool> stopAudio() async =>
      (await _methods.invokeMethod<bool>('stopAudio')) ?? false;

  static Future<Map<String, dynamic>> status() async {
    unawaited(_kokoro.prepare());
    final raw = await _methods.invokeMethod<dynamic>('status');
    final result = raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
    final s = await voiceSettings();
    result['local_neural_tts'] = true;
    result['local_neural_tts_engine'] = 'kokoro';
    result['local_neural_tts_ready'] = _kokoro.isReady;
    result['local_neural_tts_unmetered'] = true;
    result['local_voice_speaker'] = s['speakerId'];
    result['local_voice_speed'] = s['speed'];
    return result;
  }
}
