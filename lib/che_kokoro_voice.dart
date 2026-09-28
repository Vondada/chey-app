import 'dart:async';
import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

class CheKokoroVoice {
  CheKokoroVoice(this._nativeAudio);

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
    _speakerId = speakerId.clamp(0, 10).toInt();
    _speed = speed.clamp(0.70, 1.35).toDouble();
    _pauseScale = pauseScale.clamp(0.05, 0.35).toDouble();
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
        if (!await _installVoicePack(root)) return false;
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
