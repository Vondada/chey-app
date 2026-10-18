// CHE's voice on the iPhone (owner, 2026-10-14): the Worker tries her
// ElevenLabs voice (Mary), then Fish, and with `premium_only` nothing else.
// The reply header names the voice that actually spoke, and reports Mary's and
// Fish's status when they did not, so the phone never mislabels a clip and can
// say why it stayed silent.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'che_speech_pipeline.dart';

/// One /api/voice/edge reply. [clip] is null when the server spoke nothing.
/// [maryStatus] and [fishStatus] are Mary's and Fish's states in the Keys tab's
/// words, or empty when the server did not report them. [failure] says why the
/// phone got no answer at all (no connection, no answer in time, not paired).
class CheEdgeResult {
  const CheEdgeResult({
    this.clip,
    this.maryStatus = '',
    this.fishStatus = '',
    this.failure = '',
    this.tag = '',
    this.fallback = false,
    this.attempts = 1,
  });

  final CheVoiceClip? clip;
  final String maryStatus;
  final String fishStatus;
  final String failure;

  /// The server's fingerprint of the voice that spoke (provider:hash, no ID).
  final String tag;

  /// True when the backup voice spoke because the chosen one failed first.
  final bool fallback;

  /// How many tries the server needed for this clip.
  final int attempts;
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
    'needs a paid plan' => 'Mary\'s voice needs a paid ElevenLabs plan',
    'voice not found' => 'ElevenLabs cannot find Mary\'s voice ID',
    'refused text' => 'ElevenLabs refused this text',
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

/// How long the phone waits for one clip when only ElevenLabs and Fish may
/// speak. The Worker tries them one after the other, so the wait covers both
/// limits: ElevenLabs' 8 seconds plus a second for the trip, then Fish's own
/// limit for that clip (7 to 25 seconds for conversation, growing with the
/// clip; 60 seconds for a story). Giving up sooner would leave a valid Fish
/// clip unheard. Clips are prepared ahead of playback, so only the first clip
/// of a reply is ever waited on, and only when ElevenLabs is failing.
Duration chePremiumVoiceWait(String purpose, {int chars = 0}) {
  const elevenLabs = Duration(seconds: 9);
  if (purpose == 'story') return elevenLabs + const Duration(seconds: 61);
  var fish = Duration(milliseconds: 4000 + 40 * chars);
  if (fish < const Duration(seconds: 7)) fish = const Duration(seconds: 7);
  if (fish > const Duration(seconds: 25)) fish = const Duration(seconds: 25);
  return elevenLabs + fish;
}

/// How long the phone waits for a clip locked to one provider: the server
/// tries it at most twice (one short retry after a passing failure) and never
/// the other voice. Clips after the first are prepared while earlier ones play.
Duration cheLockedVoiceWait(String lock, String purpose, {int chars = 0}) {
  if (lock == 'elevenlabs') return const Duration(seconds: 19);
  final fish = chePremiumVoiceWait(purpose, chars: chars) - const Duration(seconds: 9);
  final both = fish * 2 + const Duration(seconds: 2);
  return both > const Duration(seconds: 90) ? const Duration(seconds: 90) : both;
}

/// Why CHE stayed silent for one clip, in words the owner can read: the phone's
/// own failure first, else why ElevenLabs and then Fish did not speak.
String cheSilentVoiceReason(CheEdgeResult result) {
  if (result.failure.isNotEmpty) return result.failure;
  final reasons = [
    cheMaryReason(result.maryStatus, 'none'),
    if (result.fishStatus == 'not set up') 'Fish is not set up' else cheFishReason(result.fishStatus, 'none'),
  ].where((r) => r.isNotEmpty).toList();
  return reasons.isEmpty ? 'neither ElevenLabs nor Fish sent audio' : reasons.join('; ');
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
      'elevenlabs-mary' => 'CHE voice (ElevenLabs)',
      'fish-audio' => 'Fish Audio (backup)',
      'none' => 'Silent (no voice spoke)',
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
      'needs a paid plan' => 'Needs a paid ElevenLabs plan for this voice',
      'voice not found' => 'Voice ID not found',
      'refused text' => 'Refused the last text',
      _ => maryStatus,
    };

class CheEdgeVoice {
  static const voice = 'en-US-AvaNeural';

  /// [premiumOnly] asks for ElevenLabs then Fish and no other voice; the
  /// server then answers 204 with both reasons when neither spoke.
  /// [turn] names the spoken reply, [index] the clip's place in it, and [lock]
  /// ('elevenlabs' or 'fish') keeps a later clip on the voice the first used.
  static Future<CheEdgeResult> speak(
    String text, {
    String purpose = 'conversation',
    bool premiumOnly = false,
    String turn = '',
    int index = -1,
    String lock = '',
  }) async {
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
    if (base.trim().isEmpty || token.isEmpty) {
      return const CheEdgeResult(failure: 'this iPhone is not paired with CHE\'s server');
    }
    final wait = lock.isNotEmpty
        ? cheLockedVoiceWait(lock, purpose, chars: said.length)
        : premiumOnly
        ? chePremiumVoiceWait(purpose, chars: said.length)
        : cheVoiceWait(purpose, everyday: const Duration(seconds: 12), chars: said.length);
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
              if (premiumOnly) 'premium_only': true,
              if (turn.isNotEmpty) 'turn': turn,
              if (index >= 0) 'index': index,
              if (lock.isNotEmpty) 'lock': lock,
            }),
          )
          .timeout(wait);
      final maryStatus = (response.headers['x-che-mary'] ?? '').trim();
      final fishStatus = (response.headers['x-che-fish'] ?? '').trim();
      final type = response.headers['content-type'] ?? '';
      if (response.statusCode == 401) {
        return CheEdgeResult(failure: 'CHE\'s server did not accept this iPhone (pair it again)', maryStatus: maryStatus, fishStatus: fishStatus);
      }
      if (response.statusCode != 200 && response.statusCode != 204) {
        return CheEdgeResult(failure: 'CHE\'s server answered HTTP ${response.statusCode}', maryStatus: maryStatus, fishStatus: fishStatus);
      }
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        return CheEdgeResult(maryStatus: maryStatus, fishStatus: fishStatus);
      }
      if (!type.contains('audio') && !type.contains('octet-stream')) {
        return CheEdgeResult(failure: 'CHE\'s server sent no audio', maryStatus: maryStatus, fishStatus: fishStatus);
      }
      final tag = (response.headers['x-che-voice-tag'] ?? '').trim();
      return CheEdgeResult(
        clip: CheVoiceClip(
          response.bodyBytes,
          cheEdgeEngine(response.headers['x-che-voice']),
          tag: tag,
        ),
        maryStatus: maryStatus,
        fishStatus: fishStatus,
        tag: tag,
        fallback: response.headers['x-che-voice-fallback'] == '1',
        attempts: int.tryParse(response.headers['x-che-voice-attempts'] ?? '') ?? 1,
      );
    } on TimeoutException {
      return CheEdgeResult(failure: 'no voice from CHE\'s server within ${wait.inSeconds} seconds');
    } catch (_) {
      return const CheEdgeResult(failure: 'could not reach CHE\'s server');
    }
  }

  /// What the phone heard for one spoken reply: engines, counts and reasons,
  /// never the words. The Worker keeps a short log of these for the deploy
  /// check, so a failure on the phone leaves evidence. Best effort only.
  static Future<void> report(Map<String, Object> outcome) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final base = prefs.getString('che_agent_base_url') ??
          const String.fromEnvironment('CHE_AGENT_URL', defaultValue: 'https://chey-app.henryjavoni.workers.dev');
      final token = prefs.getString('che_agent_device_token') ?? '';
      if (base.trim().isEmpty || token.isEmpty) return;
      await http
          .post(
            Uri.parse('${base.replaceAll(RegExp(r'/+$'), '')}/api/voice/report'),
            headers: {'content-type': 'application/json', 'Authorization': 'Bearer $token'},
            body: jsonEncode(outcome),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {}
  }
}

/// One spoken reply's outcome, for [CheEdgeVoice.report] and the diagnostics
/// sheet: which voice played each clip, how many stayed silent, and why.
class CheVoiceTurnOutcome {
  final Map<String, int> engines = {};
  final List<String> reasons = [];
  final List<String> silentText = [];
  int chunks = 0;
  int silent = 0;

  /// The reply's locked voice and how it went, for the report and diagnostics.
  String provider = '';
  Map<String, int> tags = const {};
  bool fallback = false;
  bool interrupted = false;
  bool stopped = false;
  int retries = 0;
  List<int> gapsMs = const [];
  List<int> synthMs = const [];
  int? firstAudioMs;

  /// Wall-clock playback time minus the clip's own length, per played clip:
  /// the iPhone's setup between clips, as far as it can be measured here.
  final List<int> overheadMs = [];

  void timedClip(int wallMs, int? audioMs) {
    if (audioMs == null || audioMs <= 0) return;
    final over = wallMs - audioMs;
    overheadMs.add(over < 0 ? 0 : over);
  }

  /// How many times the voice changed inside this reply. Always 0 since the
  /// turn lock; a non-zero value is a bug the deploy check can see.
  int get switches => tags.length > 1 ? tags.length - 1 : 0;

  static int _max(List<int> v) => v.isEmpty ? 0 : v.reduce((a, b) => a > b ? a : b);
  static int _avg(List<int> v) => v.isEmpty ? 0 : (v.reduce((a, b) => a + b) / v.length).round();

  /// One line for the diagnostics sheet: the voice, clips, and gaps.
  String summary() {
    if (chunks == 0) return '—';
    final voice = provider.isEmpty ? 'no voice' : (provider == 'elevenlabs' ? 'ElevenLabs' : 'Fish Audio');
    final parts = <String>[
      '$voice${fallback ? ' (backup, the chosen voice failed first)' : ''}',
      '${chunks - silent} of $chunks clips spoken',
      if (switches > 0) 'voice changed $switches times' else 'one voice',
      if (gapsMs.isNotEmpty) 'longest gap ${_max(gapsMs)} ms',
      if (overheadMs.isNotEmpty) 'iPhone setup about ${_avg(overheadMs)} ms a clip',
      if (interrupted) 'stopped partway',
      if (stopped) 'stopped by you',
    ];
    return parts.join(', ');
  }

  void played(String engine) {
    chunks += 1;
    engines[engine] = (engines[engine] ?? 0) + 1;
  }

  void stayedSilent(String text, String reason) {
    chunks += 1;
    silent += 1;
    silentText.add(text);
    if (reason.isNotEmpty && !reasons.contains(reason) && reasons.length < 6) reasons.add(reason);
  }

  Map<String, Object> toReport() => {
        'chunks': chunks,
        'played': chunks - silent,
        'silent': silent,
        'engines': engines,
        'reasons': reasons,
        if (provider.isNotEmpty) 'provider': provider,
        'tags': tags,
        'switches': switches,
        'fallback': fallback ? 1 : 0,
        'interrupted': interrupted ? 1 : 0,
        'stopped': stopped ? 1 : 0,
        'retries': retries,
        'gaps': gapsMs.length,
        'gap_max_ms': _max(gapsMs),
        'gap_avg_ms': _avg(gapsMs),
        'first_audio_ms': ?firstAudioMs,
        'synth_max_ms': _max(synthMs),
        'overhead_max_ms': _max(overheadMs),
        'overhead_avg_ms': _avg(overheadMs),
      };
}
