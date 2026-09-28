import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'che_native_voice.dart';
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
      child: SingleChildScrollView(
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
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Voice diagnostics',
                    style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
                  ),
                ),
                FilledButton.tonalIcon(
                  onPressed: () async {
                    await showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => const CheVoiceSettingsSheet(),
                    );
                  },
                  icon: const Icon(Icons.tune_rounded, size: 18),
                  label: const Text('VOICE SETTINGS'),
                ),
              ],
            ),
            const SizedBox(height: 10),
            row('Engine', snapshot.engineLabel),
            row('Voice state', snapshot.phaseLabel),
            row('Microphone', snapshot.microphoneActive ? 'Active' : 'Inactive'),
            row('Realtime link', snapshot.connectionState),
            row('Model', snapshot.selectedModel ?? '—'),
            row('Voice', snapshot.selectedVoice ?? '—'),
            row('Session ready', snapshot.sessionReady ? 'Yes' : 'No'),
            row('Audio returned', snapshot.audioReturned ? 'Yes' : 'No'),
            row('Audio verified', snapshot.audioVerified ? 'Yes' : 'No'),
            row('CHE server', serverOnline ? 'Connected' : 'Not confirmed'),
            row('Last event', lastServerEvent ?? '—'),
            row('Last interruption', snapshot.lastInterruptionReason ?? '—'),
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

class CheVoiceSettingsSheet extends StatefulWidget {
  const CheVoiceSettingsSheet({super.key});

  @override
  State<CheVoiceSettingsSheet> createState() => _CheVoiceSettingsSheetState();
}

class _CheVoiceSettingsSheetState extends State<CheVoiceSettingsSheet> {
  bool loading = true;
  bool saving = false;
  int speakerId = 3;
  double speed = 1.0;
  double pauseScale = 0.16;
  double nativePitch = 0.98;
  double nativeRate = 0.94;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final settings = await CheNativeVoice.voiceSettings();
    if (!mounted) return;
    setState(() {
      speakerId = settings['speakerId'] as int? ?? 3;
      speed = settings['speed'] as double? ?? 1.0;
      pauseScale = settings['pauseScale'] as double? ?? 0.16;
      nativePitch = settings['nativePitch'] as double? ?? 0.98;
      nativeRate = settings['nativeRate'] as double? ?? 0.94;
      loading = false;
    });
  }

  Future<void> _save({bool close = false}) async {
    if (saving) return;
    setState(() => saving = true);
    await CheNativeVoice.configureVoice(
      speakerId: speakerId,
      speed: speed,
      pauseScale: pauseScale,
      nativePitch: nativePitch,
      nativeRate: nativeRate,
    );
    if (!mounted) return;
    setState(() => saving = false);
    if (close) Navigator.of(context).pop();
  }

  Future<void> _preview() async {
    await _save();
    await CheNativeVoice.stopAudio();
    await CheNativeVoice.previewVoice();
  }

  @override
  Widget build(BuildContext context) {
    final selected = CheNativeVoice.localVoiceOptions.firstWhere(
      (item) => item['id'] == speakerId,
      orElse: () => CheNativeVoice.localVoiceOptions[3],
    );

    return SafeArea(
      child: FractionallySizedBox(
        heightFactor: 0.86,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            10,
            20,
            20 + MediaQuery.of(context).viewInsets.bottom,
          ),
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : Column(
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
                        'CHE Voice Settings',
                        style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'Choose a local neural voice and tune the delivery. Your selection is saved on this iPhone and works offline after the Kokoro voice pack is installed.',
                        style: TextStyle(color: CheColors.textDim, height: 1.35),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Expanded(
                      child: ListView(
                        children: [
                          DropdownButtonFormField<int>(
                            value: speakerId,
                            isExpanded: true,
                            decoration: const InputDecoration(
                              labelText: 'Local neural voice',
                              prefixIcon: Icon(Icons.record_voice_over_rounded),
                            ),
                            items: [
                              for (final item in CheNativeVoice.localVoiceOptions)
                                DropdownMenuItem<int>(
                                  value: item['id'] as int,
                                  child: Text(item['name'] as String),
                                ),
                            ],
                            onChanged: (value) {
                              if (value != null) setState(() => speakerId = value);
                            },
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Selected: ${selected['speaker']}',
                            style: const TextStyle(color: CheColors.textDim, fontSize: 12),
                          ),
                          const SizedBox(height: 20),
                          _VoiceSlider(
                            label: 'Speaking speed',
                            value: speed,
                            min: 0.70,
                            max: 1.35,
                            divisions: 26,
                            display: '${speed.toStringAsFixed(2)}×',
                            onChanged: (v) => setState(() => speed = v),
                          ),
                          _VoiceSlider(
                            label: 'Pause spacing',
                            value: pauseScale,
                            min: 0.05,
                            max: 0.35,
                            divisions: 30,
                            display: pauseScale.toStringAsFixed(2),
                            onChanged: (v) => setState(() => pauseScale = v),
                          ),
                          const Divider(height: 32),
                          const Text(
                            'iPhone fallback tuning',
                            style: TextStyle(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            'These controls affect Apple’s built-in fallback voice when the local neural voice is still loading or unavailable.',
                            style: TextStyle(color: CheColors.textDim, fontSize: 12.5),
                          ),
                          const SizedBox(height: 12),
                          _VoiceSlider(
                            label: 'Pitch',
                            value: nativePitch,
                            min: 0.75,
                            max: 1.25,
                            divisions: 25,
                            display: nativePitch.toStringAsFixed(2),
                            onChanged: (v) => setState(() => nativePitch = v),
                          ),
                          _VoiceSlider(
                            label: 'Fallback pace',
                            value: nativeRate,
                            min: 0.70,
                            max: 1.25,
                            divisions: 22,
                            display: '${nativeRate.toStringAsFixed(2)}×',
                            onChanged: (v) => setState(() => nativeRate = v),
                          ),
                          const SizedBox(height: 12),
                          const Text(
                            'Voice labels describe language/region and presentation only. They do not assign a race or ethnicity to a voice.',
                            style: TextStyle(color: CheColors.textDim, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: saving ? null : _preview,
                            icon: const Icon(Icons.play_arrow_rounded),
                            label: const Text('PREVIEW'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: saving ? null : () => _save(close: true),
                            icon: const Icon(Icons.check_rounded),
                            label: Text(saving ? 'SAVING...' : 'SAVE VOICE'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _VoiceSlider extends StatelessWidget {
  const _VoiceSlider({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.display,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String display;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text(label)),
            Text(display, style: const TextStyle(color: CheColors.textDim)),
          ],
        ),
        Slider(
          value: value,
          min: min,
          max: max,
          divisions: divisions,
          label: display,
          onChanged: onChanged,
        ),
      ],
    );
  }
}
