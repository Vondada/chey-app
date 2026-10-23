// More → Film Studio (also "open the film studio" in chat). CHE's free film pipeline (/api/film): the current film,
// its real progress (elapsed time against the estimate), its shots and their checks, and the free render farm with
// each provider's real status and quota. Everything also works by voice in chat ("make me a 10-minute movie about
// …", "how's my movie going", "remake shot 12", "pause my movie", "render farm status").
//
// Opening the room is quiet: progress is muted text that refreshes itself; CHE speaks only when the owner presses
// Read Aloud or acts. Every action reports its real outcome as text, a haptic and a VoiceOver announcement.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import '../che_ui/che_foreground.dart';

class CheFilmClient {
  CheFilmClient({required this.baseUrl, required this.headers, http.Client? client}) : _client = client ?? http.Client();
  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  Future<Map<String, dynamic>> _decode(Future<http.Response> Function() send) async {
    if (baseUrl.isEmpty) throw Exception('CHE is not connected on this iPhone yet.');
    final http.Response r;
    try {
      r = await send().timeout(const Duration(seconds: 30));
    } on TimeoutException {
      throw Exception('CHE did not answer within 30 seconds.');
    }
    Object? body;
    try {
      body = r.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } on FormatException {
      body = null;
    }
    final map = body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};
    if (r.statusCode >= 400) throw Exception(map['detail']?.toString() ?? map['said']?.toString() ?? 'CHE answered ${r.statusCode}.');
    return map;
  }

  Future<Map<String, dynamic>> view() => _decode(() => _client.get(Uri.parse('$baseUrl/api/film'), headers: headers()));
  Future<Map<String, dynamic>> action(Map<String, dynamic> body) => _decode(() => _client.post(
        Uri.parse('$baseUrl/api/film'),
        headers: {...headers(), 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ));
}

/// "1 hour 5 minutes", "40 seconds": the way CHE says a duration.
String cheFilmDuration(num seconds) {
  final s = seconds.round();
  if (s < 90) return '$s second${s == 1 ? '' : 's'}';
  final m = (s / 60).round();
  if (m < 90) return '$m minute${m == 1 ? '' : 's'}';
  final h = m ~/ 60, r = m % 60;
  return '$h hour${h == 1 ? '' : 's'}${r > 0 ? ' $r minute${r == 1 ? '' : 's'}' : ''}';
}

class CheFilmStudioScreen extends StatefulWidget {
  const CheFilmStudioScreen({super.key, required this.client, this.onSpeak, this.onListen, this.refreshEvery = const Duration(seconds: 15)});
  final CheFilmClient client;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;
  final Duration refreshEvery;

  @override
  State<CheFilmStudioScreen> createState() => _CheFilmStudioScreenState();
}

class _CheFilmStudioScreenState extends State<CheFilmStudioScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  String _status = '';
  bool _busy = false;
  Timer? _timer;
  final _topic = TextEditingController();
  final _shot = TextEditingController();
  int _seconds = 600;
  int? _deadline; // null: CHE's default for the length; 0: as fast as possible

  static const _lengths = {300: '5 minutes', 600: '10 minutes', 1800: '30 minutes', 3600: '1 hour', 7200: '2 hours'};
  static const _active = {'scripting', 'making', 'assembling', 'verifying'};

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _timer = Timer.periodic(widget.refreshEvery, (_) {
      final state = (_view?['film'] as Map?)?['state'];
      if (_active.contains(state) && cheAppInForeground()) unawaited(_load());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _topic.dispose();
    _shot.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final v = await widget.client.view();
      if (!mounted) return;
      setState(() { _view = v; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'I could not load Film Studio: ${e.toString().replaceFirst('Exception: ', '')}');
    }
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

  Future<void> _act(Map<String, dynamic> body) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final out = await widget.client.action(body);
      final said = out['said']?.toString() ?? 'Done.';
      _report(said, ok: out['ok'] != false);
      await _load();
    } catch (e) {
      _report('That did not work: ${e.toString().replaceFirst('Exception: ', '')}', ok: false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _make({required bool planOnly}) async {
    final topic = _topic.text.trim();
    if (!planOnly && topic.isEmpty) {
      _report('Say or type what the film is about first.', ok: false);
      return;
    }
    await _act({'action': planOnly ? 'plan' : 'make', 'topic': topic, 'seconds': _seconds, if (_deadline != null) 'deadline_s': _deadline});
  }

  Future<void> _remake() async {
    final n = int.tryParse(_shot.text.trim());
    if (n == null || n < 1) {
      _report('Type the shot number to remake.', ok: false);
      return;
    }
    await _act({'action': 'remake', 'shot': n});
  }

  String _readAloudText() {
    final v = _view;
    if (v == null) return _error ?? 'Film Studio is loading.';
    final parts = <String>[v['spoken']?.toString() ?? ''];
    final film = v['film'] as Map?;
    final notes = (film?['notes'] as List?)?.map((e) => '$e').toList() ?? const [];
    parts.addAll(notes);
    if (_status.isNotEmpty) parts.add(_status);
    return parts.where((p) => p.trim().isNotEmpty).join(' ');
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final film = v?['film'] is Map ? Map<String, dynamic>.from(v!['film'] as Map) : null;
    final progress = v?['progress'] is Map ? Map<String, dynamic>.from(v!['progress'] as Map) : null;
    final providers = (v?['providers'] as List?)?.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() ?? const [];
    final shots = (v?['shots'] as List?)?.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() ?? const [];
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Film Studio')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Wrap(spacing: 12, runSpacing: 8, children: [
            FilledButton.icon(
              onPressed: () => widget.onSpeak?.call(_readAloudText()),
              icon: const Icon(Icons.record_voice_over_rounded),
              label: const Text('Read Aloud'),
            ),
            if (widget.onListen != null)
              OutlinedButton.icon(onPressed: widget.onListen, icon: const Icon(Icons.mic_rounded), label: const Text('Talk to CHE')),
            OutlinedButton.icon(onPressed: _busy ? null : _load, icon: const Icon(Icons.refresh_rounded), label: const Text('Refresh')),
          ]),
          if (_status.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Semantics(liveRegion: true, child: Text(_status, style: text.titleMedium)),
            ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: text.titleMedium)),
          const SizedBox(height: 16),
          Text('Current film', style: text.titleLarge),
          const SizedBox(height: 8),
          // Passive progress: muted text, no announcement on its own.
          Text(v?['spoken']?.toString() ?? 'Loading…', style: text.titleMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          if (film != null && progress != null) ...[
            const SizedBox(height: 8),
            Semantics(
              label: '${progress['shots_verified']} of ${progress['shots_total']} shots done. ${cheFilmDuration(progress['elapsed_s'] as num? ?? 0)} elapsed of an estimated ${cheFilmDuration(progress['eta_s'] as num? ?? 0)}.',
              child: ExcludeSemantics(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  LinearProgressIndicator(value: ((progress['shots_total'] as num?) ?? 0) > 0 ? ((progress['shots_verified'] as num) / (progress['shots_total'] as num)).clamp(0, 1).toDouble() : null),
                  const SizedBox(height: 4),
                  Text('${progress['shots_verified']} of ${progress['shots_total']} shots · ${cheFilmDuration(progress['elapsed_s'] as num? ?? 0)} of about ${cheFilmDuration(progress['eta_s'] as num? ?? 0)}'),
                ]),
              ),
            ),
            if (film['plan'] is Map) Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_planLine(Map<String, dynamic>.from(film['plan'] as Map))),
            ),
            for (final note in (film['notes'] as List? ?? const [])) Text('$note'),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (_active.contains(film['state']))
                OutlinedButton(onPressed: _busy ? null : () => _act({'action': 'pause'}), child: const Text('Pause film')),
              if (film['state'] == 'paused')
                OutlinedButton(onPressed: _busy ? null : () => _act({'action': 'resume'}), child: const Text('Resume film')),
              if (_active.contains(film['state']) || film['state'] == 'paused')
                OutlinedButton(onPressed: _busy ? null : () => _act({'action': 'cancel'}), child: const Text('Stop film')),
            ]),
            const SizedBox(height: 8),
            // Wraps at narrow widths and large text instead of pushing the button off screen.
            Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.end, children: [
              SizedBox(
                width: 120,
                child: TextField(
                  controller: _shot,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Shot number'),
                ),
              ),
              OutlinedButton(onPressed: _busy ? null : _remake, child: const Text('Remake this shot')),
            ]),
          ],
          const SizedBox(height: 24),
          Text('New film', style: text.titleLarge),
          TextField(
            controller: _topic,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'What is the film about?'),
          ),
          const SizedBox(height: 8),
          Text('Length', style: text.titleMedium),
          Wrap(spacing: 8, children: [
            for (final e in _lengths.entries)
              ChoiceChip(label: Text(e.value), selected: _seconds == e.key, onSelected: (_) => setState(() => _seconds = e.key)),
          ]),
          const SizedBox(height: 8),
          Text('When you need it', style: text.titleMedium),
          Wrap(spacing: 8, children: [
            ChoiceChip(label: const Text('As fast as possible'), selected: _deadline == 0, onSelected: (_) => setState(() => _deadline = 0)),
            ChoiceChip(label: Text('In ${cheFilmDuration(_seconds / 2)}'), selected: _deadline == _seconds ~/ 2, onSelected: (_) => setState(() => _deadline = _seconds ~/ 2)),
            ChoiceChip(label: const Text('CHE decides'), selected: _deadline == null, onSelected: (_) => setState(() => _deadline = null)),
          ]),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            OutlinedButton(onPressed: _busy ? null : () => _make(planOnly: true), child: const Text('Show the plan and time')),
            FilledButton(onPressed: _busy ? null : () => _make(planOnly: false), child: const Text('Make the film')),
          ]),
          if (shots.isNotEmpty) ...[
            const SizedBox(height: 24),
            Text('Shots', style: text.titleLarge),
            for (final s in shots.take(120))
              ListTile(
                dense: true,
                title: Text('Shot ${s['n']}: ${s['description']}'),
                subtitle: Text([
                  s['status'] == 'verified' ? 'checked' : '${s['status']}',
                  s['tier'] == 'A' ? 'moving clip' : 'still with camera motion',
                  if ('${s['reason']}'.isNotEmpty) '${s['reason']}',
                  if ('${s['downgraded']}'.isNotEmpty) 'was a moving clip: ${s['downgraded']}',
                ].join(' · ')),
              ),
          ],
          const SizedBox(height: 24),
          Text('Free render farm', style: text.titleLarge),
          const Text('Only free compute. Your own computer is never used.'),
          for (final p in providers)
            ListTile(
              title: Text('${p['name']}: ${p['status']}'),
              subtitle: Text('${p['detail'] ?? ''}'),
            ),
          OutlinedButton(onPressed: _busy ? null : () => _act({'action': 'farm'}), child: const Text('Check the farm now')),
        ],
      ),
    );
  }

  String _planLine(Map<String, dynamic> p) {
    if (p['ok'] == false) return '${p['said'] ?? ''}';
    final mix = ((p['tier_a'] as num?) ?? 0) > 0 ? '${p['tier_a']} moving clips and ${p['tier_b']} stills with motion' : 'all stills with camera motion';
    return 'Plan: ${p['shots']} shots, $mix, ${p['segments']} runners in parallel. Estimate ${cheFilmDuration(p['eta_s'] as num? ?? 0)}${p['estimated'] == true ? ' (starting numbers)' : ' (measured)'}.';
  }
}
