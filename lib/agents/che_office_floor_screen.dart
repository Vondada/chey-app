// CHE Office floor: CHE and every agent at their desk, mirrored live from the
// backend Agent Runtime. Tap an agent to open their desk (profile, current
// task, history, responsibilities; message / reassign / upgrade / retire).
// Tap CHE to talk to her. "War Room" convenes a multi-agent project.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import 'che_agent_runtime.dart';
import 'che_office_world.dart';
import 'che_war_room_screen.dart';

class CheOfficeFloorScreen extends StatefulWidget {
  const CheOfficeFloorScreen({super.key, required this.client, this.onTalkToChe});

  final CheAgentRuntimeClient client;

  /// Opens CHE's chat (tapping CHE's own desk).
  final VoidCallback? onTalkToChe;

  @override
  State<CheOfficeFloorScreen> createState() => _CheOfficeFloorScreenState();
}

class _CheOfficeFloorScreenState extends State<CheOfficeFloorScreen> {
  late final CheAgentRuntimeController _runtime = CheAgentRuntimeController(widget.client)..addListener(_changed);

  int _worldLevel = 1;

  @override
  void initState() {
    super.initState();
    _runtime.start();
    unawaited(_loadWorldLevel());
  }

  Future<void> _loadWorldLevel() async {
    try {
      final level = await widget.client.officeWorldLevel();
      if (mounted) setState(() => _worldLevel = level);
    } catch (_) {
      // Default size until the server answers.
    }
  }

  Future<void> _setWorldLevel(int level) async {
    try {
      final saved = await widget.client.setOfficeWorldLevel(level);
      HapticFeedback.mediumImpact();
      if (mounted) setState(() => _worldLevel = saved);
      _snack(saved > 1 ? 'The Office is now size $saved of 3, with more room to work and hang out.' : 'The Office is back to its standard size.');
    } catch (e) {
      _snack('$e');
    }
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _openAgent(CheAgent agent) async {
    if (agent.isChe) {
      if (widget.onTalkToChe != null) {
        Navigator.of(context).pop();
        widget.onTalkToChe!();
      }
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      builder: (_) => _AgentDeskSheet(client: widget.client, agentId: agent.id, onChanged: _runtime.refresh),
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

  @override
  Widget build(BuildContext context) {
    final r = _runtime;
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: const Text('CHE Office'),
          actions: [
            IconButton(tooltip: 'Refresh', onPressed: r.refresh, icon: const Icon(Icons.refresh_rounded)),
            IconButton(tooltip: 'New agent', onPressed: _newAgent, icon: const Icon(Icons.person_add_alt_1_rounded)),
          ],
        ),
        body: SafeArea(
          top: false,
          child: RefreshIndicator(
            onRefresh: r.refresh,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl),
              children: [
                if (!r.loaded)
                  const Padding(padding: EdgeInsets.all(CheSpace.xxl), child: Center(child: CircularProgressIndicator()))
                else ...[
                  if (r.error != null) _Banner(text: r.error!, color: CheColors.warning),
                  CheOfficeFloor(
                    che: r.che,
                    agents: [for (final p in r.agents) p.agent],
                    onTapAgent: _openAgent,
                    onConvene: _convene,
                  ),
                  const SizedBox(height: CheSpace.sm),
                  if (r.che.task != null) Text('CHE: ${r.che.task}', maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption),
                  const SizedBox(height: CheSpace.lg),
                  Text('WAR ROOM', style: CheType.overline),
                  const SizedBox(height: CheSpace.sm),
                  if (r.meetings.isEmpty)
                    Text('No meetings yet. Convene the team when a project needs several specialties.', style: CheType.bodyDim)
                  else
                    for (final m in r.meetings) _MeetingTile(meeting: m, onTap: () => _openMeeting(m.id)),
                  const SizedBox(height: CheSpace.lg),
                  Text('OFFICE WORLD', style: CheType.overline),
                  const SizedBox(height: CheSpace.sm),
                  CheOfficeWorld(
                    che: r.che,
                    agents: r.agents,
                    level: _worldLevel,
                    onOpenAgent: _openAgent,
                    onUpgrade: _setWorldLevel,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
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
  const _MeetingTile({required this.meeting, required this.onTap});
  final CheMeetingSummary meeting;
  final VoidCallback onTap;
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
        title: Text(meeting.objective, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.label),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SizedBox(height: 4),
          Text('${meeting.statusLabel} • ${meeting.participantNames.join(', ')}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
          if (meeting.live) ...[
            const SizedBox(height: 6),
            LinearProgressIndicator(value: meeting.progress, color: amber, backgroundColor: CheColors.stroke),
          ],
        ]),
        trailing: const Icon(Icons.chevron_right_rounded),
      ),
    );
  }
}

// ─── Agent desk: profile, task, history, actions ────────────────────────

class _AgentDeskSheet extends StatefulWidget {
  const _AgentDeskSheet({required this.client, required this.agentId, required this.onChanged});
  final CheAgentRuntimeClient client;
  final String agentId;
  final Future<void> Function() onChanged;
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
                        Text(a.status.label + (a.task != null ? ' • ${a.task}' : ''),
                            maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: a.color)),
                        const SizedBox(height: CheSpace.xs),
                        Wrap(spacing: CheSpace.xs, children: [
                          _Pill(p.modelTier == 'strong' ? 'Upgraded engine' : 'Fast engine'),
                          if (p.temporary) const _Pill('Temporary'),
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
            for (final t in d.history) _TaskCard(task: t),
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
  const _TaskCard({required this.task});
  final CheAgentTask task;
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
        title: Text(task.task, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.label),
        subtitle: Text(label, style: CheType.caption.copyWith(color: color)),
        childrenPadding: const EdgeInsets.fromLTRB(CheSpace.lg, 0, CheSpace.lg, CheSpace.md),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
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
