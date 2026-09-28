import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

class CheNativeVoice {
  static const MethodChannel _methods = MethodChannel('che/native_voice');
  static const EventChannel _events = EventChannel('che/native_voice_events');
  static final _CheKokoroVoice _kokoro = _CheKokoroVoice(_methods);

  static Stream<Map<String, dynamic>>? _cachedEvents;

  static Stream<Map<String, dynamic>> get events {
    _cachedEvents ??= _events
        .receiveBroadcastStream()
        .where((event) => event is Map)
        .map((event) => Map<String, dynamic>.from(event as Map))
        .asBroadcastStream();
    return _cachedEvents!;
  }

  static Future<bool> start() async {
    unawaited(_kokoro.prepare());
    return (await _methods.invokeMethod<bool>('start')) ?? false;
  }

  static Future<bool> stop() async =>
      (await _methods.invokeMethod<bool>('stop')) ?? false;

  static Future<bool> sleep() async =>
      (await _methods.invokeMethod<bool>('sleep')) ?? false;

  static Future<bool> wake() async {
    unawaited(_kokoro.prepare());
    return (await _methods.invokeMethod<bool>('wake')) ?? false;
  }

  static Future<void> setAssistantSpeaking(bool value) async {
    await _methods.invokeMethod('assistantSpeaking', value);
  }

  /// CHE's default free voice path on iPhone.
  ///
  /// Kokoro is a local neural TTS model. Once its voice pack is cached on the
  /// phone, speech generation has no per-message API bill or daily cloud quota.
  /// If the local model is still preparing, CHE falls through to Apple's native
  /// synthesizer for that turn instead of stalling the conversation.
  static Future<bool> speakText(String text) async {
    final clean = text.trim();
    if (clean.isEmpty) return false;

    try {
      if (await _kokoro.speak(clean)) return true;
    } catch (_) {
      // Keep voice reliable even if the optional local neural model cannot run.
    }

    return (await _methods.invokeMethod<bool>('speakText', {'text': clean})) ??
        false;
  }

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
    result['local_neural_tts'] = true;
    result['local_neural_tts_engine'] = 'kokoro';
    result['local_neural_tts_ready'] = _kokoro.isReady;
    result['local_neural_tts_unmetered'] = true;
    return result;
  }
}

class _CheKokoroVoice {
  _CheKokoroVoice(this._nativeAudio);

  static const String _modelFolder = 'kokoro-int8-en-v0_19';
  static const String _modelUrl =
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/'
      'kokoro-int8-en-v0_19.tar.bz2';

  // af_sarah: smooth American feminine Kokoro voice.
  static const int _speakerId = 3;
  static const double _speed = 1.0;

  final MethodChannel _nativeAudio;
  sherpa_onnx.OfflineTts? _tts;
  Future<bool>? _preparing;
  Directory? _workDir;

  bool get isReady => _tts != null;

  Future<bool> prepare() async {
    if (_tts != null) return true;
    if (_preparing != null) return _preparing!;

    final task = _prepareInternal();
    _preparing = task;
    final ok = await task;
    if (!ok) _preparing = null; // allow a later retry after transient failures
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
        silenceScale: 0.16,
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
      // Start the one-time model setup in parallel and let native iOS TTS carry
      // the current turn. The next turn automatically uses Kokoro when ready.
      unawaited(prepare());
      return false;
    }

    try {
      final config = sherpa_onnx.OfflineTtsGenerationConfig(
        sid: _speakerId,
        speed: _speed,
        silenceScale: 0.16,
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

      return (await _nativeAudio.invokeMethod<bool>('playAudio', bytes)) ??
          false;
    } catch (_) {
      return false;
    }
  }
}
