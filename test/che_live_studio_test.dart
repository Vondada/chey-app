// Live Studio (lib/create/che_live_studio.dart): one creation project in a 3D viewport, with the Creation Engine job's
// real stages, preview pictures, edits, versions, undo, redo, save and voice routes. The Worker is a MockClient that
// answers like creation_studio.js; the viewport is a fake that records what the page would be told. Test data only.
//
// CHE_STUDIO_SHOTS=<dir> flutter test test/che_live_studio_test.dart also writes iPhone-size screenshots of the page.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/create/che_live_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _FakeViewport implements CheViewportDriver {
  _FakeViewport(this.onMessage, {this.clips = const [], this.unsupported = const {}, this.morphs = const []});
  final void Function(Map<String, dynamic>) onMessage;
  final List<String> clips;

  /// The model's shape keys; like studio.html, lip sync is refused without mouth_open.
  final List<String> morphs;
  String? get _mouth => morphs.contains('mouth_open') ? 'mouth_open' : null;

  /// Actions this fake page answers with ok: false, like studio.html's "Unknown viewport command."
  final Set<String> unsupported;
  final loads = <String>[];
  final bytes = <int>[];
  final cmds = <Map<String, Object>>[];

  @override
  Widget build(BuildContext context) => const ColoredBox(color: Color(0xFF101418), child: Center(child: Text('viewport')));

  @override
  Future<void> load(Uint8List glb, String label) async {
    loads.add(label);
    bytes.add(glb.length);
    onMessage({'type': 'model', 'label': label, 'meshes': 4, 'vertices': 30904, 'triangles': 51000, 'clips': clips, 'morphs': morphs, 'mouth_morph': _mouth});
  }

  @override
  Future<void> command(Map<String, Object> cmd) async {
    cmds.add(cmd);
    if (unsupported.contains(cmd['action'])) {
      onMessage({'type': 'done', 'action': cmd['action'], 'ok': false, 'note': 'Unknown viewport command.', 'playing': null});
      return;
    }
    if (cmd['action'] == 'lipsync' && _mouth == null) {
      onMessage({'type': 'done', 'action': 'lipsync', 'ok': false, 'note': 'This model has no mouth_open shape key, so its mouth cannot move.', 'playing': null, 'mouth_morph': null});
      return;
    }
    if (cmd['action'] == 'lipsync') {
      onMessage({'type': 'done', 'action': 'lipsync', 'ok': true, 'note': 'Lip sync on the mouth_open shape key.', 'playing': null, 'mouth_morph': _mouth});
      return;
    }
    onMessage({'type': 'done', 'action': cmd['action'], 'ok': true, 'playing': cmd['action'] == 'animate' ? cmd['clip'] : null});
  }

  @override
  Future<void> pause(bool paused) async {}

  @override
  void dispose() {}
}

// A GLB header (magic, version 2, length) and padding: what the Worker serves at the model URL.
final _glb = Uint8List.fromList([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 32, 0, 0, 0, ...List.filled(20, 0)]);

Map<String, dynamic> _job({bool model = true, String state = 'rendering'}) => {
      'id': 'gpu_abc',
      'kind': 'person_model',
      'state': state,
      'progress': {'message': 'Rendering on OPTIX: Tesla T4', 'pct': 33, 'views_done': [0]},
      'previews': {'0': 'm_front'},
      'receipt': {'nvidia_smi': 'Tesla T4, 550.54, 15360 MiB'},
      'model': model ? {'bytes': 1463972, 'sha256': 'aa11', 'uploaded_at': '2026-10-24T18:02:10Z', 'url': '/api/gpu/jobs/gpu_abc/model.glb'} : null,
    };

Map<String, dynamic> _project({Map<String, dynamic>? job, int version = 1, int count = 1, String engine = 'offline'}) => {
      'id': 'cr_1',
      'kind': 'person',
      'title': 'CHE (new person)',
      'base_id': 'che',
      'version': version,
      'versions': [for (var i = 1; i <= count; i++) {'n': i}],
      'versions_count': count,
      'can_undo': version > 1,
      'can_redo': version < count,
      'saved_at': null,
      'job': job,
      'stages': job == null
          ? []
          : [
              {'at': '2026-10-24T18:00:00Z', 'label': 'Queued', 'state': 'queued'},
              {'at': '2026-10-24T18:01:00Z', 'label': 'Started on the GPU', 'state': 'rendering'},
              {'at': '2026-10-24T18:02:10Z', 'label': 'Geometry ready', 'state': 'rendering'},
              {'at': '2026-10-24T18:03:00Z', 'label': 'Preview front arrived', 'state': 'rendering'},
            ],
      'engine': {
        'status': engine,
        'online': engine == 'online',
        'paired': engine != 'not_paired',
        'gpu': engine == 'online' ? 'Tesla T4' : null,
        if (engine == 'cloud') ...{'automatic': true, 'workers_online': 0, 'max_concurrent': 3},
      },
    };

class _Worker {
  _Worker(this.project);
  Map<String, dynamic> project;
  final posts = <String>[];
  final bodies = <Map<String, dynamic>>[];
  int modelGets = 0;

  http.Client client() => MockClient((r) async {
        final p = r.url.path;
        if (r.method == 'GET' && p == '/api/creations/cr_1') return http.Response(jsonEncode({'ok': true, 'project': project}), 200);
        if (r.method == 'GET' && p.endsWith('/model.glb')) {
          modelGets += 1;
          return http.Response.bytes(_glb, 200, headers: {'content-type': 'model/gltf-binary'});
        }
        if (r.method == 'POST') {
          posts.add(p);
          final body = r.body.isEmpty ? <String, dynamic>{} : Map<String, dynamic>.from(jsonDecode(r.body) as Map);
          bodies.add(body);
          if (p.endsWith('/edit')) {
            final t = '${body['text']}'.toLowerCase();
            if (t.contains('skeleton')) {
              return http.Response(jsonEncode({'ok': true, 'changed': false, 'applied': [], 'unsupported': [],
                'viewport': {'action': 'skeleton', 'on': true}, 'spoken': 'Showing the skeleton.', 'project': project}), 200);
            }
            if (t.contains('office')) {
              return http.Response(jsonEncode({'ok': true, 'changed': false, 'applied': [], 'unsupported': ['Putting creations in the Office is not built yet.'],
                'viewport': null, 'spoken': 'Putting creations in the Office is not built yet.', 'project': project}), 200);
            }
            project = _project(job: null, version: 2, count: 2);
            return http.Response(jsonEncode({'ok': true, 'changed': true, 'applied': ['Hair changed to long wavy.'], 'unsupported': [],
              'viewport': null, 'spoken': 'Hair changed to long wavy. Saved as version 2. Say generate to build it.', 'project': project}), 200);
          }
          if (p.endsWith('/undo')) {
            project = _project(job: null, version: 1, count: 2);
            return http.Response(jsonEncode({'ok': true, 'spoken': 'Back to version 1 of 2.', 'project': project}), 200);
          }
          if (p.endsWith('/generate')) {
            project = _project(job: _job(model: false, state: 'queued'), version: project['version'] as int, count: project['versions_count'] as int);
            return http.Response(jsonEncode({'ok': true, 'spoken': 'Queued. It builds when your Creation Engine is online.', 'project': project}), 202);
          }
          if (p.endsWith('/save')) return http.Response(jsonEncode({'ok': true, 'spoken': 'Saved version 1.', 'project': project}), 200);
        }
        return http.Response('{"detail":"not found"}', 404);
      });
}

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

void main() {
  final shots = Platform.environment['CHE_STUDIO_SHOTS'] ?? '';
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
  });

  Widget studio(_Worker w, {List<String>? read, List<String>? spoken, List<_FakeViewport>? vp, List<String> clips = const [], CheLiveStudioMode mode = CheLiveStudioMode.person, Set<String> unsupported = const {}, List<String> morphs = const []}) =>
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(brightness: Brightness.dark, fontFamily: 'Roboto'),
        home: CheLiveStudio(
          baseUrl: 'https://che.test',
          headers: const {},
          projectId: mode == CheLiveStudioMode.person ? 'cr_1' : null,
          mode: mode,
          client: w.client(),
          onRead: read?.add,
          onSpeak: spoken?.add,
          viewport: (onMessage) {
            final v = _FakeViewport(onMessage, clips: clips, unsupported: unsupported, morphs: morphs);
            vp?.add(v);
            return v;
          },
          loadBundled: (id) async => Uint8List.fromList([1, 2, 3, id.length]),
        ),
      );

  test('viewport words become viewport commands; other words are not', () {
    expect(cheViewportCommand('rotate the model'), {'action': 'rotate', 'deg': 45});
    expect(cheViewportCommand('Rotate the model left.'), {'action': 'rotate', 'deg': -45});
    expect(cheViewportCommand('turn it around'), {'action': 'rotate', 'deg': 180});
    expect(cheViewportCommand('rotate right 90 degrees'), {'action': 'rotate', 'deg': 90});
    expect(cheViewportCommand('zoom in'), {'action': 'zoom', 'factor': 1.4});
    expect(cheViewportCommand('side view'), {'action': 'view', 'deg': 90});
    expect(cheViewportCommand('reset the view'), {'action': 'reset'});
    expect(cheViewportCommand('make the hair longer'), isNull);
    expect(cheLooksLikeEdit('make the hair longer'), isTrue);
    expect(cheLooksLikeEdit('Put this in my Office'), isTrue);
    expect(cheLooksLikeEdit('what is the weather in Chicago'), isFalse);
  });

  testWidgets('opens silently on the bundled base model, labelled as not the owner\'s edits; engine offline offers Connect', (tester) async {
    await _phone(tester);
    final read = <String>[];
    final vp = <_FakeViewport>[];
    await tester.pumpWidget(studio(_Worker(_project()), read: read, vp: vp));
    await tester.pumpAndSettle();
    expect(read, isEmpty, reason: 'nothing spoken on open');
    expect(vp.single.loads.single, startsWith('Bundled stylised model of CHE: not your edits.'));
    expect(find.text('Creation Engine Offline'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-connect')), findsOneWidget);
    expect(find.text('Version 1 of 1'), findsOneWidget);
    expect(find.text('Nothing generated for this version yet.'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('live-read')));
    expect(read.single, contains('CHE (new person), version 1 of 1. Creation Engine Offline.'));
    expect(read.single, contains('No model has been generated for this version yet.'));
  });

  testWidgets('with free cloud workers the engine is Ready and asks nothing; the job shows its owner-facing state', (tester) async {
    await _phone(tester);
    final read = <String>[];
    final job = {
      ..._job(model: false, state: 'queued'),
      'display_state': 'Starting a cloud worker',
      'status_line': 'CHE started a free cloud worker 20 seconds ago; it builds on the CPU.',
    };
    await tester.pumpWidget(studio(_Worker(_project(job: job, engine: 'cloud')), read: read));
    await tester.pumpAndSettle();
    expect(read, isEmpty, reason: 'nothing spoken on open');
    expect(find.text('Creation Engine Ready'), findsOneWidget);
    expect(find.textContaining('CHE starts free cloud workers herself'), findsOneWidget);
    expect(find.textContaining('Up to 3 jobs at once'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-connect')), findsNothing, reason: 'nothing for the owner to start');
    expect(find.text('Starting a cloud worker'), findsOneWidget);
    expect(find.text('CHE started a free cloud worker 20 seconds ago; it builds on the CPU.'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('live-read')));
    expect(read.single, contains('Creation Engine Ready.'));
    expect(read.single, contains('Creation Engine job: Starting a cloud worker. CHE started a free cloud worker'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a viewport change is reported only after the viewport confirms it; a refusal is spoken as a failure (review of #521)', (tester) async {
    await _phone(tester);
    for (final refuse in [false, true]) {
      final spoken = <String>[];
      final vp = <_FakeViewport>[];
      await tester.pumpWidget(studio(_Worker(_project(job: _job(), engine: 'online')), spoken: spoken, vp: vp, unsupported: refuse ? {'skeleton'} : {}));
      await tester.pumpAndSettle();
      final state = tester.state<CheLiveStudioState>(find.byType(CheLiveStudio));
      final said = await state.applyEdit('show the skeleton');
      await tester.pumpAndSettle();
      expect(vp.single.cmds.last, {'action': 'skeleton', 'on': true});
      if (refuse) {
        expect(said, 'That did not work: Unknown viewport command.');
        expect(spoken.single, 'That did not work: Unknown viewport command.');
        expect(spoken.any((s) => s.contains('Showing the skeleton')), isFalse);
      } else {
        expect(said, 'Showing the skeleton.');
        expect(spoken.single, 'Showing the skeleton.');
      }
      await tester.pumpWidget(const SizedBox());
    }
  });

  test('job states read as Creating, Waiting for Resources, Paused, Completed', () {
    expect(cheJobDisplayState({'state': 'rendering'}), 'Creating');
    expect(cheJobDisplayState({'state': 'queued'}), 'Waiting for Resources');
    expect(cheJobDisplayState({'state': 'paused'}), 'Paused');
    expect(cheJobDisplayState({'state': 'completed'}), 'Completed');
    expect(cheJobDisplayState({'state': 'queued', 'display_state': 'Starting a cloud worker'}), 'Starting a cloud worker');
    expect(cheJobDisplayState(null), '');
  });

  testWidgets('a delivered GLB replaces the bundled model; stages, timestamps and the preview picture are the job\'s own', (tester) async {
    await _phone(tester);
    final handle = tester.ensureSemantics();
    final vp = <_FakeViewport>[];
    final w = _Worker(_project(job: _job(), engine: 'online'));
    await tester.pumpWidget(studio(w, vp: vp));
    await tester.pumpAndSettle();
    expect(w.modelGets, 1);
    expect(vp.single.bytes.single, _glb.length);
    expect(vp.single.loads.single, contains('exported by Blender on Tesla T4'));
    expect(find.text('Creation Engine Online'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-connect')), findsNothing);
    expect(find.text('Rendering on OPTIX: Tesla T4'), findsOneWidget);
    for (final s in ['Queued', 'Started on the GPU', 'Geometry ready', 'Preview front arrived']) {
      expect(find.text(s), findsOneWidget, reason: s);
    }
    expect(find.text('30904 vertices, 51000 triangles, 4 parts.'), findsOneWidget);
    expect(find.textContaining('3D model file: 1430 KB GLB'), findsOneWidget);
    expect(find.bySemanticsLabel('Front preview render from the Creation Engine'), findsOneWidget);
    // The same model is not downloaded again on the next poll.
    await tester.pump(const Duration(seconds: 7));
    await tester.pumpAndSettle();
    expect(w.modelGets, 1);
    await tester.pumpWidget(const SizedBox());
    handle.dispose();
  });

  testWidgets('typed edit makes a new version; undo and generate go to the Worker; results show in the banner', (tester) async {
    await _phone(tester);
    final w = _Worker(_project());
    await tester.pumpWidget(studio(w));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('live-apply')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('live-edit')), 'Make the hair longer');
    await tester.tap(find.byKey(const ValueKey('live-apply')));
    await tester.pumpAndSettle();
    expect(w.posts.last, '/api/creations/cr_1/edit');
    expect(w.bodies.last, {'text': 'Make the hair longer'});
    expect(find.text('Hair changed to long wavy. Saved as version 2. Say generate to build it.'), findsOneWidget);
    expect(find.text('Version 2 of 2'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('live-Undo')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('live-Undo')));
    await tester.pumpAndSettle();
    expect(w.posts.last, '/api/creations/cr_1/undo');
    expect(find.text('Version 1 of 2'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('live-generate')));
    await tester.tap(find.byKey(const ValueKey('live-generate')));
    await tester.pumpAndSettle();
    expect(w.posts.last, '/api/creations/cr_1/generate');
    expect(find.text('Queued. It builds when your Creation Engine is online.'), findsOneWidget);
    expect(find.text('Model in progress'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('voice: viewport moves, edits, unsupported requests answered plainly, chat left alone', (tester) async {
    await _phone(tester);
    final vp = <_FakeViewport>[];
    final w = _Worker(_project());
    await tester.pumpWidget(studio(w, vp: vp, clips: const ['idle', 'wave']));
    await tester.pumpAndSettle();
    final voice = CheLiveStudio.voiceHandler!;
    expect(await voice('what is the weather in Chicago'), isNull, reason: 'not for the studio: goes to Chat');
    expect(await voice('rotate the model left'), 'Turned the model left 45 degrees.');
    expect(vp.single.cmds.last, {'action': 'rotate', 'deg': -45});
    expect(await voice('zoom in'), 'Zoomed in.');
    expect(await voice('animate the character'), 'Playing the idle animation on the bundled model.');
    expect(vp.single.cmds.last, {'action': 'animate', 'clip': 'idle'});
    expect(await voice('make the hair longer'), 'Hair changed to long wavy. Saved as version 2. Say generate to build it.');
    expect(w.posts.last, '/api/creations/cr_1/edit');
    expect(await voice('Put this in my Office'), 'Putting creations in the Office is not built yet.');
    expect(await voice('undo'), 'Back to version 1 of 2.');
    expect(await voice('save it'), 'Saved version 1.');
    expect(await voice('read'), contains('version 1 of 2'));
    await tester.pumpWidget(const SizedBox());
    expect(CheLiveStudio.voiceHandler, isNull, reason: 'stops listening when closed');
  });

  testWidgets('button and text-field actions speak their outcome once; voice actions do not speak twice (review of #520)', (tester) async {
    await _phone(tester);
    final spoken = <String>[];
    final vp = <_FakeViewport>[];
    final w = _Worker(_project());
    await tester.pumpWidget(studio(w, spoken: spoken, vp: vp));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'opening and loading never speak');
    await tester.ensureVisible(find.byKey(const ValueKey('live-apply')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('live-edit')), 'Make the hair longer');
    await tester.tap(find.byKey(const ValueKey('live-apply')));
    await tester.pumpAndSettle();
    expect(spoken, ['Hair changed to long wavy. Saved as version 2. Say generate to build it.']);
    await tester.ensureVisible(find.byKey(const ValueKey('live-tool-Turn left')));
    await tester.tap(find.byKey(const ValueKey('live-tool-Turn left')));
    await tester.pumpAndSettle();
    expect(spoken.last, 'Turned the model left 45 degrees.');
    final before = spoken.length;
    expect(await CheLiveStudio.voiceHandler!('undo'), 'Back to version 1 of 2.');
    expect(spoken.length, before, reason: 'the voice route speaks the reply itself');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a failed progress request while building keeps polling (review of #520)', (tester) async {
    await _phone(tester);
    var fail = true;
    var gets = 0;
    final project = _project(job: _job(model: false, state: 'rendering'), engine: 'online');
    final client = MockClient((r) async {
      if (r.method == 'GET' && r.url.path == '/api/creations/cr_1') {
        gets += 1;
        if (gets == 2 && fail) return http.Response('oops', 500);
        return http.Response(jsonEncode({'ok': true, 'project': project}), 200);
      }
      return http.Response('{}', 404);
    });
    await tester.pumpWidget(MaterialApp(
      home: CheLiveStudio(
        baseUrl: 'https://che.test',
        headers: const {},
        projectId: 'cr_1',
        client: client,
        viewport: (m) => _FakeViewport(m),
        loadBundled: (id) async => Uint8List.fromList([1]),
      ),
    ));
    await tester.pumpAndSettle();
    expect(gets, 1);
    await tester.pump(const Duration(seconds: 7)); // second request fails
    await tester.pumpAndSettle();
    expect(gets, 2);
    fail = false;
    await tester.pump(const Duration(seconds: 7)); // and polling continues
    await tester.pumpAndSettle();
    expect(gets, 3);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a generated model with no skeleton says it cannot be animated', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(studio(_Worker(_project(job: _job(state: 'completed'), engine: 'online'))));
    await tester.pumpAndSettle();
    expect(await CheLiveStudio.voiceHandler!('animate it'), startsWith('This generated model has no skeleton yet'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('animation mode previews a crew model\'s own clips and says new animation is not built', (tester) async {
    await _phone(tester);
    final vp = <_FakeViewport>[];
    await tester.pumpWidget(studio(_Worker(_project()), vp: vp, clips: const ['idle', 'wave', 'talk'], mode: CheLiveStudioMode.animation));
    await tester.pumpAndSettle();
    expect(vp.single.loads.single, startsWith('Bundled stylised model of CHE with its built-in animation clips.'));
    await tester.ensureVisible(find.byKey(const ValueKey('anim-clip-wave')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('anim-clip-wave')));
    await tester.pumpAndSettle();
    expect(vp.single.cmds.last, {'action': 'animate', 'clip': 'wave'});
    expect(find.textContaining('Making new animations and rendering animation videos is not built yet.'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('anim-base-nova')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('anim-base-nova')));
    await tester.pumpAndSettle();
    expect(vp.single.loads.last, startsWith('Bundled stylised model of Nova'));
  });

  test('text-driven lip sync cues: closures for b/m/p, open vowels, stretched to the clip length', () {
    final cues = cheLipSyncCues('Bob, hi.');
    expect(cues.first, {'start': 0.0, 'end': 0.077, 'value': 'A'}, reason: 'b closes the mouth');
    expect([for (final c in cues) c['value']], ['A', 'E', 'A', 'X', 'B', 'C']);
    expect(cues.last['value'], isNot('X'), reason: 'no trailing rest');
    for (var i = 1; i < cues.length; i++) {
      expect(cues[i]['start'], cues[i - 1]['end'], reason: 'cues are contiguous');
    }
    final timed = cheLipSyncCues('Hello there, how are you?', durationMs: 2400);
    expect(timed.last['end'] as double, closeTo(2.4, 0.01), reason: 'stretched to the real clip length');
    expect(cheLipSyncCues('...  '), isEmpty);
  });

  testWidgets('lip sync: voice and button run the test on mouth_open; CHE\'s spoken clips move the mouth silently', (tester) async {
    await _phone(tester);
    final spoken = <String>[];
    final vp = <_FakeViewport>[];
    await tester.pumpWidget(studio(_Worker(_project()), spoken: spoken, vp: vp, morphs: const ['mouth_open', 'smile', 'blink_l', 'blink_r']));
    await tester.pumpAndSettle();
    expect(spoken, isEmpty, reason: 'nothing spoken on open');
    final said = await CheLiveStudio.voiceHandler!('make her talk');
    expect(said, startsWith(CheLiveStudio.lipSyncTestLine));
    expect(said, contains('mouth_open shape key'));
    expect(said, contains('approximate'));
    expect(spoken, isEmpty, reason: 'the voice route speaks the reply itself');
    expect(vp.single.cmds.last['action'], 'lipsync');
    expect((vp.single.cmds.last['cues'] as List).isNotEmpty, isTrue);
    expect(await CheLiveStudio.voiceHandler!('lip sync test'), startsWith(CheLiveStudio.lipSyncTestLine));
    await tester.ensureVisible(find.byKey(const ValueKey('live-tool-Lip sync test')));
    await tester.tap(find.byKey(const ValueKey('live-tool-Lip sync test')));
    await tester.pumpAndSettle();
    expect(spoken.single, startsWith(CheLiveStudio.lipSyncTestLine), reason: 'a button action speaks its outcome once');
    // A clip CHE is already playing: cues timed to its real length; nothing spoken, nothing in the banner.
    final banner = tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('live-banner')), matching: find.byType(Text))).data;
    CheLiveStudio.speechLipSync!('Hello there, how are you?', 1800);
    await tester.pumpAndSettle();
    final cmd = vp.single.cmds.last;
    expect(cmd['action'], 'lipsync');
    expect(cmd['duration'], 1.8);
    expect(((cmd['cues'] as List).last as Map)['end'] as double, closeTo(1.8, 0.01));
    CheLiveStudio.speechLipSyncStop!();
    await tester.pumpAndSettle();
    expect(vp.single.cmds.last, {'action': 'stop_speaking'});
    expect(spoken.length, 1, reason: 'lip sync never starts speech');
    expect(tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('live-banner')), matching: find.byType(Text))).data, banner);
    await tester.pumpWidget(const SizedBox());
    expect(CheLiveStudio.speechLipSync, isNull, reason: 'stops following speech when closed');
    expect(CheLiveStudio.speechLipSyncStop, isNull);
  });

  testWidgets('lip sync on a model with no mouth_open shape key is refused aloud; spoken clips send nothing', (tester) async {
    await _phone(tester);
    final vp = <_FakeViewport>[];
    await tester.pumpWidget(studio(_Worker(_project()), vp: vp));
    await tester.pumpAndSettle();
    expect(await CheLiveStudio.voiceHandler!('lip sync test'),
        'That did not work: This model has no mouth_open shape key, so its mouth cannot move.');
    await tester.pumpAndSettle();
    expect(find.text('That did not work: This model has no mouth_open shape key, so its mouth cannot move.'), findsOneWidget);
    final sent = vp.single.cmds.length;
    CheLiveStudio.speechLipSync!('Hello there.', 900);
    CheLiveStudio.speechLipSyncStop!();
    await tester.pumpAndSettle();
    expect(vp.single.cmds.length, sent, reason: 'no mouth shape key: passive lip sync sends nothing');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('VoiceOver labels on the viewport and controls', (tester) async {
    await _phone(tester);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(studio(_Worker(_project())));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^3D viewport\. Bundled stylised model of CHE')), findsOneWidget);
    for (final l in ['Turn left', 'Turn right', 'Zoom in', 'Zoom out', 'Reset view', 'Lip sync test', 'Apply the change', 'Generate the 3D model']) {
      expect(find.bySemanticsLabel(l), findsOneWidget, reason: l);
    }
    expect(find.bySemanticsLabel(RegExp(r'^Creation Engine Offline\.')), findsOneWidget);
    expect(find.bySemanticsLabel('Connect: open the Colab notebook'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('screenshots', (tester) async {
    if (shots.isEmpty) return;
    Directory(shots).createSync(recursive: true);
    await _phone(tester);
    final boundary = GlobalKey();
    Future<void> shoot(String name) async {
      await tester.pumpAndSettle();
      final ro = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final bytes = await tester.runAsync(() async {
        final image = await ro.toImage(pixelRatio: 3);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        return data!.buffer.asUint8List();
      });
      File('$shots/$name.png').writeAsBytesSync(bytes!);
    }

    await tester.pumpWidget(RepaintBoundary(key: boundary, child: studio(_Worker(_project()))));
    await shoot('20_live_studio_offline');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(key: boundary, child: studio(_Worker(_project(job: _job(), engine: 'online')))));
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const ValueKey('live-studio-scroll')), const Offset(0, -700));
    await shoot('21_live_studio_progress');
    await tester.pumpWidget(const SizedBox());
  });
}
