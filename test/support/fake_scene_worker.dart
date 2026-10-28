// Shared fake of the Worker's scene routes (same version rule as server/cloudflare/scene_store.js), for widget tests.
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:chey/create/che_scene_client.dart';

/// Stands in for the Worker: same routes, same version check as server/cloudflare/scene_store.js.
class FakeWorker {
  final Map<String, Map<String, dynamic>> scenes = {};
  int _next = 1;

  http.Response handle(http.Request req) {
    final path = req.url.path;
    if (req.method == 'POST' && path == '/api/scenes') {
      final id = 'scene_${(_next++).toString().padLeft(12, '0')}';
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final scene = {
        'schema': 1,
        'id': id,
        'name': body['name'],
        'objects': [
          {
            'id': 'character_adult',
            'kind': 'character',
            'name': 'Adult',
            'asset_ref': 'adult_preset',
            'transform': {'position': {'x': 0, 'y': 0, 'z': 0}, 'rotation': {'x': 0, 'y': 0, 'z': 0}, 'scale': {'x': 1, 'y': 1, 'z': 1}},
            'properties': {'height_m': 1.7, 'pore_detail': 0.2},
            'hidden': false,
          },
        ],
      };
      scenes[id] = {'version': 1, 'scene': scene};
      return http.Response(jsonEncode({'ok': true, 'version': 1, 'scene': scene}), 201);
    }
    if (req.method == 'GET' && path == '/api/scenes') {
      final list = [
        for (final e in scenes.entries)
          {
            'id': e.key,
            'name': (e.value['scene'] as Map)['name'],
            'version': e.value['version'],
            'objects': ((e.value['scene'] as Map)['objects'] as List).length,
          },
      ];
      return http.Response(jsonEncode({'ok': true, 'scenes': list.reversed.toList()}), 200);
    }
    final m = RegExp(r'^/api/scenes/(scene_[0-9a-f]+)$').firstMatch(path);
    if (m != null && req.method == 'GET') {
      final rec = scenes[m.group(1)];
      if (rec == null) return http.Response(jsonEncode({'ok': false, 'detail': 'No scene.'}), 404);
      return http.Response(jsonEncode({'ok': true, 'version': rec['version'], 'scene': rec['scene']}), 200);
    }
    if (m != null && req.method == 'PUT') {
      final id = m.group(1)!;
      final rec = scenes[id]!;
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      if (body['expected_version'] != rec['version']) {
        return http.Response(jsonEncode({'ok': false, 'version': rec['version'], 'scene': rec['scene']}), 409);
      }
      final next = {'version': (rec['version'] as int) + 1, 'scene': body['scene']};
      scenes[id] = next;
      return http.Response(jsonEncode({'ok': true, 'version': next['version'], 'scene': next['scene']}), 200);
    }
    return http.Response(jsonEncode({'detail': 'Unknown route.'}), 404);
  }
}

CheSceneClient clientFor(FakeWorker w) => CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {},
      client: MockClient((req) async => w.handle(req)),
    );
