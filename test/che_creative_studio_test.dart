// Create → the Creation Room (lib/create/che_creative_studio.dart): six main choices (Create Person, Object, Room,
// Animation, My Creations, Active Projects) under the Creation Engine's real state, then More to create, the Film,
// Music, Code and Art & Character studios and Projects. These tests check every choice and studio is there, every button
// reaches its existing handler, Create Object and Create Room offer their fixed families and report the Worker's answer, the GPU controls moved to Settings →
// Creation Engine, nothing is spoken on open, and activity shows only real states. The data below is test data only.
//
// CHE_STUDIO_SHOTS=<dir> flutter test test/che_creative_studio_test.dart also writes iPhone-size PNG screenshots of the
// real widgets to <dir> (Roboto and Material Icons from the Flutter SDK).
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/che_creations.dart';
import 'package:chey/che_gpu_jobs.dart';
import 'package:chey/create/che_creation_engine_page.dart';
import 'package:chey/create/che_creative_studio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _projects = <Map<String, dynamic>>[
  {'id': 'p1', 'title': 'Arc reactor lamp', 'type': 'invention', 'status': 'idle', 'updated_at': '2026-10-20T10:00:00Z'},
  {'id': 'p2', 'title': 'Night city poster', 'type': 'art', 'status': 'active', 'updated_at': '2026-10-23T10:00:00Z'},
  {'id': 'p3', 'title': 'Launch teaser', 'type': 'video', 'updated_at': '2026-10-22T10:00:00Z'},
  {'id': 'p4', 'title': 'Studio beat pack', 'type': 'music', 'updated_at': '2026-10-18T10:00:00Z'},
  {'id': 'p5', 'title': 'Recipe app', 'type': 'code', 'updated_at': '2026-10-24T09:00:00Z'},
];

class _Calls {
  _Calls({this.workspaces = false});

  /// With the workspaces this build wires (hub_rooms.dart): Code Studio and the project manager.
  final bool workspaces;
  final list = <String>[];
  CheStudioActions actions() => CheStudioActions(
        onOpenCodeWorkspace: workspaces ? () => list.add('code workspace') : null,
        onOpenProjectManager: workspaces ? () => list.add('project manager') : null,
        onOpenFilmStudio: () => list.add('film'),
        onNewVideo: () => list.add('new video'),
        onOpenTheater: () => list.add('theater'),
        onOpenMusic: () => list.add('music'),
        onNewSong: () => list.add('new song'),
        onNewApp: () => list.add('new app'),
        onOpenCommandCenter: () => list.add('command center'),
        onOpenOffice: () => list.add('office'),
        onCharacterGenerator: () => list.add('character generator'),
        onOpenArtStudio: () => list.add('art studio'),
        onNewImage: () => list.add('new image'),
        onNewProject: () => list.add('new project'),
        onOpenProject: (p) async => list.add('project ${p['id']}'),
        onVault: () => list.add('vault'),
        onResearch: () => list.add('research'),
        onInventions: () => list.add('inventions'),
        onShowroom: () => list.add('showroom'),
        loadPeople: () async => const [('che', 'CHE', 'Office Boss'), ('vale', 'Vale', 'Quality assurance')],
        onCreatePerson: (base) => list.add('person $base'),
        onCreateAnimation: () => list.add('animation'),
        onOpenCreation: (id) => list.add('creation $id'),
        onConnectEngine: (e) => list.add('connect ${e.status}'),
        onContinueCreating: () async {
          list.add('continue');
          return 'Opening CHE (new person): it is waiting for a worker.';
        },
        onCreateThing: (kind, base, viaVoice) async {
          list.add('$kind $base${viaVoice ? ' (voice)' : ''}');
          return base == 'dragon' ? 'That did not work: CHE builds only these objects.' : 'Worker: $base started. Opening it in the Live Studio.';
        },
      );
}

// GET /api/creations as the Worker answers it (creation_studio.js), with one creation building. Test data only.
Map<String, dynamic> _creationsView({String engine = 'offline', bool things = true}) => {
      'projects': [
        {'id': 'cr_1', 'kind': 'person', 'title': 'CHE (new person)', 'version': 2, 'versions': 2,
          'job': {'id': 'gpu_1', 'state': 'queued', 'pct': 0, 'message': 'Waiting for your Colab GPU session.'}},
        {'id': 'cr_2', 'kind': 'person', 'title': 'Vale (new person)', 'version': 1, 'versions': 1, 'job': null},
      ],
      'engine': {
        'status': engine,
        'online': engine == 'online',
        'paired': engine != 'not_paired',
        'gpu': engine == 'online' ? 'Tesla T4' : null,
        if (engine == 'cloud') ...{'automatic': true, 'workers_online': 1, 'max_concurrent': 3},
      },
      'capabilities': [
        {'id': 'person', 'status': 'available', 'detail': 'Build a real 3D head.'},
        // As creation_studio.js answers now; things: false is an older Worker without them.
        things
            ? {'id': 'object', 'status': 'available', 'detail': 'Procedural parametric objects and rooms from a fixed family list; not free-form text-to-3D.'}
            : {'id': 'object', 'status': 'unavailable', 'detail': 'Not built yet: CHE has no object modelling pipeline in Blender yet.'},
        things
            ? {'id': 'room', 'status': 'available', 'detail': 'Procedural parametric objects and rooms from a fixed family list; not free-form text-to-3D.'}
            : {'id': 'room', 'status': 'unavailable', 'detail': 'Not built yet: rooms have no generator yet.'},
        {'id': 'animation', 'status': 'partial', 'detail': 'Preview the built-in clips on the bundled crew models.'},
      ],
    };

// The GPU queue before pairing: what the owner's phone shows until he taps Pair Colab.
http.Client _gpuClient() => MockClient((r) async {
      if (r.url.path == '/api/gpu') {
        return http.Response(jsonEncode({'worker_paired': false, 'workers': [], 'counts': {}, 'jobs': [], 'spoken': 'No GPU jobs yet.'}), 200);
      }
      return http.Response('{}', 404);
    });

Widget _studio(_Calls calls, {List<CheStudioActivity> activity = const [], List<String>? read, bool creations = true, String engine = 'offline', Key? key, Future<String> Function(Map<String, Object>)? saveEngine, bool things = true}) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, fontFamily: 'Roboto'),
      home: Scaffold(
        body: CheCreativeStudio(
          key: key,
          actions: calls.actions(),
          projects: _projects,
          vaultCount: 3,
          activity: activity,
          imageConnected: true,
          videoConnected: false,
          onRead: read?.add,
          loadCreations: () async => _creationsView(engine: engine, things: things),
          saveEngineSettings: saveEngine,
          creations: creations
              ? const CheCreationsTiles(
                  items: [
                    {'id': 'v1', 'kind': 'video', 'title': 'Launch teaser'},
                    {'id': 'i1', 'kind': 'image', 'title': 'Night city poster'},
                  ],
                  baseUrl: 'https://che.test',
                  headers: {},
                )
              : null,
        ),
      ),
    );

Future<void> _phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1170, 2532); // iPhone, 390 x 844 points at 3x
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Future<void> _scrollTo(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 300, scrollable: find.descendant(of: find.byKey(const ValueKey('creative-studio-scroll')), matching: find.byType(Scrollable)).first);
  await tester.pumpAndSettle();
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

  testWidgets('every studio and Projects are on one scrolling page, under the six main choices', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    expect(find.text('CREATION ROOM'), findsOneWidget);
    for (final id in ['person', 'object', 'room', 'animation', 'mine', 'active']) {
      expect(find.byKey(ValueKey('studio-tile-$id')), findsOneWidget, reason: id);
    }
    // No GPU vocabulary in the room itself: it lives in Settings → Creation Engine.
    expect(find.textContaining('Pair Colab'), findsNothing);
    expect(find.byType(CheGpuJobsCard), findsNothing);
    expect(find.text('Managed by Vale'), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-create-new')), findsOneWidget);
    for (final title in ['Film Studio', 'Music Studio', 'Code Studio', 'Art & Character Studio']) {
      await _scrollTo(tester, find.text(title));
      expect(find.text(title), findsOneWidget);
    }
    await _scrollTo(tester, find.text('PROJECTS'));
    expect(find.text('PROJECTS'), findsOneWidget);
    // No figures: the old gallery's 3D scene is gone.
    expect(find.byType(CustomPaint).evaluate().where((e) => '${(e.widget as CustomPaint).painter.runtimeType}'.contains('Gallery')), isEmpty);
  });

  testWidgets('Create New lists what can be made and each item reaches its existing handler', (tester) async {
    await _phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    const items = {
      'Video': 'new video',
      'Film': 'film',
      'Song or beat': 'new song',
      'App, website or game': 'new app',
      'Image': 'new image',
      'Character': 'character generator',
      'Project': 'new project',
      'Invention': 'inventions',
    };
    for (final e in items.entries) {
      await tester.tap(find.byKey(const ValueKey('studio-create-new')));
      await tester.pumpAndSettle();
      final item = find.byKey(ValueKey('studio-new-${e.key}'));
      await tester.scrollUntilVisible(item, 120, scrollable: find.descendant(of: find.byType(BottomSheet), matching: find.byType(Scrollable)).first);
      await tester.tap(item);
      await tester.pumpAndSettle();
      expect(calls.list.last, e.value, reason: e.key);
      expect(find.byType(BottomSheet), findsNothing);
    }
  });

  testWidgets('each studio button reaches its handler', (tester) async {
    await _phone(tester);
    final calls = _Calls(workspaces: true);
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    final buttons = {
      'studio-film-primary': 'film',
      'studio-film-New video': 'new video',
      'studio-film-Theater': 'theater',
      'studio-music-primary': 'music',
      'studio-music-New song or beat': 'new song',
      'studio-code-primary': 'code workspace',
      'studio-code-New app, site or game': 'new app',
      'studio-code-The crew': 'office',
      'studio-code-Commands': 'command center',
      'studio-art-primary': 'character generator',
      'studio-art-Art Studio': 'art studio',
      'studio-art-New image': 'new image',
    };
    for (final e in buttons.entries) {
      final f = find.byKey(ValueKey(e.key));
      await _scrollTo(tester, f);
      await tester.tap(f);
      await tester.pump();
      expect(calls.list.last, e.value, reason: e.key);
    }
  });

  testWidgets('Settings → Connections → Cloud Computer holds GPU jobs, Pair Colab and the notebook link', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(MaterialApp(
      home: CheCreationEnginePage(baseUrl: 'https://che.test', headers: const {}, client: _gpuClient()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Cloud Computer'), findsOneWidget);
    expect(find.byKey(const ValueKey('engine-open-notebook')), findsOneWidget);
    expect(find.byType(CheGpuJobsCard), findsOneWidget);
    expect(find.textContaining('CHE_GPU_TOKEN'), findsOneWidget);
  });

  testWidgets('the six choices: real statuses, honest not-built answers, and each reaches its handler', (tester) async {
    await _phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-person')), matching: find.text('Ready')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-object')), matching: find.text('Ready')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-room')), matching: find.text('Ready')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-animation')), matching: find.text('Preview only')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-mine')), matching: find.text('2 3D creations')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-active')), matching: find.text('1 building now')), findsOneWidget);
    // Engine offline: the plain label and Connect.
    expect(find.text('Waiting for a worker'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-connect')));
    expect(calls.list.last, 'connect offline');
    // Create Object: the fixed families; choosing one asks the Worker to start the project.
    await tester.tap(find.byKey(const ValueKey('studio-tile-object')));
    await tester.pumpAndSettle();
    expect(find.text('Create an object'), findsOneWidget);
    for (final name in ['Lamp', 'Chair', 'Table', 'Desk', 'Mug', 'Vase', 'Shelf']) {
      expect(find.byKey(ValueKey('studio-new-$name')), findsOneWidget, reason: name);
    }
    await tester.tap(find.byKey(const ValueKey('studio-new-Chair')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'object chair', reason: 'a tap: the app speaks the Worker answer itself');
    // Create Room: the four room types.
    await tester.tap(find.byKey(const ValueKey('studio-tile-room')));
    await tester.pumpAndSettle();
    expect(find.text('Create a room'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-new-Office')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'room office');
    // Create Person: choose who to start from.
    await tester.tap(find.byKey(const ValueKey('studio-tile-person')));
    await tester.pumpAndSettle();
    expect(find.text('Create a person'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-new-Vale')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'person vale');
    // Create Animation, My Creations.
    await tester.tap(find.byKey(const ValueKey('studio-tile-animation')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'animation');
    await tester.tap(find.byKey(const ValueKey('studio-tile-mine')));
    await tester.pumpAndSettle();
    expect(find.text('My Creations'), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('studio-new-Vale (new person)')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'creation cr_2');
    // Active Projects: the building creation first, then saved projects.
    await tester.tap(find.byKey(const ValueKey('studio-tile-active')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('studio-new-CHE (new person)')), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-new-Vale (new person)')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('studio-new-CHE (new person)')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'creation cr_1');
  });

  testWidgets('engine online shows the GPU and no Connect', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_studio(_Calls(), engine: 'online'));
    await tester.pumpAndSettle();
    expect(find.text('Creation Engine Online'), findsOneWidget);
    expect(find.text('Running on Tesla T4.'), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-connect')), findsNothing);
  });

  testWidgets('free cloud workers: the engine is Ready with no Connect, and "creation engine status" says so', (tester) async {
    await _phone(tester);
    final key = GlobalKey<CheCreativeStudioState>();
    await tester.pumpWidget(_studio(_Calls(), engine: 'cloud', key: key));
    await tester.pumpAndSettle();
    expect(find.text('Creation Engine Ready'), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-connect')), findsNothing);
    final said = await key.currentState!.voice('creation engine status');
    expect(said, startsWith('Creation Engine Ready. CHE starts free cloud workers herself.'));
    expect(said, contains('Up to 3 jobs at once.'));
    expect(await key.currentState!.voice('is the creation engine running'), said);
  });

  test('spoken Creation Engine settings are understood; other sentences are not', () {
    expect(cheEngineSettingFromWords('Start cloud workers automatically.'), {'auto_cloud': true});
    expect(cheEngineSettingFromWords('turn on free cloud workers'), {'auto_cloud': true});
    expect(cheEngineSettingFromWords('stop starting cloud workers'), {'auto_cloud': false});
    expect(cheEngineSettingFromWords('turn off cloud workers'), {'auto_cloud': false});
    expect(cheEngineSettingFromWords('allow 4 cloud workers at once'), {'max_cloud_workers': 4});
    expect(cheEngineSettingFromWords('set cloud workers to 2'), {'max_cloud_workers': 2});
    expect(cheEngineSettingFromWords('what are cloud workers'), isNull);
    expect(cheEngineSettingFromWords('start the video'), isNull);
  });

  testWidgets('Creation Engine settings by voice reach the Worker and speak its answer (review of #521)', (tester) async {
    await _phone(tester);
    final key = GlobalKey<CheCreativeStudioState>();
    final sent = <Map<String, Object>>[];
    await tester.pumpWidget(_studio(_Calls(), engine: 'cloud', key: key, saveEngine: (c) async {
      sent.add(c);
      return 'Creation Engine set: up to ${c['max_cloud_workers'] ?? 3} cloud workers at once. Spending limit stays at zero dollars.';
    }));
    await tester.pumpAndSettle();
    final said = await key.currentState!.voice('allow 4 cloud workers');
    expect(sent.single, {'max_cloud_workers': 4});
    expect(said, 'Creation Engine set: up to 4 cloud workers at once. Spending limit stays at zero dollars.');
    expect(await key.currentState!.voice('stop starting cloud workers'), isNotNull);
    expect(sent.last, {'auto_cloud': false});
  });

  testWidgets('projects: newest first, four shown, See all lists every one and opens the editor', (tester) async {
    await _phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    expect(cheProjectsNewestFirst(_projects).map((p) => p['id']), ['p5', 'p2', 'p3', 'p1', 'p4']);
    await _scrollTo(tester, find.byKey(const ValueKey('studio-project-p5')));
    expect(find.byKey(const ValueKey('studio-project-p4')), findsNothing); // the oldest waits behind See all
    await tester.tap(find.byKey(const ValueKey('studio-project-p5')));
    await tester.pump();
    expect(calls.list.last, 'project p5');
    await _scrollTo(tester, find.byKey(const ValueKey('studio-see-all')));
    await tester.tap(find.byKey(const ValueKey('studio-see-all')));
    await tester.pumpAndSettle();
    expect(find.text('All projects (5)'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-project-p4')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'project p4');
    for (final link in ['Saved files', 'Invention Studio', 'Capability Showroom', 'Novelty and feasibility research']) {
      final f = find.byKey(ValueKey('studio-link-$link'));
      await _scrollTo(tester, f);
      await tester.tap(f);
      await tester.pump();
    }
    expect(calls.list.sublist(calls.list.length - 4), ['vault', 'inventions', 'showroom', 'research']);
  });

  testWidgets('activity shows only the real states it is given; none says so', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    expect(find.text('No active jobs right now.'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls, activity: [
      CheStudioActivity(title: 'Coding job', status: 'Running', detail: 'Building the recipe app.', onTap: () => calls.list.add('job')),
    ]));
    await tester.pumpAndSettle();
    expect(find.text('No active jobs right now.'), findsNothing);
    expect(find.text('Coding job'), findsOneWidget);
    expect(find.text('Running'), findsOneWidget);
    await _scrollTo(tester, find.text('Coding job'));
    await tester.tap(find.text('Coding job'));
    expect(calls.list.last, 'job');
  });

  testWidgets('nothing is spoken on open; Read aloud reads the studios as a numbered list', (tester) async {
    await _phone(tester);
    final read = <String>[];
    await tester.pumpWidget(_studio(_Calls(), read: read));
    await tester.pumpAndSettle();
    expect(read, isEmpty);
    await tester.tap(find.byKey(const ValueKey('studio-read')));
    expect(read.single, contains('1 Create Person, 2 Create Object, 3 Create Room, 4 Create Animation, 5 My Creations, '
        '6 Active Projects, 7 More to create, 8 Film Studio, 9 Music Studio, 10 Code Studio, 11 Art Studio'));
    expect(read.single, contains('Waiting for a worker.'));
    expect(read.single, isNot(contains('not built yet')));
    expect(read.single, contains('No active jobs.'));
    expect(read.single, contains('2 3D creations, 5 projects and 3 saved files'));
  });

  testWidgets('VoiceOver labels on the main controls', (tester) async {
    await _phone(tester);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^More to create\. Choose a video')), findsOneWidget);
    expect(find.bySemanticsLabel('Read the Creation Room aloud'), findsOneWidget);
    expect(find.bySemanticsLabel('1. Create Person. Ready.'), findsOneWidget);
    expect(find.bySemanticsLabel('2. Create Object. Ready.'), findsOneWidget);
    expect(find.bySemanticsLabel('3. Create Room. Ready.'), findsOneWidget);
    expect(find.bySemanticsLabel('Cloud Computer: open Settings, Connections, Cloud Computer'), findsOneWidget);
    expect(find.bySemanticsLabel('Film Studio: Open Film Studio'), findsOneWidget);
    await _scrollTo(tester, find.byKey(const ValueKey('studio-art-primary')));
    expect(find.bySemanticsLabel('Art & Character Studio: Character Generator'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('studio scrolls to a section on request (voice routes)', (tester) async {
    await _phone(tester);
    final key = GlobalKey<CheCreativeStudioState>();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheCreativeStudio(key: key, actions: _Calls().actions(), projects: _projects, vaultCount: 0),
      ),
    ));
    await tester.pumpAndSettle();
    key.currentState!.scrollTo(CheStudioSection.projects);
    await tester.pumpAndSettle();
    expect(find.text('PROJECTS').hitTestable(), findsOneWidget);
  });

  // Screenshots of the real widgets at iPhone size, written only when CHE_STUDIO_SHOTS names a folder.
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

    await tester.pumpWidget(RepaintBoundary(key: boundary, child: _studio(_Calls())));
    await tester.pumpAndSettle();
    await shoot('01_create_top');
    for (final (key, name) in [
      ('studio-create-new', '02_more_to_create'),
      ('studio-film', '03_film_studio'),
      ('studio-art', '05_art_character_studio'),
      ('studio-link-Saved files', '07_projects'),
    ]) {
      final f = find.byKey(ValueKey(key));
      await tester.scrollUntilVisible(f, 300, scrollable: find.descendant(of: find.byKey(const ValueKey('creative-studio-scroll')), matching: find.byType(Scrollable)).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await shoot(name);
    }
    await tester.pumpWidget(const SizedBox()); // a fresh page, scrolled to the top
    await tester.pumpWidget(RepaintBoundary(key: boundary, child: _studio(_Calls())));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('studio-tile-person')));
    await shoot('08_create_person_sheet');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(key: boundary, child: _studio(_Calls())));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('studio-tile-mine')));
    await shoot('10_my_creations_sheet');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(key: boundary, child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, fontFamily: 'Roboto'),
      home: CheCreationEnginePage(baseUrl: 'https://che.test', headers: const {}, client: _gpuClient()),
    )));
    await shoot('11_settings_creation_engine');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(
      key: boundary,
      child: _studio(_Calls(), activity: const [CheStudioActivity(title: 'Coding job', status: 'Running', detail: 'Example state for the screenshot (test data).')]),
    ));
    await shoot('09_working_now_with_a_job');
  });

  test('create words name an object family or a room type, and nothing else', () {
    expect(cheCreateThingFromWords('create a chair'), ('object', 'chair'));
    expect(cheCreateThingFromWords('Make a floor lamp.'), ('object', 'lamp'));
    expect(cheCreateThingFromWords('new desk'), ('object', 'desk'));
    expect(cheCreateThingFromWords('build me a bookcase'), ('object', 'shelf'));
    expect(cheCreateThingFromWords('create a living room'), ('room', 'living_room'));
    expect(cheCreateThingFromWords('CHE, make a bedroom'), ('room', 'bedroom'));
    for (final other in ['create a room', 'create an object', 'make a video', 'new project', 'create a dragon', 'create person', 'open the music studio']) {
      expect(cheCreateThingFromWords(other), isNull, reason: other);
    }
  });

  testWidgets('an older Worker without objects and rooms: the tiles say so honestly and nothing is created', (tester) async {
    await _phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls, things: false));
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byKey(const ValueKey('studio-tile-object')), matching: find.text('Not available yet')), findsOneWidget);
    final before = calls.list.length;
    await tester.tap(find.byKey(const ValueKey('studio-tile-object')));
    await tester.pump();
    expect(find.textContaining('Create Object is not available yet. Not built yet'), findsOneWidget);
    expect(await CheCreativeStudio.voiceHandler!('create a chair'), isNull, reason: 'not claimed when the Worker says it is not built');
    expect(await CheCreativeStudio.voiceHandler!('create a room'), startsWith('Create Room is not available yet.'));
    expect(calls.list.length, before);
    await tester.pumpAndSettle(const Duration(seconds: 7));
  });

  test('spoken numbers are read as choices', () {
    expect(cheSpokenChoice('four'), 4);
    expect(cheSpokenChoice('Option four.'), 4);
    expect(cheSpokenChoice('number 6'), 6);
    expect(cheSpokenChoice('choose the second'), 2);
    expect(cheSpokenChoice('what is four plus four'), isNull);
  });

  testWidgets('the numbered choices Read aloud announces work by voice, on the studio and in Create New', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    final voice = CheCreativeStudio.voiceHandler!;
    expect(await voice('tell me a joke'), isNull, reason: 'anything else goes to Chat');
    expect(await voice('read'), contains('1 Create Person, 2 Create Object'));
    expect(await voice('eleven'), startsWith('Opening Art Studio for images.'));
    expect(calls.list.last, 'art studio');
    // Create Object by number: the families as a numbered list, then a number starts one and CHE says the Worker's answer.
    final objects = await voice('two');
    await tester.pumpAndSettle();
    expect(objects, 'Create Object. Say a number: 1 Lamp, 2 Chair, 3 Table, 4 Desk, 5 Mug, 6 Vase, 7 Shelf.');
    expect(await voice('read'), startsWith('Create an object. Say or choose: 1 Lamp, 2 Chair'));
    expect(await voice('two'), 'Worker: chair started. Opening it in the Live Studio.');
    await tester.pumpAndSettle();
    expect(calls.list.last, 'object chair (voice)', reason: 'spoken by the voice route, so the app does not speak it twice');
    expect(find.text('Create an object'), findsNothing, reason: 'the sheet closed');
    final rooms = await voice('create a room');
    await tester.pumpAndSettle();
    expect(rooms, 'Create Room. Say a number: 1 Living room, 2 Bedroom, 3 Office, 4 Studio.');
    expect(await voice('cancel'), 'Closed Create a room.');
    await tester.pumpAndSettle();
    // Named straight away.
    expect(await voice('CHE, create an office.'), 'Worker: office started. Opening it in the Live Studio.');
    expect(calls.list.last, 'room office (voice)');
    expect(await voice('make a coffee table'), startsWith('Worker: table started'));
    expect(calls.list.last, 'object table (voice)');
    expect(await voice('character generator'), 'Opening the Character Generator.');
    expect(calls.list.last, 'character generator');
    expect(await voice('create animation'), contains('Opening the animation preview'));
    expect(calls.list.last, 'animation');
    expect(await voice('connect the engine'), startsWith('Waiting for a worker.'));
    expect(await voice('connect the engine'), endsWith('Opening Settings, Connections, Cloud Computer.'));
    expect(calls.list.last, 'connect offline');
    // "Continue creating" goes back into the creation; "connect" never opens a website (no launcher in this route).
    expect(await voice('continue creating'), 'Opening CHE (new person): it is waiting for a worker.');
    expect(calls.list.last, 'continue');
    expect(await voice('resume my creation'), startsWith('Opening CHE'));
    final people = await voice('create person');
    await tester.pumpAndSettle();
    expect(people, startsWith('Create Person.'));
    expect(await voice('two'), 'Opening Vale.');
    await tester.pumpAndSettle();
    expect(calls.list.last, 'person vale');
    final menu = await voice('option seven');
    await tester.pumpAndSettle();
    expect(menu, startsWith('Create new. Say or choose: 1 Video, 2 Film'));
    expect(find.text('Choose what to make.'), findsOneWidget);
    expect(await voice('read'), startsWith('Create new.'), reason: 'numbers now refer to the open sheet');
    expect(await voice('three'), 'Opening Song or beat.');
    await tester.pumpAndSettle();
    expect(calls.list.last, 'new song');
    expect(find.text('Choose what to make.'), findsNothing, reason: 'the sheet closed');
    expect(await voice('12'), startsWith('There is no choice 12.'));
  });

  testWidgets('the studio leaves spoken numbers alone when it is not the open tab, and stops listening when gone', (tester) async {
    final calls = _Calls();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheCreativeStudio(actions: calls.actions(), projects: const [], vaultCount: 0, active: false),
      ),
    ));
    await tester.pumpAndSettle();
    expect(await CheCreativeStudio.voiceHandler!('four'), isNull);
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(CheCreativeStudio.voiceHandler, isNull);
  });

  // Owner, 2026-10-24: "every Studio button goes to its real destination ... Code opens a dedicated coding
  // workspace (not Home or Chat)". The numbered choices and studio buttons open workspaces, never a chat prompt.
  testWidgets('every Studio button and numbered choice opens its real destination, never Chat', (tester) async {
    await _phone(tester);
    final calls = _Calls(workspaces: true);
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    final voice = CheCreativeStudio.voiceHandler!;
    // Numbered choices 8-11 open the studios themselves.
    expect(await voice('eight'), 'Opening Film Studio.');
    expect(calls.list.last, 'film');
    expect(await voice('nine'), 'Opening Music Studio.');
    expect(calls.list.last, 'music');
    expect(await voice('ten'), 'Opening Code Studio.');
    expect(calls.list.last, 'code workspace');
    expect(await voice('eleven'), startsWith('Opening Art Studio'));
    expect(calls.list.last, 'art studio');
    expect(await voice('open code studio'), 'Opening Code Studio.');
    expect(calls.list.last, 'code workspace');
    expect(await voice('coding jobs'), 'Opening Code Studio.');
    expect(await voice('open the project manager'), 'Opening the project manager.');
    expect(calls.list.last, 'project manager');
    // Active Projects opens the project manager; My Creations lists 3D creations and the saved pictures and videos.
    await tester.tap(find.byKey(const ValueKey('studio-tile-active')));
    await tester.pumpAndSettle();
    expect(calls.list.last, 'project manager');
    await tester.tap(find.byKey(const ValueKey('studio-tile-mine')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('studio-new-Pictures and videos')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-new-Pictures and videos')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('saved-visuals')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    // Create Object and Create Room open their real choices (Blender object and room jobs on the Creation Engine).
    expect(await voice('three'), startsWith('Create Room. Say a number:'));
    await tester.pumpAndSettle();
    expect(await voice('cancel'), startsWith('Closed'));
    await tester.pumpAndSettle();
    // Every studio-card button, by key: its destination.
    final buttons = {
      'studio-film-primary': 'film', 'studio-film-New video': 'new video', 'studio-film-Theater': 'theater',
      'studio-music-primary': 'music', 'studio-music-New song or beat': 'new song',
      'studio-code-primary': 'code workspace', 'studio-code-New app, site or game': 'new app', 'studio-code-The crew': 'office',
      'studio-code-Commands': 'command center',
      'studio-art-primary': 'character generator', 'studio-art-Art Studio': 'art studio', 'studio-art-New image': 'new image',
    };
    for (final e in buttons.entries) {
      final f = find.byKey(ValueKey(e.key));
      await _scrollTo(tester, f);
      await tester.tap(f);
      await tester.pump();
      expect(calls.list.last, e.value, reason: e.key);
    }
  });
}
