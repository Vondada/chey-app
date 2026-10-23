// Brain Room list view (owner, 2026-10-23): five sections, origins, evidence read only from the
// record, and no "done" without evidence.
import 'package:chey/brain/che_brain_list.dart';
import 'package:chey/brain/che_brain_sections.dart';
import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

List<CheMemoryDot> dotsFrom(List<Map<String, dynamic>> records) =>
    cheBuildMemoryDots(savedMemories: const [], memoryNotes: const [], learnedPersonality: const [], learnedKnowledge: const [], brainRecords: records);

final records = <Map<String, dynamic>>[
  {
    'id': 'brainmem:1',
    'region': 'Conversations and Corrections',
    'kind': 'conversation',
    'title': 'You asked about the 86 model',
    'body': 'You asked what the 86 model is.',
    'verification': 'owner_attested',
    'source': {'kind': 'owner_chat'},
    'created_at': '2026-10-23T10:00:00Z',
  },
  {
    'id': 'flagstaff:9',
    'region': 'Learned Knowledge',
    'kind': 'flagstaff_exchange',
    'title': 'Codex suggested a cache',
    'body': 'Codex suggested caching the ledger.',
    'verification': 'external_correspondence',
    'source': {'kind': 'flagstaff_exchange'},
    'created_at': '2026-10-23T09:00:00Z',
  },
  {
    'id': 'web:1',
    'region': 'Trading and Market Research',
    'kind': 'web_read',
    'title': 'CME micro Nasdaq contract specs',
    'body': 'Tick size 0.25 index points.',
    'verification': 'verified_source',
    'source': {'kind': 'web_read', 'url': 'https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.html'},
    'created_at': '2026-10-22T09:00:00Z',
  },
  {
    'id': 'atlas:recursion',
    'region': 'Learned Knowledge',
    'kind': 'concept_card',
    'path': 'Knowledge Atlas/Coding/Recursion',
    'title': 'Recursion',
    'body': 'A function that calls itself.',
    'verification': 'curated_lesson',
    'source': {'kind': 'knowledge_atlas'},
  },
  {
    'id': 'mem:drink',
    'region': 'Personal Memory',
    'kind': 'memory',
    'title': 'Favorite drink',
    'body': 'My favorite drink is Sprite.',
    'verification': 'owner_attested',
    'source': {'kind': 'memory_record'},
  },
  {
    'id': 'job:abc123',
    'region': 'Active and Historical Tasks',
    'kind': 'job',
    'title': 'Fix the Film Studio misroute',
    'body': 'Kind: coding. Status: completed.\nResult: merged as 346fc51c40fc32ba6a78636e495d7c2f0fd13a0f in PR #475, deploy run 39953032802.',
    'verification': 'unverified_reference',
    'source': {'kind': 'job', 'status': 'completed', 'outcome': 'done'},
    'created_at': '2026-10-23T12:24:00Z',
  },
  {
    'id': 'job:nothing',
    'region': 'Active and Historical Tasks',
    'kind': 'job',
    'title': 'Render the beach video',
    'body': 'Kind: video. Status: completed.',
    'verification': 'unverified_reference',
    'source': {'kind': 'job', 'status': 'completed', 'outcome': 'done'},
    'created_at': '2026-10-23T11:00:00Z',
  },
  {
    'id': 'room:trading:t1',
    'region': 'Trading and Market Research',
    'kind': 'room_trade',
    'title': 'Paper trade closed',
    'body': 'EMA 20 pullback long on MNQ closed at target.',
    'verification': 'verified_source',
    'source': {
      'kind': 'room_event',
      'status': 'verified',
      'refs': {'trade_id': 'mnq-5m-ema20-0042'},
    },
    'created_at': '2026-10-23T13:00:00Z',
  },
];

void main() {
  final dots = dotsFrom(records);
  CheMemoryDot byId(String id) => dots.firstWhere((d) => d.id == id);

  test('every record lands in one of the five sections', () {
    expect(cheBrainSectionOf(byId('brainmem:1')), CheBrainSection.conversations);
    expect(cheBrainSectionOf(byId('flagstaff:9')), CheBrainSection.conversations, reason: 'an outside AI message is talk, not knowledge');
    expect(cheBrainSectionOf(byId('web:1')), CheBrainSection.research);
    expect(cheBrainSectionOf(byId('atlas:recursion')), CheBrainSection.knowledge);
    expect(cheBrainSectionOf(byId('mem:drink')), CheBrainSection.memory);
    expect(cheBrainSectionOf(byId('job:abc123')), CheBrainSection.actions);
    expect(cheBrainSectionOf(byId('room:trading:t1')), CheBrainSection.actions);
    final counts = cheBrainSectionCounts(dots);
    expect(counts.values.fold<int>(0, (a, b) => a + b), dots.length);
  });

  test('origins tell the owner, CHE and outside AIs apart', () {
    expect(cheBrainOriginOf(byId('brainmem:1')), 'You and CHE');
    expect(cheBrainOriginOf(byId('flagstaff:9')), contains('outside AI'));
    expect(cheBrainOriginOf(byId('mem:drink')), 'You');
    expect(cheBrainOriginOf(byId('web:1')), 'A source CHE read');
    expect(cheBrainTrustOf(byId('flagstaff:9')), isNot(contains('Verified')));
  });

  test('evidence comes only from the record: commit, PR, run and job from a job result', () {
    final ev = cheBrainEvidenceOf(byId('job:abc123'));
    final kinds = ev.map((e) => e.kind).toSet();
    expect(kinds, containsAll({CheEvidenceKind.commit, CheEvidenceKind.pullRequest, CheEvidenceKind.deployment, CheEvidenceKind.codingJob}));
    expect(ev.firstWhere((e) => e.kind == CheEvidenceKind.commit).url, 'https://github.com/Vondada/chey-app/commit/346fc51c40fc32ba6a78636e495d7c2f0fd13a0f');
    expect(ev.firstWhere((e) => e.kind == CheEvidenceKind.deployment).url, endsWith('/actions/runs/39953032802'));
    expect(cheActionProofOf(byId('job:abc123')), CheActionProof.proven);
  });

  test('a job marked done with no evidence is never called verified', () {
    final d = byId('job:nothing');
    final ev = cheBrainEvidenceOf(d);
    expect(ev.where((e) => e.kind != CheEvidenceKind.codingJob), isEmpty, reason: 'nothing invented beyond its own job id');
    final bare = CheMemoryDot(id: 'x', title: 'Done', body: 'Status: completed.', category: 'Agents', status: 'completed');
    expect(cheActionProofOf(bare), CheActionProof.claimedNoEvidence);
    expect(cheActionProofLabel(CheActionProof.claimedNoEvidence), contains('not verified'));
  });

  test('a trade links to its trade and replay by its stable id', () {
    final ev = cheBrainEvidenceOf(byId('room:trading:t1'));
    expect(ev.map((e) => (e.kind, e.id)), containsAll([(CheEvidenceKind.trade, 'mnq-5m-ema20-0042'), (CheEvidenceKind.replay, 'mnq-5m-ema20-0042')]));
    expect(ev.firstWhere((e) => e.kind == CheEvidenceKind.replay).route, '/trade-replay');
  });

  test('search matches every word, newest first, within a section', () {
    expect(cheBrainSearch(dots, 'sprite').map((d) => d.id), ['mem:drink']);
    expect(cheBrainSearch(dots, '', section: CheBrainSection.actions).first.id, 'room:trading:t1');
    expect(cheBrainSearch(dots, 'film misroute').single.id, 'job:abc123');
  });

  testWidgets('the list opens a record with its evidence; trade evidence without a screen says so; nothing speaks', (tester) async {
    final spoken = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CheBrainList(dots: dots, onReadAloud: (t) async => spoken.add(t)),
        ),
      ),
    );
    expect(find.text('All ${dots.length}'), findsOneWidget);
    await tester.tap(find.text('Actions 3'));
    await tester.pumpAndSettle();
    expect(find.text('Paper trade closed'), findsOneWidget);
    expect(find.text('Favorite drink'), findsNothing);
    await tester.tap(find.text('Paper trade closed'));
    await tester.pumpAndSettle();
    expect(find.text('Trade mnq-5m-ema20-0042'), findsOneWidget);
    expect(find.text('Evidence not available yet'), findsNWidgets(2));
    expect(spoken, isEmpty, reason: 'opening a record is silent');
    await tester.tap(find.text('Read aloud'));
    expect(spoken.single, contains('Paper trade closed'));
  });

  testWidgets('a done job without evidence says it is not verified', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: CheBrainList(dots: dots)),
      ),
    );
    await tester.enterText(find.byType(TextField), 'beach video');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Render the beach video'));
    await tester.pumpAndSettle();
    expect(find.textContaining('not verified'), findsWidgets);
  });

  test('voice and typing reach the list: sections by name, and back to the neural view', () {
    CheBrainCommand? p(String w) => CheBrainCommand.parse(w);
    expect(p('show the brain list')?.action, CheBrainAction.list);
    expect(p("Show the brain's actions")?.section, CheBrainSection.actions);
    expect(p('show my research in the brain')?.section, CheBrainSection.research);
    expect(p('CHE, show the brain conversations')?.section, CheBrainSection.conversations);
    expect(p('show the neural view')?.action, CheBrainAction.space);
    expect(p('show my actions'), isNull, reason: 'without the word brain it stays ordinary chat');
    final c = CheBrainSpaceController(dots);
    final said = c.execute(p("show the brain's actions")!);
    expect(c.listMode, isTrue);
    expect(c.listSection, CheBrainSection.actions);
    expect(said, startsWith('Actions: 3 records.'));
    c.execute(p('show the neural view')!);
    expect(c.listMode, isFalse);
  });
}
