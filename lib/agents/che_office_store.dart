// One store for the Office floor. The roster poll and the board poll both
// feed it; widgets listen to exactly what they draw:
//   • deskOrder   — which desks exist (the floor plan rebuilds only when this changes)
//   • desk(id)    — one ValueNotifier per desk (a status change repaints only that desk)
//   • board       — today's board for the header and the LA AGENCIA panel
//   • warRoom     — live / total meetings for the War Room on the plan
// There is no second poll here: CheAgentRuntimeController keeps polling
// (Stripe webhooks update the server; the 45s board poll is only a backup).

import 'package:flutter/foundation.dart';

import '../che_ui/che_agents.dart';
import 'che_agent_runtime.dart';
import 'che_office_status.dart';

/// What one desk shows: the live agent plus the board's real job status.
@immutable
class CheDeskView {
  const CheDeskView({required this.agent, this.note, this.boardState, this.job = ''});
  final CheAgent agent;

  /// Board status for this desk, e.g. "Blocked: tool not configured (Codex)".
  final String? note;

  /// The board's desk state (office_board.js: working, queued, stalled, blocked, failed, done, idle), when known.
  final String? boardState;

  /// The board's job title for this desk, when it has one.
  final String job;

  String get line => cheDeskLine(agent, note);

  /// Working, Queued, Blocked, Finished, Available (or Offline), from the board first, then the roster.
  CheWorkState get workState => cheWorkStateFor(agent, boardState: boardState);

  /// The card line for [workState]: the real task, or plain availability.
  String get workLine => cheWorkLine(workState, agent, note: note, job: job);

  CheDeskView withNote(String? value) => CheDeskView(agent: agent, note: value, boardState: boardState, job: job);

  CheDeskView withBoard(CheOfficeDesk? desk) => CheDeskView(
        agent: agent,
        note: desk == null || desk.state == 'idle' ? null : desk.status,
        boardState: desk?.state,
        job: desk?.job ?? '',
      );

  @override
  bool operator ==(Object other) =>
      other is CheDeskView &&
      other.note == note &&
      other.boardState == boardState &&
      other.job == job &&
      other.agent.id == agent.id &&
      other.agent.name == agent.name &&
      other.agent.role == agent.role &&
      other.agent.status == agent.status &&
      other.agent.task == agent.task &&
      other.agent.color == agent.color;

  @override
  int get hashCode => Object.hash(agent.id, agent.name, agent.role, agent.status, agent.task, agent.color, note, boardState, job);
}

/// Counts as working on the floor: anything but idle, offline or done.
bool cheAgentIsWorking(CheAgentStatus status) =>
    !const {CheAgentStatus.idle, CheAgentStatus.offline, CheAgentStatus.done}.contains(status);

class CheOfficeStore extends ChangeNotifier {
  CheOfficeStore();

  static const cheId = 'che';

  final ValueNotifier<List<String>> deskOrder = ValueNotifier<List<String>>(const []);
  final ValueNotifier<CheOfficeToday?> board = ValueNotifier<CheOfficeToday?>(null);
  /// Agents whose real state is Working right now (the floor plan's "N working").
  final ValueNotifier<int> working = ValueNotifier<int>(0);
  final ValueNotifier<({int live, int total})> warRoom = ValueNotifier<({int live, int total})>((live: 0, total: 0));

  final Map<String, ValueNotifier<CheDeskView>> _desks = {};
  final Map<String, String> _notesByName = {};
  final Map<String, CheOfficeDesk> _boardByName = {};
  final List<String> _pendingSpeech = [];

  /// The live notifier for one desk (CHE is [cheId]).
  ValueNotifier<CheDeskView>? desk(String id) => _desks[id];

  /// Desk id whose agent matches [name] (case-insensitive), for deep links
  /// from the Brain's live agent orbs. Null when nobody by that name is on
  /// the floor — the caller must say so honestly instead of opening a desk.
  String? deskIdForAgentName(String name) {
    final want = name.trim().toLowerCase();
    if (want.isEmpty) return null;
    for (final entry in _desks.entries) {
      if (entry.value.value.agent.name.toLowerCase() == want) return entry.key;
    }
    return null;
  }

  /// Agent desks in floor order (CHE's own desk is separate, front/center).
  List<String> get agentDeskIds => [for (final id in deskOrder.value) if (id != cheId) id];

  /// Updates desks from the live roster. Only desks whose view changed
  /// notify; the floor layout rebuilds only when desks are added or removed.
  void setRoster(CheAgent che, List<CheAgent> agents) {
    final order = <String>[cheId, for (final a in agents) a.id];
    _put(cheId, che);
    for (final a in agents) {
      _put(a.id, a);
    }
    for (final gone in _desks.keys.where((id) => !order.contains(id)).toList()) {
      _desks.remove(gone)?.dispose();
    }
    _countWorking();
    if (!listEquals(order, deskOrder.value)) {
      deskOrder.value = List.unmodifiable(order);
      notifyListeners();
    }
  }

  /// Sets today's board: header/board panel update, each desk takes its
  /// board status, and any new CHE blocker lines are queued to be spoken.
  void setBoard(CheOfficeToday? today) {
    board.value = today;
    _notesByName
      ..clear()
      ..addAll({
        for (final d in today?.desks ?? const <CheOfficeDesk>[])
          if (d.state != 'idle') d.name: d.status,
      });
    _boardByName
      ..clear()
      ..addAll({for (final d in today?.desks ?? const <CheOfficeDesk>[]) d.name: d});
    for (final entry in _desks.entries) {
      final view = entry.value.value;
      final desk = _boardByName[view.agent.name];
      entry.value.value = desk == null ? view.withNote(_notesByName[view.agent.name]) : view.withBoard(desk);
    }
    _countWorking();
    if (today != null && today.announcements.isNotEmpty) {
      _pendingSpeech.addAll(today.announcements);
    }
    notifyListeners();
  }

  /// Changes one desk's board status without touching any other desk.
  void patchDesk(String id, String status) {
    final n = _desks[id];
    if (n == null) return;
    _notesByName[n.value.agent.name] = status;
    n.value = n.value.withNote(status);
  }

  void setMeetings(List<CheMeetingSummary> meetings) {
    warRoom.value = (live: meetings.where((m) => m.live).length, total: meetings.length);
  }

  /// CHE's unprompted lines (new blockers) not yet spoken. Draining them
  /// means each line is spoken once.
  List<String> takeAnnouncements() {
    final out = List<String>.of(_pendingSpeech);
    _pendingSpeech.clear();
    return out;
  }

  /// Agent desks whose real state is Working (the board first, then the roster), never CHE's own desk.
  void _countWorking() {
    working.value = [for (final e in _desks.entries) if (e.key != cheId) e.value.value]
        .where((v) => v.workState == CheWorkState.working)
        .length;
  }

  void _put(String id, CheAgent agent) {
    final desk = _boardByName[agent.name];
    final view = desk == null
        ? CheDeskView(agent: agent, note: _notesByName[agent.name])
        : CheDeskView(agent: agent).withBoard(desk).withNote(_notesByName[agent.name]);
    final existing = _desks[id];
    if (existing == null) {
      _desks[id] = ValueNotifier<CheDeskView>(view);
    } else {
      existing.value = view; // ValueNotifier skips equal views
    }
  }

  @override
  void dispose() {
    for (final n in _desks.values) {
      n.dispose();
    }
    _desks.clear();
    deskOrder.dispose();
    working.dispose();
    board.dispose();
    warRoom.dispose();
    super.dispose();
  }
}
