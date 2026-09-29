import 'dart:async';
import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

enum _CheTtsFamily { kokoro, vits }

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

  int _speakerId = 0;
  double _speed = 0.94;
  double _pauseScale = 0.12;

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
    try {
      final ok = await task;
      if (!ok) _preparing = null;
      return ok;
    } catch (error, stack) {
      _preparing = null;
      debugPrint('CHE local TTS prepare failed: $error\n$stack');
      return false;
    }
  }

  Future<bool> _prepareInternal() async {
    final documents = await getApplicationDocumentsDirectory();
    final root = Directory('${documents.path}/che-local-voice');
    await root.create(recursive: true);

    final modelDir = Directory('${root.path}/$_modelFolder');
    await modelDir.create(recursive: true);

    final copied = await _copyBundledModelDirectory(modelDir);

    // CHE currently does not bundle the large Kokoro pack in the IPA. If the
    // asset directory is absent, install the same official pack into Documents.
    if (!copied) {
      await _installVoicePack(root);
    }

    final family = _detectFamily(_modelFolder);
    final resolved = _resolveRequiredPaths(modelDir, family);

    _logResolvedPaths(resolved, family);

    await sherpa_onnx.initBindingsAsync();

    final modelConfig = family == _CheTtsFamily.kokoro
        ? sherpa_onnx.OfflineTtsModelConfig(
            kokoro: sherpa_onnx.OfflineTtsKokoroModelConfig(
              model: resolved.model.path,
              voices: resolved.voices!.path,
              tokens: resolved.tokens.path,
              dataDir: resolved.dataDir.path,
              lexicon: resolved.lexicon?.path ?? '',
            ),
            provider: 'cpu',
            numThreads: 1,
            debug: true,
          )
        : sherpa_onnx.OfflineTtsModelConfig(
            vits: sherpa_onnx.OfflineTtsVitsModelConfig(
              model: resolved.model.path,
              tokens: resolved.tokens.path,
              dataDir: resolved.dataDir.path,
              lexicon: resolved.lexicon?.path ?? '',
            ),
            provider: 'cpu',
            numThreads: 1,
            debug: true,
          );

    final config = sherpa_onnx.OfflineTtsConfig(
      model: modelConfig,
      maxNumSenetences: 1,
      silenceScale: _pauseScale,
    );

    final context = <String, Object?>{
      'family': family.name,
      'folder': _modelFolder,
      'model': resolved.model.path,
      'voices': resolved.voices?.path,
      'tokens': resolved.tokens.path,
      'dataDir': resolved.dataDir.path,
      'lexicon': resolved.lexicon?.path,
      'provider': 'cpu',
      'numThreads': 1,
      'debug': true,
    };

    debugPrint('CHE OfflineTts config: $context');

    try {
      _tts = sherpa_onnx.OfflineTts(config);
    } catch (error, stack) {
      debugPrint(
        'CHE OfflineTts constructor failed. Config: $context\n'
        'Error: $error\n$stack',
      );
      throw StateError(
        'Failed to create CHE offline TTS for ${family.name} '
        'using $_modelFolder. Config: $context. Cause: $error',
      );
    }

    _workDir = root;
    return true;
  }

  Future<bool> _copyBundledModelDirectory(Directory destination) async {
    final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
    final assets = manifest.listAssets();

    final marker = '/$_modelFolder/';
    final keys = assets
        .where(
          (key) =>
              key.startsWith('assets/') &&
              (key.contains(marker) ||
                  key.startsWith('assets/$_modelFolder/')),
        )
        .toList();

    if (keys.isEmpty) {
      debugPrint(
        'CHE local TTS: no bundled $_modelFolder asset directory found; '
        'using Documents download fallback.',
      );
      return false;
    }

    for (final key in keys) {
      final markerIndex = key.indexOf(marker);
      final relative = markerIndex >= 0
          ? key.substring(markerIndex + marker.length)
          : key.substring('assets/$_modelFolder/'.length);
      if (relative.isEmpty) continue;

      final target = File('${destination.path}/$relative');
      await target.parent.create(recursive: true);

      final data = await rootBundle.load(key);
      final bytes = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      await target.writeAsBytes(bytes, flush: true);
    }

    debugPrint(
      'CHE local TTS: copied ${keys.length} bundled model assets to '
      '${destination.path}',
    );
    return true;
  }

  _CheTtsFamily _detectFamily(String folderName) {
    final lower = folderName.toLowerCase();
    if (lower.contains('kokoro')) return _CheTtsFamily.kokoro;
    if (lower.contains('piper') || lower.contains('vits')) {
      return _CheTtsFamily.vits;
    }
    throw StateError(
      'Unsupported CHE TTS model folder "$folderName". '
      'Expected a Kokoro or Piper/VITS folder name.',
    );
  }

  _ResolvedTtsPaths _resolveRequiredPaths(
    Directory modelDir,
    _CheTtsFamily family,
  ) {
    _requireDirectory(modelDir);

    final model = _findOnnxModel(modelDir);
    final tokens = _requireFile(File('${modelDir.path}/tokens.txt'));
    final dataDir = _requireDirectory(
      Directory('${modelDir.path}/espeak-ng-data'),
    );

    for (final name in const [
      'phontab',
      'phonindex',
      'phondata',
      'intonations',
    ]) {
      _requireFile(File('${dataDir.path}/$name'));
    }

    File? voices;
    if (family == _CheTtsFamily.kokoro) {
      voices = _requireFile(File('${modelDir.path}/voices.bin'));
    }

    final lexiconFile = File('${modelDir.path}/lexicon.txt');
    final lexicon = lexiconFile.existsSync() ? lexiconFile : null;

    return _ResolvedTtsPaths(
      model: model,
      voices: voices,
      tokens: tokens,
      dataDir: dataDir,
      lexicon: lexicon,
    );
  }

  File _findOnnxModel(Directory modelDir) {
    final preferred = [
      File('${modelDir.path}/model.int8.onnx'),
      File('${modelDir.path}/model.onnx'),
    ];

    for (final file in preferred) {
      if (file.existsSync() && file.lengthSync() > 0) return file;
    }

    final models = modelDir
        .listSync(followLinks: false)
        .whereType<File>()
        .where((file) => file.path.toLowerCase().endsWith('.onnx'))
        .where((file) => file.lengthSync() > 0)
        .toList();

    if (models.length == 1) return models.single;

    if (models.isEmpty) {
      throw StateError(
        'CHE offline TTS model is missing an ONNX file in '
        '${modelDir.path}',
      );
    }

    throw StateError(
      'CHE offline TTS found multiple ONNX files in ${modelDir.path}: '
      '${models.map((e) => e.path).join(', ')}',
    );
  }

  File _requireFile(File file) {
    if (!file.existsSync()) {
      throw StateError('CHE offline TTS missing required file: ${file.path}');
    }
    if (file.lengthSync() <= 0) {
      throw StateError('CHE offline TTS required file is empty: ${file.path}');
    }
    return file;
  }

  Directory _requireDirectory(Directory directory) {
    if (!directory.existsSync()) {
      throw StateError(
        'CHE offline TTS missing required directory: ${directory.path}',
      );
    }
    return directory;
  }

  void _logResolvedPaths(
    _ResolvedTtsPaths paths,
    _CheTtsFamily family,
  ) {
    debugPrint('CHE local TTS family: ${family.name}');
    debugPrint('CHE local TTS model: ${paths.model.absolute.path}');
    if (paths.voices != null) {
      debugPrint('CHE local TTS voices: ${paths.voices!.absolute.path}');
    }
    debugPrint('CHE local TTS tokens: ${paths.tokens.absolute.path}');
    debugPrint('CHE local TTS dataDir: ${paths.dataDir.absolute.path}');
    if (paths.lexicon != null) {
      debugPrint('CHE local TTS lexicon: ${paths.lexicon!.absolute.path}');
    }
  }

  Future<void> _installVoicePack(Directory root) async {
    final temp = await getTemporaryDirectory();
    final packageFile = File('${temp.path}/che-local-tts.tar.bz2');
    final tarFile = File('${temp.path}/che-local-tts.tar');

    try {
      final client = http.Client();
      try {
        final request = http.Request('GET', Uri.parse(_modelUrl));
        final response = await client.send(request);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw StateError(
            'CHE offline TTS model download failed with HTTP '
            '${response.statusCode}.',
          );
        }

        final sink = packageFile.openWrite();
        await response.stream.pipe(sink);
      } finally {
        client.close();
      }

      _requireFile(packageFile);

      final compressedInput = InputFileStream(packageFile.path);
      final tarOutput = OutputFileStream(tarFile.path);
      try {
        BZip2Decoder().decodeStream(compressedInput, tarOutput);
      } finally {
        tarOutput.closeSync();
        compressedInput.closeSync();
      }

      _requireFile(tarFile);

      final tarInput = InputFileStream(tarFile.path);
      try {
        final archive = TarDecoder().decodeStream(
          tarInput,
          storeData: false,
        );

        for (final entry in archive) {
          final name = entry.name.replaceAll('\\', '/');
          if (!name.startsWith('$_modelFolder/') || name.contains('../')) {
            continue;
          }

          final destination = '${root.path}/$name';
          if (entry.isFile) {
            final outputFile = File(destination);
            await outputFile.parent.create(recursive: true);
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
    final clean = text.trim();
    if (clean.isEmpty) return false;

    if (_tts == null) {
      final ready = await prepare();
      if (!ready || _tts == null) return false;
    }

    try {
      final config = sherpa_onnx.OfflineTtsGenerationConfig(
        sid: _speakerId,
        speed: _speed,
        silenceScale: _pauseScale,
      );
      final audio = _tts!.generateWithConfig(
        text: clean,
        config: config,
      );
      if (audio.samples.isEmpty || audio.sampleRate <= 0) return false;

      final root = _workDir ?? await getApplicationDocumentsDirectory();
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
    } catch (error, stack) {
      debugPrint('CHE local TTS generation failed: $error\n$stack');
      return false;
    }
  }
}

class _ResolvedTtsPaths {
  const _ResolvedTtsPaths({
    required this.model,
    required this.voices,
    required this.tokens,
    required this.dataDir,
    required this.lexicon,
  });

  final File model;
  final File? voices;
  final File tokens;
  final Directory dataDir;
  final File? lexicon;
}
