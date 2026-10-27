// Lane brain-visual (2026-10-25): the eleven regions of the glowing brain, with real counts; flying to a region by
// touch, VoiceOver, voice or typing; each region a semantics node that opens its own page of real records; Memory
// Details linking back to the screen a record came from (or saying plainly there is none); and CONNECTION_CREATED
// ledger events in Live Activity. Sample records only (the shape the phone replica hands over).
import 'dart:ui' show PictureRecorder;

import 'package:chey/brain/che_brain_overview.dart';
import 'package:chey/brain/che_brain_regions.dart';
import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_brain_overview_fixture.dart';

Map<String, dynamic> _connection(String id, String from, String to, String fromTitle, String toTitle, {Duration ago = const Duration(minutes: 1)}) => {
      'brain_event_id': id,
      'event_type': 'CONNECTION_CREATED',
      'title': '$fromTitle ↔ $toTitle',
      'category': 'General Knowledge',
      'subcategory': 'Research',
      'ms': cheTestNow.subtract(ago).millisecondsSinceEpoch,
      'time': 'Today · 3:59 PM',
      'status': 'Candidate link',
      'record_id': 'link:$id',
      'detail': {'from_id': from, 'to_id': to, 'from_title': fromTitle, 'to_title': toTitle, 'reason': 'shared words (red, outfit)', 'status': 'candidate', 'origin': 'brain_relations'},
    };

Map<String, dynamic> _ledgerWithConnections() => {
      ...cheTestLedger(),
      'connections': [
        _connection('be_c1', 'mem:red', 'conv:outfits', 'You prefer red over blue for outfits', 'Red or blue outfit, which is better?'),
        _connection('be_c2', 'cloud:only', 'know:3', 'A note only in the cloud', 'Futures chart fact 3', ago: const Duration(minutes: 9)),
      ],
    };

Future<void> _pump(WidgetTester tester, Widget child) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: MediaQuery(data: const MediaQueryData(size: Size(440, 956), disableAnimations: true), child: Scaffold(backgroundColor: Colors.black, body: child)),
  ));
  await tester.pump();
}

void main() {
  group('eleven regions from the real records', () {
    test('eleven named regions; the nine domains partition the records; Verified counts across them', () {
      expect(CheBrainRegion.values.length, 11);
      final dots = cheTestDots();
      final counts = cheBrainRegionCounts(dots);
      final domains = CheBrainRegion.values.where((r) => r != CheBrainRegion.verified).fold<int>(0, (a, r) => a + counts[r]!);
      expect(domains, dots.length);
      for (final r in CheBrainRegion.values) {
        expect(cheBrainRegionRecords(r, dots).length, counts[r], reason: '${r.label}: the page lists exactly the counted records');
      }
      expect(counts[CheBrainRegion.research], 1, reason: 'the REA investigation sits in Research, not Knowledge');
      expect(cheBrainRegionOf(dots.firstWhere((d) => d.id == 'note:rea')), CheBrainRegion.research);
      expect(cheBrainRegionCounts(const []).values.every((n) => n == 0), isTrue, reason: 'no records: every region is zero');
    });

    test('region names parse by word or number, typed or spoken', () {
      expect(cheBrainRegionFromWords('memory'), CheBrainRegion.memories);
      expect(cheBrainRegionFromWords('the trading region'), CheBrainRegion.trading);
      expect(cheBrainRegionFromWords('region 4'), CheBrainRegion.research);
      expect(cheBrainRegionFromWords('region number eleven'), CheBrainRegion.errors);
      expect(cheBrainRegionFromWords('region 12'), isNull);
      expect(cheBrainRegionFromWords('kitchen'), isNull);
      final spoken = cheBrainRegionsSpoken(cheBrainRegionCounts(cheTestDots()));
      expect(spoken, startsWith('1, Memories: 2 records'));
      expect(spoken, contains('11, Errors: 1 record'));
    });

    test('voice phrases: regions, fly, open and rotate; anything else is not a region command', () {
      expect(CheBrainCommand.parse('go to memory region')?.region, CheBrainRegion.memories);
      expect(CheBrainCommand.parse('CHE, fly to the coding region')?.action, CheBrainAction.region);
      expect(CheBrainCommand.parse('take me to region 6')?.region, CheBrainRegion.trading);
      expect(CheBrainCommand.parse('show me the agents region')?.region, CheBrainRegion.agents);
      final open = CheBrainCommand.parse('open the trading region');
      expect(open?.action, CheBrainAction.openRegion);
      expect(open?.region, CheBrainRegion.trading);
      expect(CheBrainCommand.parse('list the records in the memory region')?.action, CheBrainAction.openRegion);
      expect(CheBrainCommand.parse('list the brain regions')?.action, CheBrainAction.regions);
      expect(CheBrainCommand.parse('what regions are there')?.action, CheBrainAction.regions);
      expect(CheBrainCommand.parse('rotate the brain left')?.direction, 'left');
      expect(CheBrainCommand.parse('turn right')?.direction, 'right');
      expect(CheBrainCommand.parse('zoom out')?.action, CheBrainAction.zoomOut, reason: 'the existing zoom phrases still work');
      expect(CheBrainCommand.parse('go to the kitchen region'), isNull);
      expect(CheBrainCommand.parse('open the pod bay doors'), isNull);
    });
  });

  group('3D navigation over the regions', () {
    test('fly to a region: the camera targets its real centre, a halo marks it, CHE says its count and newest records', () {
      final c = CheBrainSpaceController(cheTestDots());
      final counts = cheBrainRegionCounts(cheTestDots());
      for (final r in CheBrainRegion.values) {
        expect(c.regionCounts[r] ?? 0, counts[r], reason: '${r.label} count in the brain matches the records');
      }
      final said = c.execute(CheBrainCommand.parse('go to the memory region')!);
      expect(said, startsWith('Memories region: 2 records. Newest: You prefer red over blue for outfits'));
      expect(c.focusedRegion, CheBrainRegion.memories);
      for (var i = 0; i < 60; i++) {
        c.tick(1 / 60);
      }
      expect((c.camera.target - c.regionCenters[CheBrainRegion.memories]!).length, lessThan(.01));
      expect(c.camera.distance, inInclusiveRange(5, 14));
      final empty = CheBrainSpaceController(cheTestDots().where((d) => cheBrainRegionOf(d) != CheBrainRegion.creative).toList());
      expect(empty.flyToRegion(CheBrainRegion.creative), contains('no records on this phone yet'));
      expect(empty.focusedRegion, isNull, reason: 'an empty region is never shown as if it held something');
      expect(c.execute(CheBrainCommand.parse('list the regions')!), contains('11 regions. 1, Memories: 2 records'));
      final yaw = c.camera.yaw;
      expect(c.execute(CheBrainCommand.parse('rotate the brain right')!), 'Turned the brain right.');
      for (var i = 0; i < 60; i++) {
        c.tick(1 / 60);
      }
      expect(c.camera.yaw, closeTo(yaw + 0.785398, .01));
      expect(c.execute(const CheBrainCommand(CheBrainAction.overview)), startsWith('Showing the whole brain'));
      expect(c.focusedRegion, isNull);
      expect(c.stepRegion(1), startsWith('Memories region'), reason: 'VoiceOver steps through regions that hold records');
      expect(c.stepRegion(1), startsWith('Conversations region'));
      c.dispose();
      empty.dispose();
    });

    test('the glowing renderer paints a very large brain under the node cap without errors', () {
      final dots = cheBuildMemoryDots(
        savedMemories: const [],
        memoryNotes: [for (var i = 0; i < 3000; i++) {'id': 'p$i', 'title': 'Note $i', 'body': 'body $i', 'kind': ['research', 'ml', ''][i % 3]}],
        learnedPersonality: const [],
        learnedKnowledge: const [],
      );
      final c = CheBrainSpaceController(dots);
      for (final cl in c.layout.clusters.values) {
        cl.expanded = true;
      }
      c.flyToRegion(CheBrainRegion.research);
      c.tick(1);
      final painter = CheBrainPainter(c);
      for (final at in [c.camera.copy(), CheBrainCamera(distance: 0)]) {
        c.camera
          ..target = at.target
          ..distance = at.distance;
        final recorder = PictureRecorder();
        painter.paint(Canvas(recorder), const Size(440, 956));
        recorder.endRecording().dispose();
      }
      expect(CheBrainPainter.maxDrawnNodes, lessThan(dots.length));
      c.dispose();
    });
  });

  group('the Brain Room', () {
    testWidgets('each region is a VoiceOver node with its name and count; it opens a page of its real records', (tester) async {
      final handle = tester.ensureSemantics();
      final c = CheBrainSpaceController(cheTestDots());
      await _pump(tester, CheBrainOverview(brain: CheBrainSpace(controller: c), dots: cheTestDots(), clock: () => cheTestNow));
      final counts = cheBrainRegionCounts(cheTestDots());
      for (final r in CheBrainRegion.values) {
        final n = counts[r]!;
        expect(find.bySemanticsLabel('${r.label} region: $n record${n == 1 ? '' : 's'}. Opens its records.'), findsOneWidget, reason: r.label);
      }
      final node = tester.getSemantics(find.byKey(const ValueKey('brain-region-trading')));
      expect(node.getSemanticsData().customSemanticsActionIds, isNotEmpty, reason: 'VoiceOver can fly to the region');
      await tester.tap(find.byKey(const ValueKey('brain-region-research')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-region-details-research')), findsOneWidget);
      expect(find.text('Research region'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('brain-region-record-note:rea')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-record-details')), findsOneWidget);
      expect(find.text('How BandLab layers tracks'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      handle.dispose();
      c.dispose();
    });

    testWidgets('an empty region says so; "Fly there" sends the neural brain to the region and reads the result', (tester) async {
      final spoken = <String>[];
      final c = CheBrainSpaceController(cheTestDots());
      await _pump(tester, CheBrainOverview(brain: CheBrainSpace(controller: c), dots: cheTestDots(), clock: () => cheTestNow, onReadAloud: (t) async => spoken.add(t)));
      expect(spoken, isEmpty, reason: 'opening the Brain Room is silent');
      await tester.tap(find.byKey(const ValueKey('brain-region-coding')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('brain-region-fly')));
      await tester.pumpAndSettle();
      expect(c.focusedRegion, CheBrainRegion.coding);
      expect(spoken.single, startsWith('Coding region: 1 record.'));
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await _pump(tester, CheBrainRegionDetails(region: CheBrainRegion.creative, dots: const [], now: cheTestNow));
      expect(find.textContaining('has no records on this phone yet'), findsOneWidget);
      expect(find.byKey(const ValueKey('brain-region-fly')), findsNothing);
    });

    testWidgets('voice: "go to the trading region" flies there, "open the trading region" opens its page', (tester) async {
      final c = CheBrainSpaceController(cheTestDots());
      await _pump(tester, CheBrainOverview(brain: CheBrainSpace(controller: c), dots: cheTestDots(), clock: () => cheTestNow));
      final space = CheBrainSpaceController.current!;
      expect(space.execute(CheBrainCommand.parse('go to the trading region')!), startsWith('Trading region: 2 records. Newest: BTC short setup analysed'));
      expect(space.focusedRegion, CheBrainRegion.trading);
      expect(space.execute(CheBrainCommand.parse('open the trading region')!), 'Opening the Trading region: 2 records, newest first.');
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-region-details-trading')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      expect(CheBrainSpaceController.regionOpener, isNull, reason: 'off screen, nothing opens region pages');
      c.dispose();
    });

    testWidgets('Memory Details: a trade opens its replay through the app route; a fact says it has no source screen', (tester) async {
      final opened = <CheBrainSourceLink>[];
      final spoken = <String>[];
      final dots = cheTestDots();
      final trade = dots.firstWhere((d) => d.id == 'trade:btc');
      await _pump(tester, CheBrainRecordDetails(dot: trade, onOpenSource: (l) async { opened.add(l); return true; }, onReadAloud: (t) async => spoken.add(t), now: cheTestNow));
      await tester.ensureVisible(find.byKey(const ValueKey('brain-source-trade')));
      await tester.tap(find.byKey(const ValueKey('brain-source-trade')));
      await tester.pumpAndSettle();
      expect(opened.single.kind, CheBrainSourceKind.trade);
      expect(opened.single.id, 'sim-btc-0042');
      expect(spoken.single, 'Open the replay of trade sim-btc-0042: opened.');

      final task = dots.firstWhere((d) => d.id == 'task:edit');
      expect(cheBrainSourceLinksOf(task).map((l) => l.kind), contains(CheBrainSourceKind.agentDesk));
      expect(cheBrainSourceLinksOf(dots.firstWhere((d) => d.id == 'conv:outfits')).single.kind, CheBrainSourceKind.conversation);

      await _pump(tester, CheBrainRecordDetails(dot: dots.firstWhere((d) => d.id == 'know:1'), onOpenSource: (l) async => true, now: cheTestNow));
      await tester.ensureVisible(find.byKey(const ValueKey('brain-source-none')));
      expect(find.text(cheBrainNoSourceScreen), findsOneWidget);

      // A route that fails is reported as a failure, never as opened.
      spoken.clear();
      await _pump(tester, CheBrainRecordDetails(dot: task, onOpenSource: (l) async => false, onReadAloud: (t) async => spoken.add(t), now: cheTestNow));
      await tester.ensureVisible(find.byKey(const ValueKey('brain-source-agentDesk')));
      await tester.tap(find.byKey(const ValueKey('brain-source-agentDesk')));
      await tester.pumpAndSettle();
      expect(spoken.single, startsWith('I could not open that screen'));
    });

    testWidgets('Live Activity shows CONNECTION_CREATED events from the ledger; each opens the connection and its records', (tester) async {
      final spoken = <String>[];
      await _pump(tester, CheBrainOverview(
        brain: const SizedBox(),
        dots: cheTestDots(),
        initialSection: CheBrainNav.activity,
        loadLearning: () async => _ledgerWithConnections(),
        clock: () => cheTestNow,
        onReadAloud: (t) async => spoken.add(t),
      ));
      await tester.pumpAndSettle();
      expect(spoken, isEmpty, reason: 'new connections never speak on their own');
      expect(find.byKey(const ValueKey('brain-connection-be_c1')), findsOneWidget);
      expect(find.text('You prefer red over blue for outfits  ↔  Red or blue outfit, which is better?'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('brain-activity-connections')));
      await tester.tap(find.byKey(const ValueKey('brain-activity-connections')));
      await tester.pump();
      expect(find.byKey(const ValueKey('brain-connection-be_c2')), findsOneWidget);
      expect(find.byKey(const ValueKey('brain-record-mem:red')), findsNothing, reason: 'the Connections filter shows ledger connections only');
      await tester.tap(find.byKey(const ValueKey('brain-connection-be_c2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-connection-details')), findsOneWidget);
      expect(find.text('shared words (red, outfit)'), findsOneWidget);
      expect(find.textContaining('not on this phone yet'), findsOneWidget, reason: 'a record only in the cloud says so');
      await tester.tap(find.byKey(const ValueKey('brain-connection-side-know:3')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-record-details')), findsOneWidget);
      expect(find.text('Futures chart fact 3'), findsWidgets);
    });

    test('ledger parsing keeps only complete connection rows', () {
      final l = CheBrainLearning.fromLedger(_ledgerWithConnections(), fetchedAt: cheTestNow);
      expect(l.connections.map((c) => c.id), ['be_c1', 'be_c2']);
      expect(l.events.any((e) => e.eventType == 'CONNECTION_CREATED'), isFalse);
      expect(CheBrainConnectionEvent.fromLedger({'event_type': 'CONNECTION_CREATED', 'brain_event_id': 'x', 'ms': 1, 'detail': {'from_id': 'a'}}), isNull);
      expect(CheBrainConnectionEvent.fromLedger({'event_type': 'KNOWLEDGE_SAVED'}), isNull);
      expect(cheBrainDotForNodeId('know:3', cheTestDots())?.id, 'know:3');
      expect(cheBrainDotForNodeId('nowhere', cheTestDots()), isNull);
      expect(SemanticsFlag.isButton, isNotNull);
    });
  });
}
