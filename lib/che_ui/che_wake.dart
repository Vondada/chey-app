// CHE's wake word for Office voice commands. Thin, stable API over the shared
// matcher in che_wake_match.dart ("Chay" is the spoken name; "CHE" is how she
// is written everywhere).

import '../che_wake_match.dart';

/// True when [raw] starts with CHE's wake name ("Chay", "CHE", "Hey Chay"...).
bool matchWake(String raw) => cheIsWake(raw);

/// The command spoken after the wake name, e.g. "Hey Chay, what is Knox
/// doing?" → "what is Knox doing?". Null when there was no wake name; empty
/// when only the name was said.
String? commandAfterWake(String raw) => cheWakeRemainder(raw);

/// The six Office phrases CHE answers from the live board (the Worker's
/// office_phrases.js is the source of truth; this mirrors it so the app can
/// tell an Office command from ordinary chat after the wake word).
enum CheOfficePhrase { happening, builtToday, earnedToday, readOffice, agentStatus, standDown }

const cheOfficeRoster = ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra'];

/// Matches an Office phrase, with or without the wake name in front.
({CheOfficePhrase type, String? agentId})? matchOfficePhrase(String raw) {
  final spoken = commandAfterWake(raw) ?? raw;
  final t = spoken
      .toLowerCase()
      .replaceAll(RegExp(r'[’‘]'), "'")
      .replaceAll(RegExp(r"[^a-z0-9 ?']"), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (t.isEmpty) return null;
  if (RegExp(r"\bwhat(?:'s|s| is)? (?:happening|going on) in the office\b").hasMatch(t)) {
    return (type: CheOfficePhrase.happening, agentId: null);
  }
  if (RegExp(r'\bwhat did (?:they|the office|the team|we) (?:build|ship|finish) today\b').hasMatch(t)) {
    return (type: CheOfficePhrase.builtToday, agentId: null);
  }
  if (RegExp(r'\bhow much (?:did we|have we) (?:make|made|earn|earned) today\b').hasMatch(t)) {
    return (type: CheOfficePhrase.earnedToday, agentId: null);
  }
  if (RegExp(r'\bread (?:this |the )?office(?: board)?(?: to me)?\b').hasMatch(t)) {
    return (type: CheOfficePhrase.readOffice, agentId: null);
  }
  final who = RegExp(r"\bwhat(?:'s|s| is) ([a-z]+) (?:doing|working on)\b").firstMatch(t);
  if (who != null && cheOfficeRoster.contains(who.group(1))) {
    return (type: CheOfficePhrase.agentStatus, agentId: who.group(1));
  }
  if (RegExp(r'^(?:office )?stand down\b|\boffice,? stand down\b').hasMatch(t)) {
    return (type: CheOfficePhrase.standDown, agentId: null);
  }
  return null;
}
