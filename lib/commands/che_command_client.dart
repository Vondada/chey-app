// Talks to CHE's Command Center routes on the Worker (/api/commands…).
// Every answer is CHE's own; a failure is reported as a failure with CHE's
// reason, never turned into a success on the phone.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'che_command_models.dart';

class CheCommandResult {
  const CheCommandResult({required this.ok, required this.message, this.body = const {}});
  final bool ok;
  final String message;
  final Map<String, dynamic> body;
}

class CheCommandClient {
  CheCommandClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();

  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  static const _timeout = Duration(seconds: 20);

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Future<Map<String, dynamic>> _decode(http.Response response) async {
    // CHE's JSON is UTF-8 ("→", "…"); never let a missing charset turn it into Latin-1.
    Object? decoded;
    try {
      decoded = response.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      decoded = null;
    }
    final body = decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
    if (response.statusCode >= 400) {
      throw CheCommandException(body['detail']?.toString() ?? 'CHE answered ${response.statusCode}.', body);
    }
    return body;
  }

  /// The catalog exactly as CHE sent it (the store caches this JSON).
  Future<Map<String, dynamic>> catalogJson() async {
    if (baseUrl.isEmpty) throw const CheCommandException('CHE is not connected on this iPhone yet.', {});
    final response = await _client.get(_uri('/api/commands'), headers: headers()).timeout(_timeout);
    return _decode(response);
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    if (baseUrl.isEmpty) throw const CheCommandException('CHE is not connected on this iPhone yet.', {});
    final response = await _client
        .post(_uri(path), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(_timeout);
    return _decode(response);
  }

  Future<CheWorkflowPlan> describe(String name, List<CheWorkflowStepDraft> steps) async =>
      CheWorkflowPlan.fromJson(await _post('/api/commands/workflow/describe', {
        'name': name,
        'steps': [for (final s in steps) s.toJson()],
      }));

  Future<(CheSavedWorkflow, List<CheSavedWorkflow>)> save(CheSavedWorkflow workflow) async {
    final body = await _post('/api/commands/workflows/save', workflow.toJson());
    final saved = CheSavedWorkflow.fromJson(Map<String, dynamic>.from(body['workflow'] as Map));
    final all = [
      for (final w in (body['workflows'] as List? ?? const []))
        if (w is Map) CheSavedWorkflow.fromJson(Map<String, dynamic>.from(w)),
    ];
    return (saved, all);
  }

  Future<void> delete(String id) async => _post('/api/commands/workflows/delete', {'id': id});

  /// Starts a workflow on CHE's mission graph. Returns CHE's spoken summary.
  Future<CheCommandResult> run(CheSavedWorkflow workflow) async {
    try {
      final body = await _post('/api/commands/workflow/run', workflow.id.isNotEmpty ? {'id': workflow.id} : workflow.toJson());
      return CheCommandResult(ok: true, message: body['spoken']?.toString() ?? 'Started.', body: body);
    } on CheCommandException catch (e) {
      return CheCommandResult(ok: false, message: e.message, body: e.body);
    }
  }

  /// approve | retry | pause | resume | cancel one workflow run (or step).
  Future<CheCommandResult> control(String missionId, String action, {String? stepId}) async {
    try {
      final body = await _post('/api/commands/workflow/control', {
        'id': missionId,
        'action': action,
        'node_id': ?stepId,
      });
      return CheCommandResult(ok: true, message: body['spoken']?.toString() ?? 'Done.', body: body);
    } on CheCommandException catch (e) {
      return CheCommandResult(ok: false, message: e.message, body: e.body);
    }
  }
}

class CheCommandException implements Exception {
  const CheCommandException(this.message, this.body);
  final String message;
  final Map<String, dynamic> body;
  @override
  String toString() => message.length > 240 ? '${message.substring(0, 240)}…' : message;
}
