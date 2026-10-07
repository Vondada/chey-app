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
  // Explicit authorization, including "Implement this, but do not deploy yet".
  if (_cheHasExplicitImplementationAuthorization(text) ||
      _cheImperativeImplementation(text)) {
    return true;
  }
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
    r"^(?:(?:chay|chey|shay|che)[,:]?\s*)?(?:(?:for|in)\s+(?:this|the)\s+(?:task|change|update)[,:]?\s*)?(?:(?:please|now)\s+|go\s+ahead\s+and\s+|i\s+(?:want|need)\s+you\s+to\s+|(?:can|could|would)\s+you\s+)?(?:implement|integrate|adapt|apply|install|add|upgrade|update|rewrite|refactor|build|change|modify|patch|fix|repair)\b[\s\S]{0,220}\b(?:your|che(?:'s)?|the)\s+(?:code|codebase|repo(?:sitory)?|app|flutter\s+app|ui|interface|worker|system|workflow|architecture)\b",
    caseSensitive: false,
  ).hasMatch(text);
}

/// "Implement this, but do not deploy yet" authorizes the change; the hold
/// only limits delivery. Mirrors imperativeImplementation in code_scout.js.
bool _cheImperativeImplementation(String text) {
  return RegExp(
    r"^(?:(?:che|chay|chey|shay)[,:]?\s*)?(?:(?:for|in)\s+(?:this|the)\s+(?:task|change|update)[,:]?\s*)?(?:(?:please|now)\s+|go\s+ahead\s+and\s+|i\s+(?:want|need)\s+you\s+to\s+|(?:can|could|would)\s+you\s+)?(?:implement|fix|build|add|update|apply)\s+(?:this|that|it)\b",
    caseSensitive: false,
  ).hasMatch(text.trim());
}

/// Whole-repository prohibitions are final for the turn. Mirrors
/// globalRepositoryProhibition in code_scout.js.
bool _cheHasGlobalRepositoryProhibition(String text) {
  bool m(String pattern) => RegExp(pattern, caseSensitive: false).hasMatch(text);
  // Scoped limits ("outside that screen", "anything else") are not prohibitions.
  return m(r"\b(?:do\s+not|don['’]t|never|make\s+no)\s+(?:make\s+)?(?:any\s+)?(?:modify|modifying|change|changes|changing|touch|edit|alter)\s+(?:to\s+)?(?:your\s+|any\s+|the\s+)?(?:source\s+)?(?:code|codebase|repo(?:sitory)?)\b(?!\s+(?:else\b|outside\b|elsewhere\b|beyond\b|except\b|apart\s+from\b|other\s+(?:files?|screens?|parts?|features?|code)\b|to\s+(?:anything\s+else|any\s+other|other)\b))") ||
      m(r"\b(?:do\s+not|don['’]t|never)\s+make\s+(?:any\s+)?(?:code\s+)?changes\b(?!\s+(?:else\b|outside\b|elsewhere\b|beyond\b|except\b|apart\s+from\b|other\s+(?:files?|screens?|parts?|features?|code)\b|to\s+(?:anything\s+else|any\s+other|other)\b))") ||
      m(r"\bwithout\s+(?:changing|modifying|touching|editing)\s+anything\b(?!\s+(?:else\b|outside\b|elsewhere\b|beyond\b|except\b|apart\s+from\b|other\s+(?:files?|screens?|parts?|features?|code)\b|to\s+(?:anything\s+else|any\s+other|other)\b))") ||
      (m(r"\b(?:do\s+not|don['’]t|never)\s+(?:modify|change|touch|edit|alter)\s+(?:it|anything)\b(?!\s+(?:else\b|outside\b|elsewhere\b|beyond\b|except\b|apart\s+from\b|other\s+(?:files?|screens?|parts?|features?|code)\b|to\s+(?:anything\s+else|any\s+other|other)\b))") && m(r"\b(?:code|codebase|repo(?:sitory)?|app)\b")) ||
      m(r"\b(?:do\s+not|don['’]t|never)\s+(?:create|build|make)\s+(?:anything|it|a\s+project|the\s+project)\b") ||
      m(r"\b(?:no|zero)\s+(?:repository|repo|code)\s+changes?\b");
}

bool _cheHasHardRepositoryActionProhibition(String text) {
  return RegExp(
    r"\b(?:do\s+not|don['’]t|never|without|make\s+no)\b[\s\S]{0,180}(?:(?:modify|alter|touch|edit|changes?)\b[\s\S]{0,60}\b(?:source\s+code|code|codebase|repo(?:sitory)?)\b|write(?:\s+any)?\s+code\b|start(?:\s+(?:a|the))?\s+(?:coding|self[- ]development)(?:\s+(?:job|request|process))?\b|create(?:\s+(?:a|the))?\s+(?:branch|commit)\b|open(?:\s+(?:a|the))?\s+(?:pr|pull\s+request)\b|(?:source\s+code|code|codebase|repo(?:sitory)?|repository)\s+changes?\b)|\b(?:no|zero)\s+(?:repository|repo|code)\s+changes?\b",
    caseSensitive: false,
  ).hasMatch(text);
}

// Quoted text is an example under discussion, never this turn's instruction.
String _cheWithoutQuotedText(String text) {
  final stripped = text
      .replaceAll(RegExp('["\u201c\u201d][^"\u201c\u201d]{0,400}["\u201c\u201d]'), ' "" ')
      .trim();
  return RegExp(r'[a-z]', caseSensitive: false)
          .hasMatch(stripped.replaceAll('""', ''))
      ? stripped
      : text;
}

/// True when answering from an offline/general model could fabricate live CHE
/// repository state. These turns require the connected Worker/GitHub evidence
/// path; if it is unavailable the client must report that limitation instead
/// of substituting an ungrounded local answer.
bool cheRequiresVerifiedRemoteEvidence(String raw) {
  final text = _cheWithoutQuotedText(raw.trim());
  if (text.isEmpty) return false;

  final repositoryTarget = RegExp(
    r"\b(?:(?:your|che(?:'s)?)\s+(?:current\s+)?(?:github\s+)?(?:main(?:\s+branch)?|repo(?:sitory)?|codebase|source(?:\s+code)?|code|architecture|routing|router|worker|coding\s+(?:job|pipeline|runtime))|"
    r"(?:current|exact|latest)\s+(?:github\s+)?main\s+(?:branch\s+)?sha|"
    r"github\s+main)\b",
    caseSensitive: false,
  ).hasMatch(text);
  if (!repositoryTarget) return false;

  return RegExp(
    r"\b(?:inspect|investigate|diagnos(?:e|is|tic)|trace|audit|review|verify|verified|find|locate|identify|exact|current|status|self[- ]diagnostic|what\s+happened|why\b[\s\S]{0,80}\bfailed)\b",
    caseSensitive: false,
  ).hasMatch(text);
}

bool cheIsTerminalChatOnlyRequest(String raw) {
  final text = _cheWithoutQuotedText(raw.trim());
  final responseDirective = RegExp(
    r'\b(?:answer|respond|reply)\b[\s\S]{0,80}\b(?:in\s+(?:this\s+)?chat|chat[- ]only|without\s+(?:changing|modifying|editing)\s+(?:your\s+)?code)\b|\bchat[- ]only\s+(?:test|exam|evaluation)\b|\b(?:this\s+is\s+)?(?:an?\s+)?evaluation\b[\s\S]{0,50}\bnot\s+(?:a\s+)?(?:coding|self[- ]development)\s+request\b',
    caseSensitive: false,
  ).hasMatch(text);
  if (_cheHasGlobalRepositoryProhibition(text)) return true;
  if (responseDirective && _cheHasHardRepositoryActionProhibition(text)) {
    return true;
  }
  if (RegExp(
    r'\b(?:this\s+is\s+)?(?:an?\s+)?(?:evaluation|exam|test\s+question)\b[\s\S]{0,50}\bnot\s+(?:a\s+)?(?:coding|self[- ]development)\s+request\b',
    caseSensitive: false,
  ).hasMatch(text)) {
    return true;
  }
  // A real implementation command can still say "do not deploy yet". That
  // delivery hold does not revoke the owner's authorization to implement.
  if (_cheHasExplicitImplementationAuthorization(text) ||
      _cheImperativeImplementation(text)) {
    return false;
  }
  if (RegExp(r'\b(?:in\s+this\s+chat\s+only|chat[- ]only)\b', caseSensitive: false).hasMatch(text) &&
      !RegExp(r'\bchat[- ]only\s+(?:feature|mode|screen|button|setting)\b', caseSensitive: false).hasMatch(text)) {
    return true;
  }
  final prohibition = RegExp(
    r"\b(?:do\s+not|don['’]t|never|make\s+no|without)\b[\s\S]{0,220}\b(?:modify|alter|touch|changes?|edit|write(?:\s+any)?\s+code|start|create|open|merge|deploy|coding|self[- ]development|branch|commit|pull\s+request|\bpr\b|repository\s+changes?)\b|\b(?:no|zero)\s+(?:repository|repo|code)\s+changes?\b",
    caseSensitive: false,
  ).hasMatch(text);
  return responseDirective && prohibition;
}
