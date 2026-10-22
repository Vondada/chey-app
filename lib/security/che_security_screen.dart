// More → Security: Security Intelligence on the phone (/api/security). Every line is CHE's real record; nothing
// is estimated here. Face ID runs in iOS (LocalAuthentication); only its yes/no and the method name are sent to CHE,
// never a face template or image. Everything here also works by voice ("run a security check", "security status",
// "revoke my sessions", "disable external dependencies", "lock down CHE").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_account_bridge.dart';

typedef CheBiometricCheck = Future<bool> Function(String reason);

class CheSecurityClient {
  CheSecurityClient({required this.baseUrl, required this.headers, http.Client? client, CheBiometricCheck? biometric})
      : _client = client ?? http.Client(),
        _biometric = biometric ?? ((reason) => CheAccountBridge.authenticate(reason: reason, requireFaceId: true));
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;
  final CheBiometricCheck _biometric;

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final r = await send().timeout(const Duration(seconds: 25));
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return map;
  }

  Future<Map<String, dynamic>> status() => _send(() => _client.get(Uri.parse('$baseUrl/api/security'), headers: headers()));
  Future<Map<String, dynamic>> post(String action, [Map<String, dynamic> body = const {}, String? session]) => _send(() => _client.post(
        Uri.parse('$baseUrl/api/security/$action'),
        headers: {...headers(), 'Content-Type': 'application/json', 'X-CHE-Session': ?session},
        body: jsonEncode(body),
      ));

  /// Face ID → a short CHE session for one scope. Returns null when Face ID fails or is cancelled: nothing is sent.
  /// The request carries only the nonce, the scope and `{ok: true, method: 'face_id'}`.
  Future<String?> faceIdSession(String scope, String reason) async {
    final ok = await _biometric(reason);
    if (!ok) return null;
    final nonce = (await post('nonce'))['nonce'] as String;
    final out = await post('session', {
      'nonce': nonce,
      'scope': [scope],
      'assertion': {'ok': true, 'method': 'face_id'},
    });
    return out['session'] as String?;
  }
}

class CheSecurityScreen extends StatefulWidget {
  const CheSecurityScreen({super.key, required this.client, this.onSpeak, this.onListen});
  final CheSecurityClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheSecurityScreen> createState() => _CheSecurityScreenState();
}

class _CheSecurityScreenState extends State<CheSecurityScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.status();
      if (mounted) setState(() { _view = v; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = 'I could not load security status: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  /// Every action reports its real outcome as large text, a haptic and a VoiceOver announcement.
  Future<void> _run(Future<String> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    String said;
    try {
      said = await action();
      HapticFeedback.mediumImpact();
    } catch (e) {
      said = 'That did not work: ${e.toString().replaceFirst('Exception: ', '')}';
      HapticFeedback.heavyImpact();
    }
    if (!mounted) return;
    setState(() { _busy = false; _status = said; });
    unawaited(SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr));
    unawaited(_load());
  }

  Future<String> _withFaceId(String scope, String reason, Future<String> Function(String session) then) async {
    final session = await widget.client.faceIdSession(scope, reason);
    if (session == null) return 'Face ID did not confirm, so nothing was changed.';
    return then(session);
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final text = Theme.of(context).textTheme;
    final events = [for (final e in (v?['events'] as List? ?? const [])) Map<String, dynamic>.from(e as Map)];
    final status = '${v?['status'] ?? ''}';
    final internalOnly = v?['internal_only'] == true;
    Widget action(IconData icon, String label, Future<String> Function() run) => OutlinedButton.icon(
          icon: Icon(icon),
          label: Text(label),
          onPressed: _busy ? null : () => unawaited(_run(run)),
        );
    return Scaffold(
      appBar: AppBar(title: const Text('Security'), actions: [
        IconButton(tooltip: 'Talk to CHE about security', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
        IconButton(tooltip: 'Reload security status', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
      ]),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: text.titleMedium)))
          : v == null
              ? const Center(child: CircularProgressIndicator(semanticsLabel: 'Loading security status'))
              : ListView(padding: const EdgeInsets.all(16), children: [
                  Semantics(container: true, label: 'Security status. $status', child: ExcludeSemantics(child: Text(status, style: text.titleMedium))),
                  const SizedBox(height: 8),
                  Text(internalOnly ? 'Internal-only mode is on: no external services are called.' : 'External services are allowed when you approve them.', style: text.titleMedium),
                  const SizedBox(height: 12),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    OutlinedButton.icon(
                      icon: const Icon(Icons.record_voice_over_rounded),
                      label: const Text('Read Aloud'),
                      onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(status),
                    ),
                    action(Icons.fact_check_rounded, 'Run Security Check', () async => '${(await widget.client.post('check'))['status']}'),
                    action(Icons.lock_rounded, 'Lock Down CHE', () async { await widget.client.post('lockdown'); return 'Lockdown is on. Remote engines are paused.'; }),
                    action(Icons.block_rounded, 'Revoke Sessions', () async => 'Revoked ${(await widget.client.post('revoke_sessions'))['revoked']} Face ID sessions.'),
                    action(Icons.history_rounded, 'Back Up Trusted State', () async => 'Saved a trusted snapshot, fingerprint ${'${(await widget.client.post('snapshot'))['sha256']}'.substring(0, 12)}.'),
                    if (!internalOnly)
                      action(Icons.shield_outlined, 'Disable External Dependencies', () async { await widget.client.post('external', {'internal_only': true}); return 'Internal-only mode is on.'; })
                    else
                      action(Icons.lock_outline_rounded, 'Allow External Services (Face ID)', () => _withFaceId('external_dependency', 'Allow CHE to use external services again',
                          (s) async { await widget.client.post('external', {'internal_only': false}, s); return 'External services are allowed again, with your approval for each one.'; })),
                    action(Icons.security_rounded, 'Restore Trusted State (Face ID)', () => _withFaceId('restore', 'Restore CHE to its trusted snapshot',
                        (s) async { await widget.client.post('restore', const {}, s); return 'Restored the trusted snapshot.'; })),
                  ]),
                  if (_status.isNotEmpty)
                    Padding(padding: const EdgeInsets.only(top: 12), child: Semantics(liveRegion: true, child: Text(_status, style: text.titleMedium))),
                  const SizedBox(height: 20),
                  Text('Recent events (${events.length})', style: text.titleLarge),
                  for (final e in events.take(40))
                    Semantics(
                      container: true,
                      label: '${e['severity']} ${e['classification']}: ${e['evidence']}',
                      child: ExcludeSemantics(
                        child: ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(e['severity'] == 'high' ? Icons.shield : Icons.shield_outlined),
                          title: Text('${e['evidence']}'),
                          subtitle: Text('${e['severity']} · ${e['classification']} · ${'${e['at']}'.replaceFirst('T', ' ').split('.').first}'),
                        ),
                      ),
                    ),
                ]),
    );
  }
}
