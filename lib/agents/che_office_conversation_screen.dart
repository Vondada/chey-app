// Full-screen Office conversation (owner rule, 2026-10-26). Opened from an agent's desk or from one of its tasks.
// Shows the agent's real state, then every recorded message in order, with exact untruncated text, search, filter
// groups and expandable details. Newest message at the bottom; the view opens scrolled there. The search box and
// filter groups stay fixed at the top. Passive: nothing here speaks on its own. Read aloud happens only when the
// owner taps a Read button.

import 'package:flutter/material.dart';

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

  @override
  void initState() {
    super.initState();
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
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _jumpToNewestSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _refresh() async {
    final load = widget.onRefresh;
    if (load == null || _refreshing) return;
    setState(() => _refreshing = true);
    try {
      final next = await load();
      if (!mounted) return;
      setState(() {
        _c = next;
        _error = null;
      });
      _jumpToNewestSoon();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  bool _matchesFilter(CheConversationMessage m) {
    final kinds = cheConversationFilters[_filter];
    return kinds == null || kinds.contains(m.kind);
  }

  @override
  Widget build(BuildContext context) {
    final visible = [
      for (final m in _c.messages)
        if (_matchesFilter(m) && cheConversationMatches(m, _search.text)) m,
    ];
    final agent = _c.agent;
    final title = agent == null ? 'Office task' : '${agent.name} · conversation';
    return Scaffold(
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (widget.onRefresh != null)
            IconButton(
              tooltip: 'Refresh conversation',
              onPressed: _refreshing ? null : _refresh,
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
                if (agent != null) _AgentPanel(agent: agent) else if (_c.task != null) _TaskPanel(task: _c.task!),
                const SizedBox(height: CheSpace.md),
                _EvidencePanel(messages: _c.messages),
                const SizedBox(height: CheSpace.md),
                if (_c.messages.isEmpty)
                  Text('No messages are recorded for this conversation yet.', style: CheType.bodyDim)
                else if (visible.isEmpty)
                  Text('No messages match this search and filter.', style: CheType.bodyDim),
                for (final m in visible) _MessageCard(message: m, onReadAloud: widget.onReadAloud),
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
  const _TaskPanel({required this.task});
  final CheConversationTask task;
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
            _Kv('Agent', task.partnerName),
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
  const _MessageCard({required this.message, this.onReadAloud});
  final CheConversationMessage message;
  final void Function(String text)? onReadAloud;

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
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: CheSpace.sm),
              shape: const Border(),
              title: Text('Details', style: CheType.label),
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
