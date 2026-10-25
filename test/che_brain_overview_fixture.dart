// Test data for the Brain Room overview: records in the exact shape the phone's Brain replica hands over
// (brain_store.js regions, kinds, verification, source maps) and Brain Ledger rows in the shape /api/brain/ledger
// returns (brain_ledger.js view()). Sample content only, labelled as such wherever it is shown.
import 'package:chey/home/che_memory_brain.dart';

final cheTestNow = DateTime.utc(2026, 10, 24, 21, 0);

String _at(Duration ago) => cheTestNow.subtract(ago).toIso8601String();

List<Map<String, dynamic>> cheTestBrainRecords() => [
      {'id': 'mem:red', 'kind': 'memory', 'region': 'Personal Memory', 'path': 'Preferences', 'title': 'You prefer red over blue for outfits', 'excerpt': 'You prefer red over blue for outfits. You said the red one matches your energy.', 'verification': 'owner_attested', 'created_at': _at(const Duration(minutes: 12)), 'source': {'kind': 'memory_record'}, 'links': [{'type': 'learned_from', 'to': 'conv:outfits'}], 'places': const []},
      {'id': 'mem:hoodies', 'kind': 'memory', 'region': 'Personal Memory', 'path': 'Preferences', 'title': 'You prefer hoodies in the house', 'excerpt': 'You prefer hoodies in the house.', 'verification': 'owner_attested', 'created_at': _at(const Duration(hours: 3)), 'source': {'kind': 'memory_record'}, 'links': const [], 'places': const []},
      {'id': 'conv:outfits', 'kind': 'conversation', 'region': 'Conversations and Corrections', 'path': 'Chat', 'title': 'Red or blue outfit, which is better?', 'excerpt': 'You: I like the red one better. CHE: The red matches your energy.', 'verification': 'owner_attested', 'created_at': _at(const Duration(minutes: 2)), 'source': {'kind': 'owner_chat'}, 'links': [{'type': 'related_to', 'to': 'mem:red'}], 'places': const []},
      {'id': 'conv:nails', 'kind': 'conversation', 'region': 'Conversations and Corrections', 'path': 'Chat', 'title': 'Red nails for the weekend', 'excerpt': 'You asked for red nail ideas for the weekend; red and blue both look good.', 'verification': 'owner_attested', 'created_at': _at(const Duration(days: 2)), 'source': {'kind': 'owner_chat'}, 'links': const [], 'places': const []},
      {'id': 'media:video', 'kind': 'video', 'region': 'YouTube and Media', 'path': 'Videos', 'title': 'Late night talk video', 'excerpt': 'A 24-second video, late night talk, made on the free renderer.', 'verification': 'verified_source', 'created_at': _at(const Duration(minutes: 30)), 'source': {'kind': 'video', 'video_url': 'https://example.com/che/late-night.mp4'}, 'links': const [], 'places': const []},
      {'id': 'trade:btc', 'kind': 'strategy_decision', 'region': 'Trading and Market Research', 'path': 'Crypto', 'title': 'BTC short setup analysed', 'excerpt': 'Trading analysis complete: BTC short setup on the 15-minute chart, paper only.', 'verification': 'derived', 'created_at': _at(const Duration(minutes: 8)), 'source': {'kind': 'strategy_decision', 'paper': true, 'status': 'complete', 'trade_id': 'sim-btc-0042'}, 'links': const [], 'places': const []},
      {'id': 'job:brainviz', 'kind': 'coding_job', 'region': 'Coding and Development', 'path': 'CHE Code', 'title': 'Code updated: brain visualization', 'excerpt': 'Coding job finished. Merged as commit 1a2b3c4d5e6f in PR #512.', 'verification': 'verified_source', 'created_at': _at(const Duration(hours: 1)), 'source': {'kind': 'job', 'status': 'complete', 'task_id': 'job-brainviz'}, 'links': const [], 'places': const []},
      {'id': 'task:edit', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Video edit finished', 'excerpt': 'Task: video edit finished. Status: complete. Workflow run 40122344928.', 'verification': 'verified_source', 'created_at': _at(const Duration(minutes: 34)), 'source': {'kind': 'team_task', 'agent': 'Nova', 'status': 'complete', 'outcome': 'done'}, 'links': const [], 'places': [{'region': 'Office Agents', 'path': 'Nova'}]},
      {'id': 'task:research', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Active', 'title': 'Read the EMA research papers', 'excerpt': 'Task: read three EMA research papers. Status: running.', 'verification': 'unverified_reference', 'created_at': _at(const Duration(minutes: 5)), 'source': {'kind': 'team_task', 'agent': 'Atlas', 'status': 'running'}, 'links': const [], 'places': [{'region': 'Office Agents', 'path': 'Atlas'}]},
      {'id': 'task:failed', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Index the music rights PDF', 'excerpt': 'Task failed: the PDF could not be read.', 'verification': 'unverified_reference', 'created_at': _at(const Duration(hours: 5)), 'source': {'kind': 'team_task', 'agent': 'Atlas', 'status': 'failed', 'outcome': 'failed'}, 'links': const [], 'places': const []},
      {'id': 'note:rea', 'kind': 'rea_investigation', 'region': 'REA Investigations', 'path': 'BandLab', 'title': 'How BandLab layers tracks', 'excerpt': 'Investigation: how BandLab layers vocal tracks and applies reverb.', 'verification': 'verified_source', 'created_at': _at(const Duration(days: 1)), 'source': {'kind': 'rea_investigation', 'url': 'https://www.bandlab.com/'}, 'links': const [], 'places': const []},
      {'id': 'skill:atlas', 'kind': 'concept_card', 'region': 'Learned Knowledge', 'path': 'Knowledge Atlas/Trading', 'title': 'Opening range breakout', 'excerpt': 'Lesson card: the opening range breakout and its risk rules.', 'verification': 'curated_lesson', 'created_at': _at(const Duration(days: 3)), 'source': {'kind': 'atlas'}, 'links': const [], 'places': const []},
      for (var i = 0; i < 18; i++)
        {'id': 'know:$i', 'kind': 'knowledge', 'region': 'Learned Knowledge', 'path': 'Facts', 'title': 'Futures chart fact $i', 'excerpt': 'Learned fact $i about futures charts and session times.', 'verification': i % 3 == 0 ? 'verified_source' : 'unverified_reference', 'created_at': _at(Duration(days: i, hours: 2)), 'source': {'kind': 'knowledge'}, 'links': i > 0 && i % 3 == 0 ? [{'type': 'related_to', 'to': 'know:${i - 3}'}, {'type': 'builds_upon', 'to': 'know:${i - 1}'}] : const [], 'places': const []},
    ];

List<CheMemoryDot> cheTestDots() => cheBuildMemoryDots(
      savedMemories: const [],
      memoryNotes: const [],
      learnedPersonality: const [],
      learnedKnowledge: const [],
      brainRecords: cheTestBrainRecords(),
    );

/// A very large Brain (for "never overcrowded" and frame-cost checks): [n] records spread across every region.
List<CheMemoryDot> cheLargeTestDots(int n) {
  const regions = [
    ('Personal Memory', 'memory'),
    ('Conversations and Corrections', 'conversation'),
    ('Learned Knowledge', 'knowledge'),
    ('Trading and Market Research', 'strategy_decision'),
    ('Coding and Development', 'coding_job'),
    ('Active and Historical Tasks', 'task'),
    ('YouTube and Media', 'video'),
  ];
  return cheBuildMemoryDots(
    savedMemories: const [],
    memoryNotes: const [],
    learnedPersonality: const [],
    learnedKnowledge: const [],
    brainRecords: [
      for (var i = 0; i < n; i++)
        {
          'id': 'big:$i',
          'kind': regions[i % regions.length].$2,
          'region': regions[i % regions.length].$1,
          'path': 'Bulk',
          'title': 'Sample record $i',
          'excerpt': 'Sample record $i for the large-brain check.',
          'verification': i % 4 == 0 ? 'verified_source' : 'unverified_reference',
          'created_at': _at(Duration(minutes: i * 7)),
          'source': {'kind': regions[i % regions.length].$2},
          'links': const [],
          'places': const [],
        },
    ],
  );
}

Map<String, dynamic> cheTestLedger({Duration newest = const Duration(minutes: 2), int count = 4}) {
  final rows = [
    ('SOURCE_INDEXED', 'Trading', 'EMA', 'EMA crossover paper indexed', 'INDEXED', 'ARTICLE', 'Indexed'),
    ('OWNER_MEMORY_SAVED', 'Owner Preferences', 'Personal', 'You prefer hoodies in the house', 'VERIFIED', 'OWNER', 'Knowledge'),
    ('CAPABILITY_TESTED', 'Workflows', 'Skills', 'Render a 24-second video', 'TESTED', 'TOOL RESULT', 'Tested'),
    ('CORRECTION', 'General Knowledge', 'Conversations', 'Corrected: the outfit preference is red', 'CORRECTED', 'CONVERSATION', 'Corrected'),
  ];
  final base = cheTestNow.subtract(newest).millisecondsSinceEpoch;
  return {
    'version': 1,
    'zone': 'America/Chicago',
    'totals': {'knowledge': 128, 'procedures': 6, 'capabilities': 3, 'pending': 2, 'failed': 1},
    'categories': const [],
    'recent': [
      for (final (i, (type, cat, sub, title, state, src, status)) in rows.take(count).indexed)
        {
          'brain_event_id': 'bev_$i',
          'ms': base - i * 7 * 60000,
          'category': cat,
          'subcategory': sub,
          'event_type': type,
          'title': title,
          'new_state': state,
          'source_type': src,
          'status': status,
          'time': 'Today · ${3 + i}:${(10 + i * 7).toString().padLeft(2, '0')} PM',
          'spoken': '$cat. $title.',
        },
    ],
  };
}
