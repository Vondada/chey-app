// One voice per spoken reply (owner, 2026-10-18).
//
// Each reply gets a turn id. Its first clip asks the server for CHE's chosen
// voice, and the server may answer with the allowed backup when the chosen
// one fails before anything has played. Whatever spoke the first clip is
// locked: every later clip asks for that provider only (the server keeps the
// voice ID, model, speed and settings the turn started with). A later clip that
// cannot be spoken by the locked voice gets one retry, then the reply stops
// speaking and says why; the rest stays on screen. It never changes voice
// halfway through.

import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'che_edge_voice.dart';

/// 'elevenlabs' or 'fish' for a playback engine label, else ''.
String cheVoiceProviderOf(String? engine) {
  final label = engine ?? '';
  if (label.startsWith('elevenlabs')) return 'elevenlabs';
  if (label.startsWith('fish')) return 'fish';
  return '';
}

/// The owner-facing name of a locked provider.
String cheVoiceProviderLabel(String provider) => switch (provider) {
      'elevenlabs' => 'ElevenLabs',
      'fish' => 'Fish Audio',
      _ => 'CHE\'s voice',
    };

/// Asks the server for one clip of turn [turn].
typedef CheTurnSpeak = Future<CheEdgeResult> Function(String text, {required String turn, required int index, String lock});

/// One synthesized clip of a turn and its place in the reply.
class CheTurnClip {
  const CheTurnClip(this.index, this.result);
  final int index;
  final CheEdgeResult result;
}

class CheVoiceTurn {
  CheVoiceTurn(this._speak, {String? id, Random? random}) : id = id ?? _newId(random ?? Random());

  static String _newId(Random random) {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return 'turn-${List.generate(16, (_) => letters[random.nextInt(letters.length)]).join()}';
  }

  final String id;
  final CheTurnSpeak _speak;
  int _next = 0;
  // Until a clip has spoken, clips decide the voice one at a time, in order, so two
  // clips can never lock to different voices. Once one has spoken, the rest go ahead
  // in parallel on that lock.
  Future<void> _deciding = Future<void>.value();

  /// The provider that spoke the first spoken clip; '' until one has.
  String provider = '';

  /// The voice fingerprint of the first spoken clip.
  String tag = '';

  /// True when the first spoken clip came from the backup voice.
  bool fallback = false;

  /// Why the reply stopped speaking partway (empty while it speaks).
  String interruption = '';

  /// The first clip that was not spoken because of [interruption].
  int? interruptedAt;

  /// Phone-side retries (no answer from CHE's server) and voice tags heard.
  int retries = 0;
  final Map<String, int> tags = {};
  bool _cancelled = false;

  bool get interrupted => interruption.isNotEmpty;

  /// Stop or barge-in: later clips are not requested.
  void cancel() => _cancelled = true;

  /// True when clip [index] must not play: the reply stopped speaking before it.
  bool stoppedBefore(int index) => interruptedAt != null && index >= interruptedAt!;

  /// Synthesizes the next clip of the reply, in the order clips arrive.
  Future<CheTurnClip> synthesize(String text) async {
    final index = _next++;
    if (provider.isEmpty) {
      final before = _deciding;
      final mine = Completer<void>();
      _deciding = mine.future;
      try {
        await before;
        if (provider.isEmpty) return CheTurnClip(index, await _unlocked(index, text));
      } finally {
        mine.complete();
      }
    }
    return CheTurnClip(index, await _locked(index, text));
  }

  // A lost answer (no connection) is asked once more; a timeout is not, because the
  // server may still be making, and paying for, that clip.
  Future<CheEdgeResult> _ask(String text, int index, String lock) async {
    var r = await _speak(text, turn: id, index: index, lock: lock);
    if (r.clip == null && r.failure.isNotEmpty && !r.timedOut && !_cancelled && !stoppedBefore(index)) {
      retries += 1;
      r = await _speak(text, turn: id, index: index, lock: lock);
    }
    return r;
  }

  // Before anything has spoken: the chosen voice, or the allowed backup. A clip neither
  // could speak stays silent with its reason, and the next clip tries again.
  Future<CheEdgeResult> _unlocked(int index, String text) async {
    if (_cancelled) return const CheEdgeResult(failure: 'stopped');
    final r = await _ask(text, index, '');
    final spoke = cheVoiceProviderOf(r.clip?.engine);
    if (spoke.isNotEmpty) {
      provider = spoke;
      tag = r.tag;
      fallback = r.fallback;
      _hear(r.tag);
    }
    return r;
  }

  Future<CheEdgeResult> _locked(int index, String text) async {
    if (_cancelled) return const CheEdgeResult(failure: 'stopped');
    if (stoppedBefore(index)) return CheEdgeResult(failure: interruption);
    final r = await _ask(text, index, provider);
    final spoke = cheVoiceProviderOf(r.clip?.engine);
    final otherVoice = spoke.isNotEmpty && (spoke != provider || (tag.isNotEmpty && r.tag.isNotEmpty && r.tag != tag));
    if (spoke.isEmpty || otherVoice) {
      // The locked voice could not speak this part, or another voice answered (an older
      // server, or settings that changed mid-reply): the reply stops here rather than
      // change voice.
      final why = spoke.isEmpty ? cheSilentVoiceReason(r) : 'a different voice answered';
      _stop(index, '${cheVoiceProviderLabel(provider)} stopped partway through this reply ($why), so the rest is on screen');
      return CheEdgeResult(failure: interruption, maryStatus: r.maryStatus, fishStatus: r.fishStatus);
    }
    _hear(r.tag);
    return r;
  }

  void _hear(String tag) {
    if (tag.isEmpty) return;
    tags[tag] = (tags[tag] ?? 0) + 1;
  }

  void _stop(int index, String why) {
    if (interruptedAt == null || index < interruptedAt!) {
      interruptedAt = index;
      interruption = why;
    }
  }
}

/// About how long [bytes] of MP3 (constant bitrate, as ElevenLabs and Fish
/// send) or WAV audio play, in milliseconds; null when the format is unknown.
int? cheAudioDurationMs(Uint8List bytes) {
  if (bytes.length > 44 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46) {
    final view = ByteData.sublistView(bytes);
    final byteRate = view.getUint32(28, Endian.little);
    return byteRate > 0 ? ((bytes.length - 44) * 1000 / byteRate).round() : null;
  }
  var offset = 0;
  if (bytes.length > 10 && bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33) {
    offset = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  }
  for (var i = offset; i + 3 < bytes.length && i < offset + 4096; i++) {
    if (bytes[i] != 0xff || (bytes[i + 1] & 0xe0) != 0xe0) continue;
    final version = (bytes[i + 1] >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    final layer = (bytes[i + 1] >> 1) & 0x03; // 1 = Layer III
    final index = (bytes[i + 2] >> 4) & 0x0f;
    if (layer != 1 || index == 0 || index == 15 || version == 1) continue;
    const mpeg1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const mpeg2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    final kbps = (version == 3 ? mpeg1 : mpeg2)[index];
    return ((bytes.length - i) * 8 / kbps).round();
  }
  return null;
}
