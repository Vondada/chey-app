// UI Controls — live Appearance + Voice reply settings (More → UI Controls).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import '../che_ui/che_ui_preferences.dart';
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
          backgroundColor: cheBgOf(context),
          appBar: AppBar(
            backgroundColor: cheBgOf(context).withValues(alpha: 0.92),
            title: Text('UI Controls', style: CheType.headline.copyWith(color: cheTextOf(context))),
            leading: IconButton(
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
                    const SizedBox(height: CheSpace.sm),
                    PillToggle(
                      options: const ['Dark', 'Light', 'System'],
                      index: switch (prefs.themeMode) {
                        ThemeMode.dark => 0,
                        ThemeMode.light => 1,
                        ThemeMode.system => 2,
                      },
                      onChanged: (i) => prefs.setThemeMode(switch (i) {
                        1 => ThemeMode.light,
                        2 => ThemeMode.system,
                        _ => ThemeMode.dark,
                      }),
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
                      'Applies to device TTS. Realtime sessions use the system route (speakerphone).',
                      style: CheType.caption.copyWith(color: cheTextDimOf(context)),
                    ),
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
