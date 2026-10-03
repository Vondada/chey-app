import 'dart:async';

/// Coalesces high-frequency streaming text updates so token arrival does not
/// rebuild the conversation on every network chunk. The latest value always wins.
class CheStreamBatcher {
  CheStreamBatcher(this.onFlush, {this.interval = const Duration(milliseconds: 65)});
  final void Function(String value) onFlush;
  final Duration interval;
  Timer? _timer;
  String? _pending;

  void add(String value) {
    _pending = value;
    _timer ??= Timer(interval, flush);
  }

  void flush() {
    _timer?.cancel();
    _timer = null;
    final value = _pending;
    _pending = null;
    if (value != null) onFlush(value);
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _pending = null;
  }
}

/// Converts cumulative model text into speech chunks that sound fluent.
///
/// The first complete sentence is released immediately (fast first word).
/// After that, whole sentences are grouped into larger chunks (about
/// [targetChars]) so the voice engine reads them in one breath instead of
/// pausing and re-starting between every sentence. Code fences are never
/// spoken. Order is never changed and nothing is spoken twice.
class CheSpeechChunker {
  CheSpeechChunker({this.targetChars = 240});
  final int targetChars;

  String _seen = '';
  String _buffer = '';
  String _pending = '';
  bool _inFence = false;
  bool _firstSent = false;

  List<String> addCumulative(String value) {
    if (!value.startsWith(_seen)) {
      // The text was rewritten (e.g. sanitised). Never re-speak what was
      // already handled; only take text beyond the old length.
      _buffer += value.length > _seen.length ? value.substring(_seen.length) : '';
    } else {
      _buffer += value.substring(_seen.length);
    }
    _seen = value;
    return _drain(false);
  }

  List<String> flush() => _drain(true);

  // Removes fenced code from the buffer, remembering an unclosed fence.
  String _speakableFromBuffer(bool force) {
    final out = StringBuffer();
    var rest = _buffer;
    while (true) {
      final fence = rest.indexOf('```');
      if (fence < 0) {
        if (_inFence) {
          rest = '';
        }
        break;
      }
      if (!_inFence) out.write(rest.substring(0, fence));
      _inFence = !_inFence;
      rest = rest.substring(fence + 3);
    }
    if (!_inFence) {
      // Keep a possible partial fence ("``") for the next delta.
      final keep = rest.endsWith('``') ? 2 : rest.endsWith('`') ? 1 : 0;
      if (keep > 0 && !force) {
        out.write(rest.substring(0, rest.length - keep));
        _buffer = rest.substring(rest.length - keep);
        return out.toString();
      }
      out.write(rest);
    }
    _buffer = '';
    return out.toString();
  }

  List<String> _drain(bool force) {
    final out = <String>[];
    _pending += _speakableFromBuffer(force);
    final sentence = RegExp(r'(.+?[.!?](?:\s+|$))', dotAll: true);
    var grouped = '';
    while (true) {
      final match = sentence.firstMatch(_pending);
      if (match == null) break;
      final chunk = match.group(1)!.replaceAll(RegExp(r'\s+'), ' ').trim();
      _pending = _pending.substring(match.end);
      if (chunk.isEmpty) continue;
      if (!_firstSent) {
        out.add(chunk);
        _firstSent = true;
        continue;
      }
      grouped = grouped.isEmpty ? chunk : '$grouped $chunk';
      if (grouped.length >= targetChars) {
        out.add(grouped);
        grouped = '';
      }
    }
    // Sentences not yet long enough wait for more text (or the final flush).
    if (grouped.isNotEmpty) _pending = '$grouped ${_pending.trimLeft()}';
    if (force) {
      final tail = _pending.replaceAll(RegExp(r'\s+'), ' ').trim();
      if (tail.isNotEmpty) out.add(tail);
      _pending = '';
    }
    return out;
  }
}
