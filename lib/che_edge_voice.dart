// Edge Ava is the voice on this route, and the Worker tries Mary first. The reply
// header names the voice that actually spoke, and reports Mary's status when she
// did not, so the phone never labels a Mary clip as Edge Ava or the reverse.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_speech_pipeline.dart';

/// One /api/voice/edge reply. [clip] is null when the server spoke nothing.
/// [maryStatus] is Mary's state in the Keys tab's words, or empty when the
/// server did not report it.
class CheEdgeResult {
  const CheEdgeResult({this.clip, this.maryStatus = ''});

  final CheVoiceClip? clip;
  final String maryStatus;
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

/// The owner-facing name for a playback engine label, as the Worker and the
/// phone report it.
String cheVoiceEngineLabel(String? engine) => switch (engine) {
      null || '' => '—',
      'elevenlabs-mary' => 'Mary (ElevenLabs)',
      'edge-ava' => 'Edge Ava (free server voice)',
      'cloudflare-aura' => 'Aura (free server voice)',
      'huggingface-kokoro' => 'Kokoro (free server voice)',
      'gemini-tts' => 'Gemini voice',
      'openai-neural' => 'OpenAI voice',
      'neural' => 'Server neural voice',
      'iphone-neural' => 'iPhone neural voice',
      'iphone-tts' => 'iPhone system voice',
      _ => engine ?? '—',
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

  static Future<CheEdgeResult> speak(String text) async {
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
            body: jsonEncode({'text': said, 'voice': voice}),
          )
          .timeout(const Duration(seconds: 12));
      final maryStatus = (response.headers['x-che-mary'] ?? '').trim();
      final type = response.headers['content-type'] ?? '';
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        return CheEdgeResult(maryStatus: maryStatus);
      }
      if (!type.contains('audio') && !type.contains('octet-stream')) {
        return CheEdgeResult(maryStatus: maryStatus);
      }
      return CheEdgeResult(
        clip: CheVoiceClip(
          response.bodyBytes,
          cheEdgeEngine(response.headers['x-che-voice']),
        ),
        maryStatus: maryStatus,
      );
    } catch (_) {
      return const CheEdgeResult();
    }
  }
}
