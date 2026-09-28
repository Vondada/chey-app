import 'package:flutter/material.dart';

import 'che_conversation_state.dart';
import 'che_theme.dart';

class CheVoiceOrb extends StatefulWidget {
  const CheVoiceOrb({
    super.key,
    required this.snapshot,
    this.onTap,
  });

  final CheConversationSnapshot snapshot;
  final VoidCallback? onTap;

  @override
  State<CheVoiceOrb> createState() => _CheVoiceOrbState();
}

class _CheVoiceOrbState extends State<CheVoiceOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1150),
      lowerBound: 0,
      upperBound: 1,
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  String get _label {
    switch (widget.snapshot.phase) {
      case CheConversationPhase.sleeping:
        return 'Say “Chay”';
      case CheConversationPhase.wakeListening:
        return 'Listening';
      case CheConversationPhase.userSpeaking:
        return 'Listening…';
      case CheConversationPhase.thinking:
        return 'Thinking';
      case CheConversationPhase.toolUse:
        return 'Working';
      case CheConversationPhase.cheSpeaking:
        return 'Speaking';
      case CheConversationPhase.interrupted:
        return 'Interrupted';
      case CheConversationPhase.fallback:
        return 'Native fallback';
    }
  }

  String get _engine {
    switch (widget.snapshot.engine) {
      case CheVoiceEngine.realtime:
        return 'Realtime';
      case CheVoiceEngine.nativeFallback:
        return 'Native fallback';
      case CheVoiceEngine.disconnected:
        return 'Disconnected';
    }
  }

  bool get _animate =>
      widget.snapshot.phase == CheConversationPhase.userSpeaking ||
      widget.snapshot.phase == CheConversationPhase.thinking ||
      widget.snapshot.phase == CheConversationPhase.cheSpeaking;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: widget.onTap,
      child: Container(
        margin: const EdgeInsets.fromLTRB(14, 8, 14, 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: const Color(0xFF0F1D27),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: Colors.white10),
        ),
        child: Row(
          children: [
            AnimatedBuilder(
              animation: _pulse,
              builder: (context, _) {
                final pulse = _animate ? _pulse.value : 0.2;
                return Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      colors: [
                        Color(0xFFB9FFF4),
                        Color(0xFF4BE5CF),
                        Color(0xFF164B57),
                        Color(0xFF0B1720),
                      ],
                      stops: [0, 0.28, 0.65, 1],
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: CheColors.accent.withValues(
                          alpha: 0.16 + (pulse * 0.26),
                        ),
                        blurRadius: 12 + (pulse * 13),
                        spreadRadius: pulse * 2.5,
                      ),
                    ],
                  ),
                );
              },
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _label.toUpperCase(),
                    style: const TextStyle(
                      color: CheColors.accent,
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _engine,
                    style: const TextStyle(
                      color: CheColors.textDim,
                      fontSize: 10.5,
                    ),
                  ),
                ],
              ),
            ),
            if (widget.snapshot.latencyMs != null)
              Text(
                '${widget.snapshot.latencyMs} ms',
                style: const TextStyle(
                  color: Colors.white38,
                  fontSize: 9.5,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
