// Memory Brain — neural constellation (mockup 01).
// Every learned thought is a glowing teal dot. NO capacity limit on dots.
// Related memories connect with thin lines. Tap a dot → Memory detail sheet.
// Cheap CustomPaint + InteractiveViewer (no WebView / 3D).

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import '../che_ui/che_widgets.dart';

class CheMemoryDot {
  const CheMemoryDot({
    required this.id,
    required this.title,
    required this.body,
    required this.category,
    this.tokens = const [],
    this.at,
    this.clusterId,
  });

  final String id;
  final String title;
  final String body;
  final String category;
  final List<String> tokens;
  final DateTime? at;
  final String? clusterId;
}

/// Build unlimited dots from Worker memories / notes / learning — never capped.
List<CheMemoryDot> cheBuildMemoryDots({
  required List<String> savedMemories,
  required List<Map<String, dynamic>> memoryNotes,
  required List<Map<String, dynamic>> learnedPersonality,
  required List<String> learnedKnowledge,
  List<Map<String, dynamic>> brainLinks = const [],
  List<String> suggestions = const [],
}) {
  // brainLinks are applied in CheMemoryBrainRoom via cheRelatedMemoryEdges.

  final out = <CheMemoryDot>[];
  var i = 0;
  for (final m in savedMemories) {
    final t = m.trim();
    if (t.isEmpty) continue;
    out.add(CheMemoryDot(
      id: 'mem-$i',
      title: _shortTitle(t),
      body: t,
      category: 'Memory',
      tokens: _tokens(t),
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
    ));
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

class _CheMemoryBrainRoomState extends State<CheMemoryBrainRoom>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;
  String _query = '';
  CheMemoryDot? _selected;
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(seconds: 5));
    if (widget.active) _pulse.repeat();
  }

  @override
  void didUpdateWidget(covariant CheMemoryBrainRoom oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_pulse.isAnimating) {
      _pulse.repeat();
    } else if (!widget.active && _pulse.isAnimating) {
      _pulse.stop();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
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

  double _depth(CheMemoryDot dot) {
    final normalized = ((dot.id.hashCode & 0x7fffffff) % 1000) / 999.0;
    return normalized * 2 - 1; // -1 far, +1 near
  }

  /// Stable pseudo-3D neural cloud. Depth changes projection, orb size and glow,
  /// while InteractiveViewer supplies pinch-to-zoom and pan.
  Map<String, Offset> _layout(List<CheMemoryDot> dots, Size size) {
    final cx = size.width * 0.5;
    final cy = size.height * 0.5;
    final map = <String, Offset>{};
    if (dots.isEmpty) return map;
    final scale = math.min(size.width, size.height) * 0.43;
    for (var i = 0; i < dots.length; i++) {
      final d = dots[i];
      final hash = d.id.hashCode;
      final angle = i * 2.399963229728653;
      final r = scale * math.sqrt((i + 1) / dots.length);
      final z = _depth(d);
      final perspective = 0.72 + ((z + 1) / 2) * 0.48;
      final wobbleX = ((hash % 17) - 8) * 1.4;
      final wobbleY = (((hash ~/ 17) % 17) - 8) * 1.2;
      map[d.id] = Offset(
        cx + (math.cos(angle) * r * 1.08 + wobbleX) * perspective,
        cy + (math.sin(angle) * r * 0.82 + wobbleY) * perspective,
      );
    }
    return map;
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
                    Text('MEMORY', style: CheType.overline.copyWith(color: CheColors.accent, letterSpacing: 2)),
                    Text('Brain constellation', style: CheType.title),
                    Text(
                      '${widget.dots.length} thoughts · no capacity limit',
                      style: CheType.caption,
                    ),
                  ],
                ),
              ),
              if (widget.onRefresh != null)
                CheIconButton(
                  icon: Icons.refresh_rounded,
                  onTap: () => widget.onRefresh!(),
                  tooltip: 'Refresh memories',
                ),
            ],
          ),
        ),
        Padding(
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
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.sm),
          child: Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              for (final category in const ['Memory', 'Learning', 'ML Learning', 'Research', 'About you', 'Knowledge'])
                Container(
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
              Text('Pinch to zoom · tap an orb', style: CheType.caption.copyWith(fontSize: 10)),
            ],
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final size = Size(math.max(constraints.maxWidth, 360), math.max(constraints.maxHeight, 420));
              final pos = _layout(dots, size);
              final edges = cheRelatedMemoryEdges(dots, brainLinks: widget.brainLinks);
              return InteractiveViewer(
                minScale: 0.55,
                maxScale: 4,
                boundaryMargin: const EdgeInsets.all(200),
                child: SizedBox(
                  width: size.width,
                  height: size.height,
                  child: RepaintBoundary(
                    child: AnimatedBuilder(
                    animation: _pulse,
                    builder: (context, _) {
                      return Stack(
                        children: [
                          Positioned.fill(
                            child: CustomPaint(
                              painter: _ConstellationPainter(
                                positions: pos,
                                edges: edges,
                                phase: _pulse.value,
                                selectedId: _selected?.id,
                              ),
                            ),
                          ),
                          for (final d in dots)
                            if (pos[d.id] != null)
                              Positioned(
                                left: pos[d.id]!.dx - 10,
                                top: pos[d.id]!.dy - 10,
                                child: Semantics(
                                  button: true,
                                  label: '${d.category}. ${d.title}. Depth ${((_depth(d) + 1) * 50).round()} percent.',
                                  child: GestureDetector(
                                    onTap: () => _openDetail(d),
                                    child: _DotOrb(
                                      selected: _selected?.id == d.id,
                                      phase: _pulse.value,
                                      seed: d.id.hashCode,
                                      color: cheMemoryCategoryColor(d.category),
                                      depth: _depth(d),
                                    ),
                                  ),
                                ),
                              ),
                          if (dots.isEmpty)
                            const Center(
                              child: Text(
                                'No memories yet.\nSay “remember that …” or let learning notes land.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Colors.white54),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                  ),
                ),
              );
            },
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
            ],
          ),
        ),
      ],
    );

    if (!widget.embedded) return ColoredBox(color: Colors.black, child: child);
    return Material(color: Colors.black, child: child);
  }
}

class _DotOrb extends StatelessWidget {
  const _DotOrb({
    required this.selected,
    required this.phase,
    required this.seed,
    required this.color,
    required this.depth,
  });
  final bool selected;
  final double phase;
  final int seed;
  final Color color;
  final double depth;

  @override
  Widget build(BuildContext context) {
    final pulse = 0.85 + 0.15 * math.sin(phase * math.pi * 2 + seed);
    final depthScale = 0.72 + ((depth + 1) / 2) * 0.70;
    final size = selected ? 28.0 : (13.0 + (seed.abs() % 5) * 0.8) * depthScale;
    final alpha = (0.55 + ((depth + 1) / 2) * 0.38).clamp(0.45, 0.95);
    return Transform.scale(
      scale: selected ? 1.08 : 1,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            center: const Alignment(-0.35, -0.35),
            colors: [
              Colors.white.withValues(alpha: selected ? 0.95 : 0.72),
              color.withValues(alpha: selected ? 1 : alpha * pulse),
              color.withValues(alpha: 0.32),
            ],
            stops: const [0, 0.28, 1],
          ),
          boxShadow: [
            BoxShadow(
              color: color.withValues(alpha: selected ? 0.82 : (0.18 + 0.28 * pulse) * depthScale),
              blurRadius: selected ? 26 : 8 + 10 * depthScale,
              spreadRadius: selected ? 3 : depthScale - 0.7,
            ),
          ],
          border: selected ? Border.all(color: Colors.white, width: 1.6) : null,
        ),
      ),
    );
  }
}

class _ConstellationPainter extends CustomPainter {
  _ConstellationPainter({
    required this.positions,
    required this.edges,
    required this.phase,
    this.selectedId,
  });

  final Map<String, Offset> positions;
  final List<(String, String)> edges;
  final double phase;
  final String? selectedId;

  @override
  void paint(Canvas canvas, Size size) {
    // Soft brain aura — gently breathes with phase.
    final auraAlpha = 0.08 + 0.04 * math.sin(phase * math.pi * 2).abs();
    final aura = Paint()
      ..shader = RadialGradient(
        colors: [
          CheColors.accent.withValues(alpha: auraAlpha),
          Colors.transparent,
        ],
      ).createShader(Rect.fromCircle(center: Offset(size.width / 2, size.height / 2), radius: size.shortestSide * 0.55));
    canvas.drawRect(Offset.zero & size, aura);

    final edgePaint = Paint()..style = PaintingStyle.stroke;
    final flowPaint = Paint()
      ..style = PaintingStyle.fill
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);

    for (var i = 0; i < edges.length; i++) {
      final (a, b) = edges[i];
      final pa = positions[a];
      final pb = positions[b];
      if (pa == null || pb == null) continue;

      final highlight = selectedId == a || selectedId == b;
      // Per-edge phase offset so links don't blink in lockstep — organic breathe.
      final edgePhase = (phase + (i * 0.07) + ((a.hashCode ^ b.hashCode) % 100) / 100.0) % 1.0;
      final breathe = (math.sin(edgePhase * math.pi * 2) + 1) * 0.5; // 0..1
      final baseAlpha = highlight ? 0.42 : 0.10;
      final alpha = (baseAlpha + 0.22 * breathe).clamp(0.06, 0.85);
      final thickness = highlight
          ? 1.3 + 0.9 * breathe
          : 0.7 + 0.85 * breathe;

      edgePaint
        ..color = (highlight ? CheColors.accent : Colors.white).withValues(alpha: alpha)
        ..strokeWidth = thickness;
      canvas.drawLine(pa, pb, edgePaint);

      // Subtle energy flow along the link.
      final flowT = (edgePhase + 0.35 * breathe) % 1.0;
      final flow = Offset.lerp(pa, pb, flowT)!;
      final flowAlpha = highlight ? 0.75 : (0.25 + 0.45 * breathe);
      flowPaint.color = CheColors.accent.withValues(alpha: flowAlpha);
      canvas.drawCircle(flow, highlight ? 2.8 : 1.8 + breathe, flowPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _ConstellationPainter old) =>
      old.phase != phase || old.selectedId != selectedId || old.positions != positions || old.edges.length != edges.length;
}
