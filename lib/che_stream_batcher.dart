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

const _abbreviations = <String>{
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'mt', 'ft', 'no', 'approx', 'fig', 'gen', 'col',
  'capt', 'sgt', 'lt', 'rev', 'hon', 'dept', 'univ', 'ave', 'blvd', 'rd', 'est', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e', 'a.m', 'p.m',
  'u.s', 'u.k', 'etc', 'al',
};

final _blockLine = RegExp(r'^\s*(?:#{1,6}\s|[-*•+]\s|\d{1,3}[.)]\s|>|\|)');

/// The end (exclusive) of the first sentence in [text] at or after [from], or
/// -1 when no sentence is complete yet. A sentence ends at `.`, `!`, `?` or `…`
/// followed by a space or line break, never inside "Dr. Smith", "e.g. this",
/// "3.5" or a list number, and never at the very end of streaming text: more
/// may follow ("3." then "5 dollars"). A finished line of a list, heading or
/// table, or a line ending in punctuation, also ends a sentence. With [force]
/// the end of [text] counts as an end.
int cheSentenceEnd(String text, int from, {bool force = false}) {
  for (var i = from; i < text.length; i++) {
    final c = text[i];
    if (c == '\n') {
      final lineStart = i == 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1;
      final line = text.substring(lineStart < from ? from : lineStart, i).trim();
      if (line.isEmpty) continue;
      if (_blockLine.hasMatch(line) || RegExp(r'[.!?…:;]["”’)\]*_]*$').hasMatch(line) ||
          (i + 1 < text.length && (text[i + 1] == '\n' || _blockLine.hasMatch(text.substring(i + 1))))) {
        return i + 1;
      }
      continue;
    }
    if (c != '.' && c != '!' && c != '?' && c != '…') continue;
    var end = i + 1;
    while (end < text.length && '"”’)]*_'.contains(text[end])) {
      end++;
    }
    if (end >= text.length) {
      if (force) return text.length;
      return -1;
    }
    if (!RegExp(r'\s').hasMatch(text[end])) continue;
    if (c == '.' && !_endsSentence(text, from, i, end)) continue;
    return end;
  }
  return force && text.substring(from).trim().isNotEmpty ? text.length : -1;
}

bool _endsSentence(String text, int from, int dot, int after) {
  final lineStart = text.lastIndexOf('\n', dot) + 1;
  final before = text.substring(lineStart < from ? from : lineStart, dot);
  // "1." at the start of a line is a list number, not a sentence.
  if (RegExp(r'^\s*\d{1,3}$').hasMatch(before)) return false;
  final word = RegExp(r'([A-Za-z][A-Za-z.]*)$').firstMatch(before)?.group(1) ?? '';
  // "J. Smith": a single capital letter is an initial.
  if (RegExp(r'^[A-Z]$').hasMatch(word)) return false;
  if (_abbreviations.contains(word.toLowerCase())) {
    // "...and so on, etc. Then" ends a sentence; "etc. and" does not.
    final next = RegExp(r'\S').firstMatch(text.substring(after))?.group(0) ?? '';
    final ends = word.toLowerCase() == 'etc' && RegExp(r'[A-Z]').hasMatch(next);
    if (!ends) return false;
  }
  // A lowercase word after the stop continues the sentence ("e.g. this").
  final next = RegExp(r'\S').firstMatch(text.substring(after))?.group(0) ?? '';
  if (RegExp(r'[a-z]').hasMatch(next)) return false;
  return true;
}

/// Where to cut [text] so the first part fits in [limit] characters and ends
/// at a natural place: the end of a sentence when one is in the last 40%,
/// else a phrase break (comma, semicolon, colon, dash), else a space; never
/// in the middle of a word unless the word itself is longer than [limit].
int chePhraseCut(String text, int limit) {
  if (text.length <= limit) return text.length;
  final window = text.substring(0, limit + 1);
  var sentence = -1;
  for (var at = cheSentenceEnd(window, 0); at > 0 && at <= limit; at = cheSentenceEnd(window, at)) {
    sentence = at;
  }
  if (sentence >= limit * 0.60) return sentence;
  final phrase = RegExp(r'(?:[,;:]|\s[-–—])\s').allMatches(window).where((m) => m.end <= limit + 1).toList();
  if (phrase.isNotEmpty && phrase.last.end - 1 >= limit ~/ 2) return phrase.last.end - 1;
  final space = window.lastIndexOf(RegExp(r'\s'));
  if (space >= limit ~/ 2) return space;
  return limit;
}

/// Split a complete Read This/assistant reply into whole-word TTS requests.
/// CHE's preferred ElevenLabs route deliberately declines clips over 800 chars;
/// without splitting, a long Brain memory silently reverted to the old voice.
/// Keep a conservative 640-char maximum for fast, affordable synthesis.
/// The first clip is shorter ([firstMaxChars]), so the voice starts sooner
/// while the next clips are prepared during playback: Fish's time grows with
/// the clip's length. Cuts fall at sentence ends, else phrase breaks, so no
/// clip stops in the middle of a phrase (owner, 2026-10-18).
/// This is a pure helper, shared by every call to speakText, not a new router.
List<String> cheReadAloudChunks(String text, {int maxChars = 640, int firstMaxChars = 240}) {
  if (maxChars < 32) throw ArgumentError.value(maxChars, 'maxChars');
  if (firstMaxChars < 32) throw ArgumentError.value(firstMaxChars, 'firstMaxChars');
  var pending = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final chunks = <String>[];
  while (true) {
    final limit = chunks.isEmpty && firstMaxChars < maxChars ? firstMaxChars : maxChars;
    if (pending.length <= limit) break;
    final cut = chePhraseCut(pending, limit);
    final piece = pending.substring(0, cut).trimRight();
    if (piece.isEmpty) break;
    chunks.add(piece);
    pending = pending.substring(cut).trimLeft();
  }
  if (pending.isNotEmpty) chunks.add(pending);
  return chunks;
}

/// Converts cumulative model text into speech chunks that sound fluent.
///
/// The first complete sentence is released immediately (fast first word).
/// The next chunk groups about [secondTargetChars] of whole sentences, and
/// later ones about [targetChars], so the voice reads them in one breath with
/// few clip boundaries. A chunk ends only where a sentence or a list, heading
/// or table line ends, never at the end of text still streaming ("3." may be
/// "3.5"); none is longer than [maxChars] (ElevenLabs refuses clips over 800
/// characters, which used to hand that part to another voice). Line breaks are
/// kept so cheSpeakableText (che_spoken_text.dart) can give lists and headings their pauses. Code
/// fences are never spoken. Order is never changed and nothing is spoken twice.
class CheSpeechChunker {
  CheSpeechChunker({this.targetChars = 240, this.secondTargetChars = 160, this.maxChars = 640});
  final int targetChars;
  final int secondTargetChars;
  final int maxChars;

  String _seen = '';
  String _buffer = '';
  String _pending = '';
  bool _inFence = false;
  int _released = 0;

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

  static String _tidy(String text) => text
      .replaceAll(RegExp(r'[ \t]+'), ' ')
      .replaceAll(RegExp(r' ?\n[\s]*'), '\n')
      .trim();

  List<String> _drain(bool force) {
    final out = <String>[];
    _pending += _speakableFromBuffer(force);
    while (_pending.trim().isNotEmpty) {
      final target = _released == 0
          ? 1
          : _released == 1
              ? (secondTargetChars < targetChars ? secondTargetChars : targetChars)
              : targetChars;
      var end = 0;
      var full = false;
      while (end < target) {
        final next = cheSentenceEnd(_pending, end);
        if (next < 0) break;
        if (next > maxChars && end > 0) {
          full = true;
          break;
        }
        end = next;
      }
      if (end < target && !full) {
        if (force) {
          end = _pending.length;
        } else if (_pending.length > maxChars) {
          // One sentence longer than a clip: cut it at a phrase break.
          end = chePhraseCut(_pending, maxChars);
        } else {
          break;
        }
      }
      if (end > maxChars) end = chePhraseCut(_pending, maxChars);
      final piece = _tidy(_pending.substring(0, end));
      _pending = _pending.substring(end);
      if (piece.isNotEmpty) {
        out.add(piece);
        _released++;
      }
    }
    if (force) _pending = '';
    return out;
  }
}
