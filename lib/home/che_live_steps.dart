// Home-screen pieces from the agent-chat design: a live "Thinking… 0.4s"
// timer with step lines while CHE works, delegation chips with the agent's
// mini person, a collapsible "Thought 1.2s" line on finished replies, and
// CHE's own mini person with live Office status next to the orb.

import 'dart:async';

import 'package:flutter/material.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';

class CheLiveStep {
  const CheLiveStep({required this.text, this.agentId, this.agentName});
  final String text;
  final String? agentId;
  final String? agentName;
}

/// Shown under CHE's reply while it is being produced.
class CheLiveStepsView extends StatefulWidget {
  const CheLiveStepsView({
    super.key,
    required this.startedAt,
    required this.steps,
    required this.agents,
    this.onTapAgent,
  });

  final DateTime startedAt;
  final List<CheLiveStep> steps;

  /// Live roster, so delegation chips show the agent's real look and status.
  final List<CheAgent> agents;
  final void Function(CheAgent agent)? onTapAgent;

  @override
  State<CheLiveStepsView> createState() => _CheLiveStepsViewState();
}

class _CheLiveStepsViewState extends State<CheLiveStepsView> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final secs = DateTime.now().difference(widget.startedAt).inMilliseconds / 1000;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.6, color: CheColors.accent),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              'Thinking… ${secs.toStringAsFixed(1)}s',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.caption.copyWith(color: CheColors.accent),
            ),
          ),
        ]),
        for (final step in widget.steps) ...[
          const SizedBox(height: 6),
          _StepLine(step: step, agents: widget.agents, onTapAgent: widget.onTapAgent),
        ],
      ],
    );
  }
}

class _StepLine extends StatelessWidget {
  const _StepLine({required this.step, required this.agents, this.onTapAgent});
  final CheLiveStep step;
  final List<CheAgent> agents;
  final void Function(CheAgent agent)? onTapAgent;

  @override
  Widget build(BuildContext context) {
    CheAgent? agent;
    for (final a in agents) {
      if (a.id == step.agentId) agent = a;
    }
    if (agent == null && step.agentName != null && step.agentId != null) {
      agent = CheAgent(id: step.agentId!, name: step.agentName!, role: '', status: CheAgentStatus.done);
    }
    if (agent != null) {
      final a = agent;
      return Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        runSpacing: 4,
        children: [
          CheAgentChip(agent: a, onTap: onTapAgent == null ? null : () => onTapAgent!(a)),
          Text(step.text, style: CheType.caption),
        ],
      );
    }
    return Text(step.text, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption);
  }
}

/// Collapsible "Thought 1.2s" line with the steps CHE took for a reply.
class CheThoughtLine extends StatefulWidget {
  const CheThoughtLine({super.key, required this.thoughtMs, required this.steps});
  final int? thoughtMs;
  final List<String> steps;
  @override
  State<CheThoughtLine> createState() => _CheThoughtLineState();
}

class _CheThoughtLineState extends State<CheThoughtLine> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final label = widget.thoughtMs == null
        ? 'Steps'
        : 'Thought ${(widget.thoughtMs! / 1000).toStringAsFixed(1)}s';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        GestureDetector(
          onTap: widget.steps.isEmpty ? null : () => setState(() => _open = !_open),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(label, style: CheType.caption),
            if (widget.steps.isNotEmpty)
              Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 16, color: CheColors.textDim),
          ]),
        ),
        AnimatedSize(
          duration: CheMotion.base,
          curve: CheMotion.curve,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [for (final s in widget.steps) Text(s, style: CheType.caption)],
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

/// CHE's mini person + live Office status. Tap opens the Office floor.
class CheOfficePresence extends StatelessWidget {
  const CheOfficePresence({
    super.key,
    required this.che,
    required this.working,
    required this.liveMeetings,
    required this.onTap,
    this.connected = true,
  });

  final CheAgent che;
  final int working;
  final int liveMeetings;
  final bool connected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final label = !connected
        ? 'Office offline'
        : liveMeetings > 0
            ? 'War Room live'
            : working > 0
                ? '$working working'
                : 'Office quiet';
    return Semantics(
      button: true,
      label: 'CHE Office, $label',
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(2, 2, 10, 2),
          decoration: BoxDecoration(
            color: CheColors.office.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(CheRadius.pill),
            border: Border.all(color: CheColors.office.withValues(alpha: working > 0 || liveMeetings > 0 ? 0.8 : 0.35)),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 34, height: 40, child: FittedBox(child: CheMiniPerson(agent: che, size: 34))),
            const SizedBox(width: 4),
            Text(label, maxLines: 1, style: CheType.caption.copyWith(color: CheColors.text)),
          ]),
        ),
      ),
    );
  }
}
