import 'dart:math' as math;
import 'package:flutter/material.dart';

class InsightsBrainScene extends StatefulWidget {
  const InsightsBrainScene({
    super.key,
    required this.active,
    required this.learnedAboutYou,
    required this.learnedKnowledge,
    required this.suggestions,
  });

  final bool active;
  final List<Map<String, dynamic>> learnedAboutYou;
  final List<String> learnedKnowledge;
  final List<String> suggestions;

  @override
  State<InsightsBrainScene> createState() => _InsightsBrainSceneState();
}

class _InsightsBrainSceneState extends State<InsightsBrainScene>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  static const _teal = Color(0xFF67E8D1);
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
                  'What CHE has learned, connected like a living map.',
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
  });

  final String region;
  final String title;
  final String body;
  final Color color;
  final Offset position;
  final bool empty;

  _BrainNode copyWith({Offset? position}) => _BrainNode(
        region: region,
        title: title,
        body: body,
        color: color,
        position: position ?? this.position,
        empty: empty,
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
      ..color = const Color(0xFF67E8D1).withValues(alpha: .18)
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

    for (final node in nodes) {
      final hub = node.region == 'Learned About You'
          ? hubs[0]
          : node.region == 'Learned Knowledge'
              ? hubs[1]
              : hubs[2];

      linePaint.color = node.color.withValues(
        alpha: node.empty ? .09 : .24,
      );
      canvas.drawLine(hub, node.position, linePaint);

      if (!node.empty) {
        final t = (phase + node.position.dx / 900) % 1.0;
        final dot = Offset.lerp(hub, node.position, t)!;
        canvas.drawCircle(
          dot,
          2.7,
          Paint()
            ..color = node.color.withValues(alpha: .9)
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4),
        );
      }
    }

    for (var i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].region != nodes[i + 1].region) continue;
      linePaint.color = nodes[i].color.withValues(alpha: .10);
      canvas.drawLine(nodes[i].position, nodes[i + 1].position, linePaint);
    }

    canvas.drawCircle(
      const Offset(345, 360),
      95,
      Paint()
        ..color = const Color(0xFF67E8D1).withValues(alpha: .12)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 30),
    );
  }

  @override
  bool shouldRepaint(covariant _BrainPainter oldDelegate) =>
      oldDelegate.phase != phase ||
      oldDelegate.nodes.length != nodes.length;
}
