// CHE HUD look (owner, 2026-10-22: "glassy, futuristic, glossy ... like Iron Man's devices ... not cartoony ... digital,
// future 3D"; approved from the rendered concept). Deep navy space, a holographic floor grid, thick glossy glass with a
// specular sheen and a spectral rim, chrome-silver lettering and ice-blue light.
// Everything here is decoration only: no widget in this file invents data, speaks, or changes what a control does.
// The backdrop is painted once (no animation); blur is used only where a panel asks for it.
// Owner, 2026-10-22 (later): "same type of design, but way more futuristic ... 2036, 2070", so panels are angled
// holographic plates with iridescent edges instead of rounded glossy glass, and CHE's reactor is a gyroscope.
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
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

  /// Holographic chrome, top to bottom: white light, a cool ice band, a violet-tinted dip, then bright again.
  static const LinearGradient chrome = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFFFFFFFF), Color(0xFFEAF8FF), Color(0xFFA9DDF5), Color(0xFFC9BCFF), Color(0xFFF2FAFF)],
    stops: [0.0, 0.28, 0.55, 0.78, 1.0],
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

/// The HUD backdrop: deep space with a violet undertone, light from above, a glowing horizon line over a perspective
/// light-floor, faint orbital arcs and a dot field. Painted once; nothing here moves.
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
      // Fills its space like the earlier background did. The content repaints on its own layer, so a moving part
      // (CHE's reactor, a typing caret) never repaints the backdrop.
      child: SizedBox.expand(child: RepaintBoundary(child: child)),
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
          colors: [Color(0xFF060B1C), CheHud.navyMid, Color(0xFF02030A)],
          stops: [0.0, 0.5, 1.0],
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
    glow(Offset(w * 0.5, h * 0.26), w * 0.95, h * 0.30, aura, 0.18);
    glow(Offset(w * 0.08, h * 0.02), w * 0.55, h * 0.18, const Color(0xFF7A8CFF), 0.16);
    glow(Offset(w * 1.0, h * 0.95), w * 0.7, h * 0.28, const Color(0xFFA078FF), 0.14);
    glow(Offset(w * 0.0, h * 0.70), w * 0.45, h * 0.20, CheHud.mint, 0.05);

    // A fine dot field across the upper sky, fading downward: the "light-field" of a projected display.
    final dots = <Offset>[];
    const step = 18.0;
    for (var y = step / 2; y < h * 0.5; y += step) {
      for (var x = (y ~/ step).isEven ? step / 2 : step; x < w; x += step) {
        dots.add(Offset(x, y));
      }
    }
    canvas.drawPoints(
      ui.PointMode.points,
      dots,
      Paint()
        ..strokeWidth = 1
        ..strokeCap = StrokeCap.round
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [CheHud.ice.withValues(alpha: 0.10), CheHud.ice.withValues(alpha: 0)],
        ).createShader(Rect.fromLTWH(0, 0, w, h * 0.5)),
    );

    // Faint orbital arcs behind everything, off to one side.
    final orbit = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final (rf, a) in const [(0.62, 0.10), (0.78, 0.07), (0.96, 0.05)]) {
      orbit.color = CheHud.ice.withValues(alpha: a);
      canvas.drawArc(Rect.fromCircle(center: Offset(w * 1.05, h * 0.18), radius: w * rf), math.pi * 0.55, math.pi * 0.55, false, orbit);
    }

    if (floor > 0) _paintFloor(canvas, size);

    // Fixed specks of light (no randomness, so every frame and every test image is the same).
    final dust = Paint()..color = const Color(0xFFC8EBFF).withValues(alpha: 0.5);
    for (final p in const [
      Offset(0.20, 0.30), Offset(0.70, 0.18), Offset(0.82, 0.46), Offset(0.35, 0.62),
      Offset(0.12, 0.78), Offset(0.58, 0.84), Offset(0.90, 0.70), Offset(0.45, 0.10),
    ]) {
      canvas.drawCircle(Offset(p.dx * w, p.dy * h), 0.9, dust);
    }
  }

  // A floor plane seen from above the horizon: rows get closer together with distance and columns converge on a
  // vanishing point. A bright horizon line blooms where the floor meets the sky.
  void _paintFloor(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final horizon = h * 0.52;
    final depth = h - horizon;
    final vanish = Offset(w / 2, horizon - depth * 0.6);
    final base = 0.24 * floor;
    final line = Paint()
      ..strokeWidth = 1
      ..style = PaintingStyle.stroke;
    for (var i = 0; i <= 16; i++) {
      final f = math.pow(i / 16, 1.9).toDouble();
      final y = h - depth * (1 - f);
      line.color = const Color(0xFF78D2FF).withValues(alpha: base * f);
      canvas.drawLine(Offset(0, y), Offset(w, y), line);
    }
    final t = (h - horizon) / (h - vanish.dy);
    line.shader = LinearGradient(
      begin: Alignment.bottomCenter,
      end: Alignment.topCenter,
      colors: [const Color(0xFF78D2FF).withValues(alpha: base), const Color(0x0078D2FF)],
    ).createShader(Rect.fromLTRB(0, horizon, w, h));
    for (var i = -12; i <= 12; i++) {
      final xBottom = w / 2 + i * w / 6;
      final xTop = vanish.dx + (xBottom - vanish.dx) * (1 - t);
      canvas.drawLine(Offset(xBottom, h), Offset(xTop, horizon), line);
    }
    line.shader = null;
    // The horizon: a soft bloom and a thin bright line that fades out to the sides.
    final band = Rect.fromLTWH(0, horizon - 1, w, 2);
    final fade = LinearGradient(colors: [
      CheHud.iceDeep.withValues(alpha: 0),
      CheHud.ice.withValues(alpha: 0.55 * floor),
      CheHud.iceDeep.withValues(alpha: 0),
    ]).createShader(band);
    canvas.drawRect(
      Rect.fromLTWH(0, horizon - 10, w, 20),
      Paint()
        ..shader = fade
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 8),
    );
    canvas.drawRect(band, Paint()..shader = fade);
  }

  @override
  bool shouldRepaint(_HudBackdropPainter old) => old.aura != aura || old.floor != floor;
}

/// The outline of a HUD panel: a holographic plate with angled corners. The top-left and bottom-right corners are
/// cut deep, the other two shallow. A pill-shaped bar ([cut] at least 40% of its height) gets pointed hexagonal ends.
Path cheHudPlate(Rect r, double cut) {
  if (cut <= 0) return Path()..addRect(r);
  final pill = cut >= r.height * 0.4;
  final big = pill ? r.height * 0.42 : math.min(cut * 0.75, math.min(r.width, r.height) * 0.3);
  final small = pill ? big : big * 0.4;
  if (pill) {
    final mid = r.center.dy;
    return Path()
      ..moveTo(r.left + big, r.top)
      ..lineTo(r.right - big, r.top)
      ..lineTo(r.right, mid)
      ..lineTo(r.right - big, r.bottom)
      ..lineTo(r.left + big, r.bottom)
      ..lineTo(r.left, mid)
      ..close();
  }
  return Path()
    ..moveTo(r.left + big, r.top)
    ..lineTo(r.right - small, r.top)
    ..lineTo(r.right, r.top + small)
    ..lineTo(r.right, r.bottom - big)
    ..lineTo(r.right - big, r.bottom)
    ..lineTo(r.left + small, r.bottom)
    ..lineTo(r.left, r.bottom - small)
    ..lineTo(r.left, r.top + big)
    ..close();
}

class _PlateClipper extends CustomClipper<Path> {
  const _PlateClipper(this.cut);

  final double cut;

  @override
  Path getClip(Size size) => cheHudPlate(Offset.zero & size, cut);

  @override
  bool shouldReclip(_PlateClipper old) => old.cut != cut;
}

/// A holographic glass plate: an angled-corner pane of projected light with an iridescent edge, a fine light-grid,
/// a diagonal light streak, edge data ticks and glowing corner accents. [radius] sets how deep the corners are cut.
/// [blur] frosts what is behind it; turn it off for long lists.
class CheGlass extends StatelessWidget {
  const CheGlass({
    super.key,
    required this.child,
    this.radius = 24,
    this.padding = EdgeInsets.zero,
    this.glow,
    this.blur = false,
    this.tint,
    this.shadow = true,
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? glow;
  /// Frosts what is behind the pane. Off by default: CHE's panes sit over the painted backdrop, not over moving
  /// content, and a blur on every panel costs the iPhone a full-screen pass per panel per frame (owner, 2026-10-22: laggy).
  final bool blur;
  final Color? tint;
  /// The soft emitted light around the plate's edge.
  final bool shadow;

  @override
  Widget build(BuildContext context) {
    final light = tint ?? CheHud.iceDeep;
    Widget body = CustomPaint(
      painter: _GlassFillPainter(cut: radius, light: light),
      foregroundPainter: _GlassPainter(cut: radius, light: light, glow: glow),
      child: Padding(padding: padding, child: child),
    );
    if (blur) {
      body = BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 20, sigmaY: 20), child: body);
    }
    return CustomPaint(
      // The emitted halo sits outside the clip, so the plate glows into the space around it.
      painter: shadow ? _GlassHaloPainter(cut: radius, color: glow ?? light) : null,
      child: ClipPath(clipper: _PlateClipper(radius), child: body),
    );
  }
}

class _GlassHaloPainter extends CustomPainter {
  _GlassHaloPainter({required this.cut, required this.color});

  final double cut;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final path = cheHudPlate(Offset.zero & size, cut);
    canvas.drawPath(
      path.shift(const Offset(0, 10)),
      Paint()
        ..color = Colors.black.withValues(alpha: 0.4)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 14),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = color.withValues(alpha: 0.22)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10),
    );
  }

  @override
  bool shouldRepaint(_GlassHaloPainter old) => old.cut != cut || old.color != color;
}

class _GlassFillPainter extends CustomPainter {
  _GlassFillPainter({required this.cut, required this.light});

  final double cut;
  final Color light;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    // Projected light: cool and clear at the top-left, deepening to blue-violet at the bottom-right.
    canvas.drawRect(
      rect,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            CheHud.ice.withValues(alpha: 0.13),
            const Color(0xFF3E7BD6).withValues(alpha: 0.06),
            const Color(0xFF5A3FB0).withValues(alpha: 0.10),
          ],
          stops: const [0.0, 0.5, 1.0],
        ).createShader(rect),
    );
    // A fine light-grid of dots, like the pixel lattice of a holographic emitter.
    final dots = <Offset>[];
    const step = 9.0;
    for (var y = step; y < size.height; y += step) {
      for (var x = step; x < size.width; x += step) {
        dots.add(Offset(x, y));
      }
    }
    canvas.drawPoints(
      ui.PointMode.points,
      dots,
      Paint()
        ..strokeWidth = 1
        ..color = CheHud.ice.withValues(alpha: 0.06),
    );
    // Light pooled along the bottom edge.
    final pool = Rect.fromLTWH(0, size.height - math.min(28, size.height * 0.5), size.width, math.min(28, size.height * 0.5));
    canvas.drawRect(
      pool,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.bottomCenter,
          end: Alignment.topCenter,
          colors: [light.withValues(alpha: 0.18), light.withValues(alpha: 0)],
        ).createShader(pool),
    );
    // One diagonal streak of light across the pane.
    final streak = Path()
      ..moveTo(size.width * 0.18, 0)
      ..lineTo(size.width * 0.34, 0)
      ..lineTo(size.width * 0.34 - size.height * 0.7, size.height)
      ..lineTo(size.width * 0.18 - size.height * 0.7, size.height)
      ..close();
    canvas.drawPath(
      streak,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.white.withValues(alpha: 0.07), Colors.white.withValues(alpha: 0)],
        ).createShader(rect),
    );
  }

  @override
  bool shouldRepaint(_GlassFillPainter old) => old.cut != cut || old.light != light;
}

class _GlassPainter extends CustomPainter {
  _GlassPainter({required this.cut, required this.light, this.glow});

  final double cut;
  final Color light;
  final Color? glow;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final plate = cheHudPlate(rect.deflate(0.5), cut);
    // A panel's own colour glows just inside its edge.
    if (glow != null) {
      canvas.save();
      canvas.clipPath(plate);
      canvas.drawPath(
        plate,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 6
          ..color = glow!.withValues(alpha: 0.45)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
      );
      canvas.restore();
    }
    // The iridescent edge: ice, violet, mint and white sweeping round the plate like thin-film light.
    canvas.drawPath(
      plate,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..shader = SweepGradient(
          center: Alignment.center,
          colors: [
            Colors.white.withValues(alpha: 0.85),
            CheHud.ice.withValues(alpha: 0.55),
            CheHud.lilac.withValues(alpha: 0.65),
            CheHud.iceDeep.withValues(alpha: 0.20),
            CheHud.mint.withValues(alpha: 0.45),
            Colors.white.withValues(alpha: 0.85),
          ],
        ).createShader(rect),
    );
    if (cut <= 0 || size.width < 60 || size.height < 28) return;
    final pill = cut >= size.height * 0.4;
    final big = pill ? size.height * 0.42 : math.min(cut * 0.75, math.min(size.width, size.height) * 0.3);
    final accent = glow ?? CheHud.ice;
    final bright = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.square
      ..strokeWidth = 2
      ..color = accent.withValues(alpha: 0.95)
      ..maskFilter = const MaskFilter.blur(BlurStyle.solid, 2.5);
    if (pill) {
      // Bright light on the two pointed ends.
      final mid = size.height / 2;
      canvas.drawPath(Path()..moveTo(big * 0.55, mid - big * 0.45)..lineTo(1, mid)..lineTo(big * 0.55, mid + big * 0.45), bright);
      canvas.drawPath(
          Path()
            ..moveTo(size.width - big * 0.55, mid - big * 0.45)
            ..lineTo(size.width - 1, mid)
            ..lineTo(size.width - big * 0.55, mid + big * 0.45),
          bright);
      return;
    }
    // Light along the two deep cuts, and a short accent bar running on from each.
    canvas.drawLine(Offset(1, big), Offset(big, 1), bright);
    canvas.drawLine(Offset(big, 1), Offset(big + math.min(42, size.width * 0.22), 1), bright);
    canvas.drawLine(Offset(size.width - 1, size.height - big), Offset(size.width - big, size.height - 1), bright);
    canvas.drawLine(
        Offset(size.width - big, size.height - 1), Offset(size.width - big - math.min(42, size.width * 0.22), size.height - 1), bright);
    // Edge data ticks: five marks along the top right, the first one lit.
    if (size.width >= 140) {
      final tick = Paint()..strokeWidth = 1.2;
      for (var i = 0; i < 5; i++) {
        final x = size.width - big * 0.4 - 14 - i * 6.0;
        tick.color = (i == 0 ? accent : CheHud.ice).withValues(alpha: i == 0 ? 0.95 : 0.35);
        canvas.drawLine(Offset(x, 4), Offset(x, 8), tick);
      }
    }
    // A thin vertical rail down the left side, as on an instrument panel.
    if (size.height >= 70) {
      canvas.drawLine(
        Offset(3.5, big + 8),
        Offset(3.5, math.min(big + 8 + size.height * 0.3, size.height - 12)),
        Paint()
          ..strokeWidth = 1
          ..color = accent.withValues(alpha: 0.45),
      );
    }
  }

  @override
  bool shouldRepaint(_GlassPainter old) => old.cut != cut || old.light != light || old.glow != glow;
}

/// Text in holographic chrome: white light at the top, cooling through ice to a violet edge. The text itself is
/// ordinary [Text], so VoiceOver and Dynamic Type read it as usual.
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
        style: style.copyWith(
          color: Colors.white,
          // Wide-tracked, lighter display lettering.
          letterSpacing: (style.letterSpacing ?? 0) + (style.fontSize ?? 14) * 0.04,
        ),
      ),
    );
  }
}

/// A holographic lens, used for the main voice control: a dark glass core, an iridescent ring and light from within.
/// [color] lights the ring (ice, or red while listening).
class CheChromeOrb extends StatelessWidget {
  const CheChromeOrb({super.key, required this.size, required this.child, this.color = CheHud.ice});

  final double size;
  final Widget child;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _LensPainter(color),
        child: Center(child: child),
      ),
    );
  }
}

class _LensPainter extends CustomPainter {
  _LensPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2;
    canvas.drawCircle(c, r, Paint()
      ..color = color.withValues(alpha: 0.55)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 12));
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(
          center: const Alignment(0, 0.35),
          colors: [color.withValues(alpha: 0.55), const Color(0xFF10233F), const Color(0xFF050A16)],
          stops: const [0.0, 0.62, 1.0],
        ).createShader(Rect.fromCircle(center: c, radius: r)),
    );
    final ring = Rect.fromCircle(center: c, radius: r - 1.5);
    canvas.drawCircle(
      c,
      r - 1.5,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..shader = SweepGradient(colors: [Colors.white, color, CheHud.lilac, CheHud.mint, Colors.white]).createShader(ring),
    );
    canvas.drawCircle(
      c,
      r * 0.72,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = color.withValues(alpha: 0.5),
    );
    // A crescent of reflected light across the top of the lens.
    final top = Rect.fromCircle(center: c, radius: r * 0.84);
    canvas.drawArc(
      top,
      math.pi * 1.15,
      math.pi * 0.7,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 2
        ..color = Colors.white.withValues(alpha: 0.55),
    );
  }

  @override
  bool shouldRepaint(_LensPainter old) => old.color != color;
}

/// The HUD reactor around CHE: two tilted gyroscope rings, a segmented data ring, a tick scale, a hexagonal frame,
/// spectral arcs and a radar sweep, in [color]. [t] (0..1) turns the arcs and the sweep; [active] adds the outward
/// pulse. Static when [t] stays 0.
class CheHudReactorPainter extends CustomPainter {
  CheHudReactorPainter({required this.color, required this.t, required this.active});

  final Color color;
  final double t;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2;
    double rad(double deg) => deg * math.pi / 180;
    final spin = t * 2 * math.pi;
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
    // Gyroscope: two thin rings seen at an angle, crossing behind CHE.
    for (final (tilt, a) in [(rad(-28), 0.55), (rad(32), 0.40)]) {
      canvas.save();
      canvas.translate(c.dx, c.dy);
      canvas.rotate(tilt + spin * 0.15);
      final oval = Rect.fromCenter(center: Offset.zero, width: r * 2.0, height: r * 0.62);
      canvas.drawOval(
        oval,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..shader = SweepGradient(colors: [
            CheHud.ice.withValues(alpha: a),
            CheHud.lilac.withValues(alpha: a * 0.6),
            CheHud.ice.withValues(alpha: 0.05),
            CheHud.ice.withValues(alpha: a),
          ]).createShader(oval),
      );
      canvas.drawCircle(Offset(r, 0), 2.4, Paint()..color = Colors.white.withValues(alpha: 0.9));
      canvas.restore();
    }
    // Segmented data ring: 24 segments, a few of them lit.
    final segR = Rect.fromCircle(center: c, radius: r * 0.985);
    final seg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.2;
    for (var i = 0; i < 24; i++) {
      final lit = i % 6 == 0 || i == 7 || i == 8 || i == 15;
      seg.color = (lit ? color : CheHud.ice).withValues(alpha: lit ? 0.9 : 0.16);
      canvas.drawArc(segR, rad(i * 15.0 + 1.5) - spin * 0.25, rad(11), false, seg);
    }
    // Tick scale: 120 ticks, every tenth long.
    final tick = Paint()..strokeCap = StrokeCap.round;
    for (var i = 0; i < 120; i++) {
      final a = i * 3 * math.pi / 180;
      final long = i % 10 == 0;
      final r1 = r * 0.94, r2 = r * (long ? 0.875 : 0.91);
      tick
        ..strokeWidth = long ? 1.6 : 0.9
        ..color = CheHud.ice.withValues(alpha: long ? 0.85 : 0.3);
      canvas.drawLine(c + Offset(math.cos(a), math.sin(a)) * r1, c + Offset(math.cos(a), math.sin(a)) * r2, tick);
    }
    // Radar sweep: a fading wedge of light turning with t.
    final sweepRect = Rect.fromCircle(center: c, radius: r * 0.8);
    canvas.drawCircle(
      c,
      r * 0.8,
      Paint()
        ..shader = SweepGradient(
          colors: [color.withValues(alpha: 0), color.withValues(alpha: 0), color.withValues(alpha: 0.22)],
          stops: const [0.0, 0.82, 1.0],
          transform: GradientRotation(spin - math.pi / 2),
        ).createShader(sweepRect),
    );
    // Hexagonal frame.
    final hex = Path();
    for (var i = 0; i < 6; i++) {
      final a = rad(i * 60.0 - 90);
      final p = c + Offset(math.cos(a), math.sin(a)) * (r * 0.84);
      i == 0 ? hex.moveTo(p.dx, p.dy) : hex.lineTo(p.dx, p.dy);
    }
    hex.close();
    canvas.drawPath(
      hex,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = CheHud.ice.withValues(alpha: 0.28),
    );
    // The main ring: a thin bright line with an iridescent sheen.
    final ring = Rect.fromCircle(center: c, radius: r * 0.8);
    canvas.drawCircle(
      c,
      r * 0.8,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..shader = SweepGradient(
          colors: [Colors.white, CheHud.ice, CheHud.lilac, Colors.white, CheHud.mint, Colors.white],
          transform: GradientRotation(-spin * 0.5),
        ).createShader(ring),
    );
    canvas.drawCircle(
      c,
      r * 0.8,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..color = color.withValues(alpha: 0.35)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
    );
    // Spectral arcs on the outer track, turning with t.
    final track = Rect.fromCircle(center: c, radius: r * 0.86);
    final arc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.butt
      ..strokeWidth = 2.5;
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
    canvas.drawCircle(c + Offset(math.cos(node), math.sin(node)) * (r * 0.86), 3.5, Paint()..color = const Color(0xFFE9FBFF));
    // Dashed inner ring, turning the other way.
    final inner = Rect.fromCircle(center: c, radius: r * 0.72);
    final dash = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = CheHud.ice.withValues(alpha: 0.55);
    for (var i = 0; i < 40; i++) {
      final a0 = rad(-80) - spin * 0.5 + i * rad(7);
      canvas.drawArc(inner, a0, rad(2), false, dash);
    }
    // Angled outer brackets left and right.
    final outer = Rect.fromCircle(center: c, radius: r * 1.02);
    final bracket = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..color = Colors.white.withValues(alpha: 0.75);
    canvas.drawArc(outer, rad(160), rad(40), false, bracket);
    canvas.drawArc(outer, rad(-20), rad(40), false, bracket);
    if (active) {
      final waveR = r * 0.8 + r * 0.2 * t;
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

/// Every page in the HUD look carries the HUD backdrop (owner, 2026-10-22: the style "for all her rooms"). The backdrop
/// is part of the page, so the iOS slide between two rooms stays clean, and rooms with a clear background show it.
class CheHudPageTransitionsBuilder extends PageTransitionsBuilder {
  const CheHudPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) =>
      const CupertinoPageTransitionsBuilder().buildTransitions(route, context, animation, secondaryAnimation, CheHudBackdrop(floor: 0.6, child: child));
}
