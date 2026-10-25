// Brain Room UI cleanup (owner, 2026-10-25): the first glance is at most seven category regions with real counts;
// records appear only in one region sheet at a time (capped, paged, searchable); decoration is excluded from
// VoiceOver; reduced motion stops the animation; the activity rests after its awake cycles; empty and very large
// Brains render without an ErrorWidget; voice opens, reads and closes regions; a frame costs the same at any size.
import 'dart:ui' show PictureRecorder;

import 'package:chey/brain/che_brain_neural.dart';
import 'package:chey/brain/che_brain_overview.dart';
import 'package:chey/brain/che_brain_regions.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_brain_overview_fixture.dart';

Future<void> _pump(WidgetTester tester, {List<CheMemoryDot>? dots, bool still = false, List<String>? spoken}) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: MediaQuery(
      data: MediaQueryData(size: const Size(440, 956), disableAnimations: still),
      child: Scaffold(
        backgroundColor: Colors.black,
        body: CheBrainOverview(
          brain: const SizedBox(key: ValueKey('the-neural-brain')),
          dots: dots ?? cheTestDots(),
          clock: () => cheTestNow,
          onReadAloud: (t) async => spoken?.add(t),
        ),
      ),
    ),
  ));
  await tester.pump();
}

final _lobeButtons = find.byWidgetPredicate((w) => w is GestureDetector && w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('brain-lobe-') && !(w.key! as ValueKey<String>).value.contains('barrier'));

CheBrainNeuralPainter _painter(WidgetTester tester) => tester.widget<CustomPaint>(find.byKey(const ValueKey('brain-neural-paint'))).painter! as CheBrainNeuralPainter;

void main() {
  group('regions come only from the records', () {
    test('at most seven regions; they partition every record; verified and fresh are real counts', () {
      expect(CheBrainLobe.values.length, lessThanOrEqualTo(cheBrainLobeCap));
      final dots = cheTestDots();
      final s = cheBrainLobeStats(dots, now: cheTestNow);
      expect(s.length, CheBrainLobe.values.length);
      expect(s.values.fold<int>(0, (a, x) => a + x.count), dots.length, reason: 'every record sits in exactly one region');
      expect(s[CheBrainLobe.memory]!.count, 2);
      expect(s[CheBrainLobe.trading]!.count, 2);
      expect(s[CheBrainLobe.knowledge]!.count, 19, reason: '18 facts and the REA investigation (the Atlas trading card is Trading)');
      expect(s[CheBrainLobe.work]!.count, 3, reason: 'two tasks and a coding job; the failed task is under review');
      expect(s[CheBrainLobe.review]!.count, 1);
      expect(s.values.fold<int>(0, (a, x) => a + x.verified), cheBrainRegionCounts(dots)[CheBrainRegion.verified]);
      expect(s[CheBrainLobe.memory]!.fresh, 2, reason: '12 minutes and 3 hours ago are both within a day');
      final empty = cheBrainLobeStats(const [], now: cheTestNow);
      expect(empty.values.every((x) => x.count == 0 && x.verified == 0 && x.fresh == 0), isTrue, reason: 'nothing invented');
      final big = cheBrainLobeStats(cheLargeTestDots(6000), now: cheTestNow);
      expect(big.length, lessThanOrEqualTo(cheBrainLobeCap));
      expect(big.values.fold<int>(0, (a, x) => a + x.count), 6000);
    });

    test('region names parse by word or number; a record region maps to its region', () {
      expect(cheBrainLobeFromWords('the memory region'), CheBrainLobe.memory);
      expect(cheBrainLobeFromWords('agents & work'), CheBrainLobe.work);
      expect(cheBrainLobeFromWords('coding'), CheBrainLobe.work);
      expect(cheBrainLobeFromWords('region 3'), CheBrainLobe.knowledge);
      expect(cheBrainLobeFromWords('seven'), CheBrainLobe.review);
      expect(cheBrainLobeFromWords('region 8'), isNull);
      expect(cheBrainLobeFromWords('pizza'), isNull);
      for (final r in CheBrainRegion.values.where((r) => r != CheBrainRegion.verified)) {
        expect(cheBrainLobeOfRegion(r).regions, contains(r));
      }
    });

    test('voice phrases: open, read, close, constellation; only Brain words reach the Brain from elsewhere', () {
      final memory = CheBrainOverview.parse('open memory in the brain')!;
      expect(memory.lobe, CheBrainLobe.memory);
      expect(memory.explicitBrain, isTrue);
      final coding = CheBrainOverview.parse('open coding')!;
      expect(coding.lobe, CheBrainLobe.work);
      expect(coding.only, CheBrainRegion.coding);
      expect(coding.explicitBrain, isFalse, reason: '"open coding" off the Brain is not a Brain phrase');
      expect(CheBrainOverview.parse('open region 3')!.lobe, CheBrainLobe.knowledge);
      expect(CheBrainOverview.parse('open region 3')!.only, isNull);
      expect(CheBrainOverview.parse("what's in the brain")!.summary, isTrue);
      expect(CheBrainOverview.parse("what's in the brain")!.explicitBrain, isTrue);
      expect(CheBrainOverview.parse('go back')!.close, isTrue);
      expect(CheBrainOverview.parse('show the constellation')!.constellation, isTrue);
      expect(CheBrainOverview.parse('show the brain regions')!.constellation, isFalse);
      expect(CheBrainOverview.parse('open live activity')!.section, CheBrainNav.activity, reason: 'sections still open');
      expect(CheBrainOverview.parse('open the pod bay doors'), isNull);
    });
  });

  group('the first glance', () {
    testWidgets('seven region buttons, each labelled with name, count and meaning; the decoration has no semantics', (tester) async {
      final handle = tester.ensureSemantics();
      await _pump(tester);
      expect(_lobeButtons, findsNWidgets(7));
      final stats = cheBrainLobeStats(cheTestDots(), now: cheTestNow);
      for (final l in CheBrainLobe.values) {
        final label = cheBrainLobeSemantics(l, stats[l]!);
        expect(label, startsWith('${l.label} region, ${stats[l]!.count} record'));
        expect(label, contains(l.meaning));
        expect(find.bySemanticsLabel(label), findsOneWidget, reason: l.label);
      }
      expect(
        find.ancestor(of: find.byKey(const ValueKey('brain-neural-paint')), matching: find.byWidgetPredicate((w) => w is ExcludeSemantics && w.excluding)),
        findsWidgets,
        reason: 'the painted brain, neurons and pulses are decoration',
      );
      expect(find.byKey(const ValueKey('brain-dashboard')), findsNothing);
      expect(find.byKey(const ValueKey('brain-learning')), findsNothing);
      expect(find.byKey(const ValueKey('the-neural-brain')), findsNothing, reason: 'the record node cloud is not the first glance');
      handle.dispose();
    });

    testWidgets('reduced motion: nothing animates; the brain is drawn still', (tester) async {
      await _pump(tester, still: true);
      expect(_painter(tester).still, isTrue);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse, reason: 'no frame is asked for while animations are disabled');
    });

    testWidgets('with motion: one clock runs, then rests on a still frame after its awake cycles; a tap wakes it', (tester) async {
      await _pump(tester);
      expect(_painter(tester).still, isFalse);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
      for (var i = 0; i < 32; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(_painter(tester).still, isTrue, reason: 'rests after five 6-second cycles');
      expect(tester.binding.hasScheduledFrame, isFalse);
      await tester.tap(find.byKey(const ValueKey('brain-lobe-memory')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('brain-lobe-close')));
      await tester.pump();
      expect(_painter(tester).still, isFalse, reason: 'a touch wakes it');
    });

    testWidgets('empty, undated and very large Brains render without an ErrorWidget', (tester) async {
      for (final dots in [
        <CheMemoryDot>[],
        cheBuildMemoryDots(savedMemories: const [], memoryNotes: const [], learnedPersonality: const [], learnedKnowledge: const [], brainRecords: [
          {'id': 'x', 'title': '', 'region': '', 'kind': ''},
        ]),
        cheLargeTestDots(20000),
      ]) {
        await _pump(tester, dots: dots);
        expect(find.byType(ErrorWidget), findsNothing);
        expect(tester.takeException(), isNull);
        expect(_lobeButtons, findsNWidgets(7), reason: '${dots.length} records still show seven regions');
        await tester.tap(find.byKey(const ValueKey('brain-lobe-knowledge')));
        await tester.pump();
        expect(find.byType(ErrorWidget), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      }
    });
  });

  group('drill-down: one sheet at a time', () {
    testWidgets('a region opens one sheet; another replaces it; the barrier, the back button, voice and system back close it', (tester) async {
      final spoken = <String>[];
      await _pump(tester, spoken: spoken);
      await tester.tap(find.byKey(const ValueKey('brain-lobe-memory')));
      await tester.pump();
      expect(find.byType(CheBrainLobeSheet), findsOneWidget);
      expect(find.text('You prefer red over blue for outfits'), findsOneWidget);
      expect(CheBrainOverview.chromeHidden.value, isTrue, reason: 'the room chips hide under an open sheet');
      expect(spoken, isEmpty, reason: 'opening a region by touch is silent');

      final voice = CheBrainOverview.voiceHandler!;
      expect(await voice('open trading in the brain'), startsWith('Opened Trading: 2 records'));
      await tester.pump();
      expect(find.byType(CheBrainLobeSheet), findsOneWidget, reason: 'replaced, never stacked');
      expect(find.byKey(const ValueKey('brain-lobe-sheet-trading')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('brain-lobe-read')));
      expect(spoken.single, startsWith('Trading: 2 records'));

      await tester.tap(find.byKey(const ValueKey('brain-lobe-barrier')));
      await tester.pump();
      expect(find.byType(CheBrainLobeSheet), findsNothing);
      expect(CheBrainOverview.chromeHidden.value, isFalse);

      await tester.tap(find.byKey(const ValueKey('brain-lobe-conversations')));
      await tester.pump();
      expect(await voice('go back'), startsWith('Closed Conversations.'));
      await tester.pump();
      expect(find.byType(CheBrainLobeSheet), findsNothing);
      expect(await voice('go back'), isNull, reason: 'nothing open: "go back" goes on to the rest of the app');

      await tester.tap(find.byKey(const ValueKey('brain-lobe-knowledge')));
      await tester.pump();
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(find.byType(CheBrainLobeSheet), findsNothing, reason: 'the system back gesture closes the sheet first');

      final summary = (await voice("what's in the brain"))!;
      expect(summary, startsWith('Your brain holds 30 records in 7 regions. 1, Memory: 2 records; 2, Conversations: 2 records;'));
      expect(summary, contains('7, Needs Review: 1 record'));
    });

    testWidgets('a big region pages 20 at a time, searches and filters by record region', (tester) async {
      await _pump(tester, dots: cheLargeTestDots(300));
      await tester.tap(find.byKey(const ValueKey('brain-lobe-work')));
      await tester.pump();
      final total = cheBrainLobeRecords(CheBrainLobe.work, cheLargeTestDots(300)).length;
      expect(total, greaterThan(40));
      await tester.scrollUntilVisible(find.byKey(const ValueKey('brain-lobe-showing')), 400, scrollable: find.descendant(of: find.byKey(const ValueKey('brain-lobe-list')), matching: find.byType(Scrollable)));
      expect(find.text('Showing 20 of $total'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('brain-lobe-more')));
      await tester.pump();
      await tester.scrollUntilVisible(find.byKey(const ValueKey('brain-lobe-showing')), 400, scrollable: find.descendant(of: find.byKey(const ValueKey('brain-lobe-list')), matching: find.byType(Scrollable)));
      expect(find.text('Showing 40 of $total'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('brain-lobe-filter-coding')));
      await tester.pump();
      final coding = cheBrainLobeRecords(CheBrainLobe.work, cheLargeTestDots(300), only: CheBrainRegion.coding).length;
      expect(coding, lessThan(total));

      await tester.enterText(find.byKey(const ValueKey('brain-lobe-search')), 'record 11');
      await tester.pump();
      final hits = cheBrainLobeRecords(CheBrainLobe.work, cheLargeTestDots(300), only: CheBrainRegion.coding, query: 'record 11');
      expect(hits, isNotEmpty);
      expect(find.text(hits.first.title), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('brain-lobe-search')), 'zzz no such thing');
      await tester.pump();
      expect(find.byKey(const ValueKey('brain-lobe-empty')), findsOneWidget);
    });

    testWidgets('a record opens Memory Details; back returns to the same sheet', (tester) async {
      await _pump(tester);
      await tester.tap(find.byKey(const ValueKey('brain-lobe-memory')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('brain-lobe-record-mem:red')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-record-details')), findsOneWidget);
      Navigator.of(tester.element(find.byKey(const ValueKey('brain-record-details')))).pop();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const ValueKey('brain-lobe-sheet-memory')), findsOneWidget);
    });

    testWidgets('the record constellation opens only on request and returns to the regions', (tester) async {
      await _pump(tester);
      await tester.tap(find.byKey(const ValueKey('brain-constellation-toggle')));
      await tester.pump();
      expect(find.byKey(const ValueKey('the-neural-brain')), findsOneWidget);
      expect(find.byKey(const ValueKey('brain-neural')), findsNothing);
      expect(await CheBrainOverview.voiceHandler!('show the brain regions'), startsWith('Showing the brain regions.'));
      await tester.pump();
      expect(find.byKey(const ValueKey('brain-neural')), findsOneWidget);
    });
  });

  test('frame cost: one painter frame stays cheap and does not grow with the record count', () {
    double averageMs(Map<CheBrainLobe, CheBrainLobeStat> stats) {
      final clock = AnimationController(vsync: const TestVSync(), duration: const Duration(seconds: 6));
      final painter = CheBrainNeuralPainter(clock: clock, stats: stats);
      const size = Size(440, 850);
      // Warm up (geometry is built on the first frame and reused).
      painter.paint(Canvas(PictureRecorder()), size);
      final sw = Stopwatch()..start();
      const frames = 200;
      for (var i = 0; i < frames; i++) {
        clock.value = i / frames;
        final rec = PictureRecorder();
        painter.paint(Canvas(rec), size);
        rec.endRecording().dispose();
      }
      sw.stop();
      clock.dispose();
      return sw.elapsedMicroseconds / frames / 1000;
    }

    final small = averageMs(cheBrainLobeStats(cheTestDots(), now: cheTestNow));
    final large = averageMs(cheBrainLobeStats(cheLargeTestDots(20000), now: cheTestNow));
    // Recorded on the CI/dev container in debug (JIT) mode; release on device is far faster. The budget is generous
    // so the check catches a regression (per-record drawing) without flaking.
    // ignore: avoid_print
    print('Brain neural painter: ${small.toStringAsFixed(3)} ms/frame (30 records), ${large.toStringAsFixed(3)} ms/frame (20,000 records)');
    expect(small, lessThan(8));
    expect(large, lessThan(8));
    expect(large, lessThan(small * 3 + 1), reason: 'the frame does not scale with the record count');
  });
}
