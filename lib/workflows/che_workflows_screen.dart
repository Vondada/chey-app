// More → Workflows: CHE's Universal Workflow Engine library (/api/workflows). Every number here is from CHE's
// recorded runs; nothing is estimated on the phone. Everything on the page also works by voice in chat
// ("list my workflows", "workflow stats", "promote candidate 1", "disable the trading desk workflow").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../security/che_secret_scan.dart';

export '../security/che_secret_scan.dart' show cheLooksSecret;

class CheWorkflowsClient {
  CheWorkflowsClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<Map<String, dynamic>> _decode(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await send().timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw Exception('CHE did not answer within 20 seconds.');
    }
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

  Future<Map<String, dynamic>> view() => _decode(() => _client.get(Uri.parse('$baseUrl/api/workflows'), headers: headers()));
  /// Verified internal capabilities, knowledge used and external dependencies (capability_engine.js).
  Future<Map<String, dynamic>> capabilities() => _decode(() => _client.get(Uri.parse('$baseUrl/api/capability-engine'), headers: headers()));
  Future<Map<String, dynamic>> capabilityPolicy(Map<String, dynamic> set) => _decode(() => _client.post(
        Uri.parse('$baseUrl/api/capability-engine/policy'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode({'set': set}),
      ));
  Future<Map<String, dynamic>> exportAll() => _decode(() => _client.get(Uri.parse('$baseUrl/api/workflows/export'), headers: headers()));
  Future<Map<String, dynamic>> action(String name, Map<String, dynamic> body) => _decode(() => _client.post(
        Uri.parse('$baseUrl/api/workflows/$name'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ));
}


/// The spoken summary of the measurements, the same words CHE says for "workflow stats".
String cheWorkflowSummary(Map<String, dynamic> e) {
  final requests = (e['requests'] as num?)?.toInt() ?? 0;
  if (requests == 0) return 'No requests are recorded yet. Each request from now on is recorded against the workflow that served it.';
  final parts = <String>[
    'Of your last $requests requests, ${e['via_workflow']} ran through reusable workflows (${e['percent_via_workflow']} percent) and ${e['via_model_only']} needed the language model.',
  ];
  if (e['avg_model_calls_workflow'] != null && e['avg_model_calls_model_path'] != null) {
    parts.add('Workflow runs averaged ${e['avg_model_calls_workflow']} model calls against at least ${e['avg_model_calls_model_path']} on the model path.');
  }
  if (e['model_calls_avoided'] != null) parts.add('Model calls avoided, measured: at least ${e['model_calls_avoided']}.');
  if (((e['learned_runs'] as num?) ?? 0) > 0) parts.add('${e['learned_runs']} ran through workflows learned from your repeated requests.');
  return parts.join(' ');
}

class CheWorkflowsScreen extends StatefulWidget {
  const CheWorkflowsScreen({super.key, required this.client, this.onSpeak, this.onListen});
  final CheWorkflowsClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheWorkflowsScreen> createState() => _CheWorkflowsScreenState();
}

class _CheWorkflowsScreenState extends State<CheWorkflowsScreen> {
  Map<String, dynamic>? _view;
  Map<String, dynamic>? _caps;
  String? _error;
  String _status = '';
  String _kind = 'all';
  bool _busy = false;

  static const _kinds = {'all': 'All', 'system': 'Built in', 'command': 'Commands', 'owner': 'Saved', 'learned': 'Learned'};

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.view();
      Map<String, dynamic>? caps;
      try {
        caps = await widget.client.capabilities();
      } catch (_) {
        caps = null; // The library still shows; the capability section says it could not load.
      }
      if (!mounted) return;
      setState(() { _view = v; _caps = caps; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load the workflow library: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  /// Every action reports its real outcome as visible text, a haptic and a VoiceOver announcement.
  Future<void> _act(String name, Map<String, dynamic> body, String success) async {
    if (_busy) return;
    setState(() => _busy = true);
    String said;
    var ok = false;
    try {
      final out = await widget.client.action(name, body);
      if (out['view'] is Map) _view = Map<String, dynamic>.from(out['view'] as Map);
      said = success;
      ok = true;
    } catch (e) {
      said = 'That did not work: ${e.toString().replaceFirst('Exception: ', '')}';
    }
    if (!mounted) return;
    setState(() => _busy = false);
    _report(said, ok: ok);
  }

  /// The same receipt for every result: visible text, a haptic pattern and a VoiceOver announcement.
  void _report(String said, {required bool ok}) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (!mounted) return;
    setState(() => _status = said);
    unawaited(SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr));
  }

  Future<void> _export() async {
    try {
      final out = await widget.client.exportAll();
      await Clipboard.setData(ClipboardData(text: const JsonEncoder.withIndent('  ').convert(out)));
      _report('Copied ${(out['workflows'] as List?)?.length ?? 0} workflows to the clipboard. No keys, tokens or passwords are in it.', ok: true);
    } catch (e) {
      _report('Export did not work: ${e.toString().replaceFirst('Exception: ', '')}', ok: false);
    }
  }

  Future<void> _import() async {
    final clip = await Clipboard.getData(Clipboard.kTextPlain);
    final text = clip?.text ?? '';
    // A password, key or token never leaves this iPhone: the import is refused here, before anything is sent.
    if (cheLooksSecret(text)) {
      _report('That workflow list contains something that looks like a password, key or token, so I did not import it. Nothing was sent.', ok: false);
      return;
    }
    Map<String, dynamic>? payload;
    try {
      final d = jsonDecode(text);
      if (d is Map) payload = Map<String, dynamic>.from(d);
    } catch (_) {}
    if (payload == null) {
      _report('The clipboard does not hold an exported workflow list. Nothing was imported.', ok: false);
      return;
    }
    await _act('import', payload, 'Import finished; see the library for what was added.');
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final workflows = [for (final w in (v?['workflows'] as List? ?? const [])) Map<String, dynamic>.from(w as Map)];
    final shown = _kind == 'all' ? workflows : workflows.where((w) => w['kind'] == _kind).toList();
    shown.sort((a, b) => (((b['stats'] as Map?)?['runs'] as num?) ?? 0).compareTo(((a['stats'] as Map?)?['runs'] as num?) ?? 0));
    final candidates = [for (final c in (v?['candidates'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    final summary = v == null ? '' : cheWorkflowSummary(Map<String, dynamic>.from(v['efficiency'] as Map? ?? const {}));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Workflows'),
        actions: [
          IconButton(tooltip: 'Talk to CHE about workflows', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Reload workflows', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
        ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: Theme.of(context).textTheme.titleMedium)))
          : v == null
              ? const Center(child: CircularProgressIndicator(semanticsLabel: 'Loading workflows'))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Semantics(
                      container: true,
                      label: 'Measured savings. $summary',
                      child: ExcludeSemantics(child: Text(summary, style: Theme.of(context).textTheme.titleMedium)),
                    ),
                    const SizedBox(height: 8),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      OutlinedButton.icon(
                        icon: const Icon(Icons.record_voice_over_rounded),
                        label: const Text('Read Aloud'),
                        onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(summary),
                      ),
                      OutlinedButton.icon(icon: const Icon(Icons.copy_rounded), label: const Text('Export'), onPressed: () => unawaited(_export())),
                      OutlinedButton.icon(icon: const Icon(Icons.content_paste_outlined), label: const Text('Import from clipboard'), onPressed: () => unawaited(_import())),
                    ]),
                    if (_status.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Semantics(liveRegion: true, child: Text(_status, style: Theme.of(context).textTheme.titleMedium)),
                      ),
                    const SizedBox(height: 20),
                    ..._capabilitySection(),
                    if (candidates.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      Text('Learned candidates (${candidates.length})', style: Theme.of(context).textTheme.titleLarge),
                      for (final (i, c) in candidates.indexed) _candidate(i + 1, c),
                    ],
                    const SizedBox(height: 20),
                    Text('Library (${workflows.length})', style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: 8),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      for (final e in _kinds.entries)
                        ChoiceChip(
                          label: Text(e.value),
                          selected: _kind == e.key,
                          onSelected: (_) => setState(() => _kind = e.key),
                        ),
                    ]),
                    const SizedBox(height: 8),
                    for (final w in shown) _workflow(w),
                  ],
                ),
    );
  }

  static const _where = {'internal': 'inside CHE', 'local': 'on your device', 'owner_compute': 'on compute you control', 'external_free': 'approved free service', 'external_paid': 'approved paid service'};

  /// Internal Capabilities, Knowledge Used and External Dependencies: only verified capabilities are called working.
  List<Widget> _capabilitySection() {
    final c = _caps;
    final theme = Theme.of(context).textTheme;
    if (c == null) return [Text('Internal capabilities could not be loaded just now.', style: theme.titleMedium)];
    final caps = [for (final x in (c['capabilities'] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
    final working = caps.where((x) => x['serving_version'] != null).toList();
    final other = caps.where((x) => x['serving_version'] == null).toList();
    final policy = Map<String, dynamic>.from(c['policy'] as Map? ?? const {});
    final internalOnly = policy['internal_only'] == true;
    final used = c['knowledge_used'] is Map ? Map<String, dynamic>.from(c['knowledge_used'] as Map) : null;
    final deps = (c['external_dependencies'] as List? ?? const []).length;
    final knowledge = Map<String, dynamic>.from(c['knowledge'] as Map? ?? const {});
    return [
      Text('Internal capabilities (${working.length} verified)', style: theme.titleLarge),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Internal-only mode'),
        subtitle: Text(internalOnly ? 'On: no external model, API or renderer is used.' : 'Off: approved external services may be used.'),
        value: internalOnly,
        onChanged: _busy
            ? null
            : (on) async {
                try {
                  await widget.client.capabilityPolicy({'internal_only': on});
                  _report('Internal-only mode is ${on ? 'on' : 'off'}.', ok: true);
                  await _load();
                } catch (e) {
                  _report('That did not work: ${e.toString().replaceFirst('Exception: ', '')}', ok: false);
                }
              },
      ),
      if (working.isEmpty) Text('No verified internal capabilities yet. Described or indexed knowledge is not counted as a capability.', style: theme.bodyLarge),
      for (final x in working)
        Semantics(
          container: true,
          label: '${x['name']}, ${x['status']}, ${_where[x['execution']] ?? x['execution']}, version ${x['serving_version']}, ${x['successes']} of ${x['runs']} runs worked',
          child: ExcludeSemantics(
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.check_circle_rounded),
              title: Text('${x['name']}'),
              subtitle: Text('${_where[x['execution']] ?? x['execution']} · v${x['serving_version']} · ${x['successes']}/${x['runs']} runs worked'),
            ),
          ),
        ),
      if (other.isNotEmpty) Text('Not working capabilities: ${other.map((x) => '${x['name']} (${'${x['status']}'.toLowerCase()})').join(', ')}', style: theme.bodyMedium),
      const SizedBox(height: 8),
      Semantics(
        container: true,
        child: Text(
          'Knowledge: ${knowledge['indexed'] ?? 0} indexed, ${knowledge['procedure'] ?? 0} procedures, ${knowledge['experience'] ?? 0} verified outcomes, ${c['conflicts'] ?? 0} conflicts, ${c['stale'] ?? 0} possibly outdated.',
          style: theme.bodyLarge,
        ),
      ),
      if (used != null) Text('Knowledge used last: ${used['what']} (${(used['items'] as List? ?? const []).length} items).', style: theme.bodyLarge),
      Text(deps == 0 ? 'External dependencies: none.' : 'External dependencies: $deps, each used only with your approval.', style: theme.bodyLarge),
    ];
  }

  Widget _candidate(int n, Map<String, dynamic> c) {
    final test = c['test'] as Map?;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$n. ${c['name']}', style: Theme.of(context).textTheme.titleMedium),
          Text('${c['reason']}'),
          if (test != null) Text(test['ok'] == true ? 'Test passed.' : 'Test failed: ${(test['issues'] as List? ?? const []).join(' ')}'),
          Wrap(spacing: 8, children: [
            TextButton.icon(icon: const Icon(Icons.science_outlined), label: const Text('Test'), onPressed: _busy ? null : () => unawaited(_act('test', {'id': c['id']}, 'Candidate $n tested.'))),
            TextButton.icon(icon: const Icon(Icons.check_rounded), label: const Text('Promote'), onPressed: _busy ? null : () => unawaited(_act('promote', {'id': c['id']}, 'Candidate $n promoted. Requests like it now run directly.'))),
            TextButton.icon(icon: const Icon(Icons.close_rounded), label: const Text('Dismiss'), onPressed: _busy ? null : () => unawaited(_act('dismiss', {'id': c['id']}, 'Candidate $n dismissed.'))),
          ]),
        ]),
      ),
    );
  }

  Widget _workflow(Map<String, dynamic> w) {
    final s = Map<String, dynamic>.from(w['stats'] as Map? ?? const {});
    final runs = (s['runs'] as num?)?.toInt() ?? 0;
    final disabled = w['disabled'] == true;
    // Built-in workflows are CHE's own handlers: they cannot be switched off, so no switch pretends they can.
    final fixed = w['kind'] == 'system';
    final facts = runs == 0
        ? 'No runs yet'
        : '$runs runs · ${s['success_rate']}% succeeded · ${s['avg_model_calls']} model calls on average';
    final label = '${w['name']}, ${_kinds[w['kind']] ?? w['kind']}. ${w['summary'] ?? ''}. $facts. Approval: ${w['approval']}. ${disabled ? 'Turned off.' : 'On.'}';
    return Row(children: [
      Expanded(
        child: Semantics(
          container: true,
          label: label,
          child: ExcludeSemantics(
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(w['kind'] == 'learned' ? Icons.school_rounded : w['kind'] == 'owner' ? Icons.star_rounded : Icons.account_tree_rounded),
              title: Text('${w['name']}'),
              subtitle: Text('${w['summary'] ?? ''}\n$facts'),
              isThreeLine: true,
            ),
          ),
        ),
      ),
      Semantics(
        label: fixed ? '${w['name']} always stays on' : 'Use ${w['name']}',
        child: Switch(
          value: !disabled,
          onChanged: _busy || fixed
              ? null
              : (on) => unawaited(_act(on ? 'enable' : 'disable', {'id': w['id']}, '${w['name']} is ${on ? 'on' : 'off'}.')),
        ),
      ),
    ]);
  }
}
