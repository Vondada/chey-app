import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

/// On-device iPhone text fallback for CHE.
///
/// The native bridge uses Apple's Foundation Models framework when available.
/// It receives recent chat history plus CHE's already-local conversation-memory
/// context, so a network outage does not erase prior conversations from recall.
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
  static final _CheKokoroVoice _kokoro = _CheKokoroVoice(_methods);

  static const String _speakerKey = 'che.voice.kokoroSpeaker';
  static const String _speedKey = 'che.voice.kokoroSpeed';
  static const String _pauseKey = 'che.voice.kokoroPause';
  static const String _nativePitchKey = 'che.voice.nativePitch';
  static const String _nativeRateKey = 'che.voice.nativeRate';

  /// Kokoro v0.19's bundled English speakers. Region/presentation labels are
  /// descriptive voice choices, not race labels.
  static const List<Map<String, Object>> localVoiceOptions = [
    {'id': 0, 'name': 'American Feminine — Classic', 'speaker': 'af'},
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
    return {
      'speakerId': prefs.getInt(_speakerKey) ?? 3,
      'speed': prefs.getDouble(_speedKey) ?? 1.0,
      'pauseScale': prefs.getDouble(_pauseKey) ?? 0.16,
      'nativePitch': prefs.getDouble(_nativePitchKey) ?? 0.98,
      'nativeRate': prefs.getDouble(_nativeRateKey) ?? 0.94,
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

    final sid = (speakerId ?? current['speakerId'] as int).clamp(0, 10);
    final localSpeed = (speed ?? current['speed'] as double).clamp(0.70, 1.35);
    final localPause =
        (pauseScale ?? current['pauseScale'] as double).clamp(0.05, 0.35);
    final fallbackPitch =
        (nativePitch ?? current['nativePitch'] as double).clamp(0.75, 1.25);
    final fallbackRate =
        (nativeRate ?? current['nativeRate'] as double).clamp(0.70, 1.25);

    await prefs.setInt(_speakerKey, sid);
    await prefs.setDouble(_speedKey, localSpeed.toDouble());
    await prefs.setDouble(_pauseKey, localPause.toDouble());
    await prefs.setDouble(_nativePitchKey, fallbackPitch.toDouble());
    await prefs.setDouble(_nativeRateKey, fallbackRate.toDouble());

    _kokoro.configure(
      speakerId: sid,
      speed: localSpeed.toDouble(),
      pauseScale: localPause.toDouble(),
    );

    try {
      await _methods.invokeMethod('configureVoice', {
        'pitch': fallbackPitch.toDouble(),
        'rate': fallbackRate.toDouble(),
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

  /// CHE's default unmetered neural voice path on iPhone.
  ///
  /// Kokoro runs locally after its one-time voice pack download. If it is still
  /// preparing, Apple's native synthesizer carries that turn instead of stalling.
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

  static Future<bool> previewVoice() => speakText(
        'Hey, I’m CHE. This is a preview of the voice you selected.',
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

class _CheKokoroVoice {
  _CheKokoroVoice(this._nativeAudio);

  static const String _modelFolder = 'kokoro-int8-en-v0_19';
  static const String _modelUrl =
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/'
      'kokoro-int8-en-v0_19.tar.bz2';

  final MethodChannel _nativeAudio;
  sherpa_onnx.OfflineTts? _tts;
  Future<bool>? _preparing;
  Directory? _workDir;

  int _speakerId = 3;
  double _speed = 1.0;
  double _pauseScale = 0.16;

  bool get isReady => _tts != null;

  void configure({
    required int speakerId,
    required double speed,
    required double pauseScale,
  }) {
    _speakerId = speakerId.clamp(0, 10);
    _speed = speed.clamp(0.70, 1.35);
    _pauseScale = pauseScale.clamp(0.05, 0.35);
  }

  Future<bool> prepare() async {
    if (_tts != null) return true;
    if (_preparing != null) return _preparing!;

    final task = _prepareInternal();
    _preparing = task;
    final ok = await task;
    if (!ok) _preparing = null;
    return ok;
  }

  Future<bool> _prepareInternal() async {
    try {
      final support = await getApplicationSupportDirectory();
      final root = Directory('${support.path}/che-local-voice');
      await root.create(recursive: true);
      final modelDir = Directory('${root.path}/$_modelFolder');

      final model = File('${modelDir.path}/model.int8.onnx');
      final voices = File('${modelDir.path}/voices.bin');
      final tokens = File('${modelDir.path}/tokens.txt');
      final dataDir = Directory('${modelDir.path}/espeak-ng-data');

      if (!model.existsSync() ||
          !voices.existsSync() ||
          !tokens.existsSync() ||
          !dataDir.existsSync()) {
        final installed = await _installVoicePack(root);
        if (!installed) return false;
      }

      await sherpa_onnx.initBindingsAsync();
      final kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model: model.path,
        voices: voices.path,
        tokens: tokens.path,
        dataDir: dataDir.path,
      );
      final modelConfig = sherpa_onnx.OfflineTtsModelConfig(
        kokoro: kokoro,
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      );
      final config = sherpa_onnx.OfflineTtsConfig(
        model: modelConfig,
        maxNumSenetences: 1,
        silenceScale: _pauseScale,
      );
      _tts = sherpa_onnx.OfflineTts(config);
      _workDir = root;
      return true;
    } catch (_) {
      _tts = null;
      return false;
    }
  }

  Future<bool> _installVoicePack(Directory root) async {
    final temp = await getTemporaryDirectory();
    final packageFile = File('${temp.path}/che-kokoro.tar.bz2');
    final tarFile = File('${temp.path}/che-kokoro.tar');

    try {
      final client = http.Client();
      try {
        final request = http.Request('GET', Uri.parse(_modelUrl));
        final response = await client.send(request);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return false;
        }
        final sink = packageFile.openWrite();
        await response.stream.pipe(sink);
      } finally {
        client.close();
      }

      if (!packageFile.existsSync() || packageFile.lengthSync() == 0) {
        return false;
      }

      final compressedInput = InputFileStream(packageFile.path);
      final tarOutput = OutputFileStream(tarFile.path);
      try {
        BZip2Decoder().decodeStream(compressedInput, tarOutput);
      } finally {
        tarOutput.closeSync();
        compressedInput.closeSync();
      }

      final tarInput = InputFileStream(tarFile.path);
      try {
        final archive = TarDecoder().decodeStream(tarInput, storeData: false);
        for (final entry in archive) {
          final name = entry.name.replaceAll('\\', '/');
          if (!name.startsWith('$_modelFolder/') || name.contains('../')) {
            continue;
          }
          final destination = '${root.path}/$name';
          if (entry.isFile) {
            final output = OutputFileStream(destination);
            try {
              entry.writeContent(output);
            } finally {
              output.closeSync();
            }
          } else {
            Directory(destination).createSync(recursive: true);
          }
        }
      } finally {
        tarInput.closeSync();
      }

      final model = File('${root.path}/$_modelFolder/model.int8.onnx');
      final voices = File('${root.path}/$_modelFolder/voices.bin');
      final tokens = File('${root.path}/$_modelFolder/tokens.txt');
      final dataDir = Directory('${root.path}/$_modelFolder/espeak-ng-data');
      return model.existsSync() &&
          voices.existsSync() &&
          tokens.existsSync() &&
          dataDir.existsSync();
    } catch (_) {
      return false;
    } finally {
      try {
        if (packageFile.existsSync()) packageFile.deleteSync();
      } catch (_) {}
      try {
        if (tarFile.existsSync()) tarFile.deleteSync();
      } catch (_) {}
    }
  }

  Future<bool> speak(String text) async {
    if (_tts == null) {
      unawaited(prepare());
      return false;
    }

    try {
      final config = sherpa_onnx.OfflineTtsGenerationConfig(
        sid: _speakerId,
        speed: _speed,
        silenceScale: _pauseScale,
      );
      final audio = _tts!.generateWithConfig(text: text, config: config);
      if (audio.samples.isEmpty || audio.sampleRate <= 0) return false;

      final root = _workDir ?? await getTemporaryDirectory();
      final wav = File(
        '${root.path}/che-${DateTime.now().microsecondsSinceEpoch}.wav',
      );
      sherpa_onnx.writeWave(
        filename: wav.path,
        samples: audio.samples,
        sampleRate: audio.sampleRate,
      );
      final bytes = await wav.readAsBytes();
      try {
        await wav.delete();
      } catch (_) {}
      if (bytes.isEmpty) return false;

      return (await _nativeAudio.invokeMethod<bool>('playAudio', bytes)) ?? false;
    } catch (_) {
      return false;
    }
  }
}
