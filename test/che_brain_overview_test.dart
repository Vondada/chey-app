// The Brain Room overview (owner, 2026-10-24, his original reference): every sidebar section opens its own real
// view, the seven first-glance regions show real counts and open one sheet (UI cleanup 2026-10-25), Real-Time Learning shows only ledger events
// (idle when there are none), Live Activity filters real records, Search highlights real matches, Memory Details
// shows the record's own facts and connections, the brain lights a region only for a real event, and nothing speaks
// on its own.
import 'package:chey/brain/che_brain_overview.dart';
import 'package:chey/brain/che_brain_regions.dart';
import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_brain_overview_fixture.dart';

Widget _app(Widget child) => MaterialApp(
      theme: ThemeData.dark(),
      home: MediaQuery(
        data: const MediaQueryData(size: Size(440, 956)),
        child: Scaffold(backgroundColor: Colors.black, body: child),
      ),
    );

CheBrainOverview _overview({
  List<CheMemoryDot>? dots,
  CheBrainLedgerLoader? load,
  List<String>? spoken,
  CheBrainNav initial = CheBrainNav.overview,
  Widget? brain,
}) =>
    CheBrainOverview(
      brain: brain ?? const SizedBox(key: ValueKey('the-neural-brain')),
      dots: dots ?? cheTestDots(),
      loadLearning: load,
      initialSection: initial,
      clock: () => cheTestNow,
      onReadAloud: (t) async => spoken?.add(t),
    );

Future<void> _pumpSized(WidgetTester tester, Widget w) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(_app(w));
  await tester.pump();
}

void main() {
  group('regions and links come only from the records', () {
    test('each record lands in its owner region; verified counts across regions; a failed task is an error', () {
      final counts = cheBrainRegionCounts(cheTestDots());
      expect(counts[CheBrainRegion.memories], 2);
      expect(counts[CheBrainRegion.conversations], 2);
      expect(counts[CheBrainRegion.media], 1);
      expect(counts[CheBrainRegion.trading], 2, reason: 'the BTC analysis and the trading lesson card');
      expect(counts[CheBrainRegion.coding], 1);
      expect(counts[CheBrainRegion.errors], 1);
      expect(counts[CheBrainRegion.agents], 2, reason: 'the finished and the running Office tasks');
      final domains = CheBrainRegion.values.where((r) => r != CheBrainRegion.verified).fold<int>(0, (a, r) => a + counts[r]!);
      expect(domains, cheTestDots().length, reason: 'the domain regions and Errors partition the records');
      expect(counts[CheBrainRegion.verified], greaterThan(0));
      expect(counts[CheBrainRegion.verified], lessThan(cheTestDots().length));
    });

    test('a recorded link between two verified records is strong; shared words alone are weak', () {
      final links = cheBrainLinks(cheTestDots());
      final strong = links.firstWhere((l) => {l.a.id, l.b.id}.containsAll({'mem:red', 'conv:outfits'}));
      expect(strong.strength, CheBrainLinkStrength.verified);
      final developing = links.where((l) => l.strength == CheBrainLinkStrength.developing);
      expect(developing, isNotEmpty, reason: 'know:6 → know:5 is recorded but know:5 is not verified');
      expect(links.where((l) => l.strength == CheBrainLinkStrength.weak), isNotEmpty, reason: 'futures-chart facts share words only');
      expect(cheBrainLinks(const []), isEmpty);
    });

    test('no records: every count is zero, every list empty, nothing invented', () {
      expect(cheBrainRegionCounts(const []).values.every((v) => v == 0), isTrue);
      for (final s in cheBrainDashboardCards) {
        expect(cheBrainCardFigure(s, const [], const []).count, 0);
      }
      expect(cheBrainActivity(const []), isEmpty);
    });
  });

  group('Real-Time Learning reads the ledger and never invents an event', () {
    test('recent ledger events: learning now; old ones: idle; none: idle and says so', () {
      final now = cheTestNow;
      final live = CheBrainLearning.fromLedger(cheTestLedger(), fetchedAt: now);
      expect(live.isActive(now), isTrue);
      expect(live.headline(now), startsWith('Learning now: reading and indexing · EMA crossover paper indexed'));
      final old = CheBrainLearning.fromLedger(cheTestLedger(newest: const Duration(hours: 5)), fetchedAt: now);
      expect(old.isActive(now), isFalse);
      expect(old.headline(now), 'Idle — waiting for work. Last learned 5h ago.');
      final empty = CheBrainLearning.fromLedger(const {'recent': [], 'totals': {}}, fetchedAt: now);
      expect(empty.headline(now), startsWith('Idle — waiting for work'));
      expect(live.events.map((e) => e.kind), ['Reading and indexing', 'Updating memories', 'Developing and testing a skill', 'Recording a mistake or correction']);
      expect(live.events.first.region, CheBrainRegion.trading);
      expect(live.events[1].region, CheBrainRegion.memories);
      expect(live.events.first.progress, closeTo(3 / 9, 1e-9), reason: 'INDEXED is step 3 of the ledger progression');
    });

    test('only events new since the last look light a region; the first load lights nothing', () {
      final first = CheBrainLearning.fromLedger(cheTestLedger(count: 2), fetchedAt: cheTestNow);
      expect(first.newSince(const CheBrainLearning()), isEmpty);
      final next = CheBrainLearning.fromLedger({
        ...cheTestLedger(count: 2),
        'recent': [
          {'brain_event_id': 'bev_new', 'ms': cheTestNow.millisecondsSinceEpoch, 'category': 'Coding', 'subcategory': 'CHE Code', 'event_type': 'PROJECT_KNOWLEDGE_UPDATED', 'title': 'Learned from job-brainviz', 'new_state': 'VERIFIED'},
          ...(cheTestLedger(count: 2)['recent'] as List),
        ],
      }, fetchedAt: cheTestNow);
      final fresh = next.newSince(first);
      expect(fresh.map((e) => e.id), ['bev_new']);
      expect(fresh.single.region, CheBrainRegion.coding);
      expect(fresh.single.kind, 'Learning from completed work');
    });

    test('a real event lights its region in the neural view; a region with no records lights nothing', () {
      final c = CheBrainSpaceController(cheTestDots());
      expect(c.regionGlow(CheBrainRegion.trading), 0);
      expect(c.illuminate(CheBrainRegion.trading), 2);
      expect(c.regionGlow(CheBrainRegion.trading), 1);
      c.tick(1.5);
      expect(c.regionGlow(CheBrainRegion.trading), lessThan(.5), reason: 'the glow fades; it is a moment, not a state');
      expect(c.illuminate(CheBrainRegion.creative), 0);
      expect(c.regionGlow(CheBrainRegion.creative), 0);
      c.dispose();
    });
  });

  testWidgets('every sidebar section opens its own view, never Home or Chat', (tester) async {
    await _pumpSized(tester, _overview());
    expect(find.byKey(const ValueKey('brain-neural')), findsOneWidget, reason: 'first glance: the seven regions');
    expect(find.byKey(const ValueKey('the-neural-brain'), skipOffstage: false), findsOneWidget, reason: 'the record constellation stays mounted');
    for (final s in CheBrainNav.values) {
      await tester.tap(find.byKey(const ValueKey('brain-sidebar-toggle')));
      await tester.pump();
      final item = find.byKey(ValueKey('brain-nav-${s.name}'));
      await tester.ensureVisible(item);
      await tester.tap(item);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('brain-sidebar')), findsNothing, reason: 'on iPhone the sidebar closes after a choice');
      if (s == CheBrainNav.overview) {
        expect(find.byKey(const ValueKey('brain-neural')), findsOneWidget);
        expect(find.byKey(const ValueKey('brain-section-overview')), findsNothing);
      } else {
        expect(find.byKey(ValueKey('brain-section-${s.name}')), findsOneWidget, reason: '${s.label} opens its own section');
        expect(find.textContaining(s.label.toUpperCase()), findsOneWidget, reason: 'the header names ${s.label}');
      }
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('the seven regions show real counts; a region opens one sheet of its records and closes back', (tester) async {
    await _pumpSized(tester, _overview());
    expect(find.byKey(const ValueKey('brain-dashboard')), findsNothing, reason: 'no dashboard cards under the brain any more');
    expect(find.byKey(const ValueKey('brain-learning')), findsNothing, reason: 'no learning panel stacked under the brain');
    expect(find.text('2'), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('brain-lobe-trading')));
    await tester.pump();
    expect(find.byKey(const ValueKey('brain-lobe-sheet-trading')), findsOneWidget);
    expect(find.text('BTC short setup analysed'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('brain-lobe-close')));
    await tester.pump();
    expect(find.byKey(const ValueKey('brain-lobe-sheet-trading')), findsNothing);
  });

  testWidgets('learning panel: live with real events, idle without; polling and new events never speak', (tester) async {
    final spoken = <String>[];
    var calls = 0;
    await _pumpSized(tester, _overview(spoken: spoken, initial: CheBrainNav.activity, load: () async {
      calls++;
      return cheTestLedger();
    }));
    await tester.pump();
    expect(calls, 1);
    expect(find.text('Live'), findsOneWidget);
    expect(find.textContaining('Learning now'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('brain-learning-toggle')));
    await tester.pump();
    expect(find.textContaining('Reading and indexing · EMA crossover paper indexed'), findsOneWidget);
    expect(find.textContaining('128 knowledge'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'a passive screen never speaks');
    await tester.pumpWidget(const SizedBox());

    await _pumpSized(tester, _overview(initial: CheBrainNav.activity, load: () async => cheTestLedger(newest: const Duration(hours: 5))));
    await tester.pump();
    expect(find.text('Idle'), findsOneWidget);
    expect(find.textContaining('Idle — waiting for work'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());

    await _pumpSized(tester, _overview(initial: CheBrainNav.activity));
    expect(find.textContaining('Learning feed not connected'), findsOneWidget, reason: 'no ledger: says so, shows nothing made up');
    await tester.pumpWidget(const SizedBox());

    await _pumpSized(tester, _overview(initial: CheBrainNav.activity, load: () async => throw Exception('CHE did not answer within 20 seconds.')));
    await tester.pump();
    expect(find.textContaining('Learning feed unavailable: CHE did not answer'), findsOneWidget);
  });

  testWidgets('Live Activity: newest first, real filters, opens the record', (tester) async {
    await _pumpSized(tester, _overview(initial: CheBrainNav.activity));
    final titles = tester.widgetList<Text>(find.descendant(of: find.byKey(const ValueKey('brain-section-activity')), matching: find.byType(Text))).map((t) => t.data ?? '').toList();
    expect(titles.indexOf('Red or blue outfit, which is better?'), lessThan(titles.indexOf('You prefer red over blue for outfits')), reason: 'the 2-minute-old conversation is above the 12-minute-old memory');
    await tester.ensureVisible(find.byKey(const ValueKey('brain-activity-trading')));
    await tester.tap(find.byKey(const ValueKey('brain-activity-trading')));
    await tester.pump();
    expect(find.text('BTC short setup analysed'), findsOneWidget);
    expect(find.text('You prefer red over blue for outfits'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('brain-record-trade:btc')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('brain-record-details')), findsOneWidget);
    expect(find.textContaining('Simulated or paper'), findsOneWidget, reason: 'paper work is never shown as live');
    expect(find.text('Replay trade sim-btc-0042'), findsOneWidget, reason: 'its replay evidence is listed');
  });

  testWidgets('Search: real counts per scope, highlighted words, Memory Details with related records', (tester) async {
    await _pumpSized(tester, _overview(initial: CheBrainNav.search));
    await tester.enterText(find.byKey(const ValueKey('brain-search-field')), 'red');
    await tester.pump();
    final r = cheBrainSearchScoped(cheTestDots(), 'red', CheBrainSearchScope.all);
    expect(find.text('All (${r.counts[CheBrainSearchScope.all]})'), findsOneWidget);
    expect(r.counts[CheBrainSearchScope.all], 3);
    expect(r.counts[CheBrainSearchScope.conversations], 2);
    expect(r.counts[CheBrainSearchScope.memories], 1);
    await tester.ensureVisible(find.byKey(const ValueKey('brain-search-scope-memories')));
    expect(find.text('Memories (1)'), findsOneWidget);
    final runs = cheBrainHighlight('You: I like the red one better.', 'red');
    expect(runs.where((r) => r.$2).map((r) => r.$1), ['red']);
    await tester.tap(find.byKey(const ValueKey('brain-search-scope-memories')));
    await tester.pump();
    expect(find.text('Conversations (2)'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('brain-record-mem:red')));
    await tester.pumpAndSettle();
    expect(find.text('Memory Details'), findsOneWidget);
    expect(find.text('You confirmed this'), findsOneWidget);
    expect(find.text('You'), findsOneWidget, reason: 'source: the owner');
    expect(find.text('Related · 3'), findsOneWidget, reason: 'one recorded link, two shared-word links');
    await tester.tap(find.byKey(const ValueKey('brain-related-conv:outfits')));
    await tester.pumpAndSettle();
    expect(find.text('Red or blue outfit, which is better?'), findsOneWidget);
  });

  testWidgets('voice: sections, search and "what is CHE learning" by voice; the sidebar reads its options', (tester) async {
    await _pumpSized(tester, _overview(load: () async => cheTestLedger()));
    await tester.pump();
    final voice = CheBrainOverview.voiceHandler!;
    expect(await voice('show live activity'), startsWith('Live Activity. Newest: Red or blue outfit, which is better?'));
    await tester.pump();
    expect(find.byKey(const ValueKey('brain-section-activity')), findsOneWidget);
    expect(await voice('search my brain for red'), startsWith('3 results for "red".'));
    await tester.pump();
    expect(find.byKey(const ValueKey('brain-section-search')), findsOneWidget);
    expect(await voice('what is CHE learning'), startsWith('Learning now: reading and indexing'));
    expect(await voice('open skills and training'), startsWith('Skills & Training:'));
    await tester.pump();
    expect(find.byKey(const ValueKey('brain-section-skills')), findsOneWidget);
    expect(await voice('open the brain'), startsWith('Your brain holds 30 records in 7 regions. 1, Memory: 2 records;'));
    final menu = await voice('show the sidebar');
    expect(menu, contains('1, Brain Overview'));
    expect(menu, contains('16, Analytics'));
    expect(await voice('what time is it'), isNull, reason: 'anything else goes on to CHE');
    await tester.pumpWidget(const SizedBox());
    expect(CheBrainOverview.voiceHandler, isNull, reason: 'off screen, the handler is gone');
  });

  test('voice phrases parse the same typed or spoken', () {
    expect(CheBrainOverview.parse('CHE, search my brain for red nails')?.query, 'red nails');
    expect(CheBrainOverview.parse('search the brain for EMA')?.section, CheBrainNav.search);
    expect(CheBrainOverview.parse("what's CHE learning")?.learning, isTrue);
    expect(CheBrainOverview.parse('what are you learning')?.learning, isTrue);
    expect(CheBrainOverview.parse('open the knowledge library')?.section, CheBrainNav.library);
    expect(CheBrainOverview.parse('show learning tasks')?.section, CheBrainNav.learningTasks);
    expect(CheBrainOverview.parse('open analytics in the brain')?.section, CheBrainNav.analytics);
    expect(CheBrainOverview.parse('open the pod bay doors'), isNull);
    expect(CheBrainOverview.parse('tell me a joke'), isNull);
  });
}
