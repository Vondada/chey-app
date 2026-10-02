import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';

/// Original CHE Core mark: a compact, dense, compressed-energy sphere.
/// Not a copy of any named anime or game energy attack.
class CheCoreSphere extends StatefulWidget {
  const CheCoreSphere({super.key, this.size = 148, this.active = true});

  final double size;
  final bool active;

  @override
  State<CheCoreSphere> createState() => _CheCoreSphereState();
}

class _CheCoreSphereState extends State<CheCoreSphere> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduced = CheMotion.reduced(context) || !widget.active;
    if (reduced) {
      _controller.stop();
      _controller.value = 0.35;
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void didUpdateWidget(covariant CheCoreSphere oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active && _controller.isAnimating) _controller.stop();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'CHE Core. Compact compressed-energy sphere.',
      child: ExcludeSemantics(
        child: SizedBox(
          width: widget.size,
          height: widget.size,
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, _) => CustomPaint(
              painter: _CoreSpherePainter(_controller.value),
            ),
          ),
        ),
      ),
    );
  }
}

class _CoreSpherePainter extends CustomPainter {
  _CoreSpherePainter(this.t);

  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide * 0.46;
    final field = Paint()
      ..shader = const RadialGradient(
        colors: [Color(0xFF07352E), Color(0xFF04110F), Color(0xFF010605)],
        stops: [0.2, 0.72, 1],
      ).createShader(Offset.zero & size);
    canvas.drawCircle(center, radius, field);

    final shell = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.1;
    for (var i = 0; i < 18; i++) {
      final depth = i / 17;
      final compressed = radius * (1 - math.pow(depth, 1.7) * 0.82);
      shell.color = CheColors.accent.withValues(alpha: 0.08 + depth * 0.28);
      canvas.drawCircle(center, compressed, shell);
    }

    final filament = Paint()
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 1.2;
    for (var i = 0; i < 42; i++) {
      final angle = (i / 42) * math.pi * 2 + t * 0.35;
      final inner = radius * (0.18 + (i % 5) * 0.03);
      final outer = radius * (0.62 + (i % 3) * 0.08);
      filament.color = (i.isEven ? CheColors.accent : CheColors.accentAlt).withValues(alpha: 0.28);
      canvas.drawLine(
        center + Offset(math.cos(angle), math.sin(angle)) * inner,
        center + Offset(math.cos(angle), math.sin(angle)) * outer,
        filament,
      );
    }

    final coreRadius = radius * (0.16 + 0.015 * math.sin(t * math.pi * 2));
    canvas.drawCircle(
      center,
      coreRadius * 2.4,
      Paint()
        ..color = CheColors.accent.withValues(alpha: 0.16)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 12),
    );
    canvas.drawCircle(
      center,
      coreRadius,
      Paint()
        ..shader = const RadialGradient(
          colors: [Color(0xFFF4FFFC), CheColors.accent, CheColors.accentDeep],
        ).createShader(Rect.fromCircle(center: center, radius: coreRadius)),
    );
  }

  @override
  bool shouldRepaint(covariant _CoreSpherePainter oldDelegate) => oldDelegate.t != t;
}
