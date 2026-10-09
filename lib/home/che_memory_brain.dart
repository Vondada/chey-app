// Memory Brain: CHE's real memories as an immersive 3D space (see
// lib/brain/). Every learned thought is a category-colored orb, NO capacity
// limit. Related memories connect like neural branches. Orbit, travel inside,
// select, open, expand clusters, by touch or voice.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
      ),
    );
    i++;
  }
  // Older installs stored owner memories as strings only. Keep showing those,
  // but do not duplicate a memory that now has structured provenance.
  for (final m in savedMemories) {
    final t = m.trim();
    if (t.isEmpty || structuredTexts.contains(t.toLowerCase())) continue;
    out.add(CheMemoryDot(id: 'legacy-mem-$i', title: _shortTitle(t), body: t, category: 'Memory', tokens: _tokens(t), source: 'Legacy owner memory', scope: 'owner'));
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
      ),
    );
    i++;
  }
  for (final k in learnedKnowledge) {
    final t = k.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(id: 'know-$i', title: _shortTitle(t), body: t, category: 'Knowledge', tokens: _tokens(t), source: 'CHE learned knowledge', scope: 'general'));
    i++;
  }
  for (final s in suggestions) {
    final t = s.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(id: 'sug-$i', title: _shortTitle(t), body: t, category: 'Suggestion', tokens: _tokens(t), source: 'CHE planning', scope: 'owner'));
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
      ),
    );
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
  _ => CheColors.accent,
};

class CheMemoryBrainRoom extends StatefulWidget {
  const CheMemoryBrainRoom({super.key, required this.dots, this.brainLinks = const [], this.onReadAloud, this.onRefresh, this.embedded = true, this.active = true});

  final List<CheMemoryDot> dots;

  /// Related links from Worker `/api/state` brain_graph (clustering + similarity).
  final List<Map<String, dynamic>> brainLinks;
  final Future<void> Function(String text)? onReadAloud;
  final Future<void> Function()? onRefresh;
  final bool embedded;

  /// When false, pause the breathing / pulse AnimationController.
  final bool active;

  @override
  State<CheMemoryBrainRoom> createState() => _CheMemoryBrainRoomState();
}

class _CheMemoryBrainRoomState extends State<CheMemoryBrainRoom> {
  late final CheBrainSpaceController _space = CheBrainSpaceController(widget.dots, brainLinks: widget.brainLinks);
  final _search = TextEditingController();
  bool _searchOpen = false;
  bool _filtersOpen = false;

  late int _signature = _sig();

  // The hub rebuilds the dot list on every parent rebuild (e.g. while a chat
  // reply streams); re-layout only when the memories actually changed.
  int _sig() => Object.hash(
    Object.hashAll([for (final d in widget.dots) Object.hash(d.id, d.title, d.body, d.category, d.importance)]),
    Object.hashAll([for (final l in widget.brainLinks) Object.hash(l['source'], l['target'])]),
  );

  @override
  void didUpdateWidget(covariant CheMemoryBrainRoom old) {
    super.didUpdateWidget(old);
    final next = _sig();
    if (next != _signature) {
      _signature = next;
      _space.update(widget.dots, widget.brainLinks);
    }
  }

  @override
  void dispose() {
    _search.dispose();
    _space.dispose();
    super.dispose();
  }

  void _say(String text) => unawaited(widget.onReadAloud?.call(text) ?? Future<void>.value());

  void _toggleSearch() {
    HapticFeedback.selectionClick();
    setState(() {
      _searchOpen = !_searchOpen;
      if (_searchOpen) _filtersOpen = false;
    });
  }

  void _toggleFilters() {
    HapticFeedback.selectionClick();
    setState(() {
      _filtersOpen = !_filtersOpen;
      if (_filtersOpen) _searchOpen = false;
    });
  }

  void _find(String query) {
    if (query.trim().isEmpty) return;
    HapticFeedback.selectionClick();
    _say(_space.find(query));
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

  @override
  Widget build(BuildContext context) {
    final total = widget.dots.length;
    final counts = <String, int>{};
    for (final d in widget.dots) {
      counts[cheBrainCategoryKey(d.category)] = (counts[cheBrainCategoryKey(d.category)] ?? 0) + 1;
    }
    // The chrome stays compact at any text size; memory text itself (card,
    // VoiceOver, speech) keeps the owner's full size.
    final media = MediaQuery.of(context);
    final chromeScale = media.textScaler.clamp(minScaleFactor: 1.0, maxScaleFactor: 1.2);
    final chrome = ValueListenableBuilder<int>(
      // Voice filters / search change the chips too.
      valueListenable: _space.state,
      builder: (context, _, _) => MediaQuery(
        data: media.copyWith(textScaler: chromeScale),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 44,
              child: Row(
                children: [
                  const SizedBox(width: CheSpace.gutter),
                  Expanded(
                    child: Semantics(
                      header: true,
                      label: 'Brain constellation. $total memories, no capacity limit.',
                      excludeSemantics: true,
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: 'Brain constellation',
                              style: CheType.label.copyWith(color: Colors.white, fontSize: 15),
                            ),
                            TextSpan(text: '  ·  $total memories', style: CheType.caption.copyWith(fontSize: 12)),
                          ],
                        ),
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                  _iconButton(Icons.search_rounded, _searchOpen ? 'Hide memory search' : 'Find a memory', _toggleSearch, on: _searchOpen),
                  _iconButton(Icons.tune_rounded, _filtersOpen ? 'Hide category filters' : 'Filter by category', _toggleFilters, on: _filtersOpen || _space.filter.isNotEmpty),
                  _iconButton(Icons.center_focus_strong_rounded, 'Show the whole brain', () => _say(_space.overview())),
                  _iconButton(Icons.blur_on_rounded, 'Go inside the brain', () => _say(_space.inside())),
                  if (widget.onRefresh != null) _iconButton(Icons.refresh_rounded, 'Refresh memories', () => widget.onRefresh!()),
                  const SizedBox(width: 4),
                ],
              ),
            ),
            if (_searchOpen)
              Padding(
                padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 6),
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
                      hintText: 'Find a memory, then fly to it',
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
            if (_filtersOpen)
              SizedBox(
                height: 38,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
                  children: [
                    for (final category in cheBrainCategories)
                      Padding(
                        padding: const EdgeInsets.only(right: 6, bottom: 4),
                        child: Semantics(
                          button: true,
                          selected: _space.filter.contains(category),
                          label: '$category memories, ${counts[category] ?? 0}${_space.filter.contains(category) ? ', showing only these' : ''}',
                          excludeSemantics: true,
                          child: FilterChip(
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            avatar: CircleAvatar(radius: 4, backgroundColor: cheMemoryCategoryColor(category)),
                            label: Text('$category ${counts[category] ?? 0}', style: const TextStyle(fontSize: 12)),
                            selected: _space.filter.contains(category),
                            onSelected: (on) {
                              HapticFeedback.selectionClick();
                              setState(() {});
                              _say(_space.setFilter(on ? category : null));
                            },
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );

    final space = widget.dots.isEmpty
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
