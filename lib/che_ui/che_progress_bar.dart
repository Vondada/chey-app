// The Office's progress bar (owner, 2026-10-26): it always fills from 0 to the measured value, like loading, and never
// sweeps back and forth. An unknown value shows 0, so the bar never pretends to be busy.
import 'package:flutter/material.dart';

class CheProgressBar extends StatelessWidget {
  const CheProgressBar({super.key, required this.value, required this.color, required this.background, this.height = 7});

  /// 0 to 1, or null when nothing is measured yet (shown as an empty bar, not a sweep).
  final double? value;
  final Color color;
  final Color background;
  final double height;

  @override
  Widget build(BuildContext context) {
    final target = (value ?? 0).clamp(0.0, 1.0).toDouble();
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: target),
      duration: const Duration(milliseconds: 900),
      curve: Curves.easeOut,
      builder: (context, v, _) => ClipRRect(
        borderRadius: BorderRadius.circular(99),
        child: LinearProgressIndicator(value: v, minHeight: height, color: color, backgroundColor: background),
      ),
    );
  }
}
