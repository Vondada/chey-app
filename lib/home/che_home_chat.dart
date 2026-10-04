// Home conversation in the CHE agent-chat design (kit look), driven by the
// app's existing chat + voice pipeline:
//   • presence header: 9-state CHE orb, gradient name, live state label,
//     voice engine line and Office status
//   • "New Chat ▾" switcher + new-chat button
//   • user bubbles, assistant messages with orb avatar, live timer + step
//     lines, collapsible "Thought", rich text with code file cards and
//     "Saved to brain" chips, Copy / Redo chips
//   • floating glow composer: Agent | Chat mode chip, attach, mic, send/stop

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agent_chat.dart' show CheOrb, CheOrbState, CheOrbStateLabel;
import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_widgets.dart';
import 'che_live_steps.dart';

class CheHomePresence extends StatelessWidget {
  const CheHomePresence({
    super.key,
    required this.orbState,
    required this.subtitle,
    required this.onOrbTap,
    this.office,
  });

  final CheOrbState orbState;
  final String subtitle;
  final VoidCallback onOrbTap;

  /// Optional trailing chip. Prefer [CheOfficeHomeStage] below the presence row.
  final Widget? office;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.xs),
      child: Row(children: [
        Semantics(
          button: true,
          label: orbState == CheOrbState.speaking
              ? 'CHE is speaking. Double tap to interrupt.'
              : orbState == CheOrbState.listening
                  ? 'CHE is listening. Double tap to stop listening.'
                  : 'CHE, ${orbState.label}. Double tap to talk.',
          child: GestureDetector(
            onTap: () {
              HapticFeedback.mediumImpact();
              onOrbTap();
            },
            child: CheOrb(size: 46, state: orbState),
          ),
        ),
        const SizedBox(width: CheSpace.md),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            AnimatedSwitcher(
              duration: CheMotion.d(context, CheMotion.fast),
              child: Text(
                orbState.label.toUpperCase(),
                key: ValueKey(orbState),
                maxLines: 1,
                style: CheType.overline.copyWith(color: CheColors.accent, letterSpacing: 2),
              ),
            ),
            const SizedBox(height: 2),
            Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
          ]),
        ),
        if (office != null) ...[
          const SizedBox(width: CheSpace.sm),
          office!,
        ],
      ]),
    );
  }
}

class CheConversationBar extends StatelessWidget {
  const CheConversationBar({super.key, required this.title, required this.onOpen, required this.onNew});
  final String title;
  final VoidCallback onOpen;
  final VoidCallback onNew;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.xs),
      child: Row(children: [
        Expanded(
          child: ChePressable(
            onTap: onOpen,
            child: Container(
              height: 38,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: CheColors.surface,
                borderRadius: BorderRadius.circular(CheRadius.md),
                border: Border.all(color: CheColors.stroke),
              ),
              child: Row(children: [
                Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label)),
                const Icon(Icons.keyboard_arrow_down_rounded, size: 20, color: CheColors.textDim),
              ]),
            ),
          ),
        ),
        const SizedBox(width: CheSpace.sm),
        CheIconButton(icon: Icons.add_rounded, size: 38, onTap: onNew, tooltip: 'New chat'),
      ]),
    );
  }
}

class CheHomeUserBubble extends StatelessWidget {
  const CheHomeUserBubble({super.key, required this.text, this.onLongPress, this.animate = true});
  final String text;
  final VoidCallback? onLongPress;

  /// Pop-in only for a just-sent message, not every time an old one scrolls
  /// back into view.
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final maxW = MediaQuery.sizeOf(context).width * 0.8;
    return Align(
      alignment: Alignment.centerRight,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxW),
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: animate ? 0.92 : 1, end: 1),
            duration: CheMotion.d(context, CheMotion.base),
            curve: CheMotion.spring,
            builder: (_, s, child) => Transform.scale(scale: s, alignment: Alignment.bottomRight, child: child),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(CheRadius.lg),
                  topRight: Radius.circular(CheRadius.lg),
                  bottomLeft: Radius.circular(CheRadius.lg),
                  bottomRight: Radius.circular(6),
                ),
                gradient: LinearGradient(colors: [
                  CheColors.accent.withValues(alpha: 0.20),
                  CheColors.accentAlt.withValues(alpha: 0.12),
                ]),
                border: Border.all(color: CheColors.accent.withValues(alpha: 0.4)),
              ),
              child: SelectableText(text, style: CheType.body),
            ),
          ),
        ),
      ),
    );
  }
}

class CheHomeAssistantMessage extends StatelessWidget {
  const CheHomeAssistantMessage({
    super.key,
    required this.text,
    required this.streaming,
    required this.liveStart,
    required this.liveSteps,
    required this.finishedSteps,
    required this.thoughtMs,
    required this.agents,
    required this.extras,
    this.onTapAgent,
    this.onRedo,
    this.onReadAloud,
    this.onLongPress,
  });

  final String text;
  final bool streaming;

  /// Set while this reply is being produced.
  final DateTime? liveStart;
  final List<CheLiveStep> liveSteps;
  final List<String> finishedSteps;
  final int? thoughtMs;
  final List<CheAgent> agents;

  /// Plugin install cards, update cards, generated media.
  final List<Widget> extras;
  final void Function(CheAgent agent)? onTapAgent;
  final VoidCallback? onRedo;

  /// Reads this reply aloud in CHE's voice.
  final VoidCallback? onReadAloud;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final live = liveStart != null;
    return GestureDetector(
      onLongPress: onLongPress,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 2), child: CheOrb(size: 24, active: streaming || live)),
        const SizedBox(width: CheSpace.md),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (live && text.isEmpty)
              CheLiveStepsView(startedAt: liveStart!, steps: liveSteps, agents: agents, onTapAgent: onTapAgent)
            else if (live && liveSteps.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  for (final s in liveSteps) StepLine(label: s.text, status: StepStatus.done),
                ]),
              )
            else if (!live && (finishedSteps.isNotEmpty || thoughtMs != null))
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: CheThoughtLine(thoughtMs: thoughtMs, steps: finishedSteps),
              ),
            if (text.isNotEmpty) CheRichText(text: text, streaming: streaming),
            ...extras,
          ]),
        ),
      ]),
    );
  }
}

class CheHomeComposer extends StatelessWidget {
  const CheHomeComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    this.typingOn = true,
    this.onToggleTyping,
    required this.busy,
    required this.modes,
    required this.modeIndex,
    required this.onModeChanged,
    required this.onSend,
    required this.onStop,
    required this.onAttach,
    required this.onMic,
    required this.micActive,
    required this.hint,
    this.attachmentLabel,
    this.onClearAttachment,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool typingOn;
  final VoidCallback? onToggleTyping;
  final bool busy;
  final List<String> modes;
  final int modeIndex;
  final ValueChanged<int> onModeChanged;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback onAttach;
  final VoidCallback onMic;
  final bool micActive;
  final String hint;
  final String? attachmentLabel;
  final VoidCallback? onClearAttachment;

  @override
  Widget build(BuildContext context) {
    final keyboardUp = MediaQuery.viewInsetsOf(context).bottom > 0;

    if (!typingOn && attachmentLabel == null) {
      final voiceLabel = busy
          ? 'CHE is working. Stop the current reply.'
          : micActive
              ? 'CHE voice is active. Stop listening or interrupt CHE.'
              : 'CHE voice is off. Start listening.';
      return Padding(
        padding: const EdgeInsets.fromLTRB(CheSpace.md, 2, CheSpace.md, CheSpace.sm),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (onToggleTyping != null)
              Semantics(
                button: true,
                label: 'Show keyboard.',
                excludeSemantics: true,
                child: _ComposerIcon(
                  icon: Icons.keyboard_rounded,
                  tooltip: 'Show keyboard',
                  onTap: onToggleTyping!,
                ),
              ),
            const SizedBox(width: 8),
            Semantics(
              button: true,
              label: voiceLabel,
              excludeSemantics: true,
              child: ChePressable(
                onTap: busy ? onStop : onMic,
                child: AnimatedContainer(
                  duration: CheMotion.d(context, CheMotion.fast),
                  width: 54,
                  height: 54,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: (micActive || busy) ? CheColors.accentGradient : null,
                    color: (micActive || busy) ? null : CheColors.surfaceHi,
                    border: Border.all(color: CheColors.accent.withValues(alpha: 0.55)),
                    boxShadow: (micActive || busy)
                        ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.35), blurRadius: 18)]
                        : null,
                  ),
                  child: Icon(
                    busy
                        ? Icons.stop_rounded
                        : micActive
                            ? Icons.graphic_eq_rounded
                            : Icons.mic_rounded,
                    size: 25,
                    color: (micActive || busy) ? const Color(0xFF02110E) : CheColors.accent,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(CheSpace.md, CheSpace.xs, CheSpace.md, keyboardUp ? CheSpace.xs : CheSpace.sm),
      child: ListenableBuilder(
        listenable: Listenable.merge([controller, focusNode]),
        builder: (context, _) {
          final canSend = controller.text.trim().isNotEmpty || attachmentLabel != null;
          return GlowCard(
            active: busy || focusNode.hasFocus,
            radius: CheRadius.xl,
            padding: const EdgeInsets.fromLTRB(CheSpace.md, CheSpace.sm, CheSpace.sm, CheSpace.sm),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (attachmentLabel != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 6, top: 2),
                    child: InputChip(
                      label: Text(attachmentLabel!, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
                      avatar: const Icon(Icons.attach_file_rounded, size: 16, color: CheColors.accent),
                      onDeleted: onClearAttachment,
                      backgroundColor: CheColors.surfaceHi,
                      side: const BorderSide(color: CheColors.stroke),
                    ),
                  ),
                ),
              if (!typingOn)
                Semantics(
                  button: true,
                  label: 'Keyboard is off. Double tap to type instead of talking.',
                  child: ChePressable(
                    onTap: onToggleTyping ?? () {},
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(children: [
                        Expanded(
                          child: Text(
                            micActive ? 'Listening…' : 'Tap the mic and talk to CHE',
                            style: CheType.body.copyWith(color: CheColors.textFaint),
                          ),
                        ),
                      ]),
                    ),
                  ),
                )
              else
              TextField(
                controller: controller,
                focusNode: focusNode,
                minLines: 1,
                maxLines: 6,
                style: CheType.body,
                cursorColor: CheColors.accent,
                textCapitalization: TextCapitalization.sentences,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  isDense: true,
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  hintText: hint,
                  hintStyle: CheType.body.copyWith(color: CheColors.textFaint),
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                ),
              ),
              const SizedBox(height: 4),
              Row(children: [
                ChePressable(
                  onTap: () => onModeChanged((modeIndex + 1) % modes.length),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(CheRadius.pill),
                      color: CheColors.accent.withValues(alpha: 0.10),
                      border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(modeIndex == 0 ? Icons.auto_awesome_rounded : Icons.chat_bubble_outline_rounded,
                          size: 14, color: CheColors.accent),
                      const SizedBox(width: 4),
                      Text(modes[modeIndex],
                          style: CheType.caption.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700)),
                      const Icon(Icons.swap_horiz_rounded, size: 14, color: CheColors.accent),
                    ]),
                  ),
                ),
                const Spacer(),
                if (keyboardUp)
                  Semantics(
                    button: true,
                    label: 'Hide keyboard. Your typing stays.',
                    excludeSemantics: true,
                    child: _ComposerIcon(
                      icon: Icons.keyboard_arrow_down_rounded,
                      tooltip: 'Hide keyboard',
                      onTap: focusNode.unfocus,
                    ),
                  ),
                if (onToggleTyping != null)
                  _ComposerIcon(
                    icon: typingOn ? Icons.keyboard_hide_rounded : Icons.keyboard_rounded,
                    tooltip: typingOn ? 'Turn keyboard off' : 'Turn keyboard on',
                    onTap: onToggleTyping!,
                    highlight: typingOn,
                  ),
                _ComposerIcon(icon: Icons.add_photo_alternate_outlined, tooltip: 'Attach', onTap: onAttach),
                _ComposerIcon(
                  icon: micActive ? Icons.graphic_eq_rounded : Icons.mic_none_rounded,
                  tooltip: micActive ? 'Stop talking to CHE' : 'Talk to CHE',
                  onTap: onMic,
                  highlight: micActive,
                ),
                const SizedBox(width: 4),
                _SendButton(busy: busy, enabled: canSend, onSend: onSend, onStop: onStop),
              ]),
            ]),
          );
        },
      ),
    );
  }
}

class _ComposerIcon extends StatelessWidget {
  const _ComposerIcon({required this.icon, required this.tooltip, required this.onTap, this.highlight = false});
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool highlight;
  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: ChePressable(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Icon(icon, size: 22, color: highlight ? CheColors.accent : CheColors.textDim),
          ),
        ),
      );
}

class _SendButton extends StatelessWidget {
  const _SendButton({required this.busy, required this.enabled, required this.onSend, required this.onStop});
  final bool busy;
  final bool enabled;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final on = busy || enabled;
    return Semantics(
      button: true,
      label: busy ? 'Stop' : 'Send',
      child: ChePressable(
        onTap: busy ? onStop : (enabled ? onSend : () {}),
        child: AnimatedContainer(
          duration: CheMotion.d(context, CheMotion.fast),
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: on ? CheColors.accentGradient : null,
            color: on ? null : CheColors.surfaceHi,
            boxShadow: on ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.5), blurRadius: 14)] : null,
          ),
          child: Icon(
            busy ? Icons.stop_rounded : Icons.arrow_upward_rounded,
            size: 20,
            color: on ? const Color(0xFF02110E) : CheColors.textFaint,
          ),
        ),
      ),
    );
  }
}

/// Home, voice-first: at most three big things. 1) Talk to CHE (a big button
/// that also backs up the wake word), 2) what's happening now, read aloud on
/// request, 3) three smart suggestions. Everything else is one sentence away.
class CheHomeEmptyState extends StatelessWidget {
  const CheHomeEmptyState({
    super.key,
    required this.actions,
    required this.onPick,
    required this.onTalk,
    this.proactive,
    this.onReadAloud,
    this.onActivity,
    this.listening = false,
  });

  /// Smart suggestions; only the first three are shown.
  final List<String> actions;
  final ValueChanged<String> onPick;
  final VoidCallback onTalk;

  /// CHE's one-line greeting / what's happening now.
  final String? proactive;
  final VoidCallback? onReadAloud;
  final VoidCallback? onActivity;
  final bool listening;

  @override
  Widget build(BuildContext context) {
    final now = proactive?.trim() ?? '';
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl),
      children: [
        // 1. Talk to CHE.
        Semantics(
          button: true,
          label: listening ? 'CHE is listening. Double tap to stop.' : 'Talk to CHE. Double tap, then just speak.',
          excludeSemantics: true,
          child: ChePressable(
            onTap: () {
              HapticFeedback.heavyImpact();
              onTalk();
            },
            child: Container(
              height: 132,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.xl),
                gradient: CheColors.accentGradient,
                boxShadow: [BoxShadow(color: CheColors.accent.withValues(alpha: 0.35), blurRadius: 28)],
              ),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(listening ? Icons.graphic_eq_rounded : Icons.mic_rounded, size: 52, color: const Color(0xFF03120F)),
                const SizedBox(width: CheSpace.md),
                Flexible(
                  child: Text(
                    listening ? 'Listening…' : 'Talk to CHE',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.title.copyWith(color: const Color(0xFF03120F), fontSize: 28, fontWeight: FontWeight.w800),
                  ),
                ),
              ]),
            ),
          ),
        ),
        const SizedBox(height: CheSpace.lg),
        // 2. What's happening now.
        GlowCard(
          radius: CheRadius.lg,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('HAPPENING NOW', style: CheType.overline.copyWith(color: CheColors.accent)),
            const SizedBox(height: CheSpace.xs),
            Semantics(
              liveRegion: true,
              child: Text(
                now.isEmpty ? 'What should we do?' : now,
                style: CheType.title.copyWith(fontSize: 21, height: 1.3),
              ),
            ),
            const SizedBox(height: CheSpace.sm),
            Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
              if (onReadAloud != null)
                _BigChip(icon: Icons.volume_up_rounded, label: 'Read to me', semantics: 'Read what is happening aloud', onTap: onReadAloud!),
              if (onActivity != null)
                _BigChip(icon: Icons.history_rounded, label: 'What happened', semantics: 'Open everything CHE and the Office did', onTap: onActivity!),
            ]),
          ]),
        ),
        const SizedBox(height: CheSpace.lg),
        // 3. Three smart suggestions.
        Text('TRY SAYING', style: CheType.overline),
        const SizedBox(height: CheSpace.sm),
        for (final (i, a) in actions.take(3).indexed)
          Padding(
            padding: const EdgeInsets.only(bottom: CheSpace.sm),
            child: Semantics(
              button: true,
              label: 'Suggestion ${i + 1}: $a',
              excludeSemantics: true,
              child: ChePressable(
                onTap: () => onPick(a),
                child: Container(
                  constraints: const BoxConstraints(minHeight: 58),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    color: CheColors.surface,
                    borderRadius: BorderRadius.circular(CheRadius.lg),
                    border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
                  ),
                  child: Row(children: [
                    const Icon(Icons.auto_awesome_rounded, color: CheColors.accent, size: 22),
                    const SizedBox(width: CheSpace.sm),
                    Expanded(child: Text('“$a”', maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.body.copyWith(fontSize: 18))),
                  ]),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _BigChip extends StatelessWidget {
  const _BigChip({required this.icon, required this.label, required this.semantics, required this.onTap});
  final IconData icon;
  final String label;
  final String semantics;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: ChePressable(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: CheColors.surfaceHi,
              borderRadius: BorderRadius.circular(CheRadius.pill),
              border: Border.all(color: CheColors.stroke),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 20, color: CheColors.accent),
              const SizedBox(width: 6),
              Text(label, style: CheType.label.copyWith(fontSize: 16)),
            ]),
          ),
        ),
      );
}
