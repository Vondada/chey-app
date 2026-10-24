// Settings → Creation Engine, status (owner, 2026-10-24): which compute workers are really connected, how many jobs can
// run at once, which providers start by themselves and which need the owner, the $0 spending limit, and the two
// controls (start free cloud workers automatically; the most cloud workers at once). Everything shown comes from
// GET /api/creations/engine (creation_orchestrator.js); nothing is estimated here. Loading is quiet; Read aloud speaks
// the Worker's own summary, and each control speaks its real result.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'che_creative_studio.dart' show CheStudioColors;

/// "Cloud CPU (GitHub)" / "Colab GPU" for a worker class.
String cheWorkerClassLabel(String cls) => switch (cls) {
  'github_cpu' => 'Cloud CPU (GitHub)',
  'colab_t4' => 'Colab GPU',
  _ => cls.isEmpty ? 'Worker' : cls,
};

class CheEngineStatusCard extends StatefulWidget {
  const CheEngineStatusCard({super.key, required this.baseUrl, required this.headers, this.onRead, this.client});

  final String baseUrl;
  final Map<String, String> headers;

  /// Speaks a text the owner asked for (Read aloud, or a control's result).
  final void Function(String text)? onRead;
  final http.Client? client;

  @override
  State<CheEngineStatusCard> createState() => CheEngineStatusCardState();
}

class CheEngineStatusCardState extends State<CheEngineStatusCard> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic> _view = const {};
  bool _loading = true;
  bool _busy = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  List<Map<String, dynamic>> _list(Object? v) => [
    if (v is List)
      for (final e in v)
        if (e is Map) Map<String, dynamic>.from(e),
  ];

  Map<String, dynamic> get settings => _map(_view['settings']);
  Map<String, dynamic> get capacity => _map(_view['capacity']);
  List<Map<String, dynamic>> get workers => _list(_view['workers']);
  List<Map<String, dynamic>> get providers => _list(_view['providers']);
  List<Map<String, dynamic>> get dispatches => _list(_view['dispatches']);
  String get spoken => '${_view['spoken'] ?? ''}'.trim();

  Future<void> load() async {
    try {
      final r = await _http
          .get(Uri.parse('${widget.baseUrl}/api/creations/engine'), headers: widget.headers)
          .timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) throw StateError('status ${r.statusCode}');
      final d = jsonDecode(r.body);
      if (!mounted) return;
      setState(() {
        _view = d is Map ? Map<String, dynamic>.from(d) : const {};
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _status = 'Could not load the Creation Engine status. Use Refresh to try again.';
      });
    }
  }

  /// Saves one setting and reports the Worker's real answer (banner, haptic, speech).
  Future<String> save(Map<String, Object> change) async {
    if (_busy) return 'Still saving the last change.';
    setState(() => _busy = true);
    String msg;
    var ok = false;
    try {
      final r = await _http
          .post(
            Uri.parse('${widget.baseUrl}/api/creations/engine/settings'),
            headers: {...widget.headers, 'Content-Type': 'application/json'},
            body: jsonEncode(change),
          )
          .timeout(const Duration(seconds: 15));
      final d = jsonDecode(r.body);
      ok = r.statusCode == 200 && d is Map && d['ok'] == true;
      msg = '${d is Map ? d['spoken'] ?? d['detail'] ?? '' : ''}'.trim();
      if (msg.isEmpty) msg = ok ? 'Saved.' : 'The Creation Engine setting was not saved.';
      if (ok && d['view'] is Map) _view = Map<String, dynamic>.from(d['view'] as Map);
    } catch (_) {
      msg = 'Could not reach CHE, so the Creation Engine setting was not saved.';
    }
    if (!mounted) return msg;
    setState(() {
      _busy = false;
      _status = msg;
    });
    if (ok) {
      HapticFeedback.lightImpact();
      unawaited(load());
    } else {
      HapticFeedback.heavyImpact();
    }
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(msg)));
    widget.onRead?.call(msg);
    return msg;
  }

  @override
  Widget build(BuildContext context) {
    const title = TextStyle(color: CheStudioColors.text, fontSize: 17, fontWeight: FontWeight.w800);
    const body = TextStyle(color: CheStudioColors.silver, fontSize: 15, height: 1.4);
    const quiet = TextStyle(color: CheStudioColors.dim, fontSize: 13.5, height: 1.35);
    final auto = settings['auto_cloud'] != false;
    final maxWorkers = (settings['max_cloud_workers'] as num?)?.toInt() ?? 3;
    final running = (capacity['running'] as num?)?.toInt() ?? 0;
    final maxNow = (capacity['max_concurrent'] as num?)?.toInt() ?? 0;
    final spend = settings['spend_limit_usd'] ?? 0;
    return Column(
      key: const ValueKey('engine-status'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(header: true, child: const Text('Compute', style: title)),
            ),
            IconButton(
              tooltip: 'Read the Creation Engine status aloud',
              onPressed: widget.onRead == null || spoken.isEmpty ? null : () => widget.onRead!(spoken),
              icon: const Icon(Icons.volume_up_rounded, color: CheStudioColors.silver),
            ),
            IconButton(
              tooltip: 'Refresh the Creation Engine status',
              onPressed: () {
                HapticFeedback.selectionClick();
                unawaited(load());
              },
              icon: const Icon(Icons.refresh_rounded, color: CheStudioColors.silver),
            ),
          ],
        ),
        if (_loading)
          const Text('Loading…', style: quiet)
        else ...[
          if (spoken.isNotEmpty) Text(spoken, key: const ValueKey('engine-summary'), style: body),
          const SizedBox(height: 10),
          Semantics(
            container: true,
            label: '$running running now. Up to $maxNow jobs can run at once with what is connected and allowed.',
            child: ExcludeSemantics(
              child: Text(
                'Running now: $running · Can run at once: $maxNow',
                key: const ValueKey('engine-capacity'),
                style: const TextStyle(color: CheStudioColors.text, fontSize: 15.5, fontWeight: FontWeight.w700),
              ),
            ),
          ),
          const SizedBox(height: 14),
          const Text('CONNECTED WORKERS', style: quiet),
          const SizedBox(height: 6),
          if (workers.isEmpty)
            const Text('No worker is connected right now.', key: ValueKey('engine-no-workers'), style: body),
          for (final w in workers)
            Semantics(
              container: true,
              label:
                  '${cheWorkerClassLabel('${w['class'] ?? ''}')}, ${w['device'] ?? ''}, ${w['online'] == true ? 'online' : 'offline'}'
                  '${'${w['job_id'] ?? ''}'.isEmpty ? '' : ', working on job ${w['job_id']}'}.',
              child: ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    children: [
                      Icon(
                        '${w['class']}' == 'github_cpu' ? Icons.cloud_rounded : Icons.memory_rounded,
                        size: 20,
                        color: w['online'] == true ? CheStudioColors.teal : CheStudioColors.dim,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          '${cheWorkerClassLabel('${w['class'] ?? ''}')} · ${w['device'] ?? ''} · '
                          '${w['online'] == true ? ('${w['job_id'] ?? ''}'.isEmpty ? 'idle' : 'working') : 'offline'}',
                          style: body,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          const SizedBox(height: 14),
          const Text('PROVIDERS', style: quiet),
          const SizedBox(height: 6),
          for (final p in providers)
            Semantics(
              container: true,
              label:
                  '${p['label'] ?? p['id']}. ${p['automatic'] == true ? 'Starts automatically.' : 'Needs you to start it.'} '
                  '${p['cost'] ?? ''}. ${p['manual_step'] ?? ''}',
              child: ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${p['label'] ?? p['id']} — ${p['automatic'] == true ? 'Automatic' : 'Needs you'}',
                        style: const TextStyle(color: CheStudioColors.text, fontSize: 15, fontWeight: FontWeight.w700),
                      ),
                      if ('${p['cost'] ?? ''}'.isNotEmpty) Text('${p['cost']}', style: quiet),
                      if ('${p['manual_step'] ?? ''}'.isNotEmpty) Text('${p['manual_step']}', style: quiet),
                    ],
                  ),
                ),
              ),
            ),
          const SizedBox(height: 14),
          Semantics(
            container: true,
            label: 'Spending limit: $spend dollars. Nothing paid can start.',
            child: ExcludeSemantics(
              child: Text(
                'Spending limit: \$$spend. Nothing paid can start.',
                key: const ValueKey('engine-spend'),
                style: body,
              ),
            ),
          ),
          const SizedBox(height: 6),
          // The switch keeps its own semantics (label, toggled state and tap action) so VoiceOver can operate it.
          MergeSemantics(
            child: SwitchListTile.adaptive(
              key: const ValueKey('engine-auto-cloud'),
              contentPadding: EdgeInsets.zero,
              activeTrackColor: CheStudioColors.teal,
              title: const Text('Start free cloud workers automatically', style: body),
              value: auto,
              onChanged: _busy || _view.isEmpty ? null : (v) => unawaited(save({'auto_cloud': v})),
            ),
          ),
          Row(
            children: [
              const Expanded(child: Text('Most cloud workers at once', style: body)),
              IconButton(
                key: const ValueKey('engine-workers-less'),
                tooltip: 'One fewer cloud worker at once',
                onPressed: _busy || maxWorkers <= 1
                    ? null
                    : () => unawaited(save({'max_cloud_workers': maxWorkers - 1})),
                icon: const Icon(Icons.remove, color: CheStudioColors.silver),
              ),
              Semantics(
                label: '$maxWorkers cloud workers at once',
                child: ExcludeSemantics(
                  child: Text('$maxWorkers', key: const ValueKey('engine-workers'), style: title),
                ),
              ),
              IconButton(
                key: const ValueKey('engine-workers-more'),
                tooltip: 'One more cloud worker at once',
                onPressed: _busy || maxWorkers >= 10
                    ? null
                    : () => unawaited(save({'max_cloud_workers': maxWorkers + 1})),
                icon: const Icon(Icons.add, color: CheStudioColors.silver),
              ),
            ],
          ),
          if (dispatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            const Text('RECENT CLOUD STARTS', style: quiet),
            for (final d in dispatches.take(3))
              Text(
                '${d['at'] ?? ''} · ${d['ok'] == true ? 'started' : 'not started'} · ${d['detail'] ?? d['reason'] ?? ''}',
                style: quiet,
              ),
          ],
        ],
        if (_status != null) ...[
          const SizedBox(height: 10),
          Text(_status!, key: const ValueKey('engine-status-line'), style: quiet),
        ],
      ],
    );
  }
}
