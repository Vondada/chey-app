// Voice routes for the REA investigation pages, the same hook pattern as
// [CheCommandCenterVoice]: while a page is open it registers here, and the
// Command Center offers the owner's words to the page in front first. Every
// button on those pages has a spoken route. Parsing is deterministic and
// never calls a model. A slash command ("/rea-build rea-…") is never taken
// here: it is the page's own action on its way to Chat.

import '../che_wake_match.dart';
import 'che_command_voice.dart';

class CheReaVoice {
  CheReaVoice._();
  static final _pages = <Future<String?> Function(String words)>[];

  /// The REA page in front of the owner, or null when none is open.
  static Future<String?> Function(String words)? get handler => _pages.lastOrNull;

  static void register(Future<String?> Function(String words) page) => _pages.add(page);
  static void unregister(Future<String?> Function(String words) page) => _pages.remove(page);
}

enum CheReaVoiceOp { describe, back, pick, refresh, mapFeatures, compare, select, clear, plan, build, verify, listFeatures, feature, yes, no }

class CheReaVoiceRequest {
  const CheReaVoiceRequest(this.op, {this.numbers = const []});
  final CheReaVoiceOp op;

  /// "number 2" (one), "select features 1 and 3" (several).
  final List<int> numbers;

  static final _polite = RegExp(r"^(?:please\s+|can you\s+|could you\s+|would you\s+|i want to\s+|i want you to\s+|let's\s+|now\s+)+", caseSensitive: false);
  static const _num = r'(?:f?\d+|one|first|two|second|to|too|three|third|four|for|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)';
  static const _che = r'(?:che|chay|chey|shay|you|yourself)';

  /// "1 and 3", "f1, f3", "one three": every number said, in order.
  static List<int> numbersIn(String text) => [
        for (final w in text.toLowerCase().split(RegExp(r'[\s,;&]+|\band\b|\bthen\b')))
          ?CheCommandVoice.numberFrom(w.replaceFirst(RegExp(r'^f(?=\d)'), '')),
      ];

  static CheReaVoiceRequest? parse(String raw) {
    var t = raw.trim().replaceAll('’', "'");
    if (t.startsWith('/')) return null;
    t = t.replaceAll(RegExp(r'[.!?]+$'), '');
    t = (cheWakeRemainder(t) ?? t).replaceFirst(_polite, '').trim();
    if (t.isEmpty) return null;
    bool has(String pattern) => RegExp(pattern, caseSensitive: false).hasMatch(t);
    RegExpMatch? m(String pattern) => RegExp(pattern, caseSensitive: false).firstMatch(t);

    if (has(r'^(?:yes|yeah|yep|yes please|do it|go ahead|confirm|i confirm|build it now)$')) return const CheReaVoiceRequest(CheReaVoiceOp.yes);
    if (has(r"^(?:no|nope|no thanks|don't|do not|never mind|cancel|cancel that|cancel it|stop|not now|don't build)$")) return const CheReaVoiceRequest(CheReaVoiceOp.no);
    if (has(r'^(?:go\s+)?back$|^(?:go\s+)?back\s+to\s+(?:the\s+)?(?:investigations?|list)$')) return const CheReaVoiceRequest(CheReaVoiceOp.back);
    if (has(r"^read\s+(?:this|it|that)(?:\s+(?:page|screen|investigation))?(?:\s+(?:aloud|out loud))?$|^read\s+aloud$|^(?:what'?s|what is)\s+on\s+(?:the\s+|this\s+|my\s+)?(?:screen|page)(?:\s+(?:right\s+)?now)?$|^what\s+am\s+i\s+looking\s+at$|^where\s+am\s+i$|^what\s+can\s+i\s+do(?:\s+here)?$|^(?:what are|read|list)(?:\s+me)?\s+(?:my\s+|the\s+)?(?:options|choices)$|^(?:read|list)\s+(?:the\s+|my\s+)?investigations$|^help$")) {
      return const CheReaVoiceRequest(CheReaVoiceOp.describe);
    }
    if (has(r'^(?:refresh|reload|update)(?:\s+(?:it|this|the\s+page|the\s+list|investigations?|the\s+investigations?))?$|^check\s+(?:with\s+che\s+)?again$')) {
      return const CheReaVoiceRequest(CheReaVoiceOp.refresh);
    }
    if (has(r'^(?:read|list|what are|tell me)\s+(?:me\s+)?(?:about\s+)?(?:the\s+|its\s+)?(?:features|feature map)$')) return const CheReaVoiceRequest(CheReaVoiceOp.listFeatures);
    if (m('^(?:read|describe|tell me about|what is|open)?\\s*feature\\s+($_num)\$') case final f?) {
      return CheReaVoiceRequest(CheReaVoiceOp.feature, numbers: numbersIn(f.group(1)!));
    }
    if (has(r'^(?:map|find|discover)\s+(?:the\s+|its\s+)?features$|^map\s+(?:it|them|this)$|^(?:make|build)\s+(?:the\s+|a\s+)?feature\s+map$')) {
      return const CheReaVoiceRequest(CheReaVoiceOp.mapFeatures);
    }
    if (has('^(?:compare|gap)(?:\\s+(?:it|this|them|that))?(?:\\s+(?:with|to|against)\\s+$_che)?\$|^(?:what does|what do)\\s+$_che\\s+(?:have|lack|miss)\$')) {
      return const CheReaVoiceRequest(CheReaVoiceOp.compare);
    }
    if (m(r'^(?:select|choose|pick|include|add|check)\s+(?:the\s+)?features?\s+(.+?)(?:\s+(?:for|to)\s+the\s+plan)?$') case final s?) {
      final n = numbersIn(s.group(1)!);
      if (n.isNotEmpty) return CheReaVoiceRequest(CheReaVoiceOp.select, numbers: n);
    }
    if (has(r'^(?:clear|unselect|deselect|uncheck)(?:\s+(?:all|the|my))?(?:\s+(?:features?|selection|choices))?$')) return const CheReaVoiceRequest(CheReaVoiceOp.clear);
    if (m(r'^plan(?:\s+(?:the\s+)?(?:selected|chosen|checked|it|them|these|those))?(?:\s+features?)?(?:\s+(.+))?$') case final p?) {
      final rest = p.group(1) ?? '';
      final n = numbersIn(rest);
      if (rest.isEmpty || n.isNotEmpty) return CheReaVoiceRequest(CheReaVoiceOp.plan, numbers: n);
    }
    if (has('^build(?:\\s+(?:it|this|them|that|the\\s+plan|the\\s+features|these\\s+features|the\\s+selected\\s+features))?(?:\\s+(?:into|in|for)\\s+$_che)?\$')) {
      return const CheReaVoiceRequest(CheReaVoiceOp.build);
    }
    if (has(r'^(?:verify|check)(?:\s+(?:it|this|that|the\s+build|the\s+pull\s+request|the\s+pr))?$')) return const CheReaVoiceRequest(CheReaVoiceOp.verify);
    if (m('^(?:open|pick|choose|select|read)?\\s*(?:number|option|investigation|the)?\\s*($_num)(?:\\s+one)?\$') case final n?) {
      return CheReaVoiceRequest(CheReaVoiceOp.pick, numbers: numbersIn(n.group(1)!));
    }
    return null;
  }
}
