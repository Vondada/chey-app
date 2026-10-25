import 'dart:async';

import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_kokoro_voice.dart';
import 'che_private_voice.dart';
import 'che_speech_style.dart';
import 'che_ui/che_ui_preferences.dart';

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
      return text == null || text.isEmpty ? null : stripButler(text);
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

  static bool bridgePresent = true;

  static Future<T?> _invoke<T>(String method, [dynamic arguments]) async {
    try {
      final value = await _methods.invokeMethod<T>(method, arguments);
      bridgePresent = true;
      return value;
    } on MissingPluginException {
      bridgePresent = false;
      return null;
    } on PlatformException {
      return null;
    }
  }

  static const String _speakerKey = 'che.voice.kokoroSpeaker';
  static const String _speedKey = 'che.voice.kokoroSpeed';
  static const String _pauseKey = 'che.voice.kokoroPause';
  static const String _nativePitchKey = 'che.voice.nativePitch';
  static const String _nativeRateKey = 'che.voice.nativeRate';
  static const String _signatureVersionKey = 'che.voice.chazeSignatureVersion';

  static const List<Map<String, Object>> localVoiceOptions = [
    {'id': 0, 'name': 'Chaze \u2014 Signature (Local)', 'speaker': 'af'},
    {'id': 1, 'name': 'American Feminine \u2014 Bella', 'speaker': 'af_bella'},
    {'id': 2, 'name': 'American Feminine \u2014 Nicole', 'speaker': 'af_nicole'},
    {'id': 3, 'name': 'American Feminine \u2014 Sarah', 'speaker': 'af_sarah'},
    {'id': 4, 'name': 'American Feminine \u2014 Sky', 'speaker': 'af_sky'},
    {'id': 5, 'name': 'American Masculine \u2014 Adam', 'speaker': 'am_adam'},
    {'id': 6, 'name': 'American Masculine \u2014 Michael', 'speaker': 'am_michael'},
    {'id': 7, 'name': 'British Feminine \u2014 Emma', 'speaker': 'bf_emma'},
    {'id': 8, 'name': 'British Feminine \u2014 Isabella', 'speaker': 'bf_isabella'},
    {'id': 9, 'name': 'British Masculine \u2014 George', 'speaker': 'bm_george'},
    {'id': 10, 'name': 'British Masculine \u2014 Lewis', 'speaker': 'bm_lewis'},
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
    final sid = (speakerId ?? current['speakerId'] as int).clamp(0, 10).toInt();
    final localSpeed = (speed ?? current['speed'] as double).clamp(0.70, 1.35).toDouble();
    final localPause = (pauseScale ?? current['pauseScale'] as double).clamp(0.05, 0.35).toDouble();
    final fallbackPitch = (nativePitch ?? current['nativePitch'] as double).clamp(0.75, 1.25).toDouble();
    final fallbackRate = (nativeRate ?? current['nativeRate'] as double).clamp(0.70, 1.25).toDouble();
    await prefs.setInt(_speakerKey, sid);
    await prefs.setDouble(_speedKey, localSpeed);
    await prefs.setDouble(_pauseKey, localPause);
    await prefs.setDouble(_nativePitchKey, fallbackPitch);
    await prefs.setDouble(_nativeRateKey, fallbackRate);
    _kokoro.configure(speakerId: sid, speed: localSpeed, pauseScale: localPause);
    try {
      await _invoke<void>('configureVoice', {'pitch': fallbackPitch, 'rate': fallbackRate});
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
      await _invoke<void>('configureVoice', {'pitch': s['nativePitch'], 'rate': s['nativeRate']});
    } catch (_) {}
  }

  static Future<bool> start() async {
    if (!await _privateRecognitionAllowed()) return false;
    await _applyStoredSettings();
    _prepareInBackground();
    return (await _invoke<bool>('start')) ?? false;
  }

  /// Why the last [start] or [wake] did not open the microphone under Private
  /// voice, or empty. Shown and spoken by the caller.
  static String lastPrivateRefusal = '';

  /// Private voice: the native recognizer may run only when Apple reports
  /// on-device recognition for this iPhone and language. The Swift side sets
  /// requiresOnDeviceRecognition whenever it is supported; when it is not, the
  /// microphone stays closed instead of falling back to Apple's servers.
  static Future<bool> _privateRecognitionAllowed() async {
    lastPrivateRefusal = '';
    if (!ChePrivateVoice.isOn) return true;
    Map<String, dynamic> report = const {};
    try {
      final raw = await _methods.invokeMethod<dynamic>('status');
      if (raw is Map) report = Map<String, dynamic>.from(raw);
    } catch (_) {}
    final refusal = ChePrivateVoice.recognitionRefusal(report);
    if (refusal == null) return true;
    lastPrivateRefusal = refusal;
    return false;
  }

  static Future<bool> stop() async => (await _invoke<bool>('stop')) ?? false;

  static Future<bool> sleep() async => (await _invoke<bool>('sleep')) ?? false;

  static Future<bool> wake() async {
    if (!await _privateRecognitionAllowed()) return false;
    await _applyStoredSettings();
    _prepareInBackground();
    return (await _invoke<bool>('wake')) ?? false;
  }

  static Future<void> setAssistantSpeaking(bool value) async {
    await _invoke<void>('assistantSpeaking', value);
  }

  static Future<bool> speakText(String text) async {
    final clean = stripButler(text);
    if (clean.isEmpty) return false;
    // This is the on-device fallback. Server voice is selected by the existing
    // speech pipeline before this method, with its own cooldown and cancellation.
    await _applyStoredSettings();
    // Speak now. The neural model is used only once it is already loaded: waiting
    // on its first-run download here held the whole fallback, so a stalled
    // download meant silence with no error.
    if (_kokoro.isReady) {
      try {
        if (await _kokoro.speak(clean)) return true;
      } catch (_) {}
    } else {
      _prepareInBackground();
    }
    return (await _invoke<bool>('speakText', {'text': clean})) ?? false;
  }

  /// Warms the neural voice without ever making speech wait for it.
  static void _prepareInBackground() {
    unawaited(_kokoro.prepare().then<void>((_) {}, onError: (_) {}));
  }

  static Future<bool> speakNeural(String text) async {
    final clean = stripButler(text);
    if (clean.isEmpty) return false;
    await _applyStoredSettings();
    if (!_kokoro.isReady) {
      _prepareInBackground();
      return false;
    }
    try {
      return await _kokoro.speak(clean);
    } catch (_) {
      return false;
    }
  }

  /// Loads the on-device Kokoro voice, waiting at most [timeout]. Private
  /// voice speaks only with it, so a reply waits briefly for it to load.
  static Future<bool> prepareNeural({Duration timeout = const Duration(seconds: 20)}) async {
    if (_kokoro.isReady) return true;
    try {
      return await _kokoro.prepare().timeout(timeout, onTimeout: () => false);
    } catch (_) {
      return false;
    }
  }

  static bool get neuralReady => _kokoro.isReady;

  static Future<Uint8List?> synthesizeNeural(String text) async {
    final clean = stripButler(text);
    if (clean.isEmpty) return null;
    await _applyStoredSettings();
    if (!_kokoro.isReady) {
      _prepareInBackground();
      return null;
    }
    try {
      return await _kokoro.synthesize(clean);
    } catch (_) {
      return null;
    }
  }

  static Future<bool> previewVoice() => speakText('Hey, I\u2019m CHE. You\u2019re hearing my Chaze signature voice.');

  /// Why the last [playAudio] did not play, in the iPhone's own words (for
  /// example AVAudioPlayer's error), or empty when it played.
  static String lastPlaybackError = '';

  /// What the iPhone reported for the last clip: where it played ("speaker",
  /// "receiver", "bluetooth", "headphones", ...), the iPhone's own volume,
  /// CHE's Voice Volume, the clip's loudness and any gain added. Empty on a
  /// build without that report.
  static Map<String, dynamic> lastPlayback = const {};

  /// Plays one ElevenLabs or Fish clip. [text] is what the clip says, so the
  /// iPhone never takes CHE's own voice for the owner interrupting. [volume]
  /// (0 to 1) and [output] ("auto", "speaker" or "receiver") default to the
  /// owner's Voice Volume and Audio Output.
  static Future<bool> playAudio(Uint8List bytes, {String text = '', double? volume, String? output}) async {
    lastPlaybackError = '';
    final prefs = CheUiPreferences.instance;
    try {
      final value = await _methods.invokeMethod<Object?>('playClip', {
        'bytes': bytes,
        'text': text,
        'volume': (volume ?? prefs.voiceVolume).clamp(0.0, 1.0),
        'output': output ?? prefs.audioOutput.name,
        'normalize': true,
      });
      bridgePresent = true;
      if (value is Map) lastPlayback = Map<String, dynamic>.from(value);
      final played = value is Map ? value['played'] == true : value == true;
      if (!played) lastPlaybackError = 'the audio player stopped or did not start';
      return played;
    } on MissingPluginException {
      // An iPhone build from before playClip: play the same bytes the old way.
    } on PlatformException catch (error) {
      final detail = (error.details ?? error.message ?? '').toString().trim();
      lastPlaybackError = detail.isEmpty ? error.code : '${error.code}: $detail';
      return false;
    }
    try {
      final played = await _methods.invokeMethod<bool>('playAudio', bytes) ?? false;
      bridgePresent = true;
      if (!played) lastPlaybackError = 'the audio player stopped or did not start';
      return played;
    } on MissingPluginException {
      bridgePresent = false;
      // The voice bridge is missing from this build (it is registered at
      // launch in native code, which a Dart patch cannot change).
      lastPlaybackError = 'this CHE build cannot play voice audio; install the newest CHE build from Updates';
      return false;
    } on PlatformException catch (error) {
      final detail = (error.details ?? error.message ?? '').toString().trim();
      lastPlaybackError = detail.isEmpty ? error.code : '${error.code}: $detail';
      return false;
    }
  }

  /// Where CHE's voice plays right now, as iOS reports it, or null on a
  /// build that cannot say.
  static Future<Map<String, dynamic>?> audioRoute() => _routeCall('audioRoute');

  /// Tells the iPhone where CHE's voice should play ("auto", "speaker" or
  /// "receiver"). Returns the route iOS reports afterwards, or null on a
  /// build without output control (it plays on the loudspeaker).
  static Future<Map<String, dynamic>?> setAudioOutput(String output) => _routeCall('setAudioOutput', output);

  // An older build answers "not implemented" here while its voice bridge
  // works, so these calls never mark the bridge missing.
  static Future<Map<String, dynamic>?> _routeCall(String method, [Object? arguments]) async {
    try {
      final value = await _methods.invokeMethod<Object?>(method, arguments);
      return value is Map ? Map<String, dynamic>.from(value) : null;
    } on MissingPluginException {
      return null;
    } on PlatformException {
      // An unsupported route query may return null; an explicit route change
      // must propagate native failure so UI and voice never announce success.
      if (method == 'setAudioOutput') rethrow;
      return null;
    }
  }

  /// How long one clip may play before it counts as stuck. Scales with the bytes
  /// for compressed speech, but is capped: uncompressed WAV (24 kHz PCM16 from
  /// the Gemini route) is about 20 times larger per second of audio, and an
  /// uncapped deadline would leave a silent turn for minutes.
  static Duration playbackDeadline(int bytes) {
    final seconds = 3 + bytes ~/ 2000;
    return Duration(seconds: seconds > 60 ? 60 : seconds);
  }

  /// Plays one clip but never waits forever. A player that stops reporting
  /// completion would otherwise hold the whole speech turn in silence. On
  /// timeout the audio is stopped and the caller shows that chunk and why.
  static Future<bool> playAudioBounded(
    Uint8List bytes, {
    Duration? limit,
    String text = '',
    double? volume,
    String? output,
  }) async {
    final wait = limit ?? playbackDeadline(bytes.length);
    try {
      return await playAudio(bytes, text: text, volume: volume, output: output).timeout(wait);
    } on TimeoutException {
      lastPlaybackError = 'playback did not finish within ${wait.inSeconds} seconds';
      try {
        await stopAudio();
      } catch (_) {}
      return false;
    }
  }

  static Future<bool> stopAudio() async => (await _invoke<bool>('stopAudio')) ?? false;

  static Future<Map<String, dynamic>> status() async {
    _prepareInBackground();
    final raw = await _invoke<dynamic>('status');
    final result = raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{'native_bridge': bridgePresent ? 'present' : 'missing'};
    if (!bridgePresent) {
      result['native_bridge'] = 'missing';
      result['fallback'] = 'Flutter speech_to_text / TTS until Swift che/native_voice lands';
    } else {
      result['native_bridge'] = 'present';
    }
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

/// What CHE says for an output route the iPhone reports.
String cheAudioRouteLabel(String route) => switch (route) {
      'speaker' => 'the loudspeaker',
      'receiver' => 'the earpiece',
      'bluetooth' => 'Bluetooth',
      'headphones' => 'headphones',
      'airplay' => 'AirPlay',
      'car' => 'your car',
      'usb' => 'a USB audio device',
      'external' => 'an external audio output',
      'none' => 'no audio output',
      '' => 'an output this CHE build cannot report',
      _ => 'another audio output',
    };

/// "the loudspeaker" or "Bluetooth (AirPods Pro)", from the iPhone's report.
String cheAudioRouteSpoken(Map<String, dynamic> report) {
  final route = report['route']?.toString() ?? '';
  final outputs = report['outputs'];
  final name = outputs is List && outputs.isNotEmpty && outputs.first is Map
      ? ((outputs.first as Map)['name']?.toString() ?? '').trim()
      : '';
  final label = cheAudioRouteLabel(route);
  final named = ['bluetooth', 'headphones', 'airplay', 'car', 'usb', 'external'].contains(route) && name.isNotEmpty;
  return named ? '$label ($name)' : label;
}

/// The iPhone's own volume as a percentage, or null when it was not reported.
int? cheIphoneVolumePercent(Map<String, dynamic> report) {
  final v = report['output_volume'];
  return v is num ? (v.clamp(0, 1) * 100).round() : null;
}
