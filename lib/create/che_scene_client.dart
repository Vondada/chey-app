// CHE scene client (M2b, owner 2026-10-28): talks to the Worker's /api/scenes routes. The Worker decides; the phone shows
// what it says. A save from an out-of-date copy comes back as a conflict with the stored scene, never a silent overwrite.

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'che_scene_document.dart';

class SceneConflict implements Exception {
  SceneConflict(this.storedVersion, this.stored);
  final int storedVersion;
  final SceneDocument stored;
  @override
  String toString() => 'This scene was changed somewhere else. Reload it before saving.';
}

class SceneRequestFailed implements Exception {
  SceneRequestFailed(this.status, this.detail);
  final int status;
  final String detail;
  @override
  String toString() => detail;
}

class SceneSummary {
  const SceneSummary({required this.id, required this.name, required this.version, required this.objects});
  final String id;
  final String name;
  final int version;
  final int objects;

  static SceneSummary fromJson(Map<String, dynamic> m) => SceneSummary(
        id: m['id'] as String? ?? '',
        name: m['name'] as String? ?? '',
        version: (m['version'] as num?)?.toInt() ?? 0,
        objects: (m['objects'] as num?)?.toInt() ?? 0,
      );
}

class LoadedScene {
  const LoadedScene(this.version, this.scene);
  final int version;
  final SceneDocument scene;
}

class CheSceneClient {
  CheSceneClient({required this.baseUrl, required this.headers, http.Client? client}) : _http = client ?? http.Client();

  final String baseUrl;
  final Map<String, String> headers;
  final http.Client _http;

  Map<String, dynamic> _decode(http.Response r) {
    final body = r.body.isEmpty ? <String, dynamic>{} : jsonDecode(r.body) as Map<String, dynamic>;
    return body;
  }

  Future<List<SceneSummary>> list() async {
    final r = await _http.get(Uri.parse('$baseUrl/api/scenes'), headers: headers);
    final body = _decode(r);
    if (r.statusCode != 200) throw SceneRequestFailed(r.statusCode, body['detail'] as String? ?? 'Could not list scenes.');
    return [for (final s in (body['scenes'] as List? ?? const [])) SceneSummary.fromJson(Map<String, dynamic>.from(s as Map))];
  }

  Future<LoadedScene> load(String id) async {
    final r = await _http.get(Uri.parse('$baseUrl/api/scenes/$id'), headers: headers);
    final body = _decode(r);
    if (r.statusCode != 200) throw SceneRequestFailed(r.statusCode, body['detail'] as String? ?? 'Could not load the scene.');
    return LoadedScene((body['version'] as num).toInt(), SceneDocument.fromJson(Map<String, dynamic>.from(body['scene'] as Map)));
  }

  Future<LoadedScene> create({required String name, required String template}) async {
    final r = await _http.post(
      Uri.parse('$baseUrl/api/scenes'),
      headers: {...headers, 'Content-Type': 'application/json'},
      body: jsonEncode({'name': name, 'template': template}),
    );
    final body = _decode(r);
    if (r.statusCode != 201) throw SceneRequestFailed(r.statusCode, body['detail'] as String? ?? 'Could not create the scene.');
    return LoadedScene((body['version'] as num).toInt(), SceneDocument.fromJson(Map<String, dynamic>.from(body['scene'] as Map)));
  }

  /// Saves the editor's present scene at the version it was loaded at. A stale version throws [SceneConflict].
  Future<LoadedScene> save(String id, SceneDocument scene, int expectedVersion) async {
    final r = await _http.put(
      Uri.parse('$baseUrl/api/scenes/$id'),
      headers: {...headers, 'Content-Type': 'application/json'},
      body: jsonEncode({'scene': scene.toJson(), 'expected_version': expectedVersion}),
    );
    final body = _decode(r);
    if (r.statusCode == 409 && body['scene'] is Map) {
      throw SceneConflict(
        (body['version'] as num).toInt(),
        SceneDocument.fromJson(Map<String, dynamic>.from(body['scene'] as Map)),
      );
    }
    if (r.statusCode != 200) throw SceneRequestFailed(r.statusCode, body['detail'] as String? ?? 'Could not save the scene.');
    return LoadedScene((body['version'] as num).toInt(), SceneDocument.fromJson(Map<String, dynamic>.from(body['scene'] as Map)));
  }

  void close() => _http.close();
}
