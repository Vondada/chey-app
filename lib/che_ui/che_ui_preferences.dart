// In-app UI Controls — live preferences persisted on device.
// Theme, avatar style, desk density, text scale, and voice replies/volume.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_active_palette.dart';
import 'che_palettes.dart';

enum CheAvatarStyle { mini, portrait }

enum CheDeskDensity { comfortable, compact }

enum CheTextScalePref { small, defaultScale, large }

/// Where CHE's voice plays. [auto]: the loudspeaker, or the headphones,
/// Bluetooth, AirPlay or car the owner connected. [speaker]: always the
/// loudspeaker. [receiver]: the earpiece, held to the ear.
enum CheAudioOutput { auto, speaker, receiver }

/// Singleton ChangeNotifier for live UI + voice reply preferences.
class CheUiPreferences extends ChangeNotifier {
  CheUiPreferences._();
  static final CheUiPreferences instance = CheUiPreferences._();

  static const _themeKey = 'che.ui.themeMode';
  // The owner's palette (che_palettes.dart ids). Saved once chosen; the dark palette is the default.
  static const _paletteKey = 'che.ui.palette';
  static const _avatarKey = 'che.ui.avatarStyle';
  static const _densityKey = 'che.ui.deskDensity';
  static const _textScaleKey = 'che.ui.textScale';
  static const _voiceEnabledKey = 'che.ui.voiceResponsesEnabled';
  static const _voiceVolumeKey = 'che.ui.voiceVolume';
  static const _handsFreeKey = 'che.ui.handsFreeWake';
  static const _audioOutputKey = 'che.ui.audioOutput';

  bool _loaded = false;
  bool get isLoaded => _loaded;

  CheColorPalette palette = kCheDarkPalette;
  // Light palettes use light system chrome; every other palette is dark.
  ThemeMode get themeMode => palette.brightness == Brightness.light ? ThemeMode.light : ThemeMode.dark;
  // Owner asked for CHE to appear as her female character by default.
  CheAvatarStyle avatarStyle = CheAvatarStyle.portrait;
  CheDeskDensity deskDensity = CheDeskDensity.comfortable;
  CheTextScalePref textScalePref = CheTextScalePref.defaultScale;
  bool voiceResponsesEnabled = true;
  double voiceVolume = 1.0;
  CheAudioOutput audioOutput = CheAudioOutput.auto;
  // Owner rule: the mic never opens by itself when CHE launches. Hands-free
  // wake listening is opt-in ("turn on hands-free").
  bool handsFreeWake = false;

  double get textScale => switch (textScalePref) {
        CheTextScalePref.small => 0.90,
        CheTextScalePref.defaultScale => 1.0,
        CheTextScalePref.large => 1.18,
      };

  bool get deskCompact => deskDensity == CheDeskDensity.compact;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    palette = _paletteFromSaved(prefs);
    CheActivePalette.current = palette;
    avatarStyle = prefs.getString(_avatarKey) == CheAvatarStyle.mini.name
        ? CheAvatarStyle.mini
        : CheAvatarStyle.portrait;
    deskDensity = prefs.getString(_densityKey) == CheDeskDensity.compact.name
        ? CheDeskDensity.compact
        : CheDeskDensity.comfortable;
    textScalePref = switch (prefs.getString(_textScaleKey)) {
      'small' => CheTextScalePref.small,
      'large' => CheTextScalePref.large,
      _ => CheTextScalePref.defaultScale,
    };
    // Default ON — only honor an explicit false.
    voiceResponsesEnabled = prefs.getBool(_voiceEnabledKey) ?? true;
    voiceVolume = (prefs.getDouble(_voiceVolumeKey) ?? 1.0).clamp(0.0, 1.0);
    handsFreeWake = prefs.getBool(_handsFreeKey) ?? false;
    audioOutput = CheAudioOutput.values.firstWhere(
      (o) => o.name == prefs.getString(_audioOutputKey),
      orElse: () => CheAudioOutput.auto,
    );
    _loaded = true;
    notifyListeners();
  }

  // A palette saved by id; the older dark / light / system choice maps to the dark or light palette.
  CheColorPalette _paletteFromSaved(SharedPreferences prefs) {
    final id = prefs.getString(_paletteKey);
    if (id != null) return cheColorPaletteFor(id);
    return switch (prefs.getString(_themeKey)) {
      'light' => kCheLightPalette,
      _ => kCheDarkPalette,
    };
  }

  Future<void> setPalette(CheColorPalette next) async {
    if (palette.id == next.id) return;
    palette = next;
    CheActivePalette.current = next;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_paletteKey, next.id);
  }

  /// The older Dark / Light / System control, now choosing a palette: System keeps the dark palette.
  Future<void> setThemeMode(ThemeMode mode) =>
      setPalette(mode == ThemeMode.light ? kCheLightPalette : kCheDarkPalette);

  Future<void> setAvatarStyle(CheAvatarStyle style) async {
    if (avatarStyle == style) return;
    avatarStyle = style;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_avatarKey, style.name);
  }

  Future<void> setDeskDensity(CheDeskDensity density) async {
    if (deskDensity == density) return;
    deskDensity = density;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_densityKey, density.name);
  }

  Future<void> setTextScalePref(CheTextScalePref scale) async {
    if (textScalePref == scale) return;
    textScalePref = scale;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _textScaleKey,
      switch (scale) {
        CheTextScalePref.small => 'small',
        CheTextScalePref.large => 'large',
        CheTextScalePref.defaultScale => 'default',
      },
    );
  }

  Future<void> setVoiceResponsesEnabled(bool enabled) async {
    if (voiceResponsesEnabled == enabled) return;
    voiceResponsesEnabled = enabled;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_voiceEnabledKey, enabled);
  }

  Future<void> setVoiceVolume(double volume) async {
    final v = volume.clamp(0.0, 1.0);
    if ((voiceVolume - v).abs() < 0.001) return;
    voiceVolume = v;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_voiceVolumeKey, v);
  }

  Future<void> setAudioOutput(CheAudioOutput output) async {
    if (audioOutput == output) return;
    audioOutput = output;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_audioOutputKey, output.name);
  }

  Future<void> setHandsFreeWake(bool enabled) async {
    if (handsFreeWake == enabled) return;
    handsFreeWake = enabled;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_handsFreeKey, enabled);
  }

  Future<void> toggleVoiceResponses() =>
      setVoiceResponsesEnabled(!voiceResponsesEnabled);
}
