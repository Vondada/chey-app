// ignore_for_file: use_null_aware_elements
// CHE reusable widgets: background, glow card, glass panel, pill toggle,
// office tile, header, section bar, step line, thinking shimmer, code card,
// rich (markdown-lite) text, and a glowing popover menu.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';

// ─────────────────────────────────────────────────────────────────────────
// Background
// ─────────────────────────────────────────────────────────────────────────

/// Near-black backdrop with a faint logo-colored aura at the top.
class CheBackground extends StatelessWidget {
  const CheBackground({super.key, required this.child, this.auraColor});
  final Widget child;
  final Color? auraColor;

  @override
  Widget build(BuildContext context) {
    final aura = auraColor ?? CheColors.accent;
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [CheColors.bgTop, CheColors.bg],
        ),
      ),
      child: Stack(children: [
        Positioned(
          top: -160,
          left: -80,
          right: -80,
          height: 380,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  colors: [aura.withValues(alpha: 0.16), aura.withValues(alpha: 0.0)],
                ),
              ),
            ),
          ),
        ),
        Positioned.fill(child: child),
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Glow card — rotating gradient border, pulses brighter while `active`.
// ─────────────────────────────────────────────────────────────────────────

class GlowCard extends StatefulWidget {
  const GlowCard({
    super.key,
    required this.child,
    this.active = false,
    this.color,
    this.radius = CheRadius.lg,
    this.padding = const EdgeInsets.all(CheSpace.md),
    this.fill,
  });

  final Widget child;
  final bool active;
  final Color? color;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? fill;

  @override
  State<GlowCard> createState() => _GlowCardState();
}

class _GlowCardState extends State<GlowCard> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 4));

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant GlowCard old) {
    super.didUpdateWidget(old);
    if (old.active != widget.active && !CheMotion.reduced(context)) _sync();
  }

  void _sync() {
    _c.duration = Duration(milliseconds: widget.active ? 1600 : 6000);
    _c.repeat(); // restart so the new speed applies immediately
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (CheMotion.reduced(context)) {
      _c.stop();
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
    final color = widget.color ?? CheColors.accent;
    final r = BorderRadius.circular(widget.radius);
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) {
        final pulse = widget.active ? 0.55 + 0.45 * math.sin(_c.value * math.pi * 2).abs() : 0.35;
        return Container(
          decoration: BoxDecoration(
            borderRadius: r,
            boxShadow: [
              BoxShadow(
                color: color.withValues(alpha: 0.22 * pulse + (widget.active ? 0.12 : 0)),
                blurRadius: widget.active ? 34 : 22,
                spreadRadius: widget.active ? 1 : 0,
              ),
            ],
          ),
          child: CustomPaint(
            foregroundPainter: _GlowBorderPainter(
              progress: _c.value,
              radius: widget.radius,
              color: color,
              alt: CheColors.accentAlt,
              intensity: widget.active ? 1.0 : 0.55,
            ),
            child: ClipRRect(
              borderRadius: r,
              child: Container(
                color: widget.fill ?? CheColors.surface.withValues(alpha: 0.92),
                padding: widget.padding,
                child: child,
              ),
            ),
          ),
        );
      },
      child: widget.child,
    );
  }
}

class _GlowBorderPainter extends CustomPainter {
  _GlowBorderPainter({
    required this.progress,
    required this.radius,
    required this.color,
    required this.alt,
    required this.intensity,
  });
  final double progress;
  final double radius;
  final Color color;
  final Color alt;
  final double intensity;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(rect.deflate(0.75), Radius.circular(radius));
    final shader = SweepGradient(
      transform: GradientRotation(progress * math.pi * 2),
      colors: [
        color.withValues(alpha: 0.15 * intensity),
        color.withValues(alpha: 0.95 * intensity),
        alt.withValues(alpha: 0.7 * intensity),
        color.withValues(alpha: 0.15 * intensity),
      ],
      stops: const [0.0, 0.35, 0.6, 1.0],
    ).createShader(rect);
    canvas.drawRRect(
      rrect,
      Paint()
        ..shader = shader
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );
  }

  @override
  bool shouldRepaint(covariant _GlowBorderPainter old) =>
      old.progress != progress || old.intensity != intensity || old.color != color;
}

// ─────────────────────────────────────────────────────────────────────────
// Glass panel
// ─────────────────────────────────────────────────────────────────────────

class GlassPanel extends StatelessWidget {
  const GlassPanel({
    super.key,
    required this.child,
    this.radius = CheRadius.md,
    this.padding = const EdgeInsets.all(CheSpace.md),
    this.tint,
    this.blur = 18,
  });
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;
  final Color? tint;
  final double blur;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(radius);
    return ClipRRect(
      borderRadius: r,
      child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            borderRadius: r,
            color: (tint ?? CheColors.surfaceHi).withValues(alpha: 0.72),
            border: Border.all(color: CheColors.stroke),
          ),
          child: child,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pill toggle (e.g. Agent | Chat)
// ─────────────────────────────────────────────────────────────────────────

class PillToggle extends StatelessWidget {
  const PillToggle({
    super.key,
    required this.options,
    required this.index,
    required this.onChanged,
    this.height = 38,
  });
  final List<String> options;
  final int index;
  final ValueChanged<int> onChanged;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.pill),
        border: Border.all(color: CheColors.stroke),
      ),
      child: LayoutBuilder(builder: (context, c) {
        final w = c.maxWidth / options.length;
        return Stack(children: [
          AnimatedPositioned(
            duration: CheMotion.d(context, CheMotion.base),
            curve: CheMotion.curve,
            left: w * index,
            top: 0,
            bottom: 0,
            width: w,
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                gradient: LinearGradient(colors: [
                  CheColors.accent.withValues(alpha: 0.28),
                  CheColors.accentAlt.withValues(alpha: 0.18),
                ]),
                border: Border.all(color: CheColors.accent.withValues(alpha: 0.7)),
                boxShadow: [BoxShadow(color: CheColors.accent.withValues(alpha: 0.35), blurRadius: 14)],
              ),
            ),
          ),
          Row(children: [
            for (var i = 0; i < options.length; i++)
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    if (i == index) return;
                    HapticFeedback.selectionClick();
                    onChanged(i);
                  },
                  child: Center(
                    child: AnimatedDefaultTextStyle(
                      duration: CheMotion.d(context, CheMotion.fast),
                      style: CheType.label.copyWith(
                        color: i == index ? CheColors.text : CheColors.textDim,
                        fontWeight: i == index ? FontWeight.w700 : FontWeight.w500,
                      ),
                      child: Text(options[i], maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ),
                ),
              ),
          ]),
        ]);
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pressable (scale-on-press + haptic) — wrap any tappable card with it.
// ─────────────────────────────────────────────────────────────────────────

class ChePressable extends StatefulWidget {
  const ChePressable({super.key, required this.child, required this.onTap, this.haptic = true});
  final Widget child;
  final VoidCallback? onTap;
  final bool haptic;

  @override
  State<ChePressable> createState() => _ChePressableState();
}

class _ChePressableState extends State<ChePressable> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => setState(() => _down = true),
      onTapCancel: () => setState(() => _down = false),
      onTapUp: (_) => setState(() => _down = false),
      onTap: widget.onTap == null
          ? null
          : () {
              if (widget.haptic) HapticFeedback.lightImpact();
              widget.onTap!();
            },
      child: AnimatedScale(
        scale: _down ? 0.96 : 1,
        duration: CheMotion.d(context, CheMotion.fast),
        curve: CheMotion.curve,
        child: widget.child,
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Office tile
// ─────────────────────────────────────────────────────────────────────────

class CheTile extends StatelessWidget {
  const CheTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.hue,
    required this.onTap,
    this.badge,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final Color hue;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    return ChePressable(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(CheSpace.sm, CheSpace.md, CheSpace.sm, CheSpace.md),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CheRadius.lg),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [hue.withValues(alpha: 0.20), CheColors.surface.withValues(alpha: 0.9)],
          ),
          border: Border.all(color: hue.withValues(alpha: 0.45)),
          boxShadow: [BoxShadow(color: hue.withValues(alpha: 0.18), blurRadius: 18)],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Stack(clipBehavior: Clip.none, children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: hue.withValues(alpha: 0.16),
                  border: Border.all(color: hue.withValues(alpha: 0.7), width: 1.2),
                  boxShadow: [BoxShadow(color: hue.withValues(alpha: 0.45), blurRadius: 16)],
                ),
                child: Icon(icon, color: hue, size: 22),
              ),
              if (badge != null)
                Positioned(
                  right: -6,
                  top: -4,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                        color: hue, borderRadius: BorderRadius.circular(CheRadius.pill)),
                    child: Text(badge!,
                        style: CheType.caption.copyWith(color: Colors.black, fontWeight: FontWeight.w800)),
                  ),
                ),
            ]),
            const SizedBox(height: CheSpace.sm),
            Text(title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: CheType.label),
            const SizedBox(height: 2),
            Text(subtitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: CheType.caption),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Header — "CHE / COGNITIVE.HORIZON.ENGINE" (single copy, no ghost title)
// ─────────────────────────────────────────────────────────────────────────

class CheStatusDot extends StatefulWidget {
  const CheStatusDot({super.key, this.color = CheColors.success, this.size = 7});
  final Color color;
  final double size;
  @override
  State<CheStatusDot> createState() => _CheStatusDotState();
}

class _CheStatusDotState extends State<CheStatusDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: widget.color,
          boxShadow: [
            BoxShadow(color: widget.color.withValues(alpha: 0.3 + 0.5 * _c.value), blurRadius: 8, spreadRadius: 1),
          ],
        ),
      ),
    );
  }
}

class CheHeader extends StatelessWidget {
  const CheHeader({
    super.key,
    this.title = 'CHE',
    this.subtitle = 'COGNITIVE.HORIZON.ENGINE',
    this.status = 'ONLINE',
    this.leading,
    this.trailing,
    this.compact = false,
  });
  final String title;
  final String subtitle;
  final String? status;
  final Widget? leading;
  final Widget? trailing;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
      child: Row(children: [
        if (leading != null) ...[leading!, const SizedBox(width: CheSpace.sm)],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              ShaderMask(
                shaderCallback: (r) => CheColors.accentGradient.createShader(r),
                child: Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: (compact ? CheType.display.copyWith(fontSize: 24) : CheType.display)
                        .copyWith(color: Colors.white)),
              ),
              const SizedBox(height: 4),
              Row(children: [
                if (status != null) ...[
                  const CheStatusDot(),
                  const SizedBox(width: 6),
                  Text(status!, style: CheType.overline.copyWith(color: CheColors.success)),
                  const SizedBox(width: 10),
                ],
                Flexible(
                  child: Text(subtitle,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.overline),
                ),
              ]),
            ],
          ),
        ),
        if (trailing != null) trailing!,
      ]),
    );
  }
}

/// Round glowing icon button (chat button, +, mic, etc.)
class CheIconButton extends StatelessWidget {
  const CheIconButton({
    super.key,
    required this.icon,
    required this.onTap,
    this.size = 44,
    this.glow = false,
    this.color,
    this.tooltip,
  });
  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  final bool glow;
  final Color? color;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final c = color ?? CheColors.accent;
    final btn = ChePressable(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: glow ? c.withValues(alpha: 0.18) : CheColors.surfaceHi,
          border: Border.all(color: glow ? c.withValues(alpha: 0.8) : CheColors.stroke),
          boxShadow: glow ? [BoxShadow(color: c.withValues(alpha: 0.45), blurRadius: 18)] : null,
        ),
        child: Icon(icon, size: size * 0.46, color: glow ? c : CheColors.text),
      ),
    );
    return tooltip == null ? btn : Semantics(label: tooltip, button: true, child: btn);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section bar — replaces the crowded tab row. Scrolls, never overlaps,
// auto-centers the selected section.
// ─────────────────────────────────────────────────────────────────────────

class CheSectionBarItem {
  const CheSectionBarItem({required this.label, required this.icon, required this.hue});
  final String label;
  final IconData icon;
  final Color hue;
}

class CheSectionBar extends StatefulWidget {
  const CheSectionBar({super.key, required this.items, required this.index, required this.onChanged});
  final List<CheSectionBarItem> items;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  State<CheSectionBar> createState() => _CheSectionBarState();
}

class _CheSectionBarState extends State<CheSectionBar> {
  late List<GlobalKey> _keys;

  @override
  void initState() {
    super.initState();
    _keys = List.generate(widget.items.length, (_) => GlobalKey());
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal(animate: false));
  }

  @override
  void didUpdateWidget(covariant CheSectionBar old) {
    super.didUpdateWidget(old);
    if (old.items.length != widget.items.length) {
      _keys = List.generate(widget.items.length, (_) => GlobalKey());
    }
    if (old.index != widget.index) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
    }
  }

  void _reveal({bool animate = true}) {
    if (widget.index < 0 || widget.index >= _keys.length) return;
    final ctx = _keys[widget.index].currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(ctx,
        alignment: 0.5,
        duration: animate ? CheMotion.d(context, CheMotion.base) : Duration.zero,
        curve: CheMotion.curve);
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
        itemCount: widget.items.length,
        separatorBuilder: (_, _) => const SizedBox(width: CheSpace.sm),
        itemBuilder: (context, i) {
          final it = widget.items[i];
          final sel = i == widget.index;
          return ChePressable(
            key: _keys[i],
            onTap: () => widget.onChanged(i),
            child: AnimatedContainer(
              duration: CheMotion.d(context, CheMotion.base),
              curve: CheMotion.curve,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                color: sel ? it.hue.withValues(alpha: 0.18) : CheColors.surface,
                border: Border.all(color: sel ? it.hue.withValues(alpha: 0.85) : CheColors.stroke),
                boxShadow: sel ? [BoxShadow(color: it.hue.withValues(alpha: 0.35), blurRadius: 14)] : null,
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(it.icon, size: 16, color: sel ? it.hue : CheColors.textDim),
                const SizedBox(width: 6),
                Text(it.label,
                    maxLines: 1,
                    softWrap: false,
                    style: CheType.label.copyWith(
                        color: sel ? CheColors.text : CheColors.textDim,
                        fontWeight: sel ? FontWeight.w700 : FontWeight.w500)),
              ]),
            ),
          );
        },
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Agent working state: steps + thinking shimmer
// ─────────────────────────────────────────────────────────────────────────

enum StepStatus { running, done, error }

class StepLine extends StatelessWidget {
  const StepLine({super.key, required this.label, required this.status});
  final String label;
  final StepStatus status;

  @override
  Widget build(BuildContext context) {
    final Widget icon = switch (status) {
      StepStatus.done => const Icon(Icons.check_rounded, size: 15, color: CheColors.success),
      StepStatus.error => const Icon(Icons.error_outline_rounded, size: 15, color: CheColors.danger),
      StepStatus.running => const SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(strokeWidth: 1.6, color: CheColors.accent),
        ),
    };
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: CheMotion.d(context, CheMotion.base),
      curve: CheMotion.curve,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, (1 - t) * 6), child: child),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          SizedBox(width: 18, child: Center(child: icon)),
          const SizedBox(width: 8),
          Expanded(
            child: status == StepStatus.running
                ? ThinkingShimmer(text: label, style: CheType.bodyDim.copyWith(fontSize: 13.5))
                : Text(label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.bodyDim.copyWith(fontSize: 13.5)),
          ),
        ]),
      ),
    );
  }
}

class ThinkingShimmer extends StatefulWidget {
  const ThinkingShimmer({super.key, this.text = 'Thinking…', this.style});
  final String text;
  final TextStyle? style;
  @override
  State<ThinkingShimmer> createState() => _ThinkingShimmerState();
}

class _ThinkingShimmerState extends State<ThinkingShimmer> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1300))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = widget.style ?? CheType.bodyDim;
    if (CheMotion.reduced(context)) return Text(widget.text, style: style);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, child) => ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (r) {
          final x = -1.0 + 3.0 * _c.value;
          return LinearGradient(
            begin: Alignment(x - 1, 0),
            end: Alignment(x, 0),
            colors: const [CheColors.textFaint, CheColors.text, CheColors.textFaint],
          ).createShader(r);
        },
        child: child,
      ),
      child: Text(widget.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
    );
  }
}

class BlinkingCursor extends StatefulWidget {
  const BlinkingCursor({super.key});
  @override
  State<BlinkingCursor> createState() => _BlinkingCursorState();
}

class _BlinkingCursorState extends State<BlinkingCursor> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 520))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: _c,
        child: Container(
          width: 8,
          height: 17,
          margin: const EdgeInsets.only(left: 2),
          decoration: BoxDecoration(
            color: CheColors.accent,
            borderRadius: BorderRadius.circular(2),
            boxShadow: [BoxShadow(color: CheColors.accent.withValues(alpha: 0.6), blurRadius: 8)],
          ),
        ),
      );
}

// ─────────────────────────────────────────────────────────────────────────
// Rich text (markdown-lite): paragraphs, **bold**, `code`, bullets,
// headings and ``` fenced code blocks rendered as CodeCards.
// ─────────────────────────────────────────────────────────────────────────

class CheRichText extends StatelessWidget {
  const CheRichText({super.key, required this.text, this.streaming = false});
  final String text;
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final blocks = _parseBlocks(text);
    final children = <Widget>[];
    for (var i = 0; i < blocks.length; i++) {
      final b = blocks[i];
      final last = i == blocks.length - 1;
      if (b.isCode && b.lang == 'che-remember') {
        children.add(_RememberChip(lines: b.text));
      } else if (b.isCode) {
        children.add(CodeCard(code: b.text, filename: b.lang));
        if (last && streaming) children.add(const BlinkingCursor());
      } else {
        children.add(_Paragraphs(text: b.text, cursor: last && streaming));
      }
    }
    if (children.isEmpty && streaming) children.add(const BlinkingCursor());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }

  static List<_Block> _parseBlocks(String src) {
    final out = <_Block>[];
    final lines = src.split('\n');
    final buf = StringBuffer();
    String? lang;
    var inCode = false;
    void flush(bool code) {
      final s = buf.toString();
      buf.clear();
      if (code || s.trim().isNotEmpty) out.add(_Block(s.trimRight(), code, lang));
    }

    for (final line in lines) {
      if (line.trimLeft().startsWith('```')) {
        if (!inCode) {
          flush(false);
          lang = line.trim().substring(3).trim();
          if (lang.isEmpty) lang = null;
          inCode = true;
        } else {
          flush(true);
          inCode = false;
          lang = null;
        }
        continue;
      }
      buf.writeln(line);
    }
    flush(inCode); // unterminated fence while streaming still renders as code
    return out;
  }
}

class _RememberChip extends StatelessWidget {
  const _RememberChip({required this.lines});
  final String lines;
  @override
  Widget build(BuildContext context) {
    final items = lines
        .split('\n')
        .map((l) => l.replaceFirst(RegExp(r'^\s*[-*•]\s*'), '').trim())
        .where((l) => l.isNotEmpty)
        .toList();
    return Container(
      margin: const EdgeInsets.only(top: CheSpace.sm),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: CheColors.accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Icon(Icons.psychology_rounded, size: 16, color: CheColors.accent),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Saved to brain', style: CheType.caption.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700)),
            for (final i in items) Text(i, style: CheType.caption),
          ]),
        ),
      ]),
    );
  }
}

class _Block {
  _Block(this.text, this.isCode, this.lang);
  final String text;
  final bool isCode;
  final String? lang;
}

class _Paragraphs extends StatelessWidget {
  const _Paragraphs({required this.text, required this.cursor});
  final String text;
  final bool cursor;

  @override
  Widget build(BuildContext context) {
    final lines = text.split('\n');
    final widgets = <Widget>[];
    for (var i = 0; i < lines.length; i++) {
      final raw = lines[i];
      final isLast = i == lines.length - 1;
      if (raw.trim().isEmpty) {
        widgets.add(const SizedBox(height: 6));
        continue;
      }
      var style = CheType.body;
      var content = raw;
      Widget? bullet;
      if (raw.startsWith('### ') || raw.startsWith('## ') || raw.startsWith('# ')) {
        content = raw.replaceFirst(RegExp(r'^#+\s'), '');
        style = CheType.headline;
      } else if (RegExp(r'^\s*[-*•]\s').hasMatch(raw)) {
        content = raw.replaceFirst(RegExp(r'^\s*[-*•]\s'), '');
        bullet = Container(
          margin: const EdgeInsets.only(top: 9, right: 10),
          width: 5,
          height: 5,
          decoration: const BoxDecoration(color: CheColors.accent, shape: BoxShape.circle),
        );
      } else if (RegExp(r'^\s*\d+[.)]\s').hasMatch(raw)) {
        final m = RegExp(r'^\s*(\d+)[.)]\s').firstMatch(raw)!;
        content = raw.substring(m.end);
        bullet = Padding(
          padding: const EdgeInsets.only(right: 8),
          child: Text('${m.group(1)}.', style: CheType.body.copyWith(color: CheColors.accent)),
        );
      }
      final spans = _inline(content, style);
      if (cursor && isLast) {
        spans.add(const WidgetSpan(alignment: PlaceholderAlignment.middle, child: BlinkingCursor()));
      }
      final rich = Text.rich(TextSpan(children: spans));
      widgets.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: bullet == null
            ? rich
            : Row(crossAxisAlignment: CrossAxisAlignment.start, children: [bullet, Expanded(child: rich)]),
      ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: widgets);
  }

  static List<InlineSpan> _inline(String s, TextStyle base) {
    final spans = <InlineSpan>[];
    final re = RegExp(r'(\*\*[^*]+\*\*|`[^`]+`)');
    var i = 0;
    for (final m in re.allMatches(s)) {
      if (m.start > i) spans.add(TextSpan(text: s.substring(i, m.start), style: base));
      final t = m.group(0)!;
      if (t.startsWith('**')) {
        spans.add(TextSpan(text: t.substring(2, t.length - 2), style: base.copyWith(fontWeight: FontWeight.w700)));
      } else {
        spans.add(TextSpan(
          text: ' ${t.substring(1, t.length - 1)} ',
          style: CheType.mono.copyWith(
              fontSize: base.fontSize! - 1.5,
              color: CheColors.accent,
              backgroundColor: CheColors.accent.withValues(alpha: 0.10)),
        ));
      }
      i = m.end;
    }
    if (i < s.length) spans.add(TextSpan(text: s.substring(i), style: base));
    return spans;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Code card — file-style header, copy button, light syntax colors.
// ─────────────────────────────────────────────────────────────────────────

class CodeCard extends StatelessWidget {
  const CodeCard({super.key, required this.code, this.filename});
  final String code;
  final String? filename;

  static final _kw = RegExp(
      r'\b(import|export|from|return|final|const|var|let|function|class|extends|if|else|for|while|async|await|new|void|def|true|false|null|this|static|int|double|String|bool)\b');
  static final _str = RegExp(r'''("[^"\n]*"|'[^'\n]*')''');
  static final _num = RegExp(r'\b\d+(\.\d+)?\b');
  static final _cmt = RegExp(r'(//.*$|#.*$)', multiLine: true);

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: CheSpace.sm),
      decoration: BoxDecoration(
        color: const Color(0xFF060B0D),
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
        boxShadow: [BoxShadow(color: CheColors.accent.withValues(alpha: 0.12), blurRadius: 18)],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: CheColors.stroke))),
          child: Row(children: [
            const Icon(Icons.code_rounded, size: 16, color: CheColors.accent),
            const SizedBox(width: 8),
            Expanded(
              child: Text(filename ?? 'code',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.mono.copyWith(color: CheColors.textDim)),
            ),
            IconButton(
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.copy_rounded, size: 16, color: CheColors.textDim),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: code));
                HapticFeedback.lightImpact();
                ScaffoldMessenger.maybeOf(context)
                    ?.showSnackBar(const SnackBar(content: Text('Copied'), duration: Duration(milliseconds: 900)));
              },
            ),
          ]),
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.all(12),
          child: Text.rich(TextSpan(children: _highlight(code))),
        ),
      ]),
    );
  }

  List<TextSpan> _highlight(String src) {
    // Assign a color per character, later rules win, then merge runs.
    final colors = List<Color>.filled(src.length, CheColors.text);
    void paint(RegExp re, Color c) {
      for (final m in re.allMatches(src)) {
        for (var i = m.start; i < m.end; i++) {
          colors[i] = c;
        }
      }
    }

    paint(_num, CheColors.warning);
    paint(_kw, CheColors.accentAlt);
    paint(_str, CheColors.accent);
    paint(_cmt, CheColors.textFaint);

    final spans = <TextSpan>[];
    var start = 0;
    for (var i = 1; i <= src.length; i++) {
      if (i == src.length || colors[i] != colors[start]) {
        spans.add(TextSpan(text: src.substring(start, i), style: CheType.mono.copyWith(color: colors[start])));
        start = i;
      }
    }
    return spans;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Glowing popover menu anchored to a widget (Framer-style quick actions).
// Usage:  final key = GlobalKey();  ...  showCheMenu(context, key, [...])
// ─────────────────────────────────────────────────────────────────────────

class CheMenuItem<T> {
  const CheMenuItem({required this.value, required this.label, this.icon, this.trailing});
  final T value;
  final String label;
  final IconData? icon;
  final String? trailing;
}

Future<T?> showCheMenu<T>(BuildContext context, GlobalKey anchor, List<CheMenuItem<T>> items) {
  final box = anchor.currentContext?.findRenderObject() as RenderBox?;
  final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
  final pos = box?.localToGlobal(Offset.zero, ancestor: overlay) ?? Offset.zero;
  final size = box?.size ?? Size.zero;
  final screen = overlay.size;
  const menuW = 230.0;
  final maxLeft = math.max(12.0, screen.width - menuW - 12.0);
  final double left = (pos.dx + size.width - menuW).clamp(12.0, maxLeft).toDouble();
  final estH = items.length * 44.0 + 16;
  final below = pos.dy + size.height + 8;
  final double top =
      below + estH < screen.height - 40 ? below : (pos.dy - estH - 8).clamp(40.0, screen.height).toDouble();

  HapticFeedback.selectionClick();
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'menu',
    barrierColor: Colors.black.withValues(alpha: 0.25),
    transitionDuration: CheMotion.d(context, CheMotion.fast),
    pageBuilder: (ctx, a, b) => Stack(children: [
      Positioned(
        left: left,
        top: top,
        width: menuW,
        child: Material(
          type: MaterialType.transparency,
          child: GlowCard(
            active: true,
            radius: CheRadius.md,
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              for (final it in items)
                InkWell(
                  onTap: () => Navigator.of(ctx).pop(it.value),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                    child: Row(children: [
                      if (it.icon != null) ...[
                        Icon(it.icon, size: 17, color: CheColors.accent),
                        const SizedBox(width: 10),
                      ],
                      Expanded(child: Text(it.label, style: CheType.label)),
                      if (it.trailing != null) Text(it.trailing!, style: CheType.caption),
                    ]),
                  ),
                ),
            ]),
          ),
        ),
      ),
    ]),
    transitionBuilder: (ctx, a, b, child) => FadeTransition(
      opacity: a,
      child: ScaleTransition(
        scale: Tween(begin: 0.94, end: 1.0).animate(CurvedAnimation(parent: a, curve: CheMotion.curve)),
        alignment: Alignment.topRight,
        child: child,
      ),
    ),
  );
}
