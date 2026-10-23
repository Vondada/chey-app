// CHE Brain sections and evidence (owner, 2026-10-23): the Brain Room's list view sorts every real
// record into one of five sections and shows who it came from and what proves it.
//
// - Conversations: what the owner, CHE or an outside AI said. Never shown as verified research.
// - Research: material read or investigated (sources, trading research, REA, media, projects).
// - Knowledge: what CHE learned or was taught (lessons, Knowledge Atlas, skills, self-knowledge).
// - Memory: the owner's own facts and preferences.
// - Actions: work CHE or an Office worker did (jobs, tasks, room events, trades, renders, deploys).
//
// Evidence is read only from what the record itself holds (its source fields and the links or
// identifiers written in its text). Nothing is inferred or invented: an action with no evidence
// says so, and is never called verified.

import '../home/che_memory_brain.dart' show CheMemoryDot;

enum CheBrainSection { conversations, research, knowledge, memory, actions }

extension CheBrainSectionLabel on CheBrainSection {
  String get label => switch (this) {
    CheBrainSection.conversations => 'Conversations',
    CheBrainSection.research => 'Research',
    CheBrainSection.knowledge => 'Knowledge',
    CheBrainSection.memory => 'Memory',
    CheBrainSection.actions => 'Actions',
  };

  String get meaning => switch (this) {
    CheBrainSection.conversations => 'What you, CHE and other AIs said. Talk, not verified fact.',
    CheBrainSection.research => 'Sources CHE read and things she investigated.',
    CheBrainSection.knowledge => 'What CHE learned or was taught.',
    CheBrainSection.memory => 'Your own facts and preferences.',
    CheBrainSection.actions => 'Work CHE and her Office did, with its evidence.',
  };
}

// Execution records: trades, coding jobs, deployments, renders, evidence runs, strategy decisions.
const _actionKinds = {
  'job',
  'team_task',
  'agent_work_log',
  'trading_evidence_run',
  'experiment',
  'sim_run',
  'trade',
  'video',
  'render',
  'deployment',
  'commit',
  'coding_job',
  'strategy_decision',
};
// Recorded talk between CHE, the owner, AI providers and the Office workers.
const _conversationKinds = {'conversation', 'owner_chat', 'flagstaff_exchange', 'brainmem', 'handoff', 'correspondence_import', 'meeting'};
// Retrieved or analysed material: articles, sites, books, videos, documents, investigations.
const _researchKinds = {'web_read', 'knowledge_reference', 'library', 'rea_investigation', 'memory_note'};
const _researchRegions = {
  'Trading and Market Research',
  'YouTube and Media',
  'Business and Finance',
  'REA Investigations',
  'Problems and Opportunities',
  'Projects and Proposals',
};

/// The section a record belongs to (owner, 2026-10-23):
/// - Conversations: recorded talk between the owner, CHE, AI providers and Office workers.
/// - Research: articles, websites, books, videos and documents retrieved or analysed.
/// - Knowledge: indexed information with its sources and verification state.
/// - Memory: the owner's preferences, lessons, corrections and history.
/// - Actions: trades, coding jobs, deployments, generated videos and other execution records.
/// Order matters: a correction is memory even though it was said in chat; an outside AI's message is
/// a conversation wherever it is filed; an execution record is an action wherever it is filed.
CheBrainSection cheBrainSectionOf(CheMemoryDot d) {
  final kind = d.kind.toLowerCase();
  final sourceKind = '${d.sourceInfo['kind'] ?? ''}'.toLowerCase();
  final room = '${d.sourceInfo['room'] ?? ''}';
  if (kind == 'correction' || d.path == 'Corrections') return CheBrainSection.memory;
  if (_conversationKinds.contains(kind) ||
      _conversationKinds.contains(sourceKind) ||
      room == 'meetings' ||
      room == 'chat' ||
      d.verification == 'external_correspondence' ||
      d.region == 'Conversations and Corrections' ||
      d.category == 'Conversations') {
    return CheBrainSection.conversations;
  }
  if (_actionKinds.contains(kind) ||
      _actionKinds.contains(sourceKind) ||
      kind.startsWith('room_') ||
      sourceKind == 'room_event' ||
      d.region == 'Active and Historical Tasks' ||
      (d.status.isNotEmpty && !_researchKinds.contains(sourceKind))) {
    return CheBrainSection.actions;
  }
  if (d.region == 'Personal Memory' ||
      d.region == 'Experiments and Lessons' ||
      d.category == 'Memory' ||
      d.category == 'About you' ||
      d.category == 'Suggestion') {
    return CheBrainSection.memory;
  }
  if (_researchKinds.contains(sourceKind) || _researchKinds.contains(kind) || _researchRegions.contains(d.region) || d.category == 'Research') {
    return CheBrainSection.research;
  }
  return CheBrainSection.knowledge;
}

/// The record's status, exactly one of four words (owner, 2026-10-23).
enum CheBrainStatus { pending, verified, failed, unverified }

extension CheBrainStatusLabel on CheBrainStatus {
  String get label => switch (this) {
    CheBrainStatus.pending => 'Pending',
    CheBrainStatus.verified => 'Verified',
    CheBrainStatus.failed => 'Failed',
    CheBrainStatus.unverified => 'Unverified',
  };
}

/// Simulated, backtest or paper work: shown as such, never as a real (broker or live) result.
bool cheBrainIsSimulated(CheMemoryDot d) {
  final src = d.sourceInfo;
  final kind = '${d.kind} ${src['kind'] ?? ''} ${src['evidence'] ?? ''} ${src['mode'] ?? ''}'.toLowerCase();
  return src['paper'] == true || src['simulated'] == true || RegExp(r'\b(?:sim_run|simulated|simulation|backtest|paper)\b').hasMatch(kind);
}

/// Verified only with proof: the owner's word or a checked source for a fact, a recorded result for an
/// action. Everything else is Unverified; running work is Pending; failed work is Failed.
CheBrainStatus cheBrainStatusOf(CheMemoryDot d, [List<CheBrainEvidence>? evidence]) {
  if (d.outcome == 'failed') return CheBrainStatus.failed;
  if (d.outcome == 'live') return CheBrainStatus.pending;
  if (cheBrainSectionOf(d) == CheBrainSection.actions) {
    final proof = cheActionProofOf(d, evidence);
    if (proof == CheActionProof.proven) return CheBrainStatus.verified;
    if (proof == CheActionProof.claimedNoEvidence) return CheBrainStatus.unverified;
  }
  return const {'owner_attested', 'verified_source', 'derived'}.contains(d.verification) ? CheBrainStatus.verified : CheBrainStatus.unverified;
}

/// Who a record came from, in words: the owner, CHE, an Office worker, an outside AI or a source.
String cheBrainOriginOf(CheMemoryDot d) {
  final sourceKind = '${d.sourceInfo['kind'] ?? ''}'.toLowerCase();
  if (d.verification == 'external_correspondence' || sourceKind == 'flagstaff_exchange') return 'An outside AI (advice, not your words)';
  if (sourceKind == 'owner_chat' || d.kind == 'conversation') return 'You and CHE';
  if (d.verification == 'owner_attested') return 'You';
  final agent = '${d.sourceInfo['agent'] ?? ''}'.trim();
  if (agent.isNotEmpty && agent.toLowerCase() != 'che') return 'Office worker $agent';
  if (d.workers.isNotEmpty) return 'Office worker ${d.workers.first}';
  if (sourceKind == 'web_read' || sourceKind == 'library' || sourceKind == 'knowledge_reference') return 'A source CHE read';
  return 'CHE';
}

/// The record's fact-check label in plain words.
String cheBrainTrustOf(CheMemoryDot d) => switch (d.verification) {
  'owner_attested' => 'You confirmed this',
  'verified_source' => 'Verified against a source',
  'derived' => 'Calculated from verified data',
  'observed' => 'Seen on a screen or page',
  'curated_lesson' => 'Teaching content',
  'owner_practice' => 'Your practice',
  'external_correspondence' => 'Another AI\'s message',
  'superseded' => 'Replaced by a newer record',
  'contradicted' => 'Disputed by a newer record',
  'unverified_reference' || 'unverified_research_lead' => 'Not verified',
  'model_opinion' || 'hypothesis' || 'inferred' || 'proposed' => 'CHE\'s reasoning, not evidence',
  _ => 'Not verified',
};

enum CheEvidenceKind { commit, pullRequest, deployment, codingJob, trade, replay, video, article, link }

class CheBrainEvidence {
  const CheBrainEvidence(this.kind, this.label, {this.url = '', this.id = ''});

  final CheEvidenceKind kind;
  final String label;

  /// Opens in the browser when set.
  final String url;

  /// In-app target (a trade or job id) when there is no URL.
  final String id;

  String get key => '${kind.name}:${url.isNotEmpty ? url : id}';

  /// The in-app route that opens this evidence ('' when it is a web link).
  String get route => switch (kind) {
    CheEvidenceKind.trade => url.isEmpty ? '/trade' : '',
    CheEvidenceKind.replay => url.isEmpty ? '/trade-replay' : '',
    _ => '',
  };
}

final _urlRe = RegExp(r'https?://[^\s<>"\)\]]+', caseSensitive: false);
final _shaRe = RegExp(r'\b(?:commit|sha|merged as|squash(?:ed)?(?: as)?)\s*[:#]?\s*`?([0-9a-f]{7,40})\b', caseSensitive: false);
final _runRe = RegExp(r'\b(?:deploy(?:ment)?|workflow|actions?) run\s*#?\s*(\d{8,12})\b', caseSensitive: false);
final _prRe = RegExp(r'\b(?:PR|pull request)\s*#(\d{1,6})\b', caseSensitive: false);
final _tradeRe = RegExp(r'\btrade(?:[_ ]id)?[:#]\s*([A-Za-z0-9_.:-]{4,80})\b', caseSensitive: false);

const _repo = 'https://github.com/Vondada/chey-app';

CheBrainEvidence _fromUrl(String raw) {
  final url = raw.replaceAll(RegExp(r'[.,;:!?`]+$'), '');
  final u = url.toLowerCase();
  if (RegExp(r'github\.com/[^/]+/[^/]+/commit/[0-9a-f]{7,40}').hasMatch(u)) {
    return CheBrainEvidence(CheEvidenceKind.commit, 'Commit ${RegExp(r'commit/([0-9a-f]{7})').firstMatch(u)!.group(1)}', url: url);
  }
  if (RegExp(r'github\.com/[^/]+/[^/]+/pull/\d+').hasMatch(u)) {
    return CheBrainEvidence(CheEvidenceKind.pullRequest, 'Pull request #${RegExp(r'pull/(\d+)').firstMatch(u)!.group(1)}', url: url);
  }
  if (RegExp(r'github\.com/[^/]+/[^/]+/actions/runs/\d+').hasMatch(u)) {
    return CheBrainEvidence(CheEvidenceKind.deployment, 'Workflow run ${RegExp(r'runs/(\d+)').firstMatch(u)!.group(1)}', url: url);
  }
  if (u.contains('youtube.com/') || u.contains('youtu.be/') || RegExp(r'\.(mp4|mov|webm)(\?|$)').hasMatch(u)) {
    return CheBrainEvidence(CheEvidenceKind.video, 'Video', url: url);
  }
  final host = Uri.tryParse(url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? '';
  return CheBrainEvidence(CheEvidenceKind.article, host.isEmpty ? 'Source' : 'Source: $host', url: url);
}

/// Every piece of evidence the record holds, deduplicated, in a stable order. Empty when it holds none.
List<CheBrainEvidence> cheBrainEvidenceOf(CheMemoryDot d) {
  final out = <String, CheBrainEvidence>{};
  void add(CheBrainEvidence e) => out.putIfAbsent(e.key, () => e);
  final src = d.sourceInfo;
  final refs = src['refs'] is Map ? src['refs'] as Map : const {};

  for (final value in [
    src['url'],
    src['source_url'],
    src['video_url'],
    refs['url'],
    refs['video_url'],
    ...((src['urls'] as List?) ?? const []),
    ...((src['references'] as List?) ?? const []),
  ]) {
    final s = value is Map ? '${value['url'] ?? ''}' : '${value ?? ''}';
    if (_urlRe.hasMatch(s)) add(_fromUrl(_urlRe.firstMatch(s)!.group(0)!));
  }
  for (final e in (src['evidence'] as List?) ?? const []) {
    final s = '$e';
    for (final m in _urlRe.allMatches(s)) {
      add(_fromUrl(m.group(0)!));
    }
  }
  final commit = '${refs['commit'] ?? refs['sha'] ?? src['commit'] ?? ''}'.trim();
  if (RegExp(r'^[0-9a-f]{7,40}$', caseSensitive: false).hasMatch(commit)) {
    add(CheBrainEvidence(CheEvidenceKind.commit, 'Commit ${commit.substring(0, 7)}', url: '$_repo/commit/$commit'));
  }
  final pr = '${refs['pr'] ?? refs['pull_request'] ?? src['pr'] ?? ''}'.replaceAll('#', '').trim();
  if (RegExp(r'^\d{1,6}$').hasMatch(pr)) add(CheBrainEvidence(CheEvidenceKind.pullRequest, 'Pull request #$pr', url: '$_repo/pull/$pr'));
  final run = '${refs['run_id'] ?? refs['deploy_run'] ?? src['run_id'] ?? ''}'.trim();
  if (RegExp(r'^\d{8,12}$').hasMatch(run)) add(CheBrainEvidence(CheEvidenceKind.deployment, 'Workflow run $run', url: '$_repo/actions/runs/$run'));
  final trade = '${refs['trade_id'] ?? src['trade_id'] ?? ''}'.trim();
  if (trade.isNotEmpty) {
    add(CheBrainEvidence(CheEvidenceKind.trade, 'Trade $trade', id: trade));
    add(CheBrainEvidence(CheEvidenceKind.replay, 'Replay trade $trade', id: trade));
  }
  final sourceKind = '${src['kind'] ?? ''}';
  if (sourceKind == 'job' || sourceKind == 'team_task' || sourceKind == 'agent_work_log') {
    final job = '${src['task_id'] ?? (d.id.startsWith('job:') ? d.id.substring(4) : '')}'.trim();
    if (job.isNotEmpty) add(CheBrainEvidence(CheEvidenceKind.codingJob, 'Job ${job.length > 12 ? job.substring(0, 12) : job}', id: job));
  }

  // Identifiers written in the record's own text (a job's result names its commit, PR or run).
  final text = '${d.title}\n${d.body}';
  for (final m in _urlRe.allMatches(text)) {
    add(_fromUrl(m.group(0)!));
  }
  for (final m in _shaRe.allMatches(text)) {
    final sha = m.group(1)!;
    if (!out.values.any((e) => e.kind == CheEvidenceKind.commit && e.url.contains(sha.substring(0, 7)))) {
      add(CheBrainEvidence(CheEvidenceKind.commit, 'Commit ${sha.substring(0, 7)}', url: '$_repo/commit/$sha'));
    }
  }
  for (final m in _prRe.allMatches(text)) {
    add(CheBrainEvidence(CheEvidenceKind.pullRequest, 'Pull request #${m.group(1)}', url: '$_repo/pull/${m.group(1)}'));
  }
  for (final m in _runRe.allMatches(text)) {
    add(CheBrainEvidence(CheEvidenceKind.deployment, 'Workflow run ${m.group(1)}', url: '$_repo/actions/runs/${m.group(1)}'));
  }
  for (final m in _tradeRe.allMatches(text)) {
    final id = m.group(1)!;
    add(CheBrainEvidence(CheEvidenceKind.trade, 'Trade $id', id: id));
    add(CheBrainEvidence(CheEvidenceKind.replay, 'Replay trade $id', id: id));
  }
  return out.values.toList();
}

/// Evidence the app opens itself (Lane E's trade replay); every other kind opens as a web link.
const cheInAppEvidenceKinds = {CheEvidenceKind.trade, CheEvidenceKind.replay};

/// The Brain record ids a chat reply rests on (`record_ids` on the Worker's done event), or empty.
List<String> cheRecordIdsOf(Object? raw) => <String>{
  for (final v in (raw is List ? raw : const []))
    if ('$v'.trim().isNotEmpty && '$v'.length <= 200) '$v'.trim(),
}.take(12).toList();

/// An action's state as the record proves it. "Done" is only claimed with evidence attached.
enum CheActionProof { proven, claimedNoEvidence, failed, inProgress, unknown }

CheActionProof cheActionProofOf(CheMemoryDot d, [List<CheBrainEvidence>? evidence]) {
  // A job's own id names the work, it does not prove it: only a result (commit, PR, run, trade,
  // video, source) counts.
  final ev = (evidence ?? cheBrainEvidenceOf(d)).where((e) => e.kind != CheEvidenceKind.codingJob);
  return switch (d.outcome) {
    'done' => ev.isEmpty ? CheActionProof.claimedNoEvidence : CheActionProof.proven,
    'failed' => CheActionProof.failed,
    'live' => CheActionProof.inProgress,
    _ => CheActionProof.unknown,
  };
}

String cheActionProofLabel(CheActionProof p) => switch (p) {
  CheActionProof.proven => 'Done, with evidence',
  CheActionProof.claimedNoEvidence => 'Marked done, but no evidence recorded: not verified',
  CheActionProof.failed => 'Failed',
  CheActionProof.inProgress => 'Still in progress',
  CheActionProof.unknown => 'Outcome not recorded',
};

/// Records matching [query] (every word, in the title, body, origin or section), newest first.
List<CheMemoryDot> cheBrainSearch(Iterable<CheMemoryDot> dots, String query, {CheBrainSection? section}) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  final out = <CheMemoryDot>[
    for (final d in dots)
      if (!d.archived || words.isNotEmpty)
        if (section == null || cheBrainSectionOf(d) == section)
          if (words.isEmpty || words.every('${d.title}\n${d.body}\n${cheBrainOriginOf(d)}\n${cheBrainSectionOf(d).label}'.toLowerCase().contains)) d,
  ];
  out.sort((a, b) => (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0)));
  return out;
}

Map<CheBrainSection, int> cheBrainSectionCounts(Iterable<CheMemoryDot> dots) {
  final counts = {for (final s in CheBrainSection.values) s: 0};
  for (final d in dots) {
    if (d.archived) continue;
    final s = cheBrainSectionOf(d);
    counts[s] = counts[s]! + 1;
  }
  return counts;
}
