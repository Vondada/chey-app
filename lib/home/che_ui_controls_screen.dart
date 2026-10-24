// UI Controls — live Appearance + Voice reply settings (More → UI Controls).

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_native_voice.dart';
import '../che_ui/che_palettes.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_ui_preferences.dart';
import '../che_ui/che_ui_voice_command.dart';
import '../che_ui/che_widgets.dart';

class CheUiControlsScreen extends StatelessWidget {
  const CheUiControlsScreen({
    super.key,
    this.onVoiceEnabledChanged,
    this.onVoiceVolumeChanged,
  });

  /// Optional hook so the home shell can mirror voiceResponsesEnabled live.
  final ValueChanged<bool>? onVoiceEnabledChanged;
  final ValueChanged<double>? onVoiceVolumeChanged;

  @override
  Widget build(BuildContext context) {
    final prefs = CheUiPreferences.instance;
    return ListenableBuilder(
      listenable: prefs,
      builder: (context, _) {
        final bottom = MediaQuery.viewPaddingOf(context).bottom;
        return Scaffold(
          backgroundColor: CheColors.screen,
          appBar: AppBar(
            backgroundColor: CheColors.screen == Colors.transparent ? Colors.transparent : cheBgOf(context).withValues(alpha: 0.92),
            title: Text('UI Controls', style: CheType.headline.copyWith(color: cheTextOf(context))),
            leading: IconButton(
              tooltip: 'Back',
              icon: Icon(Icons.arrow_back_ios_new_rounded, color: cheTextOf(context), size: 18),
              onPressed: () => Navigator.of(context).maybePop(),
            ),
          ),
          body: ListView(
            padding: EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl + bottom),
            children: [
              Text('Appearance', style: CheType.overline.copyWith(color: CheColors.accent)),
              const SizedBox(height: CheSpace.sm),
              _SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Theme', style: CheType.label.copyWith(color: cheTextOf(context))),
                    const SizedBox(height: 4),
                    Text('Changes every screen, right away.', style: CheType.caption.copyWith(color: cheTextDimOf(context))),
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: [for (final p in kCheColorPalettes) p.label],
                      index: kCheColorPalettes.indexWhere((p) => p.id == prefs.palette.id).clamp(0, kCheColorPalettes.length - 1),
                      onChanged: (i) => prefs.setPalette(kCheColorPalettes[i]),
                    ),
                    const SizedBox(height: CheSpace.lg),
                    Text('Avatar style', style: CheType.label.copyWith(color: cheTextOf(context))),
                    const SizedBox(height: 4),
                    Text('CHE’s face on Home and More.', style: CheType.caption.copyWith(color: cheTextDimOf(context))),
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: const ['Mini person', 'Portrait'],
                      index: prefs.avatarStyle == CheAvatarStyle.portrait ? 1 : 0,
                      onChanged: (i) => prefs.setAvatarStyle(
                        i == 1 ? CheAvatarStyle.portrait : CheAvatarStyle.mini,
                      ),
                    ),
                    const SizedBox(height: CheSpace.lg),
                    Text('Desk / Office density', style: CheType.label.copyWith(color: cheTextOf(context))),
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: const ['Comfortable', 'Compact'],
                      index: prefs.deskCompact ? 1 : 0,
                      onChanged: (i) => prefs.setDeskDensity(
                        i == 1 ? CheDeskDensity.compact : CheDeskDensity.comfortable,
                      ),
                    ),
                    const SizedBox(height: CheSpace.lg),
                    Text('Text size', style: CheType.label.copyWith(color: cheTextOf(context))),
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: const ['Small', 'Default', 'Large'],
                      index: switch (prefs.textScalePref) {
                        CheTextScalePref.small => 0,
                        CheTextScalePref.defaultScale => 1,
                        CheTextScalePref.large => 2,
                      },
                      onChanged: (i) => prefs.setTextScalePref(switch (i) {
                        0 => CheTextScalePref.small,
                        2 => CheTextScalePref.large,
                        _ => CheTextScalePref.defaultScale,
                      }),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: CheSpace.lg),
              Text('Voice replies', style: CheType.overline.copyWith(color: CheColors.accent)),
              const SizedBox(height: CheSpace.sm),
              _SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Speak replies', style: CheType.label.copyWith(color: cheTextOf(context))),
                              Text(
                                prefs.voiceResponsesEnabled
                                    ? 'CHE speaks out loud.'
                                    : 'Muted — text only.',
                                style: CheType.caption.copyWith(color: cheTextDimOf(context)),
                              ),
                            ],
                          ),
                        ),
                        Switch.adaptive(
                          value: prefs.voiceResponsesEnabled,
                          activeThumbColor: CheColors.accent,
                          onChanged: (v) async {
                            HapticFeedback.selectionClick();
                            await prefs.setVoiceResponsesEnabled(v);
                            onVoiceEnabledChanged?.call(v);
                          },
                        ),
                      ],
                    ),
                    const SizedBox(height: CheSpace.md),
                    Text(
                      'Volume  ${(prefs.voiceVolume * 100).round()}%',
                      style: CheType.label.copyWith(color: cheTextOf(context)),
                    ),
                    SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        activeTrackColor: CheColors.accent,
                        thumbColor: CheColors.accent,
                        inactiveTrackColor: CheColors.stroke,
                      ),
                      child: Slider(
                        value: prefs.voiceVolume,
                        min: 0,
                        max: 1,
                        divisions: 20,
                        onChanged: (v) async {
                          await prefs.setVoiceVolume(v);
                          onVoiceVolumeChanged?.call(v);
                        },
                      ),
                    ),
                    Text(
                      'CHE\'s voice (ElevenLabs and Fish) plays at this level. Your iPhone\'s volume buttons set the overall loudness. Say "louder" or "volume 80 percent".',
                      style: CheType.caption.copyWith(color: cheTextDimOf(context)),
                    ),
                    const SizedBox(height: CheSpace.md),
                    Text('Audio output', style: CheType.label.copyWith(color: cheTextOf(context))),
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: const ['Automatic', 'Speaker', 'Earpiece'],
                      index: prefs.audioOutput.index,
                      onChanged: (i) async {
                        final view = View.maybeOf(context);
                        final banner = ScaffoldMessenger.maybeOf(context);
                        final direction = Directionality.of(context);
                        // The iPhone first, so the line below reads the new route.
                        final result = await cheSetAudioOutput(CheAudioOutput.values[i]);
                        // The owner's choice is reported, done or not: a banner,
                        // a haptic and VoiceOver, as the spoken command says it.
                        result.applied ? HapticFeedback.lightImpact() : HapticFeedback.heavyImpact();
                        banner
                          ?..hideCurrentSnackBar()
                          ..showSnackBar(SnackBar(content: Text(result.text)));
                        if (view != null) SemanticsService.sendAnnouncement(view, result.text, direction);
                      },
                    ),
                    const SizedBox(height: CheSpace.xs),
                    _AudioRouteLine(output: prefs.audioOutput),
                  ],
                ),
              ),
              const SizedBox(height: CheSpace.lg),
              Text(
                'Changes apply live and stay on this device — no restart needed.',
                style: CheType.caption.copyWith(color: cheTextDimOf(context)),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// What each Audio Output choice does, and where CHE's voice plays right now
/// as the iPhone reports it.
class _AudioRouteLine extends StatefulWidget {
  const _AudioRouteLine({required this.output});
  final CheAudioOutput output;

  @override
  State<_AudioRouteLine> createState() => _AudioRouteLineState();
}

class _AudioRouteLineState extends State<_AudioRouteLine> {
  Map<String, dynamic>? _report;
  bool _asked = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(_AudioRouteLine old) {
    super.didUpdateWidget(old);
    if (old.output != widget.output) _load();
  }

  Future<void> _load() async {
    final report = await CheNativeVoice.audioRoute();
    if (!mounted) return;
    setState(() {
      _report = report;
      _asked = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final what = switch (widget.output) {
      CheAudioOutput.auto => 'The loudspeaker, or your headphones, Bluetooth, AirPlay or car when connected.',
      CheAudioOutput.speaker => 'Always the loudspeaker, even with headphones or Bluetooth connected.',
      CheAudioOutput.receiver => 'The earpiece: hold the iPhone to your ear.',
    };
    final report = _report;
    final now = !_asked
        ? ''
        : report == null
            ? ' This CHE build cannot report where it plays.'
            : ' Now playing through ${cheAudioRouteSpoken(report)}.';
    // Quiet text: VoiceOver reads it when the owner moves to it.
    return Text('$what$now', style: CheType.caption.copyWith(color: cheTextDimOf(context)));
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(
        color: cheSurfaceOf(context),
        borderRadius: BorderRadius.circular(CheRadius.lg),
        border: Border.all(color: cheStrokeOf(context)),
      ),
      child: child,
    );
  }
}
