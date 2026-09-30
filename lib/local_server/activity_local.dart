const Duration _localStallAfter = Duration(minutes: 45);
const Set<String> _localDoneStatuses = {
  'complete',
  'completed',
  'done',
  'succeeded',
};

List<Map<String, dynamic>> _localMaps(dynamic value) {
  if (value is! List) return <Map<String, dynamic>>[];
  return [
    for (final item in value)
      if (item is Map) Map<String, dynamic>.from(item),
  ];
}

String _localShortTitle(dynamic text, [int maxWords = 6]) {
  final clean = (text ?? '').toString().replaceAll(RegExp(r'\s+'), ' ').trim();
  final clause = RegExp(r'^(.{12,}?)[.;:!?]').firstMatch(clean);
  final source = clause?.group(1) ?? clean;
  final words = source.split(' ').where((word) => word.isNotEmpty).toList();
  return words.length <= maxWords
      ? words.join(' ')
      : '${words.take(maxWords).join(' ')}…';
}

int _localAgeMs(Map<String, dynamic> item) {
  final raw = (item['updated_at'] ?? item['created_at'] ?? '').toString();
  final parsed = DateTime.tryParse(raw);
  if (parsed == null) return 0;
  return DateTime.now().toUtc().difference(parsed.toUtc()).inMilliseconds;
}

bool _localHasValue(dynamic value) {
  if (value == null || value == false) return false;
  if (value is String) return value.isNotEmpty;
  return true;
}

String _localTimeSuggestion(int hour) {
  if (hour < 5) return 'Up late? I can wind down with some music.';
  if (hour < 11) return 'Want me to plan your day?';
  if (hour < 14) return 'Want a quick midday check of your top project?';
  if (hour < 18) return 'Want me to put the team on your next big task?';
  if (hour < 22) return 'Want to watch something together in the Theater?';
  return 'Want a quick recap of today before bed?';
}

String _localPartOfDay(int hour) {
  if (hour < 5) return 'Hey night owl';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

List<Map<String, dynamic>> stalledTasks(Map<String, dynamic> data) {
  final out = <Map<String, dynamic>>[];
  for (final t in _localMaps(data['team_tasks'])) {
    final status = (t['status'] ?? '').toString();
    if (!const {'running', 'queued', 'blocked', 'waiting'}.contains(status)) {
      continue;
    }
    final blob =
        '${t['task'] ?? ''} ${t['result'] ?? ''} ${t['blocker'] ?? ''}';
    final waitingOnOwner = RegExp(
      r'need(s)? (you|the owner|approval|a decision)',
      caseSensitive: false,
    ).hasMatch(blob);
    final stale = _localAgeMs(t) > _localStallAfter.inMilliseconds;
    if (status == 'blocked' || waitingOnOwner || stale) {
      out.add({
        'id': t['id'],
        'who': (t['partner_name'] ?? 'An agent').toString(),
        'title': _localShortTitle(t['task']),
        'reason': waitingOnOwner
            ? 'needs your decision'
            : status == 'blocked'
                ? 'blocked'
                : 'no update in a while',
        'at': t['updated_at'] ?? t['created_at'],
      });
    }
  }
  out.sort(
    (a, b) => (a['at'] ?? '')
        .toString()
        .compareTo((b['at'] ?? '').toString()),
  );
  return out;
}

List<Map<String, dynamic>> decisionsNeeded(Map<String, dynamic> data) {
  return stalledTasks(data)
      .where((item) => item['reason'] == 'needs your decision')
      .toList();
}

List<String> nextActions(Map<String, dynamic> data) {
  final actions = <String>[];

  final decisions = decisionsNeeded(data);
  if (decisions.isNotEmpty) {
    final decide = decisions.first;
    actions.add(
      'Decide on "${decide['title']}" for ${decide['who']}',
    );
  }

  for (final stall in stalledTasks(data)) {
    if (stall['reason'] == 'needs your decision') continue;
    actions.add(
      'Check in on ${stall['who']} — "${stall['title']}" is ${stall['reason']}',
    );
    break;
  }

  for (final task in _localMaps(data['team_tasks'])) {
    if (!_localDoneStatuses.contains((task['status'] ?? '').toString())) {
      continue;
    }
    actions.add(
      'Read what ${task['partner_name'] ?? 'the Office'} finished',
    );
    break;
  }

  final projects = _localMaps(data['projects']);
  if (projects.isNotEmpty) {
    actions.add(
      "What's next on ${_localShortTitle(projects.first['title'], 4)}?",
    );
  }

  return actions.take(3).toList();
}

List<Map<String, dynamic>> activityFeed(
  Map<String, dynamic> data, {
  int limit = 30,
}) {
  final events = <Map<String, dynamic>>[];

  for (final stalled in stalledTasks(data)) {
    events.add({
      'at': stalled['at'],
      'who': stalled['who'],
      'kind': 'stalled',
      'id': stalled['id'],
      'line':
          '${stalled['who']} is stalled on "${stalled['title']}" (${stalled['reason']}).',
    });
  }

  for (final task in _localMaps(data['team_tasks'])) {
    final who = (task['partner_name'] ?? 'An agent').toString();
    final title = _localShortTitle(task['task']);
    final status = (task['status'] ?? '').toString();
    var line = '';
    if (_localDoneStatuses.contains(status)) {
      line = '$who finished "$title".';
    } else if (status == 'running') {
      line = '$who is working on "$title".';
    } else if (status == 'queued') {
      line = '$who has "$title" next.';
    } else if (status == 'failed') {
      line = '$who could not finish "$title".';
    }
    if (line.isNotEmpty) {
      events.add({
        'at': task['updated_at'] ?? task['created_at'],
        'who': who,
        'line': line,
        'kind': 'agent_task',
        'id': task['id'],
      });
    }
  }

  for (final meeting in _localMaps(data['meetings'])) {
    final objective = _localShortTitle(meeting['objective']);
    events.add({
      'at': meeting['updated_at'] ?? meeting['created_at'],
      'who': 'War Room',
      'kind': 'meeting',
      'id': meeting['id'],
      'line': _localHasValue(meeting['final_plan'])
          ? 'The War Room made a plan for "$objective".'
          : 'The War Room is meeting on "$objective".',
    });
  }

  for (final job in _localMaps(data['jobs'])) {
    final title = _localShortTitle(job['title'] ?? job['prompt']);
    final status = (job['status'] ?? '').toString();
    var line = '';
    if (_localDoneStatuses.contains(status)) {
      line = 'CHE finished "$title".';
    } else if (status == 'queued' || status == 'running') {
      line = 'CHE is working on "$title".';
    } else if (status == 'failed') {
      line = 'CHE could not finish "$title".';
    }
    if (line.isNotEmpty) {
      events.add({
        'at': job['updated_at'] ?? job['created_at'],
        'who': 'CHE',
        'kind': 'job',
        'id': job['id'],
        'line': line,
      });
    }
  }

  for (final project in _localMaps(data['projects'])) {
    events.add({
      'at': project['created_at'],
      'who': 'CHE',
      'kind': 'project',
      'id': project['id'],
      'line':
          'CHE started the project "${_localShortTitle(project['title'])}".',
    });
  }

  events.removeWhere((event) => event['at'] == null);
  events.sort(
    (a, b) => (b['at'] ?? '')
        .toString()
        .compareTo((a['at'] ?? '').toString()),
  );
  return events.take(limit).toList();
}

Map<String, dynamic> greeting(
  Map<String, dynamic> data, {
  int hour = 12,
  String since = '',
}) {
  final h = hour.clamp(0, 23).toInt();
  final hello = _localPartOfDay(h);

  final decisions = decisionsNeeded(data);
  if (decisions.isNotEmpty) {
    final decide = decisions.first;
    return {
      'line':
          '$hello! ${decide['who']} needs you on "${decide['title']}".',
      'kind': 'decision',
    };
  }

  final stalled = stalledTasks(data);
  if (stalled.isNotEmpty) {
    final item = stalled.first;
    return {
      'line':
          '$hello! ${item['who']} is stalled on "${item['title']}".',
      'kind': 'stalled',
    };
  }

  final tasks = _localMaps(data['team_tasks']);
  final finished = tasks.where((task) {
    if (!_localDoneStatuses.contains((task['status'] ?? '').toString())) {
      return false;
    }
    if (since.isEmpty) return true;
    return (task['updated_at'] ?? '').toString().compareTo(since) > 0;
  }).toList();

  if (finished.isNotEmpty) {
    final task = finished.first;
    final more = finished.length > 1 ? ' and ${finished.length - 1} more' : '';
    return {
      'line':
          '$hello! ${task['partner_name'] ?? 'The Office'} finished "${_localShortTitle(task['task'], 5)}"$more. Want to hear it?',
      'kind': 'finished',
    };
  }

  for (final task in tasks) {
    final status = (task['status'] ?? '').toString();
    if (status != 'running' && status != 'queued') continue;
    return {
      'line':
          '$hello! ${task['partner_name'] ?? 'The Office'} is on "${_localShortTitle(task['task'], 5)}". ${_localTimeSuggestion(h)}',
      'kind': 'working',
    };
  }

  for (final meeting in _localMaps(data['meetings'])) {
    if (!_localHasValue(meeting['final_plan'])) continue;
    if (since.isNotEmpty &&
        (meeting['updated_at'] ?? '').toString().compareTo(since) <= 0) {
      continue;
    }
    return {
      'line':
          '$hello! The War Room has a plan for "${_localShortTitle(meeting['objective'], 5)}". Want it?',
      'kind': 'plan',
    };
  }

  return {
    'line': '$hello! ${_localTimeSuggestion(h)}',
    'kind': 'suggestion',
  };
}

List<String> localSuggestions(
  Map<String, dynamic> data, {
  int hour = 12,
}) {
  final out = nextActions(data);

  final hasActiveAgent =
      _localMaps(data['team']).any((agent) => agent['retired'] != true);
  if (hasActiveAgent &&
      !out.any((item) => RegExp('office', caseSensitive: false).hasMatch(item))) {
    out.add('What is the Office doing?');
  }

  final fill = hour < 11
      ? <String>['Plan my day', 'What is the weather today?', 'Play some music']
      : hour < 18
          ? <String>[
              'Put the team on my top task',
              'Make me an image',
              'Research something for me',
            ]
          : <String>[
              'Watch something in the Theater',
              'Recap my day',
              'Play some music',
            ];

  for (final item in fill) {
    if (out.length >= 3) break;
    if (!out.contains(item)) out.add(item);
  }

  return out.take(3).toList();
}
