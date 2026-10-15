// Voice routes for the Command Center. While the page is open it registers
// [CheCommandCenterVoice.handler]; Chat's send pipeline offers it the
// owner's words first (the same hook pattern CHE's browser uses), so every
// action on the page also works by voice: search, read the options as a
// numbered list, pick by number, open, run, favorite, switch tabs, build,
// run, edit or delete a workflow, and approve, retry, pause, resume or
// cancel a run. Parsing is deterministic and never calls a model.
//
// Requests to list or search commands are read as whole sentences, the way
// speech recognition writes them: "show me five YouTube commands and tell me
// which are ready" is one list request (a topic, a number and a readiness
// question), never a command called "five YouTube commands…". Listing,
// searching and explaining never run anything.

import '../che_wake_match.dart';

/// The page that is open right now answers here. Returns what CHE should
/// say, or null when the words are not for the Command Center.
class CheCommandCenterVoice {
  CheCommandCenterVoice._();
  static Future<String?> Function(String words)? handler;
}

enum CheCommandVoiceOp {
  describe,
  tab,
  search,
  pick,
  open,
  run,
  favorite,
  unfavorite,
  newWorkflow,
  buildWorkflow,
  addStep,
  removeStep,
  runWorkflow,
  deleteWorkflow,
  approve,
  retry,
  pause,
  resume,
  cancel,
  activity,
  back,
  repeat,
  yes,
  no,
}

class CheCommandVoice {
  const CheCommandVoice(this.op, {this.text = '', this.target = '', this.number, this.items = const [], this.list});
  final CheCommandVoiceOp op;

  /// A list or search request: its topic, number and readiness question.
  final CheCommandListRequest? list;

  /// The command words, search words or tab name.
  final String text;

  /// A workflow or run name, when one was said.
  final String target;

  /// "number 2", "step 3".
  final int? number;

  /// Commands named for a new workflow, in order.
  final List<String> items;

  static final _lead = RegExp(r'^(?:hey\s+)?(?:che|chay|chey)[,:]?\s+', caseSensitive: false);
  static final _polite = RegExp(r'^(?:please\s+|can you\s+|could you\s+|would you\s+|i want to\s+|i want you to\s+|let\x27s\s+)', caseSensitive: false);
  static const _numbers = {
    'one': 1, 'first': 1, 'two': 2, 'second': 2, 'to': 2, 'too': 2, 'three': 3, 'third': 3, 'four': 4, 'for': 4, 'fourth': 4,
    'five': 5, 'fifth': 5, 'six': 6, 'sixth': 6, 'seven': 7, 'seventh': 7, 'eight': 8, 'eighth': 8, 'nine': 9, 'ninth': 9,
    'ten': 10, 'tenth': 10, 'eleven': 11, 'twelve': 12,
  };

  static int? numberFrom(String? raw) {
    if (raw == null) return null;
    final t = raw.trim().toLowerCase();
    return int.tryParse(t) ?? _numbers[t];
  }

  static const _num = r'(\d+|one|first|two|second|to|too|three|third|four|for|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)';

  static CheCommandVoice? parse(String raw) {
    // Case is kept so a command's input ("NQ", "Joe's Barbershop") arrives
    // as said; every pattern ignores case.
    var t = raw.trim().replaceAll(RegExp(r'[.!?]+$'), '').replaceAll('’', "'");
    t = t.replaceFirst(_lead, '').replaceFirst(_polite, '').trim();
    if (t.isEmpty) return null;
    RegExpMatch? m;
    bool has(String pattern) => (m = RegExp(pattern, caseSensitive: false).firstMatch(t)) != null;
    String g(int i) => (m!.group(i) ?? '').trim();

    if (has(r'^(?:yes|yeah|yep|yes please|do it|go ahead|confirm|i confirm)$')) return const CheCommandVoice(CheCommandVoiceOp.yes);
    if (has(r'^(?:no|nope|no thanks|don\x27t|do not|never mind|cancel that|keep it|keep running)$')) return const CheCommandVoice(CheCommandVoiceOp.no);

    if (has(r'^(?:go\s+)?back(?:\s+to\s+(?:the\s+)?chat)?$|^(?:close|exit|leave)(?:\s+the)?\s+(?:commands?|command center)(?:\s+page)?$|^(?:go\s+to|open|show)\s+(?:the\s+)?chat$')) {
      return const CheCommandVoice(CheCommandVoiceOp.back);
    }
    if (has(r"^(?:read|say|repeat)(?:\s+(?:that|them|those|it|the list|the results?))?\s+again$|^repeat(?:\s+(?:that|it|the list))?$|^what did you (?:just )?say$")) {
      return const CheCommandVoice(CheCommandVoiceOp.repeat);
    }
    if (has(r"^what can i do(?:\s+(?:here|on this page))?$")) return const CheCommandVoice(CheCommandVoiceOp.describe);
    if (has(r"^(?:what'?s|what is)\s+on\s+(?:the\s+|this\s+)?(?:screen|page)$|^(?:read|describe)(?:\s+(?:this|the))?(?:\s+(?:page|screen))?(?:\s+aloud)?$|^where am i$|^(?:what are|read|list)(?:\s+me)?\s+(?:my\s+|the\s+)?(?:options|choices)$|^(?:open|show)\s+(?:the\s+)?commands?(?:\s+page)?$|^help$")) {
      return const CheCommandVoice(CheCommandVoiceOp.describe);
    }
    if (has(r'^(?:show|open|go\s+to|switch\s+to)?\s*(?:the\s+|my\s+)?(library|workflows?|activity|history|runs)(?:\s+tab)?$')) {
      final w = g(1).toLowerCase();
      return CheCommandVoice(CheCommandVoiceOp.tab, text: w.startsWith('workflow') ? 'workflows' : w == 'library' ? 'library' : 'activity');
    }
    if (has(r"^(?:read|what'?s|what is|how'?s|how is)?\s*(?:the\s+)?(?:activity|progress|status|run status)(?:\s+of\s+(.+))?$|^how\s+(?:is|are)\s+(?:it|my runs?|the runs?|the workflows?)\s+going$") &&
        !RegExp(r'\b(?:commands?|them|those|these|ones)\b', caseSensitive: false).hasMatch(g(1))) {
      return CheCommandVoice(CheCommandVoiceOp.activity, target: g(1));
    }

    // Choosing from the list CHE just read: "number two", "open 3", "2".
    if (has('^(?:open|pick|choose|select|read)?\\s*(?:number|option|result|the)?\\s*$_num(?:\\s+one)?\$')) {
      return CheCommandVoice(CheCommandVoiceOp.pick, number: numberFrom(g(1)));
    }

    // Workflows.
    if (has(r'^(?:build|create|make|start|set up)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:new\s+)?workflow(?:\s+(?:called|named)\s+(.+?))?(?:\s*(?::|\bwith\b|\busing\b|\bfrom\b|\bthat runs\b)\s+(.+))?$')) {
      final items = _items(g(2));
      return items.isEmpty
          ? CheCommandVoice(CheCommandVoiceOp.newWorkflow, target: g(1))
          : CheCommandVoice(CheCommandVoiceOp.buildWorkflow, target: g(1), items: items);
    }
    if (has(r'^(?:open|show)\s+(?:me\s+)?(?:the\s+)?(?:workflow\s+)?builder$|^(?:new|build)\s+(?:a\s+)?workflow$')) {
      return const CheCommandVoice(CheCommandVoiceOp.newWorkflow);
    }
    if (has(r'^add\s+(.+?)\s+to\s+(?:the\s+|my\s+)?(.+?)\s+workflow$')) {
      return CheCommandVoice(CheCommandVoiceOp.addStep, text: g(1), target: g(2));
    }
    if (has('^(?:remove|delete|take out)\\s+step\\s+$_num\\s+(?:from|of|in)\\s+(?:the\\s+|my\\s+)?(.+?)\\s+workflow\$')) {
      return CheCommandVoice(CheCommandVoiceOp.removeStep, number: numberFrom(g(1)), target: g(2));
    }
    if (has(r'^(?:delete|remove)\s+(?:the\s+|my\s+)?(?:saved\s+)?(?:workflow\s+(.+)|(.+?)\s+workflow)$')) {
      return CheCommandVoice(CheCommandVoiceOp.deleteWorkflow, target: g(1).isNotEmpty ? g(1) : g(2));
    }
    if (has(r'^(?:run|start|launch)\s+(?:the\s+|my\s+)?(?:saved\s+)?(?:workflow\s+(.+)|(.+?)\s+(?:workflow|template))$')) {
      return CheCommandVoice(CheCommandVoiceOp.runWorkflow, target: g(1).isNotEmpty ? g(1) : g(2));
    }

    // Workflow runs (Activity).
    if (has('^(approve|retry)(?:\\s+(?:step|number)\\s+$_num)?(?:\\s+(?:it|that|this))?(?:\\s+(?:of|in|for|on)\\s+(?:the\\s+|my\\s+)?(.+?))?\$')) {
      return CheCommandVoice(g(1).toLowerCase() == 'approve' ? CheCommandVoiceOp.approve : CheCommandVoiceOp.retry, number: numberFrom(m!.group(2)), target: g(3));
    }
    if (has(r'^(pause|resume|continue|unpause)(?:\s+(?:it|that|this))?(?:\s+(?:the\s+|my\s+)?(?:run|workflow|mission)?\s*(.*?))?(?:\s+run)?$')) {
      return CheCommandVoice(g(1).toLowerCase() == 'pause' ? CheCommandVoiceOp.pause : CheCommandVoiceOp.resume, target: g(2));
    }
    if (has(r'^(?:cancel|stop)\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:run|workflow run|mission)(?:\s+(?:of\s+)?(.+))?$|^(?:cancel|stop)\s+(?:the\s+|my\s+)?(.+?)\s+run$')) {
      return CheCommandVoice(CheCommandVoiceOp.cancel, target: g(1).isNotEmpty ? g(1) : g(2));
    }

    // Favorites.
    if (has(r'^(?:add|put|save)\s+(.+?)\s+(?:to|in|into)\s+(?:my\s+)?favou?rites$|^(?:favou?rite|star)\s+(.+)$')) {
      return CheCommandVoice(CheCommandVoiceOp.favorite, text: g(1).isNotEmpty ? g(1) : g(2));
    }
    if (has(r'^(?:remove|take|delete)\s+(.+?)\s+(?:from|out of)\s+(?:my\s+)?favou?rites$|^(?:unfavou?rite|unstar)\s+(.+)$')) {
      return CheCommandVoice(CheCommandVoiceOp.unfavorite, text: g(1).isNotEmpty ? g(1) : g(2));
    }

    // Lists and searches, said naturally: "show me five YouTube commands and
    // tell me which are ready", "search for YouTube", "which ones need
    // setup?", "more". A command is never run from these.
    final list = cheCommandListRequest(raw, onPage: true);
    if (list != null) return CheCommandVoice(CheCommandVoiceOp.search, text: list.topic, list: list);

    // One command: run it, or open its details.
    if (has(r'^(?:run|start|do|use|execute)\s+(?:the\s+)?(?:command\s+)?(.+?)(?:\s+command)?$')) {
      return CheCommandVoice(CheCommandVoiceOp.run, text: g(1));
    }
    // A named command opens; a name that is not a command (a topic such as
    // "YouTube") is listed by the page instead.
    if (has(r'^(?:open|show|explain|describe|details\s+(?:for|of|on))\s+(?:me\s+)?(?:the\s+)?(?:command\s+)?(.+?)(?:\s+command)?$|^what\s+does\s+(?:the\s+)?(?:command\s+)?(.+?)(?:\s+command)?\s+(?:do|need|require)$|^tell\s+me\s+(?:about|more about)\s+(?:the\s+)?(?:command\s+)?(.+?)(?:\s+command)?$')) {
      final words = [g(1), g(2), g(3)].firstWhere((w) => w.isNotEmpty, orElse: () => '');
      return CheCommandVoice(CheCommandVoiceOp.open, text: words);
    }
    return null;
  }

  /// "lead scout, lead audit, pricing and then lead proposal".
  static List<String> _items(String raw) => raw
      .split(RegExp(r'\s*(?:,|;|→|->|\bthen\b|\band then\b|\band\b|\bfollowed by\b)\s*'))
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toList();
}

/// Matches spoken words to a command id. Speech gives "trade chart",
/// "YouTube ideas" or "slash che plan"; the id is the longest leading run of
/// words that names a command. Returns the id and the words after it (the
/// command's input), or null when no command is named. Never fuzzy: a
/// command runs only when its name was actually said.
({String id, String rest})? cheMatchCommandWords(String words, Set<String> ids) {
  final tokens = words.trim().replaceFirst(RegExp(r'^(?:slash\s+|/)', caseSensitive: false), '').split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  String piece(String token) {
    final w = token.toLowerCase().replaceFirst(RegExp(r'^/'), '');
    return w == 'youtube' ? 'yt' : w == 'chey' || w == 'chay' ? 'che' : w;
  }
  for (var n = tokens.length; n >= 1; n--) {
    final id = tokens.take(n).map(piece).join('-').replaceAll(RegExp(r'-+'), '-').replaceAll(RegExp(r'-d\b'), 'd');
    if (ids.contains(id)) {
      // "yt ideas command for cooking": the input is "cooking".
      final rest = tokens.skip(n).join(' ').replaceFirst(RegExp(r'^command\b\s*', caseSensitive: false), '').replaceFirst(RegExp(r'^(?:for|on|with|about|to)\s+', caseSensitive: false), '');
      return (id: id, rest: rest);
    }
  }
  return null;
}


/// A request to list or search CHE's commands, read from natural speech.
/// Listing, searching or explaining never runs a command.
class CheCommandListRequest {
  const CheCommandListRequest({
    this.topic = '',
    this.count,
    this.all = false,
    this.readiness = false,
    this.only = '',
    this.followUp = false,
    this.more = false,
    this.runAsked = false,
    this.aboutIt = false,
  });

  /// What the commands are for ("youtube", "create and publish faceless
  /// youtube videos"). Empty means every command.
  final String topic;

  /// "five" → 5. Null when no number was said.
  final int? count;

  /// "all", "every", "the full list".
  final bool all;

  /// The owner asked which are ready or need setup.
  final bool readiness;

  /// 'ready' or 'setup' when only those were asked for, otherwise ''.
  final String only;

  /// About the list CHE just read: "which ones are ready?"
  final bool followUp;

  /// "more", "the next five".
  final bool more;

  /// Said as "run …" for several commands: they are listed, never run.
  final bool runAsked;

  /// A follow-up about the one command just picked: "is it ready?"
  final bool aboutIt;
}

const _amounts = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'fifteen': 15, 'twenty': 20, 'a couple of': 2, 'a couple': 2, 'couple of': 2, 'a few': 3,
  'few': 3, 'several': 5,
};
const _amount = r'(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|a couple of|a couple|couple of|a few|few|several)';
int? _amountOf(String? raw) => raw == null ? null : int.tryParse(raw) ?? _amounts[raw];

// "Ready" in the ways it is said. "Available for/to" means "exists for".
const _readyWords = r"(?:ready|usable|runnable|working(?: (?:right )?now)?|works? (?:right )?now|which (?:ones? |of them )?(?:work|run)|can (?:i |you |we )?(?:use|run)(?: (?:it|them|those|these))?(?: (?:right )?now)?(?! (?:to|for|in|on|with|when|if)\b)|available(?! (?:for|to|on|in)\b))";
// The narrower "ready" that asks for only the ready ones. "Available" and
// "can you run" ask what exists, so they get every command with its state.
const _onlyReadyWords = r"(?:ready|usable|runnable|working(?: (?:right )?now)?|works? (?:right )?now|which (?:ones? |of them )?(?:work|run)|can i (?:use|run)(?: (?:it|them|those|these))?(?: (?:right )?now)?(?! (?:to|for|in|on|with|when|if)\b))";
const _setupWords = r"(?:(?:need|needs|require|requires|needing) (?:(?:a|some|any|more|to be) )?(?:setup|set|connect\w*|config\w*|sign[\s-]?in|keys?|connection)|not ready|unready|unavailable|setup)";

/// The owner's words made comparable: lower case, CHE's name (in any
/// spelling) and polite openers removed, and common speech-recognition
/// variants ("you tube", "comands", "set up", "ready to use") made one form.
String cheCommandSpeech(String raw) {
  var t = raw.trim().replaceAll('’', "'").replaceAll(RegExp(r'\s*[—–…]\s*|\s+-\s+'), '. ');
  t = (cheWakeRemainder(t) ?? t).toLowerCase();
  t = t
      .replaceAll(RegExp(r'\b(?:you|u)[\s-]?tubes?\b'), 'youtube')
      .replaceAllMapped(RegExp(r"\bcomm?and('s|s'|s)?(?![a-z])"), (m) => m.group(1) == null ? 'command' : 'commands')
      .replaceAll(RegExp(r'\bslash\s+(?=commands?\b)'), '')
      .replaceAll(RegExp(r'\bset(?:ting)?[\s-]up\b'), 'setup')
      .replaceAll(RegExp(r'\bready (?:to (?:use|go|run)|for use)\b|\bgood to go\b'), 'ready')
      .replaceAll(RegExp(r"\b(?:aren't|are not|isn't|is not|not|don't|do not|doesn't|does not)\s+(?:yet\s+)?(?:ready|usable|working|work|available|runnable)\b"), 'unready')
      .replaceAll(RegExp(r"\bwhat's\b"), 'what is')
      .replaceAll(RegExp(r"\bthey're\b"), 'they are')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return _unlead(t);
}

final _leadIn = RegExp(r"^(?:(?:please|ok|okay|so|now|also|and|then|but|plus|just|alright|all right|um|uh|hey)\b[,\s]*|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need|would like|'d like)(?: you)? to\s+|let'?s\s+|go ahead and\s+)");

String _unlead(String text) {
  var t = text.trim();
  while (true) {
    final next = t.replaceFirst(_leadIn, '').trim();
    if (next == t) return t;
    t = next;
  }
}

final _command = RegExp(r'\bcommands?\b');
// "open your Commands page", "in my command library": the page itself, not a topic.
final _thePage = RegExp(r"\b(?:(?:open|show(?: me)?|bring up|pull up|go to|take me to|go into)\s+(?:up\s+)?|(?:on|in|from|inside)\s+)(?:your|the|my|che's|che)\s+(?:commands?\s+(?:page|screen|tab|list|library|section)|commands?(?=\s*(?:$|[.,;!?]|\band\b|\bthen\b))|command\s+(?:center|library|page|list))\b");
// Words that make it CHE's own commands, not any commands ("Linux commands").
final _cheOwn = RegExp(r"\b(?:your|che's|che)\s+(?:own\s+)?commands?\b|\bcommands?\s+(?:that\s+)?(?:you|che)\s+(?:can|could|have|has|know|offer|support|run)\b|\b(?:do|can|could|does)\s+(?:you|che)\s+(?:have|has|offer|run|support|know)\b.*\bcommands?\b|\bcommands?\b.*\b(?:do|can|could|does)\s+(?:you|che)\s+(?:have|has|offer|run|support|know)\b|\bcommand\s+(?:center|library)\b");
// Topics CHE's catalog covers; outside the page a number or a readiness
// question about these is a request for CHE's commands.
// Words like "website" or "videos" are left out: "3 git commands for my
// website repo" is not about CHE.
final _catalogWords = RegExp(r"\b(?:youtube|yt|faceless|trading|trades?|futures|nq|money|budget|cash ?flow|invoices?|expenses|clients?|marketing|seo|office)\b");
// Other systems' commands.
final _otherCommands = RegExp(r"\b(?:git|linux|unix|bash|zsh|shell|terminal|command line|cmd|powershell|dos|windows|mac ?os|npm|docker|kubectl|sql|excel|vim|siri|alexa|google assistant|python|dog|dogs)\b");
final _verbLead = RegExp(r'^(?:show|list|give|tell|read|find|search|look|get|pull up|bring up|display|name)\b');
final _runLead = RegExp(r'^(?:run|start|use|execute|do)\b');
final _more = RegExp('^(?:(?:show|read|give|tell|list)(?: me| us)? )?(?:(?:the )?next(?: $_amount)?|(?:$_amount )?more|the rest|the others)(?: (?:ones?|commands|of them|please))*\$');

/// Reads a request to list or search commands from the owner's words, or
/// returns null when the words ask for something else. On the Commands page
/// ([onPage]) a bare search ("search for YouTube") and follow-ups about the
/// list just read ("which ones are ready?", "more") count too. Elsewhere in
/// Chat the words must mean CHE's own commands.
CheCommandListRequest? cheCommandListRequest(String raw, {bool onPage = false}) {
  var t = cheCommandSpeech(raw);
  if (t.isEmpty) return null;
  // The web is Chat's web search, never the catalog.
  if (RegExp(r'^(?:search|find|look up|look)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:on|from) the (?:web|internet)\b|\bgoogle (?:it|for|search)\b').hasMatch(t)) return null;
  var explicit = _cheOwn.hasMatch(t);
  final pageNamed = _thePage.hasMatch(t);
  if (pageNamed) {
    explicit = true;
    t = t.replaceAll(_thePage, ' . ');
  }
  final askReady = RegExp('\\b$_readyWords\\b').hasMatch(t);
  final onlyReady = RegExp('\\b$_onlyReadyWords\\b').hasMatch(t);
  final askSetup = RegExp('\\b$_setupWords\\b').hasMatch(t);
  String onlyOf() => onlyReady == askSetup ? '' : onlyReady ? 'ready' : 'setup';
  final readiness = askReady || askSetup || RegExp(r'\b(?:status(?:es)?|states?)\b').hasMatch(t);
  final hasCommandWord = _command.hasMatch(t);

  // Follow-ups about the list CHE just read.
  if (onPage) {
    final more = _more.firstMatch(t.replaceFirst(RegExp(r'[.?!,;:]+$'), '').trim());
    if (more != null) return CheCommandListRequest(more: true, count: _amountOf(more.group(1) ?? more.group(2)));
  }
  if (onPage && !hasCommandWord) {
    t = t.replaceFirst(RegExp(r'[.?!,;:]+$'), '').trim();
    if (readiness &&
        (RegExp(r"\b(?:ones?|them|they|those|these|it|that list|the list)\b").hasMatch(t) ||
            RegExp(r'^(?:which|what|how many|are|is|tell me|show me|say|read|explain)\b').hasMatch(t))) {
      final it = RegExp(r"\b(?:it|that one|this one|that command|this command)\b").hasMatch(t) && !RegExp(r'\b(?:them|they|those|these|ones)\b').hasMatch(t);
      return CheCommandListRequest(followUp: true, readiness: true, only: onlyOf(), aboutIt: it);
    }
    // "And the money ones?", "which one should I use to publish a video?"
    final ones = RegExp(r"^(?:(?:what|how) about\s+)?(?:the\s+)?([a-z][a-z &'-]*?)\s+ones$").firstMatch(t);
    if (ones != null && !RegExp(r'^(?:that|this|these|those|other|next|first|last|same|new|old|which|what|good|best|right)$').hasMatch(ones.group(1)!)) {
      return CheCommandListRequest(topic: ones.group(1)!);
    }
    final which = RegExp(r'^(?:which|what) ones? (?:should|can|could|do|would|will) (?:i|we) use (?:to|for) (.+)$').firstMatch(t);
    if (which != null) return CheCommandListRequest(topic: which.group(1)!);
  }

  final clauses = [
    for (final c in t.split(RegExp(r'\s*[.?!;]+\s*|\s*\n+\s*')))
      if (_unlead(c).isNotEmpty) _unlead(c),
  ];
  String? main;
  var pre = '';
  var post = '';
  var singular = false;
  for (final c in clauses) {
    final m = _command.firstMatch(c);
    if (m == null) continue;
    main = c;
    pre = c.substring(0, m.start).trim();
    post = c.substring(m.end).trim();
    singular = m.group(0) == 'command';
    break;
  }
  if (main == null && (onPage || explicit)) {
    // "search for youtube", "look up trading": a search of the catalog.
    for (final c in clauses) {
      final s = RegExp(r'^(?:search|look)(?:\s+(?:for|up))?\s+(.+)$|^find(?:\s+me)?\s+(.+)$').firstMatch(c);
      if (s == null) continue;
      main = c;
      post = 'for ${s.group(1) ?? s.group(2)}';
      pre = 'search';
      break;
    }
  }
  if (main == null) {
    // "Open your commands page and tell me which are ready."
    return explicit && (askReady || askSetup) ? CheCommandListRequest(readiness: true, only: onlyOf()) : null;
  }

  // Before "commands": the verb, the number and the topic ("show me five youtube").
  int? count;
  var all = false;
  var readyAdjective = false;
  final verbLed = _verbLead.hasMatch(pre);
  final runAsked = _runLead.hasMatch(pre);
  final searchLed = RegExp(r'^(?:search|find|look)\b').hasMatch(pre);
  final question = RegExp(r"^(?:which|what(?!\s+(?:does|do|did|was)\b)|how many|are there|is there|do you have|do i have)\b").hasMatch(pre);
  final strip = RegExp(r"^(?:(?:and|also|then|now|so|just|please|ok|okay|but)\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like|'d like)(?: you)? to\s+|(?:show|list|give|tell|read|find|search(?:\s+for)?|look(?:\s+for|\s+up)?|get|pull up|bring up|display|name|pick|choose|suggest|recommend|open|see|share|run|start|use|execute|do)(?:\s+(?:me|us))?\s+|(?:what|how) about\s+|(?:what|which)(?:\s+(?:are|is|of))?\s+|how many\s+|(?:are there|is there|do you have|do i have|have you got|you have|i have)\s+|(?:full|complete|whole)\s+list\s+of\s+|(?:the|your|my|che's|che|some|any|a|an|of|top|first|best|main|good|useful|other|right)\s+)");
  var p = '$pre ';
  while (true) {
    final a = RegExp('^$_amount\\s+').firstMatch(p);
    if (a != null) {
      count ??= _amountOf(a.group(1));
      p = p.substring(a.end);
      continue;
    }
    final every = RegExp(r'^(?:all|every|each)(?:\s+(?:of\s+)?(?:the|your|my|che.s))?\s+').firstMatch(p);
    if (every != null) {
      all = true;
      p = p.substring(every.end);
      continue;
    }
    final ready = RegExp(r'^(?:ready|usable|working|runnable)\s+').firstMatch(p);
    if (ready != null) {
      readyAdjective = true;
      p = p.substring(ready.end);
      continue;
    }
    final next = p.replaceFirst(strip, '');
    if (next == p) break;
    p = next;
  }
  if (RegExp(r'\b(?:full|complete|whole) list\b').hasMatch(pre)) all = true;
  final preTopic = p.trim();

  // "What does the trade chart command do?" names one command: not a list.
  if (singular &&
      count == null &&
      !RegExp(r"(?:^|\s)(?:which|what(?!\s+(?:does|do|did|is|was)\b))(?:\s+[a-z&'-]+){0,2}$|\b(?:a|an|any|another|some|best|right|good|useful)$").hasMatch(pre)) {
    return null;
  }

  // "… commands that need setup", "… that are ready": a filter.
  final relative = RegExp("^(?:that|which)\\s+(?:are\\s+|is\\s+)?(?:($_onlyReadyWords)|($_setupWords))\\b").firstMatch(post);
  // After "commands": what they are for, up to the rest of a compound request
  // ("… and tell me which are ready").
  post = post
      .replaceFirst(RegExp(r"(?:^|,\s*|\s+)(?:and|then|also|plus|but)\s+(?:tell|show|explain|say|let|read|which|what|whether|how|are|is|mark|label|note|give|list)\b.*$"), '')
      .replaceFirst(RegExp(r"(?:^|,\s*|\s+)(?:show|tell|explain|let)\s+(?:me|us)\b.*$"), '')
      .replaceFirst(RegExp(r"(?:^|,\s*|\s+)which\s+(?:ones?|of\s+(?:them|those|these)|are|is|need|needs)\b.*$"), '')
      .replaceFirst(RegExp("(?:^|,\\s*|\\s+)(?:that|which)\\s+(?:are\\s+|is\\s+)?(?:$_readyWords|$_setupWords)\\b.*\$"), '')
      .replaceFirst(RegExp(r'[,\s]*\b(?:and|then|also|plus|but)$'), '')
      .trim();
  final purpose = RegExp(r"^(?:(?:that|which)\s+)?(?:(?:you|i|we|che)\s+)?(?:(?:can|could|would|will|should|might|do|does|did)\s+)?(?:(?:you|i|we|che)\s+)?(?:(?:use|run|try|have|has|know|offer|suggest|recommend|need)\s+)?(?:for|about|on|to|with|in|into|related to|regarding|around|(?:to\s+)?helps?(?:\s+me)?(?:\s+with)?)\s+(.+)$").firstMatch(post) ??
      // "which commands can price a site", "commands that write scripts".
      RegExp(r"^(?:(?:that|which)\s+)?(?:can|could|will|would|should|might|lets?\s+(?:me|you))\s+(?!(?:i|you|we|che|be)\b)(.+)$").firstMatch(post) ??
      RegExp(r"^(?:that|which)\s+(?!(?:are|is|was|were|need|needs|i|you|we|che|do|does|did|have|has)\b)(.+)$").firstMatch(post) ??
      RegExp(r"^(?:are|is)\s+(?:there\s+|available\s+|good\s+|useful\s+|best\s+|right\s+)?(?:for|about|on|to|with|in)\s+(.+)$").firstMatch(post);
  final postTopic = purpose?.group(1) ?? '';
  // Words after "commands" that are neither a purpose nor a readiness
  // question ("… commands work in Final Cut") make it some other question.
  final unexplained = post.isNotEmpty &&
      purpose == null &&
      !RegExp("\\b(?:$_readyWords|$_setupWords|status(?:es)?|do you have|can you run|are there|there are|exist|you have)\\b").hasMatch(post);

  String clean(String s) {
    var c = s.trim().replaceFirst(RegExp(r"^(?:the|a|an|my|your|che's|some|any)\s+"), '');
    for (var i = 0; i < 3; i++) {
      c = c.replaceFirst(RegExp(r"\s+(?:category|section|group|tab|right now|now|today|please|for me|again|on this page|here)$"), '');
    }
    return c.replaceFirst(RegExp(r'[,\s]+$'), '').trim();
  }

  final topic = [clean(preTopic), clean(postTopic)].where((s) => s.isNotEmpty).join(' ');

  // Outside the Commands page, "commands" alone may mean any commands
  // ("five Linux commands to list files"): only CHE's own are listed here,
  // and only when the words ask for a list ("why are your commands so
  // slow?" is a question for Chat).
  if (!onPage) {
    if (_otherCommands.hasMatch(t)) return null;
    final asks = verbLed || question || runAsked || count != null || all || RegExp(r'^(?:any|are there|is there)\b').hasMatch(pre);
    if (!pageNamed && (!asks || unexplained)) return null;
    if (!explicit) {
      // As before: "show me YouTube commands", "search commands for YouTube".
      final plain = verbLed && (post.isEmpty || (searchLed && preTopic.isEmpty && purpose != null));
      final strong = count != null || all || readiness || question || RegExp(r'^(?:any|are there|is there)\b').hasMatch(pre);
      if (!plain && !(strong && (topic.isEmpty || _catalogWords.hasMatch(topic)))) return null;
    }
  }

  var only = '';
  if (relative != null) {
    only = relative.group(1) != null ? (askSetup ? '' : 'ready') : (onlyReady ? '' : 'setup');
  } else if (onlyReady != askSetup && (question || readyAdjective || RegExp(r'\bonly\b').hasMatch(t))) {
    only = onlyOf();
  }
  if (readyAdjective && !askSetup) only = 'ready';
  return CheCommandListRequest(
    topic: topic,
    count: count,
    all: all,
    readiness: readiness || readyAdjective,
    only: only,
    runAsked: runAsked,
  );
}
