import 'package:flutter/services.dart';

/// Zero-metered iPhone fallback for CHE chat.
///
/// Uses Apple's on-device Foundation Models framework when it is available.
/// The cloud agent remains primary because it has CHE's tools and memory, but a
/// Cloudflare quota outage no longer has to turn into a visible 503.
class CheLocalAI {
  static const MethodChannel _channel = MethodChannel('che/local_ai');

  static Future<String?> respond(
    String prompt, {
    List<Map<String, String>> history = const [],
  }) async {
    final clean = prompt.trim();
    if (clean.isEmpty) return null;
    try {
      final value = await _channel.invokeMethod<String>('respond', {
        'prompt': clean,
        'history': history.take(8).toList(growable: false),
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
