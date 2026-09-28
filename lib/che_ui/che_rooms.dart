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
