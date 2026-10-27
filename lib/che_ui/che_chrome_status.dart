// Chrome status (owner, 2026-10-23): one semantic status system in the Home screen's chrome identity.
//
// - Five tones, each a metallic gradient with a highlight and a controlled glow: success (green), failure (red),
//   warning (amber), active (blue/cyan) and neutral (silver). A tone is never the only signal: every indicator carries
//   a word, and pills carry an icon.
// - Motion follows real state only. A pulse, dots or a shimmer run only while [CheActivity.running]; queued, paused,
//   blocked, disconnected, done and failed are steady. Nothing here changes tone on a timer, so a green success never
//   decays to red.
// - Reduce Motion (iOS) or accessible navigation gives static equivalents. Pulses stay under 1 Hz (no flashing).
// - Each animated indicator owns one controller inside a RepaintBoundary, and stops it as soon as it is not running.
// - Visual only: no speech and no forced VoiceOver announcements (CHE stays silent on passive status). Semantics
//   labels state the real status.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'che_hud.dart';

/// What a status means. Pick the tone from the real outcome, never from elapsed time.
enum CheStatusTone { success, failure, warning, active, neutral }

/// What is really happening. Only [running] animates.
enum CheActivity { running, queued, paused, blocked, disconnected, done, failed, idle }

/// The chrome look of each tone: a vertical metallic gradient (light top, saturated middle, cooler base), a base
/// colour for borders and icons, and a glow.
class CheStatusPalette {
  const CheStatusPalette._(this.base, this.gradient, this.glow);

  final Color base;
  final LinearGradient gradient;
  final Color glow;

  static LinearGradient _metal(Color hi, Color mid, Color lo) => LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [const Color(0xFFFFFFFF), hi, mid, lo, hi],
        stops: const [0.0, 0.26, 0.56, 0.82, 1.0],
      );

  static final success = CheStatusPalette._(
      const Color(0xFF6FF0B4), _metal(const Color(0xFFD8FFEC), const Color(0xFF6FF0B4), const Color(0xFF3FBF8A)), const Color(0xFF6FF0B4));
  static final failure = CheStatusPalette._(
      const Color(0xFFFF7A86), _metal(const Color(0xFFFFE0E3), const Color(0xFFFF7A86), const Color(0xFFD9485A)), const Color(0xFFFF5C6C));
  static final warning = CheStatusPalette._(
      const Color(0xFFFFC266), _metal(const Color(0xFFFFF1D6), const Color(0xFFFFC266), const Color(0xFFE09A3A)), const Color(0xFFFFB347));
  static final active = CheStatusPalette._(
      CheHud.ice, _metal(const Color(0xFFEAF8FF), CheHud.ice, CheHud.iceDeep), CheHud.iceDeep);
  static final neutral = CheStatusPalette._(
      CheHud.chromeMid, _metal(const Color(0xFFEAF2FA), CheHud.chromeMid, CheHud.chromeLo), CheHud.chromeMid);

  static CheStatusPalette of(CheStatusTone tone) => switch (tone) {
        CheStatusTone.success => success,
        CheStatusTone.failure => failure,
        CheStatusTone.warning => warning,
        CheStatusTone.active => active,
        CheStatusTone.neutral => neutral,
      };

  /// The icon that carries the meaning without colour. All are in the installed build's icon font.
  static IconData icon(CheStatusTone tone, CheActivity activity) => switch (activity) {
        CheActivity.queued => Icons.schedule_rounded,
        CheActivity.paused => Icons.pause_rounded,
        CheActivity.blocked => Icons.block_rounded,
        CheActivity.disconnected => Icons.link_off_rounded,
        _ => switch (tone) {
            CheStatusTone.success => Icons.check_circle_rounded,
            CheStatusTone.failure => Icons.error_outline_rounded,
            CheStatusTone.warning => Icons.warning_amber,
            CheStatusTone.active => Icons.autorenew,
            CheStatusTone.neutral => Icons.radio_button_unchecked,
          },
      };
}

/// True when this device asked for less motion.
bool cheReduceMotion(BuildContext context) {
  final mq = MediaQuery.maybeOf(context);
  return (mq?.disableAnimations ?? false) || (mq?.accessibleNavigation ?? false);
}

/// Severity 0 (safe) → 1 (critical) as a smooth green → amber → red colour.
Color cheSeverityColor(double severity) {
  final s = severity.clamp(0.0, 1.0);
  return s <= 0.5
      ? Color.lerp(CheStatusPalette.success.base, CheStatusPalette.warning.base, s * 2)!
      : Color.lerp(CheStatusPalette.warning.base, CheStatusPalette.failure.base, (s - 0.5) * 2)!;
}

/// Text in a tone's chrome gradient. The text stays an ordinary [Text], so VoiceOver and Dynamic Type read it.
class CheStatusText extends StatelessWidget {
  const CheStatusText(this.text, {super.key, required this.tone, required this.style, this.maxLines = 1});

  final String text;
  final CheStatusTone tone;
  final TextStyle style;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final palette = CheStatusPalette.of(tone);
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (rect) => palette.gradient.createShader(rect),
      child: Text(text,
          maxLines: maxLines,
          overflow: maxLines == null ? null : TextOverflow.ellipsis,
          style: style.copyWith(color: Colors.white, shadows: [Shadow(color: palette.glow.withValues(alpha: 0.45), blurRadius: 8)])),
    );
  }
}

/// Runs one repeating controller only while [running] and motion is allowed; otherwise holds still.
mixin _CheLiveTicker<T extends StatefulWidget> on State<T>, SingleTickerProviderStateMixin<T> {
  late final AnimationController pulse = AnimationController(vsync: this, duration: period);

  Duration get period;
  bool get running;

  void syncTicker(BuildContext context) {
    final go = running && !cheReduceMotion(context);
    if (go && !pulse.isAnimating) {
      pulse.repeat();
    } else if (!go && pulse.isAnimating) {
      pulse.stop();
      pulse.value = 0;
    }
  }

  @override
  void dispose() {
    pulse.dispose();
    super.dispose();
  }
}

/// A status pill: icon, word and chrome border. It pulses gently (about 0.8 Hz) only while the activity is running.
class CheStatusPill extends StatefulWidget {
  const CheStatusPill({super.key, required this.label, required this.tone, this.activity = CheActivity.idle, this.compact = false, this.uppercase = true});

  final String label;
  final CheStatusTone tone;
  final CheActivity activity;
  final bool compact;

  /// HUD capitals by default; pass false where the words are a sentence.
  final bool uppercase;

  @override
  State<CheStatusPill> createState() => _CheStatusPillState();
}

class _CheStatusPillState extends State<CheStatusPill> with SingleTickerProviderStateMixin, _CheLiveTicker {
  @override
  Duration get period => const Duration(milliseconds: 1250);
  @override
  bool get running => widget.activity == CheActivity.running;

  @override
  Widget build(BuildContext context) {
    syncTicker(context);
    final palette = CheStatusPalette.of(widget.tone);
    final size = widget.compact ? 10.0 : 11.5;
    final body = Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(CheStatusPalette.icon(widget.tone, widget.activity), size: size + 3, color: palette.base),
      SizedBox(width: widget.compact ? 4 : 6),
      Flexible(child: CheStatusText(widget.uppercase ? widget.label.toUpperCase() : widget.label, tone: widget.tone, style: CheHud.label.copyWith(fontSize: size))),
    ]);
    return Semantics(
      label: widget.label,
      excludeSemantics: true,
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: pulse,
          builder: (context, child) {
            // A soft breathing glow: 0 → 1 → 0 per period. Steady (no glow change) when not running.
            final t = pulse.isAnimating ? (1 - math.cos(pulse.value * 2 * math.pi)) / 2 : 0.0;
            return Container(
              padding: EdgeInsets.symmetric(horizontal: widget.compact ? 7 : 10, vertical: widget.compact ? 3 : 5),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                color: const Color(0xFF071222).withValues(alpha: 0.72),
                border: Border.all(color: palette.base.withValues(alpha: 0.55 + 0.35 * t), width: 1),
                boxShadow: [BoxShadow(color: palette.glow.withValues(alpha: 0.16 + 0.22 * t), blurRadius: 10 + 6 * t)],
              ),
              child: child,
            );
          },
          child: body,
        ),
      ),
    );
  }
}

/// CHE's thinking indicator: the real label (for example "Thinking… 2.4s"), three chrome dots and a gentle scanning
/// highlight. With [active] false or Reduce Motion it is a steady label.
class CheThinkingIndicator extends StatefulWidget {
  const CheThinkingIndicator({super.key, required this.label, this.active = true, this.style});

  final String label;
  final bool active;
  final TextStyle? style;

  @override
  State<CheThinkingIndicator> createState() => _CheThinkingIndicatorState();
}

class _CheThinkingIndicatorState extends State<CheThinkingIndicator> with SingleTickerProviderStateMixin, _CheLiveTicker {
  @override
  Duration get period => const Duration(milliseconds: 1500);
  @override
  bool get running => widget.active;

  @override
  Widget build(BuildContext context) {
    syncTicker(context);
    final style = (widget.style ?? CheHud.label.copyWith(fontSize: 12)).copyWith(color: Colors.white);
    final text = Text(widget.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: style);
    if (!pulse.isAnimating) {
      return CheStatusText(widget.label, tone: widget.active ? CheStatusTone.active : CheStatusTone.neutral, style: style);
    }
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: pulse,
        builder: (context, _) {
          final v = pulse.value;
          final x = -1.0 + 3.0 * v;
          return Row(mainAxisSize: MainAxisSize.min, children: [
            Flexible(
              child: ShaderMask(
                blendMode: BlendMode.srcIn,
                shaderCallback: (r) => LinearGradient(
                  begin: Alignment(x - 1, 0),
                  end: Alignment(x, 0),
                  colors: const [CheHud.chromeMid, Color(0xFFFFFFFF), CheHud.ice],
                ).createShader(r),
                child: text,
              ),
            ),
            const SizedBox(width: 6),
            for (var i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Opacity(
                  opacity: 0.3 + 0.7 * ((1 - math.cos(((v - i * 0.18) % 1.0) * 2 * math.pi)) / 2),
                  child: Container(
                    width: 4,
                    height: 4,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: CheStatusPalette.active.gradient,
                      boxShadow: [BoxShadow(color: CheStatusPalette.active.glow.withValues(alpha: 0.5), blurRadius: 4)],
                    ),
                  ),
                ),
              ),
          ]);
        },
      ),
    );
  }
}

/// Progress: a percentage only when [value] is measured (0..1); otherwise an indeterminate chrome shimmer that runs
/// only while [active]. A finished or stopped job passes its real tone and [active] false.
class CheChromeProgress extends StatefulWidget {
  const CheChromeProgress({super.key, this.value, this.active = true, this.tone = CheStatusTone.active, this.label});

  final double? value;
  final bool active;
  final CheStatusTone tone;
  final String? label;

  @override
  State<CheChromeProgress> createState() => _CheChromeProgressState();
}

class _CheChromeProgressState extends State<CheChromeProgress> with SingleTickerProviderStateMixin, _CheLiveTicker {
  @override
  Duration get period => const Duration(milliseconds: 1600);
  @override
  bool get running => widget.active && widget.value == null;

  @override
  Widget build(BuildContext context) {
    syncTicker(context);
    final palette = CheStatusPalette.of(widget.tone);
    final measured = widget.value?.clamp(0.0, 1.0);
    final pct = measured == null ? null : '${(measured * 100).round()}%';
    final semantics = [if (widget.label != null) widget.label!, pct ?? (widget.active ? 'in progress, no measured percentage' : 'not running')].join(', ');
    return Semantics(
      label: semantics,
      excludeSemantics: true,
      child: Row(children: [
        Expanded(
          child: RepaintBoundary(
            child: SizedBox(
              height: 6,
              child: AnimatedBuilder(
                animation: pulse,
                builder: (context, _) => CustomPaint(painter: _BarPainter(palette, measured, pulse.isAnimating ? pulse.value : null)),
              ),
            ),
          ),
        ),
        if (pct != null) ...[
          const SizedBox(width: 8),
          SizedBox(width: 40, child: CheStatusText(pct, tone: widget.tone, style: CheHud.label.copyWith(fontSize: 11))),
        ],
      ]),
    );
  }
}

class _BarPainter extends CustomPainter {
  _BarPainter(this.palette, this.value, this.sweep);

  final CheStatusPalette palette;
  final double? value;
  final double? sweep;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Radius.circular(size.height / 2);
    canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, r), Paint()..color = const Color(0x22FFFFFF));
    if (value != null) {
      final fill = Rect.fromLTWH(0, 0, size.width * value!, size.height);
      canvas.drawRRect(RRect.fromRectAndRadius(fill, r), Paint()..shader = palette.gradient.createShader(fill));
    } else if (sweep != null) {
      final w = size.width * 0.32;
      final x = -w + (size.width + w) * sweep!;
      final band = Rect.fromLTWH(x, 0, w, size.height);
      canvas.save();
      canvas.clipRRect(RRect.fromRectAndRadius(Offset.zero & size, r));
      canvas.drawRect(
          band,
          Paint()
            ..shader = LinearGradient(colors: [palette.base.withValues(alpha: 0), palette.base, palette.base.withValues(alpha: 0)])
                .createShader(band));
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_BarPainter old) => old.value != value || old.sweep != sweep || old.palette != palette;
}

/// The workflow stages CHE reports. [current] is the stage now in progress (or reached); [failed] marks it failed.
class CheStageTracker extends StatelessWidget {
  const CheStageTracker({
    super.key,
    required this.current,
    this.stages = defaultStages,
    this.failed = false,
    this.activity = CheActivity.running,
  });

  static const defaultStages = ['Understanding', 'Planning', 'Working', 'Verifying', 'Complete'];

  final List<String> stages;
  final int current;
  final bool failed;
  final CheActivity activity;

  @override
  Widget build(BuildContext context) {
    final done = current >= stages.length - 1 && !failed;
    final now = stages[current.clamp(0, stages.length - 1)];
    final status = failed ? 'failed at $now' : done ? 'complete' : '$now, stage ${current + 1} of ${stages.length}';
    return Semantics(
      label: 'Progress: $status',
      excludeSemantics: true,
      child: Wrap(spacing: 4, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        for (var i = 0; i < stages.length; i++) ...[
          if (i > 0) Icon(Icons.chevron_right_rounded, size: 12, color: CheHud.chromeLo.withValues(alpha: 0.7)),
          _stage(i),
        ],
      ]),
    );
  }

  Widget _stage(int i) {
    if (i < current || (i == current && current == stages.length - 1 && !failed)) {
      return CheStatusText(stages[i], tone: CheStatusTone.success, style: CheHud.label.copyWith(fontSize: 10));
    }
    if (i == current) {
      return CheStatusPill(
        label: stages[i],
        tone: failed ? CheStatusTone.failure : (activity == CheActivity.running ? CheStatusTone.active : CheStatusTone.warning),
        activity: failed ? CheActivity.failed : activity,
        compact: true,
      );
    }
    return Text(stages[i], style: CheHud.label.copyWith(fontSize: 10, color: CheHud.chromeLo.withValues(alpha: 0.6)));
  }
}

/// A severity meter: [severity] 0 (safe) → 1 (critical), coloured green → amber → red and eased between real values.
/// It never animates on its own.
class CheSeverityMeter extends StatelessWidget {
  const CheSeverityMeter({super.key, required this.severity, required this.label});

  final double severity;
  final String label;

  @override
  Widget build(BuildContext context) {
    final s = severity.clamp(0.0, 1.0);
    final word = s < 0.34 ? 'low' : s < 0.67 ? 'elevated' : 'high';
    return Semantics(
      label: '$label: $word, ${(s * 100).round()} percent',
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: s),
        duration: cheReduceMotion(context) ? Duration.zero : const Duration(milliseconds: 420),
        curve: Curves.easeOutCubic,
        builder: (context, v, _) {
          final c = cheSeverityColor(v);
          return Row(children: [
            Expanded(
              child: SizedBox(
                height: 6,
                child: CustomPaint(painter: _MeterPainter(v, c)),
              ),
            ),
            const SizedBox(width: 8),
            Text(word.toUpperCase(), style: CheHud.label.copyWith(fontSize: 10, color: c)),
          ]);
        },
      ),
    );
  }
}

class _MeterPainter extends CustomPainter {
  _MeterPainter(this.value, this.color);

  final double value;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Radius.circular(size.height / 2);
    canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, r), Paint()..color = const Color(0x22FFFFFF));
    final fill = Rect.fromLTWH(0, 0, math.max(size.height, size.width * value), size.height);
    canvas.drawRRect(
        RRect.fromRectAndRadius(fill, r),
        Paint()
          ..shader = LinearGradient(colors: [CheStatusPalette.success.base, cheSeverityColor(value)]).createShader(fill));
    canvas.drawRRect(RRect.fromRectAndRadius(fill, r), Paint()..color = color.withValues(alpha: 0.25)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3));
  }

  @override
  bool shouldRepaint(_MeterPainter old) => old.value != value || old.color != color;
}

// ─── Real state → tone and activity ───────────────────────────────────────

/// A CHE coding job's runtime state (CheCodingJobStatus.state) as a tone and an activity. Queued and waiting for
/// capacity are not running, so they never animate.
(CheStatusTone, CheActivity) cheCodingStatus(String state) => switch (state) {
      'running' || 'retrying' || 'recovering' || 'resuming' || 'reviewing' => (CheStatusTone.active, CheActivity.running),
      'queued' || 'waiting_capacity' => (CheStatusTone.neutral, CheActivity.queued),
      'implemented' || 'pr_open' => (CheStatusTone.active, CheActivity.idle),
      'merged' || 'no_change' => (CheStatusTone.success, CheActivity.done),
      'approved_waiting_owner' => (CheStatusTone.warning, CheActivity.paused),
      'blocked' => (CheStatusTone.failure, CheActivity.blocked),
      'interrupted' => (CheStatusTone.warning, CheActivity.paused),
      'review_rejected' || 'tests_failed' || 'rolled_back' || 'failed' || 'cancelled' || 'dead_letter' || 'opencode_failed' || 'deliver_failed' =>
        (CheStatusTone.failure, CheActivity.failed),
      _ => (CheStatusTone.neutral, CheActivity.idle),
    };

/// A video render stage (project.render.stage) as a tone and an activity.
(CheStatusTone, CheActivity) cheRenderStatus(String stage) => switch (stage) {
      'preparing' || 'rendering' || 'finalizing' => (CheStatusTone.active, CheActivity.running),
      'ready' => (CheStatusTone.success, CheActivity.done),
      'failed' => (CheStatusTone.failure, CheActivity.failed),
      _ => (CheStatusTone.neutral, CheActivity.idle),
    };

/// An Office agent task status as a tone and an activity. "complete" is green only when CHE verified it.
(CheStatusTone, CheActivity) cheTaskStatus(String status, {required bool verified}) => switch (status) {
      'running' || 'reviewing' => (CheStatusTone.active, CheActivity.running),
      'queued' || 'review_pending' => (CheStatusTone.neutral, CheActivity.queued),
      'needs_review' => (CheStatusTone.warning, CheActivity.paused),
      'complete' => verified ? (CheStatusTone.success, CheActivity.done) : (CheStatusTone.warning, CheActivity.done),
      'rejected' || 'failed' => (CheStatusTone.failure, CheActivity.failed),
      'blocked' => (CheStatusTone.failure, CheActivity.blocked),
      _ => (CheStatusTone.neutral, CheActivity.idle),
    };
