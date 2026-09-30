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
  });

  final String id;
  final String title;
  final String body;
  final String category;
  final List<String> tokens;
  final DateTime? at;
}

/// Build unlimited dots from Worker memories / notes / learning — never capped.
List<CheMemoryDot> cheBuildMemoryDots({
  required List<String> savedMemories,
  required List<Map<String, dynamic>> memoryNotes,
  required List<Map<String, dynamic>> learnedPersonality,
  required List<String> learnedKnowledge,
}) {
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
    final body = [
      title,
      for (final b in bullets) '• $b',
      if ('${n['url'] ?? ''}'.isNotEmpty) '${n['url']}',
    ].where((s) => s.trim().isNotEmpty).join('\n');
    if (body.trim().isEmpty) continue;
    out.add(CheMemoryDot(
      id: 'note-${n['id'] ?? i}',
      title: _shortTitle(title),
      body: body,
      category: 'Learning',
      tokens: _tokens('$title $body'),
      at: DateTime.tryParse('${n['created_at'] ?? ''}'),
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
  return out;
}

String _shortTitle(String text) {
  final line = text.split(RegExp(r'[\n.]')).first.trim();
  if (line.length <= 42) return line.isEmpty ? 'Memory' : line;
  return '${line.substring(0, 40).trimRight()}…';
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

class CheMemoryBrainRoom extends StatefulWidget {
  const CheMemoryBrainRoom({
    super.key,
    required this.dots,
    this.onReadAloud,
    this.onRefresh,
    this.embedded = true,
  });

  final List<CheMemoryDot> dots;
  final Future<void> Function(String text)? onReadAloud;
  final Future<void> Function()? onRefresh;
  final bool embedded;

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
    _pulse = AnimationController(vsync: this, duration: const Duration(seconds: 6))..repeat();
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

  /// Stable organic layout — grows with N, no artificial max.
  Map<String, Offset> _layout(List<CheMemoryDot> dots, Size size) {
    final cx = size.width * 0.5;
    final cy = size.height * 0.48;
    final map = <String, Offset>{};
    if (dots.isEmpty) return map;
    // Brain-ish oval packing: golden-angle spiral scaled by sqrt(n).
    final scale = math.min(size.width, size.height) * 0.42;
    for (var i = 0; i < dots.length; i++) {
      final d = dots[i];
      final hash = d.id.hashCode;
      final angle = i * 2.399963229728653; // golden angle
      final r = scale * math.sqrt((i + 1) / dots.length);
      final wobbleX = ((hash % 17) - 8) * 1.8;
      final wobbleY = (((hash ~/ 17) % 17) - 8) * 1.6;
      // Slight vertical squash for brain silhouette.
      map[d.id] = Offset(cx + math.cos(angle) * r * 1.05 + wobbleX, cy + math.sin(angle) * r * 0.78 + wobbleY);
    }
    return map;
  }

  List<(String, String)> _edges(List<CheMemoryDot> dots) {
    // Connect related memories by shared tokens (cap edges per node for paint cost).
    final edges = <(String, String)>[];
    final byToken = <String, List<CheMemoryDot>>{};
    for (final d in dots) {
      for (final tok in d.tokens.take(8)) {
        byToken.putIfAbsent(tok, () => []).add(d);
      }
    }
    final seen = <String>{};
    for (final group in byToken.values) {
      if (group.length < 2) continue;
      final take = group.length > 12 ? group.take(12).toList() : group;
      for (var i = 0; i < take.length; i++) {
        var links = 0;
        for (var j = i + 1; j < take.length && links < 3; j++) {
          final a = take[i].id;
          final b = take[j].id;
          final key = a.compareTo(b) < 0 ? '$a|$b' : '$b|$a';
          if (seen.add(key)) {
            edges.add((a, b));
            links++;
          }
        }
      }
    }
    return edges;
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
                  color: CheColors.accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                ),
                child: Text(dot.category, style: CheType.caption.copyWith(color: CheColors.accent)),
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
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final size = Size(math.max(constraints.maxWidth, 360), math.max(constraints.maxHeight, 420));
              final pos = _layout(dots, size);
              final edges = _edges(dots);
              return InteractiveViewer(
                minScale: 0.55,
                maxScale: 4,
                boundaryMargin: const EdgeInsets.all(200),
                child: SizedBox(
                  width: size.width,
                  height: size.height,
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
                                  label: '${d.category}. ${d.title}',
                                  child: GestureDetector(
                                    onTap: () => _openDetail(d),
                                    child: _DotOrb(
                                      selected: _selected?.id == d.id,
                                      phase: _pulse.value,
                                      seed: d.id.hashCode,
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

    if (!widget.embedded) return child;
    return Material(color: CheColors.bg, child: child);
  }
}

class _DotOrb extends StatelessWidget {
  const _DotOrb({required this.selected, required this.phase, required this.seed});
  final bool selected;
  final double phase;
  final int seed;

  @override
  Widget build(BuildContext context) {
    final pulse = 0.85 + 0.15 * math.sin(phase * math.pi * 2 + seed);
    final size = selected ? 22.0 : 14.0 + (seed % 5) * 0.6;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: CheColors.accent.withValues(alpha: selected ? 1 : 0.85 * pulse),
        boxShadow: [
          BoxShadow(
            color: CheColors.accent.withValues(alpha: selected ? 0.75 : 0.35 * pulse),
            blurRadius: selected ? 18 : 10,
            spreadRadius: selected ? 2 : 0,
          ),
        ],
        border: selected ? Border.all(color: Colors.white, width: 1.5) : null,
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
    // Soft brain aura
    final aura = Paint()
      ..shader = RadialGradient(
        colors: [
          CheColors.accent.withValues(alpha: 0.10),
          Colors.transparent,
        ],
      ).createShader(Rect.fromCircle(center: Offset(size.width / 2, size.height / 2), radius: size.shortestSide * 0.55));
    canvas.drawRect(Offset.zero & size, aura);

    final edgePaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.14 + 0.06 * math.sin(phase * math.pi * 2).abs())
      ..strokeWidth = 1
      ..style = PaintingStyle.stroke;

    for (final (a, b) in edges) {
      final pa = positions[a];
      final pb = positions[b];
      if (pa == null || pb == null) continue;
      final highlight = selectedId == a || selectedId == b;
      edgePaint.color = highlight
          ? CheColors.accent.withValues(alpha: 0.55)
          : Colors.white.withValues(alpha: 0.12);
      edgePaint.strokeWidth = highlight ? 1.4 : 0.9;
      canvas.drawLine(pa, pb, edgePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _ConstellationPainter old) =>
      old.phase != phase || old.selectedId != selectedId || old.positions != positions || old.edges.length != edges.length;
}
