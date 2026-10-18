// Brain navigation and worker brains (owner directives of 2026-10-18):
// the same dark teal Brain, now with a brain switcher, a context line, facet
// filters, a detail panel that keeps the owner's place, view controls, quiet
// states, and one navigable brain per internal Office worker built from real
// Brain records with real attribution. Acceptance tests 1–14 of the
// navigation directive and the Brain Room tests (6, 7, 10) of the Office
// worker directive run here against real-shaped data, not mocked orbs.

import 'dart:math' as math;

import 'package:chey/brain/che_brain_navigation.dart';
import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

const _now = '2026-10-18T06:00:00.000Z';
final DateTime _clock = DateTime.parse(_now);

/// Brain records exactly as the phone replica hands them to the room
/// (`recordsJson()`), after the Worker projected CHE's Office into the Brain:
/// a task shared by Atlas and Knox sits in both brains through its places.
List<Map<String, dynamic>> _brainRecords({int extra = 0}) => [
      {'id': 'che:core', 'kind': 'core', 'region': 'CHE Self-Knowledge', 'path': 'CHE', 'title': 'CHE', 'excerpt': 'CHE, the central brain of the Office.', 'verification': 'owner_attested', 'created_at': '2026-10-01T00:00:00.000Z', 'source': {'kind': 'che_core'}, 'links': const [], 'places': [{'region': 'CHE Self-Knowledge', 'path': 'CHE'}, {'region': 'Office Agents', 'path': 'CHE'}]},
      for (final (id, name, role) in [('a-atlas', 'Atlas', 'Research / scout'), ('a-knox', 'Knox', 'Engineering / Codex jobs'), ('a-nova', 'Nova', 'Product / listings')])
        {'id': 'agent:$id', 'kind': 'worker', 'region': 'Office Agents', 'path': name, 'title': name, 'excerpt': '$name, $role. An internal Office worker who reports to CHE.', 'verification': 'owner_attested', 'created_at': '2026-10-01T00:00:00.000Z', 'source': {'kind': 'office_worker', 'role': role}, 'links': [{'type': 'related_to', 'to': 'che:core'}], 'places': [{'region': 'Office Agents', 'path': name}]},
      {'id': 'task:t2', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Research silver momentum and hand the implementation to Knox', 'excerpt': 'Task: Research silver momentum and hand the implementation to Knox.\nStatus: failed.\nError: The data source timed out twice.\nHandoffs: Atlas → Knox (2026-10-09).', 'verification': 'unverified_reference', 'created_at': '2026-10-09T08:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Atlas', 'status': 'failed', 'outcome': 'failed', 'collaborators': ['Knox']}, 'links': [{'type': 'produced_by_agent', 'to': 'agent:a-atlas'}, {'type': 'escalated_to', 'to': 'agent:a-knox'}], 'places': [{'region': 'Active and Historical Tasks', 'path': 'Historical'}, {'region': 'Office Agents', 'path': 'Atlas'}, {'region': 'Office Agents', 'path': 'Knox'}]},
      {'id': 'task:t1', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Write the Etsy listing for the brass lamp', 'excerpt': 'Task: Write the Etsy listing for the brass lamp.\nStatus: complete (checked by CHE).\nResult: Listing written: Brass Lamp, 40 dollars.', 'verification': 'verified_source', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Nova', 'status': 'complete', 'outcome': 'done', 'verified_by_che': true}, 'links': [{'type': 'produced_by_agent', 'to': 'agent:a-nova'}], 'places': [{'region': 'Active and Historical Tasks', 'path': 'Historical'}, {'region': 'Office Agents', 'path': 'Nova'}]},
      {'id': 'task:t3', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Active', 'title': 'Paper-trade the silver signal', 'excerpt': 'Task: Paper-trade the silver signal.\nStatus: running.', 'verification': 'unverified_reference', 'created_at': '2026-10-17T11:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Knox', 'status': 'running', 'outcome': 'live'}, 'links': [{'type': 'produced_by_agent', 'to': 'agent:a-knox'}], 'places': [{'region': 'Active and Historical Tasks', 'path': 'Active'}, {'region': 'Office Agents', 'path': 'Knox'}]},
      {'id': 'skill:s1', 'kind': 'skill', 'region': 'Skills and Tools', 'path': 'Nova', 'title': 'Write an Etsy listing', 'excerpt': 'Skill: Write an Etsy listing. Steps: gather the product facts; write title, price and shipping.', 'verification': 'verified_source', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'office_skill', 'agents': ['Nova']}, 'links': const [], 'places': [{'region': 'Skills and Tools', 'path': 'Nova'}, {'region': 'Office Agents', 'path': 'Nova'}]},
      {'id': 'mem:1', 'kind': 'memory', 'region': 'Personal Memory', 'path': 'Family', 'title': 'My sister Ana lives in Lisbon', 'excerpt': 'My sister Ana lives in Lisbon.', 'verification': 'owner_attested', 'created_at': '2026-10-17T02:00:00.000Z', 'source': {'kind': 'memory_record'}, 'links': const [], 'places': [{'region': 'Personal Memory', 'path': 'Family'}]},
      {'id': 'note:h', 'kind': 'note', 'region': 'Trading and Market Research', 'path': 'Ideas', 'title': 'Silver may rise next week', 'excerpt': 'The momentum signal suggests silver rises next week.', 'verification': 'hypothesis', 'created_at': '2026-09-20T04:00:00.000Z', 'source': {'kind': 'note'}, 'links': const [], 'places': [{'region': 'Trading and Market Research', 'path': 'Ideas'}]},
      // A temporary provider worker's task: in the Tasks region, in no worker brain, and never a worker orb.
      {'id': 'task:t4', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Translate the listing', 'excerpt': 'Task: Translate the listing.\nStatus: complete.', 'verification': 'unverified_reference', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Claude (temp)', 'status': 'complete', 'outcome': 'done'}, 'links': const [], 'places': [{'region': 'Active and Historical Tasks', 'path': 'Historical'}, {'region': 'Office Agents', 'path': 'Claude (temp)'}]},
      for (var i = 0; i < extra; i++)
        {'id': 'know:$i', 'kind': 'knowledge', 'region': 'Learned Knowledge', 'path': 'Facts', 'title': 'Fact number $i about markets', 'excerpt': 'Learned fact $i: futures on free charts are delayed about ${10 + i % 7} minutes.', 'verification': i % 3 == 0 ? 'verified_source' : 'unverified_reference', 'created_at': '2026-${(1 + i % 9).toString().padLeft(2, '0')}-${(1 + i % 27).toString().padLeft(2, '0')}T00:00:00.000Z', 'source': {'kind': 'knowledge'}, 'links': const [], 'places': [{'region': 'Learned Knowledge', 'path': 'Facts'}, if (i % 50 == 0) {'region': 'Office Agents', 'path': 'Atlas'}]},
    ];

/// The Office roster as `/api/state` lists it: permanent workers, a temporary provider worker, an outside AI.
const _roster = [
  {'name': 'Nova', 'role': 'Product / listings', 'runtime_status': 'idle'},
  {'name': 'Atlas', 'role': 'Research / scout', 'runtime_status': 'working'},
  {'name': 'Knox', 'role': 'Engineering / Codex jobs', 'runtime_status': 'idle'},
  {'name': 'Mira', 'role': 'Customer / support copy', 'runtime_status': 'idle'},
  {'name': 'Claude (temp)', 'role': 'Provider worker', 'temporary': true},
  {'name': 'Grok', 'role': 'Outside model'},
];

List<CheMemoryDot> _dots({int extra = 0}) => cheBuildMemoryDots(
      savedMemories: const ['Owner prefers voice replies and large text'],
      memoryNotes: const [],
      learnedPersonality: const [{'statement': 'Prefers short spoken answers'}],
      learnedKnowledge: const [],
      brainRecords: _brainRecords(extra: extra),
    );

const _phone = Size(440, 956);
const _tablet = Size(1024, 768);

void _useScreen(WidgetTester tester, Size size, {double dpr = 1}) {
  tester.view.physicalSize = size * dpr;
  tester.view.devicePixelRatio = dpr;
  addTearDown(tester.view.reset);
}

Widget _room(List<CheMemoryDot> dots, {Size size = _phone, List<String>? spoken, bool loading = false, bool offline = false, int pending = 0, String? error, Future<void> Function()? onRefresh, List<Map<String, dynamic>> roster = _roster}) => MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(size: size, padding: const EdgeInsets.only(top: 62, bottom: 34), viewPadding: const EdgeInsets.only(top: 62, bottom: 34)),
        child: Scaffold(
          body: CheMemoryBrainRoom(
            dots: dots,
            roster: roster,
            loading: loading,
            offline: offline,
            pendingSync: pending,
            error: error,
            onRefresh: onRefresh,
            onReadAloud: (t) async => spoken?.add(t),
          ),
        ),
      ),
    );

Future<void> _settle(WidgetTester tester, {int frames = 60}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

/// Pills sit in sideways-scrolling rows: bring one into view, then tap it.
Future<void> _tapPill(WidgetTester tester, String label) async {
  final pill = find.widgetWithText(CheBrainPill, label);
  expect(pill, findsOneWidget, reason: 'pill "$label"');
  await tester.ensureVisible(pill);
  await tester.pump();
  await tester.tap(pill);
  await tester.pump();
}

/// A worker's experience: every record in his brain except his own profile record.
int _experienceOf(List<CheMemoryDot> dots, String name) => dots.where((d) => d.workers.contains(name) && d.kind != 'worker').length;

CheBrainSpaceController _controllerOf(WidgetTester tester) => tester.widget<CheBrainSpace>(find.byType(CheBrainSpace)).controller;

double _luminance(Color c) => c.computeLuminance();
double _contrast(Color a, Color b) {
  final la = _luminance(a), lb = _luminance(b);
  return (math.max(la, lb) + .05) / (math.min(la, lb) + .05);
}

void main() {
  group('worker brains from real records', () {
    test('Office test 6/10: internal workers get orbs with real counts and real connections; outside AIs never do', () {
      final dots = _dots();
      final c = CheBrainSpaceController(dots, roster: _roster);
      final names = c.workers.map((w) => w.name).toList();
      expect(names, containsAll(['Atlas', 'Knox', 'Nova', 'Mira']));
      expect(names.any((n) => n.toLowerCase().startsWith('claude') || n == 'Grok'), isFalse, reason: 'outside AIs and temporary provider workers are not Office brains');
      for (final w in c.workers) {
        expect(w.records, _experienceOf(dots, w.name), reason: '${w.name} counts his own experience only, never his profile record');
      }
      final atlas = c.worker('Atlas')!;
      expect(atlas.collaborators, {'Knox'}, reason: 'the shared silver task is the only real connection');
      expect(c.worker('Knox')!.collaborators, {'Atlas'});
      expect(c.worker('Nova')!.collaborators, isEmpty);
      expect(c.worker('Mira')!.records, 0);
      expect(c.worker('Mira')!.state, 'no experience yet', reason: 'an idle worker never claims learning');
      expect(atlas.state, 'working');
      expect(atlas.role, 'Research / scout');
      // On the ring, outside the brain's shape, all distinct positions.
      for (final w in c.workers) {
        expect(w.position.length, greaterThan(10));
        expect(cheBrainShape(w.position), greaterThan(1));
      }
      expect(c.workers.map((w) => '${w.position.x.toStringAsFixed(2)},${w.position.y.toStringAsFixed(2)}').toSet().length, c.workers.length);
      // A task in two brains is attributed to both; the temporary worker's task to neither.
      expect(dots.firstWhere((d) => d.id == 'task:t2').workers, ['Atlas', 'Knox']);
      expect(dots.firstWhere((d) => d.id == 'task:t4').workers, isEmpty);
      c.dispose();
    });

    test('Office test 7: the same records offline open a worker brain with only that worker\'s experience, failures included', () {
      final dots = _dots();
      final c = CheBrainSpaceController(dots, roster: _roster);
      final said = c.setScope('atlas');
      expect(c.scope, 'Atlas');
      expect(said, startsWith("Atlas's brain, Research / scout: 1 record of experience"));
      expect(said, contains('Works with Knox'));
      expect(c.layout.nodes.map((n) => n.id).toSet(), {'agent:a-atlas', 'task:t2'});
      expect(c.layout.node('task:t2')!.dot.outcome, 'failed', reason: 'a failed attempt stays in the learning history');
      expect(c.setScope('Mira'), startsWith('Mira has no experience recorded yet (Customer / support copy). Nothing is invented'));
      expect(c.layout.nodes, isEmpty);
      expect(c.setScope('Grok'), contains('There is no worker brain called Grok'));
      expect(c.setScope(null), startsWith("CHE's brain: "));
      expect(c.layout.nodes.length, dots.length);
      c.dispose();
    });
  });

  group('review 1 regressions', () {
    test('only roster workers become orbs: temporary workers, fallbacks, URLs, brand suffixes and case twins never do', () {
      final records = _brainRecords()
        ..addAll([
          {'id': 'task:h1', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Helper task', 'excerpt': 'Task: help.\nStatus: complete.', 'verification': 'unverified_reference', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Helper', 'outcome': 'done'}, 'links': const [], 'places': [{'region': 'Office Agents', 'path': 'Helper'}]},
          {'id': 'task:h2', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Lower-case atlas task', 'excerpt': 'Task: scout.\nStatus: complete.', 'verification': 'unverified_reference', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'atlas', 'outcome': 'done'}, 'links': const [], 'places': [{'region': 'Office Agents', 'path': 'atlas'}]},
          {'id': 'task:h3', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Brand task', 'excerpt': 'Task: draft.\nStatus: complete.', 'verification': 'unverified_reference', 'created_at': '2026-10-10T10:00:00.000Z', 'source': {'kind': 'team_task', 'agent': 'Nova (Claude)', 'outcome': 'done'}, 'links': const [], 'places': [{'region': 'Office Agents', 'path': 'Nova (Claude)'}, {'region': 'Office Agents', 'path': 'Research by ChatGPT'}, {'region': 'Office Agents', 'path': 'Office agent'}, {'region': 'Office Agents', 'path': 'https://example.com/report'}]},
        ]);
      final dots = cheBuildMemoryDots(
        savedMemories: const [],
        memoryNotes: const [
          {'id': 'live1', 'title': 'Live note without an agent', 'body': 'An agent task note whose only name is a URL source.', 'kind': 'agent_task', 'source': 'https://example.com/x'},
          {'id': 'live2', 'title': 'Live note by Knox', 'body': 'Knox is paper-trading.', 'kind': 'agent_task', 'agent': 'Knox', 'status': 'running'},
        ],
        learnedPersonality: const [],
        learnedKnowledge: const [],
        brainRecords: records,
      );
      final roster = [..._roster, {'name': 'Helper', 'role': 'Provider worker', 'temporary': true}];
      final c = CheBrainSpaceController(dots, roster: roster);
      expect(c.workers.map((w) => w.name).toSet(), {'Atlas', 'Knox', 'Nova', 'Mira'});
      expect(c.worker('Atlas')!.records, _experienceOf(dots, 'Atlas') + 1, reason: 'the lower-case place counts toward Atlas, not a second orb');
      expect(c.worker('Nova')!.records, _experienceOf(dots, 'Nova'), reason: '"Nova (Claude)" is not Nova');
      expect(dots.firstWhere((d) => d.id == 'live1').workers, isEmpty, reason: 'a URL source is not a worker');
      expect(dots.firstWhere((d) => d.id == 'live2').workers, ['Knox']);
      expect(c.setScope('atlas'), startsWith("Atlas's brain"));
      expect(c.layout.nodes.map((n) => n.id), contains('task:h2'));
      c.dispose();
      // Without a roster (offline before the first load) the record names stand, still never a fallback or an outside AI.
      final bare = CheBrainSpaceController(dots);
      expect(bare.workers.map((w) => w.name).toSet(), {'Atlas', 'Knox', 'Nova', 'Helper'}, reason: "CHE's core record is placed under Office Agents/CHE by the Worker; she is the centre, never an orb");
      expect(dots.firstWhere((d) => d.id == 'che:core').workers, isEmpty);
      bare.dispose();
    });

    test('a worker with only a profile record has no experience yet, and canvas labels follow the counts', () {
      final records = _brainRecords().where((r) => r['id'] != 'task:t3' && r['id'] != 'task:t2').toList();
      final dots = cheBuildMemoryDots(savedMemories: const [], memoryNotes: const [], learnedPersonality: const [], learnedKnowledge: const [], brainRecords: records);
      final c = CheBrainSpaceController(dots, roster: _roster);
      final knox = c.worker('Knox')!;
      expect(knox.records, 0);
      expect(knox.state, 'no experience yet');
      expect(c.setScope('Knox'), startsWith('Knox has no experience recorded yet (Engineering / Codex jobs)'));
      expect(c.layout.nodes.map((n) => n.id), ['agent:a-knox'], reason: 'his profile stays visible, it is just not experience');
      final first = c.label('worker:Knox', 'Knox · 0', 12, Colors.white);
      final second = c.label('worker:Knox', 'Knox · 6', 12, Colors.white);
      expect(first.text!.toPlainText(), 'Knox · 0');
      expect(second.text!.toPlainText(), 'Knox · 6', reason: 'a changed count is never drawn from a stale cache');
      c.dispose();
    });

    test('a bare "switch to X", "home" or "undo that" is never a Brain command; the brain forms still are', () {
      expect(CheBrainCommand.parse('switch to tesla'), isNull);
      expect(CheBrainCommand.parse('switch to spanish'), isNull);
      expect(CheBrainCommand.parse('home'), isNull);
      expect(CheBrainCommand.parse('undo that'), isNull);
      expect(CheBrainCommand.parse("switch to knox's brain")!.worker, 'knox');
      expect(CheBrainCommand.parse("open atlas's brain")!.worker, 'atlas');
      expect(CheBrainCommand.parse("che's brain")!.action, CheBrainAction.centerChe);
      expect(CheBrainCommand.parse('go back')!.action, CheBrainAction.back);
    });

    testWidgets('every crumb that leads somewhere is a VoiceOver button, and CHE leads to the top with nothing left set', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final handle = tester.ensureSemantics();
      final spoken = <String>[];
      await tester.pumpWidget(_room(_dots(), spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester);
      c.setScope('Atlas');
      c.setFilter('Agents');
      c.setLens(const CheBrainLens(verified: false));
      c.select(c.layout.node('task:t2')!);
      await tester.pump();
      expect(find.bySemanticsLabel("Back to CHE's brain"), findsOneWidget);
      expect(find.bySemanticsLabel("Back to Atlas's brain"), findsOneWidget);
      expect(find.bySemanticsLabel('Back to Agents memories'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r"^You are in Atlas's brain, Agents memories, Inferred")), findsOneWidget);
      await tester.tap(find.bySemanticsLabel("Back to Atlas's brain"));
      await tester.pump();
      expect(c.scope, 'Atlas');
      expect(c.filter, isEmpty);
      expect(c.lens.isEmpty, isTrue);
      expect(c.selectedId, isNull);
      expect(spoken.last, startsWith("Atlas's brain: showing all"));
      c.setLens(const CheBrainLens(verified: false));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel("Back to CHE's brain"));
      await tester.pump();
      expect(c.scope, isNull);
      expect(c.lens.isEmpty, isTrue);
      expect(spoken.last, startsWith("CHE's brain: "));
      expect(find.bySemanticsLabel("CHE's brain"), findsOneWidget, reason: 'at the top the CHE crumb is a plain label, not a button');
      handle.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('navigation (directive tests 1–14)', () {
    testWidgets('1. the CHE Brain design is unchanged: palette, background, orb space, header and controls', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      // The brain's palette (green, teal, cyan, blue, violet, white, amber for agents) is the one it had.
      expect(cheMemoryCategoryColor('Memory'), const Color(0xFF3EE6C9));
      expect(cheMemoryCategoryColor('Conversations'), const Color(0xFF52E89A));
      expect(cheMemoryCategoryColor('Learning'), const Color(0xFF4FB8FF));
      expect(cheMemoryCategoryColor('Research'), const Color(0xFF7CF0FF));
      expect(cheMemoryCategoryColor('Knowledge'), const Color(0xFF6E8CFF));
      expect(cheMemoryCategoryColor('Agents'), const Color(0xFFFFB54D));
      expect(cheMemoryCategoryColor('anything else'), CheColors.accent);
      expect(CheColors.accent, const Color(0xFF34E0B8));
      expect(CheColors.bg, const Color(0xFF030607));
      // Without worker brains the overview is exactly what it was.
      final plain = CheBrainSpaceController(cheBuildMemoryDots(savedMemories: const ['One'], memoryNotes: const [], learnedPersonality: const [], learnedKnowledge: const []));
      expect(plain.overviewDistance, CheBrainCamera.overview);
      expect(plain.camera.distance, CheBrainCamera.overview);
      plain.dispose();
      final spoken = <String>[];
      await tester.pumpWidget(_room(_dots(), spoken: spoken, onRefresh: () async {}));
      await tester.pump();
      expect(find.textContaining('Brain constellation', findRichText: true), findsOneWidget);
      expect(find.byType(CheBrainSpace), findsOneWidget);
      expect(find.byKey(const ValueKey('che-brain-canvas')), findsOneWidget);
      for (final tip in ['Find a memory', 'Filter the brain', 'Refresh memories']) {
        expect(find.byTooltip(tip), findsOneWidget, reason: '$tip stays');
      }
      // The new controls sit in the same 44-pt row; no panel is open until asked.
      expect(find.byTooltip('Switch brain: CHE or an Office worker'), findsOneWidget);
      expect(find.byTooltip('View controls: zoom, fit, center, inside, back'), findsOneWidget);
      expect(find.byType(CheBrainPill), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(spoken, isEmpty, reason: 'opening the Brain never speaks on its own');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('2 & 9. the switcher lists CHE and every internal worker; a worker brain is the same space with the same controls', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final spoken = <String>[];
      final dots = _dots();
      await tester.pumpWidget(_room(dots, spoken: spoken));
      await tester.pump();
      await tester.tap(find.byTooltip('Switch brain: CHE or an Office worker'));
      await tester.pump();
      expect(find.byType(CheBrainSwitcher), findsOneWidget);
      expect(find.widgetWithText(CheBrainPill, 'CHE'), findsOneWidget);
      final atlasCount = _experienceOf(dots, 'Atlas');
      expect(find.widgetWithText(CheBrainPill, 'Atlas · $atlasCount'), findsOneWidget);
      expect(find.widgetWithText(CheBrainPill, 'Mira · 0'), findsOneWidget);
      expect(find.textContaining('Claude'), findsNothing);
      expect(find.textContaining('Grok'), findsNothing);
      expect(tester.widget<CheBrainPill>(find.widgetWithText(CheBrainPill, 'CHE')).selected, isTrue);
      await _tapPill(tester, 'Atlas · $atlasCount');
      final c = _controllerOf(tester);
      expect(c.scope, 'Atlas');
      expect(spoken.last, startsWith("Atlas's brain, Research / scout"));
      expect(find.textContaining("Atlas's brain", findRichText: true), findsOneWidget);
      expect(tester.widget<CheBrainPill>(find.widgetWithText(CheBrainPill, 'Atlas · $atlasCount')).selected, isTrue);
      // Same widget, same controls, same gestures: nothing about the room changed but its records.
      expect(find.byType(CheBrainSpace), findsOneWidget);
      for (final tip in ['Find a memory', 'Filter the brain', 'Hide the brain switcher', 'View controls: zoom, fit, center, inside, back']) {
        expect(find.byTooltip(tip), findsOneWidget);
      }
      expect(c.layout.nodes.length, dots.where((d) => d.workers.contains('Atlas')).length, reason: 'his profile record is shown with his experience');
      // Filters, search and stepping work inside the worker brain exactly as in CHE's.
      expect(c.setFilter('Agents'), startsWith('Showing your Agents memories'));
      expect(c.find('silver momentum'), startsWith('Found it.'));
      expect(c.selectedId, 'task:t2');
      expect(c.step(1), isNotEmpty);
      await _tapPill(tester, 'CHE');
      expect(c.scope, isNull);
      expect(c.layout.nodes.length, dots.length);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('3 & 4. the context line always says where the owner is, and its crumbs lead back up', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final handle = tester.ensureSemantics();
      final spoken = <String>[];
      await tester.pumpWidget(_room(_dots(), spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester);
      expect(find.bySemanticsLabel(RegExp(r"^You are in CHE's brain, overview\.$")), findsOneWidget);
      c.setScope('Atlas');
      await tester.pump();
      c.setFilter('Agents');
      c.select(c.layout.node('task:t2')!);
      await tester.pump();
      expect(c.describe(), "Atlas's brain, Agents memories, ${c.selected!.dot.title} selected, close up");
      expect(find.bySemanticsLabel(RegExp(r"^You are in Atlas's brain, Agents memories, Research silver momentum")), findsOneWidget);
      expect(find.text('Atlas'), findsWidgets);
      expect(find.text('Agents'), findsWidgets);
      // The first crumb is CHE: tapping it returns to the central brain.
      await tester.tap(find.descendant(of: find.byType(CheBrainContextBar), matching: find.text('CHE')));
      await tester.pump();
      expect(c.scope, isNull);
      expect(c.selectedId, isNull);
      expect(spoken.last, startsWith("CHE's brain: "));
      handle.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('14 & 4. back restores the previous brain, filters, selection and camera', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      await tester.pumpWidget(_room(_dots()));
      await tester.pump();
      final c = _controllerOf(tester);
      expect(c.canGoBack, isFalse);
      expect(find.byTooltip('Back to the previous view'), findsNothing);
      c.select(c.layout.node('mem:1')!);
      await _settle(tester);
      final before = c.camera.copy();
      expect(before.distance, closeTo(3.4, .05));
      c.setScope('Atlas');
      c.select(c.layout.node('task:t2')!);
      await _settle(tester);
      expect(c.scope, 'Atlas');
      expect(find.byTooltip('Back to the previous view'), findsOneWidget);
      // Back once: still Atlas, nothing selected (the state before the selection).
      expect(c.goBack(), startsWith("Back to Atlas's brain"));
      expect(c.scope, 'Atlas');
      expect(c.selectedId, isNull);
      // Back again: CHE's brain with the sister memory selected and the camera where it was.
      expect(c.goBack(), startsWith("Back to CHE's brain, My sister Ana lives in Lisbon selected"));
      await _settle(tester);
      expect(c.scope, isNull);
      expect(c.selectedId, 'mem:1');
      expect(c.camera.distance, closeTo(before.distance, .05));
      expect((c.camera.target - before.target).length, lessThan(.05));
      // The header back button is the same action.
      c.setLens(const CheBrainLens(verified: true));
      await tester.pump();
      await tester.tap(find.byTooltip('Back to the previous view'));
      await tester.pump();
      expect(c.lens.isEmpty, isTrue);
      expect(c.goBack(), startsWith('Back to'));
      expect(c.goBack(), startsWith('Nowhere to go back to'));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('5. filters are clear, voice and chips agree, and clearing is one tap', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final spoken = <String>[];
      final dots = _dots();
      await tester.pumpWidget(_room(dots, spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester)..clock = () => _clock;
      final verified = dots.where((d) => d.isVerified).length;
      expect(c.setLens(const CheBrainLens(verified: true)), 'Showing Verified: $verified of ${dots.length}.');
      expect(c.visibleCount, verified);
      final byVoice = CheBrainCommand.parse('show verified memories only')!;
      expect(byVoice.action, CheBrainAction.lens);
      expect(byVoice.lens, const CheBrainLens(verified: true));
      expect(c.execute(byVoice), 'Already showing Verified.');
      expect(c.execute(CheBrainCommand.parse('only show failed tasks')!), 'Showing Failed tasks: 1 of ${dots.length}.');
      expect(c.layout.nodes.where(c.shows).single.id, 'task:t2');
      expect(c.execute(CheBrainCommand.parse('show me the recent ones')!), startsWith('Showing Last 7 days: '));
      expect(c.layout.nodes.where(c.shows).map((n) => n.id).toSet(), dots.where((d) => d.at != null && _clock.difference(d.at!).inDays <= 7).map((d) => d.id).toSet());
      expect(c.layout.nodes.where(c.shows).map((n) => n.id), containsAll(['mem:1', 'task:t3']));
      expect(c.layout.nodes.where(c.shows).map((n) => n.id), isNot(contains('note:h')));
      expect(c.execute(CheBrainCommand.parse('show archived records')!), startsWith('Showing Archived: '));
      expect(c.layout.nodes.where(c.shows).every((n) => n.dot.archived), isTrue);
      expect(c.execute(CheBrainCommand.parse('show personal memories')!), startsWith('Showing Personal: '));
      expect(c.layout.nodes.where(c.shows).every((n) => n.dot.isPersonal), isTrue);
      expect(c.execute(CheBrainCommand.parse('clear the filters')!), 'Filters cleared: showing all ${dots.length} memories.');
      expect(c.visibleCount, dots.length);
      // The chips do the same, with a heading per facet and words on every pill.
      await tester.tap(find.byTooltip('Filter the brain'));
      await tester.pump();
      expect(find.byType(CheBrainFilterPanel), findsOneWidget);
      for (final heading in ['Lobe', 'Truth', 'Time', 'State', 'Owner']) {
        expect(find.text(heading), findsOneWidget);
      }
      await _tapPill(tester, 'Verified');
      expect(c.lens, const CheBrainLens(verified: true));
      expect(spoken.last, 'Showing Verified: $verified of ${dots.length}.');
      await _tapPill(tester, 'Failed tasks');
      expect(c.lens, const CheBrainLens(verified: true, status: 'failed'));
      await _tapPill(tester, 'Clear all');
      expect(c.lens.isEmpty, isTrue);
      expect(c.filter, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('6 & 10. the detail panel names worker, folder, truth and status in words, and closing it keeps the place', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final spoken = <String>[];
      await tester.pumpWidget(_room(_dots(), spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester);
      c.select(c.layout.node('task:t2')!);
      await _settle(tester);
      final before = c.camera.copy();
      c.openSelected();
      await tester.pump();
      expect(find.text('Workers · Atlas, Knox'), findsOneWidget);
      expect(find.text('Folder · Active and Historical Tasks / Historical'), findsOneWidget);
      expect(find.text('Unverified reference'), findsOneWidget);
      expect(find.text('Status · failed'), findsOneWidget);
      expect(find.text('Shared Office knowledge'), findsOneWidget);
      expect(find.text('Archived'), findsOneWidget);
      expect(find.text("Open Atlas's brain"), findsOneWidget);
      expect(find.text("Open Knox's brain"), findsOneWidget);
      expect(find.text('Center on this'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline_rounded), findsWidgets, reason: 'a failed task carries an icon, not only a color');
      c.closeCard();
      await _settle(tester, frames: 10);
      expect(c.camera.distance, before.distance);
      expect((c.camera.target - before.target).length, lessThan(1e-6));
      expect(c.selectedId, 'task:t2', reason: 'closing the detail view does not lose the selection');
      // From the card into a worker's brain.
      c.openSelected();
      await tester.pump();
      await tester.tap(find.text("Open Knox's brain"));
      await tester.pump();
      expect(c.scope, 'Knox');
      expect(spoken.last, startsWith("Knox's brain, Engineering / Codex jobs"));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('7. zoom, fit, center and back work by button and by voice', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final spoken = <String>[];
      await tester.pumpWidget(_room(_dots(), spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester);
      final start = c.camera.distance;
      expect(start, c.overviewDistance);
      expect(c.overviewDistance, 23, reason: 'with worker brains around it, the overview fits the ring');
      expect(c.execute(CheBrainCommand.parse('zoom in')!), startsWith('Closer'));
      await _settle(tester);
      final closer = c.camera.distance;
      expect(closer, lessThan(start));
      expect(c.execute(CheBrainCommand.parse('zoom out')!), startsWith('Farther out'));
      await _settle(tester);
      expect(c.camera.distance, greaterThan(closer));
      expect(c.execute(CheBrainCommand.parse('fit everything')!), startsWith("Fitted: CHE's brain"));
      await _settle(tester);
      expect(c.camera.distance, closeTo(c.overviewDistance, .05));
      expect(c.centerOnSelected(), startsWith('Nothing is selected'));
      c.select(c.layout.node('mem:1')!);
      await _settle(tester);
      c.zoomOut();
      await _settle(tester);
      expect(c.execute(CheBrainCommand.parse('center on this memory')!), 'Centered on My sister Ana lives in Lisbon.');
      await _settle(tester);
      expect(c.camera.distance, closeTo(3.4, .05));
      c.setScope('Knox');
      expect(c.execute(CheBrainCommand.parse("back to che")!), startsWith("CHE's brain"));
      expect(c.scope, isNull);
      expect(CheBrainCommand.parse('go back')!.action, CheBrainAction.back);
      expect(CheBrainCommand.parse("open atlas's brain")!.worker, 'atlas');
      expect(CheBrainCommand.parse("switch to knox's brain")!.worker, 'knox');
      expect(CheBrainCommand.parse('show me the whole brain')!.action, CheBrainAction.overview, reason: 'existing phrases keep their meaning');
      expect(CheBrainCommand.parse('open my brain')!.action, CheBrainAction.open);
      expect(CheBrainCommand.parse('back out')!.action, CheBrainAction.backOut);
      // The view-controls panel offers the same actions as pills with labels.
      await tester.tap(find.byTooltip('View controls: zoom, fit, center, inside, back'));
      await tester.pump();
      for (final label in ['Whole brain', 'Zoom in', 'Zoom out', 'Fit', 'Center on CHE', 'Center on selected', 'Inside', 'Back']) {
        expect(find.widgetWithText(CheBrainPill, label), findsOneWidget);
      }
      await _tapPill(tester, 'Zoom in');
      expect(spoken.last, startsWith('Closer'));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('8. phones get a bottom sheet, wide screens a side panel; the chrome fits both', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      await tester.pumpWidget(_room(_dots()));
      await tester.pump();
      var c = _controllerOf(tester);
      c.select(c.layout.node('mem:1')!, fly: false);
      c.openSelected();
      await tester.pump();
      final canvas = tester.getRect(find.byKey(const ValueKey('che-brain-canvas')));
      var card = tester.getRect(find.bySemanticsLabel(RegExp(r'^Memory card: My sister')));
      expect(card.left, closeTo(canvas.left + 12, 1));
      expect(card.right, closeTo(canvas.right - 12, 1));
      expect(card.bottom, lessThan(canvas.bottom - 40));
      expect(card.top, greaterThan(canvas.top + canvas.height * .35), reason: 'a bottom sheet leaves the upper brain visible');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());

      _useScreen(tester, _tablet);
      await tester.pumpWidget(_room(_dots(), size: _tablet));
      await tester.pump();
      c = _controllerOf(tester);
      c.select(c.layout.node('mem:1')!, fly: false);
      c.openSelected();
      await tester.pump();
      final wide = tester.getRect(find.byKey(const ValueKey('che-brain-canvas')));
      card = tester.getRect(find.bySemanticsLabel(RegExp(r'^Memory card: My sister')));
      expect(card.width, closeTo(360, 1));
      expect(card.right, closeTo(wide.right - 12, 1));
      expect(card.left, greaterThan(wide.center.dx), reason: 'a side panel leaves the brain in view on the left');
      expect(card.top, closeTo(wide.top + 52, 1));
      await tester.tap(find.byTooltip('Switch brain: CHE or an Office worker'));
      await tester.pump();
      expect(find.byType(CheBrainSwitcher), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('11. every control has a spoken name, states are words and icons, and the text contrast holds', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_room(_dots()));
      await tester.pump();
      await tester.tap(find.byTooltip('Switch brain: CHE or an Office worker'));
      await tester.pump();
      expect(find.bySemanticsLabel("CHE's brain, the central brain, in view"), findsOneWidget);
      final atlasCount = _experienceOf(_dots(), 'Atlas');
      expect(find.bySemanticsLabel("Atlas's brain, Research / scout: $atlasCount record${atlasCount == 1 ? '' : 's'}, working"), findsOneWidget);
      expect(find.bySemanticsLabel("Mira's brain, Customer / support copy: 0 records, no experience yet"), findsOneWidget);
      await tester.tap(find.byTooltip('Filter the brain'));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp(r'^Agents memories, \d+$')), findsOneWidget);
      expect(find.bySemanticsLabel('Verified'), findsOneWidget);
      expect(find.bySemanticsLabel('Failed tasks'), findsOneWidget);
      await tester.tap(find.byTooltip('View controls: zoom, fit, center, inside, back'));
      await tester.pump();
      expect(find.bySemanticsLabel('Fit everything in view'), findsOneWidget);
      expect(find.bySemanticsLabel('Back to the previous view'), findsWidgets);
      // Text on the Brain's surfaces: body text well above AA, dim text at least AA for large text.
      expect(_contrast(CheColors.text, CheColors.bg), greaterThan(7));
      expect(_contrast(CheColors.textDim, CheColors.surface), greaterThan(4.5));
      expect(_contrast(CheColors.accent, CheColors.bg), greaterThan(7));
      expect(_contrast(Colors.white, const Color(0xFF071012)), greaterThan(7), reason: 'card text on the card');
      // Verification states are words with distinct icons, never color alone.
      final labels = ['owner_attested', 'verified_source', 'hypothesis', 'model_opinion', 'inferred', 'unverified_reference', 'unknown'].map(cheBrainVerificationLabel).toList();
      expect(labels.map((l) => l.$1).toSet().length, labels.length);
      handle.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('12. loading, offline, pending, error, empty worker, no match and no result are quiet lines, never speech', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final spoken = <String>[];
      await tester.pumpWidget(_room(const [], spoken: spoken, loading: true));
      await tester.pump();
      expect(find.text('Loading the Brain…'), findsOneWidget);
      await tester.pumpWidget(_room(_dots(), spoken: spoken, offline: true, pending: 2));
      await tester.pump();
      expect(find.text('Offline: showing the Brain on this phone, 2 changes waiting to sync.'), findsOneWidget);
      await tester.pumpWidget(_room(_dots(), spoken: spoken, pending: 1));
      await tester.pump();
      expect(find.text('1 change on this phone waiting to sync; nothing is lost.'), findsOneWidget);
      var refreshed = 0;
      await tester.pumpWidget(_room(_dots(), spoken: spoken, error: 'the cloud did not answer', onRefresh: () async => refreshed++));
      await tester.pump();
      expect(find.text('Brain could not load: the cloud did not answer'), findsOneWidget);
      await _tapPill(tester, 'Retry');
      expect(refreshed, 1);
      expect(spoken, isEmpty, reason: 'passive states are shown, not spoken');
      await tester.pumpWidget(_room(_dots(), spoken: spoken));
      await tester.pump();
      final c = _controllerOf(tester);
      expect(c.layout.nodes.length, _dots().length, reason: 'the room took the dots that arrived after it opened (the replica finishing its load)');
      c.setScope('Mira');
      await tester.pump();
      expect(find.text('Mira has no experience recorded yet (Customer / support copy). The brain fills as Mira works; nothing is invented.'), findsOneWidget);
      await _tapPill(tester, 'Back to CHE');
      expect(c.scope, isNull);
      c.setLens(const CheBrainLens(status: 'failed', verified: true));
      await tester.pump();
      expect(c.visibleCount, 0);
      expect(find.text("No memories match these filters in CHE's brain."), findsOneWidget);
      await _tapPill(tester, 'Clear filters');
      expect(c.lens.isEmpty, isTrue);
      expect(find.textContaining('No memories match'), findsNothing);
      await tester.tap(find.byTooltip('Find a memory'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'zebra giraffe');
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pump();
      expect(find.text('No memory about "zebra giraffe" in CHE\'s brain.'), findsOneWidget);
      expect(spoken.last, 'I could not find a memory about zebra giraffe.', reason: 'the owner asked, so CHE answers');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('13. five thousand real-shaped records: build, switch brain, filter and draw within budget', (tester) async {
      _useScreen(tester, _phone, dpr: 3);
      final dots = _dots(extra: 5000);
      final sw = Stopwatch()..start();
      final c = CheBrainSpaceController(dots, roster: _roster)..clock = () => _clock;
      final built = sw.elapsedMilliseconds;
      sw.reset();
      c.setScope('Atlas');
      final switched = sw.elapsedMilliseconds;
      expect(c.layout.nodes.length, dots.where((d) => d.workers.contains('Atlas')).length);
      c.setScope(null);
      sw.reset();
      c.setLens(const CheBrainLens(verified: true));
      final shown = c.visibleCount;
      final filtered = sw.elapsedMilliseconds;
      expect(shown, dots.where((d) => d.isVerified).length);
      // ignore: avoid_print
      print('BRAIN_NAV_MS build=$built switch=$switched filter=$filtered n=${dots.length}');
      expect(built, lessThan(4000));
      expect(switched, lessThan(1500));
      expect(filtered, lessThan(500));
      c.dispose();
      await tester.pumpWidget(_room(dots));
      await tester.pump();
      await _settle(tester, frames: 5);
      expect(tester.takeException(), isNull);
      expect(find.textContaining('Brain constellation', findRichText: true), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  testWidgets('a state notice\'s action pill is its own VoiceOver button with a tap action', (tester) async {
    _useScreen(tester, _phone, dpr: 3);
    final handle = tester.ensureSemantics();
    final spoken = <String>[];
    await tester.pumpWidget(_room(_dots(), spoken: spoken));
    await tester.pump();
    final c = _controllerOf(tester);
    c.setScope('Mira');
    await tester.pump();
    final pill = find.bySemanticsLabel('Back to CHE');
    expect(pill, findsOneWidget, reason: 'the pill is not merged into the notice text');
    final node = tester.getSemantics(pill);
    expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    expect(node.getSemanticsData().hasFlag(SemanticsFlag.isButton), isTrue);
    expect(node.label, 'Back to CHE');
    await tester.tap(pill);
    await tester.pump();
    expect(c.scope, isNull, reason: 'the pill really goes back to CHE');
    handle.dispose();
  });
}
