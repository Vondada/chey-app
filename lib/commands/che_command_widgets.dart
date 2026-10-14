// Building blocks of the Command Center, in CHE's dark-teal design. Every
// interactive piece has a VoiceOver label, text wraps for large Dynamic
// Type, and nothing here speaks on its own.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_command_models.dart';

Color cheStatusColor(CheCommandStatus status) => switch (status) {
      CheCommandStatus.available => CheColors.success,
      CheCommandStatus.setupRequired => CheColors.warning,
      CheCommandStatus.unsupported => CheColors.textDim,
      CheCommandStatus.temporarilyUnavailable => CheColors.danger,
      CheCommandStatus.unknown => CheColors.textDim,
    };

Color cheStepColor(String status) => switch (status) {
      'complete' || 'completed' => CheColors.success,
      'running' || 'active' => CheColors.accent,
      'failed' || 'needs_replan' => CheColors.danger,
      'awaiting_approval' || 'paused' => CheColors.warning,
      _ => CheColors.textDim,
    };

IconData cheModeIcon(String mode) => switch (mode) {
      'EXPLORE' => Icons.travel_explore_rounded,
      'PLAN' => Icons.account_tree_rounded,
      'BUILD' => Icons.construction_rounded,
      _ => Icons.bolt_rounded,
    };

/// A small rounded label. Purely visual: the enclosing tile reads it aloud.
class ChePill extends StatelessWidget {
  const ChePill({super.key, required this.text, required this.color, this.icon});
  final String text;
  final Color color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(CheRadius.pill),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 14, color: color), const SizedBox(width: 4)],
          Flexible(child: Text(text, style: CheType.caption.copyWith(color: color, fontWeight: FontWeight.w700))),
        ],
      ),
    );
  }
}

class CheSectionHeader extends StatelessWidget {
  const CheSectionHeader(this.text, {super.key, this.trailing});
  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 18, 4, 8),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              header: true,
              child: Text(text.toUpperCase(), style: CheType.overline.copyWith(color: CheColors.accent)),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// One command in the library: name, purpose, live status, mode, approval.
class CheCommandTile extends StatelessWidget {
  const CheCommandTile({
    super.key,
    required this.command,
    required this.favorite,
    required this.onOpen,
    required this.onToggleFavorite,
  });
  final CheCommandInfo command;
  final bool favorite;
  final VoidCallback onOpen;
  final VoidCallback onToggleFavorite;

  @override
  Widget build(BuildContext context) {
    final status = cheCommandStatusLabel(command.status);
    final label = '${[
      command.slash.replaceAll('-', ' '),
      command.summary,
      status,
      cheModeLabel(command.mode),
      if (command.approvalRequired) 'Needs your approval',
      if (favorite) 'Favorite',
    ].map((p) => p.replaceFirst(RegExp(r'[.\s]+$'), '')).join('. ')}.';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(CheRadius.md),
          onTap: () {
            HapticFeedback.selectionClick();
            onOpen();
          },
          child: Container(
            padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(CheRadius.md),
              border: Border.all(color: CheColors.stroke),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Semantics(
                    button: true,
                    label: label,
                    hint: 'Opens what it does, what it needs and how to run it',
                    excludeSemantics: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(cheModeIcon(command.mode), size: 16, color: CheColors.accent),
                            const SizedBox(width: 6),
                            Flexible(child: Text(command.slash, style: CheType.mono.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700))),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(command.summary, style: CheType.body),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            ChePill(text: status, color: cheStatusColor(command.status)),
                            ChePill(text: command.mode.toLowerCase(), color: CheColors.accentAlt),
                            if (command.approvalRequired)
                              const ChePill(text: 'approval', color: CheColors.warning, icon: Icons.verified_user_rounded),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                IconButton(
                  tooltip: favorite ? 'Remove ${command.slash} from favorites' : 'Add ${command.slash} to favorites',
                  onPressed: () {
                    HapticFeedback.lightImpact();
                    onToggleFavorite();
                  },
                  icon: Icon(favorite ? Icons.star_rounded : Icons.star_outline_rounded,
                      color: favorite ? CheColors.warning : CheColors.textDim),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A workflow run on CHE's mission graph, with the owner's controls.
class CheMissionCard extends StatelessWidget {
  const CheMissionCard({super.key, required this.mission, required this.onControl, this.busy = false});
  final CheMission mission;
  final void Function(String action, {String? stepId}) onControl;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final state = mission.paused && !mission.finished ? 'paused' : mission.status;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: cheStepColor(state).withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(mission.name, style: CheType.headline),
          ),
          const SizedBox(height: 6),
          ChePill(text: cheStepStatusLabel(state), color: cheStepColor(state)),
          const SizedBox(height: 8),
          Text(mission.spoken, style: CheType.bodyDim),
          const SizedBox(height: 10),
          for (final (i, step) in mission.steps.indexed) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.only(left: 10),
                child: ExcludeSemantics(
                  child: Text(step.dependsOn.isEmpty ? '∥' : '↓', style: CheType.caption.copyWith(color: CheColors.textFaint)),
                ),
              ),
            _StepRow(step: step, index: i, busy: busy, onControl: onControl),
          ],
          if (!mission.finished) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (mission.paused)
                  OutlinedButton.icon(
                    onPressed: busy ? null : () => onControl('resume'),
                    icon: const Icon(Icons.play_arrow_rounded),
                    label: const Text('Resume'),
                  )
                else
                  OutlinedButton.icon(
                    onPressed: busy ? null : () => onControl('pause'),
                    icon: const Icon(Icons.pause_rounded),
                    label: const Text('Pause'),
                  ),
                OutlinedButton.icon(
                  onPressed: busy ? null : () => onControl('cancel'),
                  icon: const Icon(Icons.stop_circle_outlined),
                  label: const Text('Cancel run'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step, required this.index, required this.busy, required this.onControl});
  final CheMissionStep step;
  final int index;
  final bool busy;
  final void Function(String action, {String? stepId}) onControl;

  @override
  Widget build(BuildContext context) {
    final label = cheStepStatusLabel(step.status);
    final canRetry = step.failed || (step.status == 'pending' && step.evidence.isNotEmpty);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            label: 'Step ${index + 1}, ${step.title}. $label.${step.verifiedBy.isNotEmpty ? ' Verified by ${step.verifiedBy}.' : ''}',
            excludeSemantics: true,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.circle, size: 10, color: cheStepColor(step.status)),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${index + 1}. ${step.title}', style: CheType.label),
                      Text(label, style: CheType.caption.copyWith(color: cheStepColor(step.status))),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (step.output.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 18, top: 4),
              child: SelectableText(step.output, style: CheType.bodyDim),
            )
          else if (step.evidence.isNotEmpty && (step.failed || canRetry))
            Padding(
              padding: const EdgeInsets.only(left: 18, top: 4),
              child: Text(step.evidence.last, style: CheType.caption),
            ),
          if (step.awaitingApproval || canRetry)
            Padding(
              padding: const EdgeInsets.only(left: 14, top: 4),
              child: Wrap(
                spacing: 8,
                children: [
                  if (step.awaitingApproval)
                    FilledButton.icon(
                      onPressed: busy ? null : () => onControl('approve', stepId: step.id),
                      icon: const Icon(Icons.verified_user_rounded),
                      label: Text('Approve step ${index + 1}'),
                    ),
                  if (canRetry)
                    OutlinedButton.icon(
                      onPressed: busy ? null : () => onControl('retry', stepId: step.id),
                      icon: const Icon(Icons.refresh_rounded),
                      label: Text(step.failed ? 'Retry step ${index + 1}' : 'Run step ${index + 1} now'),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The compact suggestion card under a CHE reply. Tapping a command opens
/// its details; nothing runs from a suggestion.
class CheCommandSuggestionCard extends StatelessWidget {
  const CheCommandSuggestionCard({
    super.key,
    required this.card,
    required this.onOpenCommand,
    required this.onBuildWorkflow,
    required this.onDismiss,
  });
  final CheSuggestionCard card;
  final void Function(String commandId) onOpenCommand;
  final void Function(List<String> commandIds) onBuildWorkflow;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final chain = card.commands.map((c) => '/${c.id}').join(', then ');
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 2, 14, 8),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 10),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const ExcludeSemantics(child: Icon(Icons.bolt_rounded, size: 18, color: CheColors.accent)),
              const SizedBox(width: 6),
              Expanded(
                child: Semantics(
                  label: 'Suggested commands: ${card.label}. $chain. Suggestions do not run anything.',
                  excludeSemantics: true,
                  child: Text(card.label, style: CheType.label.copyWith(color: CheColors.accent)),
                ),
              ),
              IconButton(
                tooltip: 'Dismiss this suggestion',
                visualDensity: VisualDensity.compact,
                onPressed: () {
                  HapticFeedback.selectionClick();
                  onDismiss();
                },
                icon: const Icon(Icons.close_rounded, size: 18, color: CheColors.textDim),
              ),
            ],
          ),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final c in card.commands)
                ActionChip(
                  tooltip: '/${c.id}: ${c.summary}. ${cheCommandStatusLabel(c.status)}. Opens details.',
                  avatar: Icon(Icons.circle, size: 9, color: cheStatusColor(c.status)),
                  label: Text('/${c.id}'),
                  onPressed: () => onOpenCommand(c.id),
                ),
              if (card.commands.length > 1)
                TextButton.icon(
                  onPressed: () => onBuildWorkflow([for (final c in card.commands) c.id]),
                  icon: const Icon(Icons.account_tree_rounded, size: 18),
                  label: const Text('Build workflow'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
