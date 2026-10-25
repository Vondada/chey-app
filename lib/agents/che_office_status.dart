// What every Office card says about an agent's work, from real records only (owner, CHE 2.0: "Office employee cards
// showing real work only: Working, Queued, Blocked, Finished or Available").
//
// Sources, strongest first:
//   1. the Office board desk state (GET /api/office/today, office_board.deskStatus: working, queued, stalled,
//      blocked, failed, done, idle), computed on the Worker from persisted team_tasks;
//   2. the agent's latest assignment status (GET /api/agents latest_assignment.status);
//   3. the agent's runtime status (GET /api/agents status).
// Nothing here guesses progress or invents activity. An agent the Worker reports offline says Offline.

import 'package:flutter/material.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';

enum CheWorkState { working, queued, blocked, finished, available, offline }

extension CheWorkStateInfo on CheWorkState {
  String get label => switch (this) {
        CheWorkState.working => 'Working',
        CheWorkState.queued => 'Queued',
        CheWorkState.blocked => 'Blocked',
        CheWorkState.finished => 'Finished',
        CheWorkState.available => 'Available',
        CheWorkState.offline => 'Offline',
      };

  Color get color => switch (this) {
        CheWorkState.working => CheColors.success,
        CheWorkState.queued => const Color(0xFF7FB2FF),
        CheWorkState.blocked => CheColors.danger,
        CheWorkState.finished => CheColors.markets,
        CheWorkState.available => const Color(0xFFB8C4D6),
        CheWorkState.offline => const Color(0xFF6B7280),
      };

  /// Icons from the shipped icon set only (test/fixtures/release_icons.txt).
  IconData get icon => switch (this) {
        CheWorkState.working => Icons.play_arrow_rounded,
        CheWorkState.queued => Icons.schedule_rounded,
        CheWorkState.blocked => Icons.block_rounded,
        CheWorkState.finished => Icons.check_circle_rounded,
        CheWorkState.available => Icons.check_circle_outline_rounded,
        CheWorkState.offline => Icons.cloud_off_outlined,
      };
}

/// The board's desk state (office_board.js) as a card state, or null when unknown.
CheWorkState? cheWorkStateFromBoard(String? state) => switch ((state ?? '').toLowerCase()) {
      'working' || 'running' => CheWorkState.working,
      'queued' => CheWorkState.queued,
      'stalled' || 'blocked' || 'failed' => CheWorkState.blocked,
      'done' || 'complete' => CheWorkState.finished,
      'idle' => CheWorkState.available,
      _ => null,
    };

/// A team_tasks status (agent_runtime.js) as a card state, or null when unknown.
CheWorkState? cheWorkStateFromTask(String? status) => switch ((status ?? '').toLowerCase()) {
      'queued' => CheWorkState.queued,
      'running' || 'reviewing' || 'review_pending' => CheWorkState.working,
      'blocked' || 'failed' || 'rejected' || 'needs_review' => CheWorkState.blocked,
      'complete' => CheWorkState.finished,
      _ => null,
    };

/// One agent's card state from the strongest real source available.
CheWorkState cheWorkStateFor(CheAgent agent, {String? boardState, String assignmentStatus = ''}) {
  if (agent.status == CheAgentStatus.offline) return CheWorkState.offline;
  final board = cheWorkStateFromBoard(boardState);
  if (board != null) return board;
  final task = cheWorkStateFromTask(assignmentStatus);
  if (task != null) return task;
  if (cheAgentIsMoving(agent.status)) return CheWorkState.working;
  return switch (agent.status) {
    CheAgentStatus.waiting => CheWorkState.queued,
    CheAgentStatus.done => CheWorkState.finished,
    _ => CheWorkState.available,
  };
}

/// The line under the name: the real task for that state, or plain availability.
/// [note] is the board's own status line ("Blocked: tool not configured (Codex)"), [job] its job title.
String cheWorkLine(CheWorkState state, CheAgent agent, {String? note, String job = '', String assignmentTask = ''}) {
  final task = [agent.task, job, assignmentTask].map((t) => (t ?? '').trim()).firstWhere((t) => t.isNotEmpty, orElse: () => '');
  final n = (note ?? '').trim();
  return switch (state) {
    CheWorkState.working => task.isEmpty ? (n.isEmpty ? 'Working' : n) : 'Working on: $task',
    CheWorkState.queued => task.isEmpty ? 'Queued' : 'Up next: $task',
    CheWorkState.blocked => n.isNotEmpty ? n : (task.isEmpty ? 'Blocked' : 'Blocked: $task'),
    CheWorkState.finished => n.startsWith('Finished') ? n : (task.isEmpty ? 'Finished' : 'Finished: $task'),
    CheWorkState.available => 'Available for a new task',
    CheWorkState.offline => 'Offline',
  };
}

/// What CHE says for "What are you working on?" on an agent's card. Built from the same real state as the card.
String cheWorkingOnSpeech(CheAgent agent, CheWorkState state, String line) {
  final who = agent.isChe ? 'CHE' : agent.name;
  return switch (state) {
    CheWorkState.available => '$who is available. No task is running or queued.',
    CheWorkState.offline => '$who is offline right now.',
    _ => '$who: ${state.label}. $line.'.replaceAll('..', '.'),
  };
}

// ─── Office zones ──────────────────────────────────────────────────────────

/// The floor plan's zones. Each agent sits in exactly one; CHE has the central office.
enum CheOfficeZone { central, research, warRoom, operations, trading, creative, desks }

extension CheOfficeZoneInfo on CheOfficeZone {
  String get id => switch (this) {
        CheOfficeZone.central => 'central',
        CheOfficeZone.research => 'research',
        CheOfficeZone.warRoom => 'war_room',
        CheOfficeZone.operations => 'operations',
        CheOfficeZone.trading => 'trading',
        CheOfficeZone.creative => 'creative',
        CheOfficeZone.desks => 'desks',
      };

  String get title => switch (this) {
        CheOfficeZone.central => 'CHE Central Office',
        CheOfficeZone.research => 'Brain Lab',
        CheOfficeZone.warRoom => 'War Room',
        CheOfficeZone.operations => 'Business Operations',
        CheOfficeZone.trading => 'Trading Desk',
        CheOfficeZone.creative => 'Creative Studio',
        CheOfficeZone.desks => 'Agent Desks',
      };

  /// What the zone is for, read by VoiceOver and shown in the zone sheet.
  String get purpose => switch (this) {
        CheOfficeZone.central => 'CHE assigns, reviews and reports to you from here.',
        CheOfficeZone.research => 'Research and sourcing. Linked to CHE\'s Brain.',
        CheOfficeZone.warRoom => 'Group meetings where agents plan together and CHE decides.',
        CheOfficeZone.operations => 'Business, clients, coordination and cash flow.',
        CheOfficeZone.trading => 'Paper trading research. Never real money.',
        CheOfficeZone.creative => 'Video, music, design, content and ads.',
        CheOfficeZone.desks => 'Engineering, security and every other agent desk.',
      };

  Color get color => switch (this) {
        CheOfficeZone.central => CheColors.accent,
        CheOfficeZone.research => const Color(0xFF5CC8FF),
        CheOfficeZone.warRoom => CheColors.markets,
        CheOfficeZone.operations => CheColors.business,
        CheOfficeZone.trading => CheColors.success,
        CheOfficeZone.creative => CheColors.create,
        CheOfficeZone.desks => CheColors.office,
      };

  IconData get icon => switch (this) {
        CheOfficeZone.central => Icons.hub_rounded,
        CheOfficeZone.research => Icons.memory_rounded,
        CheOfficeZone.warRoom => Icons.groups_rounded,
        CheOfficeZone.operations => Icons.business_center_rounded,
        CheOfficeZone.trading => Icons.show_chart_rounded,
        CheOfficeZone.creative => Icons.auto_awesome_rounded,
        CheOfficeZone.desks => Icons.workspaces_outline,
      };

  /// The app room this zone leads to, when the host can open it ('brain', 'business', 'trading', 'create').
  String? get room => switch (this) {
        CheOfficeZone.research => 'brain',
        CheOfficeZone.operations => 'business',
        CheOfficeZone.trading => 'trading',
        CheOfficeZone.creative => 'create',
        _ => null,
      };

  /// Words the owner may say for this zone ("take me to the trading desk").
  List<String> get spoken => switch (this) {
        CheOfficeZone.central => ['central office', "che's office", 'che office', "che's desk", 'boss office'],
        CheOfficeZone.research => ['brain lab', 'research lab', 'research zone', 'research desk', 'research area'],
        CheOfficeZone.warRoom => ['war room zone'],
        CheOfficeZone.operations => ['business operations', 'operations zone', 'business zone', 'operations desk', 'ops zone'],
        CheOfficeZone.trading => ['trading desk', 'trading zone', 'trading floor'],
        CheOfficeZone.creative => ['creative studio', 'creative zone', 'creative desk', 'design studio'],
        CheOfficeZone.desks => ['agent desks', 'open floor', 'engineering desks', 'crew desks'],
      };
}

CheOfficeZone? cheOfficeZoneById(String id) {
  for (final z in CheOfficeZone.values) {
    if (z.id == id) return z;
  }
  return null;
}

/// The zone an agent's desk is in, from its real role, specialty and department. The seven core desks keep their
/// known place when their role text says nothing more specific.
CheOfficeZone cheZoneForAgent(CheAgent agent, {String department = ''}) {
  if (agent.isChe) return CheOfficeZone.central;
  // The role (and department) decide first; the specialty only when the role says nothing ("Sourced market research"
  // is a researcher, not a trader).
  for (final hay in ['${agent.role} $department'.toLowerCase(), agent.specialty.toLowerCase()]) {
    final zone = _zoneFromWords(hay);
    if (zone != null) return zone;
  }
  return switch (agent.name.toLowerCase()) {
    'nova' => CheOfficeZone.operations,
    'atlas' => CheOfficeZone.research,
    'mira' || 'lyra' || 'iris' => CheOfficeZone.creative,
    'sage' => CheOfficeZone.trading,
    _ => CheOfficeZone.desks,
  };
}

CheOfficeZone? _zoneFromWords(String hay) {
  if (RegExp(r'trad|market|futures|broker').hasMatch(hay)) return CheOfficeZone.trading;
  if (RegExp(r'secur|engineer|\bcod(e|ing)\b|develop|\bqa\b|\btest').hasMatch(hay)) return CheOfficeZone.desks;
  if (RegExp(r'creative|content|social|video|music|design|copy|\bads?\b|ad studio|\bart\b|film').hasMatch(hay)) return CheOfficeZone.creative;
  if (RegExp(r'research|intel|sourc|analyst|knowledge').hasMatch(hay)) return CheOfficeZone.research;
  if (RegExp(r'business|operation|coordinat|sales|client|financ|stripe|pipeline|deal|\bops\b').hasMatch(hay)) return CheOfficeZone.operations;
  return null;
}
