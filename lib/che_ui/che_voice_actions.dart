// Numbered voice-action rows matching owner mockups (mic + numbered label).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';

class CheVoiceAction {
  const CheVoiceAction({
    required this.number,
    required this.label,
    required this.onTap,
    this.icon = Icons.mic_rounded,
    this.semantics,
  });

  final int number;
  final String label;
  final VoidCallback onTap;
  final IconData icon;
  final String? semantics;
}

/// Vertical list of numbered action bars with mic/action icons (mockups 01, 05).
class CheVoiceActionList extends StatelessWidget {
  const CheVoiceActionList({
    super.key,
    required this.actions,
    this.horizontal = false,
  });

  final List<CheVoiceAction> actions;

  /// When true, lays actions in a horizontal row (Office status / Find / War Room).
  final bool horizontal;

  @override
  Widget build(BuildContext context) {
    if (horizontal) {
      return Row(
        children: [
          for (var i = 0; i < actions.length; i++) ...[
            if (i > 0) const SizedBox(width: CheSpace.sm),
            Expanded(child: _VoiceActionTile(action: actions[i], compact: true)),
          ],
        ],
      );
    }
    return Column(
      children: [
        for (var i = 0; i < actions.length; i++) ...[
          if (i > 0) const SizedBox(height: CheSpace.sm),
          _VoiceActionTile(action: actions[i]),
        ],
      ],
    );
  }
}

class _VoiceActionTile extends StatelessWidget {
  const _VoiceActionTile({required this.action, this.compact = false});
  final CheVoiceAction action;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final label = '${action.number}. ${action.label}';
    return Semantics(
      button: true,
      label: action.semantics ?? 'Voice action ${action.number}: ${action.label}',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            HapticFeedback.selectionClick();
            action.onTap();
          },
          borderRadius: BorderRadius.circular(CheRadius.md),
          child: Ink(
            height: compact ? 52 : 54,
            padding: EdgeInsets.symmetric(horizontal: compact ? 10 : 14),
            decoration: BoxDecoration(
              color: CheColors.surfaceHi,
              borderRadius: BorderRadius.circular(CheRadius.md),
              border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
              boxShadow: [
                BoxShadow(
                  color: CheColors.accent.withValues(alpha: 0.10),
                  blurRadius: 12,
                ),
              ],
            ),
            child: Row(
              children: [
                Container(
                  width: compact ? 28 : 32,
                  height: compact ? 28 : 32,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: CheColors.accent.withValues(alpha: 0.18),
                    border: Border.all(color: CheColors.accent.withValues(alpha: 0.7)),
                    boxShadow: [
                      BoxShadow(
                        color: CheColors.accent.withValues(alpha: 0.35),
                        blurRadius: 10,
                      ),
                    ],
                  ),
                  child: Icon(action.icon, size: compact ? 14 : 16, color: CheColors.accent),
                ),
                SizedBox(width: compact ? 8 : 12),
                Expanded(
                  child: Text(
                    label,
                    maxLines: compact ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.label.copyWith(
                      fontSize: compact ? 12.5 : 15,
                      color: CheColors.text,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
