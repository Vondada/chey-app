// CHE Office floor: CHE and every agent at their desk, mirrored live from the
// backend Agent Runtime. Tap an agent (including CHE) to open their desk
// (profile, current task, history, responsibilities; message / reassign /
// upgrade / retire). CHE's desk also offers Talk and a request field that
// queues work through her Office goal API. "War Room" convenes a multi-agent
// project.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import 'che_agent_runtime.dart';
import 'che_office_store.dart';
import 'che_war_room_screen.dart';
import '../widgets/che_native_scene_world.dart';

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

  /// Opens CHE's chat from her desk sheet (Talk to CHE).
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

  /// One store for the floor: desks update individually, the plan only
  /// rebuilds when desks are added or removed.
  final CheOfficeStore _store = CheOfficeStore();
  CheOfficeToday? _lastBoard;
  Future<void> _speech = Future<void>.value();
  String _filter = 'All'; // All | Research | Trading | Content

  // Flat floor plan kept as a fallback when the WebView 3D surface fails.
  late final Widget _floorPlan = CheOfficeFloorPlan(
    store: _store,
    onTapDesk: _openDesk,
    onWarRoom: _warRoom,
  );
  bool _useFlatPlan = false;

  @override
  void initState() {
    super.initState();
    _runtime.start();
  }

  @override
  void dispose() {
    _runtime.removeListener(_changed);
    _runtime.dispose();
    _store.dispose();
    super.dispose();
  }

  void _changed() {
    final r = _runtime;
    _store.setRoster(r.che, [for (final p in r.agents) p.agent]);
    _store.setMeetings(r.meetings);
    if (!identical(r.today, _lastBoard)) {
      _lastBoard = r.today;
      _store.setBoard(r.today);
      // CHE says new blockers without being asked (deduped on the server).
      for (final line in _store.takeAnnouncements()) {
        _speech = _speech.then((_) => _announce(line));
        _snack(line);
      }
    }
    if (mounted) setState(() {});
  }

  Future<void> _announce(String line) async {
    if (!mounted) return;
    try {
      await _speak(line);
    } catch (_) {
      // Speech failing must not stop the next announcement.
    }
  }

  void _openDesk(String id) {
    final view = _store.desk(id)?.value;
    if (view != null) unawaited(_openAgent(view.agent));
  }

  /// The War Room on the floor plan: opens the live meeting if there is one,
  /// otherwise convenes a new one.
  void _warRoom() {
    final live = _runtime.meetings.where((m) => m.live).toList();
    if (live.isNotEmpty) {
      unawaited(_openMeeting(live.first.id));
    } else {
      unawaited(_convene());
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _speak(String text) => cheReadAloud(context, text, widget.onSpeak);

  Future<void> _openAgent(CheAgent agent) async {
    final talk = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      builder: (_) => _AgentDeskSheet(
        client: widget.client,
        agentId: agent.id,
        agentIds: agent.isChe
            ? const ['che']
            : [
                for (final p in _runtime.agents) p.agent.id,
              ],
        onChanged: () async {
          await _runtime.refresh();
          await _runtime.refreshBoard();
        },
        onSpeak: widget.onSpeak,
        onTalkToChe: agent.isChe ? widget.onTalkToChe : null,
      ),
    );
    if (talk == true && agent.isChe && widget.onTalkToChe != null) {
      if (!widget.embedded && mounted && Navigator.of(context).canPop()) {
        Navigator.of(context).pop();
      }
      widget.onTalkToChe!();
      return;
    }
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


  List<CheSceneEntity> _officeSceneEntities() {
    CheSceneEntity entity(CheAgent agent) => CheSceneEntity(
          id: agent.id,
          label: agent.name,
          description:
              '${agent.role}. ${agent.task?.isNotEmpty == true ? agent.task : agent.status.label}.',
          color: agent.color,
          state: agent.status.name,
          appearance: agent.appearance,
        );
    return [
      entity(_runtime.che),
      for (final p in _runtime.agents) entity(p.agent),
    ];
  }

  Widget _officeStage() {
    if (_useFlatPlan || !_runtime.loaded) return _floorPlan;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ValueListenableBuilder<CheSceneQuality>(
          valueListenable: CheSceneQualityStore.value,
          builder: (context, quality, _) => CheNativeSceneWorld(
            mode: CheSceneMode.office,
            quality: quality,
            entities: _officeSceneEntities(),
            height: 420,
            semanticsLabel: 'Immersive Office. Real agent state only.',
            onEntityTap: (id) {
              if (id.toLowerCase() == 'che') {
                if (widget.onTalkToChe != null) {
                  if (!widget.embedded) Navigator.of(context).pop();
                  widget.onTalkToChe!();
                }
                return;
              }
              _openDesk(id);
            },
          ),
        ),
        Wrap(
          alignment: WrapAlignment.end,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            const CheSceneQualityButton(),
            TextButton(
              onPressed: () => setState(() => _useFlatPlan = true),
              child: const Text('Flat floor plan'),
            ),
          ],
        ),
      ],
    );
  }

  String _officeSummary() {
    final r = _runtime;
    final working = r.agents.where((p) => p.working).length;
    final parts = <String>[
      r.agents.isEmpty
          ? 'The Office is empty. Ask CHE to build a team.'
          : '${r.agents.length} agents, $working working.',
      if (r.che.task != null) 'CHE: ${r.che.task}.',
      if (r.codingJob != null) 'Coding job: ${r.codingJob!.speech}',
      for (final p in r.agents)
        '${p.agent.name}, ${p.agent.role}: ${p.agent.task?.isNotEmpty == true ? p.agent.task : p.agent.status.label}.',
      if (r.meetings.isNotEmpty) '${r.meetings.length} War Room meetings.',
    ];
    return parts.join(' ');
  }

  List<Widget> _content(BuildContext context) {
    final r = _runtime;
    final agents = _filteredAgents(r);
    return [
      if (!r.loaded)
        const Padding(padding: EdgeInsets.all(CheSpace.xxl), child: Center(child: CircularProgressIndicator()))
      else ...[
        if (r.error != null) _Banner(text: r.error!, color: CheColors.warning),
        // Voice actions (mockup 05)
        CheVoiceActionList(
          horizontal: true,
          actions: [
            CheVoiceAction(
              number: 1,
              label: 'Office status',
              icon: Icons.mic_rounded,
              onTap: () => _speak('${cheOfficeBoardSpeech(r.today, r.connection)} ${_officeSummary()}'),
              semantics: '1. Office status',
            ),
            CheVoiceAction(
              number: 2,
              label: 'Find an agent',
              icon: Icons.groups_rounded,
              onTap: () {
                HapticFeedback.selectionClick();
                // Scroll focus: agent list is below; announce count.
                _speak(
                  agents.isEmpty
                      ? 'No agents match this filter.'
                      : '${agents.length} agents in $_filter. ${agents.map((p) => p.agent.name).join(', ')}.',
                );
              },
              semantics: '2. Find an agent',
            ),
            CheVoiceAction(
              number: 3,
              label: 'War Room',
              icon: Icons.hub_rounded,
              onTap: _warRoom,
              semantics: '3. War Room',
            ),
          ],
        ),
        const SizedBox(height: CheSpace.md),
        _officeStage(),
        const SizedBox(height: CheSpace.sm),
        if (r.codingJob != null) ...[
          CheCodingJobCard(
            status: r.codingJob!,
            onReadAloud: () => _speak(r.codingJob!.speech),
          ),
          const SizedBox(height: CheSpace.sm),
        ],
        if (r.che.task != null)
          Row(children: [
            Expanded(
              child: Text('CHE: ${cheShortSummary(r.che.task!)}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
            ),
            _ReadAloudButton(label: 'Read CHE\'s task aloud', onPressed: () => _speak('CHE is on: ${r.che.task}')),
          ]),
        const SizedBox(height: CheSpace.lg),
        Text('YOUR CREW', style: CheType.overline.copyWith(color: CheColors.accent)),
        const SizedBox(height: CheSpace.sm),
        _FilterPills(
          selected: _filter,
          onChanged: (f) {
            HapticFeedback.selectionClick();
            setState(() => _filter = f);
          },
        ),
        const SizedBox(height: CheSpace.md),
        if (agents.isEmpty)
          Text(
            _filter == 'All'
                ? 'No agents yet. Ask CHE to staff the Office.'
                : 'No $_filter agents right now.',
            style: CheType.bodyDim,
          )
        else
          for (final p in agents)
            Padding(
              padding: const EdgeInsets.only(bottom: CheSpace.sm),
              child: _AgentListCard(
                agent: p.agent,
                onTap: () => _openDesk(p.agent.id),
                onReadAloud: () => _speak(
                  '${p.agent.name}, ${p.agent.role}. ${p.agent.status.label}. '
                  '${p.agent.task?.isNotEmpty == true ? p.agent.task : p.agent.specialty}',
                ),
              ),
            ),
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
        const SizedBox(height: CheSpace.lg),
        Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
          OutlinedButton.icon(
            onPressed: _giveGoal,
            icon: const Icon(Icons.flag_rounded, size: 18),
            label: const Text('Give the Office a goal'),
          ),
          OutlinedButton.icon(
            onPressed: _standDown,
            icon: const Icon(Icons.pause_circle_rounded, size: 18),
            label: const Text('Stand down the Office'),
          ),
        ]),
        const SizedBox(height: CheSpace.md),
        CheOfficeBoard(today: r.today, onReadAloud: () => _speak(cheOfficeBoardSpeech(r.today, r.connection))),
      ],
    ];
  }

  List<CheAgentProfile> _filteredAgents(CheAgentRuntimeController r) {
    final all = r.agents;
    if (_filter == 'All') return all;
    bool match(CheAgent a) {
      final hay = '${a.role} ${a.specialty} ${a.name}'.toLowerCase();
      return switch (_filter) {
        'Research' => hay.contains('research') || hay.contains('atlas') || hay.contains('sourc') || hay.contains('intel'),
        'Trading' => hay.contains('trad') || hay.contains('financ') || hay.contains('market') || hay.contains('sage') || hay.contains('stripe'),
        'Content' => hay.contains('content') || hay.contains('social') || hay.contains('lyra') || hay.contains('copy') || hay.contains('iris') || hay.contains('ad '),
        _ => true,
      };
    }
    return [for (final p in all) if (match(p.agent)) p];
  }

  /// Reports an action's real outcome: spoken, shown as a banner, and felt.
  Future<void> _report(String text, {required bool ok}) async {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    _snack(text);
    await _speak(text);
  }

  Future<void> _giveGoal() async {
    final goal = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: const Text('Give the Office a goal'),
        content: TextField(
          controller: goal,
          autofocus: true,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'Goal',
            hintText: 'CHE splits it into jobs for Nova, Atlas, Mira, Knox, Sage, Lyra and Iris.',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Send to CHE')),
        ],
      ),
    );
    if (ok != true || goal.text.trim().isEmpty) return;
    try {
      final reply = await widget.client.officeGoal(goal.text.trim());
      await _runtime.refresh();
      await _runtime.refreshBoard();
      await _report(reply, ok: true);
    } catch (e) {
      await _report('CHE here. The goal did not reach the Office: $e', ok: false);
    }
  }

  Future<void> _standDown() async {
    try {
      final reply = await widget.client.standDown();
      await _runtime.refresh();
      await _report(reply, ok: true);
    } catch (e) {
      await _report('CHE here. The Office did not stand down: $e', ok: false);
    }
  }

  List<Widget> _actions() => [
        Semantics(
          button: true,
          label: 'Read the whole Office to me',
          excludeSemantics: true,
          child: TextButton.icon(
            onPressed: () => _speak('${cheOfficeBoardSpeech(_runtime.today, _runtime.connection)} ${_officeSummary()}'),
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
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('The Office', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.title),
                        Text(
                          'Your team. Real work. Real results.',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: CheType.caption,
                        ),
                      ],
                    ),
                  ),
                ),
                ..._actions(),
              ]),
            ),
            CheOfficeHeader(today: r.today, connection: r.connection),
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
          title: const Text('The Office'),
          actions: _actions(),
        ),
        body: SafeArea(
          top: false,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            CheOfficeHeader(today: r.today, connection: r.connection),
            Expanded(child: list),
          ]),
        ),
      ),
    );
  }
}

/// Visible, VoiceOver-live mirror of the real OpenCode runtime state.
class CheCodingJobCard extends StatelessWidget {
  const CheCodingJobCard({
    super.key,
    required this.status,
    required this.onReadAloud,
  });

  final CheCodingJobStatus status;
  final VoidCallback onReadAloud;

  @override
  Widget build(BuildContext context) {
    final color = switch (status.state) {
      'merged' || 'no_change' => CheColors.success,
      'review_rejected' || 'tests_failed' || 'rolled_back' || 'blocked' => CheColors.danger,
      'reviewing' || 'pr_open' => CheColors.accent,
      _ => CheColors.warning,
    };
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'CHE coding job. ${status.label}. ${status.speech}',
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: color.withValues(alpha: 0.65)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.code_rounded, color: color),
            const SizedBox(width: CheSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('CHE CODING · ${status.label.toUpperCase()}',
                      style: CheType.overline.copyWith(color: color)),
                  const SizedBox(height: 2),
                  Text(status.speech, style: CheType.caption),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Read coding status',
              onPressed: onReadAloud,
              icon: const Icon(Icons.volume_up_rounded),
            ),
          ],
        ),
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

/// Always-visible Office header: built today, earned today, agents working,
/// connection, and Stripe totals (or an explicit \$0.00 without Stripe).
class CheOfficeHeader extends StatelessWidget {
  const CheOfficeHeader({super.key, required this.today, required this.connection});
  final CheOfficeToday? today;
  final CheOfficeConnection connection;

  @override
  Widget build(BuildContext context) {
    final lines = cheOfficeHeaderLines(today, connection);
    final color = switch (connection) {
      CheOfficeConnection.live => CheColors.success,
      CheOfficeConnection.reconnecting => CheColors.warning,
      CheOfficeConnection.down => CheColors.danger,
    };
    return RepaintBoundary(
      child: Semantics(
        container: true,
        liveRegion: true,
        label: 'Office header. ${lines.join('. ')}.',
        excludeSemantics: true,
        child: Container(
          width: double.infinity,
          margin: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.xs),
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.sm),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.md),
            border: Border.all(color: color.withValues(alpha: 0.6)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(spacing: CheSpace.md, runSpacing: 2, children: [
              for (final line in lines.take(3)) Text(line, style: CheType.label),
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.circle, size: 10, color: color),
                const SizedBox(width: 4),
                Text(lines[3], style: CheType.label.copyWith(color: color)),
              ]),
            ]),
            const SizedBox(height: 2),
            Text(lines[4], style: CheType.caption),
            if (lines.length > 5) ...[
              const SizedBox(height: 2),
              Text(lines[5], style: CheType.caption.copyWith(color: CheColors.warning)),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Today's board: started, finished, Stripe today, blockers, stalled.
class CheOfficeBoard extends StatelessWidget {
  const CheOfficeBoard({super.key, required this.today, required this.onReadAloud});
  final CheOfficeToday? today;
  final VoidCallback onReadAloud;

  @override
  Widget build(BuildContext context) {
    final t = today;
    String rows(List<Map<String, dynamic>> items, String empty, String Function(Map<String, dynamic>) line) =>
        items.isEmpty ? empty : items.take(5).map(line).join('\n');
    final stripe = t == null || !t.stripeConnected
        ? '\$0.00 · Stripe not connected'
        : 'Charges ${cheDollars(t.chargesCents)} · Refunds ${cheDollars(t.refundsCents)} · Net ${cheDollars(t.netCents)}';
    Widget section(String title, String body, {Color? color}) => Padding(
          padding: const EdgeInsets.only(top: CheSpace.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: CheType.overline),
            Text(body, style: CheType.caption.copyWith(color: color)),
          ]),
        );
    return RepaintBoundary(
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('LA AGENCIA • TODAY', style: CheType.overline.copyWith(color: CheColors.accent))),
            _ReadAloudButton(label: 'Read this Office to me', onPressed: onReadAloud),
          ]),
          section('STARTED TODAY (${t?.startedToday ?? 0})',
              rows(t?.started ?? const [], 'Nothing started yet.', (e) => '${e['agent']}: ${e['task']} (${e['status']})')),
          section('FINISHED TODAY (${t?.builtToday ?? 0})',
              rows(t?.shipped ?? const [], 'Nothing finished yet.', (e) => '${e['agent']}: ${e['task']}')),
          section('STRIPE TODAY', stripe),
          section('BLOCKERS (${t?.blockers.length ?? 0})',
              rows(t?.blockers ?? const [], 'No blockers.', (e) => '${e['agent']}: ${e['detail']}'),
              color: (t?.blockers.isNotEmpty ?? false) ? CheColors.warning : null),
          section('STALLED (${t?.stalled.length ?? 0})',
              rows(t?.stalled ?? const [], 'Nothing stalled.', (e) => '${e['agent']}: ${e['task']} (${e['detail']})'),
              color: (t?.stalled.isNotEmpty ?? false) ? CheColors.warning : null),
        ]),
      ),
    );
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


class _FilterPills extends StatelessWidget {
  const _FilterPills({required this.selected, required this.onChanged});
  final String selected;
  final ValueChanged<String> onChanged;
  static const filters = ['All', 'Research', 'Trading', 'Content'];

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (var i = 0; i < filters.length; i++) ...[
            if (i > 0) const SizedBox(width: CheSpace.sm),
            _FilterPill(
              label: filters[i],
              selected: selected == filters[i],
              onTap: () => onChanged(filters[i]),
            ),
          ],
        ],
      ),
    );
  }
}

class _FilterPill extends StatelessWidget {
  const _FilterPill({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: '$label filter',
      excludeSemantics: true,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: CheMotion.fast,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? CheColors.accent : CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.pill),
            border: Border.all(
              color: selected ? CheColors.accent : CheColors.strokeHi,
            ),
            boxShadow: selected
                ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.35), blurRadius: 12)]
                : null,
          ),
          child: Text(
            label,
            style: CheType.label.copyWith(
              color: selected ? const Color(0xFF03120F) : CheColors.text,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}

/// Large-chibi agent row matching mockup 03 (not postage-stamp).
class _AgentListCard extends StatelessWidget {
  const _AgentListCard({
    required this.agent,
    required this.onTap,
    required this.onReadAloud,
  });
  final CheAgent agent;
  final VoidCallback onTap;
  final VoidCallback onReadAloud;

  @override
  Widget build(BuildContext context) {
    final working = cheAgentIsMoving(agent.status);
    final task = agent.task?.trim();
    return Semantics(
      button: true,
      label: '${agent.name}, ${agent.role}. ${agent.status.label}. Double tap to open desk.',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          onLongPress: onReadAloud,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          child: Ink(
            padding: const EdgeInsets.fromLTRB(10, 10, 12, 10),
            decoration: BoxDecoration(
              color: CheColors.surfaceHi,
              borderRadius: BorderRadius.circular(CheRadius.lg),
              border: Border.all(
                color: working
                    ? CheColors.accent.withValues(alpha: 0.65)
                    : CheColors.stroke,
              ),
              boxShadow: working
                  ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.18), blurRadius: 16)]
                  : null,
            ),
            child: Row(
              children: [
                CheMiniPerson(agent: agent, size: 72, showDesk: false),
                const SizedBox(width: CheSpace.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(agent.name, style: CheType.headline, maxLines: 1, overflow: TextOverflow.ellipsis),
                      Text(
                        agent.role.isEmpty ? agent.specialty : agent.role,
                        style: CheType.caption,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        task?.isNotEmpty == true ? task! : agent.status.label,
                        style: CheType.caption.copyWith(
                          color: working ? CheColors.success : CheColors.textDim,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(99),
                        child: LinearProgressIndicator(
                          value: working ? null : (agent.status == CheAgentStatus.done ? 1 : 0.08),
                          minHeight: 3,
                          backgroundColor: CheColors.stroke,
                          color: CheColors.accent,
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
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
  const _AgentDeskSheet({
    required this.client,
    required this.agentId,
    required this.agentIds,
    required this.onChanged,
    this.onSpeak,
    this.onTalkToChe,
  });
  final CheAgentRuntimeClient client;
  final String agentId;
  final List<String> agentIds;
  final Future<void> Function() onChanged;
  final Future<void> Function(String text)? onSpeak;

  /// When set (CHE's desk), shows Talk to CHE and routes requests via officeGoal.
  final VoidCallback? onTalkToChe;
  @override
  State<_AgentDeskSheet> createState() => _AgentDeskSheetState();
}

class _AgentDeskSheetState extends State<_AgentDeskSheet> {
  CheAgentDetail? _detail;
  String? _error;
  bool _working = false;
  final _message = TextEditingController();
  late String _agentId;
  late int _agentIndex;

  @override
  void initState() {
    super.initState();
    _agentId = widget.agentId;
    _agentIndex = widget.agentIds.indexOf(_agentId);
    if (_agentIndex < 0) _agentIndex = 0;
    _load();
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await widget.client.agent(_agentId);
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

  bool get _isChe => _agentId == 'che';

  Future<void> _switchAgent(int delta) async {
    if (widget.agentIds.length < 2 || _working) return;
    final next = (_agentIndex + delta).clamp(0, widget.agentIds.length - 1);
    if (next == _agentIndex) return;
    HapticFeedback.selectionClick();
    setState(() {
      _agentIndex = next;
      _agentId = widget.agentIds[next];
      _detail = null;
      _error = null;
      _message.clear();
    });
    await _load();
  }

  double _workflowProgress(CheAgentDetail detail) {
    final status = detail.profile.assignmentStatus.toLowerCase();
    if (status.contains('complete') || status.contains('done')) return 1;
    if (status.contains('review')) return 0.82;
    if (status.contains('running') || detail.profile.working) return 0.55;
    if (status.contains('queued') || status.contains('waiting')) return 0.22;
    if (status.contains('fail') || status.contains('block')) return 0.08;
    if (detail.history.isNotEmpty) {
      final latest = detail.history.first.status.toLowerCase();
      if (latest == 'complete') return 1;
      if (latest == 'reviewing') return 0.82;
      if (latest == 'running') return 0.55;
      if (latest == 'queued') return 0.22;
    }
    return 0;
  }

  String _verifiedOutputLine(CheAgentDetail detail) {
    final verified = detail.history.where((task) => task.verifiedByChe).length;
    final finished = detail.history.where((task) => ['complete', 'failed', 'cancelled'].contains(task.status)).length;
    return 'Verified outputs: $verified · Finished tasks: $finished · History: ${detail.history.length}';
  }

  Future<void> _sendRequest(CheAgent a) async {
    final t = _message.text.trim();
    if (t.isEmpty) return;
    _message.clear();
    if (_isChe) {
      await _run(() async {
        final reply = await widget.client.officeGoal(t);
        if (mounted && widget.onSpeak != null) {
          try {
            await widget.onSpeak!(reply);
          } catch (_) {}
        }
      });
      return;
    }
    await _run(() => widget.client.assignTask(a.id, t));
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
        final progress = _workflowProgress(d);
        return GestureDetector(
          behavior: HitTestBehavior.translucent,
          onHorizontalDragEnd: (details) {
            final velocity = details.primaryVelocity ?? 0;
            if (velocity < -220) {
              unawaited(_switchAgent(1));
            } else if (velocity > 220) {
              unawaited(_switchAgent(-1));
            }
          },
          child: ListView(
          controller: scroll,
          padding: EdgeInsets.fromLTRB(
              CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl + MediaQuery.viewInsetsOf(context).bottom),
          children: [
            if (widget.agentIds.length > 1) ...[
              Semantics(
                label: 'Employee ${_agentIndex + 1} of ${widget.agentIds.length}. Swipe left or right to move through employee cards.',
                child: Row(children: [
                  IconButton(
                    tooltip: 'Previous employee',
                    onPressed: _agentIndex > 0 ? () => unawaited(_switchAgent(-1)) : null,
                    icon: const Icon(Icons.chevron_left_rounded),
                  ),
                  Expanded(
                    child: Text(
                      'EMPLOYEE ${_agentIndex + 1} OF ${widget.agentIds.length} · SWIPE TO REVIEW',
                      textAlign: TextAlign.center,
                      style: CheType.overline.copyWith(color: CheColors.accent),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Next employee',
                    onPressed: _agentIndex < widget.agentIds.length - 1 ? () => unawaited(_switchAgent(1)) : null,
                    icon: const Icon(Icons.chevron_right_rounded),
                  ),
                ]),
              ),
              const SizedBox(height: CheSpace.sm),
            ],
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
                              '${a.personality.isNotEmpty ? ' Personality: ${a.personality}.' : ''}'
                              '${p.strengths.isNotEmpty ? ' Strong points: ${p.strengths.join('; ')}.' : ''}'
                              '${p.limitations.isNotEmpty ? ' Limitations: ${p.limitations.join('; ')}.' : ''}'
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
            _Section(
              'CURRENT JOB',
              a.task?.trim().isNotEmpty == true
                  ? a.task!
                  : (p.assignmentTask.trim().isNotEmpty
                      ? p.assignmentTask
                      : 'No active job right now. Status: ${a.status.label}.'),
            ),
            Semantics(
              label: 'Verified productivity for ${a.name}. ${_verifiedOutputLine(d)}. Current workflow progress ${(progress * 100).round()} percent.',
              child: Container(
                padding: const EdgeInsets.all(CheSpace.md),
                decoration: BoxDecoration(
                  color: CheColors.surfaceHi,
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: CheColors.strokeHi),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('VERIFIED PRODUCTIVITY', style: CheType.overline.copyWith(color: CheColors.accent)),
                  const SizedBox(height: 6),
                  LinearProgressIndicator(
                    value: progress,
                    minHeight: 7,
                    color: a.color,
                    backgroundColor: CheColors.stroke,
                    borderRadius: BorderRadius.circular(99),
                  ),
                  const SizedBox(height: 6),
                  Text('${(progress * 100).round()}% current workflow stage', style: CheType.label),
                  Text(_verifiedOutputLine(d), style: CheType.caption),
                  Text('Progress is based on real queued / working / review / completed states, not a guessed performance score.',
                      style: CheType.caption.copyWith(color: CheColors.textFaint)),
                ]),
              ),
            ),
            const SizedBox(height: CheSpace.md),
            if (a.personality.isNotEmpty) _Section('PERSONALITY', a.personality),
            if (a.specialty.isNotEmpty) _Section('JOB / SPECIALTY', a.specialty),
            if (p.mission.isNotEmpty) _Section('MISSION', p.mission),
            _Section(
              'CAPABILITIES',
              p.capabilityRequirements.isEmpty
                  ? 'No extra capability requirement is registered.'
                  : p.capabilityRequirements
                      .map((x) => '• ${x.replaceAll('_', ' ')}')
                      .join('\n'),
            ),
            _Section(
              'SKILLS',
              d.skills.isEmpty
                  ? 'No learned workflow skills are assigned yet.'
                  : d.skills.map((skill) {
                      final source = skill.sourceRepo.isEmpty
                          ? ''
                          : ' — ${skill.sourceRepo}'
                              '${skill.sourcePath.isEmpty ? '' : '/${skill.sourcePath}'}'
                              '${skill.sourceLicense.isEmpty ? '' : ' · ${skill.sourceLicense}'}';
                      return '• ${skill.name}$source';
                    }).join('\n'),
            ),
            _Section(
              'STRONG POINTS',
              p.strengths.isEmpty
                  ? 'No role-specific strengths are registered yet.'
                  : p.strengths.map((x) => '• $x').join('\n'),
            ),
            _Section(
              'WEAK POINTS / LIMITATIONS',
              p.limitations.isEmpty
                  ? 'No role-specific limitations are registered yet.'
                  : p.limitations.map((x) => '• $x').join('\n'),
            ),
            _Section(
              'RESPONSIBILITIES',
              p.responsibilities.isEmpty
                  ? 'None assigned yet.'
                  : p.responsibilities.map((x) => '• $x').join('\n'),
            ),
            const SizedBox(height: CheSpace.sm),
            if (_isChe && widget.onTalkToChe != null) ...[
              FilledButton.icon(
                onPressed: _working ? null : () => Navigator.of(context).pop(true),
                icon: const Icon(Icons.record_voice_over_rounded, size: 18),
                label: const Text('Talk to CHE'),
              ),
              const SizedBox(height: CheSpace.md),
            ],
            Text(_isChe ? 'REQUEST TO CHE' : 'MESSAGE ${a.name.toUpperCase()}', style: CheType.overline),
            const SizedBox(height: CheSpace.xs),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _message,
                  minLines: 1,
                  maxLines: 4,
                  decoration: InputDecoration(
                    hintText: _isChe
                        ? 'Give CHE a request. She splits it into Office jobs.'
                        : 'Give ${a.name} a task. CHE reviews the result.',
                  ),
                ),
              ),
              IconButton(
                tooltip: _isChe ? 'Send request' : 'Send task',
                onPressed: _working ? null : () => _sendRequest(a),
                icon: const Icon(Icons.send_rounded, color: CheColors.accent),
              ),
            ]),
            const SizedBox(height: CheSpace.md),
            if (!_isChe)
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
            if (d.history.isEmpty)
              Text(_isChe ? 'No Office requests on this desk yet. Send one above.' : 'No tasks yet.',
                  style: CheType.bodyDim),
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
        ),
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

// ─────────────────────────────────────────────────────────────────────────
// Floor plan: one canvas. Labeled agent desks in a grid (the open floor),
// the War Room as a room on the right, CHE's desk front and center.
// ─────────────────────────────────────────────────────────────────────────

const Color _warRoomColor = Color(0xFFE8B04A);

class CheOfficeFloorPlan extends StatelessWidget {
  const CheOfficeFloorPlan({super.key, required this.store, required this.onTapDesk, required this.onWarRoom});

  final CheOfficeStore store;
  final void Function(String id) onTapDesk;
  final VoidCallback onWarRoom;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(CheRadius.xl),
      child: CheRoomBackdrop(
        room: CheRoom.office,
        scrim: 0.45,
        child: Padding(
          padding: const EdgeInsets.all(CheSpace.md),
          // Rebuilds only when desks are added or removed; status changes
          // reach each desk through its own notifier.
          child: ValueListenableBuilder<List<String>>(
            valueListenable: store.deskOrder,
            builder: (context, _, _) {
              final ids = store.agentDeskIds;
              final che = store.desk(CheOfficeStore.cheId);
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text('CHE OFFICE · FLOOR PLAN',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.overline.copyWith(color: Colors.white)),
                    ),
                  ),
                  ValueListenableBuilder<int>(
                    valueListenable: store.working,
                    builder: (context, n, _) =>
                        Text('$n working', style: CheType.caption.copyWith(color: Colors.white70)),
                  ),
                ]),
                const SizedBox(height: CheSpace.sm),
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(
                    flex: 3,
                    child: _OpenFloor(store: store, ids: ids, onTapDesk: onTapDesk),
                  ),
                  const SizedBox(width: CheSpace.sm),
                  Expanded(
                    flex: 2,
                    child: _WarRoomOnPlan(warRoom: store.warRoom, onTap: onWarRoom),
                  ),
                ]),
                const SizedBox(height: CheSpace.md),
                Text('FRONT OF THE OFFICE',
                    textAlign: TextAlign.center, style: CheType.overline.copyWith(color: Colors.white70)),
                const SizedBox(height: CheSpace.xs),
                if (che != null)
                  Center(
                    child: SizedBox(
                      width: 150,
                      height: 160,
                      child: _PlanDesk(view: che, big: true, onTap: () => onTapDesk(CheOfficeStore.cheId)),
                    ),
                  ),
              ]);
            },
          ),
        ),
      ),
    );
  }
}

class _OpenFloor extends StatelessWidget {
  const _OpenFloor({required this.store, required this.ids, required this.onTapDesk});
  final CheOfficeStore store;
  final List<String> ids;
  final void Function(String id) onTapDesk;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('OPEN FLOOR', style: CheType.overline.copyWith(color: Colors.white70)),
      const SizedBox(height: CheSpace.xs),
      if (ids.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: CheSpace.lg),
          child: Text('No agents yet. Ask CHE to build a team for a project.',
              style: CheType.bodyDim.copyWith(color: Colors.white70)),
        )
      else
        LayoutBuilder(
          builder: (context, box) => GridView.count(
            crossAxisCount: box.maxWidth >= 330 ? 3 : 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            padding: EdgeInsets.zero,
            mainAxisSpacing: CheSpace.sm,
            crossAxisSpacing: CheSpace.sm,
            childAspectRatio: 0.66,
            children: [
              for (final id in ids)
                if (store.desk(id) case final view?)
                  _PlanDesk(key: ValueKey(id), view: view, onTap: () => onTapDesk(id)),
            ],
          ),
        ),
    ]);
  }
}

/// One labeled desk. Listens only to its own notifier, inside its own
/// RepaintBoundary, so another desk's status change never repaints it.
class _PlanDesk extends StatelessWidget {
  const _PlanDesk({super.key, required this.view, required this.onTap, this.big = false});
  final ValueNotifier<CheDeskView> view;
  final VoidCallback onTap;
  final bool big;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: ValueListenableBuilder<CheDeskView>(
        valueListenable: view,
        builder: (context, d, _) {
          final agent = d.agent;
          final line = d.line;
          final shown = line == agent.task ? cheShortSummary(line, max: 32) : line;
          final blocked = line.startsWith('Blocked');
          return Semantics(
            button: true,
            label: '${agent.name}${agent.role.isNotEmpty ? ', ${agent.role}' : ''}. $line. '
                '${agent.isChe ? 'CHE\'s desk, front and center. Open to talk or send a request.' : 'Open ${agent.name}\'s desk.'}',
            excludeSemantics: true,
            child: GestureDetector(
              onTap: () {
                HapticFeedback.selectionClick();
                onTap();
              },
              child: Container(
                padding: const EdgeInsets.fromLTRB(4, 6, 4, 6),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.35),
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(
                    color: blocked ? CheColors.warning : agent.color.withValues(alpha: big ? 0.9 : 0.45),
                  ),
                  boxShadow: big ? [BoxShadow(color: agent.color.withValues(alpha: 0.4), blurRadius: 18)] : null,
                ),
                child: Column(children: [
                  // The figure shrinks to the space left, so labels never overflow.
                  Expanded(child: FittedBox(child: CheMiniPerson(agent: agent, size: big ? 64 : 48, showDesk: true))),
                  const SizedBox(height: 2),
                  // Full name, never truncated: it scales down instead.
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(agent.name, maxLines: 1, style: CheType.label.copyWith(color: Colors.white)),
                  ),
                  if (agent.role.isNotEmpty)
                    Text(agent.role,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: CheType.caption.copyWith(color: Colors.white70, fontSize: 10)),
                  Text(shown,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: CheType.caption.copyWith(
                        color: blocked ? CheColors.warning : agent.color,
                        fontSize: 10.5,
                      )),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// The War Room as a room on the floor plan (right side).
class _WarRoomOnPlan extends StatelessWidget {
  const _WarRoomOnPlan({required this.warRoom, required this.onTap});
  final ValueNotifier<({int live, int total})> warRoom;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: ValueListenableBuilder<({int live, int total})>(
        valueListenable: warRoom,
        builder: (context, w, _) {
          final status = w.live > 0
              ? '${w.live} ${w.live == 1 ? 'meeting' : 'meetings'} in session'
              : w.total > 0
                  ? 'Empty now. ${w.total} past ${w.total == 1 ? 'meeting' : 'meetings'}.'
                  : 'Empty. Convene the team here.';
          return Semantics(
            button: true,
            label: 'War Room. $status ${w.live > 0 ? 'Open the live meeting.' : 'Convene the War Room.'}',
            excludeSemantics: true,
            child: GestureDetector(
              onTap: () {
                HapticFeedback.selectionClick();
                onTap();
              },
              child: Container(
                constraints: const BoxConstraints(minHeight: 180),
                padding: const EdgeInsets.all(CheSpace.sm),
                decoration: BoxDecoration(
                  color: _warRoomColor.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: _warRoomColor.withValues(alpha: w.live > 0 ? 0.95 : 0.5), width: 1.5),
                ),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text('WAR ROOM', style: CheType.overline.copyWith(color: _warRoomColor)),
                  const SizedBox(height: CheSpace.sm),
                  const Icon(Icons.groups_rounded, size: 34, color: _warRoomColor),
                  const SizedBox(height: CheSpace.sm),
                  Text(status,
                      textAlign: TextAlign.center,
                      style: CheType.caption.copyWith(color: Colors.white.withValues(alpha: 0.85))),
                  const SizedBox(height: CheSpace.sm),
                  Text(w.live > 0 ? 'Open meeting' : 'Convene',
                      style: CheType.label.copyWith(color: _warRoomColor)),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}
