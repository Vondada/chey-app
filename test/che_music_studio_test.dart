// Music Studio (owner UI cleanup, 2026-10-25): Music and the old Creator "Studio" view are one room tab, purely music
// creation. These tests hold the merge: the music sections are there; the render queue, embedded chat, 3D stages and
// unrelated tools are not; voice routes land on the tab; nothing speaks when it opens.
//
// Screenshots at the iPhone 17 Pro Max portrait size (440 x 956 points) are written only when CHE_SHOTS_DIR names a
// folder:  CHE_SHOTS_DIR=docs/ui_cleanup/studio flutter test test/che_music_studio_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/create/che_creative_studio.dart';
import 'package:chey/main.dart';
import 'package:chey/rooms/che_creator_studio.dart';
import 'package:chey/rooms/che_music_studio.dart';
import 'package:chey/widgets/che_native_scene_world.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_command_center_test.dart' as center;

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

class _Calls {
  final opened = <int>[];
  final read = <String>[];
  var songs = 0;
}

Widget _room(_Calls calls, {bool engine = false, GlobalKey? boundary}) {
  final theme = CheTheme.dark();
  final app = MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
    home: Scaffold(
      body: SafeArea(
        child: CheMusicStudioRoom(
          musicEngineConnected: engine,
          onOpenSection: calls.opened.add,
          onMakeSong: () => calls.songs++,
          onRead: calls.read.add,
        ),
      ),
    ),
  );
  return boundary == null ? app : RepaintBoundary(key: boundary, child: app);
}

void main() {
  final shots = Platform.environment['CHE_SHOTS_DIR'] ?? '';

  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
  });

  Future<void> phone(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
  }

  testWidgets('the merged tab holds every music section and none of the render queue, chat, 3D or other tools', (tester) async {
    await phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_room(calls));
    await tester.pumpAndSettle();
    expect(find.text('Music Studio'), findsOneWidget);
    for (final s in cheMusicSections) {
      expect(find.byKey(ValueKey('music-section-${s.id}'), skipOffstage: false), findsOneWidget, reason: s.id);
    }
    expect([for (final s in cheMusicSections) s.title], [
      'Record', 'Beat Maker', 'My Songs', 'Vocal Tools and Presets', 'Mixer', 'Mastering and Export', 'Make a Song with CHE', 'Help and Tutorial',
    ]);
    // Removed from this room (moved, not deleted): render queue, ON AIR, the Studio | Music switch, podcast and
    // narration (Film Studio), Apple Music and car audio (Devices), the 3D stages and any embedded chat box.
    for (final gone in ['RENDER QUEUE', 'ON AIR', 'Rendering in the cloud', 'Podcast episode', 'Voice + narration', 'Apple Music', 'Car Audio', 'Native 3D is unavailable.', '3D · Realistic']) {
      expect(find.text(gone, skipOffstage: false), findsNothing, reason: gone);
    }
    expect(find.byType(SegmentedButton<int>), findsNothing, reason: 'no Studio | Music split');
    expect(find.byType(CheNativeSceneWorld, skipOffstage: false), findsNothing);
    expect(find.byType(TextField, skipOffstage: false), findsNothing, reason: 'no chat box inside the room');
    expect(find.byType(ErrorWidget, skipOffstage: false), findsNothing);
    expect(tester.takeException(), isNull);
    // Passive open: nothing was read aloud.
    expect(calls.read, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('each section opens its Recording Studio tab; Make a Song asks CHE; Help opens the help sheet', (tester) async {
    await phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_room(calls, engine: true));
    await tester.pumpAndSettle();
    for (final s in cheMusicSections.where((s) => s.tab != null)) {
      await tester.scrollUntilVisible(find.byKey(ValueKey('music-section-${s.id}')), 200);
      await tester.tap(find.byKey(ValueKey('music-section-${s.id}')));
      await tester.pump();
    }
    expect(calls.opened, [0, 2, 1, 4, 3, 5], reason: 'Record, Beat Maker, My Songs, Effects, Mixer, Master');
    await tester.scrollUntilVisible(find.byKey(const ValueKey('music-section-engine')), 200);
    expect(find.text('Ready'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('music-section-engine')));
    expect(calls.songs, 1);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('music-section-help')), 200);
    await tester.tap(find.byKey(const ValueKey('music-section-help')));
    await tester.pumpAndSettle();
    expect(find.text('Music Studio help'), findsOneWidget);
    expect(calls.read, isEmpty, reason: 'opening Help speaks nothing');
    await tester.tap(find.byKey(const ValueKey('music-help-read')));
    expect(calls.read.single, contains('record my vocals'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('VoiceOver: every section is a labelled button with its number, and Read aloud is labelled', (tester) async {
    await phone(tester);
    final handle = tester.ensureSemantics();
    final calls = _Calls();
    await tester.pumpWidget(_room(calls));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Read the Music Studio aloud'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^1\. Record\. Record vocals')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^2\. Beat Maker\. ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^4\. Vocal Tools and Presets\. .*pitch correction')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('music-read')));
    expect(calls.read.single, startsWith('Music Studio. Music engine not connected. 1. Record. 2. Beat Maker. 3. My Songs.'));
    handle.dispose();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('spoken or typed: a number, a name, read aloud and help', (tester) async {
    await phone(tester);
    final calls = _Calls();
    await tester.pumpWidget(_room(calls));
    await tester.pumpAndSettle();
    final voice = CheMusicStudioRoom.voiceHandler!;
    expect(await voice('number two'), 'Opened Beat Maker in the Recording Studio.');
    expect(await voice('Mixer.'), 'Opened Mixer in the Recording Studio.');
    expect(await voice('open my songs'), 'Opened My Songs in the Recording Studio.');
    expect(await voice('pitch correction'), 'Opened Vocal Tools and Presets in the Recording Studio.');
    expect(calls.opened, [2, 3, 1, 4]);
    expect(await voice('read aloud'), startsWith('Music Studio. Music engine not connected. 1. Record.'));
    expect(await voice('make a song'), contains('not connected'));
    expect(calls.songs, 1);
    expect(await voice('nine'), 'There are 8 sections. Say a number from 1 to 8.');
    expect(await voice('what is the weather'), isNull, reason: 'anything else goes on to Chat');
    expect(await voice('help'), contains('record my vocals'));
    await tester.pumpAndSettle();
    expect(find.text('Music Studio help'), findsOneWidget);
    // With the help sheet on top the room is no longer in front: its numbers go elsewhere.
    expect(await voice('number one'), isNull);
    await tester.pumpWidget(const SizedBox());
    expect(CheMusicStudioRoom.voiceHandler, isNull);
  });

  test('"open music", "open studio" and "open the music studio" name the room, not the Apple Music app', () {
    for (final name in ['music', 'studio', 'the music studio', 'music studio.', 'my music studio']) {
      expect(cheIsMusicStudioName(name), isTrue, reason: name);
    }
    for (final name in ['apple music', 'the film studio', 'recording studio', 'art studio', 'music video']) {
      expect(cheIsMusicStudioName(name), isFalse, reason: name);
    }
  });

  test('the render queue moved to the Creation Room: media jobs, live first, coding work never', () {
    final q = cheCreationQueue([
      {'id': 'a', 'title': 'Old render', 'status': 'complete'},
      {'id': 'b', 'title': 'Podcast episode draft', 'status': 'running'},
      {'id': 'c', 'title': 'Repo study', 'status': 'running', 'kind': 'repo_study'},
      {'id': 'd', 'status': 'failed'},
      {'id': 'e', 'status': 'complete'},
      {'id': 'f', 'status': 'complete'},
    ]);
    expect([for (final j in q) j['id']], ['b', 'a', 'd', 'e']);
  });

  test('the rooms sheet: ten tabs, Music Studio fifth, no second Studio or Music room', () {
    final src = File('lib/home_state/memory.dart').readAsStringSync();
    final tabs = RegExp(r"Tab\(icon: Icon\(Icons\.\w+\), text: '([^']+)'\)").allMatches(src).map((m) => m.group(1)).toList();
    expect(tabs, ['Brain', 'Trading', 'Business', 'Devices', 'Music Studio', 'Create', 'Office', 'Apps', 'Theater', 'Workshop']);
    expect(src, contains('(active) => _hubMusicTab(active),'));
    final hub = File('lib/home_state/hub_rooms.dart').readAsStringSync();
    expect(hub, contains('Widget _hubMusicTab(bool active) => CheMusicStudioRoom('));
    expect(hub, isNot(contains('CheCreatorStudio(')));
    expect(hub, isNot(contains('MusicStudioScene(')));
    expect(File('lib/music_studio_scene.dart').existsSync(), isFalse);
  });

  testWidgets('voice routes: "open the music studio", "open studio" and "open music" all land on the Music Studio tab', (tester) async {
    SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.test'});
    // The phone's fallback voice: a test has no flutter_tts plugin, so its calls answer "done" here.
    const tts = MethodChannel('flutter_tts');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(tts, (call) async => 1);
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(tts, null));
    final che = center.FakeChe();
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));

      Future<void> send(String words) async {
        if (find.byTooltip('Show keyboard').evaluate().isNotEmpty) {
          await tester.tap(find.byTooltip('Show keyboard'));
          await tester.pump(const Duration(milliseconds: 300));
        }
        await tester.enterText(find.byType(TextField).last, words);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        for (var i = 0; i < 12; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
      }

      for (final phrase in ['Open the music studio.', 'CHE, open studio', 'open music']) {
        await send(phrase);
        expect(find.byKey(const ValueKey('music-studio-room')), findsOneWidget, reason: phrase);
        expect(CheScreenAwareness.describe(), startsWith('You are on Music Studio.'), reason: phrase);
        expect(find.byType(ErrorWidget), findsNothing);
        Navigator.of(tester.element(find.byKey(const ValueKey('music-studio-room')))).pop();
        for (var i = 0; i < 25; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
        expect(find.byKey(const ValueKey('music-studio-room')), findsNothing);
      }
      expect(che.requests.where((r) => r.url.path == '/api/chat'), isEmpty, reason: 'routed on the phone, no model asked');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    }, () => che.client);
  });

  testWidgets('screenshots', (tester) async {
    if (shots.isEmpty) return;
    await phone(tester);
    final boundary = GlobalKey();
    Future<void> shoot(String name) async {
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 30));
      }
      final ro = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final image = await ro.toImage(pixelRatio: 2);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        File('$shots/$name.png')
          ..createSync(recursive: true)
          ..writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    final calls = _Calls();
    await tester.pumpWidget(_room(calls, boundary: boundary));
    await shoot('after_1_music_studio_top');
    await tester.tap(find.byKey(const ValueKey('music-section-help')));
    await shoot('after_2_music_studio_help');
    expect(find.byType(ErrorWidget), findsNothing);
    // Where the render queue went: the Creation Room's Working now.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(RepaintBoundary(key: boundary, child: _creation()));
    await tester.drag(find.byKey(const ValueKey('creative-studio-scroll')), const Offset(0, -560));
    await shoot('after_3_creation_room_working_now');
    expect(find.byType(ErrorWidget), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the Creation Room lists the moved render queue under Working now, with no 3D filler', (tester) async {
    await phone(tester);
    await tester.pumpWidget(_creation());
    await tester.pumpAndSettle();
    expect(find.text('Podcast episode draft', skipOffstage: false), findsOneWidget);
    expect(find.text('Video render', skipOffstage: false), findsOneWidget);
    expect(find.text('Repo study', skipOffstage: false), findsNothing, reason: 'coding work stays in Projects and Office');
    expect(find.byType(CheNativeSceneWorld, skipOffstage: false), findsNothing);
    expect(find.byType(ErrorWidget, skipOffstage: false), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}

Widget _creation() {
  void none() {}
  final theme = CheTheme.dark();
  final jobs = [
    {'id': 'b', 'title': 'Podcast episode draft', 'status': 'running'},
    {'id': 'c', 'title': 'Repo study', 'status': 'running', 'kind': 'repo_study'},
    {'id': 'a', 'title': 'Video render', 'status': 'complete'},
  ];
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
    home: Scaffold(
      body: SafeArea(
        child: CheCreativeStudio(
          projects: const [],
          vaultCount: 0,
          activity: [for (final j in cheCreationQueue(jobs)) CheStudioActivity(title: '${j['title']}', status: '${j['status']}', onTap: none)],
          actions: CheStudioActions(
            onOpenFilmStudio: none, onNewVideo: none, onOpenTheater: none, onOpenMusic: none, onNewSong: none, onNewApp: none,
            onOpenCommandCenter: none, onOpenOffice: none, onCharacterGenerator: none, onOpenArtStudio: none, onNewImage: none,
            onNewProject: none, onOpenProject: (_) async {}, onVault: none, onResearch: none,
          ),
        ),
      ),
    ),
  );
}
