// SECURITY: the command center over CHE's Security Core (/api/security/core) and Security Intelligence
// (/api/security). Opened from Home, from More and by voice ("open security"). Every line is CHE's real record;
// nothing is estimated here, and anything from a drill is labelled SIMULATION. Face ID runs in iOS (LocalAuthentication); only its yes/no and the method name are sent to CHE,
// never a face template or image. Everything here also works by voice ("run a security check", "security status",
// "security readiness", "preview lockdown", "run a security drill", "revoke my sessions", "lock down CHE").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_account_bridge.dart';
import 'che_cyber_world.dart';
import 'che_security_panels.dart';
import 'che_security_visibility.dart';

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

  /// The Security Core view; null when this CHE server has no core yet (older deploy), so the page falls back.
  Future<Map<String, dynamic>?> core() async {
    try {
      final v = await _send(() => _client.get(Uri.parse('$baseUrl/api/security/core'), headers: headers()));
      return v['core'] is Map ? v : null;
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> corePost(String action, [Map<String, dynamic> body = const {}]) => post('core/$action', body);

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


/// Which Cyber World node a drill's labelled pulse is drawn on.
const _drillNode = {
  'leaked_credential': 'worker',
  'pairing_flood': 'worker',
  'malicious_dependency': 'repository',
  'unexpected_deploy': 'worker',
  'unreviewed_capability': 'capabilities',
};

const _stateColors = {
  'MONITORING': Color(0xFF3DD6D0),
  'INVESTIGATING': Color(0xFFFFB547),
  'CONTAINING': Color(0xFFFF5C6C),
  'RECOVERING': Color(0xFFB794F6),
  'SECURED': Color(0xFF3DDC97),
};

class CheSecurityScreen extends StatefulWidget {
  const CheSecurityScreen({super.key, required this.client, this.onSpeak, this.onListen, this.initialSection, this.onOpenAgent});
  final CheSecurityClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  /// A visibility category to open once loaded ("agents", "threats", …), from "open security access" by voice.
  final String? initialSection;

  /// Opens an Office agent's desk by name (Knox, the Security Chief): the same record as the Office.
  final ValueChanged<String>? onOpenAgent;

  @override
  State<CheSecurityScreen> createState() => _CheSecurityScreenState();
}

class _CheSecurityScreenState extends State<CheSecurityScreen> {
  Map<String, dynamic>? _view;
  Map<String, dynamic>? _core;
  Map<String, dynamic>? _preview;
  String? _simulationNode;
  String? _error;
  String _status = '';
  bool _busy = false;

  Object? _voice;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // "Show tools", "open physical security": the Security Room's lists by voice. A category page pushed on top
    // registers its own handler, which takes over until it closes.
    _voice = CheSecurityRoomVoice.register(_onVoice);
  }

  @override
  void dispose() {
    CheSecurityRoomVoice.unregister(_voice);
    super.dispose();
  }

  Future<String?> _onVoice(String said) async {
    final v = _visibility;
    if (v == null) return null;
    if (RegExp(r'^(?:open|show|go to)(?: the| my)? physical security(?: page)?[.!]?$', caseSensitive: false).hasMatch(said.trim()) && v['physical'] is Map) {
      unawaited(Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheSecurityPhysicalScreen(physical: Map<String, dynamic>.from(v['physical'] as Map)))));
      final p = Map<String, dynamic>.from(v['physical'] as Map);
      return 'Opening Physical Security. ${p['headline']}. ${p['note'] ?? ''}'.trim();
    }
    final cats = [for (final c in (v['categories'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    final id = CheSecurityRoomVoice.categoryFor(said, cats);
    if (id == null) return null;
    final cat = cats.firstWhere((c) => c['id'] == id);
    _openCategory(id);
    return 'Opening ${cat['title']}: ${cat['count']}. Say read the list, search for a name, or read number 1.';
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([widget.client.status(), widget.client.core()]);
      if (mounted) setState(() { _view = results[0]; _core = results[1]; _error = null; });
      final want = widget.initialSection;
      if (!_openedInitial && want != null && mounted && _visibility != null && want != 'chief') {
        _openedInitial = true;
        _openCategory(want);
      }
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

  Future<String> _check() async {
    if (_core == null) return '${(await widget.client.post('check'))['status']}';
    final r = await widget.client.corePost('check');
    return '${r['spoken'] ?? r['status'] ?? 'Security check finished.'}';
  }

  Future<String> _previewLockdown() async {
    final r = await widget.client.corePost('lockdown/preview');
    final p = Map<String, dynamic>.from(r['preview'] as Map);
    setState(() => _preview = p);
    return CheLockdownPreview.spoken(p);
  }

  Future<String> _confirmLockdown() async {
    final p = _preview;
    if (p == null) return 'Preview lockdown first.';
    final r = await widget.client.corePost('lockdown/confirm', {'token': p['token'], 'confirm': true});
    setState(() => _preview = null);
    return r['locked'] == true ? 'Lockdown is on and confirmed. Remote engines are paused; say "end lockdown" to resume.' : 'Lockdown could not be confirmed.';
  }

  Future<String> _drill(String id, String name) async {
    final r = await widget.client.corePost('simulate', {'scenario': id});
    setState(() => _simulationNode = _drillNode[id] ?? 'worker');
    final frames = ((r['replay'] as Map?)?['frames'] as List?)?.length ?? 0;
    return 'SIMULATION: $name. It ran in an isolated sandbox and touched no real system; $frames steps from detected to resolved.';
  }

  Future<void> _replay(String incidentId) async {
    try {
      final r = await widget.client.corePost('replay', {'incident_id': incidentId});
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => CheIncidentReplayScreen(replay: Map<String, dynamic>.from(r['replay'] as Map), onSpeak: widget.onSpeak),
      ));
    } catch (e) {
      if (mounted) setState(() => _status = 'That replay did not open: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  bool _openedInitial = false;

  Map<String, dynamic>? get _visibility => _core?['visibility'] is Map ? Map<String, dynamic>.from(_core!['visibility'] as Map) : null;

  void _openCategory(String id) {
    final v = _visibility;
    if (v == null) return;
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheSecurityCategoryScreen(visibility: v, initial: id))));
  }

  List<Widget> _visibilitySections(Map<String, dynamic> c) {
    final v = _visibility;
    final chief = c['chief'] is Map ? Map<String, dynamic>.from(c['chief'] as Map) : null;
    final text = Theme.of(context).textTheme;
    return [
      if (chief != null) ...[CheSecurityChiefCard(chief: chief, onOpenAgent: widget.onOpenAgent), const SizedBox(height: 12)],
      if (v != null) ...[
        Semantics(header: true, child: Text('What CHE can access', style: text.titleLarge)),
        const SizedBox(height: 6),
        CheSecurityCounts(visibility: v, onOpen: _openCategory),
        const SizedBox(height: 12),
        if (v['coverage'] is Map) CheSecurityCoverageCard(coverage: Map<String, dynamic>.from(v['coverage'] as Map)),
        if (v['physical'] is Map)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              icon: const Icon(Icons.videocam_outlined),
              label: Text('Physical Security: ${(v['physical'] as Map)['headline'] ?? ''}'),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheSecurityPhysicalScreen(physical: Map<String, dynamic>.from(v['physical'] as Map)))),
            ),
          ),
        const SizedBox(height: 12),
      ],
    ];
  }

  List<Map<String, dynamic>> _list(Object? v) => [for (final e in (v as List? ?? const [])) Map<String, dynamic>.from(e as Map)];

  /// One collapsible section with its count in the header; VoiceOver hears the title and count.
  Widget _section(String title, int count, List<Widget> children, {String? empty}) => Semantics(
        container: true,
        label: '$title, $count',
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('$title ($count)', style: Theme.of(context).textTheme.titleMedium),
          children: children.isEmpty ? [ListTile(contentPadding: EdgeInsets.zero, title: Text(empty ?? 'Nothing recorded.'))] : children,
        ),
      );

  Widget _eventTile(Map<String, dynamic> e) => Semantics(
        container: true,
        label: '${e['severity']} ${e['status']}: ${e['summary']}',
        child: ExcludeSemantics(
          child: ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(['high', 'critical'].contains(e['severity']) ? Icons.shield : Icons.shield_outlined),
            title: Text('${e['summary']}'),
            subtitle: Text('${e['severity']} · ${e['status']} · ${'${e['timestamp']}'.replaceFirst('T', ' ').split('.').first}'),
          ),
        ),
      );

  Widget _incidentTile(Map<String, dynamic> i) {
    final sim = i['simulation'] == true;
    final label = '${sim ? 'SIMULATION. ' : ''}${i['title']}, ${i['severity']}, ${'${i['stage']}'.toLowerCase()}';
    return Semantics(
      container: true,
      label: label,
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(sim ? Icons.science_outlined : Icons.warning_amber),
        title: ExcludeSemantics(child: Text('${sim ? 'SIMULATION · ' : ''}${i['title']}')),
        subtitle: ExcludeSemantics(child: Text('${i['severity']} · ${i['stage']}')),
        trailing: TextButton(onPressed: () => unawaited(_replay('${i['incident_id']}')), child: Text('Replay', semanticsLabel: 'Replay ${i['title']}')),
      ),
    );
  }

  List<Widget> _coreSections(Map<String, dynamic> c) {
    final text = Theme.of(context).textTheme;
    final defense = Map<String, dynamic>.from(c['defense'] as Map? ?? const {});
    final sections = Map<String, dynamic>.from(c['sections'] as Map? ?? const {});
    final active = _list(defense['active']);
    final recent = _list(defense['recent']);
    final systems = [for (final n in _list(c['systems'])) CheWorldNode.fromJson(n)];
    final access = Map<String, dynamic>.from(c['access'] as Map? ?? const {});
    final principals = _list(access['principals']);
    final findings = _list((access['review'] as Map?)?['findings']);
    final backups = Map<String, dynamic>.from(c['backups'] as Map? ?? const {});
    final knowledge = Map<String, dynamic>.from(c['knowledge'] as Map? ?? const {});
    final policies = _list((c['policies'] as Map?)?['list']);
    final sims = Map<String, dynamic>.from(c['simulations'] as Map? ?? const {});
    final scenarios = _list(sims['scenarios']);
    final recentSims = _list(sims['recent']);
    final physical = Map<String, dynamic>.from(c['physical'] as Map? ?? const {});
    List<Widget> events(String k) => [for (final e in _list(sections[k])) _eventTile(e)];
    return [
      _section('Active Defense', active.length, [for (final i in active) _incidentTile(i)], empty: 'No open incidents.'),
      _section('Recent Defense', recent.length, [for (final i in recent) _incidentTile(i)], empty: 'No resolved incidents yet.'),
      _section('Systems', systems.length, [
        for (final n in systems) Semantics(container: true, label: n.spoken, child: ExcludeSemantics(child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.circle, color: cheWorldStatusColor(n.status)), title: Text(n.label), subtitle: Text('${cheWorldStatusWord(n.status)}${n.detail.isEmpty ? '' : ' · ${n.detail}'}')))),
        Semantics(container: true, label: '${physical['note'] ?? ''}', child: ExcludeSemantics(child: ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.devices_other_rounded), title: const Text('Physical security'), subtitle: Text('${physical['note'] ?? 'No physical devices are connected.'}')))),
      ]),
      _section('Threats', _list(sections['threats']).length, events('threats'), empty: 'No threat events.'),
      _section('Access', principals.length, [
        Text('${principals.length} agents, tools, apps and devices; ${findings.length} least-privilege finding${findings.length == 1 ? '' : 's'}.', style: text.bodyLarge),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.verified_user_rounded),
            label: const Text('Open Access Control'),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheSecurityAccessScreen(access: access, onSpeak: widget.onSpeak))),
          ),
        ),
      ]),
      _section('Identity', _list(sections['identity']).length, events('identity'), empty: 'No identity events.'),
      _section('Code', _list(sections['code']).length, events('code'), empty: 'No code or deployment events.'),
      _section('Dependencies', _list(sections['dependencies']).length, events('dependencies'), empty: 'No dependency advisories matched.'),
      _section('Secrets', _list(sections['secrets']).length, events('secrets'), empty: 'No credential exposures recorded.'),
      _section('Malware', _list(sections['malware']).length, events('malware'), empty: 'No malware findings.'),
      _section('Backups', backups['last_snapshot_at'] == null ? 0 : 1, [
        Text(backups['last_snapshot_at'] == null ? 'No trusted snapshot yet. Use Back Up Trusted State.' : 'Last trusted snapshot ${'${backups['last_snapshot_at']}'.replaceFirst('T', ' ').split('.').first}, fingerprint ${backups['fingerprint']}.', style: text.bodyLarge),
      ]),
      _section('Knowledge', _list(knowledge['shared']).length + _list(knowledge['private']).length, [
        for (final k in _list(knowledge['shared'])) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.public_rounded), title: Text('${k['title']}'), subtitle: Text('${k['portability']} · ${k['lesson']}')),
        for (final k in _list(knowledge['private'])) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.lock_outline_rounded), title: Text('${k['title']}'), subtitle: Text('${k['portability']} · ${k['stage']}')),
      ], empty: 'No security knowledge recorded yet.'),
      _section('Policies', policies.length, [
        for (final p in policies) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.gavel_rounded), title: Text('${p['rule']}')),
      ]),
      _section('Simulations', recentSims.length, [
        Text('Drills run in an isolated sandbox, are labelled SIMULATION and never touch a real system.', style: text.bodyLarge),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final s in scenarios)
            OutlinedButton.icon(
              icon: const Icon(Icons.science_outlined),
              label: Text('Run Drill: ${s['name']}'),
              onPressed: _busy ? null : () => unawaited(_run(() => _drill('${s['id']}', '${s['name']}'))),
            ),
        ]),
        for (final s in recentSims)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.science_outlined),
            title: Text('SIMULATION · ${s['name']}'),
            trailing: TextButton(onPressed: () => unawaited(_replay('${s['incident_id']}')), child: Text('Replay', semanticsLabel: 'Replay simulation ${s['name']}')),
          ),
      ]),
    ];
  }

  Widget _protection(Map<String, dynamic> c) {
    final text = Theme.of(context).textTheme;
    final p = Map<String, dynamic>.from(c['protection'] as Map? ?? const {});
    final r = Map<String, dynamic>.from(c['readiness'] as Map? ?? const {});
    final state = '${p['state'] ?? 'MONITORING'}';
    final score = r['score'];
    final components = _list(r['components']);
    final agentName = '${(c['core'] as Map?)?['product_name'] ?? 'Security'}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(
            container: true,
            label: '$agentName is ${state.toLowerCase()}. ${p['reason'] ?? ''} ${p['locked_down'] == true ? 'Lockdown is on.' : 'Lockdown is off.'}',
            child: ExcludeSemantics(
              child: Row(children: [
                Icon(Icons.security_rounded, color: _stateColors[state], size: 36),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(state, style: text.headlineSmall?.copyWith(color: _stateColors[state], fontWeight: FontWeight.w800, letterSpacing: 1.5)),
                  Text('${p['reason'] ?? ''}', style: text.bodyLarge),
                  Text(p['locked_down'] == true ? 'Lockdown is on' : 'Lockdown is off', style: text.bodyMedium),
                ])),
              ]),
            ),
          ),
          const SizedBox(height: 12),
          Semantics(
            container: true,
            label: score == null ? 'Readiness not measured yet.' : 'Readiness $score out of 100. ${r['how'] ?? ''}',
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: ExcludeSemantics(child: Text(score == null ? 'Readiness: not measured yet' : 'Readiness: $score / 100', style: text.titleLarge)),
              subtitle: const ExcludeSemantics(child: Text('How this is computed')),
              children: [
                Text('${r['how'] ?? ''}', style: text.bodyMedium),
                for (final comp in components)
                  Semantics(
                    container: true,
                    label: '${comp['label']}: ${comp['status']}, ${comp['evidence']}, weight ${comp['weight']}',
                    child: ExcludeSemantics(child: ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      leading: Icon(comp['status'] == 'pass' ? Icons.check_circle_rounded : comp['status'] == 'unknown' ? Icons.help_outline_rounded : Icons.error_outline_rounded),
                      title: Text('${comp['label']}'),
                      subtitle: Text('${comp['status']} · ${comp['evidence']} · weight ${comp['weight']}'),
                    )),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final c = _core;
    final text = Theme.of(context).textTheme;
    final events = [for (final e in (v?['events'] as List? ?? const [])) Map<String, dynamic>.from(e as Map)];
    final status = '${v?['status'] ?? ''}';
    final spoken = c == null ? status : '${c['spoken'] ?? status}';
    final internalOnly = v?['internal_only'] == true;
    final world = c == null ? null : Map<String, dynamic>.from(c['world'] as Map? ?? const {});
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
                  if (c != null) ...[_protection(c), const SizedBox(height: 12), ..._visibilitySections(c)],
                  Semantics(container: true, label: 'Security status. $status', child: ExcludeSemantics(child: Text(status, style: text.titleMedium))),
                  const SizedBox(height: 8),
                  Text(internalOnly ? 'Internal-only mode is on: CHE calls no outside service, only its own runtime and your GitHub and Cloudflare.' : 'External services are allowed when you approve them.', style: text.titleMedium),
                  const SizedBox(height: 12),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    OutlinedButton.icon(
                      icon: const Icon(Icons.record_voice_over_rounded),
                      label: const Text('Read Aloud'),
                      onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(spoken),
                    ),
                    action(Icons.fact_check_rounded, 'Run Security Check', _check),
                    if (c != null)
                      action(Icons.lock_outline_rounded, 'Preview Lockdown', _previewLockdown)
                    else
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
                  if (_preview != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: CheLockdownPreview(
                        preview: _preview!,
                        busy: _busy,
                        onConfirm: () => unawaited(_run(_confirmLockdown)),
                        onCancel: () => setState(() { _preview = null; _status = 'Lockdown preview closed. Nothing was changed.'; }),
                      ),
                    ),
                  if (_status.isNotEmpty)
                    Padding(padding: const EdgeInsets.only(top: 12), child: Semantics(liveRegion: true, child: Text(_status, style: text.titleMedium))),
                  if (world != null) ...[
                    const SizedBox(height: 20),
                    Semantics(header: true, child: Text('Cyber World', style: text.titleLarge)),
                    Text(_simulationNode != null ? 'Showing a SIMULATION pulse. Real systems are unaffected.' : 'Your real systems. A node pulses only for a real open event.', style: text.bodyMedium),
                    const SizedBox(height: 8),
                    CheCyberWorld(
                      nodes: [for (final n in _list(world['nodes'])) CheWorldNode.fromJson(n)],
                      pulses: [for (final p in _list(world['pulses'])) '${p['node']}'],
                      simulationPulse: _simulationNode,
                      onSelect: (n) => setState(() => _status = n.spoken),
                    ),
                    if (_simulationNode != null)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(icon: const Icon(Icons.close_rounded), label: const Text('Clear Simulation View'), onPressed: () => setState(() => _simulationNode = null)),
                      ),
                    const SizedBox(height: 12),
                    ..._coreSections(c!),
                  ],
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
