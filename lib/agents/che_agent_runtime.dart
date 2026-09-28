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
  });

  final CheAgent agent;
  final String mission;
  final List<String> responsibilities;
  final String modelTier; // fast | strong
  final bool temporary;

  static CheAgentProfile fromJson(Map<String, dynamic> j) => CheAgentProfile(
        agent: CheAgent.fromJson(j),
        mission: '${j['mission'] ?? ''}',
        responsibilities: [for (final r in (j['responsibilities'] as List? ?? const [])) '$r'],
        modelTier: '${j['model_tier'] ?? 'fast'}',
        temporary: j['temporary'] == true,
      );
}

class CheAgentDetail {
  const CheAgentDetail({required this.profile, required this.history, required this.meetings});
  final CheAgentProfile profile;
  final List<CheAgentTask> history;
  final List<CheMeetingSummary> meetings;
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

  Future<Map<String, dynamic>> roster() => _send('GET', '/api/agents');

  Future<CheAgentDetail> agent(String id) async {
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
  String? error;
  bool loaded = false;

  Timer? _timer;
  bool _disposed = false;

  bool get busy => working > 0 || che.status != CheAgentStatus.idle || meetings.any((m) => m.live);

  void start() {
    if (_timer != null) return;
    unawaited(refresh());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
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
    } catch (e) {
      error = e.toString();
    }
    loaded = true;
    if (_disposed) return;
    notifyListeners();
    _schedule();
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }
}
