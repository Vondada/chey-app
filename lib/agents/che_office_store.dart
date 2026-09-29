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

/// What one desk shows: the live agent plus the board's real job status.
@immutable
class CheDeskView {
  const CheDeskView({required this.agent, this.note});
  final CheAgent agent;

  /// Board status for this desk, e.g. "Blocked: tool not configured (Codex)".
  final String? note;

  String get line => cheDeskLine(agent, note);

  CheDeskView withNote(String? value) => CheDeskView(agent: agent, note: value);

  @override
  bool operator ==(Object other) =>
      other is CheDeskView &&
      other.note == note &&
      other.agent.id == agent.id &&
      other.agent.name == agent.name &&
      other.agent.role == agent.role &&
      other.agent.status == agent.status &&
      other.agent.task == agent.task &&
      other.agent.color == agent.color;

  @override
  int get hashCode => Object.hash(agent.id, agent.name, agent.role, agent.status, agent.task, agent.color, note);
}

/// Counts as working on the floor: anything but idle, offline or done.
bool cheAgentIsWorking(CheAgentStatus status) =>
    !const {CheAgentStatus.idle, CheAgentStatus.offline, CheAgentStatus.done}.contains(status);

class CheOfficeStore extends ChangeNotifier {
  CheOfficeStore();

  static const cheId = 'che';

  final ValueNotifier<List<String>> deskOrder = ValueNotifier<List<String>>(const []);
  final ValueNotifier<CheOfficeToday?> board = ValueNotifier<CheOfficeToday?>(null);
  /// Agents actually doing work right now (the floor plan's "N working").
  final ValueNotifier<int> working = ValueNotifier<int>(0);
  final ValueNotifier<({int live, int total})> warRoom = ValueNotifier<({int live, int total})>((live: 0, total: 0));

  final Map<String, ValueNotifier<CheDeskView>> _desks = {};
  final Map<String, String> _notesByName = {};
  final List<String> _pendingSpeech = [];

  /// The live notifier for one desk (CHE is [cheId]).
  ValueNotifier<CheDeskView>? desk(String id) => _desks[id];

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
    working.value = agents.where((a) => cheAgentIsWorking(a.status)).length;
    for (final gone in _desks.keys.where((id) => !order.contains(id)).toList()) {
      _desks.remove(gone)?.dispose();
    }
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
    for (final entry in _desks.entries) {
      final view = entry.value.value;
      entry.value.value = view.withNote(_notesByName[view.agent.name]);
    }
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

  void _put(String id, CheAgent agent) {
    final view = CheDeskView(agent: agent, note: _notesByName[agent.name]);
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
