// One voice per spoken reply (owner, 2026-10-18), through the real speech
// pipeline: provider failures, voice consistency, uninterrupted playback and
// Stop / barge-in.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_edge_voice.dart';
import 'package:chey/che_speech_pipeline.dart';
import 'package:chey/che_voice_turn.dart';

/// A fake /api/voice/edge: [answer] decides each request.
class FakeServer {
  FakeServer(this.answer);
  final CheEdgeResult Function(String text, int index, String lock, int call) answer;
  final requests = <({String text, int index, String lock, String turn})>[];

  Future<CheEdgeResult> speak(String text, {required String turn, required int index, String lock = ''}) async {
    requests.add((text: text, index: index, lock: lock, turn: turn));
    await Future<void>.delayed(const Duration(milliseconds: 5));
    return answer(text, index, lock, requests.length);
  }
}

CheEdgeResult clip(String engine, {String tag = '', bool fallback = false}) => CheEdgeResult(
      clip: CheVoiceClip(Uint8List.fromList([1, 2, 3]), engine, tag: tag),
      tag: tag,
      fallback: fallback,
    );
const mary = 'elevenlabs:1a2b3c4d';
const fish = 'fish:9f8e7d6c';

/// Plays a reply of [parts] with [server]; returns what played and stayed silent.
Future<({List<String> played, Map<String, String> silent, CheVoiceTurn voice, CheSpeechPipeline<CheVoiceClip> turn})> speakReply(
  FakeServer server,
  List<String> parts, {
  void Function(CheSpeechPipeline<CheVoiceClip> turn, int played)? afterPlay,
}) async {
  final voice = CheVoiceTurn(server.speak);
  final played = <String>[];
  final silent = <String, String>{};
  final reasons = <String, String>{};
  late final CheSpeechPipeline<CheVoiceClip> turn;
  turn = CheSpeechPipeline<CheVoiceClip>(
    synthesize: (text) async {
      final made = await voice.synthesize(text);
      final c = made.result.clip;
      if (c == null) {
        reasons[text] = made.result.failure.isNotEmpty ? made.result.failure : cheSilentVoiceReason(made.result);
        return null;
      }
      return CheVoiceClip(c.bytes, c.engine, text: text, index: made.index, tag: made.result.tag);
    },
    play: (c) async {
      if (voice.stoppedBefore(c.index)) {
        reasons[c.text] = voice.interruption;
        return false;
      }
      played.add('${cheVoiceProviderOf(c.engine)}:${c.text}');
      afterPlay?.call(turn, played.length);
      return true;
    },
    fallback: (text) async {
      silent[text] = reasons[text] ?? 'unknown';
      return true;
    },
    onComplete: (cancelled) async {
      if (cancelled) voice.cancel();
    },
  );
  for (final p in parts) {
    turn.add(p);
  }
  turn.close();
  await turn.done;
  return (played: played, silent: silent, voice: voice, turn: turn);
}

void main() {
  test('every clip of a reply asks for the voice the first clip used', () async {
    final server = FakeServer((text, index, lock, call) => clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.']);
    expect(r.played, ['elevenlabs:One.', 'elevenlabs:Two.', 'elevenlabs:Three.']);
    expect(server.requests.map((q) => q.lock), ['', 'elevenlabs', 'elevenlabs']);
    expect(server.requests.map((q) => q.turn).toSet().length, 1, reason: 'one turn id for the whole reply');
    expect(r.voice.tags, {mary: 3});
  });

  test('when the chosen voice fails before playback, the backup speaks the whole reply', () async {
    final server = FakeServer((text, index, lock, call) =>
        index == 0 ? clip('fish-audio', tag: fish, fallback: true) : (lock == 'fish' ? clip('fish-audio', tag: fish) : clip('elevenlabs-mary', tag: mary)));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.']);
    expect(r.played, ['fish:One.', 'fish:Two.', 'fish:Three.']);
    expect(r.voice.fallback, isTrue);
    expect(server.requests.skip(1).every((q) => q.lock == 'fish'), isTrue, reason: 'never back to ElevenLabs mid-reply');
  });

  test('a failure partway stops the voice and says why instead of switching voices', () async {
    final server = FakeServer((text, index, lock, call) => index == 1
        ? const CheEdgeResult(maryStatus: 'network', fishStatus: 'healthy')
        : clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.']);
    expect(r.played, ['elevenlabs:One.'], reason: 'the third part never plays after the second was lost');
    expect(r.silent.keys, ['Two.', 'Three.']);
    expect(r.silent['Two.'], contains('ElevenLabs stopped partway'));
    expect(r.silent['Two.'], contains('Mary could not be reached'));
    expect(r.voice.interruptedAt, 1);
    expect(server.requests.where((q) => q.lock == 'fish'), isEmpty);
  });

  test('a lost answer from CHE\'s server is retried once with the same lock', () async {
    var failed = false;
    final server = FakeServer((text, index, lock, call) {
      if (index == 1 && !failed) {
        failed = true;
        return const CheEdgeResult(failure: 'could not reach CHE\'s server');
      }
      return clip('elevenlabs-mary', tag: mary);
    });
    final r = await speakReply(server, ['One.', 'Two.']);
    expect(r.played, ['elevenlabs:One.', 'elevenlabs:Two.']);
    expect(r.voice.retries, 1);
    expect(server.requests.where((q) => q.index == 1).map((q) => q.lock), ['elevenlabs', 'elevenlabs']);
  });

  test('a server that ignores the lock cannot change the voice mid-reply', () async {
    final server = FakeServer((text, index, lock, call) => index == 0 ? clip('elevenlabs-mary', tag: mary) : clip('fish-audio', tag: fish));
    final r = await speakReply(server, ['One.', 'Two.']);
    expect(r.played, ['elevenlabs:One.']);
    expect(r.silent['Two.'], contains('different voice'));
  });

  test('when neither voice speaks, each part stays silent with its reason and nothing is locked', () async {
    final server = FakeServer((text, index, lock, call) => const CheEdgeResult(maryStatus: 'out of credits', fishStatus: 'out of credits'));
    final r = await speakReply(server, ['One.', 'Two.']);
    expect(r.played, isEmpty);
    expect(r.silent['One.'], contains('Mary is out of credits'));
    expect(server.requests.map((q) => q.lock), ['', ''], reason: 'nothing spoke, so nothing was locked');
  });

  test('a first part that could not be spoken does not silence the rest (review of #338)', () async {
    final server = FakeServer((text, index, lock, call) => index == 0 ? const CheEdgeResult(maryStatus: 'rate-limited', fishStatus: 'network') : clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.']);
    expect(r.played, ['elevenlabs:Two.', 'elevenlabs:Three.']);
    expect(r.silent.keys, ['One.']);
    expect(server.requests.map((q) => q.lock), ['', '', 'elevenlabs'], reason: 'the second part decided the voice, one at a time');
  });

  test('a timed-out part is not asked again: the server may still be paying for it (review of #338)', () async {
    final server = FakeServer((text, index, lock, call) => index == 1 ? const CheEdgeResult(failure: 'no voice within 25 seconds', timedOut: true) : clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.']);
    expect(server.requests.where((q) => q.index == 1).length, 1);
    expect(r.played, ['elevenlabs:One.']);
  });

  test('a different voice from the same provider mid-reply stops the voice (review of #338)', () async {
    final server = FakeServer((text, index, lock, call) => clip('elevenlabs-mary', tag: index == 0 ? mary : 'elevenlabs:99999999'));
    final r = await speakReply(server, ['One.', 'Two.']);
    expect(r.played, ['elevenlabs:One.']);
    expect(r.silent['Two.'], contains('different voice'));
  });

  test('Stop / barge-in ends playback at once and asks for nothing more', () async {
    final server = FakeServer((text, index, lock, call) => clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.', 'Four.', 'Five.'], afterPlay: (turn, played) {
      if (played == 1) turn.cancel();
    });
    expect(r.played, ['elevenlabs:One.']);
    expect(r.silent, isEmpty, reason: 'a stopped reply shows no failure banner');
    expect(r.turn.cancelled, isTrue);
    final asked = server.requests.length;
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(server.requests.length, asked, reason: 'nothing is requested after Stop');
    expect(asked, lessThanOrEqualTo(3), reason: 'only the clips already being prepared');
  });

  test('clips are prepared ahead, so playback runs back to back', () async {
    final server = FakeServer((text, index, lock, call) => clip('elevenlabs-mary', tag: mary));
    final r = await speakReply(server, ['One.', 'Two.', 'Three.', 'Four.']);
    expect(r.played.length, 4);
    expect(r.turn.gapsMs.length, 3);
    expect(r.turn.gapsMs.every((gap) => gap < 50), isTrue, reason: 'gaps ${r.turn.gapsMs}');
    expect(r.turn.firstPlaybackMs, isNotNull);
  });

  test('the report says one voice, its timing and reasons, and never the words', () {
    final outcome = CheVoiceTurnOutcome()
      ..played('elevenlabs-mary')
      ..played('elevenlabs-mary')
      ..provider = 'elevenlabs'
      ..tags = {mary: 2}
      ..gapsMs = [40, 120]
      ..firstAudioMs = 900;
    outcome.timedClip(2300, 2100);
    final report = outcome.toReport();
    expect(report['switches'], 0);
    expect(report['gap_max_ms'], 120);
    expect(report['overhead_avg_ms'], 200);
    expect(report['first_audio_ms'], 900);
    expect(report.toString().contains('One.'), isFalse);
    expect(outcome.summary(), 'ElevenLabs, 2 of 2 clips spoken, one voice, longest gap 120 ms, iPhone setup about 200 ms a clip');
  });

  test('clip length is read from the MP3 or WAV header', () {
    // MPEG-1 Layer III, 128 kbps: 16,000 bytes a second.
    final mp3 = Uint8List(16000)..setAll(0, [0xff, 0xfb, 0x90, 0x64]);
    expect(cheAudioDurationMs(mp3), 1000);
    final wav = Uint8List(44 + 48000);
    wav.setAll(0, [0x52, 0x49, 0x46, 0x46]);
    ByteData.sublistView(wav).setUint32(28, 48000, Endian.little);
    expect(cheAudioDurationMs(wav), 1000);
    expect(cheAudioDurationMs(Uint8List.fromList([1, 2, 3])), isNull);
  });
}
