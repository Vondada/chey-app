// Ava first. Kokoro only if this returns false.

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

class CheEdgeVoice {
  static Future<Uint8List?> speak(String baseUrl, String text) async {
    final said = text.trim();
    if (said.isEmpty || baseUrl.trim().isEmpty) return null;
    try {
      final response = await http
          .post(
            Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}/api/voice/edge'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'text': said, 'voice': 'en-US-AvaNeural'}),
          )
          .timeout(const Duration(seconds: 12));
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) return null;
      final type = response.headers['content-type'] ?? '';
      if (!type.contains('audio') && !type.contains('octet-stream')) return null;
      return response.bodyBytes;
    } catch (_) {
      return null;
    }
  }
}
