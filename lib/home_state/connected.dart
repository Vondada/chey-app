part of '../main.dart';

// One connected world: CHE's greeting on open, the activity feed, "find
// anything made in any room", the explanation level and "read to me". All
// data comes from the CHE server's real state (/api/greeting, /api/activity,
// /api/find); nothing here invents activity.
extension _CheHomeConnected on _CHEHomeState {
  static const String _lastSeenKey = 'che.home.lastSeenAt';
  static const String _explainKey = 'che.explainLevel';

  Future<Map<String, dynamic>?> _getAgentJson(String path) async {
    if (_deviceToken == null || _deviceToken!.isEmpty || cheAgentBaseUrl.isEmpty) return null;
    try {
      final response = await http
          .get(Uri.parse('$cheAgentBaseUrl$path'), headers: _authHeaders)
          .timeout(const Duration(seconds: 12));
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> _loadExplainLevel() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_explainKey);
      if (saved != null && mounted) _set(() => _explainLevel = saved);
    } catch (_) {}
  }

  Future<void> _setExplainLevel(String level) async {
    _set(() => _explainLevel = level);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_explainKey, level);
    } catch (_) {}
  }

  /// Loads CHE's one-line greeting and three suggestions; speaks the greeting
  /// once per launch when the conversation is empty.
  Future<void> _loadHomeGreeting({bool speak = false}) async {
    String since = '';
    SharedPreferences? prefs;
    try {
      prefs = await SharedPreferences.getInstance();
      since = prefs.getString(_lastSeenKey) ?? '';
    } catch (_) {}
    final hour = DateTime.now().hour;
    final data = await _getAgentJson('/api/greeting?hour=$hour&since=${Uri.encodeQueryComponent(since)}');
    if (data == null || !mounted) return;
    final line = data['line']?.toString().trim() ?? '';
    final list = (data['suggestions'] as List? ?? const []).map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
    _set(() {
      if (line.isNotEmpty) _homeGreeting = line;
      if (list.isNotEmpty) _homeSuggestions = list;
    });
    try {
      await prefs?.setString(_lastSeenKey, DateTime.now().toUtc().toIso8601String());
    } catch (_) {}
    if (speak && !_greetedThisLaunch && line.isNotEmpty && messages.isEmpty && voiceResponsesEnabled && !_isSpeaking) {
      _greetedThisLaunch = true;
      await speakText(line);
    }
  }

  Future<List<Map<String, dynamic>>> _loadActivity() async {
    final data = await _getAgentJson('/api/activity?limit=40');
    return [for (final e in (data?['events'] as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];
  }

  Future<void> _openActivityFeed({bool readAloud = false}) async {
    final events = await _loadActivity();
    if (!mounted) return;
    if (readAloud) {
      await speakText(events.isEmpty
          ? 'Nothing new yet. Give me or the Office a task and I will keep track here.'
          : 'Here is what happened. ${events.take(5).map((e) => e['line']).join(' ')}');
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: kit.CheColors.surface,
      builder: (_) => CheActivityFeedSheet(events: events, onSpeak: speakText),
    );
  }

  String _officeSpokenSummary() {
    final r = _officeRuntime;
    if (r.agents.isEmpty) return 'The Office is empty right now. Ask me to build a team for a project.';
    final parts = <String>['${r.agents.length} agents, ${r.working} working.'];
    for (final p in r.agents.take(6)) {
      final task = p.agent.task;
      parts.add('${p.agent.name} is ${task != null && task.isNotEmpty ? 'on ${cheShortSummary(task)}' : p.agent.status.name}.');
    }
    return parts.join(' ');
  }

  /// Voice/typed commands for the connected world. Returns true when handled.
  Future<bool> _handleConnectedCommand(String message) async {
    final lower = message.toLowerCase().trim().replaceAll(RegExp(r'[.!?]+$'), '');

    // Explanation level. The message still goes to CHE, now at the new level.
    if (RegExp(r"\b(explain (it )?like i'?m (5|five)|simpler|keep it simple|dumb it down)\b").hasMatch(lower)) {
      await _setExplainLevel('simple');
      return false;
    }
    if (RegExp(r'\b(go deeper|more detail|in depth|explain more|tell me more)\b').hasMatch(lower)) {
      await _setExplainLevel('deeper');
      return false;
    }
    if (RegExp(r'\b(normal explanations?|regular detail)\b').hasMatch(lower)) {
      await _setExplainLevel('normal');
      await speakText('Okay, normal detail from now on.');
      return true;
    }

    // Activity feed.
    if (RegExp(r"^(what happened|what('s| is) new|what did (you|the office|everyone|the team) do|(open |show |read )?(me )?(the )?activity( feed)?)\b").hasMatch(lower)) {
      if (mounted) _set(() => controller.clear());
      await _openActivityFeed(readAloud: true);
      return true;
    }

    // Read the Office aloud.
    if (RegExp(r'^(read (the office|me the office|the office to me)|what is the office doing|what.s the office doing)\b').hasMatch(lower)) {
      await speakText(_officeSpokenSummary());
      return true;
    }

    // Find anything made in any room: "play the song Mira made".
    final made = RegExp(r"^(?:play|show|open|find|read|get)\s+(?:me\s+)?(.+?\b(?:made|created|wrote|drew|did)\b.*)$").firstMatch(lower);
    final find = made ?? RegExp(r'^find\s+(?:me\s+)?(.+)$').firstMatch(lower);
    if (find != null) {
      final data = await _getAgentJson('/api/find?q=${Uri.encodeQueryComponent(message)}');
      final items = [for (final e in (data?['items'] as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];
      if (items.isEmpty) return false; // Let CHE answer honestly.
      final top = items.first;
      final title = top['title']?.toString() ?? 'that';
      final maker = top['maker']?.toString() ?? 'CHE';
      final text = top['text']?.toString() ?? '';
      final reply = '“$title” by $maker.${text.isNotEmpty ? '\n\n$text' : ''}';
      if (!mounted) return true;
      _set(() {
        messages.add({'role': 'user', 'text': message});
        messages.add({
          'role': 'assistant',
          'text': reply,
          if ((top['media_url']?.toString() ?? '').startsWith('https://')) 'media_url': top['media_url'].toString(),
          if (top['media_type'] != null) 'media_type': top['media_type'].toString(),
        });
        controller.clear();
      });
      _scrollToBottom();
      await speakText(text.isNotEmpty ? 'Here’s “$title” by $maker. $text' : 'Here’s “$title” by $maker.');
      return true;
    }
    return false;
  }
}
