// The crew as swipeable profile cards (owner, 2026-10-26): swipe sideways through the members, tap "Show profile" to open
// one member's details inside its card, and scroll the Office up and down anywhere without getting stuck. The page grows
// when a profile is open, so nothing needs its own scroll. Every control has a voice-readable label.
import 'package:flutter/material.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';

class CheCrewPager extends StatefulWidget {
  const CheCrewPager({super.key, required this.agents, required this.onOpen, required this.onReadAloud});

  final List<CheAgent> agents;
  final ValueChanged<CheAgent> onOpen;
  final ValueChanged<CheAgent> onReadAloud;

  @override
  State<CheCrewPager> createState() => _CheCrewPagerState();
}

class _CheCrewPagerState extends State<CheCrewPager> {
  final PageController _pages = PageController(viewportFraction: 0.9);
  final Set<String> _open = {};
  int _index = 0;

  @override
  void didUpdateWidget(covariant CheCrewPager old) {
    super.didUpdateWidget(old);
    if (_index >= widget.agents.length) _index = widget.agents.isEmpty ? 0 : widget.agents.length - 1;
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.agents.isEmpty ? null : widget.agents[_index.clamp(0, widget.agents.length - 1)];
    final expanded = current != null && _open.contains(current.id);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
        height: expanded ? 400 : 210,
        // The neighbouring cards stay built, and each card paints on its own layer, so a swipe moves layers instead
        // of building and painting the next card mid-swipe (the screens gate counts dropped frames).
        child: PageView.builder(
          controller: _pages,
          allowImplicitScrolling: true,
          itemCount: widget.agents.length,
          onPageChanged: (i) => setState(() => _index = i),
          itemBuilder: (context, i) => RepaintBoundary(
            child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: _ProfileCard(
              agent: widget.agents[i],
              open: _open.contains(widget.agents[i].id),
              onToggle: () => setState(() {
                final id = widget.agents[i].id;
                if (!_open.remove(id)) _open.add(id);
              }),
              onOpen: () => widget.onOpen(widget.agents[i]),
              onReadAloud: () => widget.onReadAloud(widget.agents[i]),
            ),
            ),
          ),
        ),
      ),
      if (widget.agents.length > 1)
        Padding(
          padding: const EdgeInsets.only(top: CheSpace.sm),
          child: Semantics(
            label: 'Member ${_index + 1} of ${widget.agents.length}. Swipe left or right for the next member.',
            child: Text(
              '${_index + 1} of ${widget.agents.length}  ·  swipe for the next member',
              textAlign: TextAlign.center,
              style: CheType.caption,
            ),
          ),
        ),
    ]);
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({
    required this.agent,
    required this.open,
    required this.onToggle,
    required this.onOpen,
    required this.onReadAloud,
  });

  final CheAgent agent;
  final bool open;
  final VoidCallback onToggle;
  final VoidCallback onOpen;
  final VoidCallback onReadAloud;

  @override
  Widget build(BuildContext context) {
    // The real job the member is on, in words (owner, 2026-10-26); idle members say so.
    final hasTask = agent.task?.isNotEmpty == true;
    final task = hasTask ? 'Working on: ${agent.task}' : 'Idle. No job right now.';
    return Semantics(
      container: true,
      label: '${agent.name}, ${agent.role}, ${agent.status.label}. $task',
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: agent.color.withValues(alpha: 0.6)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            // Tapping the name or the header opens the desk, as the old list did.
            InkWell(
              onTap: onOpen,
              borderRadius: BorderRadius.circular(8),
              child: Row(children: [
                Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(color: agent.color, shape: BoxShape.circle),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(agent.name, style: CheType.title.copyWith(fontSize: 20), maxLines: 1, overflow: TextOverflow.ellipsis)),
                Text(agent.status.label, style: CheType.caption),
              ]),
            ),
            const SizedBox(height: 2),
            Text(agent.role, style: CheType.bodyDim, maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 8),
            Text(task, style: CheType.body, maxLines: open ? 4 : 2, overflow: TextOverflow.ellipsis),
            if (open) ...[
              const SizedBox(height: 10),
              if (agent.specialty.isNotEmpty) _Detail(label: 'Specialty', text: agent.specialty),
              if (agent.personality.isNotEmpty) _Detail(label: 'Personality', text: agent.personality),
            ],
            const Spacer(),
            Wrap(spacing: 8, runSpacing: 8, children: [
              _Action(
                icon: open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                label: open ? 'Hide profile' : 'Show profile',
                semantics: '${open ? 'Hide' : 'Show'} ${agent.name}\'s profile',
                onTap: onToggle,
              ),
              _Action(icon: Icons.open_in_new_rounded, label: 'Open desk', semantics: 'Open ${agent.name}\'s desk', onTap: onOpen),
              _Action(icon: Icons.volume_up_rounded, label: 'Read', semantics: 'Read ${agent.name}\'s profile aloud', onTap: onReadAloud),
            ]),
          ]),
        ),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({required this.label, required this.text});
  final String label;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text('$label: $text', style: CheType.bodyDim, maxLines: 3, overflow: TextOverflow.ellipsis),
      );
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.label, required this.semantics, required this.onTap});
  final IconData icon;
  final String label;
  final String semantics;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 18, color: CheColors.accent),
              const SizedBox(width: 4),
              Text(label, style: CheType.label.copyWith(color: CheColors.accent)),
            ]),
          ),
        ),
      );
}
