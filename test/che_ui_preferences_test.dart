import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('defaults: dark theme, voice ON, volume 1.0', () async {
    final ui = CheUiPreferences.instance;
    await ui.load();
    expect(ui.themeMode, ThemeMode.dark);
    expect(ui.voiceResponsesEnabled, isTrue);
    expect(ui.voiceVolume, 1.0);
    expect(ui.textScale, 1.0);
    expect(ui.deskCompact, isFalse);
    expect(ui.avatarStyle, CheAvatarStyle.portrait);
    // Owner rule: no microphone on launch unless hands-free was turned on.
    expect(ui.handsFreeWake, isFalse);
  });

  test('persists theme, text scale, voice mute, volume', () async {
    final ui = CheUiPreferences.instance;
    await ui.load();
    await ui.setThemeMode(ThemeMode.light);
    await ui.setTextScalePref(CheTextScalePref.large);
    await ui.setVoiceResponsesEnabled(false);
    await ui.setVoiceVolume(0.55);
    await ui.setAvatarStyle(CheAvatarStyle.portrait);
    await ui.setDeskDensity(CheDeskDensity.compact);

    // Simulate cold start by reloading from the same SharedPreferences store.
    await ui.load();
    expect(ui.themeMode, ThemeMode.light);
    expect(ui.textScalePref, CheTextScalePref.large);
    expect(ui.textScale, closeTo(1.18, 0.001));
    expect(ui.voiceResponsesEnabled, isFalse);
    expect(ui.voiceVolume, closeTo(0.55, 0.001));
    expect(ui.avatarStyle, CheAvatarStyle.portrait);
    expect(ui.deskCompact, isTrue);

    // Restore defaults for other tests sharing the singleton.
    await ui.setThemeMode(ThemeMode.dark);
    await ui.setTextScalePref(CheTextScalePref.defaultScale);
    await ui.setVoiceResponsesEnabled(true);
    await ui.setVoiceVolume(1.0);
    await ui.setAvatarStyle(CheAvatarStyle.portrait);
    await ui.setDeskDensity(CheDeskDensity.comfortable);
  });

  // Owner (2026-10-22) approved the HUD look: it shows by default and replaces the earlier dark palettes once, while
  // the light palette and any palette chosen afterwards are kept.
  test('HUD glass is the default and replaces an earlier dark choice once', () async {
    final ui = CheUiPreferences.instance;
    await ui.load();
    expect(ui.palette.id, 'hud_glass');
    expect(CheActivePalette.current.id, 'hud_glass');

    for (final earlier in ['che_dark', 'silver_black']) {
      SharedPreferences.setMockInitialValues({'che.ui.palette': earlier});
      await ui.load();
      expect(ui.palette.id, 'hud_glass', reason: earlier);
    }
    SharedPreferences.setMockInitialValues({'che.ui.palette': 'che_light'});
    await ui.load();
    expect(ui.palette.id, 'che_light', reason: 'the light palette is a deliberate choice');

    SharedPreferences.setMockInitialValues({});
    await ui.load();
    await ui.setPalette(kCheDarkPalette);
    await ui.load();
    expect(ui.palette.id, 'che_dark', reason: 'a palette chosen after the HUD look shipped is kept');
    await ui.setPalette(kCheHudPalette);
  });
}
