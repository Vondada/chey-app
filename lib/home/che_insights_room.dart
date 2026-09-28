// Insights = CHE Brain. Three views in one room:
//   Map   — the existing neural map of what CHE learned on the server
//   Brain — Soul editor, facts in the 7 categories, knowledge graph and
//           CHE's latest private thought (kit CheBrainCard)
//   Log   — every conversation, typed and spoken, word for word, searchable,
//           also saved as files in On My iPhone → CHE → che_logs

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

  final Widget map;
  final CheBrain brain;
  final CheAgentController log;

  /// Opens the Worker's cloud copies of the logs (readable from any device).
  final VoidCallback? onOpenCloudLogs;

  @override
  State<CheInsightsRoom> createState() => _CheInsightsRoomState();
}

class _CheInsightsRoomState extends State<CheInsightsRoom> {
  int _view = 0;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Material(
        color: CheColors.bg,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
              child: SegmentedButton<int>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: 0, icon: Icon(Icons.hub_outlined, size: 16), label: Text('Map')),
                  ButtonSegment(value: 1, icon: Icon(Icons.psychology_alt_outlined, size: 16), label: Text('Brain')),
                  ButtonSegment(value: 2, icon: Icon(Icons.forum_outlined, size: 16), label: Text('Log')),
                ],
                selected: {_view},
                onSelectionChanged: (v) {
                  HapticFeedback.selectionClick();
                  setState(() => _view = v.first);
                },
              ),
            ),
            Expanded(
              child: AnimatedSwitcher(
                duration: CheMotion.base,
                child: switch (_view) {
                  0 => KeyedSubtree(key: const ValueKey('map'), child: widget.map),
                  1 => ListView(
                      key: const ValueKey('brain'),
                      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
                      children: [
                        CheBrainCard(brain: widget.brain, controller: widget.log),
                      ],
                    ),
                  _ => ListView(
                      key: const ValueKey('log'),
                      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
                      children: [
                        CheConversationLogCard(controller: widget.log),
                        const SizedBox(height: CheSpace.md),
                        Text(
                          'Saved word for word on this iPhone: Files → On My iPhone → CHE → che_logs.',
                          style: CheType.caption,
                        ),
                        if (widget.onOpenCloudLogs != null) ...[
                          const SizedBox(height: CheSpace.sm),
                          OutlinedButton.icon(
                            onPressed: widget.onOpenCloudLogs,
                            icon: const Icon(Icons.cloud_outlined, size: 18),
                            label: const Text('Cloud copies on the CHE server'),
                          ),
                        ],
                      ],
                    ),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
