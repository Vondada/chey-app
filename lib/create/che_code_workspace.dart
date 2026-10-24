// Create → Code Studio (owner, 2026-10-24: "Code opens a dedicated coding workspace, not Home or Chat"). One page over
// what CHE's coding pipeline already records: the current coding job's real state (the Worker's deterministic "coding
// status" route), the background coding jobs with their status, result or error, and a request box that starts a job
// through the same /api/chat route as before, while the owner stays here and hears CHE's real answer. Stop cancels a
// queued job through POST /api/job/cancel (the same rule as "cancel coding job"); a running job is not stoppable there
// and the page says so. Nothing is spoken on open.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../rooms/che_creator_studio.dart' show cheIsCodingJob;
import 'che_creative_studio.dart' show CheStudioColors;

/// The words CHE says for a job's stored status.
String cheCodingJobStatus(Map<String, dynamic> j) => switch ('${j['status'] ?? ''}') {
  'queued' => 'Queued',
  'running' => 'Running',
  'done' || 'completed' || 'complete' => 'Done',
  'failed' => j['dead_letter'] == true ? 'Stopped after retries' : 'Failed',
  'cancelled' => 'Cancelled',
  final s => s.isEmpty ? 'Unknown' : s,
};

class CheCodeWorkspace extends StatefulWidget {
  const CheCodeWorkspace({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.loadJobs,
    this.onSpeak,
    this.onOpenOffice,
    this.onOpenCommandCenter,
    this.client,
  });

  final String baseUrl;
  final Map<String, String> Function() headers;

  /// The owner's background jobs, freshly loaded from the Worker (the coding ones are shown).
  final Future<List<Map<String, dynamic>>> Function() loadJobs;
  final void Function(String text)? onSpeak;
  final VoidCallback? onOpenOffice;
  final VoidCallback? onOpenCommandCenter;
  final http.Client? client;

  /// While open: "read", "refresh", "build" then what to make, "stop job 2", "open the office".
  static Future<String?> Function(String words)? voiceHandler;

  static Route<void> route({
    required String baseUrl,
    required Map<String, String> Function() headers,
    required Future<List<Map<String, dynamic>>> Function() loadJobs,
    void Function(String text)? onSpeak,
    VoidCallback? onOpenOffice,
    VoidCallback? onOpenCommandCenter,
  }) => MaterialPageRoute<void>(
    builder: (_) => CheCodeWorkspace(
      baseUrl: baseUrl,
      headers: headers,
      loadJobs: loadJobs,
      onSpeak: onSpeak,
      onOpenOffice: onOpenOffice,
      onOpenCommandCenter: onOpenCommandCenter,
    ),
  );

  @override
  State<CheCodeWorkspace> createState() => CheCodeWorkspaceState();
}

class CheCodeWorkspaceState extends State<CheCodeWorkspace> {
  final _request = TextEditingController();
  List<Map<String, dynamic>> _jobs = const [];
  String _current = '';
  String _reply = '';
  bool _loading = true;
  bool _sending = false;
  String? _error;

  http.Client get _http => widget.client ?? http.Client();

  @override
  void initState() {
    super.initState();
    CheCodeWorkspace.voiceHandler = voice;
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) unawaited(refresh()); });
  }

  @override
  void dispose() {
    if (CheCodeWorkspace.voiceHandler == voice) CheCodeWorkspace.voiceHandler = null;
    _request.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> get codingJobs => [
    for (final j in _jobs)
      if (cheIsCodingJob(j)) j,
  ];

  Future<void> refresh() async {
    setState(() => _loading = true);
    try {
      final jobs = await widget.loadJobs();
      final status = await _chat('coding status');
      if (!mounted) return;
      setState(() {
        _jobs = jobs;
        _current = status;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach CHE: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// One owner turn through /api/chat (the coding route answers there); returns CHE's words.
  Future<String> _chat(String message) async {
    final r = await _http
        .post(
          Uri.parse('${widget.baseUrl}/api/chat'),
          headers: {...widget.headers(), 'Content-Type': 'application/json'},
          body: jsonEncode({
            'message': message,
            'history': const <Object>[],
            'owner_mode': true,
            'agent_mode': 'chat',
            'client': const {'platform': 'flutter', 'voice_enabled': false, 'screen': 'code_workspace'},
          }),
        )
        .timeout(const Duration(seconds: 60));
    if (r.statusCode == 401) throw StateError('pair this phone with CHE first');
    if (r.statusCode >= 300) throw StateError('HTTP ${r.statusCode}');
    final out = StringBuffer();
    for (final line in const LineSplitter().convert(r.body)) {
      try {
        final d = jsonDecode(line);
        if (d is Map && d['type'] == 'delta') out.write('${d['delta'] ?? ''}');
        if (d is Map && d['type'] == 'done' && out.isEmpty) out.write('${d['reply'] ?? ''}');
      } catch (_) {}
    }
    return out.toString().replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  /// Starts a coding job for [what] and reports CHE's real answer.
  Future<String> start(String what) async {
    final ask = what.trim();
    if (ask.isEmpty) return 'Say or type what to build first.';
    setState(() => _sending = true);
    HapticFeedback.mediumImpact();
    String said;
    try {
      said = await _chat('Start a coding job: $ask');
      if (said.isEmpty) said = 'CHE did not answer, so I cannot say a job started.';
      _request.clear();
    } catch (e) {
      said = 'The coding job was not started: $e.';
    }
    if (!mounted) return said;
    setState(() {
      _reply = said;
      _sending = false;
    });
    unawaited(refresh());
    return said;
  }

  /// Stop: cancels a queued coding job (POST /api/job/cancel). A running one is not cancellable there.
  Future<String> stop(Map<String, dynamic> job) async {
    final title = '${job['title'] ?? 'that job'}';
    if ('${job['status']}' != 'queued') {
      return '$title is ${cheCodingJobStatus(job).toLowerCase()}; only a queued coding job can be stopped from here.';
    }
    try {
      final r = await _http
          .post(
            Uri.parse('${widget.baseUrl}/api/job/cancel'),
            headers: {...widget.headers(), 'Content-Type': 'application/json'},
            body: jsonEncode({'id': job['id']}),
          )
          .timeout(const Duration(seconds: 15));
      final d = jsonDecode(r.body);
      final status = d is Map && d['job'] is Map ? '${(d['job'] as Map)['status']}' : '';
      unawaited(refresh());
      return status == 'cancelled'
          ? 'Stopped $title. It was cancelled before it started; its record is kept.'
          : 'CHE did not cancel $title; it is ${status.isEmpty ? 'in an unknown state' : status}.';
    } catch (e) {
      return 'Could not reach CHE, so $title was not stopped: $e.';
    }
  }

  String get spokenSummary {
    final jobs = codingJobs;
    final list = [for (var i = 0; i < jobs.length && i < 8; i++) '${i + 1}. ${jobs[i]['title']}, ${cheCodingJobStatus(jobs[i])}'];
    return 'Code Studio. ${_current.isEmpty ? 'No current coding job status.' : _current} '
        '${jobs.isEmpty ? 'No coding jobs recorded.' : 'Coding jobs: ${list.join('; ')}.'} '
        'Say build, then what to make; or stop job, then a number.';
  }

  Future<String?> voice(String words) async {
    if (!mounted || !(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '');
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen)$").hasMatch(t)) return spokenSummary;
    if (RegExp(r'^(?:refresh|update|reload)(?: (?:it|the jobs|coding jobs))?$').hasMatch(t)) {
      await refresh();
      return '${codingJobs.length} coding job${codingJobs.length == 1 ? '' : 's'}. $_current';
    }
    final stopN = RegExp(r'^(?:stop|cancel)(?: coding)? job (?:number )?(\d{1,2})$').firstMatch(t);
    if (stopN != null) {
      final n = int.parse(stopN.group(1)!);
      if (n < 1 || n > codingJobs.length) return 'There is no coding job $n.';
      return stop(codingJobs[n - 1]);
    }
    if (RegExp(r'^open (?:the )?office$').hasMatch(t) && widget.onOpenOffice != null) {
      widget.onOpenOffice!();
      return 'Opening the Office.';
    }
    final build = RegExp(r'^(?:build|make|code|create|start a coding job(?: for| to)?:?)\s+(.{3,})$').firstMatch(t);
    if (build != null) return start(words.trim().replaceFirst(RegExp(r'^\S+\s+(?:a coding job(?: for| to)?:?\s*)?', caseSensitive: false), ''));
    return null;
  }

  void _say(String text) {
    widget.onSpeak?.call(text);
    if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 16))));
  }

  @override
  Widget build(BuildContext context) {
    final jobs = codingJobs;
    return Scaffold(
      backgroundColor: CheStudioColors.bg,
      appBar: AppBar(
        backgroundColor: CheStudioColors.bg,
        foregroundColor: CheStudioColors.text,
        title: Semantics(header: true, child: const Text('Code Studio')),
        actions: [
          IconButton(
            key: const ValueKey('code-read'),
            tooltip: 'Read Code Studio aloud',
            onPressed: () => widget.onSpeak?.call(spokenSummary),
            icon: const Icon(Icons.volume_up_rounded),
          ),
          IconButton(
            key: const ValueKey('code-refresh'),
            tooltip: 'Refresh coding jobs',
            onPressed: refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: ListView(
        key: const ValueKey('code-workspace'),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          const Text(
            'Apps, websites, games and software, built by CHE\'s crew as coding jobs you can follow here.',
            style: TextStyle(color: CheStudioColors.dim, fontSize: 14),
          ),
          const SizedBox(height: 14),
          Semantics(
            textField: true,
            label: 'What should the crew build?',
            child: TextField(
              key: const ValueKey('code-request'),
              controller: _request,
              minLines: 2,
              maxLines: 5,
              style: const TextStyle(color: CheStudioColors.text, fontSize: 16),
              decoration: const InputDecoration(
                hintText: 'What should the crew build? For example: a Roblox obby with a sword shop',
                hintStyle: TextStyle(color: CheStudioColors.dim),
                filled: true,
                fillColor: CheStudioColors.card,
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Semantics(
            button: true,
            label: 'Start coding job',
            excludeSemantics: true,
            child: FilledButton.icon(
              key: const ValueKey('code-start'),
              style: FilledButton.styleFrom(
                backgroundColor: CheStudioColors.teal,
                foregroundColor: Colors.black,
                minimumSize: const Size.fromHeight(54),
              ),
              onPressed: _sending ? null : () async => _say(await start(_request.text)),
              icon: _sending
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.play_arrow_rounded),
              label: Text(_sending ? 'Starting…' : 'Start coding job'),
            ),
          ),
          if (_reply.isNotEmpty) ...[
            const SizedBox(height: 12),
            _Panel(title: 'CHE SAID', child: Text(_reply, key: const ValueKey('code-reply'), style: const TextStyle(color: CheStudioColors.text, fontSize: 16))),
          ],
          const SizedBox(height: 16),
          _Panel(
            title: 'CURRENT CODING JOB',
            child: Text(
              _loading && _current.isEmpty ? 'Checking…' : (_current.isEmpty ? 'No coding job status recorded.' : _current),
              key: const ValueKey('code-current'),
              style: const TextStyle(color: CheStudioColors.text, fontSize: 15),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Colors.orangeAccent, fontSize: 14)),
          ],
          const SizedBox(height: 16),
          Semantics(header: true, child: Text('CODING JOBS (${jobs.length})', style: const TextStyle(color: CheStudioColors.dim, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 2))),
          const SizedBox(height: 6),
          if (jobs.isEmpty)
            const Text('No coding jobs recorded yet.', style: TextStyle(color: CheStudioColors.dim, fontSize: 14))
          else
            for (var i = 0; i < jobs.length; i++) _JobTile(number: i + 1, job: jobs[i], onStop: () async => _say(await stop(jobs[i]))),
          const SizedBox(height: 16),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              if (widget.onOpenOffice != null)
                OutlinedButton.icon(key: const ValueKey('code-office'), onPressed: widget.onOpenOffice, icon: const Icon(Icons.workspaces_outline), label: const Text('The crew in the Office')),
              if (widget.onOpenCommandCenter != null)
                OutlinedButton.icon(key: const ValueKey('code-commands'), onPressed: widget.onOpenCommandCenter, icon: const Icon(Icons.apps_rounded), label: const Text('Commands')),
            ],
          ),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.child});
  final String title;
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(color: CheStudioColors.card, borderRadius: BorderRadius.circular(16), border: Border.all(color: CheStudioColors.stroke)),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(color: CheStudioColors.teal, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 1.8)),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
}

class _JobTile extends StatelessWidget {
  const _JobTile({required this.number, required this.job, required this.onStop});
  final int number;
  final Map<String, dynamic> job;
  final VoidCallback onStop;
  @override
  Widget build(BuildContext context) {
    final status = cheCodingJobStatus(job);
    final detail = '${job['error'] ?? ''}'.trim().isNotEmpty ? '${job['error']}' : '${job['result'] ?? ''}';
    final when = '${job['updated_at'] ?? job['created_at'] ?? ''}';
    return Semantics(
      container: true,
      label: '$number. ${job['title']}. $status.${detail.isEmpty ? '' : ' $detail'}',
      child: Card(
        key: ValueKey('code-job-${job['id']}'),
        color: CheStudioColors.card,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$number. ${job['title'] ?? 'Coding job'}', style: const TextStyle(color: CheStudioColors.text, fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text('$status${when.length >= 16 ? ' · ${when.substring(0, 16).replaceFirst('T', ' ')} UTC' : ''}', style: const TextStyle(color: CheStudioColors.silver, fontSize: 13)),
              if (detail.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(detail.length > 240 ? '${detail.substring(0, 240)}…' : detail, style: const TextStyle(color: CheStudioColors.dim, fontSize: 13)),
              ],
              if ('${job['status']}' == 'queued')
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    key: ValueKey('code-stop-${job['id']}'),
                    onPressed: onStop,
                    icon: const Icon(Icons.stop_circle_outlined),
                    label: Text('Stop job $number'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
