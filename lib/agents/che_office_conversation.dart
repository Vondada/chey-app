// The full Office conversation for one agent or one task (owner rule, 2026-10-26): every message in order with its
// speaker, recipient, time and exact text, the real state, and search and filters. Everything here comes from the
// Worker's GET /api/office/conversation record (server/cloudflare/office_conversation.js). A field the record does
// not have is shown as "Not recorded", never a made-up value.

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';

/// The six states an Office task or agent can show. Exactly these; a queued task is never Running.
enum CheOfficeState { queued, running, waiting, blocked, failed, completed }

extension CheOfficeStateLabel on CheOfficeState {
  String get label => switch (this) {
        CheOfficeState.queued => 'Queued',
        CheOfficeState.running => 'Running',
        CheOfficeState.waiting => 'Waiting',
        CheOfficeState.blocked => 'Blocked',
        CheOfficeState.failed => 'Failed',
        CheOfficeState.completed => 'Completed',
      };

  Color get color => switch (this) {
        CheOfficeState.queued => CheColors.textDim,
        CheOfficeState.running => CheColors.accent,
        CheOfficeState.waiting => CheColors.warning,
        CheOfficeState.blocked => CheColors.danger,
        CheOfficeState.failed => CheColors.danger,
        CheOfficeState.completed => CheColors.success,
      };

  static CheOfficeState? parse(String? label) => switch (label) {
        'Queued' => CheOfficeState.queued,
        'Running' => CheOfficeState.running,
        'Waiting' => CheOfficeState.waiting,
        'Blocked' => CheOfficeState.blocked,
        'Failed' => CheOfficeState.failed,
        'Completed' => CheOfficeState.completed,
        _ => null,
      };
}

/// Mirrors officeTaskState() in server/cloudflare/office_conversation.js, so a stored task status reads the same
/// everywhere in the app. Returns null for an empty or unknown status, so the caller can show the raw value.
CheOfficeState? cheOfficeStateForTaskStatus(String status, {required bool verified}) => switch (status) {
      'queued' => CheOfficeState.queued,
      'running' || 'reviewing' => CheOfficeState.running,
      'review_pending' || 'needs_review' || 'advisory' => CheOfficeState.waiting,
      'complete' => verified ? CheOfficeState.completed : CheOfficeState.waiting,
      'blocked' => CheOfficeState.blocked,
      'failed' || 'rejected' || 'cancelled' => CheOfficeState.failed,
      _ => null,
    };

/// "3 h 12 min ago" from a real timestamp. Passive, plain text; the caller decides where it appears.
String cheTimeAgo(DateTime? at, {DateTime? now}) {
  if (at == null) return 'Not recorded';
  final diff = (now ?? DateTime.now()).toUtc().difference(at.toUtc());
  if (diff.isNegative || diff.inMinutes < 1) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24) {
    final m = diff.inMinutes % 60;
    return m == 0 ? '${diff.inHours} h ago' : '${diff.inHours} h $m min ago';
  }
  final days = diff.inDays;
  return days == 1 ? '1 day ago' : '$days days ago';
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "26 Oct 2026, 05:00 (your time)". Shown in the device's own time zone and labelled as such.
String cheAbsoluteTime(DateTime? at) {
  if (at == null) return 'Time not recorded';
  final l = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.day} ${_months[l.month - 1]} ${l.year}, ${two(l.hour)}:${two(l.minute)} (your time)';
}

DateTime? _time(Object? v) {
  final s = v?.toString() ?? '';
  return s.isEmpty ? null : DateTime.tryParse(s);
}

String _str(Object? v) => v?.toString() ?? '';

class CheConversationTask {
  const CheConversationTask({
    required this.id,
    required this.title,
    required this.state,
    required this.rawStatus,
    required this.reason,
    required this.partnerName,
    required this.verifiedByChe,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;

  /// The whole task text, never shortened.
  final String title;
  final CheOfficeState? state;
  final String rawStatus;
  final String reason;
  final String partnerName;
  final bool verifiedByChe;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  static CheConversationTask fromJson(Map<String, dynamic> j) => CheConversationTask(
        id: _str(j['id']),
        title: _str(j['title']),
        state: CheOfficeStateLabel.parse(j['state']?.toString()),
        rawStatus: _str(j['raw_status']),
        reason: _str(j['reason']),
        partnerName: _str(j['partner_name']),
        verifiedByChe: j['verified_by_che'] == true,
        createdAt: _time(j['created_at']),
        updatedAt: _time(j['updated_at']),
      );
}

class CheConversationBlocker {
  const CheConversationBlocker({required this.title, required this.state, required this.text});
  final String title;
  final CheOfficeState? state;
  final String text;
}

class CheConversationAgent {
  const CheConversationAgent({
    required this.name,
    required this.role,
    required this.status,
    required this.statusRaw,
    required this.statusReason,
    required this.activeTask,
    required this.currentStep,
    required this.lastCompleted,
    required this.nextScheduled,
    required this.blockers,
    required this.lastUpdateAt,
    required this.lastVerifiedAt,
  });

  final String name;
  final String role;

  /// Null when the agent has no task on record yet.
  final CheOfficeState? status;
  final String statusRaw;
  final String statusReason;
  final CheConversationTask? activeTask;
  final String? currentStep;
  final CheConversationTask? lastCompleted;
  final String? nextScheduled;
  final List<CheConversationBlocker> blockers;
  final DateTime? lastUpdateAt;
  final DateTime? lastVerifiedAt;

  static CheConversationAgent fromJson(Map<String, dynamic> j) {
    final active = j['active_task'];
    final done = j['last_completed'];
    final next = j['next_scheduled'];
    return CheConversationAgent(
      name: _str(j['name']),
      role: _str(j['role']),
      status: CheOfficeStateLabel.parse(j['status']?.toString()),
      statusRaw: _str(j['status_raw']),
      statusReason: _str(j['status_reason']),
      activeTask: active is Map<String, dynamic> ? CheConversationTask.fromJson(active) : null,
      currentStep: j['current_step'] == null ? null : _str(j['current_step']),
      lastCompleted: done is Map<String, dynamic> ? CheConversationTask.fromJson(done) : null,
      nextScheduled: next is Map ? _str(next['text']) : null,
      blockers: [
        for (final b in (j['blockers'] as List? ?? const []))
          if (b is Map)
            CheConversationBlocker(
              title: _str(b['title']),
              state: CheOfficeStateLabel.parse(b['state']?.toString()),
              text: _str(b['text']),
            ),
      ],
      lastUpdateAt: _time(j['last_update_at']),
      lastVerifiedAt: _time(j['last_verified_at']),
    );
  }
}

class CheConversationMessage {
  const CheConversationMessage({
    required this.seq,
    required this.kind,
    required this.speaker,
    required this.to,
    required this.at,
    required this.text,
    required this.taskId,
    required this.taskTitle,
    required this.taskState,
    required this.taskRawStatus,
    required this.details,
  });

  final int seq;
  final String kind;
  final String speaker;
  final String to;
  final DateTime? at;
  final String text;
  final String taskId;
  final String taskTitle;
  final CheOfficeState? taskState;
  final String taskRawStatus;
  final Map<String, dynamic> details;

  static CheConversationMessage fromJson(Map<String, dynamic> j) => CheConversationMessage(
        seq: (j['seq'] as num?)?.toInt() ?? 0,
        kind: _str(j['kind']),
        speaker: _str(j['speaker']).isEmpty ? 'Not recorded' : _str(j['speaker']),
        to: _str(j['to']).isEmpty ? 'Not recorded' : _str(j['to']),
        at: _time(j['at']),
        text: _str(j['text']),
        taskId: _str(j['task_id']),
        taskTitle: _str(j['task_title']),
        taskState: CheOfficeStateLabel.parse(j['task_state']?.toString()),
        taskRawStatus: _str(j['task_raw_status']),
        details: j['details'] is Map ? Map<String, dynamic>.from(j['details'] as Map) : const {},
      );

  /// Plain words for the kind, used as the filter and the chip.
  String get kindLabel => switch (kind) {
        'request' => 'Request',
        'steering' => 'Owner steering',
        'handoff' => 'Handoff',
        'prior_result' => 'Earlier result',
        'result' => 'Result',
        'review' => 'CHE review',
        'review_feedback' => 'CHE feedback',
        'error' => 'Error',
        'evidence' => 'Evidence',
        'job_event' => 'Job step',
        'meeting' => 'War Room',
        'meeting_outcome' => 'War Room outcome',
        _ => kind.isEmpty ? 'Message' : kind,
      };
}

/// The filter groups on the screen. A null set means every message.
const Map<String, Set<String>?> cheConversationFilters = {
  'All': null,
  'Requests': {'request', 'steering'},
  'Results': {'result', 'prior_result', 'handoff'},
  'CHE review': {'review', 'review_feedback'},
  'Errors': {'error'},
  'Evidence': {'evidence', 'job_event'},
  'War Room': {'meeting', 'meeting_outcome'},
};

/// True when a message matches the search text in any of its own words. An empty query matches everything.
bool cheConversationMatches(CheConversationMessage m, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  final haystack = [
    m.text,
    m.speaker,
    m.to,
    m.taskTitle,
    m.kindLabel,
    m.taskRawStatus,
    _str(m.details['record_id']),
  ].join('\n').toLowerCase();
  return haystack.contains(q);
}

class CheOfficeConversation {
  const CheOfficeConversation({
    required this.scope,
    required this.agent,
    required this.task,
    required this.tasks,
    required this.messages,
    required this.notes,
    required this.generatedAt,
  });

  /// 'agent' or 'task'.
  final String scope;
  final CheConversationAgent? agent;
  final CheConversationTask? task;
  final List<CheConversationTask> tasks;

  /// Oldest first. The newest message is the last one.
  final List<CheConversationMessage> messages;
  final List<String> notes;
  final DateTime? generatedAt;

  /// Reads the body of GET /api/office/conversation, which is `{ "conversation": {...} }`.
  static CheOfficeConversation fromResponse(Map<String, dynamic> body) {
    final c = body['conversation'];
    if (c is! Map<String, dynamic>) {
      throw const FormatException('The Office conversation record is missing.');
    }
    return fromJson(c);
  }

  static CheOfficeConversation fromJson(Map<String, dynamic> j) => CheOfficeConversation(
        scope: _str(j['scope']),
        agent: j['agent'] is Map<String, dynamic> ? CheConversationAgent.fromJson(j['agent'] as Map<String, dynamic>) : null,
        task: j['task'] is Map<String, dynamic> ? CheConversationTask.fromJson(j['task'] as Map<String, dynamic>) : null,
        tasks: [
          for (final t in (j['tasks'] as List? ?? const []))
            if (t is Map<String, dynamic>) CheConversationTask.fromJson(t),
        ],
        messages: [
          for (final m in (j['messages'] as List? ?? const []))
            if (m is Map<String, dynamic>) CheConversationMessage.fromJson(m),
        ],
        notes: [for (final n in (j['notes'] as List? ?? const [])) '$n'],
        generatedAt: _time(j['generated_at']),
      );
}

/// The agent name in a spoken or typed request to open one Office agent's full conversation, or null.
/// "Open Atlas's conversation", "show me the full conversation with Knox", "read Nova's full conversation".
/// The plural "agent conversations" (every group chat) is a different command and returns null here.
String? cheOfficeConversationAgentName(String text) {
  final t = text
      .trim()
      .replaceAll(RegExp(r'[.!?]+$'), '')
      .replaceAll('’', "'")
      .replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+', caseSensitive: false), '')
      .replaceFirst(RegExp(r'^(?:please|can you|could you)\s+', caseSensitive: false), '');
  const verb = r"(?:open|show|read|pull up|bring up)(?: me)?";
  final possessive = RegExp("^$verb\\s+([a-z][a-z' -]{0,40}?)(?:'s|s')\\s+(?:full |whole |entire )?(?:conversation|chat history|messages)(?: (?:screen|view))?(?: please)?\$",
      caseSensitive: false);
  final withName = RegExp("^$verb\\s+(?:the |a )?(?:full |whole |entire )?(?:conversation|chat history|messages) (?:with|for|of|from) ([a-z][a-z' -]{0,40}?)(?: please)?\$",
      caseSensitive: false);
  final m = possessive.firstMatch(t) ?? withName.firstMatch(t);
  if (m == null) return null;
  final name = m.group(1)!.trim();
  const notAgents = {'the', 'my', 'agent', 'agents', 'the agent', 'my agent', 'ai', 'ais', 'office', 'crew', 'war room', 'everyone', 'all', 'group', 'the agents'};
  if (name.isEmpty || notAgents.contains(name.toLowerCase())) return null;
  return name;
}
