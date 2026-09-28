// Cinematic page transition: scale + fade + blur-in. Respects Reduce Motion.
// Usage: Navigator.of(context).push(CheRoute(builder: (_) => SomeScreen()));

import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'che_theme.dart';

class CheRoute<T> extends PageRouteBuilder<T> {
  CheRoute({required WidgetBuilder builder, super.settings})
      : super(
          opaque: true,
          transitionDuration: const Duration(milliseconds: 340),
          reverseTransitionDuration: const Duration(milliseconds: 240),
          pageBuilder: (context, a, b) => builder(context),
          transitionsBuilder: (context, a, b, child) {
            if (CheMotion.reduced(context)) return FadeTransition(opacity: a, child: child);
            final t = CurvedAnimation(parent: a, curve: CheMotion.curve, reverseCurve: Curves.easeInCubic);
            return AnimatedBuilder(
              animation: t,
              child: child,
              builder: (context, child) {
                final v = t.value;
                final sigma = (1 - v) * 10;
                Widget w = Opacity(
                  opacity: v.clamp(0.0, 1.0),
                  child: Transform.scale(scale: 0.94 + 0.06 * v, child: child),
                );
                if (sigma > 0.2) {
                  w = ImageFiltered(imageFilter: ui.ImageFilter.blur(sigmaX: sigma, sigmaY: sigma), child: w);
                }
                return ColoredBox(color: CheColors.bg.withValues(alpha: v), child: w);
              },
            );
          },
        );
}

/// Fade + slight rise for swapping content in place (e.g. switching sections).
Widget cheSwitchTransition(Widget child, Animation<double> a) {
  final t = CurvedAnimation(parent: a, curve: CheMotion.curve);
  return FadeTransition(
    opacity: t,
    child: SlideTransition(
      position: Tween(begin: const Offset(0, 0.02), end: Offset.zero).animate(t),
      child: child,
    ),
  );
}
