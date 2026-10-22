// CHE 2.0 Home (owner, 2026-10-22): CHE is the centrepiece, lit by her real state; one Talk control; five
// destinations; and only real work underneath. Layered metal surfaces with teal/cyan energy (che_futuristic.dart).
// Nothing speaks on launch (owner rule, 2026-10-11): the state is shown as quiet text, not announced.
// Every value comes from the app's real state: listening, a pending reply, CHE's own speech, the server connection
// and the Office runtime's agents. Nothing here invents activity.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_futuristic.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_widgets.dart';

/// One Home destination: a lit portal into a room.
class CheHomeDestination {
  const CheHomeDestination({
    required this.id,
    required this.label,
    required this.detail,
    required this.icon,
    required this.hue,
    required this.onOpen,
  });

  final String id;
  final String label;
  final String detail;
  final IconData icon;
  final Color hue;
  final VoidCallback onOpen;
}

/// The agents whose real status shows work in progress, newest roster order, at most [limit].
List<CheAgent> cheHomeActiveAgents(List<CheAgent> agents, {int limit = 3}) => agents
    .where((a) =>
        !a.isChe &&
        a.status != CheAgentStatus.idle &&
        a.status != CheAgentStatus.offline &&
        a.status != CheAgentStatus.done)
    .take(limit)
    .toList();

/// CHE's Home: her presence, one Talk control, five destinations and the work that is really running.
class CheMockupHome extends StatelessWidget {
  const CheMockupHome({
    super.key,
    required this.che,
    required this.agents,
    required this.working,
    required this.liveMeetings,
    required this.connected,
    required this.greeting,
    required this.onTalk,
    required this.onOpenChat,
    required this.onOpenOffice,
    required this.onOpenBrain,
    required this.onOpenTrading,
    required this.onOpenCreate,
    required this.onOpenWorld,
    required this.onOfficeStatus,
    this.listening = false,
    this.thinking = false,
    this.speaking = false,
    this.voiceRepliesOn = true,
    this.onToggleVoiceReplies,
    this.onTapAgent,
  });

  final CheAgent che;
  final List<CheAgent> agents;
  final int working;
  final int liveMeetings;
  final bool connected;
  final String greeting;
  final VoidCallback onTalk;
  final VoidCallback onOpenChat;
  final VoidCallback onOpenOffice;
  final VoidCallback onOpenBrain;
  final VoidCallback onOpenTrading;
  final VoidCallback onOpenCreate;
  final VoidCallback onOpenWorld;
  final VoidCallback onOfficeStatus;
  final bool listening;
  final bool thinking;
  final bool speaking;
  final bool voiceRepliesOn;
  final VoidCallback? onToggleVoiceReplies;
  final void Function(CheAgent agent)? onTapAgent;

  CheHomeMode get mode => cheHomeModeFor(
        connected: connected,
        listening: listening,
        thinking: thinking,
        speaking: speaking,
        working: working,
      );

  List<CheHomeDestination> get destinations => [
        CheHomeDestination(
          id: 'office',
          label: 'The Office',
          detail: working == 0 ? 'Team at desks' : '$working working',
          icon: Icons.apartment_rounded,
          hue: CheEnergy.teal,
          onOpen: onOpenOffice,
        ),
        CheHomeDestination(
          id: 'brain',
          label: 'Brain',
          detail: 'Memory',
          icon: Icons.hub_rounded,
          hue: CheEnergy.violet,
          onOpen: onOpenBrain,
        ),
        CheHomeDestination(
          id: 'trading',
          label: 'Trading',
          detail: 'Paper',
          icon: Icons.candlestick_chart_rounded,
          hue: CheEnergy.amber,
          onOpen: onOpenTrading,
        ),
        CheHomeDestination(
          id: 'create',
          label: 'Create',
          detail: 'Pictures, video',
          icon: Icons.auto_awesome_rounded,
          hue: CheEnergy.rose,
          onOpen: onOpenCreate,
        ),
        CheHomeDestination(
          id: 'world',
          label: 'CHE World',
          detail: 'All rooms',
          icon: Icons.public_rounded,
          hue: CheEnergy.cyan,
          onOpen: onOpenWorld,
        ),
      ];

  @override
  Widget build(BuildContext context) {
    final m = mode;
    return DecoratedBox(
      // Layered depth: a dim light from above in CHE's state colour over the near-black background.
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(0, -0.75),
          radius: 1.15,
          colors: [m.color.withValues(alpha: 0.10), CheColors.bg],
        ),
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
        children: [
          _HomeHeader(mode: m, voiceRepliesOn: voiceRepliesOn, onToggleVoiceReplies: onToggleVoiceReplies),
          const SizedBox(height: CheSpace.md),
          _CheStage(che: che, mode: m, working: working, greeting: greeting.trim()),
          const SizedBox(height: CheSpace.md),
          _TalkControl(listening: listening, onTalk: onTalk, onOpenChat: onOpenChat),
          const SizedBox(height: CheSpace.lg),
          _Destinations(items: destinations),
          const SizedBox(height: CheSpace.lg),
          _NowPanel(
            active: cheHomeActiveAgents(agents),
            liveMeetings: liveMeetings,
            onOfficeStatus: onOfficeStatus,
            onTapAgent: onTapAgent ?? (_) => onOpenOffice(),
          ),
        ],
      ),
    );
  }
}

class _HomeHeader extends StatelessWidget {
  const _HomeHeader({required this.mode, required this.voiceRepliesOn, this.onToggleVoiceReplies});

  final CheHomeMode mode;
  final bool voiceRepliesOn;
  final VoidCallback? onToggleVoiceReplies;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // The CHE wordmark in brushed silver with a teal edge.
        ExcludeSemantics(
          child: ShaderMask(
            shaderCallback: (rect) => const LinearGradient(
              colors: [CheEnergy.silverHi, CheEnergy.silver, CheEnergy.teal],
              stops: [0.0, 0.55, 1.0],
            ).createShader(rect),
            child: const Text(
              'CHE',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 4, color: Colors.white),
            ),
          ),
        ),
        const SizedBox(width: CheSpace.md),
        Semantics(
          label: 'CHE is ${mode.label.toLowerCase()}',
          excludeSemantics: true,
          child: _StateChip(mode: mode),
        ),
        const Spacer(),
        if (onToggleVoiceReplies != null)
          Semantics(
            button: true,
            label: voiceRepliesOn ? 'Voice on. Double tap to mute CHE\'s replies.' : 'Voice off. Double tap to hear CHE\'s replies.',
            excludeSemantics: true,
            child: ChePressable(
              onTap: onToggleVoiceReplies,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: CheColors.surface,
                    borderRadius: BorderRadius.circular(CheRadius.pill),
                    border: Border.all(
                      color: voiceRepliesOn ? CheEnergy.teal.withValues(alpha: 0.6) : CheEnergy.gunmetal,
                    ),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(
                      voiceRepliesOn ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                      size: 16,
                      color: voiceRepliesOn ? CheEnergy.teal : CheColors.textDim,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      voiceRepliesOn ? 'Voice on' : 'Voice off',
                      style: CheType.caption.copyWith(
                        color: voiceRepliesOn ? CheEnergy.teal : CheColors.textDim,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _StateChip extends StatelessWidget {
  const _StateChip({required this.mode});

  final CheHomeMode mode;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: mode.color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(CheRadius.pill),
        border: Border.all(color: mode.color.withValues(alpha: 0.55)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: mode.color,
            shape: BoxShape.circle,
            boxShadow: [BoxShadow(color: mode.color.withValues(alpha: 0.7), blurRadius: 6)],
          ),
        ),
        const SizedBox(width: 6),
        Text(mode.label, style: CheType.caption.copyWith(color: mode.color, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}

/// CHE in her lit stage: the energy ring follows her real state, and the sentence below says it in words.
class _CheStage extends StatelessWidget {
  const _CheStage({required this.che, required this.mode, required this.working, required this.greeting});

  final CheAgent che;
  final CheHomeMode mode;
  final int working;
  final String greeting;

  @override
  Widget build(BuildContext context) {
    final sentence = cheHomeModeSentence(mode, working: working);
    final size = (MediaQuery.sizeOf(context).width * 0.56).clamp(180.0, 260.0);
    return CheMetalPanel(
      glow: mode.color,
      radius: CheRadius.xl,
      padding: const EdgeInsets.fromLTRB(CheSpace.lg, CheSpace.lg, CheSpace.lg, CheSpace.lg),
      child: Column(children: [
        Semantics(
          image: true,
          label: 'CHE. $sentence',
          excludeSemantics: true,
          child: CheEnergyRing(
            mode: mode,
            size: size,
            child: CheMiniPerson(agent: che, size: size * 0.66, showDesk: false),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        ExcludeSemantics(
          child: Text(
            sentence,
            textAlign: TextAlign.center,
            style: CheType.label.copyWith(color: mode.color, letterSpacing: 0.3),
          ),
        ),
        if (greeting.isNotEmpty) ...[
          const SizedBox(height: CheSpace.sm),
          Text(
            greeting,
            textAlign: TextAlign.center,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: CheType.body.copyWith(color: CheColors.textDim, height: 1.35),
          ),
        ],
      ]),
    );
  }
}

/// The one Talk control, plus a quiet way to type instead.
class _TalkControl extends StatelessWidget {
  const _TalkControl({required this.listening, required this.onTalk, required this.onOpenChat});

  final bool listening;
  final VoidCallback onTalk;
  final VoidCallback onOpenChat;

  @override
  Widget build(BuildContext context) {
    final label = listening ? 'Stop listening' : 'Talk to CHE';
    final colors = listening ? [CheEnergy.red, const Color(0xFFFF8A6B)] : [CheEnergy.teal, CheEnergy.cyan];
    return Row(children: [
      Expanded(
        child: Semantics(
          button: true,
          label: listening ? 'Stop listening.' : 'Talk to CHE. Starts a voice conversation.',
          excludeSemantics: true,
          child: ChePressable(
            onTap: () {
              HapticFeedback.mediumImpact();
              onTalk();
            },
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              height: 58,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.pill),
                gradient: LinearGradient(colors: colors),
                boxShadow: [BoxShadow(color: colors.first.withValues(alpha: 0.40), blurRadius: 20, spreadRadius: -2)],
              ),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(listening ? Icons.stop_rounded : Icons.mic_rounded, color: const Color(0xFF041014), size: 24),
                const SizedBox(width: 10),
                Text(
                  label,
                  style: const TextStyle(color: Color(0xFF041014), fontSize: 18, fontWeight: FontWeight.w800),
                ),
              ]),
            ),
          ),
        ),
      ),
      const SizedBox(width: CheSpace.sm),
      Semantics(
        button: true,
        label: 'Type to CHE. Opens Chat.',
        excludeSemantics: true,
        child: ChePressable(
          onTap: onOpenChat,
          child: Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: CheColors.surfaceHi,
              border: Border.all(color: CheEnergy.silver.withValues(alpha: 0.45)),
            ),
            child: Icon(Icons.keyboard_rounded, color: CheColors.text),
          ),
        ),
      ),
    ]);
  }
}

/// Five lit portals, three across, so every destination is visible without scrolling on a phone.
class _Destinations extends StatelessWidget {
  const _Destinations({required this.items});

  final List<CheHomeDestination> items;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      const gap = CheSpace.sm;
      final columns = box.maxWidth >= 520 ? 5 : 3;
      final width = (box.maxWidth - gap * (columns - 1)) / columns;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [for (final d in items) SizedBox(width: width, child: _Portal(item: d))],
      );
    });
  }
}

class _Portal extends StatelessWidget {
  const _Portal({required this.item});

  final CheHomeDestination item;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '${item.label}. ${item.detail}. Double tap to open.',
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.selectionClick();
          item.onOpen();
        },
        child: CheMetalPanel(
          glow: item.hue,
          radius: CheRadius.lg,
          padding: const EdgeInsets.fromLTRB(10, 12, 10, 12),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [item.hue.withValues(alpha: 0.35), item.hue.withValues(alpha: 0.05)]),
                border: Border.all(color: item.hue.withValues(alpha: 0.7)),
              ),
              child: Icon(item.icon, color: item.hue, size: 21),
            ),
            const SizedBox(height: 8),
            Text(
              item.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.label.copyWith(fontSize: 14, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 2),
            Text(
              item.detail,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.caption.copyWith(color: CheColors.textDim),
            ),
          ]),
        ),
      ),
    );
  }
}

/// The work that is really running: agents whose runtime status is active, and live meetings. Nothing else.
class _NowPanel extends StatelessWidget {
  const _NowPanel({
    required this.active,
    required this.liveMeetings,
    required this.onOfficeStatus,
    required this.onTapAgent,
  });

  final List<CheAgent> active;
  final int liveMeetings;
  final VoidCallback onOfficeStatus;
  final void Function(CheAgent agent) onTapAgent;

  @override
  Widget build(BuildContext context) {
    return CheMetalPanel(
      radius: CheRadius.lg,
      padding: const EdgeInsets.fromLTRB(14, 12, 6, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('NOW', style: CheType.overline.copyWith(color: CheEnergy.teal, letterSpacing: 1.6)),
          const Spacer(),
          Semantics(
            button: true,
            label: 'Read the Office status aloud.',
            excludeSemantics: true,
            child: TextButton.icon(
              onPressed: onOfficeStatus,
              icon: const Icon(Icons.volume_up_rounded, size: 18),
              label: const Text('Read status'),
              style: TextButton.styleFrom(foregroundColor: CheEnergy.teal, minimumSize: const Size(44, 44)),
            ),
          ),
        ]),
        if (active.isEmpty && liveMeetings == 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, right: 8),
            child: Text('No work is running right now.', style: CheType.body.copyWith(color: CheColors.textDim)),
          ),
        if (liveMeetings > 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, right: 8),
            child: Text(
              liveMeetings == 1 ? '1 meeting is live in the War Room.' : '$liveMeetings meetings are live in the War Room.',
              style: CheType.body.copyWith(color: CheEnergy.violet),
            ),
          ),
        for (final a in active)
          Semantics(
            button: true,
            label: '${a.name}, ${a.status.label}${a.task == null || a.task!.isEmpty ? '' : ': ${a.task}'}. Double tap to open the Office.',
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(CheRadius.md),
              onTap: () => onTapAgent(a),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(children: [
                  Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(color: a.color, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text.rich(
                      TextSpan(children: [
                        TextSpan(text: '${a.name} ', style: const TextStyle(fontWeight: FontWeight.w700)),
                        TextSpan(text: a.status.label, style: TextStyle(color: CheEnergy.amber)),
                        if (a.task != null && a.task!.isNotEmpty)
                          TextSpan(text: ' · ${a.task}', style: TextStyle(color: CheColors.textDim)),
                      ]),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.body,
                    ),
                  ),
                  Icon(Icons.chevron_right_rounded, color: CheColors.textDim),
                ]),
              ),
            ),
          ),
      ]),
    );
  }
}
