// CHE Office: the AI operations center (owner UI cleanup, 2026-10-25). One scrolling page of structured sections,
// each from real Worker records only: business overview, what needs the owner, active projects, the zoned floor
// plan, the Office agents as contact cards, current tasks, recent verified activity, the War Room and actionable
// next steps. Empty sections say so plainly. Tap an agent (including CHE) to open their desk (profile, current task,
// history, verified receipts; message / reassign / upgrade / retire). CHE's desk also offers Talk and a request
// field that queues work through her Office goal API. Nothing on this page speaks by itself: every Read button, quick
// action and spoken command does.

import '../world/che_meetings.dart';
import 'che_war_room_screen.dart';
import '../office/che_office_calendar.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_chrome_status.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_voice_actions.dart';
import '../rooms/che_characters_room.dart';
import '../home/che_projects_board.dart' show CheBoardItem;
import 'che_agent_contact_card.dart';
import 'che_agent_runtime.dart';
import 'che_office_floor_plan.dart';
import 'che_office_glass.dart';
import 'che_office_status.dart';
import 'che_office_store.dart';
import 'che_office_voice.dart';

export 'che_office_floor_plan.dart';

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
    this.runtime,
    this.onTalkToChe,
    this.onSpeak,
    this.embedded = false,
    this.initialAgentName,
    this.initialZone,
    this.initialAction = CheOfficeVoiceAction.open,
    this.onOpenRoom,
    this.projects,
    this.onOpenProjects,
  });

  final CheAgentRuntimeClient client;

  /// The app's own Office runtime, when it already has one: the floor shows it instead of starting a second set of
  /// polls on the same endpoints. Without it the floor runs (and disposes) its own.
  final CheAgentRuntimeController? runtime;

  /// Opens CHE's chat from her desk sheet (Talk to CHE).
  final VoidCallback? onTalkToChe;

  /// Reads text aloud in CHE's voice. Falls back to a VoiceOver announcement.
  final Future<void> Function(String text)? onSpeak;

  /// True when shown as the hub's Office tab (no app bar or back route).
  final bool embedded;

  /// Deep link from the Brain's live agent orbs: opens this agent's desk
  /// sheet once the roster arrives. Unmatched names are spoken, never guessed.
  final String? initialAgentName;

  /// Voice deep link to a floor-plan zone (CheOfficeZone.id, e.g. 'trading'): opens that zone once the roster arrives.
  final String? initialZone;

  /// With [initialAgentName]: open the desk, the War Room message box, or the Assign box.
  final CheOfficeVoiceAction initialAction;

  /// Opens the app room a zone leads to ('brain', 'business', 'trading', 'create'). Without it zones show desks only.
  final void Function(String room)? onOpenRoom;

  /// The Projects board's real items (Creator projects, Office goals, deals). Null hides the section.
  final List<CheBoardItem>? projects;

  /// Opens the full Projects page.
  final VoidCallback? onOpenProjects;

  @override
  State<CheOfficeFloorScreen> createState() => _CheOfficeFloorScreenState();
}

class _CheOfficeFloorScreenState extends State<CheOfficeFloorScreen> {
  late final bool _ownsRuntime = widget.runtime == null;
  late final CheAgentRuntimeController _runtime = (widget.runtime ?? CheAgentRuntimeController(widget.client))..addListener(_changed);

  /// One store for the floor: desks update individually, the plan only
  /// rebuilds when desks are added or removed.
  final CheOfficeStore _store = CheOfficeStore();
  CheOfficeToday? _lastBoard;
  String _filter = 'All'; // All | Research | Trading | Content

  // The office is the zoned floor plan: no 3D crowd, no photo backdrop (owner cleanups 2026-10-22 and 2026-10-25).
  late final Widget _floorPlan = CheOfficeFloorPlan(
    store: _store,
    onTapDesk: _openDesk,
    onWarRoom: _warRoom,
    onOpenZone: (zone) => unawaited(_openZone(zone)),
  );

  /// Deep link: open the requested agent's desk once the roster is known.
  /// Missing agents are shown visually, without unsolicited narration.
  String? _pendingAgentName;
  bool _initialAgentTried = false;
  CheOfficeZone? _pendingZone;

  @override
  void initState() {
    super.initState();
    _pendingAgentName = widget.initialAgentName;
    _pendingZone = widget.initialZone == null ? null : cheOfficeZoneById(widget.initialZone!);
    _runtime.start();
    // A shared runtime may already hold the roster; show it now rather than after its next poll.
    if (_runtime.loaded) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _changed();
      });
    }
  }

  void _openInitialAgent() {
    // The board/coding polls notify independently of the roster fetch; only
    // the loaded roster can resolve the name, otherwise a placeholder desk
    // would falsely report the agent as absent.
    // A failed roster request sets loaded=true too; do not call a real
    // agent absent until a successful roster refresh has arrived.
    if (!_runtime.loaded || _runtime.error != null) return;
    if (_pendingZone != null) {
      final zone = _pendingZone!;
      _pendingZone = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_openZone(zone));
      });
      return;
    }
    if (_pendingAgentName == null) return;
    final want = _pendingAgentName!;
    _pendingAgentName = null;
    final id = _store.deskIdForAgentName(want);
    if (id != null) {
      _initialAgentTried = true;
      final agent = _store.desk(id)!.value.agent;
      switch (widget.initialAction) {
        case CheOfficeVoiceAction.message:
          unawaited(_messageInWarRoom(agent));
        case CheOfficeVoiceAction.assign:
          unawaited(_assignTask(agent));
        case CheOfficeVoiceAction.open:
          _openDesk(id);
      }
      return;
    }
    if (!_initialAgentTried) {
      _initialAgentTried = true;
      _snack('$want is not on the Office floor right now.');
    }
  }

  @override
  void dispose() {
    _runtime.removeListener(_changed);
    if (_ownsRuntime) _runtime.dispose();
    _store.dispose();
    super.dispose();
  }

  void _changed() {
    final r = _runtime;
    _store.setRoster(r.che, [for (final p in r.agents) p.agent]);
    _store.setMeetings(r.meetings);
    _openInitialAgent();
    if (!identical(r.today, _lastBoard)) {
      _lastBoard = r.today;
      _store.setBoard(r.today);
      // Blockers stay visible and readable without automatically speaking.
      for (final line in _store.takeAnnouncements()) {
        _snack(line);
      }
    }
    if (mounted) setState(() {});
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

  /// Reopens the same visual Meeting Room for this meeting id (nothing restarts).
  Future<void> _openMeeting(String id) async {
    if (!mounted) return;
    await cheOpenMeetingRoom(context, client: widget.client, id: id, onSpeak: _roomSpeak);
    await _runtime.refresh();
    if (mounted) setState(() {});
  }

  /// The War Room's full text record of the same meeting (board, decisions, final plan).
  Future<void> _openTranscript(String id) async {
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheWarRoomScreen(client: widget.client, meetingId: id)));
    await _runtime.refresh();
  }

  Future<void> _roomSpeak(String text) async => widget.onSpeak?.call(text);

  /// Meetings: Active, Recent and Completed, without starting a new one.
  Future<void> _openMeetings() async {
    if (!mounted) return;
    HapticFeedback.selectionClick();
    await Navigator.of(context).push(CheMeetingsPage.route(client: widget.client, onSpeak: _roomSpeak));
    await _runtime.refresh();
    if (mounted) setState(() {});
  }

  Future<void> _returnToLastMeeting() async {
    final id = await cheLastMeetingId();
    if (id == null) {
      _snack('No meeting opened yet.');
      return;
    }
    await _openMeeting(id);
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

  /// One agent's real card state and line: the Office board first, then the latest assignment, then the roster.
  (CheWorkState, String) _stateFor(CheAgent agent, {String assignmentStatus = '', String assignmentTask = ''}) {
    final view = _store.desk(agent.id)?.value;
    final state = cheWorkStateFor(agent, boardState: view?.boardState, assignmentStatus: assignmentStatus);
    return (state, cheWorkLine(state, agent, note: view?.note, job: view?.job ?? '', assignmentTask: assignmentTask));
  }

  (CheWorkState, String) _profileState(CheAgentProfile p) =>
      _stateFor(p.agent, assignmentStatus: p.assignmentStatus, assignmentTask: p.assignmentTask);

  Widget _agentCard(CheAgent agent, CheWorkState state, String line) => Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.sm),
        child: CheAgentContactCard(
          agent: agent,
          state: state,
          line: line,
          onOpenDesk: () => _openDesk(agent.id),
          onMessage: () => unawaited(_messageInWarRoom(agent)),
          onAssign: () => unawaited(_assignTask(agent)),
          onAskStatus: () => unawaited(_askStatus(agent, state, line)),
        ),
      );

  /// "What are you working on?": the card's own real state, spoken (the owner asked) and shown.
  Future<void> _askStatus(CheAgent agent, CheWorkState state, String line) async {
    final text = cheWorkingOnSpeech(agent, state, line);
    HapticFeedback.selectionClick();
    _snack(text);
    await _speak(text);
  }

  /// "Message Atlas in the War Room": a War Room meeting with that agent on the objective the owner gives.
  Future<void> _messageInWarRoom(CheAgent agent) async {
    if (!mounted) return;
    final who = agent.isChe ? 'the team' : agent.name;
    final text = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: Text(agent.isChe ? 'War Room message' : 'Message ${agent.name} in the War Room'),
        content: TextField(
          controller: text,
          autofocus: true,
          maxLines: 3,
          decoration: InputDecoration(
            labelText: 'Message',
            hintText: 'What should $who work out? CHE chairs the meeting.',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Send to War Room')),
        ],
      ),
    );
    final objective = text.text.trim();
    if (ok != true || objective.isEmpty) return;
    try {
      final meeting = await widget.client.convene(objective, agentIds: agent.isChe ? null : [agent.id]);
      await _runtime.refresh();
      await _report('War Room opened with $who: ${cheShortSummary(objective, max: 60)}', ok: true);
      await _openMeeting(meeting.summary.id);
    } catch (e) {
      await _report('CHE here. The War Room message to $who did not go through: $e', ok: false);
    }
  }

  /// "Assign a task to Atlas": the owner types or dictates the task; CHE reviews the result before it counts.
  Future<void> _assignTask(CheAgent agent) async {
    if (agent.isChe) return _giveGoal();
    if (!mounted) return;
    final text = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: Text('Assign a task to ${agent.name}'),
        content: TextField(
          controller: text,
          autofocus: true,
          maxLines: 3,
          decoration: InputDecoration(labelText: 'Task', hintText: 'What should ${agent.name} do? CHE reviews the result.'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Assign')),
        ],
      ),
    );
    final task = text.text.trim();
    if (ok != true || task.isEmpty) return;
    try {
      await widget.client.assignTask(agent.id, task);
      await _runtime.refresh();
      await _runtime.refreshBoard();
      await _report('Sent to ${agent.name}: ${cheShortSummary(task, max: 60)}. CHE reviews the result before it counts.', ok: true);
    } catch (e) {
      await _report('CHE here. The task did not reach ${agent.name}: $e', ok: false);
    }
  }

  /// A zone of the floor plan: what it is for, who is there with their real state, and the room it leads to.
  Future<void> _openZone(CheOfficeZone zone) async {
    if (!mounted) return;
    if (zone == CheOfficeZone.warRoom) return _warRoom();
    final ids = cheZoneMembers(_store)[zone]!;
    HapticFeedback.selectionClick();
    final room = zone.room;
    final roomLabel = switch (room) {
      'brain' => 'Open CHE\'s Brain',
      'business' => 'Open the Business room',
      'trading' => 'Open the Trading Room',
      'create' => 'Open the Creator Studio',
      _ => null,
    };
    final openRoom = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      builder: (sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        maxChildSize: 0.95,
        builder: (context, scroll) {
          final activity = cheZoneActivity(_store, ids);
          return ListView(
            controller: scroll,
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.gutter, CheSpace.xl),
            children: [
              Row(children: [
                Icon(zone.icon, color: zone.color),
                const SizedBox(width: CheSpace.sm),
                Expanded(child: Semantics(header: true, child: Text(zone.title, style: CheType.title))),
                _ReadAloudButton(
                  label: 'Read the ${zone.title} aloud',
                  onPressed: () => unawaited(_speak('${zone.title}. ${zone.purpose} $activity')),
                ),
              ]),
              const SizedBox(height: CheSpace.xs),
              Text(zone.purpose, style: CheType.bodyDim),
              const SizedBox(height: CheSpace.xs),
              Text(activity, style: CheType.label),
              const SizedBox(height: CheSpace.md),
              if (ids.isEmpty)
                Text('No desk here yet. Ask CHE to staff it, or hire a new agent.', style: CheType.bodyDim)
              else
                for (final id in ids)
                  if (_store.desk(id)?.value case final view?)
                    Builder(builder: (_) {
                      final profile = _runtime.agents.where((p) => p.agent.id == id).firstOrNull;
                      final (state, line) = profile == null ? _stateFor(view.agent) : _profileState(profile);
                      return _agentCard(view.agent, state, line);
                    }),
              if (roomLabel != null && widget.onOpenRoom != null) ...[
                const SizedBox(height: CheSpace.sm),
                FilledButton.icon(
                  key: ValueKey('office-zone-room-${zone.id}'),
                  onPressed: () => Navigator.of(sheetContext).pop(true),
                  icon: const Icon(Icons.arrow_forward_rounded, size: 18),
                  label: Text(roomLabel),
                ),
              ],
            ],
          );
        },
      ),
    );
    if (openRoom == true && room != null) widget.onOpenRoom?.call(room);
  }

  /// Plain, honest next steps from the real records: what is blocked, what waits, what is idle.
  List<({String text, String semantics, IconData icon, VoidCallback onTap})> _nextSteps(CheAgentRuntimeController r) {
    final steps = <({String text, String semantics, IconData icon, VoidCallback onTap})>[];
    final blocked = [for (final p in r.agents) if (_profileState(p).$1 == CheWorkState.blocked) p];
    for (final p in blocked.take(3)) {
      final line = _profileState(p).$2;
      steps.add((
        text: 'Unblock ${p.agent.name}: ${cheShortSummary(line, max: 48)}',
        semantics: 'Open ${p.agent.name}\'s desk to unblock: $line',
        icon: Icons.block_rounded,
        onTap: () => _openDesk(p.agent.id),
      ));
    }
    final live = r.meetings.where((m) => m.live).toList();
    if (live.isNotEmpty) {
      steps.add((
        text: 'Join the live War Room: ${cheShortSummary(live.first.objective, max: 44)}',
        semantics: 'Open the live War Room meeting: ${live.first.objective}',
        icon: Icons.groups_rounded,
        onTap: () => unawaited(_openMeeting(live.first.id)),
      ));
    }
    final available = [for (final p in r.agents) if (_profileState(p).$1 == CheWorkState.available) p.agent.name];
    final busy = r.agents.any((p) => const {CheWorkState.working, CheWorkState.queued}.contains(_profileState(p).$1));
    if (r.agents.isEmpty) {
      steps.add((
        text: 'Give the Office a goal. CHE staffs the team.',
        semantics: 'Give the Office a goal. CHE staffs the team',
        icon: Icons.flag_rounded,
        onTap: () => unawaited(_giveGoal()),
      ));
    } else if (!busy) {
      steps.add((
        text: 'Nothing is running. Give the Office a goal.',
        semantics: 'Nothing is running. Give the Office a goal',
        icon: Icons.flag_rounded,
        onTap: () => unawaited(_giveGoal()),
      ));
    } else if (available.isNotEmpty) {
      steps.add((
        text: 'Available now: ${available.take(4).join(', ')}. Assign one a task.',
        semantics: 'Available now: ${available.join(', ')}. Assign ${available.first} a task',
        icon: Icons.assignment_ind_rounded,
        onTap: () {
          final first = r.agents.firstWhere((p) => p.agent.name == available.first);
          unawaited(_assignTask(first.agent));
        },
      ));
    }
    return steps;
  }

  List<Widget> _content(BuildContext context) {
    final r = _runtime;
    final agents = _filteredAgents(r);
    if (!r.loaded) {
      return const [Padding(padding: EdgeInsets.all(CheSpace.xxl), child: Center(child: CircularProgressIndicator()))];
    }
    final today = r.today;
    final states = {for (final p in r.agents) p.agent.id: _profileState(p)};
    int count(CheWorkState s) => states.values.where((x) => x.$1 == s).length;
    final (cheState, cheLine) = _stateFor(r.che);
    final needs = <({String who, String text})>[
      for (final b in today?.blockers ?? const <Map<String, dynamic>>[])
        (who: '${b['agent'] ?? 'Office'}', text: '${b['detail'] ?? 'Blocked'} · ${b['task'] ?? ''}'),
      for (final s in today?.stalled ?? const <Map<String, dynamic>>[])
        (who: '${s['agent'] ?? 'Office'}', text: 'Stalled (${s['detail'] ?? 'no update'}) · ${s['task'] ?? ''}'),
    ];
    final active = [
      for (final p in widget.projects ?? const <CheBoardItem>[])
        if (!RegExp(r'complete|done|shipped|cancel|archiv|lost|failed').hasMatch(p.statusLabel.toLowerCase())) p,
    ];
    final current = [
      if (r.che.task?.isNotEmpty == true && cheState == CheWorkState.working) (agent: r.che, state: cheState, line: cheLine),
      for (final p in r.agents)
        if (const {CheWorkState.working, CheWorkState.queued}.contains(states[p.agent.id]!.$1))
          (agent: p.agent, state: states[p.agent.id]!.$1, line: states[p.agent.id]!.$2),
    ];
    final verified = today?.shipped ?? const <Map<String, dynamic>>[];
    final steps = _nextSteps(r);
    return [
      if (r.error != null) _Banner(text: r.error!, color: CheColors.warning),
      // ── Business overview ─────────────────────────────────────────────
      _SectionHeader(
        title: 'BUSINESS OVERVIEW',
        onRead: () => _speak('${cheOfficeBoardSpeech(r.today, r.connection)} ${_officeSummary()}'),
        readLabel: 'Read the business overview aloud',
        first: true,
      ),
      _OverviewStats(stats: [
        ('Working', count(CheWorkState.working), CheWorkState.working.color),
        ('Queued', count(CheWorkState.queued), CheWorkState.queued.color),
        ('Blocked', count(CheWorkState.blocked), CheWorkState.blocked.color),
        ('Finished today', today?.builtToday ?? 0, CheWorkState.finished.color),
      ]),
      const SizedBox(height: CheSpace.md),
      CheVoiceActionList(
        horizontal: true,
        actions: [
          CheVoiceAction(
            number: 1,
            label: 'Status',
            icon: Icons.mic_rounded,
            onTap: () => _speak('${cheOfficeBoardSpeech(r.today, r.connection)} ${_officeSummary()}'),
            semantics: '1. Office status',
          ),
          CheVoiceAction(
            number: 2,
            label: 'Find agent',
            icon: Icons.groups_rounded,
            onTap: () {
              HapticFeedback.selectionClick();
              _speak(
                agents.isEmpty
                    ? 'No agents match this filter.'
                    : '${agents.length} agents in $_filter. ${agents.map((p) => p.agent.name).join(', ')}.',
              );
            },
            semantics: '2. Find an agent',
          ),
          CheVoiceAction(number: 3, label: 'War Room', icon: Icons.hub_rounded, onTap: _warRoom, semantics: '3. War Room'),
          CheVoiceAction(
            number: 4,
            label: 'Meetings',
            icon: Icons.meeting_room_rounded,
            onTap: () => unawaited(_openMeetings()),
            semantics: '4. Meetings: active, recent and completed',
          ),
        ],
      ),
      // ── Priorities: what needs the owner ───────────────────────────────
      _SectionHeader(
        title: 'NEEDS YOU (${needs.length})',
        onRead: () => _speak(needs.isEmpty ? 'Nothing is blocked or stalled.' : needs.map((n) => '${n.who}: ${n.text}.').join(' ')),
        readLabel: 'Read what needs you aloud',
      ),
      if (needs.isEmpty)
        const _EmptyLine('Nothing is blocked or stalled.')
      else
        for (final n in needs.take(5))
          _InfoRow(
            icon: Icons.block_rounded,
            color: CheColors.danger,
            title: n.who,
            body: n.text,
            semantics: '${n.who}. ${n.text}. Open ${n.who}\'s desk.',
            onTap: () {
              final id = _store.deskIdForAgentName(n.who);
              if (id != null) _openDesk(id);
            },
          ),
      if (r.codingJob != null) ...[
        const SizedBox(height: CheSpace.sm),
        CheCodingJobCard(status: r.codingJob!, onReadAloud: () => _speak(r.codingJob!.speech)),
      ],
      // ── Active projects ────────────────────────────────────────────────
      if (widget.projects != null) ...[
        _SectionHeader(
          title: 'ACTIVE PROJECTS (${active.length})',
          onRead: () => _speak(active.isEmpty
              ? 'No active projects.'
              : active.map((p) => '${p.title}: ${p.statusLabel}, ${(p.progress * 100).round()} percent.').join(' ')),
          readLabel: 'Read the active projects aloud',
        ),
        if (active.isEmpty)
          const _EmptyLine('No active projects.')
        else
          for (final p in active.take(4)) _ProjectRow(item: p, onTap: widget.onOpenProjects),
        if (widget.onOpenProjects != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: widget.onOpenProjects,
              icon: const Icon(Icons.arrow_forward_rounded, size: 18),
              label: const Text('All projects'),
            ),
          ),
      ],
      // ── The floor plan ─────────────────────────────────────────────────
      const SizedBox(height: CheSpace.lg),
      _floorPlan,
      // ── Office agents ──────────────────────────────────────────────────
      _SectionHeader(
        title: 'OFFICE AGENTS',
        onRead: () => _speak(_officeSummary()),
        readLabel: 'Read every agent aloud',
      ),
      _FilterPills(
        selected: _filter,
        onChanged: (f) {
          HapticFeedback.selectionClick();
          setState(() => _filter = f);
        },
      ),
      const SizedBox(height: CheSpace.md),
      if (_filter == 'All') _agentCard(r.che, cheState, cheLine),
      if (agents.isEmpty)
        _EmptyLine(_filter == 'All' ? 'No agents yet. Ask CHE to staff the Office.' : 'No $_filter agents right now.')
      else
        for (final p in agents) _agentCard(p.agent, states[p.agent.id]!.$1, states[p.agent.id]!.$2),
      // ── Current tasks ──────────────────────────────────────────────────
      _SectionHeader(
        title: 'CURRENT TASKS (${current.length})',
        onRead: () => _speak(current.isEmpty
            ? 'No tasks are running or queued.'
            : current.map((c) => '${c.agent.isChe ? 'CHE' : c.agent.name}: ${c.line}.').join(' ')),
        readLabel: 'Read the current tasks aloud',
      ),
      if (current.isEmpty)
        const _EmptyLine('No tasks are running or queued.')
      else
        for (final c in current)
          _InfoRow(
            icon: c.state.icon,
            color: c.state.color,
            title: '${c.agent.isChe ? 'CHE' : c.agent.name} · ${c.state.label}',
            body: c.line,
            semantics: '${c.agent.isChe ? 'CHE' : c.agent.name}. ${c.state.label}. ${c.line}. Open the desk.',
            onTap: () => _openDesk(c.agent.id),
          ),
      // ── Recent verified activity ───────────────────────────────────────
      _SectionHeader(
        title: 'RECENT VERIFIED ACTIVITY',
        onRead: () => _speak(verified.isEmpty
            ? 'Nothing was finished and approved by CHE today.'
            : 'Approved by CHE today: ${verified.map((e) => '${e['agent']}: ${e['task']}').join('. ')}.'),
        readLabel: 'Read the verified activity aloud',
      ),
      if (verified.isEmpty)
        const _EmptyLine('Nothing was finished and approved by CHE today.')
      else
        for (final e in verified.take(5))
          _InfoRow(
            icon: Icons.verified_rounded,
            color: CheWorkState.finished.color,
            title: '${e['agent'] ?? 'Office'} · Approved by CHE',
            body: '${e['task'] ?? ''}${'${e['id'] ?? ''}'.isEmpty ? '' : '\nOffice job ${e['id']}'}',
            semantics: '${e['agent']} finished ${e['task']}. Approved by CHE. Office job ${e['id']}. Open the desk for its receipts.',
            onTap: () {
              final id = _store.deskIdForAgentName('${e['agent'] ?? ''}');
              if (id != null) _openDesk(id);
            },
          ),
      // ── War Room ───────────────────────────────────────────────────────
      _SectionHeader(
        title: 'WAR ROOM',
        onRead: () => _speak(r.meetings.isEmpty
            ? 'No War Room meetings yet.'
            : r.meetings.take(4).map((m) => '${m.statusLabel}: ${m.objective}').join('. ')),
        readLabel: 'Read the War Room aloud',
      ),
      if (r.meetings.isEmpty)
        const _EmptyLine('No meetings yet. Convene the team when a project needs several specialties.')
      else
        for (final m in r.meetings.take(4))
          _MeetingTile(
            meeting: m,
            onTap: () => _openMeeting(m.id),
            onTranscript: () => _openTranscript(m.id),
            onReadAloud: () => _speak('${m.statusLabel}. ${m.objective}. With ${m.participantNames.join(', ')}.'),
          ),
      Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
        OutlinedButton.icon(
          onPressed: () => unawaited(_convene()),
          icon: const Icon(Icons.groups_rounded, size: 18),
          label: const Text('Convene'),
        ),
        OutlinedButton.icon(
          onPressed: () => unawaited(_openMeetings()),
          icon: const Icon(Icons.meeting_room_rounded, size: 18),
          label: const Text('All meetings'),
        ),
        OutlinedButton.icon(
          onPressed: () => unawaited(_returnToLastMeeting()),
          icon: const Icon(Icons.replay_rounded, size: 18),
          label: const Text('Return to meeting'),
        ),
      ]),
      // ── Next steps ─────────────────────────────────────────────────────
      _SectionHeader(
        title: 'NEXT STEPS',
        onRead: () => _speak(steps.isEmpty ? 'No next step is waiting.' : steps.indexed.map((e) => '${e.$1 + 1}. ${e.$2.text}').join(' ')),
        readLabel: 'Read the next steps aloud as a numbered list',
      ),
      if (steps.isEmpty)
        const _EmptyLine('No next step is waiting. The Office is on it.')
      else
        for (final (i, st) in steps.indexed)
          _InfoRow(
            icon: st.icon,
            color: CheColors.accent,
            title: '${i + 1}. ${st.text}',
            body: '',
            semantics: '${i + 1}. ${st.semantics}',
            onTap: st.onTap,
          ),
      const SizedBox(height: CheSpace.sm),
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
      const SizedBox(height: CheSpace.lg),
      Text(
        '${cheDollars(today?.earnedTodayCents ?? 0)} earned today · '
        '${today == null || !today.stripeConnected ? 'Stripe not connected, so no revenue is counted' : 'from Stripe'}',
        style: CheType.caption,
      ),
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
            hintText: 'CHE splits it into jobs for Nova, Atlas, Mira, Knox, Sage, Lyra, Orion, Iris and Vale.',
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

  Widget _officeTitle() => Semantics(
        header: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (cheHudActive)
              CheChromeText('The Office', maxLines: 1, style: CheType.title)
            else
              Text('The Office', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.title),
            Text(
              'AI operations center. Real work only.',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.caption,
            ),
          ],
        ),
      );

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
        // What the Office did, day by day (owner, 2026-10-24): real jobs and their receipts.
        IconButton(
          key: const Key('office_calendar_button'),
          tooltip: 'Office calendar',
          onPressed: () => unawaited(Navigator.of(context).push(CheOfficeCalendarPage.route(baseUrl: widget.client.baseUrl, headers: widget.client.headers, onRead: (w) => unawaited(_speak(w))))),
          icon: const Icon(Icons.calendar_month_rounded),
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
          color: CheColors.screen,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.xs, 0),
              // With Larger Text the actions move under the title instead of pushing past the screen edge; at
              // ordinary sizes the header stays one row.
              child: MediaQuery.textScalerOf(context).scale(1) > 1.25
                  ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      _officeTitle(),
                      Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: _actions()),
                    ])
                  : Row(children: [Expanded(child: _officeTitle()), ..._actions()]),
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
        backgroundColor: CheColors.screen,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: cheHudActive ? CheChromeText('The Office', maxLines: 1, style: CheType.title) : const Text('The Office'),
          actions: [
            ..._actions(),
            IconButton(
              tooltip: 'Open the 3D crew',
              icon: const Icon(Icons.view_in_ar),
              onPressed: () => CheCharactersRoom.open(context, runtime: _runtime),
            ),
          ],
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
    // Tone and motion come from the coding runtime's real state: queued or waiting never animates as running.
    final (tone, activity) = cheCodingStatus(status.state);
    final color = CheStatusPalette.of(tone).base;
    return Semantics(
      container: true,
      label: 'CHE coding job. ${status.label}. ${status.speech}',
      excludeSemantics: true,
      child: CheOfficePanel(
        width: double.infinity,
        padding: const EdgeInsets.all(CheSpace.md),
        glow: color,
        legacy: BoxDecoration(
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
                      style: cheOfficeLabel(CheType.overline.copyWith(color: color), color: color)),
                  const SizedBox(height: 2),
                  Text(status.speech, style: CheType.caption),
                  if (activity == CheActivity.running) ...[
                    const SizedBox(height: 6),
                    CheChromeProgress(tone: tone, label: status.label),
                  ],
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
        child: CheOfficePanel(
          width: double.infinity,
          margin: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.xs),
          // The glass's corner brackets need a little more room than the old flat border did.
          padding: cheHudActive
              ? const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.md)
              : const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.sm),
          glow: color,
          shadow: true,
          legacy: BoxDecoration(
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
                Flexible(child: Text(lines[3], style: CheType.label.copyWith(color: color))),
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
            Text(title, style: cheOfficeLabel(CheType.overline)),
            Text(body, style: CheType.caption.copyWith(color: color)),
          ]),
        );
    return RepaintBoundary(
      child: CheOfficePanel(
        width: double.infinity,
        padding: EdgeInsets.all(cheHudActive ? CheSpace.lg + 4 : CheSpace.md),
        shadow: true,
        legacy: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('LA AGENCIA • TODAY', style: cheOfficeLabel(CheType.overline.copyWith(color: CheColors.accent)))),
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
        icon: Icon(Icons.volume_up_rounded, size: 20, color: CheColors.accent),
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
            color: selected
                ? CheColors.accent
                : (cheHudActive ? CheHud.ice.withValues(alpha: 0.08) : CheColors.surface),
            borderRadius: BorderRadius.circular(CheRadius.pill),
            border: Border.all(
              color: selected ? CheColors.accent : (cheHudActive ? CheHud.ice.withValues(alpha: 0.40) : CheColors.strokeHi),
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
  const _MeetingTile({required this.meeting, required this.onTap, required this.onReadAloud, required this.onTranscript});
  final CheMeetingSummary meeting;
  final VoidCallback onTap;
  final VoidCallback onReadAloud;
  final VoidCallback onTranscript;
  @override
  Widget build(BuildContext context) {
    const amber = CheColors.markets;
    final tile = ListTile(
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
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(onPressed: onTranscript, child: const Text('Full transcript')),
          ),
        ]),
        trailing: _ReadAloudButton(label: 'Read this meeting aloud', onPressed: onReadAloud),
      );
    if (cheHudActive) {
      return Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.sm),
        child: CheGlass(
          radius: CheRadius.md,
          glow: meeting.live ? amber : null,
          shadow: false,
          child: Material(type: MaterialType.transparency, child: tile),
        ),
      );
    }
    return Card(
      color: CheColors.surfaceHi,
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(CheRadius.md),
        side: BorderSide(color: meeting.live ? amber : CheColors.stroke),
      ),
      child: tile,
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
                      style: cheOfficeLabel(CheType.overline.copyWith(color: CheColors.accent)),
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
              child: CheOfficePanel(
                padding: const EdgeInsets.all(CheSpace.md),
                legacy: BoxDecoration(
                  color: CheColors.surfaceHi,
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: CheColors.strokeHi),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('VERIFIED PRODUCTIVITY', style: cheOfficeLabel(CheType.overline.copyWith(color: CheColors.accent))),
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
            if (p.departmentTitle.isNotEmpty) _Section('DEPARTMENT', '${p.departmentTitle}. Reports to CHE.'),
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
            Text(_isChe ? 'REQUEST TO CHE' : 'MESSAGE ${a.name.toUpperCase()}', style: cheOfficeLabel(CheType.overline)),
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
                icon: Icon(Icons.send_rounded, color: CheColors.accent),
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
              Expanded(child: Text('WORK HISTORY', style: cheOfficeLabel(CheType.overline))),
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
          Text(title, style: cheOfficeLabel(CheType.overline)),
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
    final (tone, activity) = cheTaskStatus(task.status, verified: task.verifiedByChe);
    final (label, _) = switch (task.status) {
      'queued' => ('Queued', CheColors.textDim),
      'running' => ('Working', CheColors.accent),
      'reviewing' => ('CHE reviewing', CheColors.accentAlt),
      'review_pending' => ('Waiting for CHE review', CheColors.accentAlt),
      'needs_review' => ('Not verified yet', CheColors.warning),
      // Tasks finished before CHE's approval became required can still read complete without it.
      'complete' => task.verifiedByChe ? ('Approved by CHE', CheColors.success) : ('Not verified', CheColors.warning),
      'rejected' => ('Rejected by CHE', CheColors.danger),
      'advisory' => ('Input to an answer, not reviewed', CheColors.textDim),
      'blocked' => ('Blocked', CheColors.danger),
      'failed' => ('Failed', CheColors.danger),
      'cancelled' => ('Cancelled', CheColors.textFaint),
      _ => (task.status, CheColors.textDim),
    };
    final tile = ExpansionTile(
        shape: const Border(),
        title: Text(cheShortSummary(task.task),
            maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label, semanticsLabel: task.task),
        subtitle: Row(children: [
          Flexible(child: CheStatusPill(label: label, tone: tone, activity: activity, compact: true, uppercase: false)),
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
            Text('CHE REVIEW', style: cheOfficeLabel(CheType.overline)),
            SelectableText(task.cheReview, style: CheType.bodyDim),
          ],
          if (task.error.isNotEmpty) Text(task.error, style: CheType.caption.copyWith(color: CheColors.danger)),
        ],
      );
    if (cheHudActive) {
      return Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.sm),
        child: CheGlass(
          radius: CheRadius.md,
          shadow: false,
          child: Material(type: MaterialType.transparency, child: tile),
        ),
      );
    }
    return Card(
      color: CheColors.surfaceHi,
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      child: tile,
    );
  }
}

// ─── Operations-center building blocks ──────────────────────────────────

/// A section title with its own manual Read button (nothing on this page reads itself).
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, required this.onRead, required this.readLabel, this.first = false});
  final String title;
  final VoidCallback onRead;
  final String readLabel;
  final bool first;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(top: first ? 0 : CheSpace.xl, bottom: CheSpace.xs),
        child: Row(children: [
          Expanded(
            child: Semantics(
              header: true,
              child: Text(title, style: cheOfficeLabel(CheType.overline.copyWith(color: CheColors.accent), color: CheColors.accent)),
            ),
          ),
          _ReadAloudButton(label: readLabel, onPressed: onRead),
        ]),
      );
}

/// The overview's four real counts.
class _OverviewStats extends StatelessWidget {
  const _OverviewStats({required this.stats});
  final List<(String, int, Color)> stats;

  @override
  Widget build(BuildContext context) => Row(children: [
        for (final (i, (label, n, color)) in stats.indexed) ...[
          if (i > 0) const SizedBox(width: CheSpace.sm),
          Expanded(
            child: Semantics(
              label: '$label: $n',
              excludeSemantics: true,
              child: CheOfficePanel(
                padding: const EdgeInsets.symmetric(vertical: CheSpace.md, horizontal: CheSpace.xs),
                glow: n > 0 ? color : null,
                legacy: BoxDecoration(
                  color: CheColors.surface,
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: n > 0 ? color.withValues(alpha: 0.6) : CheColors.stroke),
                ),
                child: Column(children: [
                  Text('$n', style: CheType.title.copyWith(color: n > 0 ? color : CheColors.textDim)),
                  FittedBox(fit: BoxFit.scaleDown, child: Text(label, maxLines: 1, style: CheType.caption)),
                ]),
              ),
            ),
          ),
        ],
      ]);
}

/// The plain sentence an empty section shows (never a placeholder box).
class _EmptyLine extends StatelessWidget {
  const _EmptyLine(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: CheSpace.xs),
        child: Text(text, style: CheType.bodyDim),
      );
}

/// One tappable record row: a coloured icon, a title and the real detail.
class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.color, required this.title, required this.body, required this.semantics, required this.onTap});
  final IconData icon;
  final Color color;
  final String title;
  final String body;
  final String semantics;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.xs),
        child: Semantics(
          button: true,
          label: semantics,
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.md),
            onTap: () {
              HapticFeedback.selectionClick();
              onTap();
            },
            child: CheOfficeInkPanel(
              padding: const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.sm),
              decoration: BoxDecoration(
                color: CheColors.surface,
                borderRadius: BorderRadius.circular(CheRadius.md),
                border: Border.all(color: color.withValues(alpha: 0.35)),
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 32),
                child: Row(children: [
                  Icon(icon, size: 20, color: color),
                  const SizedBox(width: CheSpace.md),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(fontWeight: FontWeight.w700)),
                      if (body.isNotEmpty) Text(body, maxLines: 3, overflow: TextOverflow.ellipsis, style: CheType.caption),
                    ]),
                  ),
                  Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
                ]),
              ),
            ),
          ),
        ),
      );
}

/// One active project from the Projects board, with its real progress.
class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.item, this.onTap});
  final CheBoardItem item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pct = (item.progress.clamp(0.0, 1.0) * 100).round();
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.xs),
      child: Semantics(
        button: onTap != null,
        label: '${item.title}. ${item.typeLabel}. ${item.statusLabel}. $pct percent.${item.subtitle.isEmpty ? '' : ' ${item.subtitle}.'}',
        excludeSemantics: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(CheRadius.md),
          onTap: onTap,
          child: CheOfficeInkPanel(
            padding: const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.sm),
            decoration: BoxDecoration(
              color: CheColors.surface,
              borderRadius: BorderRadius.circular(CheRadius.md),
              border: Border.all(color: CheColors.stroke),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(fontWeight: FontWeight.w700)),
                ),
                Text('${item.statusLabel} · $pct%', style: CheType.caption.copyWith(color: CheColors.accent)),
              ]),
              Text(item.subtitle.isEmpty ? item.typeLabel : '${item.typeLabel} · ${item.subtitle}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
              const SizedBox(height: 6),
              LinearProgressIndicator(
                value: item.progress.clamp(0.0, 1.0),
                minHeight: 4,
                color: CheColors.accent,
                backgroundColor: CheColors.stroke,
                borderRadius: BorderRadius.circular(99),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
