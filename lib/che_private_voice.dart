import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Private voice (owner question, 2026-10-25: "Is there a way I can use live
/// voice and it doesn't go to OpenAI or anyone and stays private?").
///
/// Not a new voice engine: it is the existing local voice loop
/// (che_local_voice_loop.dart) with three rules enforced in execution code:
///
/// 1. The OpenAI Realtime engine never connects ([allowsRealtime], checked in
///    cheUseLiveVoice and in CheRealtimeVoiceEngine.connect).
/// 2. Speech recognition must run on the iPhone (Apple's on-device
///    recognizer). If this iPhone or language cannot recognize on-device, CHE
///    says so and does not listen, instead of falling back to Apple's servers
///    ([recognitionRefusal], checked in CheNativeVoice.start and wake).
/// 3. Replies are spoken by the on-device Kokoro voice only: no ElevenLabs or
///    Fish ([allowsServerVoice], checked in CheEdgeVoice.speak).
///
/// Chat turns carry `private: true` ([chatFields]); the Worker then answers
/// with Cloudflare Workers AI in CHE's own account only and refuses tools that
/// would send the words to anyone else (server/cloudflare/private_voice.js).
/// The words themselves (text) still reach CHE's server to compute the answer.
class ChePrivateVoice {
  ChePrivateVoice._();

  static const prefsKey = 'che.voice.privateVoice';

  /// Persisted on this iPhone; false until the owner turns it on.
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  static bool get isOn => enabled.value;

  static Future<bool> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      enabled.value = prefs.getBool(prefsKey) ?? false;
    } catch (_) {}
    return enabled.value;
  }

  /// Saves the choice on this iPhone. Returns whether it was saved.
  static Future<bool> setEnabled(bool on) async {
    enabled.value = on;
    try {
      final prefs = await SharedPreferences.getInstance();
      return await prefs.setBool(prefsKey, on);
    } catch (_) {
      return false;
    }
  }

  /// The OpenAI Realtime engine streams microphone audio to OpenAI.
  static bool allowsRealtime() => !isOn;

  /// ElevenLabs and Fish receive the reply text to make audio.
  static bool allowsServerVoice() => !isOn;

  /// Fields every /api/chat request adds; empty while Private voice is off.
  static Map<String, Object> chatFields() => isOn ? const {'private': true} : const {};

  /// Why Private voice will not open the microphone, or null when it may.
  /// [status] is the native bridge's report (CheNativeVoice status), whose
  /// `on_device_recognition` is Apple's supportsOnDeviceRecognition.
  static String? recognitionRefusal(Map<String, dynamic> status) {
    if (!isOn) return null;
    if (status['on_device_recognition'] == true) return null;
    return unsupportedRecognitionReply;
  }

  static const unsupportedRecognitionReply =
      'Private voice is on, but this iPhone cannot recognize speech on the phone itself for this language, so I did '
      'not open the microphone. Apple would send the audio to its servers, and Private voice does not allow that. '
      'You can type to me, or say or type "turn off private voice" to use normal voice.';

  static const serverVoiceRefusal = 'Private voice is on, so CHE speaks only with her on-device voice';

  static const realtimeRefusal = 'Private voice is on, so live voice to OpenAI does not connect.';

  /// What CHE says when the owner turns it on or off.
  static String changedReply(bool on, {required bool saved}) {
    final keep = saved ? '' : ' I could not save that on this iPhone, so it lasts until CHE restarts.';
    return on
        ? 'Private voice is on. Your voice audio now stays on this iPhone: Apple\'s on-device recognizer hears you, '
            'and my on-device voice speaks. Live voice to OpenAI, ElevenLabs and Fish are off. Your words still go as '
            'text to my own server, where Cloudflare\'s AI in my own account works out the answer; no other AI '
            'company gets them, and I won\'t search the web or ask other AIs until you turn it off.$keep'
        : 'Private voice is off. Live voice, my ElevenLabs and Fish voices, web search and the other AIs can be '
            'used again.$keep';
  }

  /// "Is my voice private?" — answered from the actual current settings.
  static String dataFlowReply({
    required bool on,
    required bool? onDeviceRecognition,
    required bool kokoroReady,
    required bool liveVoiceConfigured,
  }) {
    if (on) {
      final recognizer = onDeviceRecognition == true
          ? 'Apple\'s on-device recognizer on this iPhone hears you, so the audio never leaves the phone.'
          : onDeviceRecognition == false
              ? 'This iPhone cannot recognize speech on the phone for this language, so I keep the microphone closed '
                  'rather than send audio to Apple. You can type instead.'
              : 'I could not confirm that this iPhone recognizes speech on the phone, so I will not open the '
                  'microphone until it does.';
      final voice = kokoroReady
          ? 'My replies are spoken by my on-device voice.'
          : 'My replies use only my on-device voice, which is still loading; until it is ready a reply is shown as '
              'text instead of spoken.';
      return 'Yes, Private voice is on. $recognizer $voice Live voice to OpenAI is off, and ElevenLabs and Fish are '
          'off. What still leaves the phone: the text of your words goes to my own server, and Cloudflare\'s AI in '
          'my own account works out the answer. No OpenAI, Google, Groq or other AI company receives them, and I '
          'won\'t search the web or ask other AIs. Passwords, your master profile and the vault never leave the '
          'phone at all. A fully offline answer would need an AI model running on the iPhone, which CHE does not '
          'have yet.';
    }
    final live = liveVoiceConfigured
        ? 'When live voice connects, your microphone audio streams to OpenAI to be transcribed.'
        : 'Live voice to OpenAI is not set up, so Apple\'s recognizer hears you; it runs on the iPhone when the phone '
            'supports that.';
    return 'No, Private voice is off. $live Your words go to my server, which may answer with outside AI services '
        'such as Groq, Google Gemini or Cerebras, and may search the web. My spoken replies are made by ElevenLabs '
        'or Fish, which receive the reply text. Say "turn on private voice" to keep your voice audio on the phone '
        'and your words with my own Cloudflare AI only.';
  }

  /// A spoken or typed Private voice command, or null.
  static ChePrivateVoiceCommand? parse(String text) {
    final t = text
        .toLowerCase()
        .replaceAll('’', "'")
        .replaceAll(RegExp(r'^(?:(?:hey|ok|okay)[\s,]+)?(?:chay|chey|che|shay)[\s,.:!?]+'), '')
        .replaceAll(RegExp(r'^(?:please|can you|could you)\s+'), '')
        .replaceAll(RegExp(r'[.!?]+$'), '')
        .trim();
    if (RegExp(r'^(?:turn|switch|put)\s+on\s+(?:the\s+)?private\s+(?:voice|mode)$|^(?:turn|switch|put)\s+(?:the\s+)?private\s+(?:voice|mode)\s+on$|^(?:enable|start|use)\s+(?:the\s+)?private\s+(?:voice|mode)$|^go\s+private$|^private\s+voice\s+on$')
        .hasMatch(t)) {
      return ChePrivateVoiceCommand.on;
    }
    if (RegExp(r'^(?:turn|switch)\s+off\s+(?:the\s+)?private\s+(?:voice|mode)$|^(?:turn|switch)\s+(?:the\s+)?private\s+(?:voice|mode)\s+off$|^(?:disable|stop)\s+(?:using\s+)?(?:the\s+)?private\s+(?:voice|mode)$|^private\s+voice\s+off$')
        .hasMatch(t)) {
      return ChePrivateVoiceCommand.off;
    }
    if (RegExp(r"^(?:is|are)\s+my\s+(?:voice|words|conversations?)\s+private$|^is\s+private\s+voice\s+on$|^(?:where|who)\s+does\s+my\s+voice\s+go|^what\s+(?:leaves|stays\s+on)\s+(?:my|the)\s+(?:phone|iphone)|^(?:is|am)\s+(?:this|i)\s+(?:conversation\s+)?private$|^how\s+private\s+is\s+my\s+voice$")
        .hasMatch(t)) {
      return ChePrivateVoiceCommand.status;
    }
    return null;
  }
}

enum ChePrivateVoiceCommand { on, off, status }

/// The visible state while Private voice is on: one quiet line in the status
/// chrome (never spoken by itself), read by VoiceOver.
class ChePrivateVoiceBanner extends StatelessWidget {
  const ChePrivateVoiceBanner({super.key, this.onTurnOff});

  final VoidCallback? onTurnOff;

  static const label = 'Private voice on: your voice stays on this iPhone; your words go only to CHE\'s own Cloudflare AI.';

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: ChePrivateVoice.enabled,
      builder: (context, on, _) {
        if (!on) return const SizedBox.shrink();
        return Container(
          key: const ValueKey('private-voice-banner'),
          width: double.infinity,
          color: const Color(0xFF1B2440),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(children: [
            const ExcludeSemantics(child: Icon(Icons.lock_outline, size: 18, color: Color(0xFFB9C7FF))),
            const SizedBox(width: 8),
            Expanded(
              child: Semantics(
                label: label,
                excludeSemantics: true,
                child: const Text(
                  'Private voice on · voice stays on this iPhone',
                  style: TextStyle(color: Color(0xFFDDE4FF), fontSize: 15, fontWeight: FontWeight.w600),
                ),
              ),
            ),
            if (onTurnOff != null)
              Semantics(
                button: true,
                label: 'Turn off private voice',
                excludeSemantics: true,
                child: TextButton(onPressed: onTurnOff, child: const Text('Turn off')),
              ),
          ]),
        );
      },
    );
  }
}
