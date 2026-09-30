import 'dart:math' as math;
import 'package:flutter/material.dart';

class InsightsBrainScene extends StatefulWidget {
  const InsightsBrainScene({
    super.key,
    required this.active,
    required this.learnedAboutYou,
    required this.learnedKnowledge,
    required this.suggestions,
    this.memoryNotes = const [],
    this.brainLinks = const [],
  });

  final bool active;
  final List<Map<String, dynamic>> learnedAboutYou;
  final List<String> learnedKnowledge;
  final List<String> suggestions;
  /// Unlimited Worker memory_notes — each becomes a neural dot on the Map.
  final List<Map<String, dynamic>> memoryNotes;
  /// Related links from Worker brain_graph (source/target/relation).
  final List<Map<String, dynamic>> brainLinks;

  @override
  State<InsightsBrainScene> createState() => _InsightsBrainSceneState();
}

class _InsightsBrainSceneState extends State<InsightsBrainScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  static const _teal = Color(0xFF34E0B8);
  static const _violet = Color(0xFFB58BFF);
  static const _amber = Color(0xFFFFC86B);

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 9),
    );
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(covariant InsightsBrainScene oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat();
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  List<_BrainNode> _nodes() {
    final result = <_BrainNode>[];

    void addCluster(
      String region,
      Color color,
      Offset center,
      List<_BrainNode> items,
    ) {
      if (items.isEmpty) {
        result.add(_BrainNode(
          region: region,
          title: region,
          body: region == 'Learned About You'
              ? 'No stable personality patterns yet\nCHE learns gradually from what you explicitly show her.'
              : region == 'Learned Knowledge'
                  ? 'No researched knowledge stored yet\nLive research requires a connected research service.'
                  : 'No suggestions yet\nUseful follow-ups will appear here as CHE learns.',
          color: color,
          position: center,
          empty: true,
        ));
        return;
      }

      for (var i = 0; i < items.length; i++) {
        final angle = (i / math.max(1, items.length)) * math.pi * 2;
        final ring = 42.0 + (i % 3) * 26;
        result.add(items[i].copyWith(
          position: center +
              Offset(math.cos(angle) * ring, math.sin(angle) * ring),
        ));
      }
    }

    addCluster(
      'Learned About You',
      _teal,
      const Offset(215, 255),
      widget.learnedAboutYou.map((item) {
        final text = item['statement']?.toString() ?? 'Learned pattern';
        final confidence = (item['confidence'] as num?)?.toDouble();
        return _BrainNode(
          region: 'Learned About You',
          title: text,
          body: confidence == null
              ? text
              : '$text\nConfidence ${(confidence * 100).round()}%',
          color: _teal,
          position: Offset.zero,
        );
      }).toList(),
    );

    addCluster(
      'Learned Knowledge',
      _violet,
      const Offset(475, 255),
      widget.learnedKnowledge
          .map((text) => _BrainNode(
                region: 'Learned Knowledge',
                title: text,
                body: text,
                color: _violet,
                position: Offset.zero,
              ))
          .toList(),
    );

    addCluster(
      'Suggestions',
      _amber,
      const Offset(345, 520),
      widget.suggestions
          .map((text) => _BrainNode(
                region: 'Suggestions',
                title: text,
                body: text,
                color: _amber,
                position: Offset.zero,
              ))
          .toList(),
    );

    // Unlimited memory_notes from Worker → neural dots (ML / translate / research / knowledge).
    const noteCyan = Color(0xFF5BE7FF);
    const notePink = Color(0xFFFF7AD9);
    const noteLime = Color(0xFFB6FF6A);
    final notes = widget.memoryNotes;
    if (notes.isNotEmpty) {
      final ml = <_BrainNode>[];
      final tr = <_BrainNode>[];
      final other = <_BrainNode>[];
      for (final n in notes) {
        final kind = '${n['kind'] ?? n['region'] ?? ''}'.toLowerCase();
        final title = '${n['title'] ?? 'Note'}';
        final body = (n['body'] ?? n['text'] ?? ((n['bullets'] is List) ? (n['bullets'] as List).join(' · ') : title)).toString();
        final id = '${n['id'] ?? title}';
        final node = _BrainNode(
          region: kind.contains('ml') || kind.contains('classif') || kind.contains('cluster')
              ? 'ML Learning'
              : kind.contains('translat')
                  ? 'Translation'
                  : 'Memory Notes',
          title: title,
          body: body,
          color: kind.contains('ml') || kind.contains('classif') || kind.contains('cluster')
              ? notePink
              : kind.contains('translat')
                  ? noteLime
                  : noteCyan,
          position: Offset.zero,
          id: id,
          clusterId: n['cluster_id']?.toString(),
        );
        if (node.region == 'ML Learning') {
          ml.add(node);
        } else if (node.region == 'Translation') {
          tr.add(node);
        } else {
          other.add(node);
        }
      }
      addCluster('ML Learning', notePink, const Offset(120, 480), ml);
      addCluster('Translation', noteLime, const Offset(560, 480), tr);
      addCluster('Memory Notes', noteCyan, const Offset(345, 140), other);
    }

    return result;
  }

  void _openNode(_BrainNode node) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xEE111A25),
      showDragHandle: true,
      builder: (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      color: node.color,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                          color: node.color.withValues(alpha: .55),
                          blurRadius: 16,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    node.region.toUpperCase(),
                    style: TextStyle(
                      color: node.color,
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.1,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                node.title,
                style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                node.body,
                style: const TextStyle(
                  color: Colors.white70,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final nodes = _nodes();
    return ColoredBox(
      color: const Color(0xFF071018),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 16, 18, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'NEURAL BRAIN MAP',
                  style: TextStyle(
                    color: _teal,
                    fontSize: 12,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.5,
                  ),
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 0, 18, 10),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Memory notes, ML clusters, and translations as neural dots — unlimited learned nodes.',
                  style: TextStyle(color: Colors.white54, fontSize: 12),
                ),
              ),
            ),
            Expanded(
              child: InteractiveViewer(
                minScale: .78,
                maxScale: 2.7,
                boundaryMargin: const EdgeInsets.all(120),
                child: SizedBox(
                  width: 690,
                  height: 720,
                  child: AnimatedBuilder(
                    animation: _controller,
                    builder: (context, _) {
                      return Stack(
                        children: [
                          Positioned.fill(
                            child: CustomPaint(
                              painter: _BrainPainter(
                                nodes: nodes,
                                phase: _controller.value,
                              ),
                            ),
                          ),
                          for (var i = 0; i < nodes.length; i++)
                            Positioned(
                              left: nodes[i].position.dx - 18,
                              top: nodes[i].position.dy - 18,
                              child: GestureDetector(
                                onTap: () => _openNode(nodes[i]),
                                child: Transform.scale(
                                  scale: widget.active && !nodes[i].empty
                                      ? .96 +
                                          .08 *
                                              math.sin(
                                                (_controller.value * math.pi * 2) +
                                                    i,
                                              ).abs()
                                      : 1,
                                  child: Container(
                                    width: 36,
                                    height: 36,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: nodes[i].empty
                                          ? nodes[i].color.withValues(alpha: .13)
                                          : nodes[i].color.withValues(alpha: .92),
                                      border: Border.all(
                                        color: nodes[i].color.withValues(alpha: .9),
                                      ),
                                      boxShadow: [
                                        BoxShadow(
                                          color: nodes[i].color.withValues(
                                            alpha: i == nodes.length - 1 &&
                                                    !nodes[i].empty
                                                ? .65
                                                : .3,
                                          ),
                                          blurRadius: i == nodes.length - 1 &&
                                                  !nodes[i].empty
                                              ? 24
                                              : 12,
                                        ),
                                      ],
                                    ),
                                    child: Icon(
                                      nodes[i].empty
                                          ? Icons.radio_button_unchecked
                                          : Icons.circle,
                                      size: nodes[i].empty ? 12 : 7,
                                      color: Colors.white,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BrainNode {
  const _BrainNode({
    required this.region,
    required this.title,
    required this.body,
    required this.color,
    required this.position,
    this.empty = false,
    this.id,
    this.clusterId,
  });

  final String region;
  final String title;
  final String body;
  final Color color;
  final Offset position;
  final bool empty;
  final String? id;
  final String? clusterId;

  _BrainNode copyWith({Offset? position}) => _BrainNode(
        region: region,
        title: title,
        body: body,
        color: color,
        position: position ?? this.position,
        empty: empty,
        id: id,
        clusterId: clusterId,
      );
}

class _BrainPainter extends CustomPainter {
  const _BrainPainter({
    required this.nodes,
    required this.phase,
  });

  final List<_BrainNode> nodes;
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    final glow = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..color = const Color(0xFF34E0B8).withValues(alpha: .18)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10);

    final left = Path()
      ..moveTo(330, 110)
      ..cubicTo(135, 55, 75, 215, 118, 345)
      ..cubicTo(70, 455, 145, 600, 330, 605);
    final right = Path()
      ..moveTo(360, 110)
      ..cubicTo(555, 55, 615, 215, 572, 345)
      ..cubicTo(620, 455, 545, 600, 360, 605);

    canvas.drawPath(left, glow);
    canvas.drawPath(right, glow);

    final linePaint = Paint()
      ..strokeWidth = 1.3
      ..style = PaintingStyle.stroke;

    const hubs = [
      Offset(215, 255),
      Offset(475, 255),
      Offset(345, 520),
    ];

    for (var ni = 0; ni < nodes.length; ni++) {
      final node = nodes[ni];
      final hub = switch (node.region) {
        'Learned About You' => hubs[0],
        'Learned Knowledge' => hubs[1],
        'Suggestions' => hubs[2],
        'ML Learning' => const Offset(120, 480),
        'Translation' => const Offset(560, 480),
        'Memory Notes' => const Offset(345, 140),
        _ => hubs[2],
      };

      final breathe = (math.sin((phase + ni * 0.05) * math.pi * 2) + 1) * 0.5;
      linePaint
        ..color = node.color.withValues(
          alpha: node.empty ? .09 : (.16 + .18 * breathe),
        )
        ..strokeWidth = node.empty ? 1.0 : (1.1 + 0.7 * breathe);
      canvas.drawLine(hub, node.position, linePaint);

      if (!node.empty) {
        final t = (phase + node.position.dx / 900) % 1.0;
        final dot = Offset.lerp(hub, node.position, t)!;
        canvas.drawCircle(
          dot,
          2.2 + breathe,
          Paint()
            ..color = node.color.withValues(alpha: .55 + .4 * breathe)
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4),
        );
      }
    }

    for (var i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].region != nodes[i + 1].region) continue;
      final breathe = (math.sin((phase + i * 0.08) * math.pi * 2) + 1) * 0.5;
      linePaint
        ..color = nodes[i].color.withValues(alpha: .08 + .10 * breathe)
        ..strokeWidth = 0.8 + 0.5 * breathe;
      canvas.drawLine(nodes[i].position, nodes[i + 1].position, linePaint);
    }

    // Related / cluster links — breathe + flow
    for (var i = 0; i < nodes.length; i++) {
      final a = nodes[i];
      if (a.empty || a.clusterId == null || a.clusterId!.isEmpty) continue;
      for (var j = i + 1; j < nodes.length; j++) {
        final b = nodes[j];
        if (b.clusterId != a.clusterId) continue;
        final breathe = (math.sin((phase + i * 0.11 + j * 0.03) * math.pi * 2) + 1) * 0.5;
        linePaint
          ..color = a.color.withValues(alpha: .18 + .22 * breathe)
          ..strokeWidth = 1.0 + 0.8 * breathe;
        canvas.drawLine(a.position, b.position, linePaint);
        final flowT = (phase + i * 0.07) % 1.0;
        final flow = Offset.lerp(a.position, b.position, flowT)!;
        canvas.drawCircle(
          flow,
          2.0 + breathe,
          Paint()
            ..color = a.color.withValues(alpha: .5 + .4 * breathe)
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3),
        );
      }
    }

    canvas.drawCircle(
      const Offset(345, 360),
      95,
      Paint()
        ..color = const Color(0xFF34E0B8).withValues(alpha: .12)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 30),
    );
  }

  @override
  bool shouldRepaint(covariant _BrainPainter oldDelegate) =>
      oldDelegate.phase != phase ||
      oldDelegate.nodes.length != nodes.length;
}
