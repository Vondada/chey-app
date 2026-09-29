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

/// Converts cumulative model text into sentence/phrase-sized speech chunks.
/// It never reorders text and keeps a short tail until punctuation or flush.
class CheSpeechChunker {
  String _seen = '';
  String _buffer = '';

  List<String> addCumulative(String value) {
    if (!value.startsWith(_seen)) {
      _seen = value;
      _buffer = value;
    } else {
      _buffer += value.substring(_seen.length);
      _seen = value;
    }
    return _drain(false);
  }

  List<String> flush() => _drain(true);

  List<String> _drain(bool force) {
    final out = <String>[];
    while (true) {
      final match = RegExp(r'(.+?[.!?](?:\s+|$))', dotAll: true).firstMatch(_buffer);
      if (match == null) break;
      final chunk = match.group(1)!.trim();
      if (chunk.isNotEmpty) out.add(chunk);
      _buffer = _buffer.substring(match.end);
    }
    if (force && _buffer.trim().isNotEmpty) {
      out.add(_buffer.trim());
      _buffer = '';
    }
    return out;
  }
}
