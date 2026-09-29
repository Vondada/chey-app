// CHE AI & Models area (inside Plugins & Learning).
//
// Shows CHE's universal AI layer: connected providers, available models,
// Office workers and which engine backs them, health, preferred-model policy,
// newly discovered model candidates and privacy permissions. Everything is
// voice-first: each section reads as a spoken list, and every action is a
// sentence CHE understands by voice, so nothing needs the screen.
// The Worker never sends credential values here — only connection states.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';

class CheAiModelsPanel extends StatefulWidget {
  const CheAiModelsPanel({super.key, required this.load, this.onRunPrompt});

  /// GET /api/ai/overview from the CHE Worker.
  final Future<Map<String, dynamic>> Function() load;

  /// Sends a spoken-style command to CHE (the same words work by voice).
  final void Function(String prompt)? onRunPrompt;

  @override
  State<CheAiModelsPanel> createState() => _CheAiModelsPanelState();
}

class _CheAiModelsPanelState extends State<CheAiModelsPanel> {
  late Future<Map<String, dynamic>> _future = widget.load();

  void _reload() => setState(() => _future = widget.load());

  void _say(String prompt) {
    HapticFeedback.selectionClick();
    widget.onRunPrompt?.call(prompt);
  }

  List<Map<String, dynamic>> _list(Object? value) => [
        for (final item in (value as List? ?? const []))
          if (item is Map) Map<String, dynamic>.from(item),
      ];

  Widget _section(String title, List<String> lines, {String empty = 'Nothing yet.'}) {
    final shown = lines.isEmpty ? [empty] : lines;
    return Semantics(
      container: true,
      label: '$title. ${lines.isEmpty ? empty : [for (var i = 0; i < lines.length; i++) '${i + 1}. ${lines[i]}'].join('. ')}',
      excludeSemantics: true,
      child: Container(
        margin: const EdgeInsets.only(bottom: CheSpace.md),
        padding: const EdgeInsets.all(CheSpace.md),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title.toUpperCase(), style: CheType.overline),
          const SizedBox(height: CheSpace.xs),
          for (final line in shown.take(12))
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(line, style: lines.isEmpty ? CheType.bodyDim : CheType.body),
            ),
          if (shown.length > 12) Text('+${shown.length - 12} more', style: CheType.caption),
        ]),
      ),
    );
  }

  Widget _action(String label, String prompt, IconData icon) => Semantics(
        button: true,
        label: '$label. Same as saying: $prompt',
        excludeSemantics: true,
        onTap: widget.onRunPrompt == null ? null : () => _say(prompt),
        child: ActionChip(
          avatar: Icon(icon, size: 16, color: CheColors.accent),
          label: Text(label),
          onPressed: widget.onRunPrompt == null ? null : () => _say(prompt),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.all(CheSpace.lg),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        if (snap.hasError || snap.data == null) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('CHE couldn\'t load the AI layer: ${snap.error ?? 'no data'}', style: CheType.bodyDim),
            TextButton(onPressed: _reload, child: const Text('Try again')),
          ]);
        }
        final d = snap.data!;
        final providers = _list(d['providers']);
        final connected = providers.where((p) => p['state'] == 'connected').toList();
        final waiting = providers.where((p) => p['state'] != 'connected').toList();
        final models = _list(d['models']);
        final workers = _list(d['office_workers']);
        final candidates = _list(d['candidates']);
        final health = d['health'] is Map ? Map<String, dynamic>.from(d['health'] as Map) : <String, dynamic>{};
        final privacy = d['privacy'] is Map ? Map<String, dynamic>.from(d['privacy'] as Map) : <String, dynamic>{};
        final policy = d['policy'] is Map ? Map<String, dynamic>.from(d['policy'] as Map) : <String, dynamic>{};
        final lastCalls = _list(d['last_calls']);

        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Semantics(
            liveRegion: true,
            child: Text(
              '${connected.length} providers connected · ${models.length} models · ${workers.length} Office workers',
              style: CheType.label,
            ),
          ),
          const SizedBox(height: CheSpace.sm),
          Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
            _action('What models do I have?', 'CHE, what AI models do you have?', Icons.hub_rounded),
            _action('Who answered last?', 'Which one handled my last question?', Icons.history_rounded),
            _action('Newest model', "What's the newest model you found?", Icons.new_releases_outlined),
            _action('Grok + GPT together', 'Use Grok and GPT together on this.', Icons.join_inner_rounded),
            _action('Grok coding employee', 'Make a Grok coding employee.', Icons.person_add_alt_1_rounded),
            _action('Strongest model', 'Use the strongest model available.', Icons.bolt_rounded),
            _action('Normal routing', 'Use normal routing.', Icons.alt_route_rounded),
            _action('Local AI only', 'Use only local AI for this.', Icons.lock_outline_rounded),
            Semantics(
              button: true,
              label: 'Refresh the AI and models screen',
              excludeSemantics: true,
              onTap: _reload,
              child: ActionChip(
                avatar: const Icon(Icons.refresh_rounded, size: 16, color: CheColors.accent),
                label: const Text('Refresh'),
                onPressed: _reload,
              ),
            ),
          ]),
          const SizedBox(height: CheSpace.md),
          _section('Connected providers', [
            for (final p in connected)
              '${p['name']} · ${p['locality'] == 'local' ? 'local' : 'cloud'} · ${p['models'] ?? 0} models',
          ], empty: 'Only CHE\'s built-in engine is connected.'),
          _section('Available to connect', [
            for (final p in waiting) '${p['name']}: ${p['connect_hint'] ?? ''}',
          ], empty: 'Every known provider is connected.'),
          _section('Available models', [
            for (final m in models.take(40))
              '${m['model']} (${m['provider']})${m['trial'] == true ? ' · trial' : ''}',
          ], empty: 'Model lists refresh from connected providers twice a day.'),
          _section('Office workers', [
            for (final w in workers)
              '${w['name']} · ${w['role']} · engine: ${w['provider'] == 'auto' ? 'best available' : w['provider']}',
          ], empty: 'No Office workers yet.'),
          _section('Health', [
            for (final entry in health.entries)
              if (entry.value is Map)
                '${entry.key}: score ${((entry.value as Map)['score'] as num? ?? 1).toStringAsFixed(2)}'
                    '${(entry.value as Map)['avg_latency_ms'] != null ? ' · ${(entry.value as Map)['avg_latency_ms']} ms' : ''}'
                    '${(entry.value as Map)['quota_exhausted'] == true ? ' · resting (quota)' : ''}',
          ], empty: 'No calls recorded yet.'),
          _section('Preferred models', [
            'Strongest model always: ${policy['prefer_strongest'] == true ? 'on' : 'off'}',
            'Local AI only: ${policy['local_only'] == true ? 'on' : 'off'}',
            'Auto-use new models that pass checks: ${policy['auto_promote_models'] == false ? 'off' : 'on'}',
            'Cost limit: ${policy['max_cost_class'] ?? 'high'}',
            if (lastCalls.isNotEmpty) 'Last answer: ${lastCalls.first['provider']} · ${lastCalls.first['model']}',
          ]),
          _section('New model candidates', [
            for (final c in candidates)
              '${c['model']} from ${c['provider']} · ${'${c['status'] ?? 'candidate'}'.replaceAll('_', ' ')}'
                  '${c['score'] != null ? ' · score ${c['score']}' : ''}',
          ], empty: 'No new models found since the first scan.'),
          _section('Privacy permissions', [
            for (final entry in privacy.entries)
              '${entry.key}: ${(entry.value as List? ?? const []).join(', ')}',
          ]),
          Text(
            'Your memory stays in CHE. Each AI only gets the minimum relevant context it is allowed to see, '
            'and secrets are never sent. Say "Don\'t send my personal memories to Gemini" to change a permission; '
            'CHE confirms out loud before changing it.',
            style: CheType.caption,
          ),
        ]);
      },
    );
  }
}
