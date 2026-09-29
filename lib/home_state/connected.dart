part of '../main.dart';

// One connected world: CHE's greeting on open, the activity feed, "find
// anything made in any room", the explanation level and "read to me". All
// data comes from the CHE server's real state (/api/greeting, /api/activity,
// /api/find); nothing here invents activity.
extension _CheHomeConnected on _CHEHomeState {
  static const String _lastSeenKey = 'che.home.lastSeenAt';
  static const String _explainKey = 'che.explainLevel';
  static const String _homeBaseUrlKey = 'che.homeBaseUrl';

  Future<Map<String, dynamic>?> _getAgentJson(String path) async {
    final cloud = await _getCloudAgentJson(path);
    if (cloud != null) return cloud;

    if (_homeBaseUrl.isNotEmpty) {
      try {
        final response = await http
            .get(Uri.parse('$_homeBaseUrl$path'))
            .timeout(const Duration(seconds: 12));
        if (response.statusCode == 200) {
          final decoded = jsonDecode(response.body);
          if (decoded is Map) return Map<String, dynamic>.from(decoded);
        }
      } catch (_) {}
    }

    return _localAnswer(path);
  }

  Future<Map<String, dynamic>?> _getCloudAgentJson(String path) async {
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

  Map<String, dynamic>? _localAnswer(String path) {
    final data = _localSnapshot();
    final uri = Uri.parse(path.startsWith('http') ? path : 'http://local$path');
    final route = uri.path;
    if (route == '/api/stalled') return {'items': stalledTasks(data)};
    if (route == '/api/decisions') return {'items': decisionsNeeded(data)};
    if (route == '/api/next') return {'actions': nextActions(data)};
    if (route == '/api/activity') return {'events': activityFeed(data)};
    if (route == '/api/greeting') {
      final hour = int.tryParse(uri.queryParameters['hour'] ?? '') ?? DateTime.now().hour;
      return {...greeting(data, hour: hour), 'suggestions': suggestions(data, hour: hour)};
    }
    if (route == '/api/find') return {'items': <Map<String, dynamic>>[]};
    return null;
  }

  void _restoreLocalSnapshotCache(SharedPreferences prefs) {
    final raw = prefs.getString('che.local.snapshot');
    if (raw == null || raw.isEmpty) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      _cachedSnapshot = {
        'team': [
          for (final e in (decoded['team'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
        'team_tasks': [
          for (final e in (decoded['team_tasks'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
        'projects': [
          for (final e in (decoded['projects'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
        'vault_items': [
          for (final e in (decoded['vault_items'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
        'jobs': [
          for (final e in (decoded['jobs'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
        'meetings': [
          for (final e in (decoded['meetings'] as List? ?? const []))
            if (e is Map) Map<String, dynamic>.from(e),
        ],
      };
    } catch (_) {}
  }

  Map<String, dynamic> _localSnapshot() => {
        'team': team.isNotEmpty ? team : (_cachedSnapshot['team'] as List? ?? const []),
        'team_tasks': teamTasks.isNotEmpty ? teamTasks : (_cachedSnapshot['team_tasks'] as List? ?? const []),
        'projects': projects.isNotEmpty ? projects : (_cachedSnapshot['projects'] as List? ?? const []),
        'vault_items': vaultItems.isNotEmpty ? vaultItems : (_cachedSnapshot['vault_items'] as List? ?? const []),
        'jobs': backgroundJobs.isNotEmpty ? backgroundJobs : (_cachedSnapshot['jobs'] as List? ?? const []),
        'meetings': _cachedSnapshot['meetings'] as List? ?? const [],
      };

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
      await speakText(line, record: false);
    }
  }

  /// Null when the feed could not be loaded (never reported as "empty").
  Future<List<Map<String, dynamic>>?> _loadActivity() async {
    final data = await _getAgentJson('/api/activity?limit=40');
    final list = data?['events'];
    if (list is! List) return null;
    return [for (final e in list) if (e is Map) Map<String, dynamic>.from(e)];
  }

  Future<void> _openActivityFeed({bool readAloud = false}) async {
    final events = await _loadActivity();
    if (!mounted) return;
    if (events == null) {
      await speakText('I couldn’t load the activity from the CHE server just now. Try again in a moment.', record: false);
      return;
    }
    if (readAloud) {
      await speakText(
        events.isEmpty
            ? 'Nothing new yet. Give me or the Office a task and I will keep track here.'
            : 'Here is what happened. ${events.take(5).map((e) => e['line']).join(' ')}',
        record: false,
      );
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: kit.CheColors.surface,
      builder: (_) => CheActivityFeedSheet(events: events, onSpeak: (t) => speakText(t, record: false)),
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

  bool _looksLikeCredential(String lower) => RegExp(
        r'\b(pass ?words?|pass ?codes?|pins?|log ?ins?|credentials?|security codes?|2fa|otp|card numbers?|credit cards?|cvv|ssn|social security|bank accounts?|routing numbers?|api keys?|tokens?|secrets?)\b',
      ).hasMatch(lower);

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

    // Stalled work / decisions / next actions.
    if (RegExp(r"^(what'?s|what is)\s+stalled\b|any\s+stalled\b").hasMatch(lower)) {
      final data = await _getAgentJson('/api/stalled');
      final items = [for (final e in (data?['items'] as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];
      if (items.isEmpty) { await speakText("Nothing's stalled right now."); return true; }
      final top = items.take(3).map((e) => '${e['who']} — ${e['title']}, ${e['reason']}.').join(' ');
      await speakText("Here's what's stalled. $top");
      return true;
    }
    if (RegExp(r"\b(what needs me|what do you need from me|any decisions|needs my (call|decision|approval))\b").hasMatch(lower)) {
      final data = await _getAgentJson('/api/decisions');
      final items = [for (final e in (data?['items'] as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];
      if (items.isEmpty) { await speakText("Nothing needs your call right now."); return true; }
      await speakText("Here's what needs you. ${items.take(3).map((e) => e['title']).join(' ')}");
      return true;
    }
    if (RegExp(r"^(what should i do|next actions|what'?s next|what do i do next)\b").hasMatch(lower)) {
      final data = await _getAgentJson('/api/next');
      final actions = [for (final e in (data?['actions'] as List? ?? const [])) e.toString()].where((e) => e.isNotEmpty).toList();
      if (actions.isEmpty) { await speakText("No next actions queued."); return true; }
      await speakText("Here's what's next. ${actions.join(' ')}");
      return true;
    }

    // Find anything made in any room: "play the song Mira made".
    final made = RegExp(r"^(?:play|show|open|find|read|get)\s+(?:me\s+)?(.+?\b(?:made|created|wrote|drew|did|finished)\b.*)$").firstMatch(lower);
    final find = made ?? RegExp(r'^find\s+(?:me\s+)?(.+)$').firstMatch(lower);
    // Anything that could be a credential stays on the phone: never search
    // the server with it (passwords live only in the on-device vault).
    if (find != null && _looksLikeCredential(lower)) return false;
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
