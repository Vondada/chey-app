import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'che_bootstrap.dart';
import 'che_native_voice.dart';

/// Pinned Local Brain model. Chosen for English instruction following,
/// tool-routing, permissive license, and iPhone RAM.
class CheLocalBrainModel {
  const CheLocalBrainModel({
    required this.modelId,
    required this.version,
    required this.runtime,
    required this.filename,
    required this.sourceUrl,
    required this.sourcePage,
    required this.license,
    required this.quantization,
    required this.parameterCount,
    required this.bytes,
    required this.sha256,
    required this.contextLength,
    required this.expectedRamMb,
  });

  final String modelId;
  final String version;
  final String runtime;
  final String filename;
  final String sourceUrl;
  final String sourcePage;
  final String license;
  final String quantization;
  final String parameterCount;
  final int bytes;
  final String sha256;
  final int contextLength;
  final int expectedRamMb;
}

/// SmolLM2 1.7B Instruct Q4_K_M — Apache-2.0, ~1.0 GiB.
const cheDefaultLocalBrainModel = CheLocalBrainModel(
  modelId: 'smollm2-1.7b-instruct',
  version: '2025-12-instruct',
  runtime: 'llama.cpp-gguf',
  filename: 'smollm2-1.7b-instruct-q4_k_m.gguf',
  sourceUrl:
      'https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf',
  sourcePage: 'https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
  license: 'Apache-2.0',
  quantization: 'Q4_K_M',
  parameterCount: '1.7B',
  bytes: 1058914304,
  sha256: '',
  contextLength: 8192,
  expectedRamMb: 1800,
);

class CheLocalBrainHealth {
  const CheLocalBrainHealth({
    required this.installed,
    required this.loaded,
    required this.available,
    required this.status,
    this.detail = '',
  });

  final bool installed;
  final bool loaded;
  final bool available;
  final String status;
  final String detail;
}

class CheLocalBrain {
  CheLocalBrain({
    CheLocalBrainModel model = cheDefaultLocalBrainModel,
    MethodChannel? channel,
  })  : model = model,
        _channel = channel ?? const MethodChannel('che/local_brain');

  final CheLocalBrainModel model;
  final MethodChannel _channel;
  bool _loaded = false;
  bool _downloadAnnounced = false;

  CheLocalBrainModel get modelInfo => model;

  Future<CheLocalBrainHealth> health() async {
    final native = await CheLocalAI.available;
    var installed = false;
    try {
      installed = (await _channel.invokeMethod<bool>('installed', {
            'filename': model.filename,
          })) ??
          false;
    } on MissingPluginException {
      installed = native;
    } catch (_) {}
    return CheLocalBrainHealth(
      installed: installed,
      loaded: _loaded,
      available: native || installed,
      status: _loaded
          ? 'ready'
          : installed
              ? 'installed'
              : native
                  ? 'native_bridge'
                  : 'missing',
    );
  }

  Future<void> initialize() async {
    await ensureModel();
  }

  Future<bool> ensureModel({void Function(String speech)? announce}) async {
    final current = await health();
    if (current.installed || current.status == 'native_bridge') return true;
    if (!_downloadAnnounced) {
      _downloadAnnounced = true;
      final gb = (model.bytes / (1024 * 1024 * 1024)).toStringAsFixed(1);
      announce?.call("Sir, I'm installing my offline brain. It's about $gb gigabytes.");
    }
    return downloadModel();
  }

  Future<bool> downloadModel() async {
    if (kIsWeb) return false;
    try {
      final ok = await _channel.invokeMethod<bool>('download', {
        'url': model.sourceUrl,
        'filename': model.filename,
        'bytes': model.bytes,
        'sha256': model.sha256,
      });
      return ok ?? false;
    } on MissingPluginException {
      return CheLocalAI.available;
    } catch (_) {
      return false;
    }
  }

  Future<bool> verifyModel() async {
    try {
      return (await _channel.invokeMethod<bool>('verify', {
            'filename': model.filename,
            'bytes': model.bytes,
            'sha256': model.sha256,
          })) ??
          false;
    } catch (_) {
      return false;
    }
  }

  Future<bool> loadModel() async {
    try {
      final ok = await _channel.invokeMethod<bool>('load', {
        'filename': model.filename,
        'n_ctx': model.contextLength,
      });
      _loaded = ok ?? false;
      if (_loaded) return true;
    } on MissingPluginException {
      _loaded = await CheLocalAI.available;
      return _loaded;
    } catch (_) {}
    _loaded = await CheLocalAI.available;
    return _loaded;
  }

  Future<String?> generate({
    required String prompt,
    CheBootstrapPacket? bootstrap,
    List<Map<String, String>> history = const [],
    List<String> memory = const [],
  }) async {
    final packet = bootstrap ??
        CheBootstrapPacket(
          request: prompt,
          capabilities: const ['chat', 'memory', 'local_inference'],
          cloudHealth: 'unknown',
          localBrainHealth: 'active',
          currentProvider: 'local_brain',
          currentModel: model.modelId,
          memory: memory,
        );
    final composed = '${packet.compactPrompt(small: true)}\n$prompt';
    try {
      final text = (await _channel.invokeMethod<String>('generate', {
        'prompt': composed,
        'history': history.take(8).toList(growable: false),
      }))
          ?.trim();
      if (text != null && text.isNotEmpty) return text;
    } on MissingPluginException {
      // Fall through to the existing on-device channel.
    } catch (_) {}
    return CheLocalAI.respond(composed, history: history, memoryContext: memory);
  }

  Stream<String> stream({
    required String prompt,
    List<Map<String, String>> history = const [],
    CheBootstrapPacket? bootstrap,
  }) async* {
    final text = await generate(prompt: prompt, history: history, bootstrap: bootstrap);
    if (text == null || text.isEmpty) return;
    const step = 24;
    for (var i = 0; i < text.length; i += step) {
      final end = (i + step > text.length) ? text.length : i + step;
      yield text.substring(i, end);
    }
  }

  Future<void> cancel() async {
    try {
      await _channel.invokeMethod<void>('cancel');
    } catch (_) {}
  }

  Future<void> dispose() async {
    _loaded = false;
    try {
      await _channel.invokeMethod<void>('dispose');
    } catch (_) {}
  }

  Map<String, Object?> describe() => {
        'model_id': model.modelId,
        'version': model.version,
        'runtime': model.runtime,
        'filename': model.filename,
        'source': model.sourcePage,
        'license': model.license,
        'quantization': model.quantization,
        'parameter_count': model.parameterCount,
        'bytes': model.bytes,
        'sha256': model.sha256,
        'context_length': model.contextLength,
        'expected_ram_mb': model.expectedRamMb,
        'loaded': _loaded,
      };
}

String localBrainStatusSpeech(CheLocalBrainHealth health, {String? cloudProvider}) {
  if (cloudProvider != null && cloudProvider.isNotEmpty && health.available) {
    return '$cloudProvider is answering right now, sir. My Local Brain is ${health.status == 'ready' || health.status == 'installed' ? 'installed and ready' : 'available as backup'}.';
  }
  if (health.loaded || health.status == 'ready' || health.status == 'native_bridge') {
    return "The cloud engines are down. I'm running locally.";
  }
  return "The cloud engines are down, sir, and my offline brain is not installed yet.";
}

String encodeLocalBrainMeta(Map<String, Object?> info) => jsonEncode(info);
