// ============================================================================
// C.H.E. THEME
//
// Shared color tokens, gradients and small reusable "premium AI product"
// widgets (glass panels, glow, floating animation) used across the main
// conversation screen and the Virtual Office hub. Pulled out of main.dart so
// visual language stays consistent and main.dart stops growing.
// ============================================================================

import 'dart:math' as math;
import 'package:flutter/material.dart';

class CheColors {
  CheColors._();

  static const Color bg = Color(0xFF0A121B);
  static const Color bgDeep = Color(0xFF060B11);
  static const Color panel = Color(0xFF101D2A);
  static const Color panelGlass = Color(0xCC13212F);
  static const Color accent = Color(0xFF67E8D1);
  static const Color accentDim = Color(0xFF2E8C7C);
  static const Color violet = Color(0xFF8B7BFF);
  static const Color amber = Color(0xFFFFC876);
  static const Color rose = Color(0xFFFF7E9B);
  static const Color textPrimary = Color(0xFFEAF3F2);
  static const Color textDim = Color(0xB3EAF3F2);

  static const List<Color> buildingPalette = [
    accent,
    violet,
    amber,
    rose,
    Color(0xFF6FB6FF),
    Color(0xFF9BFF9B),
    Color(0xFFFF9E6F),
    Color(0xFFB6A0FF),
  ];
}

/// Deep-space gradient background used behind both the conversation screen
/// and the Virtual Office world.
class CheBackdrop extends StatelessWidget {
  const CheBackdrop({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: RadialGradient(
          center: Alignment(0, -0.6),
          radius: 1.4,
          colors: [Color(0xFF122536), CheColors.bgDeep],
        ),
      ),
      child: child,
    );
  }
}

/// A frosted glass panel with a soft border glow. The building block for
/// every card in the redesigned UI.
class CheGlassPanel extends StatelessWidget {
  const CheGlassPanel({
    super.key,
    required this.child,
    this.glow = CheColors.accent,
    this.padding = const EdgeInsets.all(16),
    this.borderRadius = 20,
    this.onTap,
  });

  final Widget child;
  final Color glow;
  final EdgeInsets padding;
  final double borderRadius;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final panel = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: CheColors.panelGlass,
        borderRadius: BorderRadius.circular(borderRadius),
        border: Border.all(color: glow.withValues(alpha: 0.35), width: 1),
        boxShadow: [
          BoxShadow(
            color: glow.withValues(alpha: 0.16),
            blurRadius: 24,
            spreadRadius: -4,
          ),
        ],
      ),
      child: child,
    );

    if (onTap == null) return panel;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(borderRadius),
      child: InkWell(
        borderRadius: BorderRadius.circular(borderRadius),
        onTap: onTap,
        child: panel,
      ),
    );
  }
}

/// Gentle up/down float, used to make "building" tiles and the CHE presence
/// orb feel alive rather than static.
class CheFloat extends StatefulWidget {
  const CheFloat({
    super.key,
    required this.child,
    this.amplitude = 5,
    this.period = const Duration(milliseconds: 3200),
    this.phase = 0,
  });

  final Widget child;
  final double amplitude;
  final Duration period;
  final double phase;

  @override
  State<CheFloat> createState() => _CheFloatState();
}

class _CheFloatState extends State<CheFloat>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.period,
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final t = (_controller.value * 2 * math.pi) + widget.phase;
        return Transform.translate(
          offset: Offset(0, math.sin(t) * widget.amplitude),
          child: child,
        );
      },
      child: widget.child,
    );
  }
}

/// A pulsing radial glow ring, used behind the CHE presence orb to show
/// listening/speaking/thinking energy without needing new packages.
class ChePulse extends StatefulWidget {
  const ChePulse({
    super.key,
    required this.color,
    this.size = 160,
    this.active = true,
  });

  final Color color;
  final double size;
  final bool active;

  @override
  State<ChePulse> createState() => _ChePulseState();
}

class _ChePulseState extends State<ChePulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = widget.active ? _controller.value : 0.0;
        final scale = 0.85 + (t * 0.3);
        final opacity = widget.active ? (1 - t) * 0.5 : 0.15;
        return Transform.scale(
          scale: scale,
          child: Container(
            width: widget.size,
            height: widget.size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: widget.color.withValues(alpha: opacity),
                  blurRadius: 40,
                  spreadRadius: 10,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
