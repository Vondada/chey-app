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

/// The Office phrases CHE answers from the live board (the Worker's
/// office_phrases.js is the source of truth; this mirrors it so the app can
/// tell an Office command from ordinary chat after the wake word).
enum CheOfficePhrase {
  happening,
  builtToday,
  earnedToday,
  stalled,
  readOffice,
  agentStatus,
  standDown,
  hireIris,
  fiverrScout,
  robloxJob,
  goal,
}

const cheOfficeRoster = ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];

/// Matches an Office phrase, with or without the wake name in front.
({CheOfficePhrase type, String? agentId, String? detail})? matchOfficePhrase(String raw) {
  final spoken = commandAfterWake(raw) ?? raw;
  final originalSpoken = spoken.trim();
  final t = spoken
      .toLowerCase()
      .replaceAll(RegExp(r'[’‘]'), "'")
      .replaceAll(RegExp(r"[^a-z0-9 ?']"), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (t.isEmpty) return null;
  if (RegExp(r"\bwhat(?:'s|s| is)? (?:happening|going on) in the office\b").hasMatch(t)) {
    return (type: CheOfficePhrase.happening, agentId: null, detail: null);
  }
  if (RegExp(r'\bwhat did (?:they|the office|the team|we) (?:build|ship|finish) today\b').hasMatch(t)) {
    return (type: CheOfficePhrase.builtToday, agentId: null, detail: null);
  }
  if (RegExp(r'\bhow much (?:did we|have we) (?:make|made|earn|earned) today\b').hasMatch(t)) {
    return (type: CheOfficePhrase.earnedToday, agentId: null, detail: null);
  }
  if (RegExp(r"\b(?:what(?:'s|s| is)\s+stalled|any\s+stalled|what(?:'s|s| is)\s+stuck)\b").hasMatch(t)) {
    return (type: CheOfficePhrase.stalled, agentId: null, detail: null);
  }
  if (RegExp(r'\bread (?:this |the )?office(?: board)?(?: to me)?\b').hasMatch(t)) {
    return (type: CheOfficePhrase.readOffice, agentId: null, detail: null);
  }
  final who = RegExp(r"\bwhat(?:'s|s| is) ([a-z]+) (?:doing|working on)\b").firstMatch(t);
  if (who != null && cheOfficeRoster.contains(who.group(1))) {
    return (type: CheOfficePhrase.agentStatus, agentId: who.group(1), detail: null);
  }
  if (RegExp(r'^(?:office )?stand down\b|\boffice,? stand down\b').hasMatch(t)) {
    return (type: CheOfficePhrase.standDown, agentId: null, detail: null);
  }

  // Roblox / Luau catalog (games, weapon, clothing/UGC, passes) — owner confirm before publish/spend.
  final looksRoblox = RegExp(r'\broblox\b|\bluau\b|\bugc\b|\bgame\s*pass(?:es)?\b|\brobucks?\b').hasMatch(t) ||
      (RegExp(r'\b(?:weapon|sword|gun|clothing|shirt|pants|hoodie|avatar|skin|accessory)\b').hasMatch(t) &&
          RegExp(r'\b(?:roblox|luau|ugc|game)\b').hasMatch(t));
  if (RegExp(r'\bhire\b').hasMatch(t) && looksRoblox) {
    final from = RegExp(r'\bhire\b[\s\S]{0,80}?\b(?:for|to|as)\s+(.+)$', caseSensitive: false).firstMatch(originalSpoken);
    final task = (from?.group(1) ?? originalSpoken).replaceAll(RegExp(r'[.!?]+$'), '').trim();
    return (type: CheOfficePhrase.robloxJob, agentId: null, detail: task.isEmpty ? null : task);
  }
  if (RegExp(r'\b(?:build|make|create|design|code|develop)\b').hasMatch(t) && looksRoblox) {
    final from = RegExp(r'\b(?:build|make|create|design|code|develop)\s+(.+)$', caseSensitive: false).firstMatch(originalSpoken);
    final task = (from?.group(1) ?? originalSpoken).replaceAll(RegExp(r'[.!?]+$'), '').trim();
    return (type: CheOfficePhrase.robloxJob, agentId: null, detail: task.isEmpty ? null : task);
  }

  if (RegExp(r'\bhire\s+iris\b').hasMatch(t) ||
      RegExp(r'\b(?:add|staff)\s+iris\b').hasMatch(t) ||
      RegExp(r'\biris\b.*\b(?:ad studio|join(?:s|ed)? the office)\b').hasMatch(t)) {
    final fromOriginal =
        RegExp(r'\bhire\s+iris\s+(?:for|to|as)\s+(.+)$', caseSensitive: false).firstMatch(originalSpoken);
    final task = (fromOriginal?.group(1) ?? '').replaceAll(RegExp(r'[.!?]+$'), '').trim();
    return (type: CheOfficePhrase.hireIris, agentId: 'iris', detail: task.isEmpty ? null : task);
  }

  if (RegExp(r'\bscout\s+fiverr\b').hasMatch(t) || RegExp(r'\bfiverr\s+scout\b').hasMatch(t)) {
    final fromOriginal =
        RegExp(r'\bscout\s+fiverr\s+for\s+(.+)$', caseSensitive: false).firstMatch(originalSpoken) ??
            RegExp(r'\bfiverr\s+scout\s+for\s+(.+)$', caseSensitive: false).firstMatch(originalSpoken);
    var query = (fromOriginal?.group(1) ?? 'AI ad buyers').replaceAll(RegExp(r'[.!?]+$'), '').trim();
    if (query.isEmpty) query = 'AI ad buyers';
    return (type: CheOfficePhrase.fiverrScout, agentId: null, detail: query);
  }

  final pack = RegExp(
    r'^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:draft|make|prepare|build)\s+(?:a |the )?tonight pack\b([\s\S]{0,400})$',
    caseSensitive: false,
  ).firstMatch(originalSpoken);
  if (pack != null) {
    final rest = (pack.group(1) ?? '').replaceAll(RegExp(r'[.!?]+$'), '').trim();
    final goal = ('Draft a tonight pack${rest.isEmpty ? '' : ' $rest'}').trim();
    return (type: CheOfficePhrase.goal, agentId: null, detail: goal);
  }

  final goal = RegExp(
    r'^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:tell|have|put|get) the office (?:to |on |working on )?(.{6,})$',
    caseSensitive: false,
  ).firstMatch(originalSpoken);
  if (goal != null) {
    final g = goal.group(1)!.replaceAll(RegExp(r'[.!?]+$'), '').trim();
    return (type: CheOfficePhrase.goal, agentId: null, detail: g);
  }
  return null;
}
