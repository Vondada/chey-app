/// Converts cumulative model text into sentence-sized speech chunks.
/// Never reorders text; keeps a short unread tail until punctuation or flush.
/// Used so CHE can start speaking the first sentence without waiting for the
/// full reply (time-to-first-spoken).
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
