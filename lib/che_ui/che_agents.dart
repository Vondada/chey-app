// CHE agents in the app: mini-person avatars for CHE and every Office agent,
// plus the Office floor where they sit at desks.
//
// The agents themselves run OUTSIDE the app (backend Agent Runtime, see the
// master prompt). The app only mirrors their REAL state from the backend:
// pass a live List<CheAgent> (e.g. from GET /agents or a WebSocket to the
// Durable Object). Never animate work that isn't happening.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_rooms.dart';
import 'che_theme.dart';

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

  /// CHE herself (the manager), in her logo colors.
  static CheAgent che({CheAgentStatus status = CheAgentStatus.idle, String? task}) => CheAgent(
        id: 'che',
        name: 'CHE',
        role: 'Manager',
        specialty: 'Leads the team, delegates, reviews and delivers',
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
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mini-person avatar
// ─────────────────────────────────────────────────────────────────────────

/// A little animated person. Pose follows the agent's REAL status:
/// typing (building), reading (researching/analyzing/reviewing), talking
/// (talking/meeting), thought dots (waiting), wave + check (done), dimmed
/// (offline), gentle breathing (idle). CHE gets a glowing halo.
class CheMiniPerson extends StatefulWidget {
  const CheMiniPerson({super.key, required this.agent, this.size = 64, this.showDesk = false});
  final CheAgent agent;
  final double size;
  final bool showDesk;
  @override
  State<CheMiniPerson> createState() => _CheMiniPersonState();
}

class _CheMiniPersonState extends State<CheMiniPerson> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '${widget.agent.name}, ${widget.agent.role}, ${widget.agent.status.label}',
      child: SizedBox(
        width: widget.size,
        height: widget.size * 1.25,
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) => CustomPaint(
            painter: _MiniPersonPainter(
              agent: widget.agent,
              t: CheMotion.reduced(context) ? 0.25 : _c.value,
              desk: widget.showDesk,
            ),
          ),
        ),
      ),
    );
  }
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
    // collar / badge
    canvas.drawCircle(Offset(cx + w * 0.1, h * 0.55 + breathe), w * 0.03, Paint()..color = Colors.white.withValues(alpha: dim ? 0.2 : 0.8));

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

    // head
    canvas.drawCircle(headC, headR, Paint()..color = c(agent.skin));
    // hair (cap shape)
    final hair = Path()
      ..addArc(Rect.fromCircle(center: headC.translate(0, -headR * 0.15), radius: headR * 1.05), math.pi, math.pi);
    canvas.drawPath(hair, Paint()..color = c(agent.hair));
    if (agent.isChe) {
      // CHE: long hair
      canvas.drawRRect(
          RRect.fromRectAndRadius(
              Rect.fromLTWH(headC.dx - headR * 1.05, headC.dy - headR * 0.3, headR * 2.1, headR * 1.9), Radius.circular(headR)),
          Paint()..color = c(agent.hair).withValues(alpha: 0.9));
      canvas.drawCircle(headC.translate(0, headR * 0.12), headR * 0.86, Paint()..color = c(agent.skin));
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
            ..color = const Color(0xFF14181A)
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
  });

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
            Center(child: _Desk(agent: che, big: true, onTap: () => onTapAgent(che))),
            const SizedBox(height: CheSpace.sm),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: CheSpace.sm,
              runSpacing: CheSpace.sm,
              children: [for (final a in agents) _Desk(agent: a, onTap: () => onTapAgent(a))],
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

class _Desk extends StatelessWidget {
  const _Desk({required this.agent, required this.onTap, this.big = false});
  final CheAgent agent;
  final VoidCallback onTap;
  final bool big;
  @override
  Widget build(BuildContext context) {
    final w = big ? 110.0 : 92.0;
    return GestureDetector(
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
          Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white)),
          Text(agent.task?.isNotEmpty == true ? agent.task! : agent.status.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.caption.copyWith(color: agent.color, fontSize: 10.5)),
        ]),
      ),
    );
  }
}
