// Voice routes for the Command Center. While the page is open it registers
// [CheCommandCenterVoice.handler]; Chat's send pipeline offers it the
// owner's words first (the same hook pattern CHE's browser uses), so every
// action on the page also works by voice: search, read the options as a
// numbered list, pick by number, open, run, favorite, switch tabs, build,
// run, edit or delete a workflow, and approve, retry, pause, resume or
// cancel a run. Parsing is deterministic and never calls a model.

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
  yes,
  no,
}

class CheCommandVoice {
  const CheCommandVoice(this.op, {this.text = '', this.target = '', this.number, this.items = const []});
  final CheCommandVoiceOp op;

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
    if (has(r"^(?:what'?s|what is)\s+on\s+(?:the\s+|this\s+)?(?:screen|page)$|^(?:read|describe)(?:\s+(?:this|the))?(?:\s+(?:page|screen))?(?:\s+aloud)?$|^where am i$|^(?:what are|read|list)(?:\s+me)?\s+(?:my\s+|the\s+)?(?:options|choices)$|^(?:open|show)\s+(?:the\s+)?commands?(?:\s+page)?$|^help$")) {
      return const CheCommandVoice(CheCommandVoiceOp.describe);
    }
    if (has(r'^(?:show|open|go\s+to|switch\s+to)?\s*(?:the\s+|my\s+)?(library|workflows?|activity|history|runs)(?:\s+tab)?$')) {
      final w = g(1).toLowerCase();
      return CheCommandVoice(CheCommandVoiceOp.tab, text: w.startsWith('workflow') ? 'workflows' : w == 'library' ? 'library' : 'activity');
    }
    if (has(r"^(?:read|what'?s|what is|how'?s|how is)?\s*(?:the\s+)?(?:activity|progress|status|run status)(?:\s+of\s+(.+))?$|^how\s+(?:is|are)\s+(?:it|my runs?|the runs?|the workflows?)\s+going$")) {
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

    // Search: "search for website clients", "find a command to price a site".
    if (has(r'^(?:search|look)(?:\s+(?:for|up))?\s+(.+)$|^find(?:\s+me)?(?:\s+(?:a|the))?(?:\s+commands?(?:\s+(?:for|to|that))?)?\s+(.+)$|^which\s+commands?\s+(?:can\s+|will\s+|should i use to\s+|to\s+|for\s+)?(.+)$')) {
      final words = [g(1), g(2), g(3)].firstWhere((w) => w.isNotEmpty, orElse: () => '');
      return words.isEmpty ? null : CheCommandVoice(CheCommandVoiceOp.search, text: words);
    }

    // One command: run it, or open its details.
    if (has(r'^(?:run|start|do|use|execute)\s+(?:the\s+)?(?:command\s+)?(.+)$')) {
      return CheCommandVoice(CheCommandVoiceOp.run, text: g(1));
    }
    if (has(r'^(?:open|show|explain|describe|details\s+(?:for|of|on))\s+(?:me\s+)?(?:the\s+)?(?:command\s+)?(.+)$|^what\s+does\s+(?:the\s+)?(?:command\s+)?(.+?)\s+do$|^tell\s+me\s+about\s+(?:the\s+)?(?:command\s+)?(.+)$')) {
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
      final rest = tokens.skip(n).join(' ').replaceFirst(RegExp(r'^(?:for|on|with|about|to)\s+', caseSensitive: false), '');
      return (id: id, rest: rest);
    }
  }
  return null;
}
