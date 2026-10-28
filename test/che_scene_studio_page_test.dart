// Widget test for the Create Studio scene editor (M2c). A fake Worker enforces the same version rule as the real one, so
// each step checks stored data: create from a template, edit a slider, save, close, reopen the same project.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:chey/create/che_scene_client.dart';
import 'package:chey/create/che_scene_studio_page.dart';

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

Future<void> pumpStudio(WidgetTester tester, CheSceneClient client, {String? sceneId}) async {
  await tester.pumpWidget(MaterialApp(home: CheSceneStudioPage(client: client, sceneId: sceneId)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('create a character, edit it, save, close, and reopen the same project', (tester) async {
    final worker = FakeWorker();
    final client = clientFor(worker);

    // 1. Start from the person template: a real character object with the template's height.
    await tester.pumpWidget(MaterialApp(home: CheSceneStudioPage(client: client, template: 'person')));
    await tester.pumpAndSettle();
    expect(find.text('Height (m): 1.70'), findsOneWidget);
    expect(worker.scenes, hasLength(1));
    final sceneId = worker.scenes.keys.single;

    // 2. Edit the height slider through the widget itself.
    tester.widget<Slider>(find.byType(Slider).first).onChanged!(1.9);
    await tester.pump();
    expect(find.text('Height (m): 1.90'), findsOneWidget);
    expect(worker.scenes[sceneId]!['version'], 1, reason: 'an unsaved edit does not reach the Worker');

    // 3. Save: the Worker stores version 2 with the new height.
    await tester.tap(find.byTooltip('Save'));
    await tester.pumpAndSettle();
    expect(worker.scenes[sceneId]!['version'], 2);
    final stored = (worker.scenes[sceneId]!['scene'] as Map)['objects'] as List;
    expect(((stored.first as Map)['properties'] as Map)['height_m'], 1.9);
    expect(find.textContaining('Saved version 2'), findsOneWidget);

    // 4. Close the screen, then reopen the same project from the list: it shows the saved height.
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pumpWidget(MaterialApp(home: CheSceneStudioPage(client: client, sceneId: sceneId)));
    await tester.pumpAndSettle();
    expect(find.text('Height (m): 1.90'), findsOneWidget);
    expect(find.textContaining('Saved version 2'), findsOneWidget);
  });

  testWidgets('undo and redo change the slider and do not save', (tester) async {
    final worker = FakeWorker();
    final client = clientFor(worker);
    await tester.pumpWidget(MaterialApp(home: CheSceneStudioPage(client: client, template: 'person')));
    await tester.pumpAndSettle();

    tester.widget<Slider>(find.byType(Slider).first).onChanged!(1.5);
    await tester.pump();
    await tester.tap(find.byTooltip('Undo'));
    await tester.pump();
    expect(find.text('Height (m): 1.70'), findsOneWidget);
    await tester.tap(find.byTooltip('Redo'));
    await tester.pump();
    expect(find.text('Height (m): 1.50'), findsOneWidget);
    expect(worker.scenes.values.single['version'], 1, reason: 'undo and redo never save');
  });

  testWidgets('a save from an older copy shows the conflict and does not overwrite', (tester) async {
    final worker = FakeWorker();
    final client = clientFor(worker);
    await tester.pumpWidget(MaterialApp(home: CheSceneStudioPage(client: client, template: 'person')));
    await tester.pumpAndSettle();
    final sceneId = worker.scenes.keys.single;

    // Another copy saves first, so this page's version 1 is now stale.
    final other = await client.load(sceneId);
    await client.save(sceneId, other.scene, other.version);

    tester.widget<Slider>(find.byType(Slider).first).onChanged!(0.9);
    await tester.pump();
    await tester.tap(find.byTooltip('Save'));
    await tester.pumpAndSettle();

    expect(find.textContaining('changed somewhere else (version 2)'), findsOneWidget);
    expect(worker.scenes[sceneId]!['version'], 2, reason: 'the stale edit was not written');
  });
}
