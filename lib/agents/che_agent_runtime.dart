// Client for CHE's backend Agent Runtime (server/cloudflare/agent_runtime.js).
//
// The agents run on the server and keep working while the phone is locked.
// This file only mirrors their real state: the roster, each agent's task
// history and War Room meetings. Nothing here invents progress.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_agents.dart';

class CheAgentRuntimeException implements Exception {
  const CheAgentRuntimeException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One delegated task in an agent's history.
class CheAgentTask {
  const CheAgentTask({
    required this.id,
    required this.task,
    required this.status,
    required this.result,
    required this.cheReview,
    required this.verifiedByChe,
    required this.error,
    required this.createdAt,
  });

  final String id;
  final String task;
  final String status; // queued, running, reviewing, complete, failed, cancelled
  final String result;
  final String cheReview;
  final bool verifiedByChe;
  final String error;
  final DateTime? createdAt;

  bool get inProgress => status == 'queued' || status == 'running' || status == 'reviewing';

  static CheAgentTask fromJson(Map<String, dynamic> j) => CheAgentTask(
        id: '${j['id']}',
        task: '${j['task'] ?? ''}',
        status: '${j['status'] ?? ''}',
        result: '${j['result'] ?? ''}',
        cheReview: '${j['che_review'] ?? ''}',
        verifiedByChe: j['verified_by_che'] == true,
        error: '${j['error'] ?? ''}',
        createdAt: DateTime.tryParse('${j['created_at'] ?? ''}'),
      );
}

/// Extra runtime fields the mini-person model doesn't carry.
class CheAgentProfile {
  const CheAgentProfile({
    required this.agent,
    required this.mission,
    required this.responsibilities,
    required this.modelTier,
    required this.temporary,
    this.room = 'office',
    this.activity = 'idle',
    this.working = false,
    this.assignmentId = '',
    this.assignmentTask = '',
    this.assignmentStatus = '',
    this.provider = 'auto',
    this.strengths = const [],
    this.limitations = const [],
    this.capabilityRequirements = const [],
  });

  final CheAgent agent;
  final String mission;
  final List<String> responsibilities;
  final String modelTier; // fast | strong
  final bool temporary;

  /// Where the agent is in CHE's world (office, studio, gallery, music,
  /// lounge), derived on the server from real task state.
  final String room;

  /// making_art, djing, composing, creating, on_break, meeting, idle…
  final String activity;
  final bool working;

  /// Latest real assignment, used for the "got it!" reaction.
  final String assignmentId;
  final String assignmentTask;
  final String assignmentStatus;

  /// Provider family this employee prefers (xai, openai, … or auto).
  final String provider;
  final List<String> strengths;
  final List<String> limitations;
  final List<String> capabilityRequirements;

  static CheAgentProfile fromJson(Map<String, dynamic> j) {
    final loc = j['location'] is Map ? j['location'] as Map : const {};
    final latest = j['latest_assignment'] is Map ? j['latest_assignment'] as Map : const {};
    return CheAgentProfile(
      agent: CheAgent.fromJson(j),
      mission: '${j['mission'] ?? ''}',
      responsibilities: [for (final r in (j['responsibilities'] as List? ?? const [])) '$r'],
      modelTier: '${j['model_tier'] ?? 'fast'}',
      temporary: j['temporary'] == true,
      room: '${loc['room'] ?? 'office'}',
      activity: '${loc['activity'] ?? 'idle'}',
      working: loc['working'] == true,
      assignmentId: '${latest['id'] ?? ''}',
      assignmentTask: '${latest['task'] ?? ''}',
      assignmentStatus: '${latest['status'] ?? ''}',
      provider: '${j['provider_preference'] ?? 'auto'}',
      strengths: [for (final x in (j['strengths'] as List? ?? const [])) '$x'],
      limitations: [for (final x in (j['limitations'] as List? ?? const [])) '$x'],
      capabilityRequirements: [
        for (final x in (j['capability_requirements'] as List? ?? const [])) '$x'
      ],
    );
  }
}

class CheAgentSkill {
  const CheAgentSkill({
    required this.id,
    required this.name,
    this.trigger = '',
    this.capabilities = const [],
    this.sourceRepo = '',
    this.sourcePath = '',
    this.sourceLicense = '',
    this.uses = 0,
  });

  final String id;
  final String name;
  final String trigger;
  final List<String> capabilities;
  final String sourceRepo;
  final String sourcePath;
  final String sourceLicense;
  final int uses;

  static CheAgentSkill fromJson(Map<String, dynamic> j) {
    final source = j['source'] is Map ? j['source'] as Map : const {};
    return CheAgentSkill(
      id: '${j['id'] ?? ''}',
      name: '${j['name'] ?? 'Skill'}',
      trigger: '${j['trigger'] ?? ''}',
      capabilities: [for (final x in (j['capabilities'] as List? ?? const [])) '$x'],
      sourceRepo: '${source['repo'] ?? ''}',
      sourcePath: '${source['path'] ?? ''}',
      sourceLicense: '${source['license'] ?? ''}',
      uses: (j['uses'] as num?)?.toInt() ?? 0,
    );
  }
}

class CheAgentDetail {
  const CheAgentDetail({
    required this.profile,
    required this.history,
    required this.meetings,
    this.skills = const [],
  });
  final CheAgentProfile profile;
  final List<CheAgentTask> history;
  final List<CheMeetingSummary> meetings;
  final List<CheAgentSkill> skills;
}

class CheMeetingSummary {
  const CheMeetingSummary({
    required this.id,
    required this.objective,
    required this.status,
    required this.progress,
    required this.participantNames,
  });

  final String id;
  final String objective;
  final String status; // drafting, cross_check, synthesizing, complete, failed
  final double progress;
  final List<String> participantNames;

  bool get live => status == 'drafting' || status == 'cross_check' || status == 'synthesizing';

  String get statusLabel => switch (status) {
        'drafting' => 'Agents drafting',
        'cross_check' => 'Cross-checking',
        'synthesizing' => 'CHE synthesizing',
        'complete' => 'Final plan ready',
        'failed' => 'Failed',
        _ => status,
      };

  static CheMeetingSummary fromJson(Map<String, dynamic> j) => CheMeetingSummary(
        id: '${j['id']}',
        objective: '${j['objective'] ?? ''}',
        status: '${j['status'] ?? ''}',
        progress: (j['progress'] as num?)?.toDouble() ?? 0,
        participantNames: [
          for (final p in (j['participants'] as List? ?? const []))
            if (p is Map) '${p['name']}',
        ],
      );
}

class CheMeetingPost {
  const CheMeetingPost({required this.from, required this.to, required this.kind, required this.text, this.agentId});
  final String from;
  final String? to;
  final String kind; // brief, draft, critique, synthesis
  final String text;
  final String? agentId;

  static CheMeetingPost fromJson(Map<String, dynamic> j) => CheMeetingPost(
        from: '${j['from'] ?? ''}',
        to: j['to']?.toString(),
        kind: '${j['kind'] ?? ''}',
        text: '${j['text'] ?? ''}',
        agentId: j['agent_id']?.toString(),
      );
}

class CheMeeting {
  const CheMeeting({
    required this.summary,
    required this.participants,
    required this.board,
    required this.decisions,
    required this.conflicts,
    required this.recommendations,
    required this.finalPlan,
    required this.error,
  });

  final CheMeetingSummary summary;
  final List<({String agentId, String name, String role, String responsibility})> participants;
  final List<CheMeetingPost> board;
  final List<String> decisions;
  final List<String> conflicts;
  final List<String> recommendations;
  final String finalPlan;
  final String error;

  static List<String> _strings(Object? v) => [for (final x in (v as List? ?? const [])) '$x'];

  static CheMeeting fromJson(Map<String, dynamic> j) => CheMeeting(
        summary: CheMeetingSummary.fromJson(j),
        participants: [
          for (final p in (j['participants'] as List? ?? const []))
            if (p is Map)
              (
                agentId: '${p['agent_id']}',
                name: '${p['name']}',
                role: '${p['role'] ?? ''}',
                responsibility: '${p['responsibility'] ?? ''}',
              ),
        ],
        board: [
          for (final p in (j['board'] as List? ?? const []))
            if (p is Map<String, dynamic>) CheMeetingPost.fromJson(p),
        ],
        decisions: _strings(j['decisions']),
        conflicts: _strings(j['conflicts']),
        recommendations: _strings(j['recommendations']),
        finalPlan: '${j['final_plan'] ?? ''}',
        error: '${j['error'] ?? ''}',
      );
}


/// One La Agencia desk on the Office board, with its real job status.
class CheOfficeDesk {
  const CheOfficeDesk({required this.id, required this.name, required this.role, required this.state, required this.status, required this.job});
  final String id; // lowercase name for the core roster (knox)
  final String name;
  final String role;
  final String state; // working, queued, blocked, done, failed, idle
  final String status; // spoken/visible line, e.g. "Working: Build checkout"
  final String job;

  static CheOfficeDesk fromJson(Map<String, dynamic> j) => CheOfficeDesk(
        id: '${j['id'] ?? ''}',
        name: '${j['name'] ?? ''}',
        role: '${j['role'] ?? ''}',
        state: '${j['state'] ?? 'idle'}',
        status: '${j['status'] ?? 'Idle'}',
        job: '${j['job'] ?? ''}',
      );
}

/// Today's Office board from GET /api/office/today (persisted jobs + Stripe).
class CheOfficeToday {
  const CheOfficeToday({
    required this.started,
    required this.shipped,
    required this.blockers,
    required this.agentsWorking,
    required this.stripeConnected,
    required this.chargesCents,
    required this.refundsCents,
    required this.netCents,
    this.stalled = const [],
    this.desks = const [],
    this.announcements = const [],
  });
  final List<Map<String, dynamic>> started;
  final List<Map<String, dynamic>> shipped;
  final List<Map<String, dynamic>> blockers;

  /// Live stalled work (blocked, waiting on owner, or no update for a while).
  final List<Map<String, dynamic>> stalled;
  final int agentsWorking;
  final bool stripeConnected;
  final int chargesCents;
  final int refundsCents;
  final int netCents;
  final List<CheOfficeDesk> desks;

  /// New blocker lines CHE says unprompted (server-deduped, spoken once).
  final List<String> announcements;

  int get startedToday => started.length;
  int get builtToday => shipped.length;

  /// Earned today is net of refunds, and exactly $0.00 without Stripe.
  int get earnedTodayCents => stripeConnected ? netCents : 0;

  CheOfficeDesk? deskFor(String name) {
    final key = name.toLowerCase();
    for (final d in desks) {
      if (d.name.toLowerCase() == key || d.id == key) return d;
    }
    return null;
  }

  factory CheOfficeToday.fromJson(Map<String, dynamic> j) {
    final stripe = j['stripe'] is Map ? Map<String, dynamic>.from(j['stripe'] as Map) : <String, dynamic>{};
    List<Map<String, dynamic>> rows(String key) => [for (final x in (j[key] as List? ?? const [])) if (x is Map) Map<String, dynamic>.from(x)];
    return CheOfficeToday(
      started: rows('started'), shipped: rows('shipped'), blockers: rows('blockers'),
      stalled: rows('stalled'),
      agentsWorking: (j['agents_working'] as num?)?.toInt() ?? 0,
      stripeConnected: stripe['connected'] == true,
      chargesCents: (stripe['charges_cents'] as num?)?.toInt() ?? 0,
      refundsCents: (stripe['refunds_cents'] as num?)?.toInt() ?? 0,
      netCents: (stripe['net_cents'] as num?)?.toInt() ?? 0,
      desks: [for (final d in rows('agents')) CheOfficeDesk.fromJson(d)],
      announcements: [for (final a in (j['che_announcements'] as List? ?? const [])) if (a is String && a.isNotEmpty) a],
    );
  }
}

/// How the phone's link to the Office server is doing right now.
enum CheOfficeConnection { live, reconnecting, down }

extension CheOfficeConnectionLabel on CheOfficeConnection {
  String get label => switch (this) {
        CheOfficeConnection.live => 'live',
        CheOfficeConnection.reconnecting => 'reconnecting',
        CheOfficeConnection.down => 'down',
      };
}

/// "$12.50" from cents.
String cheDollars(int cents) {
  final negative = cents < 0;
  final abs = cents.abs();
  return '${negative ? '-' : ''}\$${abs ~/ 100}.${(abs % 100).toString().padLeft(2, '0')}';
}

/// The always-visible Office header, as plain lines (shown and spoken).
List<String> cheOfficeHeaderLines(CheOfficeToday? today, CheOfficeConnection connection) {
  final t = today;
  return [
    'Built today: ${t?.builtToday ?? 0}',
    'Earned today: ${cheDollars(t?.earnedTodayCents ?? 0)}',
    'Agents working: ${t?.agentsWorking ?? 0}',
    'Connection: ${connection.label}',
    if (t != null && t.stripeConnected)
      'Stripe today: charges ${cheDollars(t.chargesCents)}, refunds ${cheDollars(t.refundsCents)}, net ${cheDollars(t.netCents)}'
    else
      '\$0.00 · Stripe not connected',
    if ((t?.stalled.isNotEmpty ?? false)) 'Stalled: ${t!.stalled.length}',
  ];
}

/// The full board, read aloud by CHE: started, finished, Stripe, blockers, desks.
String cheOfficeBoardSpeech(CheOfficeToday? today, CheOfficeConnection connection) {
  final t = today;
  if (t == null) return 'CHE here. The Office board has not loaded yet. Connection ${connection.label}.';
  final money = t.stripeConnected
      ? 'Stripe today: charges ${cheDollars(t.chargesCents)}, refunds ${cheDollars(t.refundsCents)}, net ${cheDollars(t.netCents)}.'
      : 'Stripe not connected. Earned today \$0.00.';
  final blockers = t.blockers.isEmpty
      ? 'No blockers.'
      : 'Blockers: ${t.blockers.map((b) => '${b['agent'] ?? 'An agent'}: ${b['detail'] ?? 'Blocked'}').join('; ')}.';
  final stalled = t.stalled.isEmpty
      ? 'Nothing stalled.'
      : 'Stalled: ${t.stalled.map((b) => '${b['agent'] ?? 'An agent'}: ${b['task'] ?? 'a job'} (${b['detail'] ?? 'stalled'})').join('; ')}.';
  final desks = [for (var i = 0; i < t.desks.length; i++) '${i + 1}. ${t.desks[i].name}: ${t.desks[i].status}'].join('. ');
  return 'CHE here. Office board. Started today ${t.startedToday}. Finished today ${t.builtToday}. '
      '${t.agentsWorking} working. $money $blockers $stalled${desks.isEmpty ? '' : ' Desks: $desks.'} Connection ${connection.label}.';
}

const _codingJobStates = <String>{
  'queued',
  'implemented',
  'pr_open',
  'reviewing',
  'merged',
  'review_rejected',
  'tests_failed',
  'rolled_back',
  'no_change',
  'blocked',
};

/// Latest CHE self-coding state, read from the Worker's compact runtime JSON.
///
/// Unknown strings are intentionally ignored so the Office never invents or
/// guesses a progress state that the coding runtime did not report.
class CheCodingJobStatus {
  const CheCodingJobStatus({
    required this.sessionId,
    required this.state,
    required this.speech,
  });

  final String sessionId;
  final String state;
  final String speech;

  bool get active => const {'queued', 'implemented', 'pr_open', 'reviewing'}.contains(state);

  String get label => switch (state) {
        'queued' => 'Queued',
        'implemented' => 'Implemented',
        'pr_open' => 'PR open',
        'reviewing' => 'Reviewing',
        'approved_waiting_owner' => 'Ready for your approval',
        'merged' => 'Merged',
        'review_rejected' => 'Review rejected',
        'tests_failed' => 'Tests failed',
        'rolled_back' => 'Rolled back',
        'no_change' => 'No change',
        'blocked' => 'Blocked',
        _ => '',
      };

  static CheCodingJobStatus? fromNdjson(String body) {
    final speech = StringBuffer();
    Map<String, dynamic>? done;
    for (final raw in const LineSplitter().convert(body)) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      try {
        final decoded = jsonDecode(line);
        if (decoded is! Map) continue;
        if (decoded['type'] == 'delta') {
          speech.write(decoded['delta']?.toString() ?? '');
        } else if (decoded['type'] == 'done') {
          done = Map<String, dynamic>.from(decoded);
        }
      } catch (_) {
        // A malformed line cannot become owner-facing state.
      }
    }
    final sessionId = done?['session_id']?.toString().trim() ?? '';
    final state = done?['state']?.toString().trim() ?? '';
    if (sessionId.isEmpty || !_codingJobStates.contains(state)) return null;
    final spoken = speech.toString().replaceAll(RegExp(r'\s+'), ' ').trim();
    return CheCodingJobStatus(
      sessionId: sessionId,
      state: state,
      speech: spoken.isEmpty ? 'Coding job: ${state.replaceAll('_', ' ')}.' : spoken,
    );
  }
}

/// Thin HTTP client over the Worker's Agent Runtime API.
class CheAgentRuntimeClient {
  CheAgentRuntimeClient({required this.baseUrl, required this.headers, http.Client? client})
      : _http = client ?? http.Client();

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _http;

  Uri _u(String path) => Uri.parse('${baseUrl()}$path');

  Future<Map<String, dynamic>> _send(String method, String path, [Map<String, dynamic>? body]) async {
    final request = http.Request(method, _u(path))..headers.addAll(headers());
    if (body != null) request.body = jsonEncode(body);
    final response = await http.Response.fromStream(
      await _http.send(request).timeout(const Duration(seconds: 20)),
    );
    Map<String, dynamic> decoded = const {};
    try {
      final raw = jsonDecode(response.body);
      if (raw is Map<String, dynamic>) decoded = raw;
    } catch (_) {}
    if (response.statusCode == 401) {
      throw const CheAgentRuntimeException('Pair this phone with CHE to see the Office.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw CheAgentRuntimeException('${decoded['detail'] ?? 'CHE Agent Runtime error ${response.statusCode}.'}');
    }
    return decoded;
  }

  /// Reads the latest OpenCode job state through the Worker's deterministic
  /// "coding status" route. That route reads `mailbox/runtime/<session>.json`;
  /// this client never derives progress from timers, filenames, or UI guesses.
  Future<CheCodingJobStatus?> codingStatus() async {
    final request = http.Request('POST', _u('/api/chat'))
      ..headers.addAll(headers())
      ..body = jsonEncode({
        'message': 'coding status',
        'history': const <Object>[],
        'owner_mode': true,
        'agent_mode': 'chat',
        'client': const {'platform': 'flutter', 'voice_enabled': false},
      });
    final response = await http.Response.fromStream(
      await _http.send(request).timeout(const Duration(seconds: 20)),
    );
    if (response.statusCode == 401) {
      throw const CheAgentRuntimeException('Pair this phone with CHE to see coding status.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw CheAgentRuntimeException('CHE coding status error ${response.statusCode}.');
    }
    return CheCodingJobStatus.fromNdjson(response.body);
  }

  Future<Map<String, dynamic>> roster() => _send('GET', '/api/agents');

  Future<CheOfficeToday> officeToday() async {
    final j = await _send('GET', '/api/office/today');
    return CheOfficeToday.fromJson(Map<String, dynamic>.from(j['board'] as Map? ?? const {}));
  }

  /// CHE splits an owner goal into Office jobs; returns CHE's spoken reply.
  Future<String> officeGoal(String goal) async {
    final j = await _send('POST', '/api/office/goals', {'goal': goal});
    return '${j['reply'] ?? 'CHE queued the Office jobs.'}';
  }

  /// Pauses queued Office work (same switch as "stand by"). Returns CHE's reply.
  Future<String> standDown() async {
    final j = await _send('POST', '/api/autonomy', {'enabled': false});
    if (j['autonomy'] == true) throw const CheAgentRuntimeException('CHE could not confirm the Office stood down.');
    return 'CHE here. Office standing down. ${j['reply'] ?? ''}'.trim();
  }

  Future<CheAgentDetail> agent(String id) async {
    if (id == 'che') return cheDesk();
    final j = await _send('GET', '/api/agents/$id');
    return CheAgentDetail(
      profile: CheAgentProfile.fromJson(j['agent'] as Map<String, dynamic>),
      history: [
        for (final t in (j['history'] as List? ?? const []))
          if (t is Map<String, dynamic>) CheAgentTask.fromJson(t),
      ],
      meetings: [
        for (final m in (j['meetings'] as List? ?? const []))
          if (m is Map<String, dynamic>) CheMeetingSummary.fromJson(m),
      ],
      skills: [
        for (final skill in (j['skills'] as List? ?? const []))
          if (skill is Map<String, dynamic>) CheAgentSkill.fromJson(skill),
      ],
    );
  }

  /// CHE is not in `data.team` — her desk is built from the roster snapshot
  /// so assign/request UI can open for her the same way as other desks.
  Future<CheAgentDetail> cheDesk() async {
    final j = await roster();
    final c = j['che'] as Map? ?? const {};
    final che = CheAgent.che(
      status: CheAgentStatusLabel.parse(c['status']?.toString()),
      task: c['task']?.toString(),
    );
    final busy = che.status != CheAgentStatus.idle &&
        che.status != CheAgentStatus.offline &&
        che.status != CheAgentStatus.done;
    return CheAgentDetail(
      profile: CheAgentProfile(
        agent: che,
        mission:
            'Primary agent and Office manager. Talk with the owner, split requests into Office jobs, review coworker output, and chair the War Room.',
        responsibilities: const [
          'Talk with the owner',
          'Split requests into Office jobs',
          'Review coworker output',
          'Chair the War Room',
        ],
        modelTier: 'strong',
        temporary: false,
        working: busy,
        assignmentTask: che.task ?? '',
        assignmentStatus: che.task != null ? 'active' : '',
      ),
      history: const [],
      meetings: [
        for (final m in (j['meetings'] as List? ?? const []))
          if (m is Map<String, dynamic>) CheMeetingSummary.fromJson(m),
      ],
    );
  }

  Future<CheAgent> createAgent({
    required String role,
    String? name,
    String specialty = '',
    String personality = '',
    bool temporary = false,
    String? task,
  }) async {
    final j = await _send('POST', '/api/agents', {
      'role': role,
      if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
      'specialty': specialty,
      'personality': personality,
      'temporary': temporary,
      if (task != null && task.trim().isNotEmpty) 'task': task.trim(),
    });
    return CheAgent.fromJson(j['agent'] as Map<String, dynamic>);
  }

  Future<void> assignTask(String agentId, String task) => _send('POST', '/api/agents/$agentId/task', {'task': task});

  Future<void> patchAgent(String agentId, Map<String, dynamic> body) => _send('PATCH', '/api/agents/$agentId', body);

  Future<CheMeeting> convene(String objective, {List<String>? agentIds}) async {
    final j = await _send('POST', '/api/meetings', {
      'objective': objective,
      if (agentIds != null && agentIds.isNotEmpty) 'agent_ids': agentIds,
    });
    return CheMeeting.fromJson(j['meeting'] as Map<String, dynamic>);
  }

  /// Office world size level (1–3), stored on the server.
  Future<int> officeWorldLevel() async {
    final j = await _send('GET', '/api/office/world');
    return (j['level'] as num?)?.toInt() ?? 1;
  }

  Future<int> setOfficeWorldLevel(int level) async {
    final j = await _send('POST', '/api/office/world', {'level': level});
    return (j['level'] as num?)?.toInt() ?? level;
  }

  /// Tells the server the owner is (not) watching in CHE's Theater, so free
  /// Office agents take (or leave) the Theater seats.
  Future<void> setTheaterWatching(bool watching) => _send('POST', '/api/theater', {'watching': watching});

  /// Saves captions CHE saw in the Theater, so she can talk about the movie.
  Future<void> saveTheaterNotes(String title, String host, List<Map<String, Object>> lines) =>
      _send('POST', '/api/theater/notes', {'title': title, 'host': host, 'lines': lines});

  /// Learns a YouTube video into CHE's searchable Library. The Worker first
  /// tries the video's public caption track; these live captions are fallback.
  Future<Map<String, dynamic>> learnYouTube({
    required String url,
    required String title,
    required List<Map<String, Object>> captions,
    String? frameBase64,
  }) => _send('POST', '/api/youtube/learn', {
        'url': url,
        'title': title,
        'captions': captions,
        if (frameBase64 != null && frameBase64.isNotEmpty) 'frame_base64': frameBase64,
      });

  /// Real Workshop world: live Office work, trophies and saved character looks.
  Future<Map<String, dynamic>> workshop() => _send('GET', '/api/office/workshop');

  Future<Map<String, dynamic>> saveWorkshopAvatar(String agentId, Map<String, String> appearance) =>
      _send('POST', '/api/office/workshop/avatar', {'agent_id': agentId, 'appearance': appearance});

  /// CHE's universal AI layer overview (providers, models, health, privacy).
  /// Contains connection states only, never credential values.
  Future<Map<String, dynamic>> aiOverview() => _send('GET', '/api/ai/overview');

  Future<CheMeeting> meeting(String id) async {
    final j = await _send('GET', '/api/meetings/$id');
    return CheMeeting.fromJson(j['meeting'] as Map<String, dynamic>);
  }
}

/// Mirrors the live roster. Polls quickly while work is running and slowly
/// when the Office is quiet; stops when no screen is listening.
class CheAgentRuntimeController extends ChangeNotifier {
  CheAgentRuntimeController(this.client);

  final CheAgentRuntimeClient client;

  CheAgent che = CheAgent.che();
  List<CheAgentProfile> agents = const [];
  List<CheMeetingSummary> meetings = const [];
  int working = 0;
  CheOfficeToday? today;
  CheCodingJobStatus? codingJob;
  String? error;
  bool loaded = false;
  int _failures = 0;

  /// live after a good refresh; reconnecting for up to two misses; then down.
  CheOfficeConnection get connection {
    if (!loaded) return CheOfficeConnection.reconnecting;
    if (_failures == 0) return CheOfficeConnection.live;
    return _failures < 3 ? CheOfficeConnection.reconnecting : CheOfficeConnection.down;
  }

  Timer? _timer;
  Timer? _boardTimer;
  Timer? _codingTimer;
  bool _disposed = false;

  bool get busy => working > 0 || che.status != CheAgentStatus.idle || meetings.any((m) => m.live);

  void start() {
    if (_timer != null) return;
    unawaited(refresh());
    unawaited(refreshBoard());
    unawaited(refreshCodingStatus());
    // Stripe webhooks update the server immediately; this poll is the backup.
    _boardTimer = Timer.periodic(const Duration(seconds: 45), (_) => unawaited(refreshBoard()));
    // Coding state is cheap/deterministic and changes during CI/review, so keep
    // it fresher than the money/board snapshot while the Office is open
    // (each poll is one GitHub read in the Worker, so not faster than 20s).
    _codingTimer = Timer.periodic(const Duration(seconds: 20), (_) => unawaited(refreshCodingStatus()));
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _boardTimer?.cancel();
    _boardTimer = null;
    _codingTimer?.cancel();
    _codingTimer = null;
  }

  void _schedule() {
    _timer?.cancel();
    if (_disposed) return;
    _timer = Timer(busy ? const Duration(milliseconds: 1500) : const Duration(seconds: 6), () => unawaited(refresh()));
  }

  Future<void> refresh() async {
    try {
      final j = await client.roster();
      final c = j['che'] as Map? ?? const {};
      che = CheAgent.che(
        status: CheAgentStatusLabel.parse(c['status']?.toString()),
        task: c['task']?.toString(),
      );
      agents = [
        for (final a in (j['agents'] as List? ?? const []))
          if (a is Map<String, dynamic>) CheAgentProfile.fromJson(a),
      ];
      meetings = [
        for (final m in (j['meetings'] as List? ?? const []))
          if (m is Map<String, dynamic>) CheMeetingSummary.fromJson(m),
      ];
      working = (j['working'] as num?)?.toInt() ?? 0;
      error = null;
      _failures = 0;
    } catch (e) {
      error = e.toString();
      _failures++;
    }
    loaded = true;
    if (_disposed) return;
    notifyListeners();
    _schedule();
  }

  Future<void> refreshBoard() async {
    try {
      today = await client.officeToday();
      if (!_disposed) notifyListeners();
    } catch (_) {
      // Board/Stripe is supplemental. Never let it take the live roster down.
    }
  }

  Future<void> refreshCodingStatus() async {
    try {
      final next = await client.codingStatus();
      if (_disposed) return;
      final changed = next?.sessionId != codingJob?.sessionId ||
          next?.state != codingJob?.state ||
          next?.speech != codingJob?.speech;
      codingJob = next;
      if (changed) notifyListeners();
    } catch (_) {
      // Coding status is supplemental. Keep the last verified state instead of
      // replacing it with an invented "offline" or "failed" status.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }
}
