// In-app UI Controls — live preferences persisted on device.
// Theme, avatar style, desk density, text scale, and voice replies/volume.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum CheAvatarStyle { mini, portrait }

enum CheDeskDensity { comfortable, compact }

enum CheTextScalePref { small, defaultScale, large }

/// Singleton ChangeNotifier for live UI + voice reply preferences.
class CheUiPreferences extends ChangeNotifier {
  CheUiPreferences._();
  static final CheUiPreferences instance = CheUiPreferences._();

  static const _themeKey = 'che.ui.themeMode';
  static const _avatarKey = 'che.ui.avatarStyle';
  static const _densityKey = 'che.ui.deskDensity';
  static const _textScaleKey = 'che.ui.textScale';
  static const _voiceEnabledKey = 'che.ui.voiceResponsesEnabled';
  static const _voiceVolumeKey = 'che.ui.voiceVolume';

  bool _loaded = false;
  bool get isLoaded => _loaded;

  ThemeMode themeMode = ThemeMode.dark;
  // Owner asked for CHE to appear as her female character by default.
  CheAvatarStyle avatarStyle = CheAvatarStyle.portrait;
  CheDeskDensity deskDensity = CheDeskDensity.comfortable;
  CheTextScalePref textScalePref = CheTextScalePref.defaultScale;
  bool voiceResponsesEnabled = true;
  double voiceVolume = 1.0;

  double get textScale => switch (textScalePref) {
        CheTextScalePref.small => 0.90,
        CheTextScalePref.defaultScale => 1.0,
        CheTextScalePref.large => 1.18,
      };

  bool get deskCompact => deskDensity == CheDeskDensity.compact;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    themeMode = _parseTheme(prefs.getString(_themeKey));
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
    _loaded = true;
    notifyListeners();
  }

  ThemeMode _parseTheme(String? raw) => switch (raw) {
        'light' => ThemeMode.light,
        'system' => ThemeMode.system,
        _ => ThemeMode.dark,
      };

  Future<void> setThemeMode(ThemeMode mode) async {
    if (themeMode == mode) return;
    themeMode = mode;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _themeKey,
      switch (mode) {
        ThemeMode.light => 'light',
        ThemeMode.system => 'system',
        ThemeMode.dark => 'dark',
      },
    );
  }

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

  Future<void> toggleVoiceResponses() =>
      setVoiceResponsesEnabled(!voiceResponsesEnabled);
}
