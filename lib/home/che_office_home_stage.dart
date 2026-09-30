// Home Office Stage — the living team on the main shell.
//
// Lightweight CustomPaint chibis only (no WebView / 3D / CheOfficeWorld).
// Idle breathe uses the shared CheIdleLifeClock (~10fps). Each desk is a
// RepaintBoundary so chat/composer are not repainted on idle ticks.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';

/// Prominent live Office strip on the home shell.
class CheOfficeHomeStage extends StatelessWidget {
  const CheOfficeHomeStage({
    super.key,
    required this.che,
    required this.agents,
    required this.working,
    required this.liveMeetings,
    required this.onEnterOffice,
    this.connected = true,
    this.onTapAgent,
    this.compact = false,
  });

  final CheAgent che;
  final List<CheAgent> agents;
  final int working;
  final int liveMeetings;
  final bool connected;
  final VoidCallback onEnterOffice;
  final void Function(CheAgent agent)? onTapAgent;

  /// Slightly shorter roster strip while a chat thread is open.
  final bool compact;

  String get _statusLabel {
    if (!connected) return 'Office offline';
    if (liveMeetings > 0) return 'War Room live · $liveMeetings';
    if (working > 0) return '$working working';
    if (agents.isEmpty) return 'Office quiet · hire a teammate';
    return 'Office quiet · ${agents.length + 1} at desks';
  }

  void _enter() {
    HapticFeedback.mediumImpact();
    onEnterOffice();
  }

  @override
  Widget build(BuildContext context) {
    final roster = <CheAgent>[che, ...agents];
    final lit = working > 0 || liveMeetings > 0;
    final deskH = compact ? 88.0 : 102.0;

    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.sm),
      child: RepaintBoundary(
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(CheRadius.lg),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                CheColors.office.withValues(alpha: lit ? 0.28 : 0.16),
                CheColors.surfaceHi.withValues(alpha: 0.95),
                const Color(0xFF071018),
              ],
            ),
            border: Border.all(
              color: CheColors.office.withValues(alpha: lit ? 0.85 : 0.4),
            ),
            boxShadow: [
              BoxShadow(
                color: CheColors.office.withValues(alpha: lit ? 0.22 : 0.10),
                blurRadius: 14,
              ),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(CheSpace.md, CheSpace.sm, CheSpace.md, CheSpace.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                button: true,
                label: 'CHE Office stage, $_statusLabel. Double tap to enter the Office floor.',
                excludeSemantics: true,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _enter,
                  child: Row(
                    children: [
                      const Icon(Icons.apartment_rounded, size: 16, color: Colors.white70),
                      const SizedBox(width: 6),
                      Text(
                        'LA AGENCIA',
                        style: CheType.overline.copyWith(color: Colors.white, letterSpacing: 2.4),
                      ),
                      const SizedBox(width: CheSpace.sm),
                      Expanded(
                        child: Text(
                          _statusLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.end,
                          style: CheType.caption.copyWith(
                            color: lit ? CheColors.accent : Colors.white70,
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(Icons.chevron_right_rounded, size: 18, color: Colors.white54),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: CheSpace.sm),
              SizedBox(
                height: deskH,
                child: roster.isEmpty
                    ? Center(
                        child: GestureDetector(
                          onTap: _enter,
                          child: Text(
                            'Ask CHE to staff the Office',
                            style: CheType.bodyDim.copyWith(color: Colors.white70),
                          ),
                        ),
                      )
                    // Row+scroll avoids ListView.builder overhead for a tiny roster.
                    : SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        physics: const BouncingScrollPhysics(),
                        child: Row(
                          children: [
                            for (var i = 0; i < roster.length; i++) ...[
                              if (i > 0) const SizedBox(width: CheSpace.sm),
                              _StageDesk(
                                agent: roster[i],
                                compact: compact,
                                onTap: () {
                                  HapticFeedback.selectionClick();
                                  final a = roster[i];
                                  if (onTapAgent != null) {
                                    onTapAgent!(a);
                                  } else {
                                    onEnterOffice();
                                  }
                                },
                              ),
                            ],
                          ],
                        ),
                      ),
              ),
              const SizedBox(height: CheSpace.sm),
              _EnterOfficeButton(onTap: _enter, compact: compact),
            ],
          ),
        ),
      ),
    );
  }
}

class _EnterOfficeButton extends StatelessWidget {
  const _EnterOfficeButton({required this.onTap, this.compact = false});
  final VoidCallback onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Enter Office',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(CheRadius.md),
          child: Ink(
            height: compact ? 40 : 44,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(CheRadius.md),
              gradient: CheColors.accentGradient,
              boxShadow: [
                BoxShadow(color: CheColors.accent.withValues(alpha: 0.28), blurRadius: 16),
              ],
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.meeting_room_rounded, size: 22, color: Color(0xFF03120F)),
                const SizedBox(width: 8),
                Text(
                  'Enter Office',
                  style: CheType.label.copyWith(
                    color: const Color(0xFF03120F),
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.3,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StageDesk extends StatelessWidget {
  const _StageDesk({required this.agent, required this.onTap, this.compact = false});
  final CheAgent agent;
  final VoidCallback onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: Semantics(
        button: true,
        label: '${agent.name}, ${agent.role.isEmpty ? agent.status.label : agent.role}. ${agent.status.label}.',
        excludeSemantics: true,
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: SizedBox(
            width: compact ? 64 : 72,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                CheMiniPerson(agent: agent, size: compact ? 48 : 56, showDesk: true),
                const SizedBox(height: 2),
                Text(
                  agent.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: CheType.caption.copyWith(
                    color: Colors.white,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  agent.status.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: CheType.caption.copyWith(color: agent.color, fontSize: 9.5),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
