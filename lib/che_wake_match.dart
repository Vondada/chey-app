// Shared "Chay" wake-name matching for every listening path.
//
// Speech recognition spells the spoken name many ways ("Chay", "Shay",
// "Jay", "Che", "Chey"…), and people rarely say it alone ("Hey Chay, you
// there?"). This accepts the name at the start of an utterance, after up to
// two filler words, and returns whatever was said after it.

final RegExp _cheWakePattern = RegExp(
  r'^(?:(?:hey|hi|yo|ok|okay|oh|um|uh|so|ay|aye)[\s,.!]+){0,2}'
  r'(?:chay|chey|chae|chai|shay|shae|shea|shey|jay|jae|che|ché|cheh|chee|chi|c\.?\s*h\.?\s*e\.?)'
  r"(?![a-z'])[\s,.:;!?-]*",
  caseSensitive: false,
);

/// Returns the words spoken after CHE's wake name ("" when only the name was
/// said), or null when the utterance does not start with the wake name.
String? cheWakeRemainder(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return null;
  // "She" is too common in normal speech; it only counts said on its own.
  if (RegExp(r'^(?:hey\s+)?she[\s,.!?]*$', caseSensitive: false).hasMatch(text)) return '';
  final match = _cheWakePattern.firstMatch(text);
  if (match == null) return null;
  return text.substring(match.end).trim();
}

/// True when the utterance starts with CHE's wake name.
bool cheIsWake(String raw) => cheWakeRemainder(raw) != null;

/// True when a finished speech segment ends mid-thought — a filler or a
/// joining word such as "um", "and", "so" or "because". CHE then keeps
/// listening instead of sending, so a breath or a pause to think never cuts
/// the owner off.
bool cheSoundsUnfinished(String words) {
  final cleaned = words.toLowerCase().replaceAll(RegExp(r"[^a-z' ]"), ' ').trim();
  if (cleaned.isEmpty) return false;
  final last = cleaned.split(RegExp(r'\s+')).last;
  const trailing = {
    'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'like', 'and', 'so', 'but',
    'or', 'because', 'cause', 'the', 'a', 'an', 'to', 'with', 'for', 'of',
    'then', 'that', 'if', 'when', 'my', 'your', 'maybe',
  };
  return trailing.contains(last);
}

/// How long a finished-sounding sentence may be followed by silence before
/// CHE treats the turn as over (the recognizer's own pause window is longer).
const Duration cheQuickEndOfTurn = Duration(milliseconds: 1500);

/// True when [words] sounds like a whole request: at least two words and no
/// trailing filler or connector ("um", "and", "the"...).
bool cheSoundsComplete(String words) {
  final cleaned = words.toLowerCase().replaceAll(RegExp(r"[^a-z0-9' ]"), ' ').trim();
  if (cleaned.isEmpty || cleaned.split(RegExp(r'\s+')).length < 2) return false;
  return !cheSoundsUnfinished(words);
}
