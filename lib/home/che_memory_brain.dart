// Memory Brain — neural constellation (mockup 01).
// Every learned thought is a category-colored luminous orb. NO capacity limit.
// Related memories connect like neural branches. Tap an orb for provenance.
// Cheap pseudo-3D CustomPaint + InteractiveViewer; no heavy WebView scene.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import '../che_ui/che_widgets.dart';
import '../widgets/che_native_scene_world.dart';

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
    out.add(CheMemoryDot(
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
    ));
    i++;
  }
  // Older installs stored owner memories as strings only. Keep showing those,
  // but do not duplicate a memory that now has structured provenance.
  for (final m in savedMemories) {
    final t = m.trim();
    if (t.isEmpty || structuredTexts.contains(t.toLowerCase())) continue;
    out.add(CheMemoryDot(
      id: 'legacy-mem-$i',
      title: _shortTitle(t),
      body: t,
      category: 'Memory',
      tokens: _tokens(t),
      source: 'Legacy owner memory',
      scope: 'owner',
    ));
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
    final category = kind.contains('ml') || kind.contains('classif') || kind.contains('cluster')
        ? 'ML Learning'
        : kind.contains('translat')
            ? 'Translation'
            : kind.contains('scout') || kind.contains('research')
                ? 'Research'
                : 'Learning';
    final rawId = '${n['id'] ?? ''}';
    out.add(CheMemoryDot(
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
    ));
    i++;
  }
  for (final p in learnedPersonality) {
    final text = '${p['statement'] ?? p['text'] ?? ''}'.trim();
    if (text.isEmpty) continue;
    out.add(CheMemoryDot(
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
    ));
    i++;
  }
  for (final k in learnedKnowledge) {
    final t = k.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(
      id: 'know-$i',
      title: _shortTitle(t),
      body: t,
      category: 'Knowledge',
      tokens: _tokens(t),
      source: 'CHE learned knowledge',
      scope: 'general',
    ));
    i++;
  }
  for (final s in suggestions) {
    final t = s.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(
      id: 'sug-$i',
      title: _shortTitle(t),
      body: t,
      category: 'Suggestion',
      tokens: _tokens(t),
      source: 'CHE planning',
      scope: 'owner',
    ));
    i++;
  }
  return out;
}

String _formatMemoryTime(DateTime? value) {
  if (value == null) return 'Date unavailable for this older memory';
  final t = value.toLocal();
  final hour = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final minute = t.minute.toString().padLeft(2, '0');
  final amPm = t.hour < 12 ? 'AM' : 'PM';
  return '${t.month}/${t.day}/${t.year} · $hour:$minute $amPm';
}

String _shortTitle(String text) {
  final line = text.split(RegExp(r'[\n.]')).first.trim();
  if (line.length <= 42) return line.isEmpty ? 'Memory' : line;
  return '${line.substring(0, 40).trimRight()}…';
}

/// Worker brain_graph.links + same-cluster + token overlap → edge pairs for paint.
List<(String, String)> cheRelatedMemoryEdges(
  List<CheMemoryDot> dots, {
  List<Map<String, dynamic>> brainLinks = const [],
}) {
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
  // Same cluster_id (ML clustering nodes)
  for (var i = 0; i < dots.length; i++) {
    final a = dots[i];
    if (a.clusterId == null || a.clusterId!.isEmpty) continue;
    for (var j = i + 1; j < dots.length; j++) {
      if (dots[j].clusterId == a.clusterId) add(a.id, dots[j].id);
    }
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
  return text
      .toLowerCase()
      .split(RegExp(r'[^a-z0-9]+'))
      .where((w) => w.length > 2)
      .toSet()
      .take(24)
      .toList();
}

Color cheMemoryCategoryColor(String category) => switch (category.toLowerCase()) {
      'memory' => const Color(0xFF39E6C5),
      'learning' => const Color(0xFF4CC9F0),
      'ml learning' => const Color(0xFFB17CFF),
      'research' => const Color(0xFFFFC857),
      'about you' => const Color(0xFFFF7EB6),
      'knowledge' => const Color(0xFF6EA8FF),
      'suggestion' => const Color(0xFF8DE969),
      'translation' => const Color(0xFFFF9F68),
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
  });

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
  String _query = '';
  CheMemoryDot? _selected;
  final _search = TextEditingController();

  /// Full view hides the search and legend so the constellation fills the
  /// room instead of being squeezed into a band at the bottom.
  bool _fullView = false;

  void _toggleFullView() {
    HapticFeedback.selectionClick();
    setState(() => _fullView = !_fullView);
    final view = View.maybeOf(context);
    if (view == null) return;
    unawaited(SemanticsService.sendAnnouncement(
      view,
      _fullView ? 'Full brain view. The constellation fills the screen.' : 'Brain controls shown: search and color legend.',
      Directionality.maybeOf(context) ?? TextDirection.ltr,
    ));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<CheMemoryDot> get _visible {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return widget.dots;
    return [
      for (final d in widget.dots)
        if (d.title.toLowerCase().contains(q) ||
            d.body.toLowerCase().contains(q) ||
            d.category.toLowerCase().contains(q))
          d,
    ];
  }

  void _openDetail(CheMemoryDot dot) {
    HapticFeedback.selectionClick();
    setState(() => _selected = dot);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl)),
      ),
      builder: (ctx) {
        final bottom = MediaQuery.viewPaddingOf(ctx).bottom;
        return Padding(
          padding: EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl + bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Memory detail', style: CheType.title),
              const SizedBox(height: CheSpace.sm),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: cheMemoryCategoryColor(dot.category).withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                ),
                child: Text(dot.category, style: CheType.caption.copyWith(color: cheMemoryCategoryColor(dot.category))),
              ),
              const SizedBox(height: CheSpace.md),
              Text(dot.title, style: CheType.headline),
              const SizedBox(height: CheSpace.sm),
              Text(dot.body, style: CheType.bodyDim),
              const SizedBox(height: CheSpace.md),
              Semantics(
                label: 'Memory metadata. Source ${dot.source}. Saved ${_formatMemoryTime(dot.at)}. '
                    '${dot.confidence == null ? '' : 'Confidence ${(dot.confidence! * 100).round()} percent. '}'
                    'Scope ${dot.scope}.',
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.035),
                    borderRadius: BorderRadius.circular(CheRadius.md),
                    border: Border.all(color: cheMemoryCategoryColor(dot.category).withValues(alpha: 0.24)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Source · ${dot.source}', style: CheType.caption),
                      const SizedBox(height: 4),
                      Text('Saved · ${_formatMemoryTime(dot.at)}', style: CheType.caption),
                      if (dot.lastVerifiedAt != null) ...[
                        const SizedBox(height: 4),
                        Text('Last verified · ${_formatMemoryTime(dot.lastVerifiedAt)}', style: CheType.caption),
                      ],
                      if (dot.confidence != null) ...[
                        const SizedBox(height: 4),
                        Text('Confidence · ${(dot.confidence! * 100).round()}%', style: CheType.caption),
                      ],
                      const SizedBox(height: 4),
                      Text('Scope · ${dot.scope == 'owner' ? 'Owner memory' : 'General knowledge'}', style: CheType.caption),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: CheSpace.lg),
              CheVoiceActionList(
                actions: [
                  CheVoiceAction(
                    number: 1,
                    label: 'Read aloud',
                    icon: Icons.volume_up_rounded,
                    onTap: () async {
                      Navigator.pop(ctx);
                      await widget.onReadAloud?.call('${dot.title}. ${dot.body}');
                    },
                  ),
                  CheVoiceAction(
                    number: 2,
                    label: 'Related memories',
                    icon: Icons.hub_rounded,
                    onTap: () {
                      Navigator.pop(ctx);
                      final related = [
                        for (final other in widget.dots)
                          if (other.id != dot.id &&
                              other.tokens.toSet().intersection(dot.tokens.toSet()).length >= 2)
                            other,
                      ].take(5).toList();
                      final text = related.isEmpty
                          ? 'No strongly related memories yet.'
                          : related.map((r) => r.title).join('. ');
                      widget.onReadAloud?.call(text);
                      setState(() => _query = dot.tokens.isEmpty ? dot.title : dot.tokens.first);
                      _search.text = _query;
                    },
                  ),
                  CheVoiceAction(
                    number: 3,
                    label: 'Close',
                    icon: Icons.close_rounded,
                    onTap: () => Navigator.pop(ctx),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    ).whenComplete(() {
      if (mounted) setState(() => _selected = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    final dots = _visible;
    final child = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, 0),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!_fullView) Text('MEMORY', style: CheType.overline.copyWith(color: CheColors.accent, letterSpacing: 2)),
                    Text('Brain constellation', style: _fullView ? CheType.caption : CheType.title),
                    if (!_fullView)
                      Text(
                        '${widget.dots.length} thoughts · no capacity limit',
                        style: CheType.caption,
                      ),
                  ],
                ),
              ),
              CheIconButton(
                icon: _fullView ? Icons.close_fullscreen_rounded : Icons.open_in_full_rounded,
                onTap: _toggleFullView,
                tooltip: _fullView ? 'Show brain controls' : 'Full brain view',
              ),
              if (widget.onRefresh != null)
                CheIconButton(
                  icon: Icons.refresh_rounded,
                  onTap: () => widget.onRefresh!(),
                  tooltip: 'Refresh memories',
                ),
              const CheSceneQualityButton(),
            ],
          ),
        ),
        if (!_fullView) Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
          child: TextField(
            controller: _search,
            onChanged: (v) => setState(() => _query = v),
            decoration: InputDecoration(
              hintText: 'Find a memory',
              prefixIcon: const Icon(Icons.search_rounded, color: CheColors.accent),
              filled: true,
              fillColor: CheColors.surfaceHi,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                borderSide: BorderSide(color: CheColors.accent.withValues(alpha: 0.35)),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                borderSide: BorderSide(color: CheColors.strokeHi),
              ),
            ),
          ),
        ),
        // One scrolling row instead of a 2-3 row wrap, so the legend never
        // pushes the constellation down.
        if (!_fullView) Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.sm),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              for (final category in const ['Memory', 'Learning', 'Knowledge', 'ML Learning', 'Research', 'About you', 'Suggestion', 'Translation'])
                Semantics(
                  label: switch (category) {
                    'Memory' => 'Teal means personal memories and preferences.',
                    'Learning' => 'Cyan means learned information.',
                    'Knowledge' => 'Blue means general knowledge.',
                    'ML Learning' => 'Violet means machine learning and derived patterns.',
                    'Research' => 'Gold means research.',
                    'About you' => 'Pink means information about you.',
                    'Suggestion' => 'Green means suggestions and plans.',
                    'Translation' => 'Orange means translations and language.',
                    _ => category,
                  },
                  child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: cheMemoryCategoryColor(category).withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(CheRadius.pill),
                    border: Border.all(color: cheMemoryCategoryColor(category).withValues(alpha: 0.35)),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: cheMemoryCategoryColor(category))),
                    const SizedBox(width: 5),
                    Text(category, style: CheType.caption.copyWith(fontSize: 10)),
                  ]),
                ),
                ),
              Text('Pinch to zoom · tap an orb', style: CheType.caption.copyWith(fontSize: 10)),
            ],
          ),
          ),
        ),
        Expanded(
          child: TickerMode(
            enabled: widget.active,
            child: ValueListenableBuilder<CheSceneQuality>(
              valueListenable: CheSceneQualityStore.value,
              builder: (context, quality, _) {
                final edges =
                    cheRelatedMemoryEdges(dots, brainLinks: widget.brainLinks);
                if (dots.isEmpty) {
                  return const Center(
                    child: Text(
                      'No memories yet.\nSay “remember that …” or let learning notes land.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.white54),
                    ),
                  );
                }
                return CheNativeSceneWorld(
                  mode: CheSceneMode.brain,
                  quality: quality,
                  height: double.infinity,
                  semanticsLabel:
                      'Native 3D Brain constellation. Real stored memories only.',
                  entities: [
                    for (final d in dots)
                      CheSceneEntity(
                        id: d.id,
                        label: d.title,
                        description: '${d.category}. ${d.body}',
                        color: cheMemoryCategoryColor(d.category),
                        importance: d.importance,
                      ),
                  ],
                  links: [
                    for (final edge in edges)
                      CheSceneLink(edge.$1, edge.$2),
                  ],
                  onEntityTap: (id) {
                    final matches = dots.where((d) => d.id == id);
                    if (matches.isNotEmpty) _openDetail(matches.first);
                  },
                );
              },
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.md),
          child: CheVoiceActionList(
            actions: [
              CheVoiceAction(
                number: 1,
                label: 'Read selected memory',
                icon: Icons.mic_rounded,
                onTap: () async {
                  final d = _selected ?? (dots.isNotEmpty ? dots.first : null);
                  if (d == null) {
                    await widget.onReadAloud?.call('No memory selected.');
                    return;
                  }
                  await widget.onReadAloud?.call('${d.title}. ${d.body}');
                },
              ),
              CheVoiceAction(
                number: 2,
                label: _fullView ? 'Show brain controls' : 'Full brain view',
                icon: _fullView ? Icons.close_fullscreen_rounded : Icons.open_in_full_rounded,
                onTap: _toggleFullView,
              ),
            ],
          ),
        ),
      ],
    );

    if (!widget.embedded) return ColoredBox(color: Colors.black, child: child);
    return Material(color: Colors.black, child: child);
  }
}
