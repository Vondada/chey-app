// Tests for lib/create/che_scene_client.dart (M2b). A mock HTTP client plays the Worker, so each test checks real requests.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:chey/create/che_scene_client.dart';
import 'package:chey/create/che_scene_document.dart';

const _empty = {'schema': 1, 'id': 'scene_aaaaaaaaaaaa', 'name': 'Office', 'objects': []};

void main() {
  test('create posts the name and template and reads back version 1', () async {
    late http.Request seen;
    final client = CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {'X-Owner': 'token'},
      client: MockClient((req) async {
        seen = req;
        return http.Response(jsonEncode({'ok': true, 'version': 1, 'scene': _empty}), 201);
      }),
    );
    final loaded = await client.create(name: 'Office', template: 'blank');
    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/scenes');
    expect(jsonDecode(seen.body), {'name': 'Office', 'template': 'blank'});
    expect(seen.headers['X-Owner'], 'token');
    expect(loaded.version, 1);
    expect(loaded.scene.name, 'Office');
  });

  test('save sends the scene and the version it was loaded at', () async {
    late http.Request seen;
    final client = CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {},
      client: MockClient((req) async {
        seen = req;
        return http.Response(jsonEncode({'ok': true, 'version': 2, 'scene': _empty}), 200);
      }),
    );
    final out = await client.save('scene_aaaaaaaaaaaa', SceneDocument.fromJson(_empty), 1);
    final body = jsonDecode(seen.body) as Map<String, dynamic>;
    expect(seen.method, 'PUT');
    expect(body['expected_version'], 1);
    expect(out.version, 2);
  });

  test('a stale save comes back as a conflict carrying the stored scene, not an error that loses it', () async {
    final client = CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {},
      client: MockClient((req) async => http.Response(jsonEncode({'ok': false, 'version': 4, 'scene': _empty}), 409)),
    );
    expect(
      () => client.save('scene_aaaaaaaaaaaa', SceneDocument.fromJson(_empty), 1),
      throwsA(isA<SceneConflict>().having((c) => c.storedVersion, 'storedVersion', 4)),
    );
  });

  test('a refused save shows the Worker reason', () async {
    final client = CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {},
      client: MockClient((req) async => http.Response(jsonEncode({'ok': false, 'detail': 'Scene is broken.'}), 422)),
    );
    expect(
      () => client.save('scene_aaaaaaaaaaaa', SceneDocument.fromJson(_empty), 1),
      throwsA(isA<SceneRequestFailed>().having((e) => e.detail, 'detail', 'Scene is broken.')),
    );
  });

  test('list reads the summaries in the order the Worker sends them', () async {
    final client = CheSceneClient(
      baseUrl: 'https://worker.example',
      headers: () => const {},
      client: MockClient((req) async => http.Response(
            jsonEncode({
              'ok': true,
              'scenes': [
                {'id': 'scene_bbbbbbbbbbbb', 'name': 'Newer', 'version': 3, 'objects': 2},
                {'id': 'scene_aaaaaaaaaaaa', 'name': 'Older', 'version': 1, 'objects': 0},
              ],
            }),
            200,
          )),
    );
    final list = await client.list();
    expect(list.map((s) => s.name).toList(), ['Newer', 'Older']);
    expect(list.first.objects, 2);
  });
}
