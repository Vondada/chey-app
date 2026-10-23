// In-app UI Controls — live preferences persisted on device.
// Theme, avatar style, desk density, text scale, and voice replies/volume.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_active_palette.dart';
import 'che_palettes.dart';

enum CheAvatarStyle { mini, portrait }

enum CheDeskDensity { comfortable, compact }

enum CheTextScalePref { small, defaultScale, large }

/// Spacing of the screens that read it (Trading Room, Owner Improvements, Office desks).
enum CheLayoutDensity { compact, comfortable, spacious }

/// The Trading Room chart's size.
enum CheChartHeight { compact, standard, tall }

/// Where CHE's voice plays. [auto]: the loudspeaker, or the headphones,
/// Bluetooth, AirPlay or car the owner connected. [speaker]: always the
/// loudspeaker. [receiver]: the earpiece, held to the ear.
enum CheAudioOutput { auto, speaker, receiver }

/// Singleton ChangeNotifier for live UI + voice reply preferences.
class CheUiPreferences extends ChangeNotifier {
  CheUiPreferences._();
  static final CheUiPreferences instance = CheUiPreferences._();

  static const _themeKey = 'che.ui.themeMode';
  // The owner's palette (che_palettes.dart ids). Saved once chosen; HUD glass is the default.
  static const _paletteKey = 'che.ui.palette';
  // Set once the owner picks a palette after the HUD look shipped. Until then, the earlier dark palettes show the
  // HUD look the owner approved (2026-10-22); a choice made afterwards is always kept.
  static const _paletteChosenKey = 'che.ui.paletteChosenAfterHud';
  static const _avatarKey = 'che.ui.avatarStyle';
  static const _densityKey = 'che.ui.deskDensity';
  static const _textScaleKey = 'che.ui.textScale';
  static const _voiceEnabledKey = 'che.ui.voiceResponsesEnabled';
  static const _voiceVolumeKey = 'che.ui.voiceVolume';
  static const _handsFreeKey = 'che.ui.handsFreeWake';
  static const _audioOutputKey = 'che.ui.audioOutput';
  // Owner Improvements (server/cloudflare/owner_improvements.js UI_CONFIG): the owner's preferences set by voice.
  static const _layoutDensityKey = 'che.ui.layoutDensity';
  static const _chartHeightKey = 'che.ui.chartHeight';
  static const _chartPortraitKey = 'che.ui.chartPortrait';
  static const _successColorKey = 'che.ui.successColor';
  static const _ownerConfigRevKey = 'che.ui.ownerConfigRev';

  bool _loaded = false;
  bool get isLoaded => _loaded;

  CheColorPalette palette = kCheHudPalette;
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
  CheLayoutDensity layoutDensity = CheLayoutDensity.comfortable;
  CheChartHeight chartHeight = CheChartHeight.standard;
  // "Remember that I prefer portrait charts": a tall chart while the iPhone is upright. Nothing rotates the screen.
  bool chartPortrait = false;
  // 'mint' (default), 'chrome_green', 'ice' or 'silver'. Status always carries a word too, never color alone.
  String successColorId = 'mint';
  int ownerConfigRev = 0;

  double get textScale => switch (textScalePref) {
        CheTextScalePref.small => 0.90,
        CheTextScalePref.defaultScale => 1.0,
        CheTextScalePref.large => 1.18,
      };

  bool get deskCompact => deskDensity == CheDeskDensity.compact;

  /// Multiplies padding and gaps on the screens that read the layout density.
  double get spacing => switch (layoutDensity) {
        CheLayoutDensity.compact => 0.6,
        CheLayoutDensity.comfortable => 1.0,
        CheLayoutDensity.spacious => 1.5,
      };

  /// The chart height for a screen that asked for [base]. Portrait preference makes it a tall chart while upright.
  double chartHeightFor(double base, {Size? screen}) {
    final scaled = base *
        switch (chartHeight) {
          CheChartHeight.compact => 0.7,
          CheChartHeight.standard => 1.0,
          CheChartHeight.tall => 1.35,
        };
    if (chartPortrait && screen != null && screen.height > screen.width) {
      return scaled < screen.height * 0.55 ? screen.height * 0.55 : scaled;
    }
    return scaled;
  }

  static const Map<String, Color> successColors = {
    'mint': Color(0xFF8FF5C9),
    'chrome_green': Color(0xFF6FF0B4),
    'ice': Color(0xFF9FE9FF),
    'silver': Color(0xFF9FB0C2),
  };

  /// The color of a finished, successful action.
  Color get successColor => successColors[successColorId] ?? successColors['mint']!;

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
    layoutDensity = CheLayoutDensity.values.firstWhere((d) => d.name == prefs.getString(_layoutDensityKey), orElse: () => CheLayoutDensity.comfortable);
    chartHeight = CheChartHeight.values.firstWhere((h) => h.name == prefs.getString(_chartHeightKey), orElse: () => CheChartHeight.standard);
    chartPortrait = prefs.getBool(_chartPortraitKey) ?? false;
    final color = prefs.getString(_successColorKey);
    successColorId = successColors.containsKey(color) ? color! : 'mint';
    ownerConfigRev = prefs.getInt(_ownerConfigRevKey) ?? 0;
    _loaded = true;
    notifyListeners();
  }

  /// The owner's preference values (owner_improvements.js UI_CONFIG) as this app uses them right now.
  Map<String, String> ownerConfigSnapshot() => {
        'layout.density': layoutDensity.name,
        'chart.height': chartHeight.name,
        'chart.orientation': chartPortrait ? 'portrait' : 'follow_device',
        'status.success_color': successColorId,
        'text.size': switch (textScalePref) {
          CheTextScalePref.small => 'small',
          CheTextScalePref.defaultScale => 'default',
          CheTextScalePref.large => 'large',
        },
      };

  /// Applies the owner's stored preferences from CHE's server. Only a newer revision applies, so a change made
  /// later on this phone (UI Controls) is not overwritten by an older server copy. Unknown keys and values are
  /// ignored. Returns what this app now uses, read back from its own state.
  Future<Map<String, String>> applyOwnerConfig(Map<String, dynamic> values, {required int rev, bool force = false}) async {
    if (!force && rev <= ownerConfigRev) return ownerConfigSnapshot();
    final prefs = await SharedPreferences.getInstance();
    String? v(String key) => values[key] is String ? values[key] as String : null;
    final density = CheLayoutDensity.values.where((d) => d.name == v('layout.density')).firstOrNull;
    if (density != null) {
      layoutDensity = density;
      await prefs.setString(_layoutDensityKey, density.name);
      // The Office desks have two sizes: compact, or roomy for comfortable and spacious.
      await setDeskDensity(density == CheLayoutDensity.compact ? CheDeskDensity.compact : CheDeskDensity.comfortable);
    }
    final height = CheChartHeight.values.where((h) => h.name == v('chart.height')).firstOrNull;
    if (height != null) {
      chartHeight = height;
      await prefs.setString(_chartHeightKey, height.name);
    }
    if (v('chart.orientation') == 'portrait' || v('chart.orientation') == 'follow_device') {
      chartPortrait = v('chart.orientation') == 'portrait';
      await prefs.setBool(_chartPortraitKey, chartPortrait);
    }
    final color = v('status.success_color');
    if (color != null && successColors.containsKey(color)) {
      successColorId = color;
      await prefs.setString(_successColorKey, color);
    }
    final text = switch (v('text.size')) {
      'small' => CheTextScalePref.small,
      'default' => CheTextScalePref.defaultScale,
      'large' => CheTextScalePref.large,
      _ => null,
    };
    if (text != null) await setTextScalePref(text);
    ownerConfigRev = rev > ownerConfigRev ? rev : ownerConfigRev;
    await prefs.setInt(_ownerConfigRevKey, ownerConfigRev);
    notifyListeners();
    return ownerConfigSnapshot();
  }

  // A palette saved by id; the older dark / light / system choice maps to HUD glass or the light palette. An earlier
  // dark palette saved before the HUD look shipped shows HUD glass; the light palette stays light.
  CheColorPalette _paletteFromSaved(SharedPreferences prefs) {
    final id = prefs.getString(_paletteKey);
    final chosenAfterHud = prefs.getBool(_paletteChosenKey) ?? false;
    if (id != null) {
      final saved = cheColorPaletteFor(id);
      if (!chosenAfterHud && (saved.id == kCheDarkPalette.id || saved.id == kCheSilverBlackPalette.id)) return kCheHudPalette;
      return saved;
    }
    return switch (prefs.getString(_themeKey)) {
      'light' => kCheLightPalette,
      _ => kCheHudPalette,
    };
  }

  Future<void> setPalette(CheColorPalette next) async {
    if (palette.id == next.id) return;
    palette = next;
    CheActivePalette.current = next;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_paletteKey, next.id);
    await prefs.setBool(_paletteChosenKey, true);
  }

  /// The older Dark / Light / System control, now choosing a palette: Dark and System choose HUD glass.
  Future<void> setThemeMode(ThemeMode mode) =>
      setPalette(mode == ThemeMode.light ? kCheLightPalette : kCheHudPalette);

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
