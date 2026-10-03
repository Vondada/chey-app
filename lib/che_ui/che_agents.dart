// CHE agents in the app: mini-person avatars for CHE and every Office agent,
// plus the Office floor where they sit at desks.
//
// The agents themselves run OUTSIDE the app (backend Agent Runtime, see the
// master prompt). The app only mirrors their REAL state from the backend:
// pass a live List<CheAgent> (e.g. from GET /agents or a WebSocket to the
// Durable Object). Never animate work that isn't happening.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_rooms.dart';
import 'che_theme.dart';
import 'che_ui_preferences.dart';

/// Real task states reported by the Agent Runtime.
enum CheAgentStatus { idle, researching, building, analyzing, meeting, waiting, reviewing, talking, done, offline }

extension CheAgentStatusLabel on CheAgentStatus {
  String get label => switch (this) {
        CheAgentStatus.idle => 'Idle',
        CheAgentStatus.researching => 'Researching',
        CheAgentStatus.building => 'Building',
        CheAgentStatus.analyzing => 'Analyzing',
        CheAgentStatus.meeting => 'In meeting',
        CheAgentStatus.waiting => 'Waiting',
        CheAgentStatus.reviewing => 'Reviewing',
        CheAgentStatus.talking => 'Talking',
        CheAgentStatus.done => 'Done',
        CheAgentStatus.offline => 'Offline',
      };

  static CheAgentStatus parse(String? s) =>
      CheAgentStatus.values.firstWhere((v) => v.name == s, orElse: () => CheAgentStatus.idle);
}

class CheAgent {
  const CheAgent({
    required this.id,
    required this.name,
    required this.role,
    this.specialty = '',
    this.personality = '',
    this.color = const Color(0xFF7C8CFF),
    this.hair = const Color(0xFF2B1D14),
    this.skin = const Color(0xFFC68B59),
    this.status = CheAgentStatus.idle,
    this.task,
    this.isChe = false,
    this.appearance = const {},
  });

  final String id;
  final String name;
  final String role;
  final String specialty;
  final String personality;
  final Color color; // outfit / accent
  final Color hair;
  final Color skin;
  final CheAgentStatus status;
  final String? task; // current real assignment
  final bool isChe;
  final Map<String, dynamic> appearance;

  /// CHE herself (Office Boss), in her logo colors.
  static CheAgent che({CheAgentStatus status = CheAgentStatus.idle, String? task}) => CheAgent(
        id: 'che',
        name: 'CHE',
        role: 'Office Boss',
        specialty: 'Office Boss — assigns, steers, reviews handoffs, owns outcomes, reports to the owner',
        color: CheColors.accent,
        hair: const Color(0xFF1A1110),
        skin: const Color(0xFFB9825A),
        status: status,
        task: task,
        isChe: true,
      );

  static CheAgent fromJson(Map<String, dynamic> j) {
    Color c(String? hex, Color d) {
      final h = (hex ?? '').replaceAll('#', '');
      final v = int.tryParse(h, radix: 16);
      return (h.length == 6 && v != null) ? Color(0xFF000000 | v) : d;
    }

    return CheAgent(
      id: j['id'].toString(),
      name: (j['name'] ?? 'Agent').toString(),
      role: (j['role'] ?? '').toString(),
      specialty: (j['specialty'] ?? '').toString(),
      personality: (j['personality'] ?? '').toString(),
      color: c(j['color']?.toString(), const Color(0xFF7C8CFF)),
      hair: c(j['hair']?.toString(), const Color(0xFF2B1D14)),
      skin: c(j['skin']?.toString(), const Color(0xFFC68B59)),
      status: CheAgentStatusLabel.parse(j['status']?.toString()),
      task: j['task']?.toString(),
      isChe: j['id'] == 'che',
      appearance: j['appearance'] is Map
          ? Map<String, dynamic>.from(j['appearance'] as Map)
          : const {},
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mini-person avatar
// ─────────────────────────────────────────────────────────────────────────

/// A little animated person. Pose follows the agent's REAL status:
/// typing (building), reading (researching/analyzing/reviewing), talking
/// (talking/meeting), thought dots (waiting), wave + check (done), dimmed
/// (offline), gentle breathe/blink (idle — honors Reduce Motion). CHE gets a
/// glowing halo.
class CheMiniPerson extends StatefulWidget {
  const CheMiniPerson({super.key, required this.agent, this.size = 64, this.showDesk = false});
  final CheAgent agent;
  final double size;
  final bool showDesk;
  @override
  State<CheMiniPerson> createState() => _CheMiniPersonState();
}

/// Statuses that mean an agent is actively working. These use a per-widget
/// AnimationController (usually 0–2 agents).
bool cheAgentIsMoving(CheAgentStatus status) => const {
      CheAgentStatus.researching,
      CheAgentStatus.building,
      CheAgentStatus.analyzing,
      CheAgentStatus.meeting,
      CheAgentStatus.reviewing,
      CheAgentStatus.talking,
    }.contains(status);

/// Soft idle life (breathe / blink / gentle wave). Offline stays frozen.
bool cheAgentHasIdleLife(CheAgentStatus status) =>
    status == CheAgentStatus.idle ||
    status == CheAgentStatus.waiting ||
    status == CheAgentStatus.done;

/// One shared ~10fps clock for every idle chibi. Avoids N×60fps controllers
/// freezing the home shell when the whole roster is breathing.
class CheIdleLifeClock extends ChangeNotifier with WidgetsBindingObserver {
  CheIdleLifeClock._() {
    WidgetsBinding.instance.addObserver(this);
  }
  static final CheIdleLifeClock instance = CheIdleLifeClock._();

  static const Duration _period = Duration(milliseconds: 120); // ~8 fps
  static const double _step = 0.033; // ~3.6s full breathe cycle

  Timer? _timer;
  int _retainers = 0;
  double t = 0.25;
  bool _appResumed = true;

  /// Stable 0..1 phase so neighbors don't breathe in lockstep.
  static double phaseFor(String id) => (id.hashCode.remainder(1000).abs()) / 1000.0;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appResumed = state == AppLifecycleState.resumed;
    if (_appResumed) {
      _ensureTimer();
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  void retain() {
    _retainers++;
    _ensureTimer();
  }

  void release() {
    if (_retainers <= 0) return;
    _retainers--;
    if (_retainers == 0) {
      _timer?.cancel();
      _timer = null;
    }
  }

  void _ensureTimer() {
    if (_retainers <= 0 || !_appResumed || _timer != null) return;
    _timer = Timer.periodic(_period, (_) {
      t = (t + _step) % 1.0;
      notifyListeners();
    });
  }
}

class _CheMiniPersonState extends State<CheMiniPerson> with SingleTickerProviderStateMixin {
  AnimationController? _work;
  bool _reduced = false;
  bool _depsReady = false;
  bool _holdingIdle = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduced = CheMotion.reduced(context);
    final first = !_depsReady;
    _depsReady = true;
    if (first || reduced != _reduced) {
      _reduced = reduced;
      _syncMotion();
    }
  }

  @override
  void didUpdateWidget(covariant CheMiniPerson oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.agent.status != widget.agent.status) _syncMotion();
  }

  void _releaseIdle() {
    if (!_holdingIdle) return;
    CheIdleLifeClock.instance.release();
    _holdingIdle = false;
  }

  void _holdIdle() {
    if (_holdingIdle) return;
    CheIdleLifeClock.instance.retain();
    _holdingIdle = true;
  }

  // Working = own 60fps pose loop (rare). Idle = shared 10fps clock.
  // Offline / Reduce Motion = static (no timers).
  void _syncMotion() {
    if (!_depsReady) return;
    final working = !_reduced && cheAgentIsMoving(widget.agent.status);
    final idleLife = !_reduced && cheAgentHasIdleLife(widget.agent.status);

    if (working) {
      _releaseIdle();
      _work ??= AnimationController(vsync: this, duration: const Duration(seconds: 2));
      if (!_work!.isAnimating) _work!.repeat();
      return;
    }

    _work?.stop();
    if (idleLife) {
      _holdIdle();
    } else {
      _releaseIdle();
    }
  }

  @override
  void dispose() {
    _releaseIdle();
    _work?.dispose();
    super.dispose();
  }

  static const String cheAvatarAsset = 'assets/avatars/che.png';

  Widget _paint(double t, {required bool portrait}) {
    if (portrait && widget.agent.isChe) {
      return _ChePortraitAvatar(
        agent: widget.agent,
        t: t,
        desk: widget.showDesk,
        size: widget.size,
      );
    }
    return CustomPaint(
      painter: _MiniPersonPainter(agent: widget.agent, t: t, desk: widget.showDesk),
    );
  }

  @override
  Widget build(BuildContext context) {
    final working = !_reduced && cheAgentIsMoving(widget.agent.status) && _work != null;
    final idleLife = !_reduced && _holdingIdle;
    final prefs = CheUiPreferences.instance;

    Widget bodyFor(double t, bool portrait) => _paint(t, portrait: portrait);

    late final Widget body;
    if (working) {
      body = ListenableBuilder(
        listenable: prefs,
        builder: (context, _) => AnimatedBuilder(
          animation: _work!,
          builder: (context, _) => bodyFor(_work!.value, prefs.avatarStyle == CheAvatarStyle.portrait),
        ),
      );
    } else if (idleLife) {
      body = ListenableBuilder(
        listenable: Listenable.merge([CheIdleLifeClock.instance, prefs]),
        builder: (context, _) {
          final portrait = prefs.avatarStyle == CheAvatarStyle.portrait;
          if (!TickerMode.valuesOf(context).enabled) return bodyFor(0.25, portrait);
          final phase = CheIdleLifeClock.phaseFor(widget.agent.id);
          return bodyFor((CheIdleLifeClock.instance.t + phase) % 1.0, portrait);
        },
      );
    } else {
      body = ListenableBuilder(
        listenable: prefs,
        builder: (context, _) => bodyFor(0.25, prefs.avatarStyle == CheAvatarStyle.portrait),
      );
    }

    return Semantics(
      label: '${widget.agent.name}, ${widget.agent.role}, ${widget.agent.status.label}',
      child: SizedBox(
        width: widget.size,
        height: widget.size * 1.25,
        child: RepaintBoundary(child: body),
      ),
    );
  }
}

/// Portrait image avatar for CHE when UI Controls → Avatar style = Portrait.
/// Uses the female CHE asset with teal halo + waiting/done chrome from #55.
class _ChePortraitAvatar extends StatelessWidget {
  const _ChePortraitAvatar({
    required this.agent,
    required this.t,
    required this.desk,
    required this.size,
  });

  final CheAgent agent;
  final double t;
  final bool desk;
  final double size;

  @override
  Widget build(BuildContext context) {
    final dim = agent.status == CheAgentStatus.offline;
    final breathe = math.sin(t * math.pi) * size * 0.01;

    return Stack(
      alignment: Alignment.center,
      children: [
        if (!dim)
          Positioned.fill(
            child: CustomPaint(painter: _CheHaloPainter(accent: CheColors.accent, t: t)),
          ),
        if (desk)
          Positioned(
            left: size * 0.05,
            right: size * 0.05,
            bottom: size * 0.02,
            height: size * 0.08,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xFFD2AF7F),
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        Positioned(
          top: size * 0.04 + breathe,
          child: Opacity(
            opacity: dim ? 0.45 : 1,
            child: Container(
              width: size * 0.78,
              height: size * 0.78,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: CheColors.accent.withValues(alpha: 0.55), width: 1.5),
                boxShadow: [
                  BoxShadow(
                    color: CheColors.accent.withValues(alpha: 0.25),
                    blurRadius: size * 0.12,
                    spreadRadius: 1,
                  ),
                ],
              ),
              child: ClipOval(
                child: Image.asset(
                  _CheMiniPersonState.cheAvatarAsset,
                  fit: BoxFit.cover,
                  alignment: const Alignment(-0.35, -0.15),
                  errorBuilder: (context, error, stack) => CustomPaint(
                    size: Size(size * 0.78, size * 0.78),
                    painter: _MiniPersonPainter(agent: agent, t: t, desk: false),
                  ),
                ),
              ),
            ),
          ),
        ),
        Positioned.fill(
          child: IgnorePointer(
            child: CustomPaint(painter: _CheStatusChromePainter(agent: agent, t: t)),
          ),
        ),
      ],
    );
  }
}

class _CheHaloPainter extends CustomPainter {
  _CheHaloPainter({required this.accent, required this.t});
  final Color accent;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height * 0.38);
    final r = size.width * 0.42;
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(colors: [accent.withValues(alpha: 0.4), Colors.transparent])
            .createShader(Rect.fromCircle(center: c, radius: r)),
    );
  }

  @override
  bool shouldRepaint(covariant _CheHaloPainter o) => o.t != t || o.accent != accent;
}

class _CheStatusChromePainter extends CustomPainter {
  _CheStatusChromePainter({required this.agent, required this.t});
  final CheAgent agent;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final headC = Offset(w / 2, h * 0.38);
    final headR = w * 0.28;
    final st = agent.status;

    if (st == CheAgentStatus.waiting) {
      for (var i = 0; i < 3; i++) {
        final on = ((t * 3).floor() % 3) >= i;
        canvas.drawCircle(
          headC.translate(headR * (1.0 + i * 0.4), -headR * (0.9 + i * 0.3)),
          headR * (0.1 + i * 0.04),
          Paint()..color = Colors.white.withValues(alpha: on ? 0.85 : 0.25),
        );
      }
    }
    if (st == CheAgentStatus.done) {
      final b = headC.translate(-headR * 1.2, -headR * 1.0);
      canvas.drawCircle(b, headR * 0.35, Paint()..color = CheColors.success);
      final p = Path()
        ..moveTo(b.dx - headR * 0.15, b.dy)
        ..lineTo(b.dx - headR * 0.04, b.dy + headR * 0.14)
        ..lineTo(b.dx + headR * 0.18, b.dy - headR * 0.14);
      canvas.drawPath(
        p,
        Paint()
          ..color = Colors.white
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _CheStatusChromePainter o) => o.t != t || o.agent != agent;
}

class _MiniPersonPainter extends CustomPainter {
  _MiniPersonPainter({required this.agent, required this.t, required this.desk});
  final CheAgent agent;
  final double t;
  final bool desk;

  double _s(double k) => math.sin(t * math.pi * 2 * k);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final st = agent.status;
    final dim = st == CheAgentStatus.offline;
    Color c(Color x) => dim ? Color.lerp(x, const Color(0xFF3A4446), 0.7)! : x;

    final breathe = _s(0.5) * w * 0.01;
    final cx = w / 2;
    final headR = w * 0.16;
    final headC = Offset(cx, h * 0.28 + breathe);

    // CHE halo
    if (agent.isChe && !dim) {
      canvas.drawCircle(headC, headR * 2.1,
          Paint()..shader = RadialGradient(colors: [CheColors.accent.withValues(alpha: 0.45), Colors.transparent])
              .createShader(Rect.fromCircle(center: headC, radius: headR * 2.1)));
    }
    // shadow
    canvas.drawOval(Rect.fromCenter(center: Offset(cx, h * 0.96), width: w * 0.62, height: h * 0.06),
        Paint()..color = Colors.black.withValues(alpha: 0.35));

    // body (rounded torso)
    final torso = RRect.fromRectAndRadius(
        Rect.fromCenter(center: Offset(cx, h * 0.62 + breathe), width: w * 0.46, height: h * 0.38), Radius.circular(w * 0.16));
    canvas.drawRRect(torso, Paint()..color = c(agent.color));
    // collar / badge — CHE gets a gold lapel pin (authoritative Office Boss look)
    canvas.drawCircle(Offset(cx + w * 0.1, h * 0.55 + breathe), w * 0.03, Paint()..color = Colors.white.withValues(alpha: dim ? 0.2 : 0.8));
    if (agent.isChe && !dim) {
      final pin = Offset(cx - w * 0.12, h * 0.52 + breathe);
      canvas.drawCircle(pin, w * 0.035, Paint()..color = const Color(0xFFD6A63F));
      canvas.drawCircle(pin, w * 0.018, Paint()..color = const Color(0xFFFFF3C4));
    }

    // arms by pose
    final arm = Paint()
      ..color = c(agent.color)
      ..strokeWidth = w * 0.09
      ..strokeCap = StrokeCap.round;
    final shoulderL = Offset(cx - w * 0.2, h * 0.52 + breathe);
    final shoulderR = Offset(cx + w * 0.2, h * 0.52 + breathe);
    Offset handL, handR;
    switch (st) {
      case CheAgentStatus.building:
        // typing
        handL = Offset(cx - w * 0.12, h * 0.74 + _s(4) * h * 0.012);
        handR = Offset(cx + w * 0.12, h * 0.74 - _s(4) * h * 0.012);
      case CheAgentStatus.researching:
      case CheAgentStatus.analyzing:
      case CheAgentStatus.reviewing:
        // holding a tablet / document
        handL = Offset(cx - w * 0.1, h * 0.62);
        handR = Offset(cx + w * 0.1, h * 0.62);
      case CheAgentStatus.talking:
      case CheAgentStatus.meeting:
        // gesturing
        handL = Offset(cx - w * 0.3, h * 0.66);
        handR = Offset(cx + w * 0.3, h * 0.5 + _s(1.5) * h * 0.05);
      case CheAgentStatus.done:
        // wave
        handL = Offset(cx - w * 0.28, h * 0.74);
        handR = Offset(cx + w * 0.34 + _s(2) * w * 0.04, h * 0.3);
      default:
        handL = Offset(cx - w * 0.28, h * 0.76);
        handR = Offset(cx + w * 0.28, h * 0.76);
    }
    canvas.drawLine(shoulderL, handL, arm);
    canvas.drawLine(shoulderR, handR, arm);
    final hand = Paint()..color = c(agent.skin);
    canvas.drawCircle(handL, w * 0.045, hand);
    canvas.drawCircle(handR, w * 0.045, hand);

    // prop: tablet while reading
    if (st == CheAgentStatus.researching || st == CheAgentStatus.analyzing || st == CheAgentStatus.reviewing) {
      final tab = RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(cx, h * 0.6), width: w * 0.3, height: h * 0.14),
          const Radius.circular(3));
      canvas.drawRRect(tab, Paint()..color = const Color(0xFF0B1418));
      canvas.drawRRect(tab.deflate(2), Paint()..color = c(CheColors.accentAlt).withValues(alpha: 0.5 + 0.3 * _s(1).abs()));
    }

    final hairPaint = Paint()..color = c(agent.hair);
    if (agent.isChe) {
      // CHE: long wavy hair falling BEHIND her head to the shoulders, drawn
      // first so it frames the face instead of covering the chin.
      canvas.drawRRect(
          RRect.fromRectAndRadius(
              Rect.fromLTWH(headC.dx - headR * 1.2, headC.dy - headR * 1.1, headR * 2.4, headR * 2.55),
              Radius.circular(headR * 1.1)),
          hairPaint);
      for (final side in [-1.0, 1.0]) {
        canvas.drawCircle(headC.translate(side * headR * 1.05, headR * 1.25), headR * 0.36, hairPaint);
      }
    }
    // head
    canvas.drawCircle(headC, headR, Paint()..color = c(agent.skin));
    // hair (cap shape)
    final hair = Path()
      ..addArc(Rect.fromCircle(center: headC.translate(0, -headR * 0.15), radius: headR * 1.05), math.pi, math.pi);
    canvas.drawPath(hair, hairPaint);
    if (agent.isChe) {
      // side-swept bangs
      final bangs = Path()
        ..moveTo(headC.dx - headR * 1.0, headC.dy - headR * 0.15)
        ..quadraticBezierTo(headC.dx - headR * 0.2, headC.dy - headR * 0.05, headC.dx + headR * 0.55, headC.dy - headR * 0.72)
        ..lineTo(headC.dx + headR * 0.2, headC.dy - headR * 1.05)
        ..quadraticBezierTo(headC.dx - headR * 0.7, headC.dy - headR * 0.9, headC.dx - headR * 1.0, headC.dy - headR * 0.15)
        ..close();
      canvas.drawPath(bangs, hairPaint);
      // gold hoop earrings
      final gold = Paint()
        ..color = c(const Color(0xFFE2B04A))
        ..style = PaintingStyle.stroke
        ..strokeWidth = math.max(1.0, headR * 0.09);
      for (final side in [-1.0, 1.0]) {
        canvas.drawCircle(headC.translate(side * headR * 0.98, headR * 0.42), headR * 0.14, gold);
      }
      // soft blush
      final blush = Paint()..color = const Color(0xFFE8788A).withValues(alpha: 0.28);
      for (final side in [-1.0, 1.0]) {
        canvas.drawCircle(headC.translate(side * headR * 0.52, headR * 0.3), headR * 0.14, blush);
      }
    }
    // eyes (blink)
    final blink = (t * 2 % 1.0) > 0.94;
    final eye = Paint()..color = const Color(0xFF14181A);
    for (final dx in [-0.38, 0.38]) {
      final e = headC.translate(headR * dx, headR * 0.05);
      if (blink || st == CheAgentStatus.offline) {
        canvas.drawLine(e.translate(-headR * 0.1, 0), e.translate(headR * 0.1, 0), eye..strokeWidth = 1.4);
      } else {
        canvas.drawCircle(e, headR * 0.1, eye);
        if (agent.isChe) {
          // eyelashes
          final lash = Paint()
            ..color = const Color(0xFF14181A)
            ..strokeWidth = math.max(1.0, headR * 0.05)
            ..strokeCap = StrokeCap.round;
          final outward = dx < 0 ? -1.0 : 1.0;
          canvas.drawLine(e.translate(outward * headR * 0.08, -headR * 0.08), e.translate(outward * headR * 0.2, -headR * 0.18), lash);
        }
      }
    }
    // mouth
    final talking = st == CheAgentStatus.talking || st == CheAgentStatus.meeting;
    final mouthOpen = talking ? (0.5 + 0.5 * _s(6)).abs() : 0.0;
    final mouthC = headC.translate(0, headR * 0.45);
    if (mouthOpen > 0.1) {
      canvas.drawOval(Rect.fromCenter(center: mouthC, width: headR * 0.35, height: headR * 0.3 * mouthOpen), eye);
    } else {
      canvas.drawArc(Rect.fromCenter(center: mouthC.translate(0, -headR * 0.08), width: headR * 0.45, height: headR * 0.3), 0.2,
          math.pi - 0.4, false, Paint()
            ..color = agent.isChe ? const Color(0xFFB8435A) : const Color(0xFF14181A)
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.3);
    }

    // desk + laptop in front (Office floor)
    if (desk) {
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(w * 0.05, h * 0.78, w * 0.9, h * 0.06), const Radius.circular(3)),
          Paint()..color = const Color(0xFFD2AF7F));
      final lap = Rect.fromCenter(center: Offset(cx, h * 0.72), width: w * 0.42, height: h * 0.12);
      canvas.drawRRect(RRect.fromRectAndRadius(lap, const Radius.circular(3)), Paint()..color = const Color(0xFF1C2226));
      if (st == CheAgentStatus.building) {
        canvas.drawRRect(RRect.fromRectAndRadius(lap.deflate(2), const Radius.circular(2)),
            Paint()..color = agent.color.withValues(alpha: 0.35 + 0.25 * _s(3).abs()));
      }
    }

    // thought dots while waiting
    if (st == CheAgentStatus.waiting) {
      for (var i = 0; i < 3; i++) {
        final on = ((t * 3).floor() % 3) >= i;
        canvas.drawCircle(headC.translate(headR * (1.2 + i * 0.45), -headR * (1.1 + i * 0.35)), headR * (0.12 + i * 0.05),
            Paint()..color = Colors.white.withValues(alpha: on ? 0.85 : 0.25));
      }
    }
    // done check
    if (st == CheAgentStatus.done) {
      final b = headC.translate(-headR * 1.5, -headR * 1.2);
      canvas.drawCircle(b, headR * 0.45, Paint()..color = CheColors.success);
      final p = Path()
        ..moveTo(b.dx - headR * 0.2, b.dy)
        ..lineTo(b.dx - headR * 0.05, b.dy + headR * 0.17)
        ..lineTo(b.dx + headR * 0.22, b.dy - headR * 0.17);
      canvas.drawPath(p, Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6);
    }
  }

  @override
  bool shouldRepaint(covariant _MiniPersonPainter o) => o.t != t || o.agent != agent || o.desk != desk;
}

/// Small round avatar chip (chat "Delegating to Nova…", War Room seats).
class CheAgentChip extends StatelessWidget {
  const CheAgentChip({super.key, required this.agent, this.onTap});
  final CheAgent agent;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(4, 2, 12, 2),
        decoration: BoxDecoration(
          color: agent.color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(CheRadius.pill),
          border: Border.all(color: agent.color.withValues(alpha: 0.5)),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          ClipOval(child: SizedBox(width: 28, height: 28, child: FittedBox(child: CheMiniPerson(agent: agent, size: 28)))),
          const SizedBox(width: 6),
          Text(agent.name, style: CheType.label),
          const SizedBox(width: 6),
          Text(agent.status.label, style: CheType.caption.copyWith(color: agent.color)),
        ]),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Office floor: CHE + agents at their desks in the Office room
// ─────────────────────────────────────────────────────────────────────────

class CheOfficeFloor extends StatelessWidget {
  const CheOfficeFloor({
    super.key,
    required this.che,
    required this.agents,
    required this.onTapAgent,
    this.onConvene,
    this.deskNotes = const {},
  });

  /// Real job status per agent name from the Office board (e.g. "Blocked:
  /// tool not configured (Codex)"), shown when the runtime status is idle.
  final Map<String, String> deskNotes;

  /// CHE's own live state (manager desk, front and center).
  final CheAgent che;

  /// Live agents from the backend Agent Runtime.
  final List<CheAgent> agents;
  final void Function(CheAgent agent) onTapAgent;

  /// Opens the War Room for a multi-agent project.
  final VoidCallback? onConvene;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(CheRadius.xl),
      child: CheRoomBackdrop(
        room: CheRoom.office,
        scrim: 0.45,
        child: Padding(
          padding: const EdgeInsets.all(CheSpace.md),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Flexible(
                child: Text('CHE OFFICE',
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.overline.copyWith(color: Colors.white)),
              ),
              const SizedBox(width: CheSpace.sm),
              Expanded(
                child: Text(
                  '${agents.where((a) => !const [CheAgentStatus.idle, CheAgentStatus.offline, CheAgentStatus.done].contains(a.status)).length} working',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: CheType.caption.copyWith(color: Colors.white70),
                ),
              ),
              if (onConvene != null) ...[
                const SizedBox(width: CheSpace.xs),
                TextButton.icon(
                  onPressed: onConvene,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: CheSpace.sm),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.groups_rounded, size: 18, color: Color(0xFFE8B04A)),
                  label: Text('War Room', style: CheType.label.copyWith(color: const Color(0xFFE8B04A))),
                ),
              ],
            ]),
            const SizedBox(height: CheSpace.sm),
            Center(child: RepaintBoundary(child: _Desk(agent: che, big: true, onTap: () => onTapAgent(che)))),
            const SizedBox(height: CheSpace.sm),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: CheSpace.sm,
              runSpacing: CheSpace.sm,
              children: [
                for (final a in agents)
                  RepaintBoundary(child: _Desk(agent: a, note: deskNotes[a.name], onTap: () => onTapAgent(a))),
              ],
            ),
            if (agents.isEmpty)
              Padding(
                padding: const EdgeInsets.all(CheSpace.md),
                child: Text('No agents yet. Ask CHE to build a team for a project.',
                    textAlign: TextAlign.center, style: CheType.bodyDim.copyWith(color: Colors.white70)),
              ),
          ]),
        ),
      ),
    );
  }
}

// First few words of a task so a desk card stays glanceable.
String _shortTask(String task) {
  final words = task.replaceAll(RegExp(r'\s+'), ' ').trim().split(' ');
  return words.length <= 3 ? words.join(' ') : '${words.take(3).join(' ')}…';
}

/// What a desk shows under the name: the live task, else the board's real
/// job status (blocked, up next, finished), else the runtime status.
String cheDeskLine(CheAgent agent, String? note) {
  if (agent.task?.isNotEmpty == true && agent.status != CheAgentStatus.offline) return agent.task!;
  if (note != null && note.isNotEmpty) return note;
  if (agent.task?.isNotEmpty == true) return agent.task!;
  return agent.status.label;
}

class _Desk extends StatelessWidget {
  const _Desk({required this.agent, required this.onTap, this.big = false, this.note});
  final CheAgent agent;
  final VoidCallback onTap;
  final bool big;
  final String? note;
  @override
  Widget build(BuildContext context) {
    final w = big ? 118.0 : 100.0;
    final line = cheDeskLine(agent, note);
    return Semantics(
      button: true,
      label: '${agent.name}${agent.role.isNotEmpty ? ', ${agent.role}' : ''}. $line. '
          '${agent.isChe ? 'Talk to CHE.' : 'Open ${agent.name}\'s desk.'}',
      excludeSemantics: true,
      child: GestureDetector(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Container(
          width: w,
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 8),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(CheRadius.md),
            border: Border.all(color: agent.color.withValues(alpha: big ? 0.9 : 0.45)),
            boxShadow: big ? [BoxShadow(color: agent.color.withValues(alpha: 0.4), blurRadius: 18)] : null,
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            CheMiniPerson(agent: agent, size: big ? 70 : 56, showDesk: true),
            const SizedBox(height: 4),
            // Full name, never truncated: it shrinks to fit instead.
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(agent.name, maxLines: 1, style: CheType.label.copyWith(color: Colors.white)),
            ),
            if (agent.role.isNotEmpty)
              Text(agent.role,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: CheType.caption.copyWith(color: Colors.white70, fontSize: 10)),
            Text(line == agent.task ? _shortTask(line) : line,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: CheType.caption.copyWith(color: agent.color, fontSize: 10.5)),
          ]),
        ),
      ),
    );
  }
}
