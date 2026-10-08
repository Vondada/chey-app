// One-step video voice commands from anywhere in CHE: "search YouTube for
// jazz", "find new videos about Mars", "play lofi beats video". They open
// CHE's own in-app browser on the results; inside it the existing browser
// voice ("play number one", "pause", "what's on the screen") takes over.

class CheVideoVoiceCommand {
  const CheVideoVoiceCommand({required this.query, required this.newest, required this.url});

  /// Empty for "find new videos" (the owner's subscriptions feed).
  final String query;
  final bool newest;
  final String url;

  String get spoken {
    if (query.isEmpty) return 'Opening your newest videos on YouTube in my browser, sir. Say "read the videos" to hear them, or "play number one".';
    return '${newest ? 'Searching the newest' : 'Searching'} YouTube videos for $query in my browser, sir. Say "read the videos" to hear the results, or "play number one".';
  }

  static final _prefix = RegExp(r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s*)?(?:please\s+|can you\s+|could you\s+)?', caseSensitive: false);

  static CheVideoVoiceCommand? parse(String raw) {
    final text = raw.trim().replaceFirst(_prefix, '').replaceAll(RegExp(r'[.!?]+$'), '').trim();
    if (text.isEmpty || text.length > 160) return null;
    final lower = text.toLowerCase();
    // Making a video is the video generator's job, not a search.
    if (RegExp(r'^(?:make|create|generate|render|edit)\b').hasMatch(lower)) return null;

    if (RegExp(r'^(?:find|show|get|open)(?: me)? (?:my )?(?:new|newest|latest|fresh) videos$').hasMatch(lower)) {
      return const CheVideoVoiceCommand(query: '', newest: true, url: 'https://m.youtube.com/feed/subscriptions');
    }
    // (pattern, query group, "newest" group or 0)
    final patterns = <(RegExp, int, int)>[
      (RegExp(r'^search (?:on )?youtube (?:for )?(.+)$'), 1, 0),
      (RegExp(r'^search (?:for )?(?:video results|videos?)(?: (?:for|about|of|on))? (.+)$'), 1, 0),
      (RegExp(r'^(?:find|show|get)(?: me)? (?:some )?((?:new|newest|latest|recent) )?(?:youtube )?videos? (?:about|of|on|for) (.+)$'), 2, 1),
      (RegExp(r'^(?:find|search|look up)(?: me)? (.+?) (?:videos?|on youtube)$'), 1, 0),
      (RegExp(r'^play (?:the )?(?:video|song) (.+)$'), 1, 0),
      (RegExp(r'^play (.+?) (?:video|on youtube)$'), 1, 0),
    ];
    for (final (re, queryGroup, newestGroup) in patterns) {
      final m = re.firstMatch(lower);
      if (m == null) continue;
      final newest = newestGroup > 0 && (m.group(newestGroup) ?? '').trim().isNotEmpty;
      final query = (m.group(queryGroup) ?? '').trim();
      if (query.length < 2 || RegExp(r'^(?:it|this|that|number \w+|the next one)$').hasMatch(query)) return null;
      final sort = newest ? '&sp=CAI%253D' : ''; // YouTube "upload date" sort
      return CheVideoVoiceCommand(
        query: query,
        newest: newest,
        url: 'https://m.youtube.com/results?search_query=${Uri.encodeQueryComponent(query)}$sort',
      );
    }
    return null;
  }
}
