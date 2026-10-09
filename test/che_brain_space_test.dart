import 'dart:math' as math;
import 'dart:ui' show PictureRecorder;

import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/che_ui/che_agent_chat.dart';
import 'package:chey/che_ui/che_backend.dart';
import 'package:chey/che_ui/che_brain.dart';
import 'package:chey/home/che_insights_room.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:chey/platform/che_platform_models.dart';
import 'package:chey/platform/che_platform_screens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vector_math/vector_math.dart' as vm;

/// Real-shaped memory input, exactly as the app builds it.
List<CheMemoryDot> _memories({int extraResearch = 0}) => cheBuildMemoryDots(
      savedMemories: const ['Owner prefers voice replies and large text', 'Owner trades ES futures on NinjaTrader'],
      memoryRecords: const [
        {'id': 'r1', 'text': 'TradeSea login uses email and a one-time code', 'category': 'Memory', 'importance': 5},
        {'id': 'r2', 'text': 'The TradeSea trading area was blank inside CHE', 'category': 'Research', 'importance': 4},
      ],
      memoryNotes: [
        {'id': 'n1', 'title': 'Supabase memory database', 'body': 'Long-term memory uses Supabase with pgvector', 'kind': 'research'},
        {'id': 'n2', 'title': 'Clustering notes', 'body': 'Memories cluster by topic', 'kind': 'ml', 'cluster_id': 'c1'},
        {'id': 'n3', 'title': 'Cluster peer', 'body': 'Same cluster as the clustering notes', 'kind': 'ml', 'cluster_id': 'c1'},
        for (var i = 0; i < extraResearch; i++) {'id': 'x$i', 'title': 'Research item $i', 'body': 'Study note number $i', 'kind': 'research'},
      ],
      learnedPersonality: const [{'statement': 'Prefers short spoken answers'}],
      learnedKnowledge: const ['Futures on free charts are delayed about ten minutes'],
      suggestions: const ['Add the Cerebras key for faster engineering'],
    );

const _phone = Size(440, 956); // iPhone 17 Pro Max, logical points.

Widget _brainScreen(List<CheMemoryDot> dots, {double textScale = 1.0, List<String>? spoken}) {
  final brain = CheBrain();
  final log = CheAgentController(brain: brain, backend: CheBackend.fromStream((_) => const Stream.empty()));
  return MaterialApp(
    home: MediaQuery(
      data: const MediaQueryData(size: _phone, padding: EdgeInsets.only(top: 62, bottom: 34), viewPadding: EdgeInsets.only(top: 62, bottom: 34)).copyWith(textScaler: TextScaler.linear(textScale)),
      child: Scaffold(
        body: SafeArea(
          child: CheTwoBrainsView(
            live: CheInsightsRoom(
              brain: brain,
              log: log,
              map: CheMemoryBrainRoom(dots: dots, onReadAloud: (t) async => spoken?.add(t)),
            ),
            offline: const SizedBox(),
          ),
        ),
      ),
    ),
  );
}

void _usePhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1320, 2868);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  group('real memories only', () {
    test('every node is a real memory; nothing is invented', () {
      final dots = _memories();
      final layout = CheBrainLayout.build(dots);
      expect(layout.nodes.map((n) => n.id).toSet(), dots.map((d) => d.id).toSet());
      expect(layout.nodes.length, dots.length);
      expect(CheBrainLayout.build(const []).nodes, isEmpty);
    });

    test('categories become brain regions; related memories connect', () {
      final layout = CheBrainLayout.build(_memories());
      final research = layout.clusters['Research']!;
      final ml = layout.clusters['ML Learning']!;
      expect(research.center.distanceTo(ml.center), greaterThan(3));
      // Memories fill one brain but lean toward their own region.
      var own = 0.0, other = 0.0, others = 0;
      for (final n in layout.nodes) {
        own += n.position.distanceTo(layout.clusters[n.cluster]!.center);
        for (final c in layout.clusters.values) {
          if (c.name == n.cluster) continue;
          other += n.position.distanceTo(c.center);
          others++;
        }
      }
      expect(own / layout.nodes.length, lessThan(other / others));
      final a = layout.byId['n2']!, b = layout.byId['n3']!;
      expect(layout.edges.any((e) => (e.$1 == a && e.$2 == b) || (e.$1 == b && e.$2 == a)), isTrue, reason: 'same ML cluster');
    });

    test('only huge categories (over 1,500) start collapsed; the whole brain shows by default', () {
      final layout = CheBrainLayout.build(_memories(extraResearch: 1500));
      expect(layout.clusters['Research']!.expanded, isFalse);
      expect(layout.clusters['Memory']!.expanded, isTrue);
    });

    test('every memory sits inside one brain-shaped volume', () {
      final layout = CheBrainLayout.build(_memories(extraResearch: 300));
      for (final n in layout.nodes) {
        expect(cheBrainShape(n.position), lessThan(1), reason: n.id);
      }
    });

    test('memory time reads like the picture: "Apr 12, 2024 • 4:32 PM"', () {
      expect(cheMemoryWhen(DateTime(2024, 4, 12, 16, 32)), 'Apr 12, 2024 • 4:32 PM');
      expect(cheMemoryWhen(DateTime(2024, 1, 2, 0, 5)), 'Jan 2, 2024 • 12:05 AM');
    });

    test('search finds the memory by its words', () {
      final layout = CheBrainLayout.build(_memories());
      expect(layout.find('tradesea login')!.id, 'r1');
      expect(layout.find('supabase')!.id, 'n1');
      expect(layout.find('zz'), isNull);
    });

    test('live agent tasks get their own Agents lobe with real status', () {
      final dots = cheBuildMemoryDots(
        savedMemories: const [],
        memoryNotes: const [
          {
            'id': 'agent-task-abc',
            'title': 'Atlas · Scout public research on neural interfaces',
            'body': 'Status: running. Atlas is working on: Scout public research on neural interfaces',
            'kind': 'agent_task',
            'region': 'Office Agents',
            'agent': 'Atlas',
            'status': 'running',
            'task_id': 'abc',
          },
        ],
        learnedPersonality: const [],
        learnedKnowledge: const [],
      );
      expect(dots, hasLength(1));
      expect(dots.first.category, 'Agents');
      expect(dots.first.source, 'Atlas');
      final layout = CheBrainLayout.build(dots);
      expect(layout.clusters['Agents'], isNotNull);
      expect(layout.byId['agent-task-abc'], isNotNull);
      expect(cheBrainShape(layout.nodes.single.position), lessThan(1));
    });
  });

  group('camera', () {
    test('overview sees the whole brain; inside stands at the center looking out', () {
      final cam = CheBrainCamera();
      expect(cam.project(vm.Vector3.zero(), _phone)!.offset.dx, closeTo(_phone.width / 2, .01));
      for (final p in [vm.Vector3(9, 0, 0), vm.Vector3(-9, 0, 0), vm.Vector3(0, 0, 9), vm.Vector3(0, 0, -9)]) {
        expect(cam.project(p, _phone), isNotNull, reason: 'whole brain in view: $p');
      }
      cam.zoom(1000);
      expect(cam.distance, 0);
      expect(cam.inside, isTrue);
      expect(cam.eye.distanceTo(vm.Vector3.zero()), lessThan(1e-9));
      final ahead = cam.forward * 5, behind = cam.forward * -5;
      expect(cam.project(ahead, _phone), isNotNull);
      expect(cam.project(behind, _phone), isNull, reason: 'culled behind the viewer');
      cam.rotate(math.pi, 0);
      expect(cam.project(behind, _phone), isNotNull, reason: 'turning around shows what was behind');
    });

    test('screen point ↔ world point round-trip (dragging an orb)', () {
      final cam = CheBrainCamera(distance: 12);
      final world = cam.unproject(const Offset(300, 200), 10, _phone);
      final back = cam.project(world, _phone)!;
      expect(back.offset.dx, closeTo(300, .01));
      expect(back.offset.dy, closeTo(200, .01));
    });
  });

  group('voice', () {
    test('commands', () {
      expect(CheBrainCommand.parse('CHE, open my brain')!.action, CheBrainAction.open);
      expect(CheBrainCommand.parse('Take me inside.')!.action, CheBrainAction.inside);
      final f = CheBrainCommand.parse('show my research memories')!;
      expect(f.action, CheBrainAction.filter);
      expect(f.category, 'Research');
      final q = CheBrainCommand.parse('Find my memory about the TradeSea login')!;
      expect(q.action, CheBrainAction.find);
      expect(q.query, 'the tradesea login');
      expect(CheBrainCommand.parse('open this memory')!.action, CheBrainAction.openSelected);
      expect(CheBrainCommand.parse('expand this cluster')!.action, CheBrainAction.expand);
      expect(CheBrainCommand.parse('back out')!.action, CheBrainAction.backOut);
      expect(CheBrainCommand.parse('show the whole brain')!.action, CheBrainAction.overview);
      for (final other in ['open YouTube', 'show me Tesla', 'what do you remember', 'tell me a joke']) {
        expect(CheBrainCommand.parse(other), isNull, reason: other);
      }
    });

    test('commands act on real memories and say what happened', () {
      final c = CheBrainSpaceController(_memories(extraResearch: 60));
      expect(c.execute(CheBrainCommand.parse('find my memory about tradesea login')!), startsWith('Found it. TradeSea login uses email'));
      expect(c.selectedId, 'r1');
      for (var i = 0; i < 60; i++) {
        c.tick(1 / 60);
      }
      expect(c.camera.target.distanceTo(c.layout.node('r1')!.position), lessThan(.01), reason: 'flew to it');
      expect(c.execute(const CheBrainCommand(CheBrainAction.openSelected)), contains('TradeSea login uses email and a one-time code'));
      expect(c.cardOpen, isTrue);
      expect(c.execute(CheBrainCommand.parse('show my research memories')!), 'Showing your Research memories: 62.');
      expect(c.layout.clusters['Research']!.expanded, isTrue, reason: 'filtering a collapsed cluster opens it');
      expect(c.execute(const CheBrainCommand(CheBrainAction.inside)), contains('center of my brain'));
      for (var i = 0; i < 60; i++) {
        c.tick(1 / 60);
      }
      expect(c.camera.inside, isTrue);
      expect(c.execute(const CheBrainCommand(CheBrainAction.overview)), startsWith('Showing the whole brain'));
      for (var i = 0; i < 60; i++) {
        c.tick(1 / 60);
      }
      expect(c.camera.distance, CheBrainCamera.overview);
      c.dispose();
    });

    List<CheMemoryDot> agentDots() => cheBuildMemoryDots(
          savedMemories: const [],
          memoryNotes: const [
            {
              'id': 'agent-task-a1',
              'title': 'Atlas · Scout public research on neural interfaces',
              'body': 'Status: running. Atlas is working on: Scout public research on neural interfaces',
              'kind': 'agent_task',
              'region': 'Office Agents',
              'agent': 'Atlas',
              'status': 'running',
              'task_id': 'a1',
            },
            {
              'id': 'agent-task-m1',
              'title': 'Mira · Draft support copy for the new release',
              'body': 'Status: queued. Mira is working on: Draft support copy for the new release',
              'kind': 'agent_task',
              'region': 'Office Agents',
              'agent': 'Mira',
              'status': 'queued',
              'task_id': 'm1',
            },
          ],
          learnedPersonality: const [],
          learnedKnowledge: const [],
        );

    test('agent-status commands parse to the crew member', () {
      expect(CheBrainCommand.parse('what is Atlas working on')!.agent, 'atlas');
      expect(CheBrainCommand.parse('CHE, show me what Nova is doing')!.agent, 'nova');
      expect(CheBrainCommand.parse('is Knox busy')!.agent, 'knox');
      final all = CheBrainCommand.parse('who is working')!;
      expect(all.action, CheBrainAction.agentStatus);
      expect(all.agent, isNull);
      for (final other in ['what is the weather', 'what is Atlas', 'show me Tesla', 'who is Atlas']) {
        expect(CheBrainCommand.parse(other), isNull, reason: other);
      }
    });

    test('agent status is spoken from live orbs, honestly when idle', () {
      final c = CheBrainSpaceController(agentDots());
      final status = c.execute(CheBrainCommand.parse('what is Atlas working on')!);
      expect(status, contains('Atlas is working on:'));
      expect(status, contains('Status: running'));
      expect(c.selectedId, 'agent-task-a1', reason: 'camera flies to the live orb');
      expect(c.execute(CheBrainCommand.parse('who is working')!), contains('Atlas'));
      expect(c.execute(CheBrainCommand.parse('who is working')!), contains('Mira'));
      expect(c.execute(CheBrainCommand.parse('what is Sage working on')!), 'Sage has no live work in the brain right now.');
      final empty = CheBrainSpaceController(_memories());
      expect(empty.execute(CheBrainCommand.parse('who is working')!), 'No agent has live work in the brain right now.');
      expect(empty.execute(CheBrainCommand.parse('what is Atlas working on')!), 'Atlas has no live work in the brain right now.');
      c.dispose();
      empty.dispose();
    });

    test('agent work filters to its own lobe in its own color', () {
      final c = CheBrainSpaceController(agentDots());
      expect(c.execute(CheBrainCommand.parse('show agent memories')!), 'Showing your Agents memories: 2.');
      expect(cheMemoryCategoryColor('Agents'), const Color(0xFFFFB54D));
      c.dispose();
    });
  });

  group('screen (iPhone 17 Pro Max, large accessibility text)', () {
    for (final scale in [1.0, 1.6, 2.4]) {
      testWidgets('no overflow, one-line title, visualization gets most of the screen (text ×$scale)', (tester) async {
        _usePhone(tester);
        await tester.pumpWidget(_brainScreen(_memories(), textScale: scale));
        await tester.pump(const Duration(milliseconds: 50));
        expect(tester.takeException(), isNull);

        // "Brain constellation" and "CHE Brain — Live" are single lines.
        for (final text in ['Brain constellation', 'CHE Brain — Live']) {
          final para = tester.renderObject<RenderParagraph>(find.byWidgetPredicate((w) =>
              (w is RichText && w.text.toPlainText().startsWith(text))));
          expect(para.maxLines, 1, reason: text);
          expect(para.size.height, lessThan(32), reason: '$text never wraps into a tall block');
        }

        // The 3D space is the majority of the screen.
        final canvas = tester.getRect(find.byKey(const ValueKey('che-brain-canvas')));
        expect(canvas.height / _phone.height, greaterThan(.7), reason: 'space ${canvas.height} of ${_phone.height}');

        // Nothing overlaps at the bottom: the Soul/Log chips sit over the
        // space, and no other control shares their spot.
        expect(find.text('Read selected memory'), findsNothing);
        expect(find.text('Full brain view'), findsNothing);
        final chips = tester.getRect(find.text('Log'));
        expect(chips.bottom, lessThanOrEqualTo(_phone.height - 34));
        await tester.pumpWidget(const SizedBox());
      });
    }

    testWidgets('search and filters are collapsed until asked for', (tester) async {
      _usePhone(tester);
      await tester.pumpWidget(_brainScreen(_memories()));
      await tester.pump();
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(FilterChip), findsNothing);
      await tester.tap(find.byTooltip('Filter by category'));
      await tester.pump();
      expect(find.byType(FilterChip), findsWidgets);
      expect(find.bySemanticsLabel(RegExp(r'^Memory memories, 3')), findsOneWidget);
      await tester.tap(find.byTooltip('Find a memory'));
      await tester.pump();
      expect(find.byType(FilterChip), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('gestures', () {
    late CheBrainSpaceController c;
    late List<String> spoken;

    Future<Rect> pumpSpace(WidgetTester tester, {int extraResearch = 0}) async {
      _usePhone(tester);
      spoken = [];
      c = CheBrainSpaceController(_memories(extraResearch: extraResearch));
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheBrainSpace(controller: c, onSpeak: spoken.add))));
      await tester.pump();
      return tester.getRect(find.byKey(const ValueKey('che-brain-canvas')));
    }

    Offset screenOf(Rect area, String id) => area.topLeft + c.camera.project(c.layout.node(id)!.position, area.size)!.offset;

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 50; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
    }

    testWidgets('inside the hub (swipeable tabs) a one-finger drag orbits instead of changing tabs', (tester) async {
      _usePhone(tester);
      c = CheBrainSpaceController(_memories());
      final tabs = TabController(length: 2, vsync: const TestVSync());
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: TabBarView(controller: tabs, children: [CheBrainSpace(controller: c), const Text('Trading')]))));
      await tester.pump();
      final yaw = c.camera.yaw;
      final area = tester.getRect(find.byKey(const ValueKey('che-brain-canvas')));
      await tester.dragFrom(area.center, const Offset(-200, 0));
      await tester.pump(const Duration(milliseconds: 400));
      expect(tabs.index, 0);
      expect(tabs.offset, 0);
      expect(c.camera.yaw, isNot(closeTo(yaw, .01)));
      await tester.pumpWidget(const SizedBox());
      tabs.dispose();
      c.dispose();
    });

    testWidgets('one-finger drag orbits; pinch travels inside to the center; spread backs out', (tester) async {
      final area = await pumpSpace(tester);
      final yaw = c.camera.yaw;
      await tester.dragFrom(area.center, const Offset(-120, 0));
      await tester.pump();
      expect(c.camera.yaw, isNot(closeTo(yaw, .01)));

      // Pinch (fingers apart = deeper) all the way in.
      for (var i = 0; i < 4; i++) {
        final a = await tester.startGesture(area.center - const Offset(20, 0));
        final b = await tester.startGesture(area.center + const Offset(20, 0));
        for (var s = 1; s <= 6; s++) {
          await a.moveBy(const Offset(-25, 0));
          await b.moveBy(const Offset(25, 0));
          await tester.pump();
        }
        await a.up();
        await b.up();
        await tester.pump();
      }
      expect(c.camera.inside, isTrue, reason: 'distance ${c.camera.distance}');
      expect(spoken.last, contains('Inside my brain'));

      // Fingers together = back out.
      final a = await tester.startGesture(area.center - const Offset(150, 0));
      final b = await tester.startGesture(area.center + const Offset(150, 0));
      for (var s = 1; s <= 6; s++) {
        await a.moveBy(const Offset(22, 0));
        await b.moveBy(const Offset(-22, 0));
        await tester.pump();
      }
      await a.up();
      await b.up();
      await tester.pump();
      expect(c.camera.inside, isFalse);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('tap selects and flies to a memory and says it; tap again opens the card; tap empty space closes', (tester) async {
      final area = await pumpSpace(tester);
      await tester.tapAt(screenOf(area, 'r1'));
      await tester.pump();
      expect(c.selectedId, 'r1');
      expect(spoken.last, startsWith('TradeSea login uses email'));
      await settle(tester);
      expect(c.camera.distance, closeTo(3.4, .01));
      await tester.tapAt(screenOf(area, 'r1'));
      await tester.pump();
      expect(c.cardOpen, isTrue);
      expect(find.text('TradeSea login uses email and a one-time code'), findsWidgets);
      expect(find.text('Related'), findsOneWidget);
      await tester.tapAt(area.topLeft + const Offset(4, 4));
      await tester.pump();
      expect(c.cardOpen, isFalse);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('a selected memory shows a callout with its title, date and time; tapping it opens the memory', (tester) async {
      final area = await pumpSpace(tester);
      await tester.tapAt(screenOf(area, 'r1'));
      await tester.pump();
      await settle(tester);
      final callout = find.bySemanticsLabel(RegExp(r'^TradeSea login uses email.*Open this memory\.$'));
      expect(callout, findsOneWidget);
      await tester.tap(callout);
      await tester.pump();
      expect(c.cardOpen, isTrue);
      expect(callout, findsNothing, reason: 'the full card replaces the callout');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('tapping a collapsed cluster expands it; the card can collapse it again', (tester) async {
      final area = await pumpSpace(tester, extraResearch: 1500);
      final cluster = c.layout.clusters['Research']!;
      expect(cluster.expanded, isFalse);
      final at = area.topLeft + c.camera.project(cluster.center, area.size)!.offset;
      await tester.tapAt(at);
      await tester.pump();
      expect(cluster.expanded, isTrue);
      expect(spoken.last, 'Research cluster expanded: 1502 memories.');
      await settle(tester);
      c.select(c.layout.node('x1')!, fly: false);
      c.openSelected();
      await tester.pump();
      await tester.ensureVisible(find.text('Collapse Research'));
      await tester.pump();
      await tester.tap(find.text('Collapse Research'));
      await tester.pump();
      expect(cluster.expanded, isFalse);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('long-press grabs an orb and drags it through space', (tester) async {
      final area = await pumpSpace(tester);
      final start = screenOf(area, 'n1');
      final before = c.layout.node('n1')!.position.clone();
      final g = await tester.startGesture(start);
      await tester.pump(const Duration(milliseconds: 600));
      expect(c.grabbedId, 'n1');
      expect(spoken.last, startsWith('Holding Supabase memory database'));
      await g.moveBy(const Offset(60, 40));
      await tester.pump();
      await g.up();
      await tester.pump();
      expect(c.grabbedId, isNull);
      final after = c.layout.node('n1')!.position;
      expect(after.distanceTo(before), greaterThan(.3));
      final now = screenOf(area, 'n1');
      expect((now - (start + const Offset(60, 40))).distance, lessThan(2), reason: 'it follows the finger');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('VoiceOver: one label with actions to step, open, go inside and back out', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpSpace(tester);
      final node = tester.getSemantics(find.byKey(const ValueKey('che-brain-canvas')));
      expect(node.label, contains('real memories'));
      final actions = node.getSemanticsData().customSemanticsActionIds!.map((id) => CustomSemanticsAction.getAction(id)!.label).toSet();
      expect(actions, containsAll(['Next memory', 'Previous memory', 'Open selected memory', 'Go inside the brain', 'Show the whole brain']));
      expect(c.step(1), contains('TradeSea login uses email'), reason: 'most important memory first');
      handle.dispose();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  });

  test('performance: 2,000 real-shaped memories paint in one batched pass, well inside a frame', () {
    final dots = cheBuildMemoryDots(
      savedMemories: const [],
      memoryNotes: [
        for (var i = 0; i < 2000; i++)
          {'id': 'p$i', 'title': 'Note $i topic${i % 37}', 'body': 'body text word${i % 53} other${i % 11}', 'kind': ['research', 'ml', 'translate', ''][i % 4]},
      ],
      learnedPersonality: const [],
      learnedKnowledge: const [],
    );
    final c = CheBrainSpaceController(dots);
    for (final cl in c.layout.clusters.values) {
      cl.expanded = true;
    }
    final painter = CheBrainPainter(c);
    const size = Size(440, 956);
    void frame() {
      final recorder = PictureRecorder();
      painter.paint(Canvas(recorder), size);
      recorder.endRecording().dispose();
    }
    frame(); // warm-up (sprite, labels)
    final sw = Stopwatch()..start();
    for (var i = 0; i < 20; i++) {
      c.camera.rotate(.02, 0);
      c.tick(1 / 120);
      frame();
    }
    sw.stop();
    final perFrame = sw.elapsedMicroseconds / 20 / 1000;
    debugPrint('BRAIN_FRAME_MS ${perFrame.toStringAsFixed(2)}');
    // Debug-mode JIT on a CI machine; a release build on the phone is far faster.
    expect(perFrame, lessThan(40), reason: '${perFrame.toStringAsFixed(1)} ms per frame for 2000 nodes');
    final hitSw = Stopwatch()..start();
    c.hit(const Offset(220, 478), size);
    expect(hitSw.elapsedMilliseconds, lessThan(20));
    c.dispose();
  });

  testWidgets('offline brain is the same brain in inverted colors', (tester) async {
    _usePhone(tester);
    await tester.pumpWidget(_brainScreen(_memories()));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(ColorFiltered), findsNothing);
    await tester.tap(find.bySemanticsLabel(cheBrainPresentations[1].title));
    await tester.pump(const Duration(milliseconds: 300));
    final filtered = tester.widget<ColorFiltered>(find.byType(ColorFiltered));
    expect(filtered.colorFilter, cheInvertColors);
    expect(find.descendant(of: find.byType(ColorFiltered), matching: find.byType(CheBrainSpace)), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  group('alive', () {
    test('never stands still: signals fire along real links and cascade', () {
      final c = CheBrainSpaceController(_memories(extraResearch: 20));
      final edges = {for (final e in c.layout.edges) e, for (final e in c.layout.edges) (e.$2, e.$1)};
      final start = c.livePosition(0).clone();
      var fired = 0;
      for (var i = 0; i < 240; i++) {
        expect(c.tick(1 / 60), isTrue, reason: 'keeps ticking with nothing touched');
        fired = math.max(fired, c.pulses.length);
        for (final p in c.pulses) {
          expect(edges.contains((p.from, p.to)), isTrue, reason: 'signals only travel real links');
        }
      }
      expect(fired, greaterThan(0));
      expect(c.livePosition(0).distanceTo(start), greaterThan(0), reason: 'memories drift like neurons');
      expect([for (var i = 0; i < c.layout.nodes.length; i++) c.flash(i)].any((f) => f > 0), isTrue);
      c.dispose();
    });

    test('Reduce Motion holds the brain still', () {
      final c = CheBrainSpaceController(_memories())..reduceMotion = true;
      final start = c.livePosition(0).clone();
      expect(c.tick(1 / 60), isFalse);
      expect(c.pulses, isEmpty);
      expect(c.livePosition(0), start);
      c.dispose();
    });

    test('a new conversation memory is born and fires into the memories it builds on', () {
      final c = CheBrainSpaceController(_memories());
      final first = {'id': 'a1', 'title': 'Backtest ES futures', 'body': 'You said: Backtest ES futures', 'at': '2026-10-04T10:00:00Z', 'links': <String>[]};
      final next = {'id': 'a2', 'title': 'ES futures results', 'body': 'You said: ES futures results', 'at': '2026-10-04T10:05:00Z', 'links': ['a1'], 'strength': 1};
      List<CheMemoryDot> dots(List<Map<String, dynamic>> conv) => cheBuildMemoryDots(
            savedMemories: const ['Owner trades ES futures on NinjaTrader'],
            memoryNotes: const [],
            learnedPersonality: const [],
            learnedKnowledge: const [],
            conversationMemories: conv,
          );
      c.update(dots([first]), const []);
      c.pulses.clear();
      c.update(dots([first, next]), const []);
      final born = c.layout.byId['conv:a2']!;
      final parent = c.layout.byId['conv:a1']!;
      expect(c.layout.edges.any((e) => {e.$1, e.$2}.containsAll({born, parent})), isTrue, reason: 'linked to the memory it builds on');
      expect(c.birthScale('conv:a2'), lessThan(.1), reason: 'grows in from nothing');
      expect(c.flash(born), 1);
      expect(c.pulses.any((p) => p.from == born && p.to == parent), isTrue);
      for (var i = 0; i < 90; i++) {
        c.tick(1 / 60);
      }
      expect(c.birthScale('conv:a2'), 1);
      expect(c.layout.nodes[born].dot.category, 'Conversations');
      c.dispose();
    });
  });
}
