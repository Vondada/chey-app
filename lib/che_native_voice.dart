import 'dart:async';
import 'package:flutter/services.dart';

class CheNativeVoice {
  static const MethodChannel _methods = MethodChannel('che/native_voice');

  static const EventChannel _events = EventChannel('che/native_voice_events');

  static Stream<Map<String, dynamic>>? _cachedEvents;

  static Stream<Map<String, dynamic>> get events {
    _cachedEvents ??= _events
        .receiveBroadcastStream()
        .where((event) => event is Map)
        .map((event) => Map<String, dynamic>.from(event as Map))
        .asBroadcastStream();
    return _cachedEvents!;
  }

  static Future<bool> start() async =>
      (await _methods.invokeMethod<bool>('start')) ?? false;

  static Future<bool> stop() async =>
      (await _methods.invokeMethod<bool>('stop')) ?? false;

  static Future<bool> sleep() async =>
      (await _methods.invokeMethod<bool>('sleep')) ?? false;

  static Future<bool> wake() async =>
      (await _methods.invokeMethod<bool>('wake')) ?? false;

  static Future<void> setAssistantSpeaking(bool value) async {
    await _methods.invokeMethod('assistantSpeaking', value);
  }

  static Future<bool> speakText(String text) async =>
      (await _methods.invokeMethod<bool>('speakText', {'text': text})) ?? false;

  static Future<bool> playAudio(Uint8List bytes) async =>
      (await _methods.invokeMethod<bool>('playAudio', bytes)) ?? false;

  static Future<bool> stopAudio() async =>
      (await _methods.invokeMethod<bool>('stopAudio')) ?? false;

  static Future<Map<String, dynamic>> status() async {
    final raw = await _methods.invokeMethod<dynamic>('status');
    return raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
  }
}
