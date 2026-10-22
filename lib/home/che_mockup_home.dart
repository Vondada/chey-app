// CHE 2.0 Home (owner, 2026-10-22): CHE is the centrepiece, lit by her real state; one Talk control; five
// destinations; and only real work underneath. Layered metal surfaces with teal/cyan energy (che_futuristic.dart).
// Nothing speaks on launch (owner rule, 2026-10-11): the state is shown as quiet text, not announced.
// Every value comes from the app's real state: listening, a pending reply, CHE's own speech, the server connection
// and the Office runtime's agents. Nothing here invents activity.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_agents.dart';
import '../che_ui/che_futuristic.dart';
import '../che_ui/che_clock.dart';
import '../che_ui/che_hud.dart';
import 'che_home_tiles.dart';
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
    this.unread = 0,
    this.onOpenFlagstaff,
    this.latencyMs,
    this.handsFree = false,
    this.baseUrl,
    this.headers,
    this.now,
    this.marketClient,
  });

  /// The HTTP client for the MNQ tile, for tests; null uses a fresh client per request.
  final http.Client? marketClient;

  /// Flagstaff's unread count and its opener (HUD look).
  final int unread;
  final VoidCallback? onOpenFlagstaff;

  /// The last measured round trip to CHE's server, in milliseconds; null until one is measured.
  final int? latencyMs;

  /// Hands-free wake is on, so "say CHE" is true.
  final bool handsFree;

  /// The Worker address and headers for the MNQ tile; without them the tile shows no price.
  final String Function()? baseUrl;
  final Map<String, String> Function()? headers;

  /// The clock, for tests; null uses the device clock.
  final DateTime Function()? now;

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
          hue: cheHudActive ? CheHud.ice : CheEnergy.teal,
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
    if (cheHudActive) return _hudHome(context, m);
    return DecoratedBox(
      // Layered depth: a dim light from above in CHE's state colour. In the HUD look the backdrop shows through.
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(0, -0.75),
          radius: 1.15,
          colors: [m.color.withValues(alpha: 0.10), cheHudActive ? Colors.transparent : CheColors.bg],
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
    // A wrap, not a row: with large text the voice switch moves to the next line instead of overflowing.
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      runSpacing: CheSpace.sm,
      children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
        // The CHE wordmark in brushed silver with a teal edge.
        ExcludeSemantics(
          child: ShaderMask(
            shaderCallback: (rect) => (cheHudActive
                    ? CheHud.chrome
                    : const LinearGradient(
                        colors: [CheEnergy.silverHi, CheEnergy.silver, CheEnergy.teal],
                        stops: [0.0, 0.55, 1.0],
                      ))
                .createShader(rect),
            child: const Text(
              'CHE',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 4, color: Colors.white),
            ),
          ),
        ),
        const SizedBox(width: CheSpace.md),
        Semantics(
          container: true,
          label: 'CHE is ${mode.label.toLowerCase()}',
          excludeSemantics: true,
          child: _StateChip(mode: mode),
        ),
        ]),
        if (onToggleVoiceReplies != null)
          Semantics(
            container: true,
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
                    color: cheHudActive ? Colors.white.withValues(alpha: 0.06) : CheColors.surface,
                    borderRadius: BorderRadius.circular(CheRadius.pill),
                    border: Border.all(
                      color: voiceRepliesOn ? (cheHudActive ? CheHud.ice : CheEnergy.teal).withValues(alpha: 0.6) : CheEnergy.gunmetal,
                    ),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(
                      voiceRepliesOn ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                      size: 16,
                      color: voiceRepliesOn ? (cheHudActive ? CheHud.ice : CheEnergy.teal) : CheColors.textDim,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      voiceRepliesOn ? 'Voice on' : 'Voice off',
                      style: CheType.caption.copyWith(
                        color: voiceRepliesOn ? (cheHudActive ? CheHud.ice : CheEnergy.teal) : CheColors.textDim,
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

  // HUD readouts beside the reactor, from real state only: the server link (offline mode means no connection), CHE's
  // mode and the number of agents working. VoiceOver reads the sentence below instead.
  Widget _hudReadouts(Widget reactor) {
    if (!cheHudActive) return reactor;
    final style = CheHud.label.copyWith(fontSize: 9, letterSpacing: 1.0, height: 1.45, color: const Color(0xFFBFEFFF));
    return Stack(clipBehavior: Clip.none, alignment: Alignment.center, children: [
      reactor,
      Positioned(
        left: -CheSpace.md,
        top: -CheSpace.sm,
        child: Text(
          '${mode == CheHomeMode.offline ? 'LINK DOWN' : 'LINK ONLINE'}\nMODE ${mode.label.toUpperCase()}',
          style: style,
        ),
      ),
      Positioned(
        right: -CheSpace.md,
        top: -CheSpace.sm,
        child: Text('AGENTS $working\n${working == 0 ? 'STANDBY' : 'ACTIVE'}', textAlign: TextAlign.right, style: style),
      ),
    ]);
  }

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
          container: true,
          image: true,
          label: 'CHE. $sentence',
          excludeSemantics: true,
          child: _hudReadouts(CheEnergyRing(
            mode: mode,
            size: size,
            // HUD: CHE's chrome emblem (the approved concept) instead of the cropped portrait. A phone whose installed
            // build does not carry the image yet falls back to the portrait, never to a blank stage.
            child: cheHudActive
                ? Image.asset(
                    'assets/avatars/che_emblem.png',
                    width: size * 0.64,
                    height: size * 0.64,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => CheMiniPerson(agent: che, size: size * 0.66, showDesk: false, painted: true),
                  )
                : CheMiniPerson(agent: che, size: size * 0.66, showDesk: false, painted: true),
          )),
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
    if (cheHudActive) return _hud(context, label);
    final colors = listening ? [CheEnergy.red, const Color(0xFFFF8A6B)] : [CheEnergy.teal, CheEnergy.cyan];
    return Row(children: [
      Expanded(
        child: Semantics(
          container: true,
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
                // With very large text the label shrinks to fit the button instead of overflowing it.
                Flexible(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      label,
                      style: const TextStyle(color: Color(0xFF041014), fontSize: 18, fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
      const SizedBox(width: CheSpace.sm),
      Semantics(
        container: true,
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

extension on _TalkControl {
  // HUD: one glass bar with a chrome microphone orb; the keyboard button opens Chat to type.
  Widget _hud(BuildContext context, String label) {
    final orbColor = listening ? CheEnergy.red : CheHud.ice;
    return CheGlass(
      radius: 36,
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      glow: listening ? CheEnergy.red : CheHud.iceDeep,
      child: Row(children: [
        Expanded(
          child: Semantics(
            container: true,
            button: true,
            label: listening ? 'Stop listening.' : 'Talk to CHE. Starts a voice conversation.',
            excludeSemantics: true,
            child: ChePressable(
              onTap: () {
                HapticFeedback.mediumImpact();
                onTalk();
              },
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 54),
                child: Row(children: [
                  CheChromeOrb(
                    size: 54,
                    color: orbColor,
                    child: Icon(listening ? Icons.stop_rounded : Icons.mic_rounded, color: const Color(0xFF07121E), size: 26),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(label, style: CheType.headline.copyWith(fontSize: 18, fontWeight: FontWeight.w700)),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        listening ? 'LISTENING' : 'VOICE',
                        maxLines: 1,
                        style: CheHud.label.copyWith(color: listening ? CheEnergy.red : CheHud.ice),
                      ),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
        ),
        const SizedBox(width: CheSpace.sm),
        Semantics(
          container: true,
          button: true,
          label: 'Type to CHE. Opens Chat.',
          excludeSemantics: true,
          child: ChePressable(
            onTap: onOpenChat,
            child: Container(
              width: 50,
              height: 50,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withValues(alpha: 0.08),
                border: Border.all(color: Colors.white.withValues(alpha: 0.35)),
              ),
              child: Icon(Icons.keyboard_rounded, color: CheColors.text, size: 22),
            ),
          ),
        ),
      ]),
    );
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
      container: true,
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
          Text('NOW', style: cheHudActive ? CheHud.label : CheType.overline.copyWith(color: CheEnergy.teal, letterSpacing: 1.6)),
          const Spacer(),
          Semantics(
            container: true,
            button: true,
            label: 'Read the Office status aloud.',
            excludeSemantics: true,
            child: TextButton.icon(
              onPressed: onOfficeStatus,
              icon: const Icon(Icons.volume_up_rounded, size: 18),
              label: const Text('Read status'),
              style: TextButton.styleFrom(foregroundColor: cheHudActive ? CheHud.ice : CheEnergy.teal, minimumSize: const Size(44, 44)),
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
            container: true,
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


// ─── HUD Home (owner, 2026-10-22: "I actually like this style better", the concept render) ────────────────────────
// The greeting and date, CHE's reactor with live readouts, one Talk bar, four glass tiles of real data, the other
// rooms, and the work that is really running. Every value is real; a tile without data says so.
extension on CheMockupHome {
  Widget _hudHome(BuildContext context, CheHomeMode m) {
    final now = this.now?.call() ?? DateTime.now();
    final chicago = CheChicagoTime.at(now);
    final hour = chicago.local.hour;
    final hello = hour < 5 ? 'Good evening.' : hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
    const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    final dateLine = '${days[chicago.local.weekday - 1]} · ${chicago.local.day} ${months[chicago.local.month - 1]} · ${cheTwelveHour(chicago.local.hour, chicago.local.minute)} ${chicago.zone}';
    final team = agents.where((a) => !a.isChe).length;
    final width = MediaQuery.sizeOf(context).width;
    final reactor = (width * 0.66).clamp(220.0, 300.0);
    final sentence = cheHomeModeSentence(m, working: working);
    final byId = {for (final d in destinations) d.id: d};

    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter + 4, CheSpace.sm, CheSpace.gutter + 4, CheSpace.xxl),
      children: [
        // Date, greeting, voice switch and Flagstaff bell.
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(dateLine, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 10.5)),
              const SizedBox(height: 6),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Semantics(header: true, child: CheChromeText(hello, style: const TextStyle(fontSize: 31, fontWeight: FontWeight.w700, letterSpacing: -0.8))),
              ),
            ]),
          ),
          if (onToggleVoiceReplies != null) ...[
            _HudRoundButton(
              icon: voiceRepliesOn ? Icons.volume_up_rounded : Icons.volume_off_rounded,
              label: voiceRepliesOn ? 'Voice on. Double tap to mute CHE\'s replies.' : 'Voice off. Double tap to hear CHE\'s replies.',
              onTap: onToggleVoiceReplies!,
            ),
            const SizedBox(width: CheSpace.sm),
          ],
          if (onOpenFlagstaff != null)
            _HudRoundButton(
              icon: Icons.mail_outline_rounded,
              label: unread > 0 ? 'Flagstaff, $unread unread. Messages, reports and notices.' : 'Flagstaff. Messages, reports and notices.',
              badge: unread,
              onTap: onOpenFlagstaff!,
            ),
        ]),
        const SizedBox(height: CheSpace.md),
        // CHE's reactor, free in space, with readouts from real state.
        Center(
          child: Semantics(
            container: true,
            image: true,
            label: 'CHE. $sentence',
            excludeSemantics: true,
            child: SizedBox(
              width: reactor + 70,
              height: reactor,
              child: Stack(clipBehavior: Clip.none, alignment: Alignment.center, children: [
                CheEnergyRing(
                  mode: m,
                  size: reactor,
                  child: Image.asset(
                    'assets/avatars/che_emblem.png',
                    width: reactor * 0.64,
                    height: reactor * 0.64,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => CheMiniPerson(agent: che, size: reactor * 0.66, showDesk: false, painted: true),
                  ),
                ),
                Positioned(
                  left: 0,
                  top: 6,
                  child: Text('${m == CheHomeMode.offline ? 'LINK DOWN' : 'LINK SECURE'}\nMODE ${m.label.toUpperCase()}', style: _readout),
                ),
                Positioned(
                  right: 0,
                  top: 6,
                  child: Text('AGENTS $working\n${latencyMs == null ? 'LAT —' : 'LAT $latencyMs ms'}', textAlign: TextAlign.right, style: _readout),
                ),
              ]),
            ),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Semantics(
          container: true,
          label: 'CHE is ${m.label.toLowerCase()}',
          excludeSemantics: true,
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: m.color, shape: BoxShape.circle, boxShadow: [BoxShadow(color: m.color.withValues(alpha: 0.8), blurRadius: 8)]),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                m == CheHomeMode.offline ? 'CHE OFFLINE' : 'CHE ONLINE · ${m.label.toUpperCase()}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: CheHud.label.copyWith(fontSize: 12, letterSpacing: 2.6, color: m.color, shadows: [Shadow(color: m.color.withValues(alpha: 0.7), blurRadius: 12)]),
              ),
            ),
          ]),
        ),
        const SizedBox(height: CheSpace.md),
        _HudTalkBar(listening: listening, handsFree: handsFree, onTalk: onTalk, onOpenChat: onOpenChat),
        const SizedBox(height: CheSpace.lg),
        // Four tiles of real data.
        LayoutBuilder(builder: (context, box) {
          const gap = 12.0;
          final half = (box.maxWidth - gap) / 2;
          final trading = byId['trading']!;
          // Each pair of tiles keeps one height, set by the taller tile (large text grows both).
          return Column(children: [
            IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              SizedBox(
                width: half,
                child: baseUrl == null
                    ? CheHudTile(
                        semantics: '${trading.label}. ${trading.detail}. Double tap to open.',
                        onTap: trading.onOpen,
                        leanRight: true,
                        height: 140,
                        child: Text('MNQ', style: CheHud.label),
                      )
                    : CheHomeMarketTile(baseUrl: baseUrl!, headers: headers ?? () => const {}, onOpen: trading.onOpen, client: marketClient),
              ),
              const SizedBox(width: gap),
              SizedBox(width: half, child: CheHomeFlagstaffTile(unread: unread, onOpen: onOpenFlagstaff ?? onOpenChat)),
            ])),
            const SizedBox(height: gap),
            IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              SizedBox(width: half, child: CheHomeOfficeTile(working: working, total: team, onOpen: onOpenOffice)),
              const SizedBox(width: gap),
              SizedBox(width: half, child: CheHomeNextTile(now: now, onOpen: trading.onOpen)),
            ])),
          ]);
        }),
        const SizedBox(height: CheSpace.md),
        // The rooms without a tile.
        Row(children: [
          for (final id in const ['brain', 'create', 'world']) ...[
            if (id != 'brain') const SizedBox(width: CheSpace.sm),
            Expanded(child: _HudRoomPill(item: byId[id]!)),
          ],
        ]),
        const SizedBox(height: CheSpace.lg),
        _NowPanel(
          active: cheHomeActiveAgents(agents),
          liveMeetings: liveMeetings,
          onOfficeStatus: onOfficeStatus,
          onTapAgent: onTapAgent ?? (_) => onOpenOffice(),
        ),
      ],
    );
  }

  TextStyle get _readout => CheHud.label.copyWith(fontSize: 9.5, letterSpacing: 1.1, height: 1.5, color: const Color(0xFFBFEFFF));
}

class _HudRoundButton extends StatelessWidget {
  const _HudRoundButton({required this.icon, required this.label, required this.onTap, this.badge = 0});

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final int badge;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      button: true,
      label: label,
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: SizedBox(
          width: 50,
          height: 50,
          child: Stack(clipBehavior: Clip.none, children: [
            CheGlass(
              radius: 25,
              shadow: false,
              child: Center(child: Icon(icon, size: 21, color: CheColors.text)),
            ),
            if (badge > 0)
              Positioned(
                top: -4,
                right: -4,
                child: Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  height: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 5),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFE9FBFF), Color(0xFF7FDCFF)]),
                    boxShadow: [BoxShadow(color: CheHud.iceDeep.withValues(alpha: 0.9), blurRadius: 12)],
                  ),
                  child: Text(badge > 99 ? '99+' : '$badge', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: Color(0xFF03101C))),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

class _HudTalkBar extends StatelessWidget {
  const _HudTalkBar({required this.listening, required this.handsFree, required this.onTalk, required this.onOpenChat});

  final bool listening;
  final bool handsFree;
  final VoidCallback onTalk;
  final VoidCallback onOpenChat;

  @override
  Widget build(BuildContext context) {
    final color = listening ? CheEnergy.red : CheHud.ice;
    return CheGlass(
      radius: 36,
      padding: const EdgeInsets.all(8),
      glow: listening ? CheEnergy.red : null,
      child: Row(children: [
        Expanded(
          child: Semantics(
            container: true,
            button: true,
            label: listening ? 'Stop listening.' : 'Talk to CHE. Starts a voice conversation.',
            excludeSemantics: true,
            child: ChePressable(
              onTap: () {
                HapticFeedback.mediumImpact();
                onTalk();
              },
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 54),
                child: Row(children: [
                  CheChromeOrb(
                    size: 54,
                    color: color,
                    child: Icon(listening ? Icons.stop_rounded : Icons.mic_rounded, color: const Color(0xFF07121E), size: 26),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(listening ? 'Stop listening' : 'Talk to CHE', style: CheType.headline.copyWith(fontSize: 18, fontWeight: FontWeight.w700)),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        listening ? 'LISTENING' : handsFree ? 'TAP OR SAY “CHE”' : 'TAP TO TALK',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: CheHud.label.copyWith(color: color),
                      ),
                    ]),
                  ),
                  // A still waveform, brighter while listening (decoration only).
                  ExcludeSemantics(
                    child: SizedBox(width: 60, height: 28, child: CustomPaint(painter: _WavePainter(color: color, bright: listening))),
                  ),
                  const SizedBox(width: 8),
                ]),
              ),
            ),
          ),
        ),
        Semantics(
          container: true,
          button: true,
          label: 'Type to CHE. Opens Chat.',
          excludeSemantics: true,
          child: ChePressable(
            onTap: onOpenChat,
            child: Container(
              width: 50,
              height: 50,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withValues(alpha: 0.08),
                border: Border.all(color: Colors.white.withValues(alpha: 0.35)),
              ),
              child: Icon(Icons.keyboard_rounded, color: CheColors.text, size: 22),
            ),
          ),
        ),
      ]),
    );
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter({required this.color, required this.bright});

  final Color color;
  final bool bright;
  static const _heights = [6.0, 14, 22, 12, 26, 16, 9, 20, 13, 7, 17, 10];

  @override
  void paint(Canvas canvas, Size size) {
    final step = size.width / _heights.length;
    for (var i = 0; i < _heights.length; i++) {
      final h = _heights[i] * size.height / 28;
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(step * i + step / 2, size.height / 2), width: 2.4, height: h), const Radius.circular(1.2)),
        Paint()..color = color.withValues(alpha: (bright ? 0.6 : 0.35) + 0.4 * (_heights[i] / 26)),
      );
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => old.color != color || old.bright != bright;
}

class _HudRoomPill extends StatelessWidget {
  const _HudRoomPill({required this.item});

  final CheHomeDestination item;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      button: true,
      label: '${item.label}. ${item.detail}. Double tap to open.',
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.selectionClick();
          item.onOpen();
        },
        child: CheGlass(
          radius: 22,
          glow: item.hue,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(item.icon, size: 18, color: item.hue),
            const SizedBox(width: 6),
            Flexible(child: Text(item.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(fontWeight: FontWeight.w700))),
          ]),
        ),
      ),
    );
  }
}
