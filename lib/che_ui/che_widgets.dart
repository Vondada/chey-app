// CHE reusable widgets: background, glow card, glass panel, pill toggle,
// office tile, header, section bar, step line, thinking shimmer, code card,
// rich (markdown-lite) text, and a glowing popover menu.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';

// ─────────────────────────────────────────────────────────────────────────
// Background
// ─────────────────────────────────────────────────────────────────────────

/// Near-black backdrop with a faint logo-colored aura at the top.
class CheBackground extends StatelessWidget {
  const CheBackground({super.key, required this.child, this.auraColor});
  final Widget child;
  final Color? auraColor;

  @override
  Widget build(BuildContext context) {
    final aura = auraColor ?? CheColors.accent;
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [CheColors.bgTop, CheColors.bg],
        ),
      ),
      child: Stack(children: [
        Positioned(
          top: -160,
          left: -80,
          right: -80,
          height: 380,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  colors: [aura.withOpacity(0.16), aura.withOpacity(0.0)],
                ),
              ),
            ),
          ),
        ),
        Positioned.fill(child: child),
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Glow card — rotating gradient border, pulses brighter while `active`.
// ─────────────────────────────────────────────────────────────────────────

class GlowCard extends StatefulWidget {
  const GlowCard({
    super.key,
    required this.child,
    this.active = false,
    this.color,
    this.radius = CheRadius.lg,
    this.padding = const EdgeInsets.all(CheSpace.md),
    this.fill,
  });

  final Widget child;
  final bool active;
  final Color? color;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? fill;

  @override
  State<GlowCard> createState() => _GlowCardState();
}

class _GlowCardState extends State<GlowCard> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 4));

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant GlowCard old) {
    super.didUpdateWidget(old);
    if (old.active != widget.active && !CheMotion.reduced(context)) _sync();
  }

  void _sync() {
    _c.duration = Duration(milliseconds: widget.active ? 1600 : 6000);
    _c.repeat(); // restart so the new speed applies immediately
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (CheMotion.reduced(context)) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? CheColors.accent;
    final r = BorderRadius.circular(widget.radius);
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) {
        final pulse = widget.active ? 0.55 + 0.45 * math.sin(_c.value * math.pi * 2).abs() : 0.35;
        return Container(
          decoration: BoxDecoration(
            borderRadius: r,
            boxShadow: [
              BoxShadow(
                color: color.withOpacity(0.22 * pulse + (widget.active ? 0.12 : 0)),
                blurRadius: widget.active ? 34 : 22,
                spreadRadius: widget.active ? 1 : 0,
              ),
            ],
          ),
          child: CustomPaint(
            foregroundPainter: _GlowBorderPainter(
              progress: _c.value,
              radius: widget.radius,
              color: color,
              alt: CheColors.accentAlt,
              intensity: widget.active ? 1.0 : 0.55,
            ),
            child: ClipRRect(
              borderRadius: r,
              child: Container(
                color: widget.fill ?? CheColors.surface.withOpacity(0.92),
                padding: widget.padding,
                child: child,
              ),
            ),
          ),
        );
      },
      child: widget.child,
    );
  }
}

class _GlowBorderPainter extends CustomPainter {
  _GlowBorderPainter({
    required this.progress,
    required this.radius,
    required this.color,
    required this.alt,
    required this.intensity,
  });
  final double progress;
  final double radius;
  final Color color;
  final Color alt;
  final double intensity;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(rect.deflate(0.75), Radius.circular(radius));
    final shader = SweepGradient(
      transform: GradientRotation(progress * math.pi * 2),
      colors: [
        color.withOpacity(0.15 * intensity),
        color.withOpacity(0.95 * intensity),
        alt.withOpacity(0.7 * intensity),
        color.withOpacity(0.15 * intensity),
      ],
      stops: const [0.0, 0.35, 0.6, 1.0],
    ).createShader(rect);
    canvas.drawRRect(
      rrect,
      Paint()
        ..shader = shader
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );
  }

  @override
  bool shouldRepaint(covariant _GlowBorderPainter old) =>
      old.progress != progress || old.intensity != intensity || old.color != color;
}

// ─────────────────────────────────────────────────────────────────────────
// Glass panel
// ─────────────────────────────────────────────────────────────────────────

class GlassPanel extends StatelessWidget {
  const GlassPanel({
    super.key,
    required this.child,
    this.radius = CheRadius.md,
    this.padding = const EdgeInsets.all(CheSpace.md),
    this.tint,
    this.blur = 18,
  });
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? tint;
  final double blur;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(radius);
    return ClipRRect(
      borderRadius: r,
      child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            borderRadius: r,
            color: (tint ?? CheColors.surfaceHi).withOpacity(0.72),
            border: Border.all(color: CheColors.stroke),
          ),
          child: child,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pill toggle (e.g. Agent | Chat)
// ─────────────────────────────────────────────────────────────────────────

class PillToggle extends StatelessWidget {
  const PillToggle({
    super.key,
    required this.options,
    required this.index,
    required this.onChanged,
    this.height = 38,
  });
  final List<String> options;
  final int index;
  final ValueChanged<int> onChanged;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.pill),
        border: Border.all(color: CheColors.stroke),
      ),
      child: LayoutBuilder(builder: (context, c) {
        final w = c.maxWidth / options.length;
        return Stack(children: [
          AnimatedPositioned(
            duration: CheMotion.d(context, CheMotion.base),
            curve: CheMotion.curve,
            left: w * index,
            top: 0,
            bottom: 0,
            width: w,
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                gradient: LinearGradient(colors: [
                  CheColors.accent.withOpacity(0.28),
                  CheColors.accentAlt.withOpacity(0.18),
                ]),
                border: Border.all(color: CheColors.accent.withOpacity(0.7)),
                boxShadow: [BoxShadow(color: CheColors.accent.withOpacity(0.35), blurRadius: 14)],
              ),
            ),
          ),
          Row(children: [
            for (var i = 0; i < options.length; i++)
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    if (i == index) return;
                    HapticFeedback.selectionClick();
