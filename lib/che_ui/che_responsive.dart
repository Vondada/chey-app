// Shared responsive primitives (owner, 2026-10-23: every page fits its real width on iPhone, Android, tablet and
// desktop, portrait and landscape, at any text size). They decide from the actual constraints, never a device guess,
// and keep the HUD look of whatever they hold.
import 'package:flutter/material.dart';

/// A heading line: [leading] widgets and a [title] on the left, [actions] on the right while they fit. When the
/// width (at the current text size) cannot hold both, the actions move to their own line under the title instead of
/// squeezing or clipping it.
class CheTitleRow extends StatelessWidget {
  const CheTitleRow({super.key, this.leading = const [], required this.title, this.actions = const [], this.spacing = 8});

  final List<Widget> leading;
  final Widget title;
  final List<Widget> actions;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: spacing,
      runSpacing: 4,
      children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          for (final w in leading) ...[w, SizedBox(width: spacing)],
          Flexible(child: title),
        ]),
        if (actions.isNotEmpty) Row(mainAxisSize: MainAxisSize.min, children: actions),
      ],
    );
  }
}
