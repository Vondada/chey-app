// Mockup-matched Home: large CHE avatar greeting + primary actions.
// CustomPaint chibi only (no WebView / 3D) for launch performance.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import '../che_ui/che_widgets.dart';
import 'che_office_home_stage.dart';

/// Avatar-first Home hub (mockups 02 / 04) — not chat-first.
class CheMockupHome extends StatelessWidget {
  const CheMockupHome({
    super.key,
    required this.che,
    required this.agents,
    required this.working,
    required this.liveMeetings,
    required this.connected,
    required this.greeting,
    required this.onStartChat,
    required this.onOpenOffice,
    required this.onVoice,
    required this.onQuickTools,
    required this.onOfficeStatus,
    required this.onFindAgent,
    required this.onWarRoom,
    this.listening = false,
    this.onTapAgent,
  });

  final CheAgent che;
  final List<CheAgent> agents;
  final int working;
  final int liveMeetings;
  final bool connected;
  final String greeting;
  final VoidCallback onStartChat;
  final VoidCallback onOpenOffice;
  final VoidCallback onVoice;
  final VoidCallback onQuickTools;
  final VoidCallback onOfficeStatus;
  final VoidCallback onFindAgent;
  final VoidCallback onWarRoom;
  final bool listening;
  final void Function(CheAgent agent)? onTapAgent;

  String get _timeGreeting {
    final h = DateTime.now().hour;
    if (h < 12) return 'Good morning, sir.';
    if (h < 17) return 'Good afternoon, sir.';
    return 'Good evening, sir.';
  }

  @override
  Widget build(BuildContext context) {
    final bubble = greeting.trim().isEmpty
        ? 'Hey sir, I\'m CHE. What can I handle for you today?'
        : greeting.trim();

    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
      children: [
        _HomeHeader(connected: connected, listening: listening),
        const SizedBox(height: CheSpace.md),
        _CheHero(
          che: che,
          greetingLine: _timeGreeting,
          bubble: bubble,
          onTapAvatar: onVoice,
        ),
        const SizedBox(height: CheSpace.lg),
        _PrimaryActions(
          onStartChat: onStartChat,
          onOpenOffice: onOpenOffice,
          onVoice: onVoice,
          onQuickTools: onQuickTools,
          listening: listening,
        ),
        const SizedBox(height: CheSpace.lg),
        CheOfficeHomeStage(
          che: che,
          agents: agents,
          working: working,
          liveMeetings: liveMeetings,
          connected: connected,
          onEnterOffice: onOpenOffice,
          onTapAgent: onTapAgent ?? (_) => onOpenOffice(),
        ),
        const SizedBox(height: CheSpace.md),
        Text('VOICE', style: CheType.overline.copyWith(color: CheColors.accent)),
        const SizedBox(height: CheSpace.sm),
        CheVoiceActionList(
          horizontal: true,
          actions: [
            CheVoiceAction(
              number: 1,
              label: 'Office status',
              icon: Icons.mic_rounded,
              onTap: onOfficeStatus,
              semantics: '1. Office status. Speak or tap for a live Office readout.',
            ),
            CheVoiceAction(
              number: 2,
              label: 'Find an agent',
              icon: Icons.groups_rounded,
              onTap: onFindAgent,
              semantics: '2. Find an agent. Open the Office roster.',
            ),
            CheVoiceAction(
              number: 3,
              label: 'War Room',
              icon: Icons.hub_rounded,
              onTap: onWarRoom,
              semantics: '3. War Room. Convene or open a multi-agent meeting.',
            ),
          ],
        ),
      ],
    );
  }
}

class _HomeHeader extends StatelessWidget {
  const _HomeHeader({required this.connected, required this.listening});
  final bool connected;
  final bool listening;

  @override
  Widget build(BuildContext context) {
    final status = !connected
        ? 'Offline'
        : listening
            ? 'Listening'
            : 'Online';
    final color = !connected
        ? CheColors.danger
        : listening
            ? CheColors.accent
            : CheColors.success;
    return Row(
      children: [
        ShaderMask(
          shaderCallback: (r) => CheColors.accentGradient.createShader(r),
          child: Text(
            'CHE',
            style: CheType.display.copyWith(fontSize: 28, color: Colors.white, letterSpacing: 4),
          ),
        ),
        const Spacer(),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(CheRadius.pill),
            border: Border.all(color: color.withValues(alpha: 0.55)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.circle, size: 8, color: color),
              const SizedBox(width: 6),
              Text(status, style: CheType.caption.copyWith(color: color, fontWeight: FontWeight.w700)),
            ],
          ),
        ),
      ],
    );
  }
}

class _CheHero extends StatelessWidget {
  const _CheHero({
    required this.che,
    required this.greetingLine,
    required this.bubble,
    required this.onTapAvatar,
  });

  final CheAgent che;
  final String greetingLine;
  final String bubble;
  final VoidCallback onTapAvatar;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Semantics(
          button: true,
          label: 'CHE avatar. $greetingLine Double tap to talk.',
          excludeSemantics: true,
          child: GestureDetector(
            onTap: () {
              HapticFeedback.mediumImpact();
              onTapAvatar();
            },
            child: Container(
              width: 168,
              height: 168,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: [
                    CheColors.accent.withValues(alpha: 0.28),
                    CheColors.accent.withValues(alpha: 0.04),
                    Colors.transparent,
                  ],
                ),
                boxShadow: [
                  BoxShadow(
                    color: CheColors.accent.withValues(alpha: 0.35),
                    blurRadius: 36,
                    spreadRadius: 2,
                  ),
                ],
              ),
              alignment: Alignment.center,
              child: CheMiniPerson(agent: che, size: 132, showDesk: false),
            ),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Text(
          greetingLine,
          textAlign: TextAlign.center,
          style: CheType.caption.copyWith(color: CheColors.accent, letterSpacing: 0.4),
        ),
        const SizedBox(height: CheSpace.sm),
        GlowCard(
          radius: CheRadius.lg,
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.format_quote_rounded, color: CheColors.accent.withValues(alpha: 0.7), size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  bubble,
                  style: CheType.body.copyWith(fontSize: 16.5, height: 1.35),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PrimaryActions extends StatelessWidget {
  const _PrimaryActions({
    required this.onStartChat,
    required this.onOpenOffice,
    required this.onVoice,
    required this.onQuickTools,
    required this.listening,
  });

  final VoidCallback onStartChat;
  final VoidCallback onOpenOffice;
  final VoidCallback onVoice;
  final VoidCallback onQuickTools;
  final bool listening;

  @override
  Widget build(BuildContext context) {
    final items = <(IconData, String, String, VoidCallback)>[
      (Icons.chat_bubble_rounded, 'Start Chat', 'Start a chat with CHE', onStartChat),
      (Icons.apartment_rounded, 'Open The Office', 'Open The Office floor', onOpenOffice),
      (listening ? Icons.graphic_eq_rounded : Icons.mic_rounded, 'Voice Mode', 'Voice mode with CHE', onVoice),
      (Icons.grid_view_rounded, 'Quick Tools', 'Open quick tools and apps', onQuickTools),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: CheSpace.sm,
      crossAxisSpacing: CheSpace.sm,
      childAspectRatio: 2.35,
      children: [
        for (final (icon, label, sem, onTap) in items)
          _ActionTile(icon: icon, label: label, semantics: sem, onTap: onTap),
      ],
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.label,
    required this.semantics,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String semantics;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.mediumImpact();
          onTap();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.lg),
            border: Border.all(color: CheColors.accent.withValues(alpha: 0.55)),
            boxShadow: [
              BoxShadow(color: CheColors.accent.withValues(alpha: 0.14), blurRadius: 14),
            ],
          ),
          child: Row(
            children: [
              Icon(icon, color: CheColors.accent, size: 22),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: CheType.label.copyWith(fontSize: 13.5),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
