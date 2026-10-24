// GPU jobs in the Creation Room (owner, 2026-10-24): CHE's render queue on the Worker (gpu_queue.js), worked by the
// owner's Colab T4 notebook while he has a session open. Shows queued, rendering, paused, completed and failed jobs
// with progress and the real GPU pictures, whether the Colab worker is online, and the controls: Pair Colab, Read
// aloud, Refresh, Cancel and Retry. It loads only when the room is shown and never speaks on its own (owner rule,
// 2026-10-11); Read aloud speaks the Worker's summary when he asks.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// One line per job state, as the owner hears and reads it. [device] is the worker's (`cpu` for CHE's free cloud
/// workers), so a CPU job is never called a GPU job.
String cheGpuStateLabel(String state, {String? device}) {
  final cpu = (device ?? '').toLowerCase().startsWith('cpu');
  return switch (state) {
    'queued' => 'Waiting for Resources: the next free worker takes it',
    'rendering' => cpu ? 'Creating on a cloud CPU' : 'Rendering on the GPU',
    'paused' => 'Paused: resumes on the next free worker',
    'completed' => cpu ? 'Completed on a cloud CPU' : 'Completed on the GPU',
    'failed' => 'Failed',
    'cancelled' => 'Cancelled',
    _ => state,
  };
}

/// The jobs, newest first, as the Worker lists them.
List<Map<String, dynamic>> cheGpuJobsFrom(Object? decoded) {
  if (decoded is! Map || decoded['jobs'] is! List) return const [];
  return [for (final j in decoded['jobs'] as List) if (j is Map && '${j['id'] ?? ''}'.isNotEmpty) Map<String, dynamic>.from(j)];
}

class CheGpuJobsCard extends StatefulWidget {
  const CheGpuJobsCard({super.key, required this.baseUrl, required this.headers, this.active = true, this.onRead, this.client});

  final String baseUrl;
  final Map<String, String> headers;
  final bool active;
  final void Function(String text)? onRead;
  final http.Client? client;

  @override
  State<CheGpuJobsCard> createState() => CheGpuJobsCardState();
}

class CheGpuJobsCardState extends State<CheGpuJobsCard> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic> _view = const {};
  bool _loading = true;
  String? _status;

  @override
  void initState() {
    super.initState();
    if (widget.active) unawaited(load());
  }

  @override
  void didUpdateWidget(covariant CheGpuJobsCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) unawaited(load());
  }

  Map<String, String> get _json => {...widget.headers, 'Content-Type': 'application/json'};

  Future<void> load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/gpu'), headers: widget.headers).timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) throw StateError('status ${r.statusCode}');
      final decoded = jsonDecode(r.body);
      if (!mounted) return;
      setState(() {
        _view = decoded is Map ? Map<String, dynamic>.from(decoded) : const {};
        _loading = false;   // an action's confirmation (_status) stays on screen after the reload
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _status = 'Could not load the GPU jobs. Use Refresh to try again.';
      });
    }
  }

  Future<void> _post(String path, Map<String, dynamic> body, String done) async {
    HapticFeedback.selectionClick();
    try {
      final r = await _http.post(Uri.parse('${widget.baseUrl}$path'), headers: _json, body: jsonEncode(body)).timeout(const Duration(seconds: 12));
      final d = jsonDecode(r.body);
      final ok = r.statusCode < 300 && d is Map && d['ok'] == true;
      if (!mounted) return;
      setState(() => _status = ok ? done : 'That did not work: ${d is Map ? d['detail'] ?? r.statusCode : r.statusCode}.');
      if (ok) await load();
    } catch (_) {
      if (mounted) setState(() => _status = 'That did not work: CHE could not be reached.');
    }
  }

  /// Pair Colab: the Worker makes a new worker token (replacing any old one) and it is shown once to copy.
  Future<void> pairColab() async {
    HapticFeedback.mediumImpact();
    String? token;
    try {
      final r = await _http.post(Uri.parse('${widget.baseUrl}/api/gpu/worker-token'), headers: _json, body: '{}').timeout(const Duration(seconds: 12));
      final d = jsonDecode(r.body);
      if (r.statusCode == 200 && d is Map) token = '${d['token'] ?? ''}';
    } catch (_) {}
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      setState(() => _status = 'Pairing did not work: CHE could not make a worker token.');
      return;
    }
    setState(() => _status = 'New Colab worker token made. Any older one no longer works.');
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Colab worker token'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Shown once. In Colab, open Secrets (the key icon), add CHE_GPU_TOKEN with this value, and turn on notebook access.'),
            const SizedBox(height: 12),
            SelectableText(token!, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Clipboard.setData(ClipboardData(text: token!)),
            child: Semantics(label: 'Copy the Colab worker token', child: const Text('Copy')),
          ),
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    const quiet = TextStyle(color: Colors.white60, fontSize: 12, height: 1.4);
    const title = TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600);
    final jobs = cheGpuJobsFrom(_view);
    final workers = (_view['workers'] as List?)?.whereType<Map>().toList() ?? const [];
    final online = workers.where((w) => w['online'] == true).toList();
    final paired = _view['worker_paired'] == true;
    final workerLine = online.isNotEmpty
        ? 'Colab GPU worker online: ${online.first['gpu'] ?? 'GPU'}.'
        : paired
            ? 'No Colab session open. Jobs wait until you run the notebook (Runtime, Run all).'
            : 'Colab worker not paired yet. Use Pair Colab, then run the notebook.';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(header: true, child: const Text('GPU jobs (your Colab T4, free)', style: title)),
        const SizedBox(height: 4),
        Text(_loading ? 'Loading GPU jobs…' : workerLine, style: quiet),
        if (_status != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(_status!, style: quiet)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _button('Read aloud', 'Read the GPU jobs aloud', Icons.refresh,
                widget.onRead == null || _view['spoken'] == null ? null : () => widget.onRead!('${_view['spoken']}')),
            _button('Refresh', 'Refresh the GPU jobs', Icons.refresh, () => unawaited(load())),
            _button(paired ? 'Pair Colab again' : 'Pair Colab', 'Make the Colab worker token', Icons.refresh, () => unawaited(pairColab())),
          ],
        ),
        const SizedBox(height: 8),
        if (!_loading && jobs.isEmpty) const Text('No GPU jobs yet.', style: quiet),
        for (final j in jobs.take(12)) _job(j, quiet),
      ],
    );
  }

  Widget _button(String label, String semantics, IconData icon, VoidCallback? onTap) => Semantics(
        container: true,
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: OutlinedButton.icon(onPressed: onTap, icon: Icon(icon, size: 18), label: Text(label)),
      );

  Widget _job(Map<String, dynamic> j, TextStyle quiet) {
    final state = '${j['state'] ?? ''}';
    final progress = j['progress'] is Map ? Map<String, dynamic>.from(j['progress'] as Map) : const <String, dynamic>{};
    final pct = progress['pct'] is num ? (progress['pct'] as num).toInt() : null;
    final history = (j['history'] as List?)?.whereType<Map>().toList() ?? const [];
    final last = history.isEmpty ? '' : '${history.last['note'] ?? ''}';
    final previews = j['previews'] is Map ? Map<String, dynamic>.from(j['previews'] as Map) : const <String, dynamic>{};
    final label = '${j['title'] ?? 'GPU job'}. ${cheGpuStateLabel(state, device: '${j['device'] ?? ''}')}${pct != null && state == 'rendering' ? ', $pct percent' : ''}. $last';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Semantics(
        container: true,
        explicitChildNodes: true,   // the pictures and each button stay separate VoiceOver elements
        label: label,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(child: Text('${j['title'] ?? 'GPU job'}', style: const TextStyle(color: Colors.white, fontSize: 13))),
            ExcludeSemantics(child: Text(cheGpuStateLabel(state, device: '${j['device'] ?? ''}') + (pct != null && state == 'rendering' ? ' · $pct%' : ''), style: quiet)),
            if (state == 'rendering' && pct != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: ExcludeSemantics(child: LinearProgressIndicator(value: pct / 100))),
            if (last.isNotEmpty) ExcludeSemantics(child: Text(last, style: quiet, maxLines: 3, overflow: TextOverflow.ellipsis)),
            if (previews.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(children: [
                  for (final e in previews.entries)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Semantics(
                        image: true,
                        label: 'GPU picture, ${const {'0': 'front', '45': 'three-quarter', '90': 'side'}[e.key] ?? '${e.key} degrees'} view',
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network('${widget.baseUrl}/api/media/${e.value}/image',
                              headers: widget.headers, width: 72, height: 90, fit: BoxFit.cover, cacheWidth: 200,
                              errorBuilder: (_, _, _) => const SizedBox(width: 72, height: 90)),
                        ),
                      ),
                    ),
                ]),
              ),
            Wrap(spacing: 8, children: [
              if (['queued', 'rendering', 'paused'].contains(state))
                _button('Cancel', 'Cancel ${j['title'] ?? 'this GPU job'}', Icons.close,
                    () => unawaited(_post('/api/gpu/jobs/cancel', {'id': j['id']}, 'Cancelled. Finished views stay in Drive.'))),
              if (['failed', 'cancelled'].contains(state))
                _button('Retry', 'Retry ${j['title'] ?? 'this GPU job'}', Icons.refresh,
                    () => unawaited(_post('/api/gpu/jobs/retry', {'id': j['id']}, 'Queued again. It renders in your next Colab session.'))),
            ]),
          ],
        ),
      ),
    );
  }
}
