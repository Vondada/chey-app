// Create → Creative Studio (lib/create/che_creative_studio.dart): one vertically scrolling page with Create New, the
// Film, Music, Code and Art & Character studios and Projects. These tests check every studio is there, every button
// reaches its existing handler, the GPU controls (Pair Colab, GPU jobs, Character Generator) sit in Art & Character
// Studio, nothing is spoken on open, and activity shows only real states. The data below is test data only.
//
// CHE_STUDIO_SHOTS=<dir> flutter test test/che_creative_studio_test.dart also writes iPhone-size PNG screenshots of the
// real widgets to <dir> (Roboto and Material Icons from the Flutter SDK).
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/che_creations.dart';
import 'package:chey/che_gpu_jobs.dart';
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
  final list = <String>[];
  CheStudioActions actions() => CheStudioActions(
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
      );
}

// The GPU queue before pairing: what the owner's phone shows until he taps Pair Colab.
http.Client _gpuClient() => MockClient((r) async {
      if (r.url.path == '/api/gpu') {
        return http.Response(jsonEncode({'worker_paired': false, 'workers': [], 'counts': {}, 'jobs': [], 'spoken': 'No GPU jobs yet.'}), 200);
      }
      return http.Response('{}', 404);
    });

Widget _studio(_Calls calls, {List<CheStudioActivity> activity = const [], List<String>? read, bool creations = true}) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, fontFamily: 'Roboto'),
      home: Scaffold(
        body: CheCreativeStudio(
          actions: calls.actions(),
          projects: _projects,
          vaultCount: 3,
          activity: activity,
          imageConnected: true,
          videoConnected: false,
          onRead: read?.add,
          gpuJobs: CheGpuJobsCard(baseUrl: 'https://che.test', headers: const {}, client: _gpuClient()),
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

  testWidgets('every studio and Projects are on one scrolling page, with Create New first', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    expect(find.text('CREATIVE STUDIO'), findsOneWidget);
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
    final calls = _Calls();
    await tester.pumpWidget(_studio(calls));
    await tester.pumpAndSettle();
    final buttons = {
      'studio-film-primary': 'film',
      'studio-film-New video': 'new video',
      'studio-film-Theater': 'theater',
      'studio-music-primary': 'music',
      'studio-music-New song or beat': 'new song',
      'studio-code-primary': 'new app',
      'studio-code-Coding jobs in the Office': 'office',
      'studio-code-Command Center': 'command center',
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

  testWidgets('Art & Character Studio holds the Character Generator, GPU jobs and Pair Colab', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    await _scrollTo(tester, find.byKey(const ValueKey('studio-gpu-jobs')));
    final art = find.byKey(const ValueKey('studio-art'));
    expect(find.descendant(of: art, matching: find.text('Character Generator')), findsOneWidget);
    expect(find.descendant(of: art, matching: find.byType(CheGpuJobsCard)), findsOneWidget);
    expect(find.descendant(of: art, matching: find.text('Pair Colab')), findsOneWidget);
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
    expect(read.single, contains('1 Create New, 2 Film Studio, 3 Music Studio, 4 Code Studio, 5 Art and Character Studio, 6 Projects'));
    expect(read.single, contains('No active jobs.'));
    expect(read.single, contains('5 projects and 3 saved files'));
  });

  testWidgets('VoiceOver labels on the main controls', (tester) async {
    await _phone(tester);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_studio(_Calls()));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^Create new\. Choose a video')), findsOneWidget);
    expect(find.bySemanticsLabel('Read the Creative Studio aloud'), findsOneWidget);
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
      ('studio-film', '02_film_studio'),
      ('studio-music', '03_music_studio'),
      ('studio-code', '04_code_studio'),
      ('studio-art', '05_art_character_studio'),
      ('studio-gpu-jobs', '06_gpu_jobs_pair_colab'),
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
    await tester.tap(find.byKey(const ValueKey('studio-create-new')));
    await shoot('08_create_new_sheet');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(
      key: boundary,
      child: _studio(_Calls(), activity: const [CheStudioActivity(title: 'Coding job', status: 'Running', detail: 'Example state for the screenshot (test data).')]),
    ));
    await shoot('09_working_now_with_a_job');
  });
}
