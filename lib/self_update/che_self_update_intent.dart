/// Repository-library discovery must happen before CHE tries to patch herself.
/// These requests belong to the GitHub research/scout lane, even when the owner
/// eventually wants the useful parts integrated into CHE.
bool cheIsRepositoryResearchRequest(String raw) {
  final text = raw.trim();
  final collection = RegExp(
    r'\b(?:starred(?:\s+github)?\s+(?:repos?|repositories)|'
    r'github\s+stars?|'
    r'(?:repos?|repositories)\s+(?:i\s+)?(?:have\s+)?starred|'
    r'inspirations?(?:\s+(?:list|tab|collection))?)\b',
    caseSensitive: false,
  ).hasMatch(text);
  if (!collection) return false;

  return RegExp(
    r'\b(?:inspect|scan|review|research|analy[sz]e|go\s+through|'
    r'look\s+through|check|find|study|use|integrate|adapt|take\s+code)\b',
    caseSensitive: false,
  ).hasMatch(text);
}

/// Pure classifier for owner requests that change CHE itself.
/// Kept outside UI code so routing is testable and never falls through to
/// generic model advice about creating GitHub tokens.
bool cheIsSelfUpdateRequest(String raw) {
  final text = raw.trim();
  if (cheIsRepositoryResearchRequest(text)) return false;
  final direct = RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?'
    r'(?:(?:add|change|update|remove|fix|improve|build|redesign|modify|move|restyle)\s+.+\s+'
    r'(?:to|in|on)\s+(?:your|che|c\.?h\.?e\.?)\s+(?:code|app|ui|interface|screen|layout)\b|'
    r'(?:update|improve|fix|build|redesign|change|modify)\s+(?:yourself|your app|your code|your ui|your interface|your screen|your layout)\b|'
    r'(?:proofread|review|edit|refactor)\s+(?:your\s+)?code\b|'
    r'(?:change|move|redesign|restyle)\s+(?:this|the|your)\s+(?:screen|button|control|layout|ui|interface)\b)',
    caseSensitive: false,
  ).hasMatch(text);
  if (direct) return true;

  // Long owner briefs often start with process instructions ("do not stop at
  // planning", "execute the change") before they mention CHE's code. Route
  // those to the controlled self-update lane instead of generic chat.
  final implementationVerb = RegExp(
    r'\b(?:implement|code|rewrite|patch|refactor|modify|fix|repair|build|add|change|update|execute the change)\b',
    caseSensitive: false,
  ).hasMatch(text);
  final selfTarget = RegExp(
    r"\b(?:your|che(?:'s)?|the)\s+(?:code|codebase|repo(?:sitory)?|flutter app|app|ui|interface|screen|chat ui)\b|"
    r'\b(?:actual|real|current)\s+(?:codebase|repo(?:sitory)?|source)\b',
    caseSensitive: false,
  ).hasMatch(text);
  final engineeringReceipts = RegExp(
    r'\b(?:branch|pull request|\bpr\b|commit sha|files changed|run checks|ci status|integration tests)\b',
    caseSensitive: false,
  ).hasMatch(text);

  return implementationVerb && (selfTarget || engineeringReceipts);
}
