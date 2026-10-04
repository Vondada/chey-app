// Voice/typed commands that let CHE adjust her own UI on the spot
// ("dark mode", "make the text bigger", "volume down", ...). Handled on the
// phone, applied through CheUiPreferences, and confirmed aloud.

import 'package:flutter/material.dart';

import 'che_ui_preferences.dart';

class CheUiVoiceCommand {
  const CheUiVoiceCommand._(this.kind, [this.value]);

  final String kind;
  final Object? value;

  static final _lead = RegExp(r'^(?:hey\s+)?(?:che|chay|chey)[,:]?\s+', caseSensitive: false);
  static final _polite = RegExp(r'^(?:please\s+|can you\s+|could you\s+)', caseSensitive: false);

  /// Returns a command only for short, clearly UI-directed phrases, so normal
  /// requests that merely mention a topic ("write about dark mode") go to CHE.
  static CheUiVoiceCommand? parse(String raw) {
    var t = raw.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
    t = t.replaceFirst(_lead, '').replaceFirst(_polite, '').trim();
    if (t.isEmpty || t.length > 60) return null;
    bool has(String pattern) => RegExp(pattern).hasMatch(t);

    if (has(r'^(?:switch to |turn on |use |go )?dark (?:mode|theme)$')) {
      return const CheUiVoiceCommand._('theme', ThemeMode.dark);
    }
    if (has(r'^(?:switch to |turn on |use |go )?light (?:mode|theme)$')) {
      return const CheUiVoiceCommand._('theme', ThemeMode.light);
    }
    if (has(r'^(?:use )?(?:system|automatic|auto) (?:mode|theme)$')) {
      return const CheUiVoiceCommand._('theme', ThemeMode.system);
    }

    if (has(r'^(?:make (?:the )?)?(?:text|font|words?) (?:bigger|larger)$') || has(r'^(?:bigger|larger) (?:text|font)$')) {
      return const CheUiVoiceCommand._('text', 1);
    }
    if (has(r'^(?:make (?:the )?)?(?:text|font|words?) smaller$') || has(r'^smaller (?:text|font)$')) {
      return const CheUiVoiceCommand._('text', -1);
    }
    if (has(r'^(?:normal|default|regular) (?:text|font)(?: size)?$') || has(r'^reset (?:the )?text size$')) {
      return const CheUiVoiceCommand._('text', 0);
    }

    if (has(r'^(?:make (?:the )?)?desks? (?:compact|smaller|tighter)$') || has(r'^compact (?:desks?|office)$')) {
      return const CheUiVoiceCommand._('density', CheDeskDensity.compact);
    }
    if (has(r'^(?:make (?:the )?)?desks? (?:roomy|comfortable|bigger)$') || has(r'^comfortable (?:desks?|office)$')) {
      return const CheUiVoiceCommand._('density', CheDeskDensity.comfortable);
    }
    if (has(r'^(?:use )?portrait avatars?$')) return const CheUiVoiceCommand._('avatar', CheAvatarStyle.portrait);
    if (has(r'^(?:use )?mini avatars?$')) return const CheUiVoiceCommand._('avatar', CheAvatarStyle.mini);

    if (has(r'^(?:turn )?(?:your )?voice(?: replies)? off$') ||
        has(r'^turn off (?:your )?voice(?: replies)?$') ||
        has(r'^mute (?:your )?voice$')) {
      return const CheUiVoiceCommand._('voice', false);
    }
    if (has(r'^(?:turn )?(?:your )?voice(?: replies)? on$') ||
        has(r'^turn on (?:your )?voice(?: replies)?$') ||
        has(r'^unmute (?:your )?voice$')) {
      return const CheUiVoiceCommand._('voice', true);
    }

    final pct = RegExp(r'^(?:set )?(?:your )?volume (?:to )?(\d{1,3})(?: ?%| percent)?$').firstMatch(t);
    if (pct != null) {
      final v = int.parse(pct.group(1)!).clamp(0, 100);
      return CheUiVoiceCommand._('volume', v / 100);
    }
    if (has(r'^(?:turn (?:it |the volume |your volume )?up|volume up|louder|speak louder|talk louder)$')) {
      return const CheUiVoiceCommand._('volumeStep', 0.15);
    }
    if (has(r'^(?:turn (?:it |the volume |your volume )?down|volume down|quieter|speak quieter|softer|speak softer)$')) {
      return const CheUiVoiceCommand._('volumeStep', -0.15);
    }
    return null;
  }

  /// Applies the change and returns the sentence CHE speaks to confirm it.
  Future<String> apply(CheUiPreferences prefs) async {
    try {
      switch (kind) {
        case 'theme':
          final mode = value! as ThemeMode;
          await prefs.setThemeMode(mode);
          return switch (mode) {
            ThemeMode.dark => 'Done. Dark mode is on.',
            ThemeMode.light => 'Done. Light mode is on.',
            ThemeMode.system => 'Done. My theme now follows your iPhone.',
          };
        case 'text':
          const order = [CheTextScalePref.small, CheTextScalePref.defaultScale, CheTextScalePref.large];
          final step = value! as int;
          final current = order.indexOf(prefs.textScalePref);
          final next = step == 0 ? 1 : (current + step).clamp(0, order.length - 1);
          if (step != 0 && next == current) {
            return step > 0 ? 'The text is already at the largest size.' : 'The text is already at the smallest size.';
          }
          await prefs.setTextScalePref(order[next]);
          return switch (order[next]) {
            CheTextScalePref.large => 'Done. Text is now large.',
            CheTextScalePref.small => 'Done. Text is now small.',
            CheTextScalePref.defaultScale => 'Done. Text is back to the normal size.',
          };
        case 'density':
          final d = value! as CheDeskDensity;
          await prefs.setDeskDensity(d);
          return d == CheDeskDensity.compact ? 'Done. Office desks are compact.' : 'Done. Office desks are roomy.';
        case 'avatar':
          final a = value! as CheAvatarStyle;
          await prefs.setAvatarStyle(a);
          return a == CheAvatarStyle.portrait ? 'Done. Using portrait avatars.' : 'Done. Using mini avatars.';
        case 'voice':
          final on = value! as bool;
          await prefs.setVoiceResponsesEnabled(on);
          return on
              ? 'Done. I will answer out loud again.'
              : 'Done. My replies will be text only until you turn my voice back on.';
        case 'volume':
          final v = (value! as double).clamp(0.0, 1.0);
          await prefs.setVoiceVolume(v);
          return 'Done. Volume is ${(v * 100).round()} percent.';
        case 'volumeStep':
          final v = (prefs.voiceVolume + (value! as double)).clamp(0.05, 1.0);
          await prefs.setVoiceVolume(v);
          return 'Done. Volume is ${(v * 100).round()} percent.';
      }
    } catch (_) {
      return 'I could not change that setting. Nothing was changed.';
    }
    return 'I could not change that setting.';
  }
}
