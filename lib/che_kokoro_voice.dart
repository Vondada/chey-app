import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

enum _CheTtsFamily {
  kokoro,
  vits,
}

class _ResolvedTtsPaths {
  const _ResolvedTtsPaths({
    required this.family,
    required this.model,
    required this.tokens,
    required this.dataDir,
    this.voices,
    this.lexicon,
  });

  final _CheTtsFamily family;
  final File model;
  final File tokens;
  final Directory dataDir;
  final File? voices;
  final File? lexicon;
}

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
    if (_tts != null) {
      return true;
    }

    final existing = _preparing;
    if (existing != null) {
      return existing;
    }

    final task = _prepareInternal();
    _preparing = task;

    try {
      return await task;
    } catch (error, stackTrace) {
      debugPrint(
        'CHE local TTS prepare failed:\n'
        '$error\n'
        '$stackTrace',
      );
      rethrow;
    } finally {
      _preparing = null;
    }
  }

  Future<bool> _prepareInternal() async {
    final documents = await getApplicationDocumentsDirectory();

    final root = Directory(
      '${documents.path}/che-local-voice',
    );

    await root.create(recursive: true);

    final modelDir = Directory(
      '${root.path}/$_modelFolder',
    );

    final family = _detectFamily(_modelFolder);

    _ResolvedTtsPaths resolved;

    if (modelDir.existsSync()) {
      try {
        resolved = _validateModelTree(
          modelDir,
          family,
        );

        debugPrint(
          'CHE local TTS found complete existing model at '
          '${modelDir.absolute.path}',
        );
      } catch (error, stackTrace) {
        debugPrint(
          'CHE local TTS found incomplete model tree. '
          'Deleting it before downloading again.\n'
          'Model directory: ${modelDir.absolute.path}\n'
          'Validation error: $error\n'
          '$stackTrace',
        );

        try {
          await modelDir.delete(recursive: true);
        } catch (deleteError, deleteStack) {
          debugPrint(
            'CHE local TTS could not delete incomplete model folder:\n'
            '${modelDir.absolute.path}\n'
            '$deleteError\n'
            '$deleteStack',
          );

          throw StateError(
            'CHE offline TTS could not remove incomplete model directory: '
            '${modelDir.absolute.path}. Cause: $deleteError',
          );
        }

        await _downloadAndExtractModel(root);

        resolved = _validateModelTree(
          modelDir,
          family,
        );
      }
    } else {
      await _downloadAndExtractModel(root);

      resolved = _validateModelTree(
        modelDir,
        family,
      );
    }

    _logResolvedPaths(resolved);

    await sherpa_onnx.initBindingsAsync();

    final modelConfig = _buildModelConfig(resolved);

    final config = sherpa_onnx.OfflineTtsConfig(
      model: modelConfig,
      maxNumSenetences: 1,
      silenceScale: _pauseScale,
    );

    final configContext = <String, Object?>{
      'family': resolved.family.name,
      'modelFolder': _modelFolder,
      'model': resolved.model.absolute.path,
      'voices': resolved.voices?.absolute.path,
      'tokens': resolved.tokens.absolute.path,
      'dataDir': resolved.dataDir.absolute.path,
      'lexicon': resolved.lexicon?.absolute.path,
      'provider': 'cpu',
      'numThreads': 1,
      'debug': true,
      'silenceScale': _pauseScale,
    };

    debugPrint(
      'CHE OfflineTts configuration immediately before native creation:\n'
      '$configContext',
    );

    //
    // IMPORTANT:
    //
    // SherpaOnnxCreateOfflineTts may terminate the process natively if given
    // invalid configuration. Everything above this point validates the complete
    // filesystem tree before this constructor is reachable.
    //
    try {
      _tts = sherpa_onnx.OfflineTts(config);
    } catch (error, stackTrace) {
      debugPrint(
        'CHE OfflineTts Dart constructor exception:\n'
        'Configuration: $configContext\n'
        'Error: $error\n'
        '$stackTrace',
      );

      throw StateError(
        'CHE failed to create OfflineTts for ${resolved.family.name}. '
        'Configuration: $configContext. '
        'Cause: $error',
      );
    }

    _workDir = root;

    return true;
  }

  _CheTtsFamily _detectFamily(String folderName) {
    final normalized = folderName.toLowerCase();

    if (normalized.contains('kokoro')) {
      return _CheTtsFamily.kokoro;
    }

    if (normalized.contains('piper') ||
        normalized.contains('vits')) {
      return _CheTtsFamily.vits;
    }

    throw StateError(
      'CHE offline TTS cannot determine model family from folder: '
      '$folderName',
    );
  }

  sherpa_onnx.OfflineTtsModelConfig _buildModelConfig(
    _ResolvedTtsPaths resolved,
  ) {
    switch (resolved.family) {
      case _CheTtsFamily.kokoro:
        final voices = resolved.voices;

        if (voices == null) {
          throw StateError(
            'CHE offline TTS missing required Kokoro file: '
            '${resolved.model.parent.path}/voices.bin',
          );
        }

        return sherpa_onnx.OfflineTtsModelConfig(
          kokoro: sherpa_onnx.OfflineTtsKokoroModelConfig(
            model: resolved.model.absolute.path,
            voices: voices.absolute.path,
            tokens: resolved.tokens.absolute.path,
            dataDir: resolved.dataDir.absolute.path,
            lexicon: resolved.lexicon?.absolute.path ?? '',
          ),
          provider: 'cpu',
          numThreads: 1,
          debug: true,
        );

      case _CheTtsFamily.vits:
        return sherpa_onnx.OfflineTtsModelConfig(
          vits: sherpa_onnx.OfflineTtsVitsModelConfig(
            model: resolved.model.absolute.path,
            tokens: resolved.tokens.absolute.path,
            dataDir: resolved.dataDir.absolute.path,
            lexicon: resolved.lexicon?.absolute.path ?? '',
          ),
          provider: 'cpu',
          numThreads: 1,
          debug: true,
        );
    }
  }

  _ResolvedTtsPaths _validateModelTree(
    Directory modelDir,
    _CheTtsFamily family,
  ) {
    _requireDirectory(modelDir);

    final model = _resolveModelFile(modelDir);

    final tokens = _requireFile(
      File('${modelDir.path}/tokens.txt'),
    );

    final dataDir = _requireDirectory(
      Directory('${modelDir.path}/espeak-ng-data'),
    );

    _requireFile(
      File('${dataDir.path}/phontab'),
    );

    _requireFile(
      File('${dataDir.path}/phonindex'),
    );

    _requireFile(
      File('${dataDir.path}/phondata'),
    );

    _requireFile(
      File('${dataDir.path}/intontab'),
    );

    File? voices;

    switch (family) {
      case _CheTtsFamily.kokoro:
        voices = _requireFile(
          File('${modelDir.path}/voices.bin'),
        );
        break;

      case _CheTtsFamily.vits:
        break;
    }

    final lexiconCandidate = File(
      '${modelDir.path}/lexicon.txt',
    );

    File? lexicon;

    if (lexiconCandidate.existsSync()) {
      lexicon = _requireFile(lexiconCandidate);
    }

    return _ResolvedTtsPaths(
      family: family,
      model: model,
      voices: voices,
      tokens: tokens,
      dataDir: dataDir,
      lexicon: lexicon,
    );
  }

  File _resolveModelFile(
    Directory modelDir,
  ) {
    final int8Model = File(
      '${modelDir.path}/model.int8.onnx',
    );

    if (int8Model.existsSync()) {
      return _requireFile(int8Model);
    }

    final standardModel = File(
      '${modelDir.path}/model.onnx',
    );

    if (standardModel.existsSync()) {
      return _requireFile(standardModel);
    }

    throw StateError(
      'CHE offline TTS missing required model file. '
      'Missing path: ${int8Model.absolute.path}. '
      'Fallback path is also missing: ${standardModel.absolute.path}',
    );
  }

  File _requireFile(File file) {
    final absolute = file.absolute;

    if (!absolute.existsSync()) {
      throw StateError(
        'CHE offline TTS missing required file: '
        '${absolute.path}',
      );
    }

    int length;

    try {
      length = absolute.lengthSync();
    } catch (error, stackTrace) {
      debugPrint(
        'CHE could not inspect required file:\n'
        '${absolute.path}\n'
        '$error\n'
        '$stackTrace',
      );

      throw StateError(
        'CHE offline TTS could not read required file: '
        '${absolute.path}. Cause: $error',
      );
    }

    if (length <= 0) {
      throw StateError(
        'CHE offline TTS required file is empty: '
        '${absolute.path}',
      );
    }

    return absolute;
  }

  Directory _requireDirectory(
    Directory directory,
  ) {
    final absolute = directory.absolute;

    if (!absolute.existsSync()) {
      throw StateError(
        'CHE offline TTS missing required directory: '
        '${absolute.path}',
      );
    }

    return absolute;
  }

  void _logResolvedPaths(
    _ResolvedTtsPaths resolved,
  ) {
    debugPrint(
      'CHE local TTS family: '
      '${resolved.family.name}',
    );

    debugPrint(
      'CHE local TTS model: '
      '${resolved.model.absolute.path}',
    );

    if (resolved.voices != null) {
      debugPrint(
        'CHE local TTS voices: '
        '${resolved.voices!.absolute.path}',
      );
    }

    debugPrint(
      'CHE local TTS tokens: '
      '${resolved.tokens.absolute.path}',
    );

    debugPrint(
      'CHE local TTS espeak data: '
      '${resolved.dataDir.absolute.path}',
    );

    debugPrint(
      'CHE local TTS phontab: '
      '${resolved.dataDir.absolute.path}/phontab',
    );

    debugPrint(
      'CHE local TTS phonindex: '
      '${resolved.dataDir.absolute.path}/phonindex',
    );

    debugPrint(
      'CHE local TTS phondata: '
      '${resolved.dataDir.absolute.path}/phondata',
    );

    debugPrint(
      'CHE local TTS intontab: '
      '${resolved.dataDir.absolute.path}/intontab',
    );

    if (resolved.lexicon != null) {
      debugPrint(
        'CHE local TTS lexicon: '
        '${resolved.lexicon!.absolute.path}',
      );
    }
  }

  Future<void> _downloadAndExtractModel(
    Directory root,
  ) async {
    final temp = await getTemporaryDirectory();

    final packageFile = File(
      '${temp.path}/che-kokoro-$_modelFolder.tar.bz2',
    );

    final tarFile = File(
      '${temp.path}/che-kokoro-$_modelFolder.tar',
    );

    final modelDir = Directory(
      '${root.path}/$_modelFolder',
    );

    if (modelDir.existsSync()) {
      try {
        await modelDir.delete(recursive: true);
      } catch (error, stackTrace) {
        debugPrint(
          'CHE could not remove old model directory before download:\n'
          '${modelDir.absolute.path}\n'
          '$error\n'
          '$stackTrace',
        );

        throw StateError(
          'CHE offline TTS could not clear model directory: '
          '${modelDir.absolute.path}. Cause: $error',
        );
      }
    }

    try {
      if (packageFile.existsSync()) {
        try {
          packageFile.deleteSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not delete stale package file:\n'
            '${packageFile.absolute.path}\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }

      if (tarFile.existsSync()) {
        try {
          tarFile.deleteSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not delete stale tar file:\n'
            '${tarFile.absolute.path}\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }

      debugPrint(
        'CHE local TTS downloading model:\n'
        '$_modelUrl',
      );

      final client = http.Client();

      try {
        final request = http.Request(
          'GET',
          Uri.parse(_modelUrl),
        );

        final response = await client.send(request);

        if (response.statusCode < 200 ||
            response.statusCode >= 300) {
          throw StateError(
            'CHE offline TTS model download failed. '
            'URL: $_modelUrl. '
            'HTTP status: ${response.statusCode}',
          );
        }

        final sink = packageFile.openWrite();

        try {
          await response.stream.pipe(sink);
        } catch (error, stackTrace) {
          debugPrint(
            'CHE model download stream failed:\n'
            '$error\n'
            '$stackTrace',
          );

          throw StateError(
            'CHE offline TTS model download failed while writing: '
            '${packageFile.absolute.path}. Cause: $error',
          );
        }
      } finally {
        client.close();
      }

      _requireFile(packageFile);

      debugPrint(
        'CHE local TTS downloaded archive: '
        '${packageFile.absolute.path}',
      );

      final compressedInput = InputFileStream(
        packageFile.path,
      );

      final tarOutput = OutputFileStream(
        tarFile.path,
      );

      try {
        BZip2Decoder().decodeStream(
          compressedInput,
          tarOutput,
        );
      } catch (error, stackTrace) {
        debugPrint(
          'CHE model BZip2 decode failed:\n'
          '$error\n'
          '$stackTrace',
        );

        throw StateError(
          'CHE offline TTS could not decompress archive: '
          '${packageFile.absolute.path}. Cause: $error',
        );
      } finally {
        try {
          tarOutput.closeSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not close tar output stream:\n'
            '$error\n'
            '$stackTrace',
          );
        }

        try {
          compressedInput.closeSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not close compressed input stream:\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }

      _requireFile(tarFile);

      final tarInput = InputFileStream(
        tarFile.path,
      );

      try {
        final archive = TarDecoder().decodeStream(
          tarInput,
          storeData: false,
        );

        var extractedFiles = 0;

        for (final entry in archive) {
          final normalizedName = entry.name.replaceAll(
            '\\',
            '/',
          );

          if (!normalizedName.startsWith(
                '$_modelFolder/',
              ) ||
              normalizedName.contains('../')) {
            continue;
          }

          final destinationPath =
              '${root.path}/$normalizedName';

          if (entry.isFile) {
            final destinationFile = File(
              destinationPath,
            );

            await destinationFile.parent.create(
              recursive: true,
            );

            final output = OutputFileStream(
              destinationFile.path,
            );

            try {
              entry.writeContent(output);
            } catch (error, stackTrace) {
              debugPrint(
                'CHE failed extracting model file:\n'
                '${destinationFile.absolute.path}\n'
                '$error\n'
                '$stackTrace',
              );

              throw StateError(
                'CHE offline TTS failed extracting file: '
                '${destinationFile.absolute.path}. Cause: $error',
              );
            } finally {
              try {
                output.closeSync();
              } catch (error, stackTrace) {
                debugPrint(
                  'CHE could not close extracted output file:\n'
                  '${destinationFile.absolute.path}\n'
                  '$error\n'
                  '$stackTrace',
                );
              }
            }

            extractedFiles++;
          } else {
            await Directory(destinationPath).create(
              recursive: true,
            );
          }
        }

        debugPrint(
          'CHE local TTS extracted $extractedFiles files to '
          '${modelDir.absolute.path}',
        );
      } finally {
        try {
          tarInput.closeSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not close tar input stream:\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }

      try {
        final family = _detectFamily(
          _modelFolder,
        );

        _validateModelTree(
          modelDir,
          family,
        );
      } catch (error, stackTrace) {
        debugPrint(
          'CHE extracted an incomplete model tree:\n'
          '$error\n'
          '$stackTrace',
        );

        if (modelDir.existsSync()) {
          try {
            await modelDir.delete(
              recursive: true,
            );
          } catch (deleteError, deleteStack) {
            debugPrint(
              'CHE could not delete incomplete extracted model:\n'
              '${modelDir.absolute.path}\n'
              '$deleteError\n'
              '$deleteStack',
            );
          }
        }

        rethrow;
      }
    } catch (error, stackTrace) {
      debugPrint(
        'CHE local TTS download/extract failed:\n'
        '$error\n'
        '$stackTrace',
      );

      rethrow;
    } finally {
      if (packageFile.existsSync()) {
        try {
          packageFile.deleteSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not clean temporary archive:\n'
            '${packageFile.absolute.path}\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }

      if (tarFile.existsSync()) {
        try {
          tarFile.deleteSync();
        } catch (error, stackTrace) {
          debugPrint(
            'CHE could not clean temporary tar file:\n'
            '${tarFile.absolute.path}\n'
            '$error\n'
            '$stackTrace',
          );
        }
      }
    }
  }

  Future<bool> speak(String text) async {
    final clean = text.trim();

    if (clean.isEmpty) {
      return false;
    }

    if (_tts == null) {
      try {
        final ready = await prepare();

        if (!ready || _tts == null) {
          debugPrint(
            'CHE local TTS prepare completed without a usable engine.',
          );
          return false;
        }
      } catch (error, stackTrace) {
        debugPrint(
          'CHE local TTS could not prepare before speaking:\n'
          '$error\n'
          '$stackTrace',
        );
        return false;
      }
    }

    try {
      final generationConfig =
          sherpa_onnx.OfflineTtsGenerationConfig(
        sid: _speakerId,
        speed: _speed,
        silenceScale: _pauseScale,
      );

      final audio = _tts!.generateWithConfig(
        text: clean,
        config: generationConfig,
      );

      if (audio.samples.isEmpty) {
        debugPrint(
          'CHE local TTS generated zero audio samples.',
        );
        return false;
      }

      if (audio.sampleRate <= 0) {
        debugPrint(
          'CHE local TTS returned invalid sample rate: '
          '${audio.sampleRate}',
        );
        return false;
      }

      final root =
          _workDir ??
          await getApplicationDocumentsDirectory();

      final wav = File(
        '${root.path}/'
        'che-${DateTime.now().microsecondsSinceEpoch}.wav',
      );

      sherpa_onnx.writeWave(
        filename: wav.path,
        samples: audio.samples,
        sampleRate: audio.sampleRate,
      );

      _requireFile(wav);

      final bytes = await wav.readAsBytes();

      try {
        await wav.delete();
      } catch (error, stackTrace) {
        debugPrint(
          'CHE could not delete temporary WAV:\n'
          '${wav.absolute.path}\n'
          '$error\n'
          '$stackTrace',
        );
      }

      if (bytes.isEmpty) {
        debugPrint(
          'CHE local TTS WAV contained zero bytes.',
        );
        return false;
      }

      try {
        return (await _nativeAudio.invokeMethod<bool>(
              'playAudio',
              bytes,
            )) ??
            false;
      } catch (error, stackTrace) {
        debugPrint(
          'CHE native audio playback failed:\n'
          '$error\n'
          '$stackTrace',
        );
        return false;
      }
    } catch (error, stackTrace) {
      debugPrint(
        'CHE local TTS generation failed:\n'
        '$error\n'
        '$stackTrace',
      );

      return false;
    }
  }
}
