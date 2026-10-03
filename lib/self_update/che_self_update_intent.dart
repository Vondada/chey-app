/// Repository-library discovery must happen before CHE tries to patch herself.
/// These requests belong to the GitHub research/scout lane, even when the owner
/// eventually wants the useful parts integrated into CHE.
bool cheIsRepositoryResearchRequest(String raw) {
  final text = raw.trim();

  // Explicit implementation requests that use Inspirations/starred repos as
  // references belong to the coding lane, not the research-only lane.
  final explicitCodeUpdate = RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?update\s+your\s+code\s*:',
    caseSensitive: false,
  ).hasMatch(text);
  final implementation = RegExp(
    r'\b(?:implement|integrate|adapt|apply|install|add|upgrade|improve|rewrite|refactor|build|change|modify|patch)\b',
    caseSensitive: false,
  ).hasMatch(text);
  final target = RegExp(
    r"\b(?:your|che(?:'s)?)\s+(?:code|codebase|repo(?:sitory)?|app|office|agents?|system|workflow|architecture)\b|"
    r'\b(?:into|inside|to)\s+che\b',
    caseSensitive: false,
  ).hasMatch(text);
  final receipts = RegExp(
    r'\b(?:draft\s+pr|pull\s+request|commit\s+sha|files\s+changed|run\s+tests?|implement\s+now|do\s+the\s+implementation)\b',
    caseSensitive: false,
  ).hasMatch(text);
  if (explicitCodeUpdate || (implementation && (target || receipts))) return false;

  final collection = RegExp(
    r'\b(?:starred(?:\s+github)?\s+(?:repos?|repositories)|'
    r'github\s+starred\s+(?:repos?|repositories)|'
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
/// "show me the code", "create the PR", "merge it", "PR status": actions on
/// an already-reviewed change, handled by chat, never a new coding job.
bool cheIsSelfUpdateCommand(String raw) {
  final text = raw.trim();
  return RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?(?:please\s+)?(?:'
    r'(?:show|read|let me see|display)\b.{0,25}\b(?:code|diff|changes?)|'
    r'(?:create|open|make|draft|send|push)\s+(?:the\s+|a\s+|that\s+)?(?:pr|pull request)|'
    r'(?:merge|ship)(?:\s+(?:it|that|this|the\s+(?:pr|pull request|update|change)))?(?:\s+(?:and|then)\s+deploy(?:\s+it)?)?|'
    r'(?:what(?:.s| is)\s+the\s+)?(?:pr|pull request)\s+(?:status|state|checks?)|'
    r'is\s+it\s+deployed'
    r')(?:\s+please)?[.!?]?\s*$',
    caseSensitive: false,
  ).hasMatch(text);
}

bool cheIsSelfUpdateRequest(String raw) {
  final text = raw.trim();
  if (cheIsRepositoryResearchRequest(text)) return false;
  // Commands about an existing change are not new coding requests.
  if (cheIsSelfUpdateCommand(text)) return false;
  final direct = RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?'
    r'(?:(?:add|change|update|remove|fix|repair|improve|upgrade|build|redesign|modify|move|restyle)\s+.+\s+'
    r'(?:to|in|on|inside)\s+(?:your|che|c\.?h\.?e\.?)\s+(?:code|codebase|repo(?:sitory)?|app|ui|interface|screen|layout)?\b|'
    r'(?:update|improve|fix|repair|upgrade|build|redesign|change|modify|work on)\s+(?:yourself|your own code|your app|your code|your codebase|your repo(?:sitory)?|your ui|your interface|your screen|your layout)\b|'
    r'(?:proofread|review|edit|refactor)\s+(?:your\s+)?code\b|'
    r'(?:change|move|redesign|restyle)\s+(?:this|the|your)\s+(?:screen|button|control|layout|ui|interface)\b)',
    caseSensitive: false,
  ).hasMatch(text);
  if (direct) return true;

  // Long owner briefs often start with process instructions ("do not stop at
  // planning", "execute the change") before they mention CHE's code. Route
  // those to the controlled self-update lane instead of generic chat.
  final implementationVerb = RegExp(
    r'\b(?:implement|integrate|adapt|apply|install|code|rewrite|patch|refactor|modify|fix|repair|build|add|change|update|upgrade|improve|work on|execute the change)\b',
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
