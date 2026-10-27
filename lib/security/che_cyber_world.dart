// The Cyber World: CHE's real systems as nodes around the server, drawn from /api/security/core. A node pulses only
// for a real open event on it; a drill draws its pulse dashed and labelled SIMULATION. The animation runs only while
// there is something real (or a labelled drill) to show, stops when reduced motion is on, and pauses offscreen
// (TickerMode / the lazy list disposing it). Every node is also a VoiceOver element with its status in words.
import 'dart:math' as math;

import 'package:flutter/material.dart';

class CheWorldNode {
  const CheWorldNode({required this.id, required this.kind, required this.label, required this.status, required this.events24h, this.detail = ''});
  final String id;
  final String kind;
  final String label;
  final String status;
  final int events24h;
  final String detail;

  factory CheWorldNode.fromJson(Map<String, dynamic> j) => CheWorldNode(
        id: '${j['id']}',
        kind: '${j['kind'] ?? ''}',
        label: '${j['label'] ?? j['id']}',
        status: '${j['status'] ?? 'unknown'}',
        events24h: (j['events_24h'] as num?)?.toInt() ?? 0,
        detail: '${j['detail'] ?? ''}',
      );

  String get spoken => '$label: ${cheWorldStatusWord(status)}${events24h > 0 ? ', $events24h event${events24h == 1 ? '' : 's'} in the last day' : ''}${detail.isEmpty ? '' : '. $detail'}';
}

String cheWorldStatusWord(String status) => switch (status) {
      'ok' => 'normal',
      'warning' => 'needs a look',
      'alert' => 'alert',
      _ => 'status unknown',
    };

Color cheWorldStatusColor(String status) => switch (status) {
      'ok' => const Color(0xFF3DDC97),
      'warning' => const Color(0xFFFFB547),
      'alert' => const Color(0xFFFF5C6C),
      _ => const Color(0xFF8A94A6),
    };

class CheCyberWorld extends StatefulWidget {
  const CheCyberWorld({super.key, required this.nodes, this.pulses = const [], this.simulationPulse, this.onSelect});
  final List<CheWorldNode> nodes;
  /// Node ids with a real open event.
  final List<String> pulses;
  /// A node a drill is showing; drawn dashed and labelled SIMULATION.
  final String? simulationPulse;
  final ValueChanged<CheWorldNode>? onSelect;

  @override
  State<CheCyberWorld> createState() => _CheCyberWorldState();
}

class _CheCyberWorldState extends State<CheCyberWorld> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  bool get _hasMotion => widget.pulses.isNotEmpty || widget.simulationPulse != null;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(CheCyberWorld old) {
    super.didUpdateWidget(old);
    _sync();
  }

  /// Animate only with something real (or a labelled drill) to show, and never with reduced motion.
  void _sync() {
    final reduced = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (_hasMotion && !reduced) {
      if (!_pulse.isAnimating) _pulse.repeat();
    } else {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  bool get animating => _pulse.isAnimating;

  @override
  Widget build(BuildContext context) {
    final nodes = widget.nodes;
    return LayoutBuilder(builder: (context, c) {
      final size = Size(c.maxWidth, math.min(320, c.maxWidth * 0.8));
      final positions = _layout(nodes, size);
      return SizedBox(
        width: size.width,
        height: size.height,
        child: Stack(children: [
          Positioned.fill(
            child: ExcludeSemantics(
              child: RepaintBoundary(
                child: AnimatedBuilder(
                  animation: _pulse,
                  builder: (_, _) => CustomPaint(
                    painter: _WorldPainter(nodes: nodes, positions: positions, pulses: widget.pulses, simulation: widget.simulationPulse, t: _pulse.value),
                  ),
                ),
              ),
            ),
          ),
          for (final n in nodes)
            Positioned(
              left: positions[n.id]!.dx - 44,
              top: positions[n.id]!.dy + 14,
              width: 88,
              child: Semantics(
                button: widget.onSelect != null,
                label: n.spoken,
                excludeSemantics: true,
                child: InkWell(
                  onTap: widget.onSelect == null ? null : () => widget.onSelect!(n),
                  child: Text(n.label, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.labelSmall),
                ),
              ),
            ),
          if (widget.simulationPulse != null)
            Positioned(
              right: 8,
              top: 8,
              child: Semantics(label: 'A simulation is showing. Nothing real is affected.', excludeSemantics: true, child: const _SimulationTag()),
            ),
        ]),
      );
    });
  }

  Map<String, Offset> _layout(List<CheWorldNode> nodes, Size size) {
    final center = Offset(size.width / 2, size.height / 2 - 10);
    final out = <String, Offset>{};
    final ring = nodes.where((n) => n.id != 'worker').toList();
    out['worker'] = center;
    final r = math.min(size.width, size.height) * 0.36;
    for (var i = 0; i < ring.length; i++) {
      final a = -math.pi / 2 + 2 * math.pi * i / math.max(1, ring.length);
      out[ring[i].id] = center + Offset(math.cos(a) * r * 1.25, math.sin(a) * r);
    }
    for (final n in nodes) {
      out.putIfAbsent(n.id, () => center);
    }
    return out;
  }
}

class _SimulationTag extends StatelessWidget {
  const _SimulationTag();
  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(border: Border.all(color: const Color(0xFFB794F6)), borderRadius: BorderRadius.circular(6)),
        child: const Padding(padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2), child: Text('SIMULATION', style: TextStyle(color: Color(0xFFB794F6), fontWeight: FontWeight.w700, letterSpacing: 1.2))),
      );
}

class _WorldPainter extends CustomPainter {
  _WorldPainter({required this.nodes, required this.positions, required this.pulses, required this.simulation, required this.t});
  final List<CheWorldNode> nodes;
  final Map<String, Offset> positions;
  final List<String> pulses;
  final String? simulation;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final center = positions['worker'];
    final line = Paint()
      ..color = const Color(0x553DD6D0)
      ..strokeWidth = 1.2;
    if (center != null) {
      for (final n in nodes) {
        if (n.id != 'worker') canvas.drawLine(center, positions[n.id]!, line);
      }
    }
    for (final n in nodes) {
      final p = positions[n.id]!;
      final color = cheWorldStatusColor(n.status);
      if (pulses.contains(n.id)) {
        canvas.drawCircle(p, 12 + 18 * t, Paint()..color = color.withValues(alpha: (1 - t) * 0.6));
      }
      if (simulation == n.id) {
        final ring = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = const Color(0xFFB794F6).withValues(alpha: 1 - t);
        final r = 14 + 18 * t;
        for (var a = 0.0; a < 2 * math.pi; a += math.pi / 6) {
          canvas.drawArc(Rect.fromCircle(center: p, radius: r), a, math.pi / 12, false, ring);
        }
      }
      canvas.drawCircle(p, n.id == 'worker' ? 13 : 10, Paint()..color = color);
      canvas.drawCircle(p, n.id == 'worker' ? 13 : 10, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = const Color(0xCCFFFFFF));
    }
  }

  @override
  bool shouldRepaint(_WorldPainter old) => old.t != t || old.nodes != nodes || old.pulses != pulses || old.simulation != simulation;
}
