// Insights = CHE Brain — one room.
// Primary: neural constellation / map (dots + breathing links).
// Soul/facts and conversation log open as sheets from the same screen —
// no Map | Brain | Log segmented split.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agent_chat.dart';
import '../che_ui/che_brain.dart';
import '../che_ui/che_log.dart';
import '../che_ui/che_theme.dart';

class CheInsightsRoom extends StatefulWidget {
  const CheInsightsRoom({
    super.key,
    required this.map,
    required this.brain,
    required this.log,
    this.onOpenCloudLogs,
  });

  /// Primary visualization (constellation / neural map). Fills the room.
  final Widget map;
  final CheBrain brain;
  final CheAgentController log;

  /// Opens the Worker's cloud copies of the logs (readable from any device).
  final VoidCallback? onOpenCloudLogs;

  @override
  State<CheInsightsRoom> createState() => _CheInsightsRoomState();
}

class _CheInsightsRoomState extends State<CheInsightsRoom> {
  void _openSoulSheet() {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheColors.surface,
      isScrollControlled: true,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl)),
      ),
      builder: (ctx) {
        final h = MediaQuery.sizeOf(ctx).height * 0.88;
        final bottom = MediaQuery.viewPaddingOf(ctx).bottom;
        return SizedBox(
          height: h,
          child: ListView(
            padding: EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl + bottom),
            children: [
              Text('Soul & facts', style: CheType.title),
              const SizedBox(height: CheSpace.sm),
              Text(
                'Edit CHE’s soul, teach facts, and browse what she knows — same tools as before, from this Brain room.',
                style: CheType.caption,
              ),
              const SizedBox(height: CheSpace.md),
              CheBrainCard(brain: widget.brain, controller: widget.log),
            ],
          ),
        );
      },
    );
  }

  void _openLogSheet() {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheColors.surface,
      isScrollControlled: true,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl)),
      ),
      builder: (ctx) {
        final h = MediaQuery.sizeOf(ctx).height * 0.88;
        final bottom = MediaQuery.viewPaddingOf(ctx).bottom;
        return SizedBox(
          height: h,
          child: ListView(
            padding: EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl + bottom),
            children: [
              Text('Conversation log', style: CheType.title),
              const SizedBox(height: CheSpace.sm),
              Text(
                'Every conversation, typed and spoken — searchable, and saved under Files → On My iPhone → CHE → che_logs.',
                style: CheType.caption,
              ),
              const SizedBox(height: CheSpace.md),
              CheConversationLogCard(controller: widget.log),
              const SizedBox(height: CheSpace.md),
              if (widget.onOpenCloudLogs != null)
                OutlinedButton.icon(
                  onPressed: widget.onOpenCloudLogs,
                  icon: const Icon(Icons.cloud_outlined, size: 18),
                  label: const Text('Cloud copies on the CHE server'),
                ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Material(
        color: CheColors.bg,
        child: Stack(
          children: [
            Positioned.fill(child: widget.map),
            Positioned(
              right: CheSpace.gutter,
              bottom: CheSpace.md + MediaQuery.viewPaddingOf(context).bottom,
              child: Material(
                color: CheColors.surfaceHi.withValues(alpha: 0.94),
                elevation: 6,
                borderRadius: BorderRadius.circular(CheRadius.pill),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _BrainChip(
                        icon: Icons.psychology_alt_outlined,
                        label: 'Soul & facts',
                        onTap: _openSoulSheet,
                      ),
                      const SizedBox(width: 4),
                      _BrainChip(
                        icon: Icons.forum_outlined,
                        label: 'Log',
                        onTap: _openLogSheet,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BrainChip extends StatelessWidget {
  const _BrainChip({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(CheRadius.pill),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: CheColors.accent),
            const SizedBox(width: 6),
            Text(label, style: CheType.caption.copyWith(color: CheColors.text)),
          ],
        ),
      ),
    );
  }
}
