// App call for a faceless video. Returns a file URL or the real error.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class CheVideo {
  static Future<String> make(String topic) async {
    final subject = topic.trim();
    if (subject.length < 3) return 'Name the video.';
    final prefs = await SharedPreferences.getInstance();
    final base = prefs.getString('che.server') ?? prefs.getString('che.worker') ?? '';
    if (base.trim().isEmpty) return 'The app has no server address.';
    try {
      final response = await http
          .post(
            Uri.parse('${base.replaceAll(RegExp(r'/+$'), '')}/api/video/line'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'topic': subject}),
          )
          .timeout(const Duration(seconds: 30));
      final data = jsonDecode(response.body.isEmpty ? '{}' : response.body);
      final url = data is Map ? data['media_url']?.toString() : null;
      if (url != null && url.startsWith('http')) return url;
      final error = data is Map ? data['error']?.toString() : null;
      return error ?? 'No video was made.';
    } catch (_) {
      return 'The video server did not respond.';
    }
  }
}
