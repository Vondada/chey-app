// CHE 2.0 visual language (owner, 2026-10-22): layered blacks, brushed-silver edges, and teal/cyan energy used only
// where something is active. Semantic hues carry meaning, never decoration: violet = thinking and the Brain, amber =
// work in progress and markets, green = verified, red = error, rose = creative work.
// Motion: the energy ring animates only while CHE is actually listening, thinking, speaking or working; it is still
// when idle or offline, when Reduce Motion is on, and when its screen is not visible (TickerMode).
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'che_hud.dart';
import 'che_theme.dart';

/// CHE's energy and metal colours. The palette (che_palettes.dart) gives the surfaces; these give the light.
class CheEnergy {
  CheEnergy._();

  static const Color teal = Color(0xFF3FE6D2);
  static const Color cyan = Color(0xFF38D5FF);
  static const Color electric = Color(0xFF4F8BFF);
  static const Color violet = Color(0xFF9B87FF);
  static const Color amber = Color(0xFFFFB547);
  static const Color green = Color(0xFF3DDC97);
  static const Color red = Color(0xFFFF5C7A);
  static const Color rose = Color(0xFFFF6B9B);

  static const Color silverHi = Color(0xFFE3EAED);
  static const Color silver = Color(0xFFAEBBC0);
  static const Color gunmetal = Color(0xFF3A474D);
}

/// What CHE is doing right now. It is computed from real app state only (cheHomeModeFor), never invented.
enum CheHomeMode { idle, listening, thinking, speaking, working, offline }

/// The mode from the app's real signals. Speech and listening win, because the owner hears or is heard right now; a
/// pending reply is thinking; no server connection is offline; agents with running tasks are working.
CheHomeMode cheHomeModeFor({
  required bool connected,
  required bool listening,
  required bool thinking,
  required bool speaking,
  required int working,
}) {
  if (speaking) return CheHomeMode.speaking;
  if (listening) return CheHomeMode.listening;
  if (thinking) return CheHomeMode.thinking;
  if (!connected) return CheHomeMode.offline;
  if (working > 0) return CheHomeMode.working;
  return CheHomeMode.idle;
}

extension CheHomeModeLook on CheHomeMode {
  String get label => switch (this) {
        CheHomeMode.idle => 'Ready',
        CheHomeMode.listening => 'Listening',
        CheHomeMode.thinking => 'Thinking',
        CheHomeMode.speaking => 'Speaking',
        CheHomeMode.working => 'Working',
        CheHomeMode.offline => 'Offline',
      };

  Color get color => switch (this) {
        CheHomeMode.idle => cheHudActive ? CheHud.ice : CheEnergy.teal,
        CheHomeMode.listening => CheEnergy.cyan,
        CheHomeMode.thinking => CheEnergy.violet,
        CheHomeMode.speaking => CheEnergy.electric,
        CheHomeMode.working => CheEnergy.amber,
        CheHomeMode.offline => CheEnergy.red,
      };

  /// True while something is really happening, so the ring may move.
  bool get active => this == CheHomeMode.listening ||
      this == CheHomeMode.thinking ||
      this == CheHomeMode.speaking ||
      this == CheHomeMode.working;

  /// One pulse of the ring: quick while speaking or listening, slower while thinking or working.
  Duration get period => switch (this) {
        CheHomeMode.speaking => const Duration(milliseconds: 900),
        CheHomeMode.listening => const Duration(milliseconds: 1300),
        CheHomeMode.thinking => const Duration(milliseconds: 1800),
        CheHomeMode.working => const Duration(milliseconds: 2400),
        _ => const Duration(milliseconds: 3000),
      };
}

/// The sentence for a mode, shown under CHE and read by VoiceOver. It never says "tap here".
String cheHomeModeSentence(CheHomeMode mode, {int working = 0}) => switch (mode) {
      CheHomeMode.idle => 'CHE is ready when you are.',
      CheHomeMode.listening => 'CHE is listening.',
      CheHomeMode.thinking => 'CHE is thinking about your request.',
      CheHomeMode.speaking => 'CHE is speaking.',
      CheHomeMode.working => working == 1 ? '1 agent is working right now.' : '$working agents are working right now.',
      CheHomeMode.offline => 'CHE cannot reach her server right now.',
    };

/// A raised metal panel: a brushed-silver edge around a layered graphite surface, with an optional coloured glow.
class CheMetalPanel extends StatelessWidget {
  const CheMetalPanel({
    super.key,
    required this.child,
    this.glow,
    this.radius = CheRadius.lg,
    this.padding = const EdgeInsets.all(CheSpace.lg),
  });

  final Widget child;
  final Color? glow;
  final double radius;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    // HUD glass: the same panel as thick glossy glass (che_hud.dart).
    if (cheHudActive) return CheGlass(glow: glow, radius: radius, padding: padding, child: child);
    final edge = glow ?? CheEnergy.silver;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            CheEnergy.silverHi.withValues(alpha: 0.50),
            CheEnergy.gunmetal.withValues(alpha: 0.55),
            edge.withValues(alpha: 0.40),
          ],
        ),
        boxShadow: [
          if (glow != null) BoxShadow(color: glow!.withValues(alpha: 0.22), blurRadius: 22, spreadRadius: -4),
          BoxShadow(color: Colors.black.withValues(alpha: 0.45), blurRadius: 16, offset: const Offset(0, 8)),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(1),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radius - 1),
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [CheColors.surfaceHi, CheColors.surface],
            ),
          ),
          child: Padding(padding: padding, child: child),
        ),
      ),
    );
  }
}

/// CHE's energy ring: soft concentric light in the mode's colour around [child]. It pulses only while [mode] is active
/// and motion is allowed; otherwise it is drawn still.
class CheEnergyRing extends StatefulWidget {
  const CheEnergyRing({super.key, required this.mode, required this.size, required this.child});

  final CheHomeMode mode;
  final double size;
  final Widget child;

  @override
  State<CheEnergyRing> createState() => _CheEnergyRingState();
}

class _CheEnergyRingState extends State<CheEnergyRing> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: widget.mode.period);

  /// True when the ring may move: the mode is active and Reduce Motion is off.
  bool _moving(BuildContext context) =>
      widget.mode.active && !(MediaQuery.maybeDisableAnimationsOf(context) ?? false);

  void _sync() {
    if (!_moving(context)) {
      if (_pulse.isAnimating) _pulse.stop();
      _pulse.value = 0;
      return;
    }
    if (_pulse.duration != widget.mode.period) {
      _pulse.duration = widget.mode.period;
      _pulse.repeat();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(CheEnergyRing oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Its own layer: the ring's frames never repaint the panel, the glass or the screen around it.
    return RepaintBoundary(child: SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _pulse,
        builder: (context, child) => CustomPaint(
          painter: cheHudActive
              ? CheHudReactorPainter(color: widget.mode.color, t: _pulse.value, active: widget.mode.active)
              : _EnergyRingPainter(color: widget.mode.color, t: _pulse.value, active: widget.mode.active),
          child: child,
        ),
        child: Center(child: widget.child),
      ),
    ));
  }
}

class _EnergyRingPainter extends CustomPainter {
  _EnergyRingPainter({required this.color, required this.t, required this.active});

  final Color color;
  final double t;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2;
    // Base glow: a radial light that sits behind CHE.
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(colors: [
          color.withValues(alpha: active ? 0.30 : 0.18),
          color.withValues(alpha: 0.06),
          Colors.transparent,
        ], stops: const [0.0, 0.62, 1.0])
            .createShader(Rect.fromCircle(center: c, radius: r)),
    );
    // Metal ring with a lit arc.
    final ringR = r * 0.86;
    canvas.drawCircle(
      c,
      ringR,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = CheEnergy.silver.withValues(alpha: 0.35),
    );
    final sweep = math.pi * (active ? 0.9 : 0.55);
    final start = -math.pi / 2 + t * 2 * math.pi;
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: ringR),
      start,
      sweep,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 3
        ..color = color.withValues(alpha: 0.85),
    );
    // A pulse wave that expands outward while CHE is active.
    if (active) {
      final waveR = ringR + (r - ringR) * t;
      canvas.drawCircle(
        c,
        waveR,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = color.withValues(alpha: 0.45 * (1 - t)),
      );
    }
  }

  @override
  bool shouldRepaint(_EnergyRingPainter old) => old.t != t || old.color != color || old.active != active;
}
