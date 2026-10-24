import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:chey/create/che_live_studio.dart' show CheViewportDriver;
import 'package:chey/rooms/che_invention_studio.dart';
import 'package:chey/rooms/che_invention_viewer.dart';

/// Answers like studio.html: a loaded model reports its meshes; a command reports ok and a note.
class _FakePage implements CheViewportDriver {
  _FakePage(this.onMessage);
  final void Function(Map<String, dynamic>) onMessage;
  final loads = <int>[];
  final cmds = <Map<String, Object>>[];

  @override
  Widget build(BuildContext context) => const ColoredBox(color: Color(0xFF101418));

  @override
  Future<void> load(Uint8List glb, String label) async {
    loads.add(glb.length);
    Future.microtask(() => onMessage({'type': 'model', 'meshes': 30, 'label': label}));
  }

  @override
  Future<void> command(Map<String, Object> cmd) async {
    cmds.add(cmd);
    Future.microtask(() => onMessage({'type': 'done', 'action': cmd['action'], 'ok': true, 'note': ''}));
  }

  @override
  Future<void> pause(bool paused) async {}

  @override
  void dispose() {}
}

void main() {
  test('viewer words: rotate, zoom, views and colours; other sentences are not the viewer\'s', () {
    expect(cheInventionViewerIntent('rotate it')!.cmd, {'action': 'rotate', 'deg': 45});
    expect(cheInventionViewerIntent('CHE, rotate it left 90 degrees.')!.cmd, {'action': 'rotate', 'deg': -90});
    expect(cheInventionViewerIntent('zoom in')!.cmd, {'action': 'zoom', 'factor': 1.4});
    expect(cheInventionViewerIntent('show me the back')!.cmd, {'action': 'view', 'deg': 180});
    expect(cheInventionViewerIntent('change the color to blue')!.colour, 'blue');
    expect(cheInventionViewerIntent('make it gold')!.colour, 'gold');
    expect(cheInventionViewerIntent('change the colour')!.say, contains('Nothing was changed'));
    for (final s in ['read my email', 'what time is it', 'show me my trades']) {
      expect(cheInventionViewerIntent(s), isNull, reason: s);
    }
  });

  testWidgets('the viewer loads the saved GLB, rotates on the page\'s own answer, and a colour loads the new saved version', (tester) async {
    final requests = <String>[];
    final client = MockClient((req) async {
      requests.add('${req.method} ${req.url.path}${req.url.query.isEmpty ? '' : '?${req.url.query}'}');
      if (req.url.path.endsWith('/model.glb')) return http.Response.bytes(List.filled(64, 1), 200);
      if (req.url.path.endsWith('/visual')) {
        expect(jsonDecode(req.body), {'action': 'colour', 'colour': 'blue'});
        return http.Response(jsonEncode({'ok': true, 'spoken': 'Changed the main colour to blue. Saved 3D model version 2.', 'model': {'v': 2, 'colour': 'blue'}}), 200);
      }
      return http.Response('{}', 404);
    });
    late _FakePage page;
    await tester.pumpWidget(MaterialApp(
      home: CheInventionViewer(
        baseUrl: 'https://che.example',
        headers: const {'Authorization': 'Bearer t'},
        inventionId: 'inv-8a637dad',
        title: 'Powered suit concept',
        client: client,
        viewport: (on) => page = _FakePage(on),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Powered suit concept: 30 parts in the viewer.'), findsOneWidget);
    expect(CheInventionViewer.voiceHandler, isNotNull);

    final turned = await tester.runAsync(() => CheInventionViewer.voiceHandler!('rotate it left 90 degrees'));
    expect(turned, 'Turned 90 degrees left.');
    expect(page.cmds.last, {'action': 'rotate', 'deg': -90});

    final blue = await tester.runAsync(() => CheInventionViewer.voiceHandler!('change the color to blue'));
    await tester.pumpAndSettle();
    expect(blue, startsWith('Changed the main colour to blue. Saved 3D model version 2.'));
    expect(requests, ['GET /api/inventions/inv-8a637dad/model.glb', 'POST /api/inventions/inv-8a637dad/visual', 'GET /api/inventions/inv-8a637dad/model.glb?v=2']);
    expect(page.loads.length, 2);
    expect(await tester.runAsync(() => CheInventionViewer.voiceHandler!('read my email')), isNull);

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(CheInventionViewer.voiceHandler, isNull, reason: 'leaving the viewer hands voice back');
  });

  testWidgets('a project with no 3D model offers Make 3D model; one with a model offers View in 3D and names its version', (tester) async {
    Map<String, dynamic> record(List<Map<String, dynamic>> models) => {
          'id': 'inv-8a637dad', 'title': 'Powered suit concept', 'concept': {'status': 'generated', 'media_id': 'm1', 'reason': ''},
          'cost': {'tiers': {}}, 'subsystems': [], 'parts': [], 'stages': [], 'tests': [], 'feasibility': {},
          'visuals': {'colour': 'red', 'images': [{'v': 1, 'media_id': 'm1', 'engine': 'che_internal_renderer', 'provenance': 'procedural concept sheet (CHE internal renderer), not a photo or a Blender render'}], 'models': models},
        };
    final actions = <String>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheInventionDetail(project: CheInventionView(record([])), onAction: actions.add))));
    expect(find.bySemanticsLabel('Build a 3D model of this invention and save it'), findsOneWidget);
    expect(find.textContaining('No 3D model yet.'), findsOneWidget);
    expect(find.textContaining('procedural concept sheet'), findsOneWidget);
    await tester.tap(find.text('Make 3D model'));
    expect(actions, ['model']);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheInventionDetail(
      project: CheInventionView(record([{'v': 2, 'colour': 'blue', 'meshes': 30, 'kind': 'procedural 3D concept model (CHE parts geometry), not a Blender build'}])),
      onAction: actions.add,
    ))));
    expect(find.textContaining('3D model version 2 (blue, 30 parts)'), findsOneWidget);
    await tester.tap(find.text('View in 3D'));
    expect(actions.last, 'view3d');
  });
}
