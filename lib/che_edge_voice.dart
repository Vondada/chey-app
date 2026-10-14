// Edge Ava is the voice on this route; the Worker tries CHE's Fish voice, then
// Mary, first. The reply header names the voice that actually spoke, and reports
// Fish's and Mary's status when they did not, so the phone never mislabels a clip.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_speech_pipeline.dart';

/// One /api/voice/edge reply. [clip] is null when the server spoke nothing.
/// [maryStatus] and [fishStatus] are Mary's and Fish's states in the Keys tab's
/// words, or empty when the server did not report them.
class CheEdgeResult {
  const CheEdgeResult({this.clip, this.maryStatus = '', this.fishStatus = ''});

  final CheVoiceClip? clip;
  final String maryStatus;
  final String fishStatus;
}

/// The engine label for a clip. A reply without a label is Edge Ava, the voice
/// this route speaks when the server does not name another.
String cheEdgeEngine(String? header) {
  final label = (header ?? '').trim();
  return label.isEmpty ? 'edge-ava' : label;
}

/// Why Mary did not speak, in words the owner can read. Empty when Mary spoke.
String cheMaryReason(String maryStatus, String engine) {
  if (engine == 'elevenlabs-mary' || maryStatus.isEmpty) return '';
  return switch (maryStatus) {
    'not set up' => 'Mary is not set up on the server',
    'unauthorized' => 'Mary\'s key was refused',
    'out of credits' => 'Mary is out of credits',
    'rate-limited' => 'Mary is resting after a rate limit',
    'network' => 'Mary could not be reached',
    'not tried yet' => 'Mary was not tried for this clip',
    _ => 'Mary did not speak this clip ($maryStatus)',
  };
}

/// The voice style for a reply to [ownerMessage]: 'story' when the owner asked
/// CHE to tell, read or narrate a story, otherwise 'conversation'. Only 'story'
/// uses Fish's expressive model (Drama 3), which can cost credits, so ordinary
/// questions that merely mention a story stay on the everyday voice. Decided on
/// the phone from the owner's own words: no AI call, no tokens.
String cheVoicePurposeFor(String ownerMessage) {
  final said = ownerMessage.toLowerCase();
  final asked = RegExp(
    r"\b(?:tell|read|narrate|make\s+up|write\s+and\s+read)\b[^.?!]{0,40}\b(?:story|stories|tale|fable|bedtime)\b",
  ).hasMatch(said);
  return asked || RegExp(r'\bnarrate\b').hasMatch(said) ? 'story' : 'conversation';
}

/// How long the phone waits for one server clip of [chars] characters. Fish's
/// time grows with the clip (about 0.6 s plus 33 ms per character on the owner's
/// account), so a fixed wait cut off ordinary reply chunks. The wait is a little
/// longer than the Worker's own Fish limit, and never longer than 30 seconds.
/// Drama 3 stories always get 30 seconds; chunks are prepared ahead of playback.
Duration cheVoiceWait(String purpose, {required Duration everyday, int chars = 0}) {
  const most = Duration(seconds: 30);
  if (purpose == 'story') return most;
  final scaled = Duration(milliseconds: 5000 + 40 * chars);
  final wait = scaled > everyday ? scaled : everyday;
  return wait > most ? most : wait;
}

/// Why CHE's Fish voice did not speak, in words the owner can read. Empty when
/// Fish spoke, or when Fish is not set up (that is shown in Keys, not per clip).
String cheFishReason(String fishStatus, String engine) {
  if (engine == 'fish-audio' || fishStatus.isEmpty || fishStatus == 'not set up') return '';
  return switch (fishStatus) {
    'needs a voice' => 'Fish has no voice chosen yet',
    'off' => 'Fish is switched off',
    'unauthorized' => 'Fish\'s key was refused',
    'out of credits' => 'Fish is out of credits',
    'model not available' => 'Fish\'s model is not available on this account',
    'rate-limited' => 'Fish is resting after a rate limit',
    'slow' => 'Fish was too slow, so a faster voice answered',
    'network' => 'Fish could not be reached',
    'daily limit reached' => 'Fish reached today\'s story limit',
    'not tried yet' => 'Fish was not tried for this clip',
    _ => 'Fish did not speak this clip ($fishStatus)',
  };
}

/// Fish's last known state, in words, for the diagnostics sheet.
String cheFishStateLabel(String fishStatus) => switch (fishStatus) {
      '' => 'Not asked yet this session',
      'healthy' => 'Working',
      'not tried yet' => 'Not used yet',
      'not set up' => 'Not set up on the server',
      'needs a voice' => 'Needs a voice ID',
      'off' => 'Switched off',
      'model not available' => 'Model not available on this account',
      'slow' => 'Too slow; resting',
      'daily limit reached' => 'Story limit reached today',
      _ => cheMaryStateLabel(fishStatus),
    };

/// The owner-facing name for a playback engine label, as the Worker and the
/// phone report it.
String cheVoiceEngineLabel(String? engine) => switch (engine) {
      null || '' => '—',
      'fish-audio' => 'CHE voice (Fish Audio)',
      'elevenlabs-mary' => 'Mary (ElevenLabs)',
      'edge-ava' => 'Edge Ava (free server voice)',
      'cloudflare-aura' => 'Aura (free server voice)',
      'huggingface-kokoro' => 'Kokoro (free server voice)',
      'gemini-tts' => 'Gemini voice',
      'openai-neural' => 'OpenAI voice',
      'neural' => 'Server neural voice',
      'iphone-neural' => 'iPhone neural voice',
      'iphone-tts' => 'iPhone system voice',
      _ => engine,
    };

/// Mary's last known state, in words, for the diagnostics sheet.
String cheMaryStateLabel(String maryStatus) => switch (maryStatus) {
      '' => 'Not asked yet this session',
      'healthy' => 'Working',
      'not tried yet' => 'Not used yet',
      'rate-limited' => 'Resting after a rate limit',
      'unauthorized' => 'Key refused',
      'out of credits' => 'Out of credits',
      'network' => 'Unreachable right now',
      'not set up' => 'Not set up on the server',
      _ => maryStatus,
    };

class CheEdgeVoice {
  static const voice = 'en-US-AvaNeural';

  static Future<CheEdgeResult> speak(String text, {String purpose = 'conversation'}) async {
    final said = text.trim();
    if (said.isEmpty) return const CheEdgeResult();
    final prefs = await SharedPreferences.getInstance();
    final base =
        prefs.getString('che_agent_base_url') ??
        const String.fromEnvironment(
          'CHE_AGENT_URL',
          defaultValue: 'https://chey-app.henryjavoni.workers.dev',
        );
    final token = prefs.getString('che_agent_device_token') ?? '';
    if (base.trim().isEmpty || token.isEmpty) return const CheEdgeResult();
    try {
      final response = await http
          .post(
            Uri.parse('${base.replaceAll(RegExp(r'/+$'), '')}/api/voice/edge'),
            headers: {
              'content-type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'text': said,
              'voice': voice,
              if (purpose != 'conversation') 'purpose': purpose,
            }),
          )
          .timeout(cheVoiceWait(purpose, everyday: const Duration(seconds: 12), chars: said.length));
      final maryStatus = (response.headers['x-che-mary'] ?? '').trim();
      final fishStatus = (response.headers['x-che-fish'] ?? '').trim();
      final type = response.headers['content-type'] ?? '';
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        return CheEdgeResult(maryStatus: maryStatus, fishStatus: fishStatus);
      }
      if (!type.contains('audio') && !type.contains('octet-stream')) {
        return CheEdgeResult(maryStatus: maryStatus, fishStatus: fishStatus);
      }
      return CheEdgeResult(
        clip: CheVoiceClip(
          response.bodyBytes,
          cheEdgeEngine(response.headers['x-che-voice']),
        ),
        maryStatus: maryStatus,
        fishStatus: fishStatus,
      );
    } catch (_) {
      return const CheEdgeResult();
    }
  }
}
