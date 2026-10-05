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
  if (cheIsTerminalChatOnlyRequest(text)) return false;
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

  // Natural owner requests can name a CHE surface without saying "your app".
  // Require both a CHE surface and an implementation action so questions stay chat.
  final cheSurfaceChange = RegExp(
    r'\b(?:find\s+where|locate|inspect|change|update|fix|repair|improve|upgrade|redesign|modify|restyle|adjust)\b'
    r'[\s\S]{0,180}\b(?:office|chat|home|brain|war\s+room|theater|apps?|screen|ui|interface|agent\s+status|status\s+badge|button|layout)\b',
    caseSensitive: false,
  ).hasMatch(text);
  final implementationAction = RegExp(
    r'\b(?:change|update|fix|repair|improve|upgrade|redesign|modify|restyle|adjust|make|implement|edit)\b',
    caseSensitive: false,
  ).hasMatch(text);
  if (cheSurfaceChange && implementationAction) return true;

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

/// A current-turn instruction to answer in conversation while forbidding
/// repository work. Background job state must never change this decision.
bool _cheHasExplicitImplementationAuthorization(String text) {
  if (RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?update\s+your\s+code\s*:',
    caseSensitive: false,
  ).hasMatch(text)) {
    return true;
  }
  return RegExp(
    r"^(?:(?:chay|chey|shay|che)[,:]?\s*)?(?:(?:for|in)\s+(?:this|the)\s+(?:task|change|update)[,:]?\s*)?(?:(?:please|now)\s+|go\s+ahead\s+and\s+|i\s+(?:want|need)\s+you\s+to\s+|(?:can|could|would)\s+you\s+)?(?:implement|integrate|adapt|apply|install|add|upgrade|rewrite|refactor|build|change|modify|patch|fix|repair)\b[\s\S]{0,220}\b(?:your|che(?:'s)?|the)\s+(?:code|codebase|repo(?:sitory)?|app|flutter\s+app|ui|interface|worker|system|workflow|architecture)\b",
    caseSensitive: false,
  ).hasMatch(text);
}

bool _cheHasHardRepositoryActionProhibition(String text) {
  return RegExp(
    r"\b(?:do\s+not|don['’]t|never|without|make\s+no)\b[\s\S]{0,180}(?:(?:modify|alter|touch|edit|changes?)\b[\s\S]{0,60}\b(?:source\s+code|code|codebase|repo(?:sitory)?)\b|write(?:\s+any)?\s+code\b|start(?:\s+(?:a|the))?\s+(?:coding|self[- ]development)(?:\s+(?:job|request|process))?\b|create(?:\s+(?:a|the))?\s+(?:branch|commit)\b|open(?:\s+(?:a|the))?\s+(?:pr|pull\s+request)\b|repository\s+changes?\b)|\b(?:no|zero)\s+(?:repository|repo|code)\s+changes?\b",
    caseSensitive: false,
  ).hasMatch(text);
}

bool cheIsTerminalChatOnlyRequest(String raw) {
  final text = raw.trim();
  final responseDirective = RegExp(
    r'\b(?:answer|respond|reply)\b[\s\S]{0,80}\b(?:in\s+(?:this\s+)?chat|chat[- ]only|without\s+(?:changing|modifying|editing)\s+(?:your\s+)?code)\b|\bchat[- ]only\s+(?:test|exam|evaluation)\b|\b(?:this\s+is\s+)?(?:an?\s+)?evaluation\b[\s\S]{0,50}\bnot\s+(?:a\s+)?(?:coding|self[- ]development)\s+request\b',
    caseSensitive: false,
  ).hasMatch(text);
  if (responseDirective && _cheHasHardRepositoryActionProhibition(text)) {
    return true;
  }
  // A real implementation command can still say "do not deploy yet". That
  // delivery hold does not revoke the owner's authorization to implement.
  if (_cheHasExplicitImplementationAuthorization(text)) return false;
  final prohibition = RegExp(
    r"\b(?:do\s+not|don['’]t|never|make\s+no|without)\b[\s\S]{0,220}\b(?:modify|alter|touch|changes?|edit|write(?:\s+any)?\s+code|start|create|open|merge|deploy|coding|self[- ]development|branch|commit|pull\s+request|\bpr\b|repository\s+changes?)\b|\b(?:no|zero)\s+(?:repository|repo|code)\s+changes?\b",
    caseSensitive: false,
  ).hasMatch(text);
  return responseDirective && prohibition;
}
