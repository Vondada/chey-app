// Edge Ava is the voice. Kokoro speaks only when this returns null.

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class CheEdgeVoice {
  static const voice = 'en-US-AvaNeural';

  static Future<Uint8List?> speak(String text) async {
    final said = text.trim();
    if (said.isEmpty) return null;
    final prefs = await SharedPreferences.getInstance();
    final base = prefs.getString('che.server') ?? prefs.getString('che.worker') ?? '';
    if (base.trim().isEmpty) return null;
    try {
      final response = await http
          .post(
            Uri.parse('${base.replaceAll(RegExp(r'/+$'), '')}/api/voice/edge'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'text': said, 'voice': voice}),
          )
          .timeout(const Duration(seconds: 12));
      final type = response.headers['content-type'] ?? '';
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) return null;
      if (!type.contains('audio') && !type.contains('octet-stream')) return null;
      return response.bodyBytes;
    } catch (_) {
      return null;
    }
  }
}
