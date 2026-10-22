// CHE HUD look (owner, 2026-10-22: "glassy, futuristic, glossy ... like Iron Man's devices ... not cartoony ... digital,
// future 3D"; approved from the rendered concept). Deep navy space, a holographic floor grid, thick glossy glass with a
// specular sheen and a spectral rim, chrome-silver lettering and ice-blue light.
// Everything here is decoration only: no widget in this file invents data, speaks, or changes what a control does.
// The backdrop is painted once (no animation); blur is used only where a panel asks for it.
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'che_active_palette.dart';
import 'che_palettes.dart';

/// True while the owner's palette is HUD glass (the default). Other palettes keep their earlier, flatter look.
bool get cheHudActive => CheActivePalette.current.id == kCheHudPalette.id;

/// The HUD light colours. The palette (che_palettes.dart, "HUD glass") gives the surfaces and text.
class CheHud {
  CheHud._();

  static const Color ice = Color(0xFF9FE9FF);
  static const Color iceDeep = Color(0xFF5FD2FF);
  static const Color lilac = Color(0xFFC7B5FF);
  static const Color mint = Color(0xFF8FF5C9);
  static const Color navyTop = Color(0xFF071222);
  static const Color navyMid = Color(0xFF040A14);
  static const Color space = Color(0xFF02050A);
  static const Color chromeHi = Color(0xFFFFFFFF);
  static const Color chromeMid = Color(0xFF9FB0C2);
  static const Color chromeLo = Color(0xFF7F98B3);

  /// Polished chrome, top to bottom: bright, a dark horizon band, bright again.
  static const LinearGradient chrome = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFFFFFFFF), Color(0xFFE3EBF3), Color(0xFF9FB0C2), Color(0xFFEEF4FA), Color(0xFFB9C6D4)],
    stops: [0.0, 0.22, 0.5, 0.78, 1.0],
  );

  /// The glass rim: white, clear, ice, clear, lilac (a thin rainbow-glass edge).
  static const List<Color> rim = [
    Color(0xFFFFFFFF),
    Color(0x1AFFFFFF),
    Color(0x809FE9FF),
    Color(0x0DFFFFFF),
    Color(0xB3D6BEFF),
  ];

  /// Monospaced HUD labels (iOS ships Menlo).
  static const TextStyle label = TextStyle(
    fontFamily: 'Menlo',
    fontFamilyFallback: ['Courier', 'monospace'],
    fontSize: 10.5,
    fontWeight: FontWeight.w600,
    letterSpacing: 1.6,
    color: ice,
    fontFeatures: [FontFeature.tabularFigures()],
  );
}

/// The HUD backdrop: navy depth, soft light from above, and a perspective grid floor fading into the distance.
class CheHudBackdrop extends StatelessWidget {
  const CheHudBackdrop({super.key, required this.child, this.aura, this.floor = 1.0});

  final Widget child;

  /// An optional tint for the light from above (CHE's state colour on Home).
  final Color? aura;

  /// Floor grid strength, 0 to 1. Chat uses a fainter floor so text stays the focus.
  final double floor;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _HudBackdropPainter(aura: aura ?? CheHud.iceDeep, floor: floor),
      // Fills its space like the earlier background did.
      child: SizedBox.expand(child: child),
    );
  }
}

class _HudBackdropPainter extends CustomPainter {
  _HudBackdropPainter({required this.aura, required this.floor});

  final Color aura;
  final double floor;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [CheHud.navyTop, CheHud.navyMid, CheHud.space],
          stops: [0.0, 0.45, 1.0],
        ).createShader(rect),
    );
    void glow(Offset c, double rx, double ry, Color color, double alpha) {
      canvas.save();
      canvas.translate(c.dx, c.dy);
      canvas.scale(1, ry / rx);
      canvas.drawCircle(
        Offset.zero,
        rx,
        Paint()
          ..shader = RadialGradient(colors: [color.withValues(alpha: alpha), color.withValues(alpha: 0)])
              .createShader(Rect.fromCircle(center: Offset.zero, radius: rx)),
      );
      canvas.restore();
    }

    final w = size.width, h = size.height;
    glow(Offset(w * 0.5, h * 0.28), w * 0.9, h * 0.32, aura, 0.20);
    glow(Offset(w * 0.12, 0), w * 0.6, h * 0.2, const Color(0xFFBED2FF), 0.14);
    glow(Offset(w, h), w * 0.6, h * 0.25, const Color(0xFFA078FF), 0.12);

    if (floor > 0) _paintFloor(canvas, size);

    // Fixed specks of light (no randomness, so every frame and every test image is the same).
    final dust = Paint()..color = const Color(0xFFC8EBFF).withValues(alpha: 0.45);
    for (final p in const [
      Offset(0.20, 0.30), Offset(0.70, 0.18), Offset(0.82, 0.46), Offset(0.35, 0.62),
      Offset(0.12, 0.78), Offset(0.58, 0.84), Offset(0.90, 0.70), Offset(0.45, 0.10),
    ]) {
      canvas.drawCircle(Offset(p.dx * w, p.dy * h), 0.9, dust);
    }
  }

  // A floor plane seen from above the horizon: rows get closer together with distance and columns converge on a
  // vanishing point. The grid fades out before the horizon so content above stays clean.
  void _paintFloor(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final horizon = h * 0.52;
    final depth = h - horizon;
    final vanish = Offset(w / 2, horizon - depth * 0.6);
    final base = 0.22 * floor;
    final line = Paint()
      ..strokeWidth = 1
      ..style = PaintingStyle.stroke;
    for (var i = 0; i <= 16; i++) {
      final f = math.pow(i / 16, 1.9).toDouble();
      final y = h - depth * (1 - f);
      final a = base * f;
      line.color = const Color(0xFF78D2FF).withValues(alpha: a);
      canvas.drawLine(Offset(0, y), Offset(w, y), line);
    }
    for (var i = -12; i <= 12; i++) {
      final xBottom = w / 2 + i * w / 6;
      final t = (h - horizon) / (h - vanish.dy);
      final xTop = vanish.dx + (xBottom - vanish.dx) * (1 - t);
      line.shader = LinearGradient(
        begin: Alignment.bottomCenter,
        end: Alignment.topCenter,
        colors: [const Color(0xFF78D2FF).withValues(alpha: base), const Color(0x0078D2FF)],
      ).createShader(Rect.fromLTRB(0, horizon, w, h));
      canvas.drawLine(Offset(xBottom, h), Offset(xTop, horizon), line);
      line.shader = null;
    }
  }

  @override
  bool shouldRepaint(_HudBackdropPainter old) => old.aura != aura || old.floor != floor;
}

/// Thick glossy glass: a frosted body, a specular sheen across the top, a spectral rim, light pooled at the bottom
/// edge and an optional coloured glow outside. [blur] frosts what is behind it; turn it off for long lists.
class CheGlass extends StatelessWidget {
  const CheGlass({
    super.key,
    required this.child,
    this.radius = 24,
    this.padding = EdgeInsets.zero,
    this.glow,
    this.blur = true,
    this.tint,
    this.shadow = true,
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? glow;
  final bool blur;
  final Color? tint;
  final bool shadow;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(radius);
    final light = tint ?? CheHud.iceDeep;
    Widget body = DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: r,
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            // Projected glass: a cyan-tinted, see-through pane, brighter at the top like a lit display.
            const Color(0xFF9FE9FF).withValues(alpha: 0.16),
            const Color(0xFF5FD2FF).withValues(alpha: 0.06),
            const Color(0xFF2F7FD0).withValues(alpha: 0.10),
          ],
          stops: const [0.0, 0.38, 1.0],
        ),
      ),
      position: DecorationPosition.background,
      child: CustomPaint(
        foregroundPainter: _GlassPainter(radius: radius, light: light, glow: glow),
        child: Padding(padding: padding, child: child),
      ),
    );
    if (blur) {
      body = BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 20, sigmaY: 20), child: body);
    }
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: r,
        // Only a soft drop shadow sits under the glass: a coloured shadow would show through and tint the whole panel.
        // A panel's glow is drawn along its edge instead (_GlassPainter).
        boxShadow: [
          if (shadow) BoxShadow(color: Colors.black.withValues(alpha: 0.35), blurRadius: 26, offset: const Offset(0, 14)),
        ],
      ),
      child: ClipRRect(borderRadius: r, child: body),
    );
  }
}

class _GlassPainter extends CustomPainter {
  _GlassPainter({required this.radius, required this.light, this.glow});

  final double radius;
  final Color light;
  final Color? glow;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rr = RRect.fromRectAndRadius(rect, Radius.circular(radius));
    canvas.save();
    canvas.clipRRect(rr);
    // Specular sheen: a wide soft ellipse of light over the top of the glass.
    final sheen = Rect.fromLTWH(-size.width * 0.1, -size.height * 0.6, size.width * 1.2, size.height * 0.95);
    canvas.drawOval(
      sheen,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.white.withValues(alpha: 0.30), Colors.white.withValues(alpha: 0.05), Colors.white.withValues(alpha: 0)],
          stops: const [0.0, 0.6, 1.0],
        ).createShader(sheen),
    );
    // Light pooled along the bottom edge, as in thick glass.
    final pool = Rect.fromLTWH(0, size.height - math.min(30, size.height * 0.5), size.width, math.min(30, size.height * 0.5));
    canvas.drawRect(
      pool,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.bottomCenter,
          end: Alignment.topCenter,
          colors: [light.withValues(alpha: 0.22), light.withValues(alpha: 0)],
        ).createShader(pool),
    );
    // Iron Man glass: faint scan lines across the pane, as on a projected display.
    final scan = Paint()
      ..color = CheHud.ice.withValues(alpha: 0.045)
      ..strokeWidth = 1;
    for (var y = 2.0; y < size.height; y += 4) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), scan);
    }
    // A panel's own colour glows just inside its edge.
    if (glow != null) {
      canvas.drawRRect(
        rr,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 6
          ..color = glow!.withValues(alpha: 0.45)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
      );
    }
    canvas.restore();
    // The bevel: a bright top line and a spectral rim all round.
    canvas.drawRRect(
      rr.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..shader = const LinearGradient(
          begin: Alignment(-1, -1),
          end: Alignment(1, 1),
          colors: CheHud.rim,
          stops: [0.0, 0.3, 0.55, 0.75, 1.0],
        ).createShader(rect),
    );
    canvas.drawLine(
      Offset(radius * 0.8, 1),
      Offset(size.width - radius * 0.8, 1),
      Paint()
        ..strokeWidth = 1.2
        ..color = Colors.white.withValues(alpha: 0.65),
    );
    // HUD targeting brackets just inside each corner, glowing ice. Skipped on pill-shaped bars (no corners) and on
    // panels too small to hold them.
    if (size.width >= 80 && size.height >= 44 && radius > 0 && radius < size.height * 0.4) {
      final arm = math.min(16.0, math.min(size.width, size.height) * 0.18);
      final inset = radius * 0.42 + 3;
      final bracket = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6
        ..strokeCap = StrokeCap.round
        ..color = (glow ?? CheHud.ice).withValues(alpha: 0.85)
        ..maskFilter = const MaskFilter.blur(BlurStyle.solid, 2);
      for (final (cx, cy, dx, dy) in [
        (inset, inset, 1.0, 1.0),
        (size.width - inset, inset, -1.0, 1.0),
        (inset, size.height - inset, 1.0, -1.0),
        (size.width - inset, size.height - inset, -1.0, -1.0),
      ]) {
        canvas.drawPath(
          Path()
            ..moveTo(cx, cy + dy * arm)
            ..lineTo(cx, cy)
            ..lineTo(cx + dx * arm, cy),
          bracket,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_GlassPainter old) => old.radius != radius || old.light != light || old.glow != glow;
}

/// Text in polished chrome. The text itself is ordinary [Text], so VoiceOver and Dynamic Type read it as usual.
class CheChromeText extends StatelessWidget {
  const CheChromeText(this.text, {super.key, required this.style, this.textAlign, this.maxLines});

  final String text;
  final TextStyle style;
  final TextAlign? textAlign;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (rect) => CheHud.chrome.createShader(rect),
      child: Text(
        text,
        textAlign: textAlign,
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
        style: style.copyWith(color: Colors.white),
      ),
    );
  }
}

/// A polished chrome orb, used for the main voice control. [color] lights its ring (ice, or red while listening).
class CheChromeOrb extends StatelessWidget {
  const CheChromeOrb({super.key, required this.size, required this.child, this.color = CheHud.ice});

  final double size;
  final Widget child;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: const RadialGradient(
          center: Alignment(-0.32, -0.48),
          colors: [Color(0xFFFFFFFF), Color(0xFFDBE7F2), Color(0xFF7F98B3), Color(0xFF3D5168)],
          stops: [0.0, 0.30, 0.72, 1.0],
        ),
        border: Border.all(color: color.withValues(alpha: 0.55), width: 2),
        boxShadow: [BoxShadow(color: color.withValues(alpha: 0.65), blurRadius: 22)],
      ),
      child: child,
    );
  }
}

/// The HUD reactor around CHE: a tick scale, a chrome ring, spectral arcs and a dashed inner ring, in [color].
/// [t] (0..1) turns the arcs; [active] adds the outward pulse. Static when [t] stays 0.
class CheHudReactorPainter extends CustomPainter {
  CheHudReactorPainter({required this.color, required this.t, required this.active});

  final Color color;
  final double t;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2;
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(colors: [
          color.withValues(alpha: active ? 0.34 : 0.24),
          color.withValues(alpha: 0.07),
          Colors.transparent,
        ], stops: const [0.0, 0.55, 0.78])
            .createShader(Rect.fromCircle(center: c, radius: r)),
    );
    // Tick scale: 120 ticks, every tenth long.
    final tick = Paint()..strokeCap = StrokeCap.round;
    for (var i = 0; i < 120; i++) {
      final a = i * 3 * math.pi / 180;
      final long = i % 10 == 0;
      final r1 = r * 0.96, r2 = r * (long ? 0.89 : 0.925);
      tick
        ..strokeWidth = long ? 1.6 : 1
        ..color = CheHud.ice.withValues(alpha: long ? 0.85 : 0.35);
      canvas.drawLine(c + Offset(math.cos(a), math.sin(a)) * r1, c + Offset(math.cos(a), math.sin(a)) * r2, tick);
    }
    // Chrome ring.
    final ring = Rect.fromCircle(center: c, radius: r * 0.82);
    canvas.drawCircle(
      c,
      r * 0.82,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..shader = const SweepGradient(
          colors: [Color(0xFFFFFFFF), Color(0xFF9FB0C2), Color(0xFFEEF4FA), Color(0xFF8FA2B6), Color(0xFFFFFFFF)],
        ).createShader(ring),
    );
    canvas.drawCircle(
      c,
      r * 0.79,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = CheHud.ice.withValues(alpha: 0.25),
    );
    // Spectral arcs on the outer track, turning with t.
    final spin = t * 2 * math.pi;
    final track = Rect.fromCircle(center: c, radius: r * 0.86);
    final arc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 2.5;
    double rad(double deg) => deg * math.pi / 180;
    arc.shader = SweepGradient(
      colors: [color, CheHud.lilac, color],
      transform: GradientRotation(spin),
    ).createShader(track);
    canvas.drawArc(track, rad(-150) + spin, rad(110), false, arc);
    arc.shader = null;
    arc.color = color.withValues(alpha: 0.9);
    canvas.drawArc(track, rad(20) + spin, rad(75), false, arc);
    arc.color = CheHud.lilac.withValues(alpha: 0.9);
    canvas.drawArc(track, rad(140) + spin, rad(35), false, arc);
    final node = rad(-40) + spin;
    canvas.drawCircle(c + Offset(math.cos(node), math.sin(node)) * (r * 0.86), 4, Paint()..color = const Color(0xFFE9FBFF));
    // Dashed inner ring, turning the other way.
    final inner = Rect.fromCircle(center: c, radius: r * 0.74);
    final dash = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = CheHud.ice.withValues(alpha: 0.55);
    for (var i = 0; i < 40; i++) {
      final a0 = rad(-80) - spin * 0.5 + i * rad(7);
      canvas.drawArc(inner, a0, rad(2), false, dash);
    }
    // Outer brackets top and bottom.
    final outer = Rect.fromCircle(center: c, radius: r);
    final bracket = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = Colors.white.withValues(alpha: 0.7);
    canvas.drawArc(outer, rad(-120), rad(60), false, bracket);
    canvas.drawArc(outer, rad(60), rad(60), false, bracket);
    if (active) {
      final waveR = r * 0.82 + r * 0.18 * t;
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
  bool shouldRepaint(CheHudReactorPainter old) => old.t != t || old.color != color || old.active != active;
}
