// CHE World as a globe: each room (Brain, Trading, Office, …) is its own
// continent on a detailed, slowly turning planet. Drag to spin it; tap a
// continent to open that room. Pure CustomPainter (no assets): coastlines,
// cities, a lat/long grid and an atmosphere glow, all drawn per frame from
// fixed geometry, so it stays smooth on any iPhone.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

class CheContinent {
  CheContinent({required this.tab, required this.name, required this.color, required this.lat, required this.lon, required this.outline, required this.cities});
  final int tab;
  final String name;
  final Color color;
  final double lat, lon; // radians
  final List<List<double>> outline; // unit vectors
  final List<List<double>> cities;
}

List<double> _unit(double lat, double lon) => [math.cos(lat) * math.sin(lon), math.sin(lat), math.cos(lat) * math.cos(lon)];

/// Fixed, deterministic continents (same shape every launch).
List<CheContinent> cheBuildContinents(List<({int tab, String name, Color color})> rooms) {
  final out = <CheContinent>[];
  for (var i = 0; i < rooms.length; i++) {
    final r = rooms[i];
    final y = 1 - (i + .5) / rooms.length * 2;
    final lat = math.asin(y * .82);
    final lon = i * math.pi * (3 - math.sqrt(5));
    final rnd = math.Random(41 + i * 7);
    final size = .32 + rnd.nextDouble() * .12;
    final phase = rnd.nextDouble() * 6;
    final outline = <List<double>>[];
    const k = 48;
    for (var j = 0; j < k; j++) {
      final a = j / k * 2 * math.pi;
      // Ragged coastline: layered waves around the continent's center.
      final rr = size * (1 + .22 * math.sin(3 * a + phase) + .12 * math.sin(7 * a + phase * 2) + .06 * math.sin(13 * a + phase * 3));
      outline.add(_unit(lat + rr * math.sin(a), lon + rr * math.cos(a) / math.max(.35, math.cos(lat))));
    }
    final cities = [
      for (var j = 0; j < 7; j++)
        () {
          final a = rnd.nextDouble() * 2 * math.pi, d = rnd.nextDouble() * size * .6;
          return _unit(lat + d * math.sin(a), lon + d * math.cos(a) / math.max(.35, math.cos(lat)));
        }(),
    ];
    out.add(CheContinent(tab: r.tab, name: r.name, color: r.color, lat: lat, lon: lon, outline: outline, cities: cities));
  }
  return out;
}

class CheWorldGlobe extends StatefulWidget {
  const CheWorldGlobe({super.key, required this.continents, required this.onOpenTab});
  final List<CheContinent> continents;
  final void Function(int tab) onOpenTab;

  @override
  State<CheWorldGlobe> createState() => CheWorldGlobeState();
}

class CheWorldGlobeState extends State<CheWorldGlobe> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick)..start();
  final ValueNotifier<int> _frame = ValueNotifier<int>(0);
  double yaw = 0, pitch = .25;
  final double _spin = .12; // radians per second when idle
  double _vx = 0;
  Duration _last = Duration.zero;
  bool _dragging = false;
  Size _size = Size.zero;

  @override
  void dispose() {
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }

  void _tick(Duration t) {
    final dt = _last == Duration.zero ? 1 / 60 : (t - _last).inMicroseconds / 1e6;
    _last = t;
    if (!_dragging) {
      yaw += (_spin + _vx) * dt;
      _vx *= math.pow(.05, dt).toDouble();
    }
    _frame.value++;
  }

  /// Rotates so a continent faces the viewer.
  void face(CheContinent c) {
    yaw = -c.lon;
    pitch = c.lat.clamp(-1.1, 1.1);
    _vx = 0;
    _frame.value++;
  }

  CheContinent? hit(Offset at) {
    final g = CheGlobeGeometry(_size, yaw, pitch);
    CheContinent? best;
    var bestD = double.infinity;
    for (final c in widget.continents) {
      final p = g.project(_unit(c.lat, c.lon));
      if (p == null) continue;
      final d = (p - at).distance;
      if (d < g.radius * .38 && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      _size = constraints.biggest;
      return Semantics(
        label: 'CHE World globe. Continents: ${widget.continents.map((c) => c.name).join(', ')}. Use the room buttons below or tap a continent.',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onPanStart: (_) => _dragging = true,
          onPanUpdate: (d) {
            yaw += d.delta.dx * .008;
            pitch = (pitch + d.delta.dy * .006).clamp(-1.1, 1.1);
          },
          onPanEnd: (d) {
            _dragging = false;
            _vx = d.velocity.pixelsPerSecond.dx * .004;
          },
          onTapUp: (d) {
            final c = hit(d.localPosition);
            if (c == null) return;
            HapticFeedback.mediumImpact();
            face(c);
            widget.onOpenTab(c.tab);
          },
          child: CustomPaint(painter: _GlobePainter(this), size: Size.infinite),
        ),
      );
    });
  }
}

/// Orthographic globe projection for one frame.
class CheGlobeGeometry {
  CheGlobeGeometry(this.size, double yaw, double pitch)
      : radius = math.min(size.width, size.height) * .42,
        center = Offset(size.width / 2, size.height / 2),
        _cy = math.cos(yaw),
        _sy = math.sin(yaw),
        _cp = math.cos(pitch),
        _sp = math.sin(pitch);
  final Size size;
  final double radius;
  final Offset center;
  final double _cy, _sy, _cp, _sp;

  /// Rotated point (x right, y up, z toward viewer).
  List<double> rotate(List<double> v) {
    final x = v[0] * _cy + v[2] * _sy;
    final z0 = -v[0] * _sy + v[2] * _cy;
    final y = v[1] * _cp - z0 * _sp;
    final z = v[1] * _sp + z0 * _cp;
    return [x, y, z];
  }

  Offset? project(List<double> v, {bool clampToLimb = false}) {
    final r = rotate(v);
    if (r[2] < 0) {
      if (!clampToLimb) return null;
      final l = math.sqrt(r[0] * r[0] + r[1] * r[1]);
      if (l == 0) return null;
      return center + Offset(r[0] / l, -r[1] / l) * radius;
    }
    return center + Offset(r[0], -r[1]) * radius;
  }
}

class _GlobePainter extends CustomPainter {
  _GlobePainter(this.s) : super(repaint: s._frame);
  final CheWorldGlobeState s;
  static final Map<String, TextPainter> _labels = {};

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final g = CheGlobeGeometry(size, s.yaw, s.pitch);
    final c = g.center, r = g.radius;
    // Atmosphere and ocean.
    canvas.drawCircle(c, r * 1.12, Paint()..shader = RadialGradient(colors: [const Color(0x5539E6C5), const Color(0x0039E6C5)], stops: const [.82, 1]).createShader(Rect.fromCircle(center: c, radius: r * 1.12)));
    canvas.drawCircle(c, r, Paint()..shader = RadialGradient(center: const Alignment(-.35, -.4), colors: const [Color(0xFF0E3A44), Color(0xFF041418), Color(0xFF02080A)], stops: const [0, .7, 1]).createShader(Rect.fromCircle(center: c, radius: r)));
    // Lat/long grid.
    final grid = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = .6
      ..color = const Color(0x2239E6C5);
    for (var lat = -60; lat <= 60; lat += 30) {
      _line(canvas, g, [for (var lon = 0; lon <= 360; lon += 6) _unit(lat * math.pi / 180, lon * math.pi / 180)], grid);
    }
    for (var lon = 0; lon < 360; lon += 30) {
      _line(canvas, g, [for (var lat = -84; lat <= 84; lat += 6) _unit(lat * math.pi / 180, lon * math.pi / 180)], grid);
    }
    // Continents (back ones skipped; edges hug the limb).
    for (final k in s.widget.continents) {
      final centerRot = g.rotate(_unit(k.lat, k.lon));
      if (centerRot[2] < -.25) continue;
      final path = Path();
      for (var i = 0; i < k.outline.length; i++) {
        final p = g.project(k.outline[i], clampToLimb: true);
        if (p == null) continue;
        i == 0 ? path.moveTo(p.dx, p.dy) : path.lineTo(p.dx, p.dy);
      }
      path.close();
      final face = centerRot[2].clamp(0.0, 1.0);
      canvas.drawPath(path, Paint()..color = k.color.withValues(alpha: .22 + .35 * face));
      canvas.drawPath(path, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = k.color.withValues(alpha: .5 + .5 * face));
      for (final city in k.cities) {
        final p = g.project(city);
        if (p != null) canvas.drawCircle(p, 1.8, Paint()..color = Colors.white.withValues(alpha: .7 * face));
      }
      if (centerRot[2] > .3) {
        final p = g.project(_unit(k.lat, k.lon))!;
        final tp = _labels.putIfAbsent(k.name, () => TextPainter(
              text: TextSpan(text: k.name, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700, shadows: [Shadow(blurRadius: 6)])),
              textDirection: TextDirection.ltr,
            )..layout());
        tp.paint(canvas, p - Offset(tp.width / 2, tp.height / 2));
      }
    }
    // Rim light.
    canvas.drawCircle(c, r, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = const Color(0x8839E6C5));
  }

  void _line(Canvas canvas, CheGlobeGeometry g, List<List<double>> pts, Paint paint) {
    final path = Path();
    var pen = false;
    for (final v in pts) {
      final p = g.project(v);
      if (p == null) {
        pen = false;
        continue;
      }
      pen ? path.lineTo(p.dx, p.dy) : path.moveTo(p.dx, p.dy);
      pen = true;
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _GlobePainter old) => false;
}
