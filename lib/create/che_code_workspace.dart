// Create → Code Studio (owner, 2026-10-24: "Code opens a dedicated coding workspace, not Home or Chat"). One page over
// what CHE's coding pipeline already records: the current coding job's real state (the Worker's deterministic "coding
// status" route), the background coding jobs with their status, result or error, and a request box that starts a job
// through the same /api/chat route as before, while the owner stays here and hears CHE's real answer. Stop cancels a
// queued job through POST /api/job/cancel (the same rule as "cancel coding job"); a running coding job is not stoppable
// there and the page says so. Nothing is spoken on open.
// Creation jobs (creation-gaps, 2026-10-25: "Code Studio Stop"): the Creation Engine's waiting and running builds
// (GET /api/gpu) are listed with a Stop each, and "stop the job" by voice stops the one active job (or reads a numbered
// list when there are several). Stop uses the queue's own cancel (POST /api/gpu/jobs/cancel): a running build's worker
// reads it at its next heartbeat and ends Blender, and Refresh reports when the worker confirmed it. Every Stop says
// the state the Worker answered, never an assumed one.
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

/// A Creation Engine job that Stop can still cancel: waiting, paused or building.
bool cheCreationJobActive(Map<String, dynamic> j) => const {'queued', 'paused', 'rendering'}.contains('${j['state'] ?? ''}');

/// The Worker's own words for a creation job's state, else its raw state.
String cheCreationJobStatus(Map<String, dynamic> j) {
  final d = '${j['display_state'] ?? ''}'.trim();
  return d.isNotEmpty ? d : '${j['state'] ?? 'unknown'}';
}

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
  List<Map<String, dynamic>> _creation = const [];
  String? _creationError;
  bool _stopping = false;
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

  /// The Creation Engine's waiting, paused and running builds, newest first (as GET /api/gpu lists them).
  List<Map<String, dynamic>> get creationJobs => [
    for (final j in _creation)
      if (cheCreationJobActive(j)) j,
  ];

  /// Creation jobs cancelled while a worker held them: what the worker has confirmed so far.
  List<Map<String, dynamic>> get _stoppedRunning => [
    for (final j in _creation)
      if ('${j['state']}' == 'cancelled' && '${j['cancelled_worker'] ?? ''}'.isNotEmpty) j,
  ];

  Future<List<Map<String, dynamic>>> _loadCreation() async {
    final r = await _http.get(Uri.parse('${widget.baseUrl}/api/gpu'), headers: widget.headers()).timeout(const Duration(seconds: 20));
    if (r.statusCode >= 300) throw StateError('HTTP ${r.statusCode}');
    final d = jsonDecode(r.body);
    final list = d is Map && d['jobs'] is List ? d['jobs'] as List : const [];
    return [for (final j in list) if (j is Map) Map<String, dynamic>.from(j)];
  }

  Future<void> refresh() async {
    setState(() => _loading = true);
    try {
      final jobs = await widget.loadJobs();
      final status = await _chat('coding status');
      List<Map<String, dynamic>>? creation;
      String? creationError;
      try {
        creation = await _loadCreation();
      } catch (e) {
        creationError = 'Could not read the Creation Engine jobs: $e';
      }
      if (!mounted) return;
      setState(() {
        _jobs = jobs;
        _current = status;
        _error = null;
        if (creation != null) _creation = creation;
        _creationError = creationError;
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

  /// Stop for a Creation Engine job: the queue's own cancel, then the state the Worker answered.
  Future<String> stopCreation(Map<String, dynamic> job) async {
    final title = '${job['title'] ?? 'that creation job'}';
    final running = '${job['state']}' == 'rendering';
    final worker = '${job['worker_name'] ?? ''}'.trim();
    if (mounted) setState(() => _stopping = true);
    HapticFeedback.mediumImpact();
    String said;
    var ok = false;
    try {
      final r = await _http
          .post(
            Uri.parse('${widget.baseUrl}/api/gpu/jobs/cancel'),
            headers: {...widget.headers(), 'Content-Type': 'application/json'},
            body: jsonEncode({'id': job['id']}),
          )
          .timeout(const Duration(seconds: 15));
      final d = jsonDecode(r.body);
      final state = d is Map && d['job'] is Map ? '${(d['job'] as Map)['state']}' : '';
      ok = r.statusCode < 300 && state == 'cancelled';
      said = ok
          ? (running
                ? 'Stopped $title. The queue now reads cancelled, and ${worker.isEmpty || worker == 'unknown worker' ? 'its worker' : 'the $worker'} '
                      'is told to end Blender at its next heartbeat, within about 30 seconds. Say refresh to hear when it confirms.'
                : 'Stopped $title before any worker started it. The queue now reads cancelled; its record is kept.')
          : 'CHE did not stop $title: ${d is Map ? d['detail'] ?? 'it is ${state.isEmpty ? 'in an unknown state' : state}' : 'CHE answered ${r.statusCode}'}.';
    } catch (e) {
      said = 'Could not reach CHE, so $title was not stopped: $e.';
    }
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (mounted) setState(() => _stopping = false);
    unawaited(refresh());
    return said;
  }

  /// Every job Stop can act on now: active creation jobs, then queued coding jobs, numbered in that order.
  List<(String, Map<String, dynamic>)> get stoppable => [
    for (final j in creationJobs) ('creation', j),
    for (final j in codingJobs)
      if ('${j['status']}' == 'queued') ('coding', j),
  ];

  /// "Stop the job": the one active job, a numbered list when there are several, or the plain reason nothing stops.
  Future<String> stopTheJob({String kind = ''}) async {
    final all = [for (final x in stoppable) if (kind.isEmpty || x.$1 == kind) x];
    if (all.isEmpty) {
      final runningCoding = codingJobs.where((j) => '${j['status']}' == 'running').toList();
      return runningCoding.isNotEmpty
          ? 'No job can be stopped from here. Coding job ${runningCoding.first['title']} is running, and CHE cannot cancel a coding job once it has started.'
          : 'No ${kind.isEmpty ? '' : '$kind '}job is waiting or running, so nothing was stopped.';
    }
    if (all.length == 1) return all.first.$1 == 'creation' ? stopCreation(all.first.$2) : stop(all.first.$2);
    return '${all.length} jobs can be stopped, so I will not guess. '
        '${[for (var i = 0; i < all.length && i < 9; i++) '${i + 1}. ${all[i].$1} job ${all[i].$2['title']}, '
            '${all[i].$1 == 'creation' ? cheCreationJobStatus(all[i].$2) : cheCodingJobStatus(all[i].$2)}'].join('; ')}. '
        'Say stop creation job, then its number, or stop job, then a coding job number. Nothing was stopped yet.';
  }

  String get spokenSummary {
    final jobs = codingJobs;
    final list = [for (var i = 0; i < jobs.length && i < 8; i++) '${i + 1}. ${jobs[i]['title']}, ${cheCodingJobStatus(jobs[i])}'];
    final made = creationJobs;
    final cl = [for (var i = 0; i < made.length && i < 8; i++) '${i + 1}. ${made[i]['title']}, ${cheCreationJobStatus(made[i])}'];
    final confirmed = [
      for (final j in _stoppedRunning.take(3))
        '${j['title']}: ${'${j['stop_confirmed_at'] ?? ''}'.isNotEmpty ? 'the worker confirmed the stop' : 'the worker has not confirmed the stop yet'}',
    ];
    return 'Code Studio. ${_current.isEmpty ? 'No current coding job status.' : _current} '
        '${jobs.isEmpty ? 'No coding jobs recorded.' : 'Coding jobs: ${list.join('; ')}.'} '
        '${made.isEmpty ? 'No creation jobs waiting or running.' : 'Creation jobs: ${cl.join('; ')}.'} '
        '${confirmed.isEmpty ? '' : 'Stopped builds: ${confirmed.join('; ')}. '}'
        'Say build, then what to make; stop the job; or stop job, then a number.';
  }

  Future<String?> voice(String words) async {
    if (!mounted || !(ModalRoute.of(context)?.isCurrent ?? true)) return null;
    final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '');
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen)$").hasMatch(t)) return spokenSummary;
    if (RegExp(r'^(?:refresh|update|reload)(?: (?:it|the jobs|coding jobs))?$').hasMatch(t)) {
      await refresh();
      return '${codingJobs.length} coding job${codingJobs.length == 1 ? '' : 's'}. $_current';
    }
    final stopAny = RegExp(r'^(?:stop|cancel|abort)(?: the| this| that| my)?(?: running| current| active)?(?: (creation|coding|render|build|3d))? job$').firstMatch(t);
    if (stopAny != null) {
      final k = stopAny.group(1);
      return stopTheJob(kind: k == null ? '' : (k == 'coding' ? 'coding' : 'creation'));
    }
    final stopC = RegExp(r'^(?:stop|cancel) (?:creation|render|build) job (?:number )?(\d{1,2})$').firstMatch(t);
    if (stopC != null) {
      final n = int.parse(stopC.group(1)!);
      if (n < 1 || n > creationJobs.length) return 'There is no creation job $n.';
      return stopCreation(creationJobs[n - 1]);
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
    if (mounted) {
      setState(() => _reply = text);
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 18))));
    }
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
          if (stoppable.isNotEmpty) ...[
            const SizedBox(height: 12),
            Semantics(
              button: true,
              label: 'Stop the job. ${stoppable.length == 1 ? 'Stops ${stoppable.first.$2['title']}.' : 'Reads the ${stoppable.length} jobs that can be stopped.'}',
              excludeSemantics: true,
              child: FilledButton.icon(
                key: const ValueKey('code-stop-the-job'),
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.redAccent,
                  foregroundColor: Colors.white,
                  minimumSize: const Size.fromHeight(54),
                ),
                onPressed: _stopping ? null : () async => _say(await stopTheJob()),
                icon: const Icon(Icons.stop_circle_rounded),
                label: Text(_stopping ? 'Stopping…' : 'Stop the job'),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Semantics(
            header: true,
            child: Text('CREATION JOBS (${creationJobs.length})', style: const TextStyle(color: CheStudioColors.dim, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 2)),
          ),
          const SizedBox(height: 6),
          if (_creationError != null)
            Text(_creationError!, key: const ValueKey('code-creation-error'), style: const TextStyle(color: Colors.orangeAccent, fontSize: 14))
          else if (creationJobs.isEmpty)
            const Text('No creation jobs waiting or running.', style: TextStyle(color: CheStudioColors.dim, fontSize: 14))
          else
            for (var i = 0; i < creationJobs.length; i++)
              _CreationTile(number: i + 1, job: creationJobs[i], onStop: _stopping ? null : () async => _say(await stopCreation(creationJobs[i]))),
          for (final j in _stoppedRunning.take(3))
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '${j['title']}: stopped; ${'${j['stop_confirmed_at'] ?? ''}'.isNotEmpty ? 'the worker confirmed it at ${'${j['stop_confirmed_at']}'.length >= 16 ? '${j['stop_confirmed_at']}'.substring(11, 16) : ''} UTC.' : 'waiting for the worker to confirm.'}',
                style: const TextStyle(color: CheStudioColors.silver, fontSize: 13),
              ),
            ),
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

class _CreationTile extends StatelessWidget {
  const _CreationTile({required this.number, required this.job, required this.onStop});
  final int number;
  final Map<String, dynamic> job;
  final VoidCallback? onStop;
  @override
  Widget build(BuildContext context) {
    final status = cheCreationJobStatus(job);
    final line = '${job['status_line'] ?? ''}'.trim();
    final worker = '${job['worker_name'] ?? ''}'.trim();
    final on = '${job['state']}' == 'rendering' && worker.isNotEmpty ? ' On the $worker.' : '';
    return Semantics(
      container: true,
      label: 'Creation job $number. ${job['title']}. $status.${line.isEmpty ? '' : ' $line'}$on',
      child: Card(
        key: ValueKey('code-creation-${job['id']}'),
        color: CheStudioColors.card,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$number. ${job['title'] ?? 'Creation job'}', style: const TextStyle(color: CheStudioColors.text, fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text(status, style: const TextStyle(color: CheStudioColors.silver, fontSize: 13)),
              if (line.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(line, style: const TextStyle(color: CheStudioColors.dim, fontSize: 13)),
              ],
              Align(
                alignment: Alignment.centerRight,
                child: Semantics(
                  button: true,
                  label: 'Stop creation job $number, ${job['title']}',
                  excludeSemantics: true,
                  child: TextButton.icon(
                    key: ValueKey('code-creation-stop-${job['id']}'),
                    onPressed: onStop,
                    icon: const Icon(Icons.stop_circle_outlined),
                    label: Text('Stop creation job $number'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
