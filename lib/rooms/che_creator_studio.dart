// CHE Creator / Sound Studio: neon production room. ON AIR and the meters
// react only to real activity (CHE speaking, cloud renders running). The
// render queue is CHE's real background-job list (podcast / long create jobs
// via /api/job/create). Video generation is not wired yet: next concrete step
// is a Worker media job kind "video" behind an HTTPS connector
// (CHE_VIDEO_GEN_URL), same honesty pattern as CHE_UPSCALE_URL — never fake a
// finished video. Pictures live in Art Studio (FLUX / CHE_IMAGE_GEN_URL).

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';

class CheStudioAction {
  const CheStudioAction({
    required this.icon,
    required this.title,
    required this.body,
    required this.connected,
    required this.connectorName,
    required this.onRun,
    this.background = false,
  });
  final IconData icon;
  final String title;
  final String body;
  final bool connected;
  final String connectorName;
  final VoidCallback onRun;

  /// Runs as a real cloud job that keeps going with the phone locked.
  final bool background;
}

class CheCreatorStudio extends StatefulWidget {
  const CheCreatorStudio({
    super.key,
    required this.speaking,
    required this.jobs,
    required this.actions,
    required this.onOpenJob,
    required this.musicScene,
  });

  /// CHE is speaking right now (drives the meters).
  final bool speaking;

  /// Real background jobs (render queue).
  final List<Map<String, dynamic>> jobs;
  final List<CheStudioAction> actions;
  final void Function(Map<String, dynamic> job) onOpenJob;

  /// The existing Music room (playlists, connected audio, car).
  final Widget musicScene;

  @override
  State<CheCreatorStudio> createState() => _CheCreatorStudioState();
}

class _CheCreatorStudioState extends State<CheCreatorStudio> with SingleTickerProviderStateMixin {
  static const _magenta = Color(0xFFFF3D8B);
  static const _cyan = Color(0xFF3FD0F0);

  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();
  int _view = 0;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  bool get _rendering => widget.jobs.any((j) => j['status'] == 'queued' || j['status'] == 'running');

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Material(
        color: const Color(0xFF07040A),
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
            child: SegmentedButton<int>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: 0, icon: Icon(Icons.graphic_eq_rounded, size: 16), label: Text('Studio')),
                ButtonSegment(value: 1, icon: Icon(Icons.queue_music_rounded, size: 16), label: Text('Music')),
              ],
              selected: {_view},
              onSelectionChanged: (v) {
                HapticFeedback.selectionClick();
                setState(() => _view = v.first);
              },
            ),
          ),
          Expanded(child: _view == 1 ? widget.musicScene : _studio(context)),
        ]),
      ),
    );
  }

  Widget _studio(BuildContext context) {
    final onAir = widget.speaking || _rendering;
    final reduced = CheMotion.reduced(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(CheRadius.lg),
          child: CheRoomBackdrop(
            room: CheRoom.studio,
            scrim: 0.5,
            child: Padding(
              padding: const EdgeInsets.all(CheSpace.md),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  AnimatedContainer(
                    duration: CheMotion.base,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: onAir ? Colors.red.withValues(alpha: 0.85) : Colors.white10,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: onAir ? [BoxShadow(color: Colors.red.withValues(alpha: 0.6), blurRadius: 14)] : null,
                    ),
                    child: Text('ON AIR',
                        style: TextStyle(color: onAir ? Colors.white : Colors.white38, fontWeight: FontWeight.w900, letterSpacing: 2)),
                  ),
                  const SizedBox(width: CheSpace.sm),
                  Expanded(
                    child: Text(
                      widget.speaking ? 'CHE is speaking' : _rendering ? 'Rendering in the cloud' : 'Studio ready',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.caption.copyWith(color: Colors.white70),
                    ),
                  ),
                ]),
                const SizedBox(height: CheSpace.md),
                SizedBox(
                  height: 70,
                  child: AnimatedBuilder(
                    animation: _c,
                    builder: (context, _) => CustomPaint(
                      painter: _MeterPainter(
                        t: reduced ? 0.3 : _c.value,
                        level: widget.speaking ? 1.0 : _rendering ? 0.45 : 0.06,
                        a: _magenta,
                        b: _cyan,
                      ),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
        const SizedBox(height: CheSpace.lg),
        Text('RENDER QUEUE', style: CheType.overline.copyWith(color: _cyan)),
        const SizedBox(height: CheSpace.xs),
        if (widget.jobs.isEmpty)
          Text('Nothing rendering. Long creations run as cloud jobs and keep going when your phone is locked.', style: CheType.bodyDim)
        else
          for (final job in widget.jobs.take(6)) _JobRow(job: job, onTap: () => widget.onOpenJob(job)),
        const SizedBox(height: CheSpace.lg),
        Text('CREATE', style: CheType.overline.copyWith(color: _magenta)),
        const SizedBox(height: CheSpace.sm),
        for (final a in widget.actions)
          Card(
            color: const Color(0xFF130A14),
            margin: const EdgeInsets.only(bottom: CheSpace.sm),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(CheRadius.md),
              side: BorderSide(color: _magenta.withValues(alpha: 0.25)),
            ),
            child: ListTile(
              onTap: () {
                HapticFeedback.selectionClick();
                a.onRun();
              },
              leading: Icon(a.icon, color: _magenta),
              title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
              subtitle: Text(
                a.connected
                    ? '${a.body}${a.background ? '\nRuns as a cloud job.' : ''}'
                    : '${a.body}\nNeeds: ${a.connectorName}. CHE will write the brief and plan until it is connected.',
                style: CheType.caption,
              ),
              isThreeLine: !a.connected || a.background,
              trailing: Text(a.connected ? 'READY' : 'CONNECT',
                  style: TextStyle(color: a.connected ? CheColors.success : CheColors.warning, fontSize: 10, fontWeight: FontWeight.w700)),
            ),
          ),
      ],
    );
  }
}

class _JobRow extends StatelessWidget {
  const _JobRow({required this.job, required this.onTap});
  final Map<String, dynamic> job;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final status = '${job['status'] ?? ''}';
    final (color, icon) = switch (status) {
      'queued' => (CheColors.textDim, Icons.schedule_rounded),
      'running' => (const Color(0xFF3FD0F0), Icons.graphic_eq_rounded),
      'complete' => (CheColors.success, Icons.check_circle_rounded),
      'failed' => (CheColors.danger, Icons.error_outline_rounded),
      _ => (CheColors.textFaint, Icons.remove_circle_outline_rounded),
    };
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      onTap: onTap,
      leading: Icon(icon, color: color),
      title: Text('${job['title'] ?? 'Job'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
      subtitle: Text(status, style: CheType.caption.copyWith(color: color)),
      trailing: const Icon(Icons.chevron_right_rounded),
    );
  }
}

class _MeterPainter extends CustomPainter {
  _MeterPainter({required this.t, required this.level, required this.a, required this.b});
  final double t;
  final double level;
  final Color a;
  final Color b;

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 28;
    final w = size.width / bars;
    for (var i = 0; i < bars; i++) {
      final wave = 0.5 + 0.5 * math.sin(t * math.pi * 2 * (1 + i % 5 * 0.3) + i * 0.7);
      final h = size.height * (0.06 + level * 0.94 * wave);
      final color = Color.lerp(a, b, i / bars)!;
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(i * w + w * 0.2, size.height - h, w * 0.6, h), const Radius.circular(2)),
        Paint()..color = color.withValues(alpha: 0.35 + 0.6 * level),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _MeterPainter old) => old.t != t || old.level != level;
}
