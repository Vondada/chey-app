import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:porcupine_flutter/porcupine_error.dart';
import 'package:porcupine_flutter/porcupine_manager.dart';

typedef CheWakeCallback = FutureOr<void> Function();
typedef CheWakeStatusCallback = void Function(String status);

/// Foreground/local wake-word listener for CHE.
///
/// Architecture:
/// - Apple Vocal Shortcuts/App Intent handles iPhone-level wake into the app.
/// - Porcupine handles CHE's own on-device wake word while the app is active.
/// - OpenAI Realtime/WebRTC becomes the only microphone owner after wake.
class CheWakeWordEngine {
  CheWakeWordEngine({
    required this.baseUrl,
    required this.deviceToken,
    required this.onWake,
    this.onStatus,
  });

  final String baseUrl;
  final String deviceToken;
  final CheWakeCallback onWake;
  final CheWakeStatusCallback? onStatus;

  PorcupineManager? _manager;
  bool _running = false;
  bool _starting = false;

  bool get running => _running;

  Future<Map<String, dynamic>?> _fetchConfig() async {
    try {
      final response = await http
          .get(
            Uri.parse('$baseUrl/api/wake/config'),
            headers: {'Authorization': 'Bearer $deviceToken'},
          )
          .timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  Future<bool> start() async {
    if (_running) return true;
    if (_starting) return false;
    _starting = true;

    try {
      final config = await _fetchConfig();
      if (config == null || config['enabled'] != true) {
        onStatus?.call(
          'Porcupine not configured; using CHE native wake fallback.',
        );
        return false;
      }

      final accessKey = config['access_key']?.toString().trim() ?? '';
      final keywordBase64 =
          config['keyword_ppn_base64']?.toString().trim() ?? '';
      final sensitivityValue = config['sensitivity'];
      final sensitivity = sensitivityValue is num
          ? sensitivityValue.toDouble().clamp(0.0, 1.0).toDouble()
          : 0.62;

      if (accessKey.isEmpty || keywordBase64.isEmpty) {
        onStatus?.call('Porcupine wake config is incomplete.');
        return false;
      }

      final keywordBytes = base64Decode(keywordBase64);
      final dir = Directory('\${Directory.systemTemp.path}/che_wake');
      if (!await dir.exists()) await dir.create(recursive: true);
      final keywordFile = File('\${dir.path}/chay_ios.ppn');
      await keywordFile.writeAsBytes(keywordBytes, flush: true);

      final current = _manager;
      if (current != null) {
        try {
          await current.delete();
        } catch (_) {}
      }

      _manager = await PorcupineManager.fromKeywordPaths(
        accessKey,
        [keywordFile.path],
        (_) {
          onStatus?.call('Wake word detected.');
          unawaited(Future<void>.sync(() => onWake()));
        },
        sensitivities: [sensitivity],
        errorCallback: (PorcupineException error) {
          onStatus?.call('Porcupine wake listener error: $error');
        },
      );

      await _manager!.start();
      _running = true;
      onStatus?.call('Porcupine wake listener active.');
      return true;
    } catch (error) {
      onStatus?.call('Porcupine unavailable: $error');
      await stop(disposeManager: true);
      return false;
    } finally {
      _starting = false;
    }
  }

  Future<void> stop({bool disposeManager = false}) async {
    final manager = _manager;
    if (manager == null) {
      _running = false;
      return;
    }

    try {
      if (_running) await manager.stop();
    } catch (_) {}
    _running = false;

    if (disposeManager) {
      try {
        await manager.delete();
      } catch (_) {}
      _manager = null;
    }
  }

  Future<void> dispose() => stop(disposeManager: true);
}
