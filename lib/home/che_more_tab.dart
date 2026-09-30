// More tab — Settings / Knowledge / Voice entry points (mockups 02 / 04).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_widgets.dart';

class CheMoreItem {
  const CheMoreItem({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.hue,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final Color? hue;
}

/// Settings-style More hub with CHE profile header.
class CheMoreTab extends StatelessWidget {
  const CheMoreTab({
    super.key,
    required this.che,
    required this.items,
    this.onTalkToChe,
  });

  final CheAgent che;
  final List<CheMoreItem> items;
  final VoidCallback? onTalkToChe;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewPaddingOf(context).bottom;
    return ListView(
      padding: EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl + bottom),
      children: [
        Text('Settings', style: CheType.title),
        const SizedBox(height: 4),
        Text('Your CHE profile and controls.', style: CheType.bodyDim),
        const SizedBox(height: CheSpace.lg),
        GlowCard(
          radius: CheRadius.lg,
          child: Row(
            children: [
              CheMiniPerson(agent: che, size: 64),
              const SizedBox(width: CheSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(che.name, style: CheType.headline),
                    Text(che.role, style: CheType.caption),
                    const SizedBox(height: 4),
                    Text(
                      che.task?.isNotEmpty == true ? che.task! : 'Ready when you are, sir.',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.bodyDim,
                    ),
                  ],
                ),
              ),
              if (onTalkToChe != null)
                CheIconButton(
                  icon: Icons.chat_bubble_rounded,
                  glow: true,
                  onTap: onTalkToChe!,
                  tooltip: 'Talk to CHE',
                ),
            ],
          ),
        ),
        const SizedBox(height: CheSpace.lg),
        for (final item in items) ...[
          _MoreRow(item: item),
          const SizedBox(height: CheSpace.sm),
        ],
      ],
    );
  }
}

class _MoreRow extends StatelessWidget {
  const _MoreRow({required this.item});
  final CheMoreItem item;

  @override
  Widget build(BuildContext context) {
    final hue = item.hue ?? CheColors.accent;
    return Semantics(
      button: true,
      label: '${item.title}. ${item.subtitle}',
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.selectionClick();
          item.onTap();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.lg),
            border: Border.all(color: CheColors.stroke),
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: hue.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(CheRadius.sm),
                  border: Border.all(color: hue.withValues(alpha: 0.45)),
                ),
                child: Icon(item.icon, color: hue, size: 20),
              ),
              const SizedBox(width: CheSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.title, style: CheType.headline),
                    Text(item.subtitle, style: CheType.caption),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
            ],
          ),
        ),
      ),
    );
  }
}
