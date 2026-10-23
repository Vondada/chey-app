// The Trading Room's panels in the owner's HUD glass look (owner, 2026-10-22: "this style for all her rooms").
// In the HUD palette a panel is glossy glass and a small section label is a mono HUD label; every other palette keeps
// the earlier solid panel. Decoration only: nothing here reads data, speaks, or changes what a control does.
import 'package:flutter/material.dart';

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';

/// A Trading Room panel: HUD glass in the HUD palette, otherwise the earlier solid panel with a thin stroke.
class CheTradingPanel extends StatelessWidget {
  const CheTradingPanel({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
    this.margin,
    this.width,
    this.radius = 12,
    this.color,
    this.borderColor,
    this.glow,
    this.boxShadow,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final double? width;
  final double radius;

  /// The solid look's fill and edge (other palettes). Defaults: the palette surface and stroke.
  final Color? color, borderColor;

  /// A state colour (live, verified, ...) glowing along the glass edge in the HUD look.
  final Color? glow;

  /// The solid look's shadow (other palettes).
  final List<BoxShadow>? boxShadow;

  @override
  Widget build(BuildContext context) {
    if (cheHudActive) {
      Widget glass = CheGlass(radius: radius, padding: padding, glow: glow, child: child);
      if (width != null) glass = SizedBox(width: width, child: glass);
      return margin == null ? glass : Padding(padding: margin!, child: glass);
    }
    return Container(
      width: width,
      margin: margin,
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? CheColors.surface,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: borderColor ?? CheColors.stroke),
        boxShadow: boxShadow,
      ),
      child: child,
    );
  }
}

/// A small uppercase section label: the mono HUD label in the HUD palette, otherwise [fallback].
TextStyle cheTradingLabel(TextStyle fallback) =>
    cheHudActive ? CheHud.label.copyWith(fontSize: fallback.fontSize == null ? 12 : fallback.fontSize! - 1) : fallback;

/// The colour that marks a selected chip or section: ice light in the HUD palette, otherwise the Markets gold.
Color get cheTradingSelect => cheHudActive ? CheHud.ice : CheColors.markets;

/// A room's page or app bar background: clear over the HUD backdrop, otherwise [fallback].
Color cheTradingPage(Color fallback) => cheHudActive ? CheColors.screen : fallback;

/// A small expandable Trading Room card (owner, 2026-10-23): a HUD label title and one summary line first, the full
/// panel only when opened. The panel is built only while open, so a folded card costs nothing.
class CheTradingFold extends StatefulWidget {
  const CheTradingFold({super.key, required this.title, required this.summary, required this.child, this.initiallyExpanded = false});

  final String title, summary;
  final Widget child;
  final bool initiallyExpanded;

  @override
  State<CheTradingFold> createState() => _CheTradingFoldState();
}

class _CheTradingFoldState extends State<CheTradingFold> {
  late bool _open = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    return CheTradingPanel(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(
          button: true,
          expanded: _open,
          label: '${widget.title}. ${widget.summary}. ${_open ? 'Collapse' : 'Expand'}.',
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _open = !_open),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 52),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                    Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 12.5, color: cheHudActive ? CheHud.ice : Colors.white)),
                    Text(widget.summary, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 13)),
                  ]),
                ),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: Colors.white70),
              ]),
            ),
          ),
        ),
        if (_open) Padding(padding: const EdgeInsets.only(bottom: 8), child: widget.child),
      ]),
    );
  }
}
