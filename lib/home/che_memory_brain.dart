// Memory Brain: CHE's real memories as an immersive 3D space (see
// lib/brain/). Every learned thought is a category-colored orb, NO capacity
// limit. Related memories connect like neural branches. Orbit, travel inside,
// select, open, expand clusters, by touch or voice.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../brain/che_brain_navigation.dart';
import '../brain/che_brain_space.dart';
import '../brain/che_brain_space_model.dart';
import '../che_ui/che_theme.dart';

class CheMemoryDot {
  const CheMemoryDot({
    required this.id,
    required this.title,
    required this.body,
    required this.category,
    this.tokens = const [],
    this.at,
    this.clusterId,
    this.source = 'CHE',
    this.confidence,
    this.lastVerifiedAt,
    this.scope = 'general',
    this.importance = 3,
    this.links = const [],
    this.region = '',
    this.path = '',
    this.kind = '',
    this.verification = '',
    this.status = '',
    this.workers = const [],
    this.project = '',
    this.archived = false,
  });

  final String id;
  final String title;
  final String body;
  final String category;
  final List<String> tokens;
  final DateTime? at;
  final String? clusterId;
  final String source;
  final double? confidence;
  final DateTime? lastVerifiedAt;
  final String scope;
  final int importance;

  /// Ids of earlier memories this one builds on (real shared topics).
  final List<String> links;

  /// Brain region and folder, when the memory came from the unified Brain ('' otherwise).
  final String region;
  final String path;
  final String kind;

  /// Fact-check label: owner_attested, verified_source, unverified_reference, hypothesis, model_opinion, inferred, unknown or ''.
  final String verification;

  /// A task's recorded status ('' for anything that is not a task).
  final String status;

  /// Internal Office workers whose brains hold this record (real attribution: a task's owner and its handoff partners).
  final List<String> workers;
  final String project;

  /// Historical or archived: no longer live work.
  final bool archived;

  bool get isVerified => verification == 'owner_attested' || verification == 'verified_source';

  /// A task's outcome: 'done', 'failed', 'live' or '' (not a task or unknown).
  String get outcome => switch (status.toLowerCase()) {
        'complete' || 'completed' || 'done' || 'succeeded' || 'success' => 'done',
        'failed' || 'error' || 'cancelled' || 'canceled' => 'failed',
        'queued' || 'running' || 'reviewing' || 'working' || 'waiting' || 'in_progress' || 'live' => 'live',
        _ => '',
      };

  /// The owner's own memory (what he said and what CHE learned about him) as opposed to shared Office knowledge.
  bool get isPersonal => region.isNotEmpty
      ? region == 'Personal Memory' || region == 'Conversations and Corrections'
      : scope == 'owner' && (category == 'Memory' || category == 'About you' || category == 'Conversations' || category == 'Suggestion');
}

/// Internal Office workers named in a record's places (the Office Agents region), never outside AIs.
List<String> cheBrainWorkersOf(Map<String, dynamic> record) {
  final out = <String>[];
  void add(Object? region, Object? path) {
    final name = '${path ?? ''}'.trim();
    final lower = name.toLowerCase();
    // CHE's own core record sits in the Office Agents region under her name: she is the centre, never one of her workers.
    if ('$region' != 'Office Agents' || name.isEmpty || lower == 'che' || lower == 'office' || lower == 'office agent' || lower.startsWith('http') || cheBrainExternalAi.hasMatch(name) || cheBrainMentionsExternalAi.hasMatch(name) || out.any((w) => w.toLowerCase() == lower)) return;
    out.add(name);
  }
  add(record['region'], record['path']);
  for (final place in (record['places'] as List?) ?? const []) {
    if (place is Map) add(place['region'], place['path']);
  }
  return out;
}

/// Build unlimited dots from Worker memories / notes / learning — never capped.
List<CheMemoryDot> cheBuildMemoryDots({
  required List<String> savedMemories,
  List<Map<String, dynamic>> memoryRecords = const [],
  required List<Map<String, dynamic>> memoryNotes,
  required List<Map<String, dynamic>> learnedPersonality,
  required List<String> learnedKnowledge,
  List<Map<String, dynamic>> brainLinks = const [],
  List<String> suggestions = const [],
  List<Map<String, dynamic>> conversationMemories = const [],
  List<Map<String, dynamic>> brainRecords = const [],
}) {
  // brainLinks are applied in CheMemoryBrainRoom via cheRelatedMemoryEdges.

  final out = <CheMemoryDot>[];
  var i = 0;
  final structuredTexts = <String>{};
  for (final record in memoryRecords) {
    if (record['active'] == false) continue;
    final body = '${record['text'] ?? ''}'.trim();
    if (body.isEmpty) continue;
    structuredTexts.add(body.toLowerCase());
    final title = '${record['title'] ?? body}'.trim();
    out.add(
      CheMemoryDot(
        id: '${record['id'] ?? 'mem-record-$i'}',
        title: _shortTitle(title),
        body: body,
        category: '${record['category'] ?? 'Memory'}',
        tokens: _tokens(body),
        at: DateTime.tryParse('${record['created_at'] ?? ''}'),
        source: '${record['source'] ?? 'Owner memory'}',
        confidence: (record['confidence'] as num?)?.toDouble(),
        lastVerifiedAt: DateTime.tryParse('${record['last_verified_at'] ?? record['created_at'] ?? ''}'),
        scope: '${record['scope'] ?? 'owner'}',
        importance: ((record['importance'] as num?)?.round() ?? 3).clamp(1, 5),
        verification: '${record['verification_status'] ?? 'owner_attested'}',
        kind: 'memory',
      ),
    );
    i++;
  }
  // Older installs stored owner memories as strings only. Keep showing those,
  // but do not duplicate a memory that now has structured provenance.
  for (final m in savedMemories) {
    final t = m.trim();
    if (t.isEmpty || structuredTexts.contains(t.toLowerCase())) continue;
    out.add(CheMemoryDot(id: 'legacy-mem-$i', title: _shortTitle(t), body: t, category: 'Memory', tokens: _tokens(t), source: 'Legacy owner memory', scope: 'owner', verification: 'owner_attested', kind: 'memory'));
    i++;
  }
  for (final n in memoryNotes) {
    final title = '${n['title'] ?? 'Note'}'.trim();
    final bullets = (n['bullets'] as List?) ?? const [];
    final bodyText = '${n['body'] ?? n['text'] ?? ''}';
    final body = [
      if (bodyText.trim().isNotEmpty) bodyText.trim(),
      if (bodyText.trim().isEmpty) title,
      for (final b in bullets) '• $b',
      if ('${n['url'] ?? ''}'.isNotEmpty) '${n['url']}',
    ].where((s) => s.trim().isNotEmpty).join('\n');
    if (body.trim().isEmpty) continue;
    final kind = '${n['kind'] ?? n['region'] ?? ''}'.toLowerCase();
    // Live specialist work from the Worker's brain graph (kind agent_task,
    // region Office Agents) gets its own lobe; never lumped into Learning.
    final category = kind.contains('agent_task') || '${n['region'] ?? ''}'.toLowerCase().contains('office agent')
        ? 'Agents'
        : kind.contains('ml') || kind.contains('classif') || kind.contains('cluster')
        ? 'ML Learning'
        : kind.contains('translat')
        ? 'Translation'
        : kind.contains('scout') || kind.contains('research')
        ? 'Research'
        : 'Learning';
    final rawId = '${n['id'] ?? ''}';
    out.add(
      CheMemoryDot(
        id: rawId.isNotEmpty ? rawId : 'note-$i',
        title: _shortTitle(title),
        body: body,
        category: category,
        tokens: _tokens('$title $body $kind ${n['locale'] ?? ''}'),
        at: DateTime.tryParse('${n['created_at'] ?? ''}'),
        clusterId: n['cluster_id']?.toString(),
        source: '${n['source'] ?? n['agent'] ?? n['url'] ?? 'CHE research'}',
        confidence: (n['confidence'] as num?)?.toDouble(),
        lastVerifiedAt: DateTime.tryParse('${n['last_verified_at'] ?? n['verified_at'] ?? n['updated_at'] ?? n['created_at'] ?? ''}'),
        scope: '${n['scope'] ?? n['ownership'] ?? 'general'}',
        importance: ((n['importance'] as num?)?.round() ?? 3).clamp(1, 5),
        kind: kind,
        verification: '${n['verification'] ?? n['verification_status'] ?? (n['verified_at'] != null ? 'verified_source' : 'unverified_reference')}',
        status: category == 'Agents' ? '${n['status'] ?? ''}' : '',
        workers: category == 'Agents' && n['agent'] != null ? cheBrainWorkersOf({'region': 'Office Agents', 'path': n['agent']}) : const [],
      ),
    );
    i++;
  }
  for (final p in learnedPersonality) {
    final text = '${p['statement'] ?? p['text'] ?? ''}'.trim();
    if (text.isEmpty) continue;
    out.add(
      CheMemoryDot(
        id: 'you-$i',
        title: _shortTitle(text),
        body: text,
        category: 'About you',
        tokens: _tokens(text),
        source: '${p['source'] ?? 'Owner interactions'}',
        confidence: (p['confidence'] as num?)?.toDouble(),
        at: DateTime.tryParse('${p['created_at'] ?? p['at'] ?? ''}'),
        lastVerifiedAt: DateTime.tryParse('${p['updated_at'] ?? p['verified_at'] ?? p['created_at'] ?? ''}'),
        scope: 'owner',
        verification: 'inferred',
        kind: 'trait',
      ),
    );
    i++;
  }
  for (final k in learnedKnowledge) {
    final t = k.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(id: 'know-$i', title: _shortTitle(t), body: t, category: 'Knowledge', tokens: _tokens(t), source: 'CHE learned knowledge', scope: 'general', verification: 'unverified_reference', kind: 'knowledge'));
    i++;
  }
  for (final s in suggestions) {
    final t = s.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(id: 'sug-$i', title: _shortTitle(t), body: t, category: 'Suggestion', tokens: _tokens(t), source: 'CHE planning', scope: 'owner', verification: 'inferred', kind: 'suggestion'));
    i++;
  }
  // Every conversation with the owner is a memory; it links to the earlier
  // ones it builds on and grows with how often its topic comes back.
  for (final m in conversationMemories) {
    final title = '${m['title'] ?? ''}'.trim();
    final body = '${m['body'] ?? title}'.trim();
    if (body.isEmpty) continue;
    final strength = (m['strength'] as num?)?.round() ?? 1;
    out.add(
      CheMemoryDot(
        id: 'conv:${m['id'] ?? i}',
        title: _shortTitle(title.isEmpty ? body : title),
        body: body,
        category: 'Conversations',
        tokens: _tokens(body),
        at: DateTime.tryParse('${m['at'] ?? ''}'),
        source: 'Conversation with you',
        scope: 'owner',
        importance: (strength + 2).clamp(1, 5),
        links: [for (final l in (m['links'] as List?) ?? const []) 'conv:$l'],
        verification: 'owner_attested',
        kind: 'conversation',
      ),
    );
    i++;
  }
  // The Brain replica on the phone: the same records with stable ids, so a
  // record already drawn from the cloud lists is not drawn twice. Offline, this
  // is where every dot comes from.
  final drawn = out.map((d) => d.id).toSet();
  for (final r in brainRecords) {
    if (r['deleted'] == true) continue;
    final id = '${r['id'] ?? ''}';
    if (id.isEmpty) continue;
    final bare = id.contains(':') ? id.substring(id.indexOf(':') + 1) : id;
    if (drawn.contains(id) || drawn.contains(bare) || drawn.contains('conv:$bare')) continue;
    final body = '${r['excerpt'] ?? r['body'] ?? ''}'.trim();
    if (body.isEmpty) continue;
    final region = '${r['region'] ?? ''}';
    final kind = '${r['kind'] ?? ''}';
    // Knowledge Atlas cards (curated lessons) and the owner's practice on them are their own group.
    final atlas = kind == 'concept_card' || kind == 'atlas_progress' || '${r['path'] ?? ''}'.startsWith('Knowledge Atlas/');
    final category = atlas
        ? 'Knowledge Atlas'
        : region == 'Personal Memory'
        ? 'Memory'
        : region == 'Conversations and Corrections'
        ? 'Conversations'
        : region == 'Office Agents' || region == 'Active and Historical Tasks'
        ? 'Agents'
        : region == 'Experiments and Lessons' || region == 'Daily Audits and Conclusions'
        ? 'Learning'
        : region == 'Trading and Market Research' || region == 'YouTube and Media' || region == 'Business and Finance'
            || region == 'REA Investigations' || region == 'Problems and Opportunities' || region == 'Projects and Proposals'
        ? 'Research'
        : 'Knowledge';
    final score = (r['significance'] is Map) ? ((r['significance'] as Map)['score'] as num?)?.toDouble() : null;
    final src = r['source'] is Map ? r['source'] as Map : const {};
    final path = '${r['path'] ?? ''}';
    final status = '${src['outcome'] ?? src['status'] ?? ''}';
    final workers = cheBrainWorkersOf(r);
    final who = '${src['agent'] ?? ''}'.trim();
    out.add(
      CheMemoryDot(
        id: id,
        title: _shortTitle('${r['title'] ?? body}'),
        body: body,
        category: category,
        tokens: _tokens(body),
        at: DateTime.tryParse('${r['created_at'] ?? ''}'),
        source: who.isNotEmpty ? who : '${r['verification'] ?? 'unknown'}'.replaceAll('_', ' '),
        scope: !atlas && (region == 'Personal Memory' || region == 'Conversations and Corrections') ? 'owner' : 'general',
        importance: score == null ? 3 : (1 + (score * 4).round()).clamp(1, 5),
        links: [for (final l in (r['links'] as List?) ?? const []) if (l is Map) '${l['to']}'],
        region: region,
        path: path,
        kind: '${r['kind'] ?? ''}',
        verification: '${r['verification'] ?? 'unknown'}',
        status: status,
        workers: workers,
        project: region == 'Projects and Proposals' ? path : '${src['project'] ?? ''}',
        archived: src['archived'] == true || path == 'Historical' || path.toLowerCase().contains('archive'),
      ),
    );
    drawn.add(id);
    i++;
  }
  return out;
}

String _shortTitle(String text) {
  final line = text.split(RegExp(r'[\n.]')).first.trim();
  if (line.length <= 42) return line.isEmpty ? 'Memory' : line;
  return '${line.substring(0, 40).trimRight()}…';
}

/// Worker brain_graph.links + same-cluster + token overlap → edge pairs for paint.
List<(String, String)> cheRelatedMemoryEdges(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const []}) {
  final ids = {for (final d in dots) d.id};
  final edges = <(String, String)>[];
  final seen = <String>{};
  void add(String a, String b) {
    if (a == b || !ids.contains(a) || !ids.contains(b)) return;
    final key = a.compareTo(b) < 0 ? '$a|$b' : '$b|$a';
    if (seen.add(key)) edges.add((a, b));
  }

  for (final link in brainLinks) {
    add('${link['source'] ?? ''}', '${link['target'] ?? ''}');
  }
  for (final d in dots) {
    for (final l in d.links) {
      add(d.id, l);
    }
  }
  // Same cluster_id (ML clustering nodes): a chain through the cluster, not
  // every pair (a cluster of 300 would otherwise draw ~45k lines).
  final lastInCluster = <String, String>{};
  for (final d in dots) {
    final cid = d.clusterId;
    if (cid == null || cid.isEmpty) continue;
    final prev = lastInCluster[cid];
    if (prev != null) add(prev, d.id);
    lastInCluster[cid] = d.id;
  }
  // Token overlap fallback
  final byToken = <String, List<CheMemoryDot>>{};
  for (final d in dots) {
    for (final tok in d.tokens.take(8)) {
      byToken.putIfAbsent(tok, () => []).add(d);
    }
  }
  for (final group in byToken.values) {
    if (group.length < 2) continue;
    final take = group.length > 12 ? group.take(12).toList() : group;
    for (var i = 0; i < take.length; i++) {
      var links = 0;
      for (var j = i + 1; j < take.length && links < 3; j++) {
        add(take[i].id, take[j].id);
        links++;
      }
    }
  }
  return edges;
}

List<String> _tokens(String text) {
  return text.toLowerCase().split(RegExp(r'[^a-z0-9]+')).where((w) => w.length > 2).toSet().take(24).toList();
}

// The brain's palette: green, teal, cyan, blue, violet and white.
Color cheMemoryCategoryColor(String category) => switch (category.toLowerCase()) {
  'memory' => const Color(0xFF3EE6C9),
  'conversations' => const Color(0xFF52E89A),
  'learning' => const Color(0xFF4FB8FF),
  'ml learning' => const Color(0xFFA77BFF),
  'research' => const Color(0xFF7CF0FF),
  'about you' => const Color(0xFFC79BFF),
  'knowledge' => const Color(0xFF6E8CFF),
  'suggestion' => const Color(0xFF9DF7C9),
  'translation' => const Color(0xFFEAF6FF),
  'agents' => const Color(0xFFFFB54D),
  'knowledge atlas' => const Color(0xFF8FE3FF),
  _ => CheColors.accent,
};

class CheMemoryBrainRoom extends StatefulWidget {
  const CheMemoryBrainRoom({
    super.key,
    required this.dots,
    this.brainLinks = const [],
    this.onReadAloud,
    this.onRefresh,
    this.embedded = true,
    this.active = true,
    this.onOpenAgent,
    this.roster = const [],
    this.loading = false,
    this.offline = false,
    this.pendingSync = 0,
    this.error,
  });

  final List<CheMemoryDot> dots;

  /// Related links from Worker `/api/state` brain_graph (clustering + similarity).
  final List<Map<String, dynamic>> brainLinks;
  final Future<void> Function(String text)? onReadAloud;
  final Future<void> Function()? onRefresh;
  final bool embedded;

  /// When false, pause the breathing / pulse AnimationController.
  final bool active;

  /// Deep link for live agent orbs: the agent's name. Null hides the button.
  final void Function(String agentName)? onOpenAgent;

  /// The Office roster (`/api/state` team): names, roles and live status of the
  /// permanent internal workers, so an idle worker's brain is listed as empty
  /// rather than missing. Temporary and outside-AI entries are ignored.
  final List<Map<String, dynamic>> roster;

  /// Quiet states shown as muted text in the chrome, never spoken on their own.
  final bool loading;
  final bool offline;
  final int pendingSync;
  final String? error;

  @override
  State<CheMemoryBrainRoom> createState() => _CheMemoryBrainRoomState();
}

enum _BrainPanel { none, search, filters, brains, view }

class _CheMemoryBrainRoomState extends State<CheMemoryBrainRoom> {
  late final CheBrainSpaceController _space;
  final _search = TextEditingController();
  _BrainPanel _panel = _BrainPanel.none;
  String? _lastSearchMiss;

  // Taken in initState, never lazily: a `late` field first read inside
  // didUpdateWidget would be computed from the new widget and the first change
  // (the replica finishing its load) would be missed.
  late int _signature;

  @override
  void initState() {
    super.initState();
    _space = CheBrainSpaceController(widget.dots, brainLinks: widget.brainLinks, roster: widget.roster);
    _signature = _sig();
  }

  // The hub rebuilds the dot list on every parent rebuild (e.g. while a chat
  // reply streams); re-layout only when the memories actually changed.
  int _sig() => Object.hash(
    Object.hashAll([for (final d in widget.dots) Object.hash(d.id, d.title, d.body, d.category, d.importance, Object.hashAll(d.workers), d.verification, d.status)]),
    Object.hashAll([for (final l in widget.brainLinks) Object.hash(l['source'], l['target'])]),
    Object.hashAll([for (final m in widget.roster) Object.hash(m['name'], m['role'], m['runtime_status'], m['temporary'], m['retired'])]),
  );

  @override
  void didUpdateWidget(covariant CheMemoryBrainRoom old) {
    super.didUpdateWidget(old);
    final next = _sig();
    if (next != _signature) {
      _signature = next;
      _space.update(widget.dots, widget.brainLinks, roster: widget.roster);
    }
  }

  @override
  void dispose() {
    _search.dispose();
    _space.dispose();
    super.dispose();
  }

  void _say(String text) => unawaited(widget.onReadAloud?.call(text) ?? Future<void>.value());

  void _toggle(_BrainPanel panel) {
    HapticFeedback.selectionClick();
    setState(() => _panel = _panel == panel ? _BrainPanel.none : panel);
  }

  void _find(String query) {
    if (query.trim().isEmpty) return;
    HapticFeedback.selectionClick();
    final reply = _space.find(query);
    setState(() => _lastSearchMiss = reply.startsWith('I could not find') ? query.trim() : null);
    _say(reply);
  }

  void _category(String? category) {
    setState(() {});
    _say(_space.setFilter(category));
  }

  Widget _iconButton(IconData icon, String label, VoidCallback onTap, {bool on = false}) => Semantics(
    button: true,
    selected: on,
    label: label,
    excludeSemantics: true,
    child: IconButton(
      tooltip: label,
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      icon: Icon(icon, size: 20, color: on ? CheColors.accent : Colors.white70),
      onPressed: onTap,
    ),
  );

  /// The one quiet state line that applies right now, if any. Order: an error,
  /// then loading, then an empty brain, then no matches, then sync status.
  Widget? _notice(int total, int shown) {
    final c = _space;
    if (widget.error != null && widget.error!.trim().isNotEmpty) {
      return CheBrainStateNotice(icon: Icons.error_outline_rounded, text: 'Brain could not load: ${widget.error}', tone: CheBrainNoticeTone.error, actionLabel: widget.onRefresh == null ? null : 'Retry', onAction: widget.onRefresh == null ? null : () => widget.onRefresh!());
    }
    if (widget.loading && total == 0) return const CheBrainStateNotice(icon: Icons.hourglass_empty_rounded, text: 'Loading the Brain…');
    if (c.scope != null && (c.worker(c.scope)?.records ?? total) == 0) {
      final orb = c.worker(c.scope);
      return CheBrainStateNotice(
        icon: Icons.person_outline_rounded,
        text: '${c.scope} has no experience recorded yet${orb != null && orb.role.isNotEmpty ? ' (${orb.role})' : ''}. The brain fills as ${c.scope} works; nothing is invented.',
        actionLabel: 'Back to CHE',
        onAction: () => _say(c.setScope(null)),
      );
    }
    if (total > 0 && shown == 0 && (c.filter.isNotEmpty || !c.lens.isEmpty)) {
      return CheBrainStateNotice(
        icon: Icons.filter_alt_off_outlined,
        text: 'No memories match these filters in ${c.brainName}.',
        actionLabel: 'Clear filters',
        onAction: () => _say(c.clearAll()),
      );
    }
    if (_lastSearchMiss != null) {
      return CheBrainStateNotice(icon: Icons.search_off_rounded, text: 'No memory about "$_lastSearchMiss" in ${c.brainName}.', actionLabel: 'Dismiss', onAction: () => setState(() => _lastSearchMiss = null));
    }
    if (widget.offline) {
      return CheBrainStateNotice(
        icon: Icons.cloud_off_outlined,
        text: 'Offline: showing the Brain on this phone${widget.pendingSync > 0 ? ', ${widget.pendingSync} change${widget.pendingSync == 1 ? '' : 's'} waiting to sync' : ''}.',
        tone: CheBrainNoticeTone.warning,
      );
    }
    if (widget.pendingSync > 0) {
      return CheBrainStateNotice(icon: Icons.sync_outlined, text: '${widget.pendingSync} change${widget.pendingSync == 1 ? '' : 's'} on this phone waiting to sync; nothing is lost.');
    }
    if (widget.loading) return const CheBrainStateNotice(icon: Icons.sync_outlined, text: 'Syncing with the cloud…');
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final counts = <String, int>{};
    for (final n in _space.layout.nodes) {
      counts[n.cluster] = (counts[n.cluster] ?? 0) + 1;
    }
    // The chrome stays compact at any text size; memory text itself (card,
    // VoiceOver, speech) keeps the owner's full size.
    final media = MediaQuery.of(context);
    final chromeScale = media.textScaler.clamp(minScaleFactor: 1.0, maxScaleFactor: 1.2);
    final chrome = ValueListenableBuilder<int>(
      // Voice filters / search / brain switches change the chips too.
      valueListenable: _space.state,
      builder: (context, _, _) {
        final total = _space.layout.nodes.length;
        final shown = _space.visibleCount;
        final c = _space;
        final title = c.scope == null ? 'Brain constellation' : "${c.scope}'s brain";
        final experience = c.worker(c.scope)?.records ?? total;
        final counter = c.scope == null
            ? '$total memories${c.workers.isNotEmpty ? ' · ${c.workers.length} worker brain${c.workers.length == 1 ? '' : 's'}' : ''}'
            : '$experience record${experience == 1 ? '' : 's'} of experience';
        final notice = _notice(total, shown);
        return MediaQuery(
          data: media.copyWith(textScaler: chromeScale),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                height: 44,
                child: Row(
                  children: [
                    if (c.canGoBack) _iconButton(Icons.arrow_back_rounded, 'Back to the previous view', () => _say(c.goBack())) else const SizedBox(width: CheSpace.gutter),
                    Expanded(
                      child: Semantics(
                        header: true,
                        label: '$title. $counter, no capacity limit.',
                        excludeSemantics: true,
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(text: title, style: CheType.label.copyWith(color: Colors.white, fontSize: 15)),
                              TextSpan(text: '  ·  $counter', style: CheType.caption.copyWith(fontSize: 12)),
                            ],
                          ),
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                    _iconButton(Icons.search_rounded, _panel == _BrainPanel.search ? 'Hide memory search' : 'Find a memory', () => _toggle(_BrainPanel.search), on: _panel == _BrainPanel.search),
                    _iconButton(Icons.tune_rounded, _panel == _BrainPanel.filters ? 'Hide filters' : 'Filter the brain', () => _toggle(_BrainPanel.filters), on: _panel == _BrainPanel.filters || c.filter.isNotEmpty || !c.lens.isEmpty),
                    _iconButton(Icons.hub_outlined, _panel == _BrainPanel.brains ? 'Hide the brain switcher' : 'Switch brain: CHE or an Office worker', () => _toggle(_BrainPanel.brains), on: _panel == _BrainPanel.brains || c.scope != null),
                    _iconButton(Icons.zoom_in_map_rounded, _panel == _BrainPanel.view ? 'Hide view controls' : 'View controls: zoom, fit, center, inside, back', () => _toggle(_BrainPanel.view), on: _panel == _BrainPanel.view),
                    if (widget.onRefresh != null) _iconButton(Icons.refresh_rounded, 'Refresh memories', () => widget.onRefresh!()),
                    const SizedBox(width: 4),
                  ],
                ),
              ),
              CheBrainContextBar(controller: c, onSpeak: _say),
              if (_panel == _BrainPanel.search)
                Padding(
                  padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 2, CheSpace.gutter, 6),
                  child: SizedBox(
                    height: 40,
                    child: TextField(
                      controller: _search,
                      autofocus: true,
                      textInputAction: TextInputAction.search,
                      onSubmitted: _find,
                      style: const TextStyle(fontSize: 14),
                      decoration: InputDecoration(
                        isDense: true,
                        hintText: c.scope == null ? 'Find a memory, then fly to it' : "Find in ${c.scope}'s brain",
                        prefixIcon: const Icon(Icons.search_rounded, size: 18, color: CheColors.accent),
                        suffixIcon: IconButton(tooltip: 'Fly to the best match', icon: const Icon(Icons.arrow_forward_rounded, size: 18), onPressed: () => _find(_search.text)),
                        filled: true,
                        fillColor: CheColors.surfaceHi,
                        contentPadding: const EdgeInsets.symmetric(vertical: 8),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(CheRadius.pill), borderSide: BorderSide.none),
                      ),
                    ),
                  ),
                ),
              if (_panel == _BrainPanel.filters) CheBrainFilterPanel(controller: c, onSpeak: _say, categoryCounts: counts, onCategory: _category),
              if (_panel == _BrainPanel.brains) CheBrainSwitcher(controller: c, onSpeak: _say),
              if (_panel == _BrainPanel.view) CheBrainViewControls(controller: c, onSpeak: _say),
              ?notice,
            ],
          ),
        );
      },
    );

    final space = widget.dots.isEmpty && !widget.loading && _space.scope == null
        ? const Center(
            child: Text(
              'No memories yet.\nSay “remember that …” or let learning notes land.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white54),
            ),
          )
        : CheBrainSpace(
            controller: _space,
            active: widget.active && TickerMode.valuesOf(context).enabled,
            onSpeak: _say,
            // The Soul & facts / Log chips float bottom-right in the room.
            cardBottomInset: 56 + media.viewPadding.bottom,
            onOpenAgent: widget.onOpenAgent,
          );

    final child = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        chrome,
        Expanded(child: space),
      ],
    );
    if (!widget.embedded) return ColoredBox(color: Colors.black, child: child);
    return Material(color: Colors.black, child: child);
  }
}
