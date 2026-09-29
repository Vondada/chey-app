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
