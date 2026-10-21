import 'dart:convert';

import 'package:http/http.dart' as http;

// CHE's Soul, as the Worker keeps it (server/cloudflare/soul.js). The phone shows and edits it through
// /api/soul; the Worker decides what the model receives. Nothing here is a second source of personality.

class CheSoulTrait {
  const CheSoulTrait(this.key, this.label, this.hint, this.defaultValue);
  final String key;
  final String label;
  final String hint;
  final int defaultValue;
}

/// The six traits, in the order the owner sees them. Defaults match soul.js.
const kCheSoulTraits = [
  CheSoulTrait('warmth', 'Warmth', 'How personal and caring she sounds', 7),
  CheSoulTrait('playfulness', 'Playfulness', 'Light humour in relaxed talk, never about money or problems', 4),
  CheSoulTrait('formality', 'Formality', 'From casual wording to formal wording', 5),
  CheSoulTrait('directness', 'Directness', 'From offering options to a clear recommendation first', 7),
  CheSoulTrait('verbosity', 'Detail', 'From one to three sentences to thorough explanations', 3),
  CheSoulTrait('proactivity', 'Initiative', 'From answering only what was asked to offering next steps', 5),
];

Map<String, int> cheSoulDefaultTraits() => {for (final t in kCheSoulTraits) t.key: t.defaultValue};

class CheSoulVersion {
  const CheSoulVersion({required this.version, required this.hash, required this.savedAt, required this.reason, required this.traits});

  final int version;
  final String hash;
  final String savedAt;
  final String reason;
  final Map<String, int> traits;

  factory CheSoulVersion.fromJson(Map<String, dynamic> json) => CheSoulVersion(
        version: (json['version'] as num?)?.toInt() ?? 0,
        hash: '${json['hash'] ?? ''}',
        savedAt: '${json['saved_at'] ?? ''}',
        reason: '${json['reason'] ?? ''}',
        traits: _traitsFrom(json['traits']),
      );
}

class CheSoulProfile {
  const CheSoulProfile({
    required this.version,
    required this.hash,
    required this.traits,
    required this.text,
    required this.isDefault,
    required this.history,
  });

  final int version;
  final String hash;
  final Map<String, int> traits;
  final String text;
  final bool isDefault;
  final List<CheSoulVersion> history;

  factory CheSoulProfile.fromJson(Map<String, dynamic> json) => CheSoulProfile(
        version: (json['version'] as num?)?.toInt() ?? 0,
        hash: '${json['hash'] ?? ''}',
        traits: _traitsFrom(json['traits']),
        text: '${json['text'] ?? ''}',
        isDefault: json['default'] == true,
        history: [
          for (final entry in (json['history'] as List? ?? const []))
            if (entry is Map) CheSoulVersion.fromJson(Map<String, dynamic>.from(entry)),
        ],
      );
}

Map<String, int> _traitsFrom(Object? raw) {
  final out = <String, int>{};
  if (raw is Map) {
    for (final t in kCheSoulTraits) {
      final value = raw[t.key];
      if (value is num) out[t.key] = value.round();
    }
  }
  return out.length == kCheSoulTraits.length ? out : {...cheSoulDefaultTraits(), ...out};
}

class CheSoulException implements Exception {
  CheSoulException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Talks to the Worker's Soul routes. The app root registers the base URL and the device-token headers once.
class CheSoulClient {
  CheSoulClient._();

  static String Function()? _baseUrl;
  static Map<String, String> Function()? _headers;

  /// The HTTP client; tests replace it with a fake.
  static http.Client httpClient = http.Client();

  static void configure({required String Function() baseUrl, required Map<String, String> Function() headers}) {
    _baseUrl = baseUrl;
    _headers = headers;
  }

  static Future<CheSoulProfile> load() => _send('GET', '/api/soul');

  static Future<CheSoulProfile> save({required Map<String, int> traits, required String text}) =>
      _send('POST', '/api/soul', {'traits': traits, 'text': text, 'reason': 'owner change on phone'});

  static Future<CheSoulProfile> restore(int version) => _send('POST', '/api/soul/restore', {'version': version});

  static Future<CheSoulProfile> _send(String method, String path, [Map<String, Object?>? body]) async {
    final base = _baseUrl;
    final headers = _headers;
    if (base == null || headers == null) {
      throw CheSoulException('CHE is not connected yet, so the Soul cannot be read. Nothing was changed.');
    }
    try {
      final request = http.Request(method, Uri.parse('${base()}$path'))..headers.addAll(headers());
      if (body != null) request.body = jsonEncode(body);
      final response = await http.Response.fromStream(await httpClient.send(request).timeout(const Duration(seconds: 20)));
      final decoded = jsonDecode(response.body);
      if (response.statusCode != 200 || decoded is! Map<String, dynamic>) {
        final detail = decoded is Map ? '${decoded['detail'] ?? ''}' : '';
        throw CheSoulException(detail.isNotEmpty ? detail : 'The Soul could not be reached (status ${response.statusCode}). Nothing was changed.');
      }
      return CheSoulProfile.fromJson(decoded);
    } on CheSoulException {
      rethrow;
    } catch (_) {
      throw CheSoulException('The Soul could not be reached. Nothing was changed.');
    }
  }
}
