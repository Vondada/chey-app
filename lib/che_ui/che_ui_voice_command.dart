// Voice/typed commands that let CHE adjust her own UI on the spot
// ("dark mode", "make the text bigger", "volume down", ...). Handled on the
// phone, applied through CheUiPreferences, and confirmed aloud.

import 'package:flutter/material.dart';

import '../che_native_voice.dart';
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

    if (has(r'^(?:turn |switch )?(?:on )?hands[- ]?free(?: mode| listening)?(?: on)?$') ||
        has(r'^(?:always listen|listen all the time|keep (?:the|your) mic on)$')) {
      return const CheUiVoiceCommand._('handsFree', true);
    }
    if (has(r'^(?:turn |switch )?(?:off )?hands[- ]?free(?: mode| listening)? off$') ||
        has(r'^turn off hands[- ]?free(?: mode| listening)?$') ||
        has(r'^(?:stop listening all the time|only listen when i (?:press|use) the mic)$')) {
      return const CheUiVoiceCommand._('handsFree', false);
    }

    // Where her voice plays: "use the speaker", "talk through the earpiece",
    // "use my AirPods", "which speaker are you using?".
    const through = r'(?:use|switch to|go to|play (?:through|on|from|over)|talk (?:through|on|over)|speak (?:through|on|over)|put (?:it|your voice|yourself|the sound|the audio) on)';
    if (has('^$through (?:the |your )?(?:loud ?speaker|speaker ?phone|speaker|iphone speaker|phone speaker)\$') ||
        has(r'^(?:turn |put )?(?:the )?speaker ?phone on$') || has(r'^turn on (?:the )?speaker(?: ?phone)?$')) {
      return const CheUiVoiceCommand._('audioOutput', CheAudioOutput.speaker);
    }
    if (has('^$through (?:the |your )?(?:ear ?piece|receiver|phone earpiece|top speaker)\$') ||
        has(r'^(?:turn )?(?:the )?speaker ?phone off$') || has(r'^turn off (?:the )?speaker(?: ?phone)?$') ||
        has(r'^(?:talk|speak) (?:quietly )?(?:in|into) my ear$')) {
      return const CheUiVoiceCommand._('audioOutput', CheAudioOutput.receiver);
    }
    if (has('^$through (?:my |the )?(?:bluetooth|headphones?|head ?set|air ?pods?(?: pro| max)?|ear ?buds|car(?: speakers)?)\$') ||
        has(r'^(?:use |switch to )?(?:automatic|auto) (?:audio )?(?:output|speaker|route)$')) {
      return const CheUiVoiceCommand._('audioOutput', CheAudioOutput.auto);
    }
    if (has(r'^(?:which|what) (?:speaker|audio output|output|audio route)(?: are you| is your voice| is che)? ?(?:using|playing (?:through|on|from)|on)?$') ||
        has(r'^where (?:is|are) (?:your voice|you|the sound|your audio|the audio) (?:playing|coming (?:out|from)|coming out of)(?: from)?$') ||
        has(r'^(?:check|test) (?:your |the )?(?:audio output|speaker|audio route)$')) {
      return const CheUiVoiceCommand._('audioRoute');
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
        case 'handsFree':
          final on = value! as bool;
          await prefs.setHandsFreeWake(on);
          return on
              ? 'Done. Hands-free is on. I will keep listening for my name.'
              : 'Done. Hands-free is off. I only listen after you press the mic button.';
        case 'volume':
          final v = (value! as double).clamp(0.0, 1.0);
          await prefs.setVoiceVolume(v);
          return 'Done. Volume is ${(v * 100).round()} percent.';
        case 'volumeStep':
          final step = value! as double;
          if (step > 0 && prefs.voiceVolume >= 0.999) {
            // CHE never moves the iPhone's own volume; only its buttons do.
            final phone = cheIphoneVolumePercent(CheNativeVoice.lastPlayback);
            return 'My voice is already at full volume. For more, press your iPhone\'s volume up button while I am talking'
                '${phone == null ? '.' : '; it is at $phone percent.'}';
          }
          final v = (prefs.voiceVolume + step).clamp(0.05, 1.0);
          await prefs.setVoiceVolume(v);
          return 'Done. Volume is ${(v * 100).round()} percent.';
        case 'audioOutput':
          final output = value! as CheAudioOutput;
          final report = await CheNativeVoice.setAudioOutput(output.name);
          // A build that cannot use the earpiece keeps its old choice, so it
          // is not switched on unannounced after the next update.
          if (report != null || output != CheAudioOutput.receiver) await prefs.setAudioOutput(output);
          final choice = switch (output) {
            CheAudioOutput.speaker => 'I will speak through the loudspeaker, even with headphones or Bluetooth connected.',
            CheAudioOutput.receiver => 'I will speak through the earpiece. Hold the iPhone to your ear.',
            CheAudioOutput.auto => 'I will use your headphones, Bluetooth, AirPlay or car when they are connected, and the loudspeaker otherwise.',
          };
          if (report == null) {
            return output == CheAudioOutput.receiver
                ? 'This CHE build always speaks through the loudspeaker. Install the newest CHE build from Updates to use the earpiece.'
                : 'Done. $choice';
          }
          return 'Done. $choice Right now I am playing through ${cheAudioRouteSpoken(report)}.';
        case 'audioRoute':
          final report = await CheNativeVoice.audioRoute();
          if (report == null) {
            return 'This CHE build cannot tell me where my voice plays. It uses the loudspeaker unless headphones or Bluetooth are connected.';
          }
          final phone = cheIphoneVolumePercent(report);
          final choice = switch (prefs.audioOutput) {
            CheAudioOutput.speaker => 'Speaker',
            CheAudioOutput.receiver => 'Earpiece',
            CheAudioOutput.auto => 'Automatic',
          };
          return 'I am playing through ${cheAudioRouteSpoken(report)}. Audio Output is set to $choice. '
              'My Voice Volume is ${(prefs.voiceVolume * 100).round()} percent'
              '${phone == null ? '.' : ', and your iPhone volume is at $phone percent.'}';
      }
    } catch (_) {
      return 'I could not change that setting. Nothing was changed.';
    }
    return 'I could not change that setting.';
  }
}
