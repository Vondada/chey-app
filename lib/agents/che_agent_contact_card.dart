// Contact-style cards for CHE and every Office agent (owner UI cleanup, 2026-10-25): avatar, name, role, specialty,
// real work state (Working, Queued, Blocked, Finished or Available), the current task or plain availability, and four
// quick actions. Every action has a VoiceOver label and a voice route ("message Atlas in the War Room", "assign a task
// to Atlas", "open Atlas's desk", "what is Atlas working on?"). Nothing on a card is invented: the state and line come
// from CheDeskView, which reads the Office board and the live roster.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import 'che_office_glass.dart';
import 'che_office_status.dart';

/// A distinct round avatar: the agent's own painted mini-person (CHE's portrait when that style is on) over a
/// gradient in the agent's colour, ringed in the real work-state colour. No photos of real people.
class CheAgentAvatar extends StatelessWidget {
  const CheAgentAvatar({super.key, required this.agent, required this.state, this.size = 64});
  final CheAgent agent;
  final CheWorkState state;
  final double size;

  @override
  Widget build(BuildContext context) {
    final base = agent.color;
    final ring = state.color;
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(clipBehavior: Clip.none, children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Color.lerp(base, Colors.white, 0.18)!, Color.lerp(base, Colors.black, 0.62)!],
                ),
                border: Border.all(color: ring, width: 2.2),
                boxShadow: [BoxShadow(color: ring.withValues(alpha: state == CheWorkState.working ? 0.45 : 0.18), blurRadius: size * 0.22)],
              ),
            ),
          ),
          Positioned.fill(
            child: ClipOval(
              child: OverflowBox(
                maxHeight: size * 1.1,
                alignment: Alignment.topCenter,
                child: Padding(
                  padding: EdgeInsets.only(top: size * 0.06),
                  child: CheMiniPerson(agent: agent, size: size * 0.82),
                ),
              ),
            ),
          ),
          Positioned(
            right: -1,
            bottom: -1,
            child: Container(
              width: size * 0.3,
              height: size * 0.3,
              decoration: BoxDecoration(
                color: ring,
                shape: BoxShape.circle,
                border: Border.all(color: const Color(0xFF07111C), width: 2),
              ),
              child: Icon(state.icon, size: size * 0.18, color: const Color(0xFF07111C)),
            ),
          ),
        ]),
      ),
    );
  }
}

/// The small state chip: a coloured dot and the state word.
class CheWorkStatePill extends StatelessWidget {
  const CheWorkStatePill({super.key, required this.state});
  final CheWorkState state;

  @override
  Widget build(BuildContext context) {
    final c = state.color;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(CheRadius.pill),
        border: Border.all(color: c.withValues(alpha: 0.7)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 7, height: 7, decoration: BoxDecoration(color: c, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(state.label, style: CheType.label.copyWith(color: c, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}

/// One contact card. [onMessage], [onAssign], [onOpenDesk] and [onAskStatus] are the quick actions.
class CheAgentContactCard extends StatelessWidget {
  const CheAgentContactCard({
    super.key,
    required this.agent,
    required this.state,
    required this.line,
    required this.onOpenDesk,
    required this.onMessage,
    required this.onAssign,
    required this.onAskStatus,
  });

  final CheAgent agent;
  final CheWorkState state;

  /// The real task for [state], or plain availability (cheWorkLine).
  final String line;
  final VoidCallback onOpenDesk;
  final VoidCallback onMessage;
  final VoidCallback onAssign;
  final VoidCallback onAskStatus;

  String get _who => agent.isChe ? 'CHE' : agent.name;

  @override
  Widget build(BuildContext context) {
    final role = agent.role.isEmpty ? 'Office agent' : agent.role;
    final specialty = agent.specialty.trim();
    final working = state == CheWorkState.working;
    return CheOfficePanel(
      padding: const EdgeInsets.fromLTRB(CheSpace.md, CheSpace.md, CheSpace.md, CheSpace.sm),
      glow: working ? state.color : null,
      legacy: BoxDecoration(
        color: CheColors.surfaceHi,
        borderRadius: BorderRadius.circular(CheRadius.lg),
        border: Border.all(color: working ? state.color.withValues(alpha: 0.6) : CheColors.stroke),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(
          button: true,
          label: '$_who, $role. ${state.label}. $line.'
              '${specialty.isNotEmpty && !agent.isChe ? ' Specialty: $specialty.' : ''} Double tap to open $_who\'s desk.',
          excludeSemantics: true,
          child: InkWell(
            key: ValueKey('agent-card-${agent.id}'),
            borderRadius: BorderRadius.circular(CheRadius.md),
            onTap: () {
              HapticFeedback.selectionClick();
              onOpenDesk();
            },
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              CheAgentAvatar(agent: agent, state: state, size: 62),
              const SizedBox(width: CheSpace.md),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(
                      child: Text(_who, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.headline),
                    ),
                    CheWorkStatePill(state: state),
                  ]),
                  Text(role, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: CheColors.textDim)),
                  if (specialty.isNotEmpty && !agent.isChe)
                    Text(specialty, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
                  const SizedBox(height: 6),
                  Text(
                    line,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.caption.copyWith(color: state == CheWorkState.available ? CheColors.textDim : state.color),
                  ),
                ]),
              ),
            ]),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Row(children: [
          _QuickAction(
            key: ValueKey('agent-message-${agent.id}'),
            icon: Icons.forum_rounded,
            text: 'War Room',
            semantics: agent.isChe ? 'Open a War Room meeting that CHE chairs' : 'Message $_who in the War Room',
            onTap: onMessage,
          ),
          _QuickAction(
            key: ValueKey('agent-assign-${agent.id}'),
            icon: Icons.assignment_ind_rounded,
            text: agent.isChe ? 'Give goal' : 'Assign',
            semantics: agent.isChe ? 'Give CHE an Office goal' : 'Assign a task to $_who',
            onTap: onAssign,
          ),
          _QuickAction(
            key: ValueKey('agent-desk-${agent.id}'),
            icon: Icons.event_seat_rounded,
            text: 'Desk',
            semantics: 'Open $_who\'s desk',
            onTap: onOpenDesk,
          ),
          _QuickAction(
            key: ValueKey('agent-status-${agent.id}'),
            icon: Icons.record_voice_over_rounded,
            text: 'Working on?',
            semantics: 'What are you working on, $_who? Reads $_who\'s real status aloud',
            onTap: onAskStatus,
          ),
        ]),
      ]),
    );
  }
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({super.key, required this.icon, required this.text, required this.semantics, required this.onTap});
  final IconData icon;
  final String text;
  final String semantics;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = cheHudActive ? CheHud.ice : CheColors.accent;
    return Expanded(
      child: Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(CheRadius.sm),
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 20, color: c),
                const SizedBox(height: 2),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(text, maxLines: 1, style: CheType.caption.copyWith(color: CheColors.text, fontWeight: FontWeight.w600)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
