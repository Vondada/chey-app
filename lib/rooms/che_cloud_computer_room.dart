// Cloud Computer Room (owner, 2026-10-24): CHE's one Cloud Computer Manager (server/cloudflare/cloud_computer.js,
// GET /api/cloud-computer). It shows each environment, its software and real status, every job with its agent,
// provider, tools, times, logs, outputs and evidence, the approvals waiting for the owner, costs and what is missing
// (no provider has Blender or a GPU of its own). Loading is quiet: muted text, no speech. Read Aloud and every
// action speak their real result, with a visible banner and a haptic.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class CheCloudComputerClient {
  CheCloudComputerClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Map<String, dynamic> _decode(http.Response r) {
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    return body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
  }

  Future<CheCloudView> load() async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await _client.get(Uri.parse('$baseUrl/api/cloud-computer'), headers: headers()).timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw Exception('CHE did not answer within 20 seconds.');
    }
    final map = _decode(r);
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return CheCloudView.fromJson(map);
  }

  /// approve, cancel, stop or retry. Returns CHE's spoken result and whether it worked.
  Future<({bool ok, String spoken})> control(String action, String id) async {
    if (baseUrl.isEmpty) return (ok: false, spoken: 'CHE is not connected on this iPhone yet. Nothing changed.');
    try {
      final r = await _client
          .post(Uri.parse('$baseUrl/api/cloud-computer/$action'), headers: {...headers(), 'Content-Type': 'application/json'}, body: jsonEncode({'id': id}))
          .timeout(const Duration(seconds: 30));
      final map = _decode(r);
      return (ok: map['ok'] == true, spoken: '${map['spoken'] ?? map['detail'] ?? 'CHE answered ${r.statusCode}.'}');
    } on TimeoutException {
      return (ok: false, spoken: 'CHE did not answer within 30 seconds, so I cannot say whether it worked.');
    } catch (_) {
      return (ok: false, spoken: 'I could not reach CHE. Nothing changed.');
    }
  }
}

List<Map<String, dynamic>> _maps(Object? v) => (v as List? ?? const []).whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
List<String> _strings(Object? v) => (v as List? ?? const []).map((e) => '$e').toList();

class CheCloudEnvironment {
  const CheCloudEnvironment({required this.id, required this.label, required this.status, required this.software, required this.cost, required this.billing, required this.limits, required this.detail});
  final String id, label, status, cost, billing, limits, detail;
  final List<String> software;
  factory CheCloudEnvironment.fromJson(Map<String, dynamic> j) => CheCloudEnvironment(
        id: '${j['id'] ?? ''}', label: '${j['label'] ?? ''}', status: '${j['status'] ?? 'unverified'}', software: _strings(j['software']),
        cost: '${j['cost'] ?? ''}', billing: '${j['billing'] ?? ''}', limits: '${j['limits'] ?? ''}', detail: '${j['detail'] ?? j['verified_by'] ?? ''}',
      );
  String get statusLabel => cheCloudStatusWords[status] ?? status.replaceAll('_', ' ');
  String get billingLabel => billing == 'requires_verified_free_usage' ? 'free usage not verified; asks first' : billing;
}

class CheCloudJob {
  const CheCloudJob({
    required this.id, required this.kind, required this.title, required this.agent, required this.provider, required this.tools, required this.createdAt,
    required this.startedAt, required this.finishedAt, required this.status, required this.logs, required this.outputs, required this.evidence,
    required this.error, required this.approvalReason, required this.canApprove, required this.canCancel, required this.canStop, required this.canRetry,
  });
  final String id, kind, title, agent, provider, createdAt, startedAt, finishedAt, status, evidence, error, approvalReason;
  final List<String> tools, logs;
  final List<Map<String, dynamic>> outputs;
  final bool canApprove, canCancel, canStop, canRetry;

  factory CheCloudJob.fromJson(Map<String, dynamic> j) {
    final c = Map<String, dynamic>.from(j['controls'] as Map? ?? const {});
    final a = j['approval'] is Map ? Map<String, dynamic>.from(j['approval'] as Map) : const <String, dynamic>{};
    return CheCloudJob(
      id: '${j['id'] ?? ''}', kind: '${j['kind'] ?? ''}', title: '${j['title'] ?? ''}', agent: '${j['agent'] ?? 'CHE'}', provider: '${j['provider'] ?? ''}',
      tools: _strings(j['tools']), createdAt: '${j['created_at'] ?? ''}', startedAt: '${j['started_at'] ?? ''}', finishedAt: '${j['finished_at'] ?? ''}',
      status: '${j['status'] ?? 'unverified'}', logs: _strings(j['logs']), outputs: _maps(j['outputs']), evidence: '${j['evidence'] ?? ''}',
      error: '${j['error'] ?? ''}', approvalReason: '${a['reason'] ?? ''}',
      canApprove: c['approve'] == true, canCancel: c['cancel'] == true, canStop: c['stop'] == true, canRetry: c['retry'] == true,
    );
  }

  String get shortId => id.length > 8 ? id.substring(0, 8) : id;
  String get statusLabel => cheCloudStatusWords[status] ?? status.replaceAll('_', ' ');
  String get name => title.isEmpty ? kind.replaceAll('_', ' ') : title;
  String get spoken => '$name, by $agent on $provider: $statusLabel.'
      '${error.isNotEmpty ? ' Problem: $error' : ''}${evidence.isNotEmpty ? ' Evidence: $evidence.' : ''}';
}

class CheCloudView {
  const CheCloudView({required this.environments, required this.software, required this.jobs, required this.costs, required this.missing, required this.spoken});
  final List<CheCloudEnvironment> environments;
  final List<String> software;
  final List<CheCloudJob> jobs;
  final String costs;
  final List<Map<String, dynamic>> missing;
  final String spoken;
  factory CheCloudView.fromJson(Map<String, dynamic> j) => CheCloudView(
        environments: [for (final e in _maps(j['environments'])) CheCloudEnvironment.fromJson(e)],
        software: _strings(j['software']),
        jobs: [for (final r in _maps(j['jobs'])) CheCloudJob.fromJson(r)],
        costs: '${(j['costs'] is Map ? (j['costs'] as Map)['summary'] : null) ?? ''}',
        missing: _maps(j['missing']),
        spoken: '${j['spoken'] ?? ''}',
      );
  List<CheCloudJob> get approvals => jobs.where((r) => r.canApprove).toList();
}

/// The words for each state, the same ones CHE says aloud.
const cheCloudStatusWords = {
  'operational': 'operational', 'unverified': 'unverified', 'needs_setup': 'needs setup', 'refused': 'never used',
  'awaiting_approval': 'waiting for your approval', 'queued': 'queued', 'running': 'running', 'complete': 'complete',
  'failed': 'failed', 'cancelled': 'cancelled', 'dead_letter': 'stopped after repeated failures',
};

/// The spoken overview: the Worker's own summary, then the jobs as a numbered list.
String cheCloudSummary(CheCloudView v) {
  final jobs = v.jobs.take(5).toList();
  final list = [for (var i = 0; i < jobs.length; i++) '${i + 1}. ${jobs[i].spoken}'].join(' ');
  return '${v.spoken}${jobs.isEmpty ? ' No jobs on record.' : ' Latest jobs: $list'}';
}

class CheCloudComputerRoom extends StatefulWidget {
  const CheCloudComputerRoom({super.key, required this.client, this.onSpeak, this.onListen});
  final CheCloudComputerClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  @override
  State<CheCloudComputerRoom> createState() => _CheCloudComputerRoomState();
}

class _CheCloudComputerRoomState extends State<CheCloudComputerRoom> {
  CheCloudView? _view;
  String? _error;
  String _banner = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.load();
      if (!mounted) return;
      setState(() { _view = v; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load the cloud computer: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  void _speak(String text) {
    HapticFeedback.selectionClick();
    widget.onSpeak?.call(text);
  }

  Future<void> _control(String action, CheCloudJob job) async {
    if (_busy) return;
    setState(() => _busy = true);
    HapticFeedback.mediumImpact();
    final out = await widget.client.control(action, job.id);
    if (!mounted) return;
    // The real result: a banner on screen, a haptic pattern and CHE's voice.
    if (out.ok) {
      HapticFeedback.lightImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    setState(() { _banner = out.spoken; _busy = false; });
    widget.onSpeak?.call(out.spoken);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final theme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cloud Computer'),
        actions: [
          IconButton(tooltip: 'Talk to CHE about the cloud computer', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
          IconButton(tooltip: 'Reload the cloud computer', icon: const Icon(Icons.refresh_rounded), onPressed: () => unawaited(_load())),
        ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: theme.titleMedium)))
          : v == null
              // Passive loading stays quiet: muted text, no announcement.
              ? Center(child: Text('Loading the cloud computer…', style: theme.bodyLarge?.copyWith(color: Theme.of(context).hintColor)))
              : _body(context, v),
    );
  }

  Widget _body(BuildContext context, CheCloudView v) {
    final theme = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (_banner.isNotEmpty)
          Semantics(
            container: true,
            liveRegion: true,
            label: _banner,
            child: ExcludeSemantics(
              child: Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Theme.of(context).colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(10)),
                child: Text(_banner, style: theme.titleMedium),
              ),
            ),
          ),
        Text(v.spoken, style: theme.titleMedium),
        const SizedBox(height: 8),
        Semantics(
          button: true,
          label: 'Read Aloud: the cloud computer summary and the latest jobs',
          excludeSemantics: true,
          child: OutlinedButton.icon(
            icon: const Icon(Icons.record_voice_over_rounded),
            label: const Text('Read Aloud'),
            onPressed: widget.onSpeak == null ? null : () => _speak(cheCloudSummary(v)),
          ),
        ),
        if (v.approvals.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Waiting for your approval', style: theme.titleLarge),
          for (final job in v.approvals) _approval(job),
        ],
        const SizedBox(height: 20),
        Text('Environments', style: theme.titleLarge),
        for (final e in v.environments) _environment(e),
        if (v.missing.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Not available yet', style: theme.titleLarge),
          for (final m in v.missing) _missing(m),
        ],
        const SizedBox(height: 20),
        Text('Jobs', style: theme.titleLarge),
        if (v.jobs.isEmpty) Text('No jobs on record yet.', style: theme.bodyLarge),
        for (final job in v.jobs) _job(job),
        const SizedBox(height: 20),
        Text('Costs', style: theme.titleLarge),
        Semantics(container: true, label: 'Costs: ${v.costs}', child: ExcludeSemantics(child: Text(v.costs, style: theme.bodyLarge))),
      ],
    );
  }

  Widget _environment(CheCloudEnvironment e) {
    final spoken = '${e.label}: ${e.statusLabel}. Software: ${e.software.isEmpty ? 'none reported' : e.software.join(', ')}. '
        'Cost: ${e.billingLabel}. Limits: ${e.limits}${e.detail.isNotEmpty ? ' ${e.detail}' : ''}';
    return Semantics(
      container: true,
      button: true,
      label: spoken,
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(e.status == 'operational' ? Icons.cloud_rounded : e.status == 'needs_setup' ? Icons.cloud_off_outlined : Icons.cloud_queue),
          title: Text(e.label),
          subtitle: Text('${e.statusLabel} · ${e.billingLabel}\n${e.software.isEmpty ? 'No software reported' : e.software.join(', ')}'),
          isThreeLine: true,
          onTap: widget.onSpeak == null ? null : () => _speak(spoken),
        ),
      ),
    );
  }

  Widget _missing(Map<String, dynamic> m) {
    final spoken = '${m['capability']}: ${m['reason']} ${m['existing'] ?? ''} Smallest addition: ${m['smallest_addition']}';
    return Semantics(
      container: true,
      button: true,
      label: spoken,
      child: ExcludeSemantics(
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.error_outline_rounded),
          title: Text('${m['capability']}'),
          subtitle: Text('${m['reason']} Smallest addition: ${m['smallest_addition']}'),
          onTap: widget.onSpeak == null ? null : () => _speak(spoken),
        ),
      ),
    );
  }

  Widget _approval(CheCloudJob job) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(container: true, label: '${job.name}, job ${job.shortId}. ${job.approvalReason}',
          child: ExcludeSemantics(child: Padding(padding: const EdgeInsets.only(top: 8), child: Text('${job.name}: ${job.approvalReason}', style: Theme.of(context).textTheme.bodyLarge)))),
      Wrap(spacing: 8, children: [
        _action('Approve', 'Approve cloud job ${job.shortId}: ${job.name}', Icons.check_circle_outline, () => _control('approve', job)),
        _action('Cancel', 'Cancel cloud job ${job.shortId} before it runs', Icons.cancel, () => _control('cancel', job)),
      ]),
    ]);
  }

  Widget _action(String text, String label, IconData icon, VoidCallback onPressed) => Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: TextButton.icon(icon: Icon(icon), label: Text(text), onPressed: _busy ? null : onPressed),
      );

  Widget _job(CheCloudJob job) {
    final theme = Theme.of(context).textTheme;
    final times = [
      if (job.createdAt.isNotEmpty) 'created ${job.createdAt}',
      if (job.startedAt.isNotEmpty) 'started ${job.startedAt}',
      if (job.finishedAt.isNotEmpty) 'finished ${job.finishedAt}',
    ].join(' · ');
    final outputs = job.outputs.map((o) => '${o['label'] ?? o['kind']}${o['url'] != null ? ' ${o['url']}' : ''}${o['sha256'] != null ? ' SHA-256 ${'${o['sha256']}'.substring(0, 12)}' : ''}').join('; ');
    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(
            container: true,
            button: true,
            label: '${job.spoken}${job.tools.isEmpty ? '' : ' Tools: ${job.tools.join(', ')}.'}${outputs.isEmpty ? '' : ' Outputs: $outputs.'}',
            child: ExcludeSemantics(
              child: InkWell(
                onTap: widget.onSpeak == null ? null : () => _speak(job.spoken),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(job.name, style: theme.titleMedium),
                  Text('${job.statusLabel} · ${job.agent} · ${job.provider}', style: theme.bodyLarge),
                  if (job.tools.isNotEmpty) Text('Tools: ${job.tools.join(', ')}', style: theme.bodyMedium),
                  if (times.isNotEmpty) Text(times, style: theme.bodySmall),
                  if (job.error.isNotEmpty) Text('Problem: ${job.error}', style: theme.bodyLarge?.copyWith(color: Theme.of(context).colorScheme.error)),
                  if (outputs.isNotEmpty) Text('Outputs: $outputs', style: theme.bodyMedium),
                  Text('Evidence: ${job.evidence}', style: theme.bodySmall),
                  if (job.logs.isNotEmpty) Text('Log: ${job.logs.last}', style: theme.bodySmall),
                ]),
              ),
            ),
          ),
          if (job.canApprove || job.canCancel || job.canStop || job.canRetry)
            Wrap(spacing: 8, children: [
              if (job.canApprove) _action('Approve', 'Approve job ${job.shortId}: ${job.name}', Icons.check_circle_outline, () => _control('approve', job)),
              if (job.canCancel) _action('Cancel', 'Cancel job ${job.shortId}: ${job.name}', Icons.cancel, () => _control('cancel', job)),
              if (job.canStop) _action('Stop', 'Stop job ${job.shortId} on GitHub: ${job.name}', Icons.stop_rounded, () => _control('stop', job)),
              if (job.canRetry) _action('Retry', 'Retry job ${job.shortId}: ${job.name}', Icons.replay_rounded, () => _control('retry', job)),
            ]),
        ]),
      ),
    );
  }
}
