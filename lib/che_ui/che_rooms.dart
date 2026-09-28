// CHE World — live, animated room environments drawn in code (no photos
// shipped). Each room takes its mood from the owner's reference photos:
//   studio     → neon red/cyan production studio: monitors, mixing desk, waveform
//   office     → bright premium office: skyline windows, ceiling panels, desks
//   conference → glass war room: panes with moving reflections, glowing screen
//   brain      → knowledge lab: drifting neural network with travelling pulses
//   markets    → trading desk: live candlesticks on a dark grid + ticker
//   art        → warm artist studio: gallery wall of canvases, lamp glow
//   core       → CHE's own teal command space (default)
// 2.5D, lightweight and 60fps on iPhone; honors Reduce Motion (static frame).

import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'che_theme.dart';

enum CheRoom { core, studio, office, conference, brain, markets, art }

extension CheRoomInfo on CheRoom {
  String get title => switch (this) {
        CheRoom.core => 'CHE Core',
        CheRoom.studio => 'Creator Studio',
        CheRoom.office => 'CHE Office',
        CheRoom.conference => 'War Room',
        CheRoom.brain => 'Brain Lab',
        CheRoom.markets => 'Markets Desk',
        CheRoom.art => 'Art Studio',
      };

  /// Accent used for glows / section chips in this room.
  Color get accent => switch (this) {
        CheRoom.core => CheColors.accent,
        CheRoom.studio => const Color(0xFFFF4D6D),
        CheRoom.office => const Color(0xFF8FB8FF),
        CheRoom.conference => const Color(0xFFE8B04A),
        CheRoom.brain => const Color(0xFF5CC8FF),
        CheRoom.markets => const Color(0xFF3DDC97),
        CheRoom.art => const Color(0xFFFF9F5A),
      };
}

/// Full-bleed animated backdrop for a room. Put content on top of it; a
/// bottom scrim keeps text readable.
class CheRoomBackdrop extends StatefulWidget {
  const CheRoomBackdrop({super.key, required this.room, this.scrim = 0.55, this.child});
  final CheRoom room;

  /// 0 = raw scene, 1 = almost black. Use ~0.55 behind page content and ~0.2
  /// for hero cards.
  final double scrim;
  final Widget? child;

  @override
  State<CheRoomBackdrop> createState() => _CheRoomBackdropState();
}

class _CheRoomBackdropState extends State<CheRoomBackdrop> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 24));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (CheMotion.reduced(context)) {
      _c.stop();
      _c.value = 0.3;
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
    return Stack(fit: StackFit.expand, children: [
      RepaintBoundary(
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, __) => CustomPaint(painter: _painterFor(widget.room, _c.value)),
        ),
      ),
      IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Colors.black.withOpacity(widget.scrim * 0.35),
                Colors.black.withOpacity(widget.scrim * 0.75),
                Colors.black.withOpacity(math.min(1, widget.scrim * 1.25)),
              ],
              stops: const [0.0, 0.45, 1.0],
            ),
          ),
        ),
      ),
      if (widget.child != null) widget.child!,
    ]);
  }
}

CustomPainter _painterFor(CheRoom room, double t) => switch (room) {
      CheRoom.core => _CorePainter(t),
      CheRoom.studio => _StudioPainter(t),
      CheRoom.office => _OfficePainter(t),
      CheRoom.conference => _ConferencePainter(t),
      CheRoom.brain => _BrainPainter(t),
      CheRoom.markets => _MarketsPainter(t),
      CheRoom.art => _ArtPainter(t),
    };

double _wave(double t, double speed, [double phase = 0]) => math.sin((t * speed + phase) * math.pi * 2);

Paint _glow(Color c, double blur) => Paint()
  ..color = c
  ..maskFilter = MaskFilter.blur(BlurStyle.normal, blur);

// ─── Core: teal perspective floor + floating particles ─────────────────────
class _CorePainter extends CustomPainter {
  _CorePainter(this.t);
  final double t;
  @override
  void paint(Canvas canvas, Size s) {
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF02100E), Color(0xFF041A17), Color(0xFF010605)],
          ).createShader(Offset.zero & s));
    final horizon = s.height * 0.55;
    final vp = Offset(s.width / 2, horizon);
    final line = Paint()
      ..color = CheColors.accent.withOpacity(0.22)
      ..strokeWidth = 1;
    for (var i = -10; i <= 10; i++) {
      canvas.drawLine(vp, Offset(s.width / 2 + i * s.width * 0.18, s.height), line);
    }
    for (var i = 0; i < 12; i++) {
      final f = ((i / 12) + t * 0.5) % 1.0;
      final y = horizon + (s.height - horizon) * f * f;
      canvas.drawLine(Offset(0, y), Offset(s.width, y), line..color = CheColors.accent.withOpacity(0.08 + 0.25 * f));
    }
    canvas.drawCircle(vp, s.width * 0.35, _glow(CheColors.accent.withOpacity(0.18), 60));
    final rnd = math.Random(7);
    for (var i = 0; i < 40; i++) {
      final x = rnd.nextDouble() * s.width;
      final y = (rnd.nextDouble() * horizon - t * horizon * (0.3 + rnd.nextDouble())) % horizon;
      canvas.drawCircle(Offset(x, y), 1 + rnd.nextDouble() * 1.5,
          Paint()..color = CheColors.accent.withOpacity(0.25 + 0.4 * rnd.nextDouble()));
    }
  }

  @override
  bool shouldRepaint(covariant _CorePainter o) => o.t != t;
}

// ─── Studio: neon production room ──────────────────────────────────────────
class _StudioPainter extends CustomPainter {
  _StudioPainter(this.t);
  final double t;
  static const red = Color(0xFFFF3B5C);
  static const cyan = Color(0xFF3FE6FF);

  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1A0508), Color(0xFF2A0A10), Color(0xFF0A0204)],
          ).createShader(Offset.zero & s));
    // back wall + neon rim (room perspective)
    final back = Rect.fromLTWH(w * 0.22, h * 0.12, w * 0.56, h * 0.46);
    canvas.drawRect(back, Paint()..color = const Color(0xFF3A0C14));
    final rim = Paint()
      ..color = cyan.withOpacity(0.55)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawLine(Offset(0, 0), back.topLeft, rim);
    canvas.drawLine(Offset(w, 0), back.topRight, rim);
    canvas.drawLine(back.topLeft, back.topRight, rim..color = cyan.withOpacity(0.35));
    canvas.drawLine(back.topLeft, back.topRight, _glow(cyan.withOpacity(0.5), 8)..strokeWidth = 3);
    // booth window glow
    final win = Rect.fromLTWH(back.left + back.width * 0.3, back.top + back.height * 0.2, back.width * 0.4, back.height * 0.55);
    canvas.drawRect(win, Paint()..color = const Color(0xFF52210F));
    canvas.drawRect(win, _glow(const Color(0xFFFF8A3D).withOpacity(0.35), 20));
    canvas.drawRect(win, Paint()
      ..color = red.withOpacity(0.8)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5);
    // big wall speakers left / right with a gentle "breathing" cone
    final beat = 0.5 + 0.5 * _wave(t, 24);
    for (final left in [true, false]) {
      final r = Rect.fromLTWH(left ? w * 0.02 : w * 0.80, h * 0.14, w * 0.18, h * 0.34);
      canvas.drawRRect(RRect.fromRectAndRadius(r, const Radius.circular(4)), Paint()..color = const Color(0xFF6B1420));
      canvas.drawRRect(RRect.fromRectAndRadius(r, const Radius.circular(4)), _glow(red.withOpacity(0.35), 14));
      for (final cy in [0.3, 0.7]) {
        final c = Offset(r.center.dx, r.top + r.height * cy);
        canvas.drawCircle(c, r.width * (0.26 + 0.015 * beat), Paint()..color = const Color(0xFF16060A));
        canvas.drawCircle(c, r.width * 0.09, Paint()..color = const Color(0xFF2B0B11));
      }
    }
    // waveform across the booth window
    final wave = Path();
    for (var x = 0.0; x <= win.width; x += 3) {
      final k = x / win.width;
      final y = win.center.dy + math.sin(k * 18 + t * math.pi * 2 * 6) * win.height * 0.18 * math.sin(k * math.pi);
      x == 0 ? wave.moveTo(win.left + x, y) : wave.lineTo(win.left + x, y);
    }
    canvas.drawPath(wave, Paint()
      ..color = cyan
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5);
    // mixing desk with faders + LED meters
    final desk = Path()
      ..moveTo(0, h * 0.72)
      ..lineTo(w, h * 0.72)
      ..lineTo(w, h * 0.86)
      ..lineTo(0, h * 0.86)
      ..close();
    canvas.drawPath(desk, Paint()..color = const Color(0xFFD9D4D6).withOpacity(0.18));
    canvas.drawLine(Offset(0, h * 0.72), Offset(w, h * 0.72), _glow(cyan.withOpacity(0.7), 6)..strokeWidth = 2);
    const faders = 22;
    for (var i = 0; i < faders; i++) {
      final x = w * (0.04 + 0.92 * i / (faders - 1));
      final lvl = 0.35 + 0.35 * (0.5 + 0.5 * _wave(t, 8 + i % 5, i * 0.17));
      canvas.drawLine(Offset(x, h * 0.84), Offset(x, h * 0.84 - h * 0.1 * lvl), Paint()
        ..strokeWidth = 3
        ..color = (lvl > 0.62 ? red : cyan).withOpacity(0.85));
    }
    canvas.drawRect(Rect.fromLTWH(0, h * 0.86, w, h * 0.14), Paint()..color = const Color(0xFF060203));
  }

  @override
  bool shouldRepaint(covariant _StudioPainter o) => o.t != t;
}

// ─── Office: bright premium office with skyline ─────────────────────────────
class _OfficePainter extends CustomPainter {
  _OfficePainter(this.t);
  final double t;
  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    // sky
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF9CC3E6), Color(0xFFD6E6F2), Color(0xFFE9E4DA)],
            stops: [0, 0.55, 1],
          ).createShader(Offset.zero & s));
    // skyline silhouettes (slow parallax)
    final rnd = math.Random(3);
    final shift = t * w * 0.08;
    for (var i = 0; i < 26; i++) {
      final bw = w * (0.04 + rnd.nextDouble() * 0.07);
      final bh = h * (0.10 + rnd.nextDouble() * 0.28) * (i == 11 ? 1.6 : 1);
      final x = ((i * w * 0.06 - shift) % (w * 1.4)) - w * 0.1;
      canvas.drawRect(Rect.fromLTWH(x, h * 0.62 - bh, bw, bh),
          Paint()..color = Color.lerp(const Color(0xFF7F97B0), const Color(0xFFB9C9D8), rnd.nextDouble())!);
    }
    // window mullions
    final mull = Paint()..color = const Color(0xFFF4F1EC);
    for (var i = 0; i <= 8; i++) {
      canvas.drawRect(Rect.fromLTWH(w * i / 8 - 2, h * 0.14, 4, h * 0.5), mull);
    }
    // ceiling with acoustic panels + recessed lights
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h * 0.14), Paint()..color = const Color(0xFFEDEAE4));
    for (var i = 0; i < 4; i++) {
      final y = h * (0.015 + i * 0.03);
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(w * (0.05 + i * 0.03), y, w * (0.35 - i * 0.03), h * 0.018), const Radius.circular(2)),
          Paint()..color = const Color(0xFFC9C5BE));
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(w * (0.60), y, w * (0.35 - i * 0.03), h * 0.018), const Radius.circular(2)),
          Paint()..color = const Color(0xFFC9C5BE));
    }
    // floor
    canvas.drawRect(Rect.fromLTWH(0, h * 0.64, w, h * 0.36), Paint()..color = const Color(0xFFE5E1DA));
    // phone booths
    for (final bx in [0.08, 0.56]) {
      final r = Rect.fromLTWH(w * bx, h * 0.34, w * 0.2, h * 0.36);
      canvas.drawRect(r, Paint()..color = const Color(0xFFC8A77E));
      canvas.drawRect(r.deflate(w * 0.015), Paint()..color = const Color(0xFF6E8398).withOpacity(0.85));
    }
    // desks + chairs
    final desk = Paint()..color = const Color(0xFFD2AF7F);
    for (final dx in [0.02, 0.60]) {
      canvas.drawRect(Rect.fromLTWH(w * dx, h * 0.74, w * 0.36, h * 0.03), desk);
      for (var c = 0; c < 3; c++) {
        canvas.drawRRect(
            RRect.fromRectAndRadius(Rect.fromLTWH(w * (dx + 0.03 + c * 0.11), h * 0.77, w * 0.06, h * 0.07), const Radius.circular(4)),
            Paint()..color = const Color(0xFF7D8F76));
      }
    }
    // plants
    for (final px in [0.44, 0.93]) {
      final base = Offset(w * px, h * 0.72);
      for (var l = 0; l < 7; l++) {
        final a = -math.pi / 2 + (l - 3) * 0.35 + 0.05 * _wave(t, 3, l * 0.2);
        canvas.drawLine(base, base + Offset(math.cos(a), math.sin(a)) * h * 0.12,
            Paint()
              ..color = const Color(0xFF3F7D4E)
              ..strokeWidth = 5
              ..strokeCap = StrokeCap.round);
      }
    }
    // sunlight sweep
    final sx = w * (-0.3 + 1.6 * ((t * 2) % 1.0));
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = LinearGradient(colors: [
            Colors.white.withOpacity(0),
            Colors.white.withOpacity(0.14),
            Colors.white.withOpacity(0),
          ], stops: const [0, 0.5, 1]).createShader(Rect.fromLTWH(sx - w * 0.2, 0, w * 0.4, h)));
  }

  @override
  bool shouldRepaint(covariant _OfficePainter o) => o.t != t;
}

// ─── Conference / war room: glass panes + meeting screen ────────────────────
class _ConferencePainter extends CustomPainter {
  _ConferencePainter(this.t);
  final double t;
  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1D2227), Color(0xFF2A3036), Color(0xFF15191C)],
          ).createShader(Offset.zero & s));
    // wall screen with 4 participant tiles
    final scr = Rect.fromLTWH(w * 0.08, h * 0.18, w * 0.34, h * 0.3);
    canvas.drawRect(scr, _glow(const Color(0xFF9FC4FF).withOpacity(0.35), 18));
    canvas.drawRect(scr, Paint()..color = const Color(0xFFDDE6F0));
    for (var i = 0; i < 4; i++) {
      final tile = Rect.fromLTWH(scr.left + 6 + (i % 2) * (scr.width / 2 - 3), scr.top + 6 + (i ~/ 2) * (scr.height / 2 - 3),
          scr.width / 2 - 9, scr.height / 2 - 9);
      canvas.drawRect(tile, Paint()..color = Color.lerp(const Color(0xFF8A9BB0), const Color(0xFFC4B5A5), i / 3)!);
      final speaking = ((t * 8).floor() % 4) == i;
      if (speaking) {
        canvas.drawRect(tile, Paint()
          ..color = const Color(0xFF3DDC97)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2);
      }
      canvas.drawCircle(tile.center.translate(0, -tile.height * 0.05), tile.height * 0.2, Paint()..color = const Color(0xFF4A3B32));
    }
    // table + amber chairs
    final table = Path()
      ..moveTo(w * 0.35, h * 0.62)
      ..lineTo(w * 0.98, h * 0.58)
      ..lineTo(w * 1.0, h * 0.70)
      ..lineTo(w * 0.40, h * 0.74)
      ..close();
    canvas.drawPath(table, Paint()..color = const Color(0xFFE9E7E2));
    for (var i = 0; i < 4; i++) {
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(w * (0.40 + i * 0.15), h * 0.72, w * 0.1, h * 0.08), const Radius.circular(6)),
          Paint()..color = const Color(0xFFD9A441));
    }
    // glass panes with sliding reflections
    for (var i = 0; i < 4; i++) {
      final x = w * (i / 4);
      canvas.drawLine(Offset(x, 0), Offset(x, h), Paint()
        ..color = Colors.white.withOpacity(0.18)
        ..strokeWidth = 2);
      final rx = x + ((t * 1.5 + i * 0.27) % 1.0) * w / 4;
      canvas.drawRect(
          Rect.fromLTWH(rx - 20, 0, 40, h),
          Paint()
            ..shader = LinearGradient(colors: [
              Colors.white.withOpacity(0),
              Colors.white.withOpacity(0.07),
              Colors.white.withOpacity(0),
            ]).createShader(Rect.fromLTWH(rx - 20, 0, 40, h)));
    }
    canvas.drawRect(Offset.zero & s, Paint()..color = const Color(0xFF7FA0B8).withOpacity(0.06));
  }

  @override
  bool shouldRepaint(covariant _ConferencePainter o) => o.t != t;
}

// ─── Brain lab: drifting neural network with pulses ─────────────────────────
class _BrainPainter extends CustomPainter {
  _BrainPainter(this.t);
  final double t;
  static const blue = Color(0xFF5CC8FF);

  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const RadialGradient(
            center: Alignment(0, -0.2),
            radius: 1.1,
            colors: [Color(0xFF0B2138), Color(0xFF040B16), Color(0xFF01040A)],
          ).createShader(Offset.zero & s));
    final rnd = math.Random(11);
    const n = 46;
    final pts = <Offset>[];
    for (var i = 0; i < n; i++) {
      // nodes arranged in a loose brain-like ellipse
      final a = rnd.nextDouble() * math.pi * 2;
      final r = math.sqrt(rnd.nextDouble());
      final cx = w * 0.5 + math.cos(a) * r * w * 0.42;
      final cy = h * 0.38 + math.sin(a) * r * h * 0.28;
      pts.add(Offset(cx + 6 * _wave(t, 2, i * 0.37), cy + 6 * _wave(t, 3, i * 0.21)));
    }
    final edge = Paint()..strokeWidth = 0.8;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        final d = (pts[i] - pts[j]).distance;
        if (d > w * 0.2) continue;
        final o = (1 - d / (w * 0.2)) * 0.5;
        canvas.drawLine(pts[i], pts[j], edge..color = blue.withOpacity(o));
        if ((i + j) % 5 == 0) {
          final p = ((t * 3 + i * 0.11) % 1.0);
          canvas.drawCircle(Offset.lerp(pts[i], pts[j], p)!, 1.8, Paint()..color = Colors.white.withOpacity(0.9));
        }
      }
    }
    for (var i = 0; i < n; i++) {
      final fire = 0.5 + 0.5 * _wave(t, 4, i * 0.13);
      canvas.drawCircle(pts[i], 5 + 5 * fire, _glow(blue.withOpacity(0.35 * fire), 8));
      canvas.drawCircle(pts[i], 1.8 + fire, Paint()..color = Colors.white.withOpacity(0.7 + 0.3 * fire));
    }
    // "lightning" arc that roams across the network
    final k = ((t * 5) % 1.0);
    final a = pts[(k * n).floor() % n], b = pts[((k * n).floor() + 17) % n];
    final path = Path()..moveTo(a.dx, a.dy);
    for (var i = 1; i <= 6; i++) {
      final p = Offset.lerp(a, b, i / 6)!;
      path.lineTo(p.dx + (rnd.nextDouble() - 0.5) * 14, p.dy + (rnd.nextDouble() - 0.5) * 14);
    }
    canvas.drawPath(path, _glow(Colors.white.withOpacity(0.6 * (1 - k)), 3)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5);
  }

  @override
  bool shouldRepaint(covariant _BrainPainter o) => o.t != t;
}

// ─── Markets desk: live candlesticks ───────────────────────────────────────
class _MarketsPainter extends CustomPainter {
  _MarketsPainter(this.t);
  final double t;
  static const up = Color(0xFF3DDC97);
  static const down = Color(0xFFFF4D5E);

  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    canvas.drawRect(Offset.zero & s, Paint()..color = const Color(0xFF020406));
    final grid = Paint()
      ..color = const Color(0xFF1B2A33)
      ..strokeWidth = 0.7;
    for (var i = 0; i < 10; i++) {
      canvas.drawLine(Offset(0, h * i / 10), Offset(w, h * i / 10), grid);
      canvas.drawLine(Offset(w * i / 10, 0), Offset(w * i / 10, h), grid);
    }
    const count = 60;
    final cw = w / 34;
    final scroll = t * count;
    final base = h * 0.45;
    double price(double i) =>
        base + math.sin(i * 0.23) * h * 0.12 + math.sin(i * 0.071) * h * 0.1 + math.sin(i * 1.7) * h * 0.02;
    final path = Path();
    for (var k = 0; k < 36; k++) {
      final i = k + scroll.floor();
      final x = k * cw - (scroll % 1) * cw;
      final o = price(i.toDouble()), c = price(i + 1.0);
      final hi = math.min(o, c) - h * 0.02 * (1 + math.sin(i * 3.1).abs());
      final lo = math.max(o, c) + h * 0.02 * (1 + math.cos(i * 2.3).abs());
      final col = c < o ? up : down; // y grows downward → lower y is higher price
      canvas.drawLine(Offset(x + cw / 2, hi), Offset(x + cw / 2, lo), Paint()
        ..color = col.withOpacity(0.8)
        ..strokeWidth = 1);
      canvas.drawRect(Rect.fromLTRB(x + cw * 0.2, math.min(o, c), x + cw * 0.8, math.max(o, c) + 1), Paint()..color = col);
      final vwap = (o + c) / 2 + h * 0.05;
      k == 0 ? path.moveTo(x, vwap) : path.lineTo(x, vwap);
    }
    canvas.drawPath(path, Paint()
      ..color = const Color(0xFF7CC4FF).withOpacity(0.7)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4);
    // arrows
    final pulse = 0.5 + 0.5 * _wave(t, 6);
    void arrow(Offset c, bool isUp) {
      final p = Path();
      final d = isUp ? -1 : 1;
      p.moveTo(c.dx, c.dy + d * 14);
      p.lineTo(c.dx - 12, c.dy - d * 8);
      p.lineTo(c.dx + 12, c.dy - d * 8);
      p.close();
      final col = isUp ? up : down;
      canvas.drawPath(p, _glow(col.withOpacity(0.5 * pulse), 10));
      canvas.drawPath(p, Paint()..color = col);
    }

    arrow(Offset(w * 0.2, h * 0.14), true);
    arrow(Offset(w * 0.66, h * 0.2), false);
    // ticker strip
    final ty = h * 0.86;
    canvas.drawRect(Rect.fromLTWH(0, ty, w, h * 0.06), Paint()..color = const Color(0xFF07131C));
    const syms = ['NQ', 'ES', 'BTC', 'SPY', 'QQQ', 'CL', 'GC', 'ETH', 'AAPL', 'NVDA'];
    final off = (t * w * 2) % (w * 2);
    for (var i = 0; i < syms.length * 2; i++) {
      final x = i * w * 0.22 - off;
      final chg = math.sin(i * 1.9 + t * 4) * 2.4;
      final tp = TextPainter(
        text: TextSpan(children: [
          TextSpan(text: '${syms[i % syms.length]} ', style: const TextStyle(color: Colors.white70, fontSize: 10, fontWeight: FontWeight.w700)),
          TextSpan(
              text: '${chg >= 0 ? '+' : ''}${chg.toStringAsFixed(2)}%',
              style: TextStyle(color: chg >= 0 ? up : down, fontSize: 10, fontWeight: FontWeight.w600)),
        ]),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(x, ty + (h * 0.06 - tp.height) / 2));
    }
  }

  @override
  bool shouldRepaint(covariant _MarketsPainter o) => o.t != t;
}

// ─── Art studio: warm gallery wall + lamp glow ──────────────────────────────
class _ArtPainter extends CustomPainter {
  _ArtPainter(this.t);
  final double t;
  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width, h = s.height;
    canvas.drawRect(
        Offset.zero & s,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFF1E3CF), Color(0xFFE4CFB3), Color(0xFF8C6A4A)],
          ).createShader(Offset.zero & s));
    const palette = [
      Color(0xFFD9483B), Color(0xFF1F4E79), Color(0xFF2E7D5B), Color(0xFFF2A541), Color(0xFF6B3FA0),
      Color(0xFF0E7C86), Color(0xFFE85D75), Color(0xFF334155), Color(0xFFB45309), Color(0xFF155E75),
    ];
    final rnd = math.Random(21);
    for (var i = 0; i < 26; i++) {
      final cw = w * (0.08 + rnd.nextDouble() * 0.1);
      final ch = cw * (0.6 + rnd.nextDouble() * 0.7);
      final x = rnd.nextDouble() * (w - cw);
      final y = h * 0.04 + rnd.nextDouble() * h * 0.5;
      final r = Rect.fromLTWH(x, y, cw, ch);
      final c1 = palette[rnd.nextInt(palette.length)];
      final c2 = palette[rnd.nextInt(palette.length)];
      final round = rnd.nextDouble() < 0.2;
      final paint = Paint()
        ..shader = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [c1, c2]).createShader(r);
      canvas.drawRect(r.inflate(2), Paint()..color = Colors.black.withOpacity(0.18));
      round ? canvas.drawOval(r, paint) : canvas.drawRect(r, paint);
      // horizon line like the sunset canvases
      canvas.drawLine(Offset(r.left, r.top + ch * 0.6), Offset(r.right, r.top + ch * 0.6),
          Paint()..color = Colors.white.withOpacity(0.25));
    }
    // shelf + desk
    canvas.drawRect(Rect.fromLTWH(w * 0.5, h * 0.52, w * 0.5, h * 0.015), Paint()..color = Colors.white.withOpacity(0.9));
    canvas.drawRect(Rect.fromLTWH(0, h * 0.72, w, h * 0.28), Paint()..color = const Color(0xFFF3EFE8));
    // pencil cups / paint tubes
    for (var i = 0; i < 9; i++) {
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(w * (0.52 + i * 0.045), h * 0.64, w * 0.025, h * 0.08), const Radius.circular(3)),
          Paint()..color = palette[i % palette.length]);
    }
    // warm lamp glow (gentle flicker)
    final flick = 0.85 + 0.15 * _wave(t, 9);
    final lamp = Offset(w * 0.2, h * 0.62);
    canvas.drawCircle(lamp, w * 0.45, _glow(const Color(0xFFFFB45A).withOpacity(0.35 * flick), 60));
    canvas.drawOval(Rect.fromCenter(center: lamp, width: w * 0.12, height: h * 0.1), Paint()..color = const Color(0xFFFFE1A8));
  }

  @override
  bool shouldRepaint(covariant _ArtPainter o) => o.t != t;
}
