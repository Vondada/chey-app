// CHE Office floor: CHE and every agent at their desk, mirrored live from the
// backend Agent Runtime. Tap an agent to open their desk (profile, current
// task, history, responsibilities; message / reassign / upgrade / retire).
// Tap CHE to talk to her. "War Room" convenes a multi-agent project.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import 'che_agent_runtime.dart';
import 'che_war_room_screen.dart';

/// Short, glanceable version of an agent's task or a meeting objective: the
/// first clause, cut at a word boundary. The full text stays one tap (or one
/// "read aloud") away.
String cheShortSummary(String text, {int max = 40}) {
  var t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final clause = RegExp(r'^(.{12,}?)[.;:!?\n]').firstMatch(t);
  if (clause != null) t = clause.group(1)!.trim();
  if (t.length <= max) return t;
  final cut = t.substring(0, max);
  final space = cut.lastIndexOf(' ');
  return '${(space > max ~/ 2 ? cut.substring(0, space) : cut).trimRight()}…';
}

class CheOfficeFloorScreen extends StatefulWidget {
  const CheOfficeFloorScreen({
    super.key,
    required this.client,
    this.onTalkToChe,
    this.onSpeak,
    this.embedded = false,
  });

  final CheAgentRuntimeClient client;

  /// Opens CHE's chat (tapping CHE's own desk).
  final VoidCallback? onTalkToChe;

  /// Reads text aloud in CHE's voice. Falls back to a VoiceOver announcement.
  final Future<void> Function(String text)? onSpeak;

  /// True when shown as the hub's Office tab (no app bar or back route).
  final bool embedded;

  @override
  State<CheOfficeFloorScreen> createState() => _CheOfficeFloorScreenState();
}

class _CheOfficeFloorScreenState extends State<CheOfficeFloorScreen> {
  late final CheAgentRuntimeController _runtime = CheAgentRuntimeController(widget.client)..addListener(_changed);

  @override
  void initState() {
    super.initState();
    _runtime.start();
  }

  @override
  void dispose() {
    _runtime.removeListener(_changed);
    _runtime.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _speak(String text) => cheReadAloud(context, text, widget.onSpeak);

  Future<void> _openAgent(CheAgent agent) async {
    if (agent.isChe) {
      if (widget.onTalkToChe != null) {
        if (!widget.embedded) Navigator.of(context).pop();
        widget.onTalkToChe!();
      }
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      builder: (_) => _AgentDeskSheet(
        client: widget.client,
        agentId: agent.id,
        onChanged: _runtime.refresh,
        onSpeak: widget.onSpeak,
      ),
    );
    await _runtime.refresh();
  }

  Future<void> _newAgent() async {
    final role = TextEditingController();
    final name = TextEditingController();
    final specialty = TextEditingController();
    final personality = TextEditingController();
    final task = TextEditingController();
    var temporary = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setLocal) => AlertDialog(
          backgroundColor: CheColors.surfaceHi,
          title: const Text('New Office agent'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: role, decoration: const InputDecoration(labelText: 'Role (required)', hintText: 'e.g. Research Partner')),
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Name (optional)')),
              TextField(controller: specialty, decoration: const InputDecoration(labelText: 'Specialty')),
              TextField(controller: personality, maxLines: 2, decoration: const InputDecoration(labelText: 'Personality')),
              TextField(controller: task, maxLines: 2, decoration: const InputDecoration(labelText: 'First task (optional)')),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: temporary,
                onChanged: (v) => setLocal(() => temporary = v),
                title: const Text('Temporary (retires after its task)'),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Hire')),
          ],
        ),
      ),
    );
    if (ok != true || role.text.trim().isEmpty) return;
    try {
      final agent = await widget.client.createAgent(
        role: role.text.trim(),
        name: name.text,
        specialty: specialty.text.trim(),
        personality: personality.text.trim(),
        temporary: temporary,
        task: task.text,
      );
      HapticFeedback.mediumImpact();
      _snack('${agent.name} joined the Office.');
    } catch (e) {
      _snack('$e');
    }
    await _runtime.refresh();
  }

  Future<void> _convene() async {
    final objective = TextEditingController();
    final selected = <String>{};
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setLocal) => AlertDialog(
          backgroundColor: CheColors.surfaceHi,
          title: const Text('Convene the War Room'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: objective,
                maxLines: 3,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'Objective', hintText: 'What should the team decide or plan?'),
              ),
              const SizedBox(height: CheSpace.md),
              Text(
                _runtime.agents.isEmpty
                    ? 'CHE will staff the specialists this needs.'
                    : 'Pick agents, or leave empty and CHE picks.',
                style: CheType.caption,
              ),
              const SizedBox(height: CheSpace.sm),
              Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
                for (final p in _runtime.agents)
                  FilterChip(
                    label: Text(p.agent.name),
                    selected: selected.contains(p.agent.id),
                    onSelected: (v) => setLocal(() => v ? selected.add(p.agent.id) : selected.remove(p.agent.id)),
                  ),
              ]),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Convene')),
          ],
        ),
      ),
    );
    if (ok != true || objective.text.trim().isEmpty) return;
    try {
      final meeting = await widget.client.convene(objective.text.trim(), agentIds: selected.toList());
      HapticFeedback.mediumImpact();
      await _runtime.refresh();
      await _openMeeting(meeting.summary.id);
    } catch (e) {
      _snack('$e');
    }
  }

  Future<void> _openMeeting(String id) async {
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheWarRoomScreen(client: widget.client, meetingId: id),
    ));
    await _runtime.refresh();
  }

  String _officeSummary() {
    final r = _runtime;
    final working = r.agents.where((p) => p.working).length;
    final parts = <String>[
      r.agents.isEmpty
          ? 'The Office is empty. Ask CHE to build a team.'
          : '${r.agents.length} agents, $working working.',
      if (r.che.task != null) 'CHE: ${r.che.task}.',
      for (final p in r.agents)
        '${p.agent.name}, ${p.agent.role}: ${p.agent.task?.isNotEmpty == true ? p.agent.task : p.agent.status.label}.',
      if (r.meetings.isNotEmpty) '${r.meetings.length} War Room meetings.',
    ];
    return parts.join(' ');
  }

  List<Widget> _content(BuildContext context) {
    final r = _runtime;
    return [
      if (!r.loaded)
        const Padding(padding: EdgeInsets.all(CheSpace.xxl), child: Center(child: CircularProgressIndicator()))
      else ...[
        if (r.error != null) _Banner(text: r.error!, color: CheColors.warning),
        if (widget.embedded) ...[
          _CompanyBoard(today: r.today, totalAgents: r.agents.length + 1),
          const SizedBox(height: CheSpace.md),
        ],
        CheOfficeFloor(
          che: r.che,
          agents: [for (final p in r.agents) p.agent],
          onTapAgent: _openAgent,
          onConvene: _convene,
        ),
        const SizedBox(height: CheSpace.sm),
        if (r.che.task != null)
          Row(children: [
            Expanded(
              child: Text('CHE: ${cheShortSummary(r.che.task!)}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
            ),
            _ReadAloudButton(label: 'Read CHE\'s task aloud', onPressed: () => _speak('CHE is on: ${r.che.task}')),
          ]),
        const SizedBox(height: CheSpace.lg),
        Text('WAR ROOM', style: CheType.overline),
        const SizedBox(height: CheSpace.sm),
        if (r.meetings.isEmpty)
          Text('No meetings yet. Convene the team when a project needs several specialties.', style: CheType.bodyDim)
        else
          for (final m in r.meetings)
            _MeetingTile(
              meeting: m,
              onTap: () => _openMeeting(m.id),
              onReadAloud: () => _speak('${m.statusLabel}. ${m.objective}. With ${m.participantNames.join(', ')}.'),
            ),
      ],
    ];
  }

  List<Widget> _actions() => [
        Semantics(
          button: true,
          label: 'Read the whole Office to me',
          excludeSemantics: true,
          child: TextButton.icon(
            onPressed: () => _speak(_officeSummary()),
            icon: const Icon(Icons.volume_up_rounded),
            label: const Text('Read to me'),
          ),
        ),
        IconButton(tooltip: 'Refresh', onPressed: _runtime.refresh, icon: const Icon(Icons.refresh_rounded)),
        IconButton(tooltip: 'New agent', onPressed: _newAgent, icon: const Icon(Icons.person_add_alt_1_rounded)),
      ];

  @override
  Widget build(BuildContext context) {
    final r = _runtime;
    final list = RefreshIndicator(
      onRefresh: r.refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
        children: _content(context),
      ),
    );
    if (widget.embedded) {
      return Theme(
        data: CheTheme.dark(),
        child: Material(
          color: CheColors.bg,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.xs, 0),
              child: Row(children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text('CHE Office', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.title),
                  ),
                ),
                ..._actions(),
              ]),
            ),
            Expanded(child: list),
          ]),
        ),
      );
    }
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: const Text('CHE Office'),
          actions: _actions(),
        ),
        body: SafeArea(top: false, child: list),
      ),
    );
  }
}

/// Speaks [text] with CHE's voice when available, else via VoiceOver.
Future<void> cheReadAloud(BuildContext context, String text, Future<void> Function(String text)? speak) async {
  HapticFeedback.selectionClick();
  if (speak != null) {
    await speak(text);
    return;
  }
  final view = View.maybeOf(context);
  if (view != null) {
    await SemanticsService.sendAnnouncement(view, text, Directionality.of(context));
  }
}

class _CompanyBoard extends StatelessWidget {
  const _CompanyBoard({required this.today, required this.totalAgents});
  final CheOfficeToday? today;
  final int totalAgents;
  @override
  Widget build(BuildContext context) {
    final t = today;
    final money = ((t?.netCents ?? 0) / 100).toStringAsFixed(2);
    return RepaintBoundary(child: Container(
      width: double.infinity, padding: const EdgeInsets.all(CheSpace.md),
      decoration: BoxDecoration(color: CheColors.surface, borderRadius: BorderRadius.circular(CheRadius.lg), border: Border.all(color: CheColors.stroke)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('LA AGENCIA • TODAY', style: CheType.overline.copyWith(color: CheColors.accent)),
        const SizedBox(height: 8),
        Text('Today earned: \$money', style: CheType.label),
        Text('Agents working: ${t?.agentsWorking ?? 0}/$totalAgents', style: CheType.label),
        Text('Stripe: ${t?.stripeConnected == true ? 'connected' : 'not connected'}', style: CheType.caption),
        const SizedBox(height: 8),
        Text('Today built', style: CheType.label),
        Text((t?.shipped.isNotEmpty ?? false) ? t!.shipped.take(3).map((e) => '${e['agent']}: ${e['task']}').join(' • ') : 'Nothing shipped yet.', maxLines: 3, overflow: TextOverflow.ellipsis, style: CheType.caption),
        if ((t?.blockers.isNotEmpty ?? false)) Text('Blocked: ${t!.blockers.length}', style: CheType.caption.copyWith(color: CheColors.warning)),
      ]),
    ));
  }
}
class _ReadAloudButton extends StatelessWidget {
  const _ReadAloudButton({required this.label, required this.onPressed});
  final String label;
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: label,
        visualDensity: VisualDensity.compact,
        onPressed: onPressed,
        icon: const Icon(Icons.volume_up_rounded, size: 20, color: CheColors.accent),
      );
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.color});
  final String text;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: CheSpace.md),
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Text(text, style: CheType.label),
      );
}

class _MeetingTile extends StatelessWidget {
  const _MeetingTile({required this.meeting, required this.onTap, required this.onReadAloud});
  final CheMeetingSummary meeting;
  final VoidCallback onTap;
  final VoidCallback onReadAloud;
  @override
  Widget build(BuildContext context) {
    const amber = Color(0xFFE8B04A);
    return Card(
      color: CheColors.surfaceHi,
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(CheRadius.md),
        side: BorderSide(color: meeting.live ? amber : CheColors.stroke),
      ),
      child: ListTile(
        onTap: onTap,
        leading: Icon(meeting.live ? Icons.groups_rounded : Icons.fact_check_rounded, color: meeting.live ? amber : CheColors.textDim),
        title: Text(cheShortSummary(meeting.objective),
            maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label, semanticsLabel: meeting.objective),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SizedBox(height: 4),
          Text('${meeting.statusLabel} • ${meeting.participantNames.join(', ')}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
          if (meeting.live) ...[
            const SizedBox(height: 6),
            LinearProgressIndicator(value: meeting.progress, color: amber, backgroundColor: CheColors.stroke),
          ],
        ]),
        trailing: _ReadAloudButton(label: 'Read this meeting aloud', onPressed: onReadAloud),
      ),
    );
  }
}

// ─── Agent desk: profile, task, history, actions ────────────────────────

class _AgentDeskSheet extends StatefulWidget {
  const _AgentDeskSheet({required this.client, required this.agentId, required this.onChanged, this.onSpeak});
  final CheAgentRuntimeClient client;
  final String agentId;
  final Future<void> Function() onChanged;
  final Future<void> Function(String text)? onSpeak;
  @override
  State<_AgentDeskSheet> createState() => _AgentDeskSheetState();
}

class _AgentDeskSheetState extends State<_AgentDeskSheet> {
  CheAgentDetail? _detail;
  String? _error;
  bool _working = false;
  final _message = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await widget.client.agent(widget.agentId);
      if (!mounted) return;
      setState(() {
        _detail = d;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _run(Future<void> Function() action, {bool close = false}) async {
    setState(() => _working = true);
    try {
      await action();
      HapticFeedback.selectionClick();
      await widget.onChanged();
      if (close) {
        if (mounted) Navigator.of(context).pop();
        return;
      }
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
    if (mounted) setState(() => _working = false);
  }

  Future<void> _reassign(CheAgentProfile p) async {
    final text = TextEditingController(text: p.responsibilities.join('\n'));
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: Text('Reassign ${p.agent.name}'),
        content: TextField(
          controller: text,
          maxLines: 6,
          decoration: const InputDecoration(labelText: 'Responsibilities (one per line)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true) return;
    final list = text.text.split('\n').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
    await _run(() => widget.client.patchAgent(p.agent.id, {'action': 'reassign', 'responsibilities': list}));
  }

  Future<void> _retire(CheAgentProfile p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: Text('Retire ${p.agent.name}?'),
        content: const Text('Queued tasks are cancelled and anything they owned goes back to CHE.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: CheColors.danger),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Retire'),
          ),
        ],
      ),
    );
    if (ok == true) await _run(() => widget.client.patchAgent(p.agent.id, {'action': 'retire'}), close: true);
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      maxChildSize: 0.95,
      builder: (context, scroll) {
        if (d == null) {
          return Center(
            child: _error == null
                ? const CircularProgressIndicator()
                : Padding(padding: const EdgeInsets.all(CheSpace.xl), child: Text(_error!, style: CheType.bodyDim)),
          );
        }
        final p = d.profile;
        final a = p.agent;
        return ListView(
          controller: scroll,
          padding: EdgeInsets.fromLTRB(
              CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl + MediaQuery.viewInsetsOf(context).bottom),
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(CheRadius.lg),
              child: CheRoomBackdrop(
                room: CheRoom.office,
                scrim: 0.5,
                child: Padding(
                  padding: const EdgeInsets.all(CheSpace.md),
                  child: Row(children: [
                    CheMiniPerson(agent: a, size: 84, showDesk: true),
                    const SizedBox(width: CheSpace.md),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.title.copyWith(color: Colors.white)),
                        Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white70)),
                        const SizedBox(height: CheSpace.xs),
                        Text(a.status.label + (a.task != null ? ' • ${cheShortSummary(a.task!)}' : ''),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: CheType.caption.copyWith(color: a.color),
                            semanticsLabel: a.status.label + (a.task != null ? ', ${a.task}' : '')),
                        const SizedBox(height: CheSpace.xs),
                        Wrap(spacing: CheSpace.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
                          _Pill(p.modelTier == 'strong' ? 'Upgraded engine' : 'Fast engine'),
                          if (p.temporary) const _Pill('Temporary'),
                          _ReadAloudButton(
                            label: 'Read ${a.name} aloud',
                            onPressed: () => cheReadAloud(
                              context,
                              '${a.name}, ${a.role}. ${a.status.label}.'
                              '${a.task != null ? ' Working on: ${a.task}.' : ''}'
                              '${p.responsibilities.isNotEmpty ? ' Responsible for: ${p.responsibilities.join('; ')}.' : ''}',
                              widget.onSpeak,
                            ),
                          ),
                        ]),
                      ]),
                    ),
                  ]),
                ),
              ),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: CheSpace.sm), child: _Banner(text: _error!, color: CheColors.warning)),
            const SizedBox(height: CheSpace.md),
            if (a.specialty.isNotEmpty) _Section('SPECIALTY', a.specialty),
            _Section('PERSONALITY', a.personality),
            if (p.mission.isNotEmpty) _Section('MISSION', p.mission),
            _Section('RESPONSIBILITIES', p.responsibilities.isEmpty ? 'None assigned yet.' : p.responsibilities.map((s) => '• $s').join('\n')),
            const SizedBox(height: CheSpace.sm),
            Text('MESSAGE ${a.name.toUpperCase()}', style: CheType.overline),
            const SizedBox(height: CheSpace.xs),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _message,
                  minLines: 1,
                  maxLines: 4,
                  decoration: InputDecoration(hintText: 'Give ${a.name} a task. CHE reviews the result.'),
                ),
              ),
              IconButton(
                tooltip: 'Send task',
                onPressed: _working
                    ? null
                    : () {
                        final t = _message.text.trim();
                        if (t.isEmpty) return;
                        _message.clear();
                        _run(() => widget.client.assignTask(a.id, t));
                      },
                icon: const Icon(Icons.send_rounded, color: CheColors.accent),
              ),
            ]),
            const SizedBox(height: CheSpace.md),
            Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
              OutlinedButton.icon(
                onPressed: _working ? null : () => _reassign(p),
                icon: const Icon(Icons.assignment_ind_rounded, size: 18),
                label: const Text('Reassign'),
              ),
              OutlinedButton.icon(
                onPressed: _working
                    ? null
                    : () => _run(() => widget.client.patchAgent(a.id, {'action': p.modelTier == 'strong' ? 'downgrade' : 'upgrade'})),
                icon: Icon(p.modelTier == 'strong' ? Icons.speed_rounded : Icons.upgrade_rounded, size: 18),
                label: Text(p.modelTier == 'strong' ? 'Use fast engine' : 'Upgrade'),
              ),
              if (p.temporary)
                OutlinedButton.icon(
                  onPressed: _working ? null : () => _run(() => widget.client.patchAgent(a.id, {'action': 'keep'})),
                  icon: const Icon(Icons.push_pin_rounded, size: 18),
                  label: const Text('Keep long-term'),
                ),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: CheColors.danger),
                onPressed: _working ? null : () => _retire(p),
                icon: const Icon(Icons.logout_rounded, size: 18),
                label: const Text('Retire'),
              ),
            ]),
            const SizedBox(height: CheSpace.lg),
            Row(children: [
              Expanded(child: Text('WORK HISTORY', style: CheType.overline)),
              IconButton(tooltip: 'Refresh', onPressed: _load, icon: const Icon(Icons.refresh_rounded, size: 18)),
            ]),
            if (d.history.isEmpty) Text('No tasks yet.', style: CheType.bodyDim),
            for (final t in d.history)
              _TaskCard(
                task: t,
                onReadAloud: () => cheReadAloud(
                  context,
                  '${t.task}. ${t.result.isNotEmpty ? t.result : ''} ${t.cheReview.isNotEmpty ? 'CHE review: ${t.cheReview}' : ''}',
                  widget.onSpeak,
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CheRadius.pill),
          border: Border.all(color: Colors.white24),
        ),
        child: Text(text, style: CheType.caption.copyWith(color: Colors.white70)),
      );
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.body);
  final String title;
  final String body;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: CheType.overline),
          const SizedBox(height: CheSpace.xs),
          SelectableText(body, style: CheType.body),
        ]),
      );
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.task, required this.onReadAloud});
  final CheAgentTask task;
  final VoidCallback onReadAloud;
  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (task.status) {
      'queued' => ('Queued', CheColors.textDim),
      'running' => ('Working', CheColors.accent),
      'reviewing' => ('CHE reviewing', CheColors.accentAlt),
      'complete' => task.verifiedByChe ? ('Approved by CHE', CheColors.success) : ('Needs work', CheColors.warning),
      'failed' => ('Failed', CheColors.danger),
      'cancelled' => ('Cancelled', CheColors.textFaint),
      _ => (task.status, CheColors.textDim),
    };
    return Card(
      color: CheColors.surfaceHi,
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      child: ExpansionTile(
        shape: const Border(),
        title: Text(cheShortSummary(task.task),
            maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label, semanticsLabel: task.task),
        subtitle: Row(children: [
          Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: color))),
          _ReadAloudButton(label: 'Read this task aloud', onPressed: onReadAloud),
        ]),
        childrenPadding: const EdgeInsets.fromLTRB(CheSpace.lg, 0, CheSpace.lg, CheSpace.md),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (task.task.length > 40) ...[
            SelectableText(task.task, style: CheType.bodyDim),
            const SizedBox(height: CheSpace.sm),
          ],
          if (task.result.isNotEmpty) SelectableText(task.result, style: CheType.body),
          if (task.cheReview.isNotEmpty) ...[
            const SizedBox(height: CheSpace.sm),
            Text('CHE REVIEW', style: CheType.overline),
            SelectableText(task.cheReview, style: CheType.bodyDim),
          ],
          if (task.error.isNotEmpty) Text(task.error, style: CheType.caption.copyWith(color: CheColors.danger)),
        ],
      ),
    );
  }
}
