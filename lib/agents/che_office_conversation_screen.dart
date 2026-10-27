// Full-screen Office conversation (owner rule, 2026-10-26). Opened from an agent's desk or from one of its tasks.
// Shows the agent's real state, then every recorded message in order, with exact untruncated text, search, filter
// groups and expandable details. Newest message at the bottom; the view opens scrolled there. The search box and
// filter groups stay fixed at the top. Passive: nothing here speaks on its own. Read aloud happens only when the
// owner taps a Read button or asks by voice.
//
// Voice route (AGENTS.md): while this screen is open, the home navigator (lib/home_state/send.dart) offers each
// spoken or typed turn to [CheOfficeConversationScreen.voiceHandler] first. Every on-screen action has a spoken
// form: describe the screen, read the status, read message N or the latest message, message N details, search,
// clear the search, filter by group, refresh, and a numbered list of options with spoken choices. Each reply is
// also shown as large text at the top of the screen.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_office_conversation.dart';

class CheOfficeConversationScreen extends StatefulWidget {
  const CheOfficeConversationScreen({
    super.key,
    required this.conversation,
    this.onRefresh,
    this.onReadAloud,
  });

  final CheOfficeConversation conversation;

  /// Re-reads the record from the Worker. Null when the screen shows a record it was given.
  final Future<CheOfficeConversation> Function()? onRefresh;

  /// Speaks one message's text when the owner taps its Read button.
  final void Function(String text)? onReadAloud;

  /// Spoken and typed control while this screen is open. Returns the reply to speak and show, or null when the
  /// words are not for this screen (they then go on to Chat). Null when the screen is closed.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheOfficeConversationScreen> createState() => _CheOfficeConversationScreenState();
}

class _CheOfficeConversationScreenState extends State<CheOfficeConversationScreen> {
  late CheOfficeConversation _c = widget.conversation;
  final _search = TextEditingController();
  final _scroll = ScrollController();
  String _filter = 'All';
  String? _error;
  bool _refreshing = false;

  /// The last reply to a spoken or typed command, shown as large text so nothing is only spoken.
  String? _reply;

  /// Messages whose details the owner opened by voice.
  final Set<int> _expanded = {};

  /// True right after the numbered options were read, so a bare number picks one.
  bool _optionsOffered = false;

  @override
  void initState() {
    super.initState();
    CheOfficeConversationScreen.voiceHandler = _voice;
    _jumpToNewestSoon();
  }

  @override
  void didUpdateWidget(covariant CheOfficeConversationScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.conversation, widget.conversation)) {
      _c = widget.conversation;
      _jumpToNewestSoon();
    }
  }

  @override
  void dispose() {
    if (CheOfficeConversationScreen.voiceHandler == _voice) CheOfficeConversationScreen.voiceHandler = null;
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _jumpToNewestSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  /// Re-reads the record. Returns true when it was refreshed, false when it failed or cannot refresh.
  Future<bool> _refresh() async {
    final load = widget.onRefresh;
    if (load == null || _refreshing) return false;
    setState(() => _refreshing = true);
    try {
      final next = await load();
      if (!mounted) return false;
      setState(() {
        _c = next;
        _error = null;
        _expanded.clear();
      });
      _jumpToNewestSoon();
      return true;
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
      return false;
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  bool _matchesFilter(CheConversationMessage m) {
    final kinds = cheConversationFilters[_filter];
    return kinds == null || kinds.contains(m.kind);
  }

  List<CheConversationMessage> get _visible => [
        for (final m in _c.messages)
          if (_matchesFilter(m) && cheConversationMatches(m, _search.text)) m,
      ];

  static const List<String> _options = [
    'Describe this screen',
    'Read the status',
    'Read the latest message',
    'Read a message by its number',
    'Read the details of a message',
    'Search the conversation',
    'Filter the messages',
    'Refresh the conversation',
  ];

  /// Shows [text] as large text at the top of the screen, with a light haptic, and returns it to be spoken.
  String _say(String text, {bool offered = false}) {
    HapticFeedback.selectionClick();
    if (mounted) setState(() => _reply = text);
    _optionsOffered = offered;
    return text;
  }

  String _messageSpeech(CheConversationMessage m) {
    final text = m.text.isEmpty ? 'No text recorded.' : m.text;
    final time = m.at == null ? 'time not recorded' : cheAbsoluteTime(m.at);
    return 'Message ${m.seq}, ${m.kindLabel}, from ${m.speaker} to ${m.to}, $time. $text';
  }

  String _statusSpeech() {
    final a = _c.agent;
    final task = _c.task;
    if (_c.scope == 'task' && task != null) {
      return 'Task: ${task.title}. Status: ${task.state?.label ?? 'not recorded'}. ${task.reason}'
          '${a == null ? '' : ' Agent: ${a.name}, whose status is ${a.status?.label ?? 'not recorded'}.'}';
    }
    if (a != null) {
      return '${a.name}${a.role.isEmpty ? '' : ', ${a.role}'}. Status: ${a.status?.label ?? 'no task recorded'}. ${a.statusReason} '
          'Active task: ${a.activeTask?.title ?? 'none'}. Current step: ${a.currentStep ?? 'not recorded'}. '
          'Next scheduled action: ${a.nextScheduled ?? 'not recorded'}. '
          '${a.blockers.isEmpty ? 'No blockers recorded.' : 'Blockers: ${a.blockers.map((b) => b.text).join('; ')}.'}';
    }
    return task == null ? 'No status is recorded.' : 'Task: ${task.title}. Status: ${task.state?.label ?? 'not recorded'}. ${task.reason}';
  }

  String _optionsSpeech() =>
      'You can say: ${[for (var i = 0; i < _options.length; i++) '${i + 1}. ${_options[i]}'].join('. ')}. Say a number to choose.';

  String _filtersSpeech() {
    final names = cheConversationFilters.keys.toList();
    return 'Filters: ${[for (var i = 0; i < names.length; i++) '${i + 1}. ${names[i]}'].join('. ')}. Say, for example, filter errors.';
  }

  CheConversationMessage? _bySeq(int seq) {
    for (final m in _c.messages) {
      if (m.seq == seq) return m;
    }
    return null;
  }

  Future<String> _choose(int n) async {
    switch (n) {
      case 1:
        return _say(_describe());
      case 2:
        return _say(_statusSpeech());
      case 3:
        final v = _visible;
        return _say(v.isEmpty ? 'No messages are showing.' : _messageSpeech(v.last));
      case 4:
        return _say('Say read message, then its number. Messages are numbered 1 to ${_c.messages.length}.');
      case 5:
        return _say('Say details for message, then its number.');
      case 6:
        return _say('Say search for, then the words to find.');
      case 7:
        return _say(_filtersSpeech());
      case 8:
        return _refreshSpeech();
    }
    return _say('There is no option $n. ${_optionsSpeech()}', offered: true);
  }

  Future<String> _refreshSpeech() async {
    if (widget.onRefresh == null) return _say('This conversation cannot be refreshed here.');
    if (_refreshing) return _say('Already refreshing.');
    final ok = await _refresh();
    return _say(ok
        ? 'Refreshed. ${_c.messages.length} messages. Status: ${(_c.scope == 'task' ? _c.task?.state : _c.agent?.status)?.label ?? 'not recorded'}.'
        : 'The refresh failed: ${_error ?? 'no reason was given'}. The screen still shows the earlier record.');
  }

  String _describe() {
    final a = _c.agent;
    final who = _c.scope == 'task' ? 'the task conversation${a == null ? '' : ' for ${a.name}'}' : '${a?.name ?? 'an Office'} conversation';
    final v = _visible;
    final search = _search.text.trim();
    return 'This is $who. ${_statusSpeech()} '
        'Showing ${v.length} of ${_c.messages.length} messages, filter $_filter${search.isEmpty ? '' : ', search "$search"'}. '
        'Oldest first; the newest is message ${v.isEmpty ? 'none' : v.last.seq}. Say options to hear what you can do.';
  }

  /// Spoken and typed commands for this screen. Anything else returns null and goes on to Chat.
  Future<String?> _voice(String words) async {
    if (!mounted) return null;
    final t = words.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.!?]+$'), '').trim();
    if (t.isEmpty) return null;
    final offered = _optionsOffered;
    _optionsOffered = false;

    const numberWords = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10};
    int? num(String s) => int.tryParse(s) ?? numberWords[s];

    final choice = RegExp(r'^(?:option|choice|number)\s+(\w+)$').firstMatch(t) ??
        (offered ? RegExp(r'^(\d+|one|two|three|four|five|six|seven|eight)$').firstMatch(t) : null);
    if (choice != null && num(choice.group(1)!) != null) return _choose(num(choice.group(1)!)!);

    if (RegExp(r'^(?:options|help|what can i (?:say|do)(?: here)?|read (?:the |my )?options|list (?:the )?options)$').hasMatch(t)) {
      return _say(_optionsSpeech(), offered: true);
    }
    if (RegExp(r"^(?:describe|read)(?: this| the)? (?:screen|page|view)$|^what(?:'s| is) on (?:this|the) (?:screen|page)$|^where am i$").hasMatch(t)) {
      return _say(_describe());
    }
    if (RegExp(r"^(?:read|say|what(?:'s| is))(?: me)?(?: the| his| her| their| this)? (?:status|state|current step|progress)$|^what is (?:he|she|it|the agent) doing$").hasMatch(t)) {
      return _say(_statusSpeech());
    }
    if (RegExp(r'^read(?: me)?(?: the)? (?:latest|last|newest)(?: message)?$').hasMatch(t)) {
      final v = _visible;
      return _say(v.isEmpty ? 'No messages are showing.' : _messageSpeech(v.last));
    }
    final read = RegExp(r'^read(?: me)?(?: the)? message (?:number )?(\w+)$').firstMatch(t);
    if (read != null) {
      final n = num(read.group(1)!);
      final m = n == null ? null : _bySeq(n);
      return _say(m == null ? 'There is no message ${read.group(1)}. Messages are numbered 1 to ${_c.messages.length}.' : _messageSpeech(m));
    }
    final details = RegExp(r'^(?:(?:read |show |open |expand )?(?:the )?details (?:for|of|on) message|expand message|open message) (?:number )?(\w+)(?: details)?$')
        .firstMatch(t);
    if (details != null) {
      final n = num(details.group(1)!);
      final m = n == null ? null : _bySeq(n);
      if (m == null) return _say('There is no message ${details.group(1)}. Messages are numbered 1 to ${_c.messages.length}.');
      setState(() {
        _expanded.add(m.seq);
        if (!_visible.contains(m)) {
          _filter = 'All';
          _search.clear();
        }
      });
      final rows = [for (final (label, value) in _detailRows(m)) '$label: ${value == null || value.trim().isEmpty ? 'Not recorded' : value}'];
      return _say('Details for message ${m.seq}. ${rows.join('. ')}.');
    }
    if (RegExp(r'^(?:clear|reset|remove)(?: the)? search$').hasMatch(t)) {
      setState(() => _search.clear());
      _jumpToNewestSoon();
      return _say('Search cleared. Showing ${_visible.length} of ${_c.messages.length} messages.');
    }
    // "search for X", "look for X", "find X in this conversation". A bare "find me a restaurant" goes on to Chat.
    final search = RegExp(r'^(?:search(?: (?:this|the) conversation)?(?: for)?|look for) (.+?)(?: in (?:this|the) conversation)?$').firstMatch(t) ??
        RegExp(r'^find (.+?) in (?:this|the) conversation$').firstMatch(t);
    if (search != null) {
      final q = search.group(1)!.replaceFirst(RegExp(r'^(?:the words? |messages? (?:about|with) )'), '').trim();
      setState(() => _search.text = q);
      _jumpToNewestSoon();
      final v = _visible;
      return _say(v.isEmpty
          ? 'No messages match "$q" with the $_filter filter.'
          : '${v.length} ${v.length == 1 ? 'message matches' : 'messages match'} "$q". The newest is message ${v.last.seq}. Say read message ${v.last.seq} to hear it.');
    }
    if (RegExp(r'^(?:filters|list (?:the )?filters|what filters(?: are there)?|read (?:the )?filters)$').hasMatch(t)) {
      return _say(_filtersSpeech());
    }
    final filter = RegExp(r'^(?:filter(?: by| to)?|show(?: me)?(?: only)?(?: the)?|only show(?: the)?)\s+(.+?)(?: messages| only| filter)?$').firstMatch(t);
    if (filter != null) {
      final want = filter.group(1)!.trim();
      final names = cheConversationFilters.keys.toList();
      String? pick;
      final n = num(want);
      if (n != null && n >= 1 && n <= names.length) pick = names[n - 1];
      pick ??= names.where((k) {
        final key = k.toLowerCase();
        return key == want || key == '${want}s' || '${key}s' == want || (want == 'everything' && k == 'All') || (want == 'reviews' && k == 'CHE review') || (want == 'review' && k == 'CHE review');
      }).firstOrNull;
      if (pick == null) return want.startsWith('filter') ? _say(_filtersSpeech()) : null;
      setState(() => _filter = pick!);
      _jumpToNewestSoon();
      final v = _visible;
      return _say('Filter $pick. Showing ${v.length} of ${_c.messages.length} messages${v.isEmpty ? '' : '; the newest is message ${v.last.seq}'}.');
    }
    if (RegExp(r'^(?:refresh|reload|update)(?: the| this)?(?: conversation| screen| messages)?$').hasMatch(t)) {
      return _refreshSpeech();
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final visible = _visible;
    final agent = _c.agent;
    final title = _c.scope == 'task'
        ? (agent == null ? 'Office task' : '${agent.name} · task conversation')
        : (agent == null ? 'Office task' : '${agent.name} · conversation');
    return Scaffold(
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (widget.onRefresh != null)
            IconButton(
              tooltip: 'Refresh conversation',
              onPressed: _refreshing ? null : () => unawaited(_refresh()),
              icon: const Icon(Icons.refresh_rounded),
            ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, 0),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_reply != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: CheSpace.sm),
                  child: Semantics(
                    liveRegion: true,
                    label: 'CHE said: $_reply',
                    child: ExcludeSemantics(
                      child: Container(
                        padding: const EdgeInsets.all(CheSpace.md),
                        decoration: BoxDecoration(
                          color: CheColors.surfaceHi,
                          borderRadius: BorderRadius.circular(CheRadius.md),
                          border: Border.all(color: CheColors.accent),
                        ),
                        constraints: const BoxConstraints(maxHeight: 180),
                        child: SingleChildScrollView(child: Text(_reply!, style: CheType.title)),
                      ),
                    ),
                  ),
                ),
              Semantics(
                label: 'Search this conversation',
                textField: true,
                child: TextField(
                  controller: _search,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    labelText: 'Search this conversation',
                    prefixIcon: const Icon(Icons.search_rounded),
                    suffixIcon: _search.text.isEmpty
                        ? null
                        : IconButton(
                            tooltip: 'Clear search',
                            icon: const Icon(Icons.close_rounded),
                            onPressed: () => setState(() => _search.clear()),
                          ),
                  ),
                ),
              ),
              const SizedBox(height: CheSpace.sm),
              Wrap(
                spacing: CheSpace.sm,
                runSpacing: CheSpace.xs,
                children: [
                  for (final name in cheConversationFilters.keys)
                    FilterChip(
                      label: Text(name),
                      selected: _filter == name,
                      onSelected: (_) {
                        setState(() => _filter = name);
                        _jumpToNewestSoon();
                      },
                    ),
                ],
              ),
              const SizedBox(height: CheSpace.xs),
              Text(
                'Showing ${visible.length} of ${_c.messages.length} messages. Oldest first; newest at the bottom.',
                style: CheType.caption,
              ),
            ]),
          ),
          Expanded(
            child: ListView(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.xxl),
              children: [
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: CheSpace.md),
                    child: Text('Could not refresh: $_error', style: CheType.caption.copyWith(color: CheColors.danger)),
                  ),
                // A task view shows the selected task; its agent stays as context inside the panel. The agent
                // panel (active task, current step) is for the agent view only.
                if (_c.scope == 'task' && _c.task != null)
                  _TaskPanel(task: _c.task!, agent: agent)
                else if (agent != null)
                  _AgentPanel(agent: agent)
                else if (_c.task != null)
                  _TaskPanel(task: _c.task!),
                const SizedBox(height: CheSpace.md),
                _EvidencePanel(messages: _c.messages),
                const SizedBox(height: CheSpace.md),
                if (_c.messages.isEmpty)
                  Text('No messages are recorded for this conversation yet.', style: CheType.bodyDim)
                else if (visible.isEmpty)
                  Text('No messages match this search and filter.', style: CheType.bodyDim),
                for (final m in visible)
                  _MessageCard(
                    key: ValueKey('message-${m.seq}-${_expanded.contains(m.seq)}'),
                    message: m,
                    onReadAloud: widget.onReadAloud,
                    detailsOpen: _expanded.contains(m.seq),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Color _stateColor(CheOfficeState? s) => s?.color ?? CheColors.textDim;

class _StatePill extends StatelessWidget {
  const _StatePill({required this.state, required this.raw});
  final CheOfficeState? state;
  final String raw;
  @override
  Widget build(BuildContext context) {
    final label = state?.label ?? 'No task recorded';
    return Semantics(
      label: 'Status: $label${raw.isEmpty ? '' : '. Stored status: $raw'}',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CheRadius.pill),
          border: Border.all(color: _stateColor(state)),
        ),
        child: Text(
          raw.isEmpty || state == null ? label : '$label · $raw',
          style: CheType.caption.copyWith(color: _stateColor(state), fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

/// One label and value. A null or empty value is shown as "Not recorded".
class _Kv extends StatelessWidget {
  const _Kv(this.label, this.value);
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) {
    final v = (value == null || value!.trim().isEmpty) ? 'Not recorded' : value!;
    final missing = v == 'Not recorded';
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.sm),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label.toUpperCase(), style: CheType.overline.copyWith(color: CheColors.accent)),
        const SizedBox(height: 2),
        SelectableText(v, style: missing ? CheType.bodyDim : CheType.body),
      ]),
    );
  }
}

class _AgentPanel extends StatelessWidget {
  const _AgentPanel({required this.agent});
  final CheConversationAgent agent;
  @override
  Widget build(BuildContext context) {
    final active = agent.activeTask;
    final done = agent.lastCompleted;
    final blockers = agent.blockers;
    return Card(
      color: CheColors.surfaceHi,
      child: Padding(
        padding: const EdgeInsets.all(CheSpace.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(agent.name, style: CheType.title),
          Text(agent.role.isEmpty ? 'Role not recorded' : agent.role, style: CheType.label),
          const SizedBox(height: CheSpace.sm),
          _StatePill(state: agent.status, raw: agent.statusRaw),
          const SizedBox(height: CheSpace.xs),
          Text(agent.statusReason, style: CheType.caption),
          const SizedBox(height: CheSpace.md),
          _Kv('Active task', active?.title ?? 'No active task'),
          _Kv('Current step', agent.currentStep),
          _Kv('Last completed', done == null ? null : '${done.title} (approved by CHE, ${cheAbsoluteTime(done.updatedAt)})'),
          _Kv('Next scheduled action', agent.nextScheduled),
          _Kv(
            'Blockers',
            blockers.isEmpty ? null : blockers.map((b) => '${b.state?.label ?? 'Blocked'}: ${b.text}${b.title.isEmpty ? '' : ' (${b.title})'}').join('\n'),
          ),
          _Kv('Last update', agent.lastUpdateAt == null ? null : '${cheAbsoluteTime(agent.lastUpdateAt)} · ${cheTimeAgo(agent.lastUpdateAt)}'),
          _Kv(
            'Last verified activity',
            agent.lastVerifiedAt == null ? null : '${cheTimeAgo(agent.lastVerifiedAt)} · ${cheAbsoluteTime(agent.lastVerifiedAt)}',
          ),
        ]),
      ),
    );
  }
}

class _TaskPanel extends StatelessWidget {
  const _TaskPanel({required this.task, this.agent});
  final CheConversationTask task;

  /// The agent that holds this task, shown as context only. Null when the record has no agent.
  final CheConversationAgent? agent;
  @override
  Widget build(BuildContext context) => Card(
        color: CheColors.surfaceHi,
        child: Padding(
          padding: const EdgeInsets.all(CheSpace.md),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SelectableText(task.title, style: CheType.title),
            const SizedBox(height: CheSpace.sm),
            _StatePill(state: task.state, raw: task.rawStatus),
            const SizedBox(height: CheSpace.xs),
            Text(task.reason, style: CheType.caption),
            const SizedBox(height: CheSpace.md),
            _Kv(
              'Agent',
              agent == null
                  ? task.partnerName
                  : '${agent!.name}${agent!.role.isEmpty ? '' : ' · ${agent!.role}'} · agent status: ${agent!.status?.label ?? 'No task recorded'}',
            ),
            _Kv('Created', cheAbsoluteTime(task.createdAt)),
            _Kv('Last update', cheAbsoluteTime(task.updatedAt)),
          ]),
        ),
      );
}

/// The parts of the work the Office does not record. Shown as "Not recorded" rather than left out.
class _EvidencePanel extends StatelessWidget {
  const _EvidencePanel({required this.messages});
  final List<CheConversationMessage> messages;
  @override
  Widget build(BuildContext context) {
    final evidence = [for (final m in messages) if (m.kind == 'evidence') m.text];
    return Card(
      color: CheColors.surfaceHi,
      child: Padding(
        padding: const EdgeInsets.all(CheSpace.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('EVIDENCE', style: CheType.overline.copyWith(color: CheColors.accent)),
          const SizedBox(height: CheSpace.sm),
          _Kv('Commits or PRs', evidence.isEmpty ? null : evidence.join('\n')),
          const _Kv('Tool calls', null),
          const _Kv('Files changed', null),
          const _Kv('Tests run', null),
        ]),
      ),
    );
  }
}

/// The record's own fields for one message, as label and value rows. A missing field reads "Not recorded".
List<(String, String?)> _detailRows(CheConversationMessage m) {
  final d = m.details;
  String? yesNo(Object? v) => v == null ? null : (v == true ? 'Yes' : 'No');
  final rows = <(String, String?)>[
    ('Stored status', m.taskRawStatus.isEmpty ? null : m.taskRawStatus),
    ('Task state', m.taskState?.label),
    ('Time recorded', cheAbsoluteTime(m.at)),
    if (d['time_note'] != null) ('Time note', '${d['time_note']}'),
    if (d['record_id'] != null) ('Record id', '${d['record_id']}'),
    if (d['stored_length'] != null)
      ('Stored request length', '${d['stored_length']} characters; stored limit ${d['stored_limit']}; cut when stored: ${yesNo(d['cut_when_stored'])}'),
    if (d['kind'] != null) ('Task kind', '${d['kind']}'),
    if (d['browse'] != null) ('Browsing task', yesNo(d['browse'])),
    if (d['use_computer'] != null) ('Computer task', yesNo(d['use_computer'])),
    if (d['office_job_id'] != null) ('Office job', '${d['office_job_id']}'),
    if (d['steering_version'] != null) ('Steering version', '${d['steering_version']}'),
    if (d['verified_by_che'] != null) ('Verified by CHE', yesNo(d['verified_by_che'])),
    if (d['revision_count'] != null) ('Revisions', '${d['revision_count']}'),
    if (d['from_provider'] != null || d['to_provider'] != null)
      ('Providers', '${d['from_provider'] ?? 'Not recorded'} → ${d['to_provider'] ?? 'Not recorded'}'),
    if (d['artifacts'] != null) ('Artifacts', '${d['artifacts']}'),
    if (d['citations'] != null) ('Citations', '${d['citations']}'),
    if (d['pr_number'] != null) ('PR', '#${d['pr_number']}'),
    if (d['pr_url'] != null) ('PR link', '${d['pr_url']}'),
    if (d['merge_commit_sha'] != null) ('Merge commit', '${d['merge_commit_sha']}'),
    if (d['stage'] != null) ('Office stage', '${d['stage']}'),
    if (d['job_goal'] != null) ('Office job goal', '${d['job_goal']}'),
    if (d['post_kind'] != null) ('Post type', '${d['post_kind']}'),
  ];
  final trail = d['provider_trail'];
  if (trail is List) {
    if (trail.isEmpty) {
      rows.add(('Provider attempts', 'None recorded'));
    } else {
      for (var i = 0; i < trail.length; i++) {
        final p = trail[i];
        if (p is Map) {
          rows.add((
            'Provider attempt ${i + 1}',
            '${p['provider'] ?? 'Not recorded'}${p['model'] == null ? '' : ' (${p['model']})'} · ${cheAbsoluteTime(DateTime.tryParse('${p['at'] ?? ''}'))}',
          ));
        }
      }
    }
  }
  return rows;
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({super.key, required this.message, this.onReadAloud, this.detailsOpen = false});
  final CheConversationMessage message;
  final void Function(String text)? onReadAloud;

  /// True when the owner opened this message's details by voice.
  final bool detailsOpen;

  @override
  Widget build(BuildContext context) {
    final m = message;
    final text = m.text.isEmpty ? 'No text recorded.' : m.text;
    return Semantics(
      container: true,
      label: '${m.seq}. ${m.kindLabel}. ${m.speaker} to ${m.to}. ${cheAbsoluteTime(m.at)}. $text',
      child: Card(
        color: CheColors.surfaceHi,
        margin: const EdgeInsets.only(bottom: CheSpace.sm),
        child: Padding(
          padding: const EdgeInsets.all(CheSpace.md),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${m.speaker} → ${m.to}', style: CheType.label)),
              Text(m.kindLabel, style: CheType.caption.copyWith(color: CheColors.accent)),
            ]),
            Text(cheAbsoluteTime(m.at), style: CheType.caption),
            if (m.taskTitle.isNotEmpty) ...[
              const SizedBox(height: CheSpace.xs),
              Text('Task: ${m.taskTitle}', style: CheType.caption),
            ],
            const SizedBox(height: CheSpace.sm),
            SelectableText(text, style: m.text.isEmpty ? CheType.bodyDim : CheType.body),
            const SizedBox(height: CheSpace.xs),
            Row(children: [
              if (m.taskState != null) _StatePill(state: m.taskState, raw: m.taskRawStatus),
              const Spacer(),
              if (onReadAloud != null && m.text.isNotEmpty)
                IconButton(
                  tooltip: 'Read this message aloud',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => onReadAloud!(m.text),
                  icon: Icon(Icons.volume_up_rounded, size: 20, color: CheColors.accent),
                ),
            ]),
            ExpansionTile(
              initiallyExpanded: detailsOpen,
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: CheSpace.sm),
              shape: const Border(),
              title: Text('Details', style: CheType.label, semanticsLabel: 'Details for message ${m.seq}'),
              children: [
                for (final (label, value) in _detailRows(m)) _Kv(label, value),
              ],
            ),
          ]),
        ),
      ),
    );
  }
}
