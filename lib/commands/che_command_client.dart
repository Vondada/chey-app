// Talks to CHE's Command Center routes on the Worker (/api/commands…).
// Every answer is CHE's own; a failure is reported as a failure with CHE's
// reason, never turned into a success on the phone.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'che_command_models.dart';
import 'che_rea_models.dart';

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

  /// Every request goes through here, so a timeout or a dropped connection
  /// becomes a CheCommandException the page reports, never an uncaught error
  /// that leaves its controls disabled.
  Future<Map<String, dynamic>> _send(Future<http.Response> Function() request) async {
    if (baseUrl.isEmpty) throw const CheCommandException('CHE is not connected on this iPhone yet.', {});
    final http.Response response;
    try {
      response = await request().timeout(_timeout);
    } on TimeoutException {
      throw const CheCommandException('CHE did not answer within 20 seconds', {});
    } on http.ClientException catch (e) {
      throw CheCommandException('the connection failed (${e.message})', const {});
    } on Exception {
      // Socket and TLS errors the HTTP client did not wrap.
      throw const CheCommandException('the connection failed', {});
    }
    return _decode(response);
  }

  /// The catalog exactly as CHE sent it (the store caches this JSON).
  Future<Map<String, dynamic>> catalogJson() => _send(() => _client.get(_uri('/api/commands'), headers: headers()));

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) => _send(
      () => _client.post(_uri(path), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body)));

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

  // ── REA investigations (read only; actions are chat commands) ─────────

  /// GET /api/rea/investigations: newest first, with REA's capabilities.
  Future<CheReaInvestigationList> reaInvestigations() async =>
      CheReaInvestigationList.fromJson(await _send(() => _client.get(_uri('/api/rea/investigations'), headers: headers())));

  /// `GET /api/rea/investigations/<id>`. A missing record is CHE's 404 reason.
  Future<CheReaInvestigation> reaInvestigation(String id) async {
    final body = await _send(() => _client.get(_uri('/api/rea/investigations/${Uri.encodeComponent(id)}'), headers: headers()));
    final record = body['investigation'];
    if (record is! Map) throw CheCommandException('CHE sent no record for investigation $id.', body);
    return CheReaInvestigation.fromJson(Map<String, dynamic>.from(record));
  }

  static final _safeName = RegExp(r'^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$');

  /// Where one captured screenshot is served (`GET /api/rea/files/<id>/<file>`),
  /// or null when CHE is not connected or a name could leave that folder.
  /// Load it with [reaFileHeaders]: the same paired-device headers as every
  /// other request.
  Uri? reaFileUri(String investigationId, String file) {
    if (baseUrl.isEmpty || !_safeName.hasMatch(investigationId) || !_safeName.hasMatch(file) || file.contains('..')) return null;
    return _uri('/api/rea/files/$investigationId/$file');
  }

  Map<String, String> reaFileHeaders() => headers();

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
