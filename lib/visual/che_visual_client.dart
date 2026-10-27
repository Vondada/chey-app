// Visual Studio's connection to the Worker (/api/visual). Every edit is a real operation on the project's
// stored edit document; a failure comes back as CHE's own reason, never as a success.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class CheVisualException implements Exception {
  const CheVisualException(this.message);
  final String message;
  @override
  String toString() => message;
}

class CheVisualClient {
  CheVisualClient({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _http;

  String mediaUrl(String id, {bool video = false}) => '${baseUrl()}/api/media/$id/${video ? 'video' : 'image'}';

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() call, {Duration timeout = const Duration(seconds: 45)}) async {
    if (baseUrl().isEmpty) throw const CheVisualException('CHE is not connected on this iPhone yet.');
    http.Response r;
    try {
      r = await call().timeout(timeout);
    } on TimeoutException {
      throw const CheVisualException('CHE did not answer in time. Nothing was changed on the phone.');
    } on Exception catch (e) {
      throw CheVisualException('The connection failed ($e).');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw CheVisualException('${map['detail'] ?? 'CHE answered ${r.statusCode}.'}');
    return map;
  }

  /// The owner's media library (photos, videos, audio, renders), newest first.
  Future<List<Map<String, dynamic>>> mediaList() async {
    final r = await _send(() => _http.get(Uri.parse('${baseUrl()}/api/media'), headers: headers()));
    return [for (final i in (r['items'] as List? ?? const [])) Map<String, dynamic>.from(i as Map)];
  }

  Future<Map<String, dynamic>> catalog() => _send(() => _http.get(Uri.parse('${baseUrl()}/api/visual'), headers: headers()));

  Future<Map<String, dynamic>> project(String id) =>
      _send(() => _http.get(Uri.parse('${baseUrl()}/api/visual?project_id=${Uri.encodeQueryComponent(id)}'), headers: headers()));

  Future<Map<String, dynamic>> post(Map<String, dynamic> body, {Duration timeout = const Duration(seconds: 45)}) => _send(
        () => _http.post(Uri.parse('${baseUrl()}/api/visual'), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body)),
        timeout: timeout,
      );

  Future<Map<String, dynamic>> op(String projectId, Map<String, dynamic> op) => post({'action': 'op', 'project_id': projectId, 'op': op});
  Future<Map<String, dynamic>> words(String projectId, String text, {String? selection, double playhead = 0}) =>
      post({'action': 'words', 'project_id': projectId, 'text': text, 'selection': selection, 'playhead': playhead});
}
