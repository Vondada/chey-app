import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'che_theme.dart';
import 'che_voice_state.dart';

class CheVoiceOrb extends StatefulWidget {
  const CheVoiceOrb({
    super.key,
    required this.snapshot,
    required this.onTap,
  });

  final CheVoiceSnapshot snapshot;
  final VoidCallback onTap;

  @override
  State<CheVoiceOrb> createState() => _CheVoiceOrbState();
}

class _CheVoiceOrbState extends State<CheVoiceOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
      lowerBound: 0,
      upperBound: 1,
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Color get phaseColor {
    switch (widget.snapshot.phase) {
      case CheVoicePhase.speaking:
        return const Color(0xFF87E8FF);
      case CheVoicePhase.thinking:
      case CheVoicePhase.connecting:
        return const Color(0xFFC7A9FF);
      case CheVoicePhase.interrupted:
        return const Color(0xFFFFC66D);
      case CheVoicePhase.disconnected:
        return Colors.white38;
      default:
        return CheColors.accent;
    }
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: widget.onTap,
      child: AnimatedBuilder(
        animation: controller,
        builder: (context, child) {
          final active = widget.snapshot.phase == CheVoicePhase.listening ||
              widget.snapshot.phase == CheVoicePhase.userSpeaking ||
              widget.snapshot.phase == CheVoicePhase.speaking ||
              widget.snapshot.phase == CheVoicePhase.thinking;
          final pulse = active ? 1 + (controller.value * 0.08) : 1.0;
          final glow = active ? 0.22 + controller.value * 0.18 : 0.12;
          return Transform.scale(
            scale: pulse,
            child: Container(
              width: 54,
              height: 54,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: [
                    phaseColor.withValues(alpha: 0.95),
                    phaseColor.withValues(alpha: 0.32),
                    const Color(0xFF0B1822),
                  ],
                  stops: const [0, 0.46, 1],
                ),
                boxShadow: [
                  BoxShadow(
                    color: phaseColor.withValues(alpha: glow),
                    blurRadius: 18 + math.sin(controller.value * math.pi) * 10,
                    spreadRadius: 1,
                  ),
                ],
              ),
              child: Icon(
                widget.snapshot.phase == CheVoicePhase.speaking
                    ? Icons.graphic_eq_rounded
                    : widget.snapshot.phase == CheVoicePhase.thinking
                        ? Icons.auto_awesome_rounded
                        : widget.snapshot.phase == CheVoicePhase.interrupted
                            ? Icons.pause_rounded
                            : Icons.mic_rounded,
                color: const Color(0xFF07151C),
                size: 24,
              ),
            ),
          );
        },
      ),
    );
  }
}

class CheVoiceDiagnosticsSheet extends StatelessWidget {
  const CheVoiceDiagnosticsSheet({
    super.key,
    required this.snapshot,
    required this.serverOnline,
    required this.lastServerEvent,
  });

  final CheVoiceSnapshot snapshot;
  final bool serverOnline;
  final String? lastServerEvent;

  @override
  Widget build(BuildContext context) {
    Widget row(String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 132,
                child: Text(
                  label,
                  style: const TextStyle(color: CheColors.textDim, fontSize: 12),
                ),
              ),
              Expanded(
                child: Text(
                  value,
                  style: const TextStyle(
                    color: CheColors.textPrimary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        );

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 42,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.white24,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            const SizedBox(height: 18),
            const Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Voice diagnostics',
                style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(height: 10),
            row('Engine', snapshot.engineLabel),
            row('Voice state', snapshot.phaseLabel),
            row('Microphone', snapshot.microphoneActive ? 'Active' : 'Inactive'),
            row('Realtime link', snapshot.connectionState),
            row('CHE server', serverOnline ? 'Connected' : 'Not confirmed'),
            row('Last event', lastServerEvent ?? '—'),
            row(
              'Last interruption',
              snapshot.lastInterruptionReason ?? '—',
            ),
            row(
              'Turn latency',
              snapshot.lastLatencyMs == null
                  ? '—'
                  : '${snapshot.lastLatencyMs} ms',
            ),
            row('Last error', snapshot.lastError ?? '—'),
          ],
        ),
      ),
    );
  }
}
