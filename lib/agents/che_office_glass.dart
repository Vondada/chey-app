// HUD glass for the Office and Agents rooms (owner, 2026-10-22: "this style for all her rooms"). Under the HUD glass
// palette a room's own panels become glossy glass (no blur, so lists stay fast); under the other palettes they keep
// the earlier solid look exactly. Decoration only: nothing here changes what a control does, says or shows.
import 'package:flutter/material.dart';

import '../che_ui/che_hud.dart';

/// A panel that is [CheGlass] while the HUD look is active, and a plain [Container] with [legacy] otherwise.
class CheOfficePanel extends StatelessWidget {
  const CheOfficePanel({
    super.key,
    required this.legacy,
    required this.child,
    this.padding = EdgeInsets.zero,
    this.margin,
    this.width,
    this.glow,
    this.radius,
    this.shadow = false,
  });

  /// The earlier solid look, used when the HUD palette is not active.
  final BoxDecoration legacy;
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final double? width;

  /// The panel's own colour, glowing just inside the glass edge (a status colour, for example).
  final Color? glow;

  /// Corner radius of the glass; defaults to the legacy decoration's top-left radius.
  final double? radius;

  /// A soft drop shadow under the glass. Off by default: rows in long lists stay cheap to paint.
  final bool shadow;

  static double _radiusOf(BoxDecoration d) {
    final r = d.borderRadius;
    if (r is BorderRadius) return r.topLeft.x;
    return 16;
  }

  @override
  Widget build(BuildContext context) {
    if (!cheHudActive) {
      return Container(width: width, margin: margin, padding: padding, decoration: legacy, child: child);
    }
    Widget glass = CheGlass(
      radius: radius ?? _radiusOf(legacy),
      padding: padding,
      glow: glow,
      shadow: shadow,
      child: child,
    );
    if (width != null) glass = SizedBox(width: width, child: glass);
    if (margin != null) glass = Padding(padding: margin!, child: glass);
    return glass;
  }
}

/// An [Ink] panel for a tappable row (so its ripple shows) that is [CheGlass] while the HUD look is active. Put it
/// directly inside the row's [InkWell].
class CheOfficeInkPanel extends StatelessWidget {
  const CheOfficeInkPanel({super.key, required this.padding, required this.decoration, required this.child, this.glow});

  final EdgeInsetsGeometry padding;

  /// The earlier solid look, used when the HUD palette is not active.
  final BoxDecoration decoration;
  final Widget child;
  final Color? glow;

  @override
  Widget build(BuildContext context) {
    if (!cheHudActive) return Ink(padding: padding, decoration: decoration, child: child);
    return CheGlass(
      radius: CheOfficePanel._radiusOf(decoration),
      padding: padding,
      glow: glow,
      shadow: false,
      child: child,
    );
  }
}

/// A small uppercase section label: the mono HUD label while the HUD look is active, [legacy] otherwise.
TextStyle cheOfficeLabel(TextStyle legacy, {Color? color}) =>
    cheHudActive ? (color == null ? CheHud.label : CheHud.label.copyWith(color: color)) : legacy;
