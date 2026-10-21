// Creator Studio series panel (owner issue #347): the original series, its pilot and each
// platform's real state, from /api/studio. It loads quietly and never speaks by itself.
// "Read aloud" and every action ask CHE in chat, so each answer is spoken, shown as large
// text and reported with its real result; a post still waits for the owner's yes there.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import '../che_ui/che_theme.dart';

const _dim = Color(0xFF9A8FA6);
const _panel = Color(0xFF130A14);
const _good = Color(0xFF3DDC97);
const _warn = CheColors.markets;

/// The words for each state, the same ones CHE says aloud.
const cheStudioStateWords = {
  'connected': 'connected', 'not_connected': 'not connected', 'needs_reconnect': 'needs reconnecting',
  'not_started': 'not rendered', 'queued': 'queued on GitHub', 'rendering': 'rendering', 'verified': 'verified MP4',
  'failed': 'render failed', 'invalid': 'script fails its checks',
};

/// What each button asks CHE, in the owner's own words.
const cheStudioPrompts = {
  'Read aloud': 'What is the pilot status?',
  'Series bible': 'Show the series bible',
  'Pilot script': 'Read me the pilot script',
  'Render pilot': 'Render the pilot',
  'Export for every platform': 'Export the pilot for every platform',
  'Post to YouTube Shorts': 'Post the pilot to YouTube Shorts',
  'Growth plan': 'Show the growth experiments',
};

class CheSeriesStudioPanel extends StatefulWidget {
  const CheSeriesStudioPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<CheSeriesStudioPanel> createState() => _CheSeriesStudioPanelState();
}

class _CheSeriesStudioPanelState extends State<CheSeriesStudioPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _view;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    // Only a client this panel made is closed; a client handed in belongs to its owner.
    if (widget.client == null) _http.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/studio'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map || j['pilot'] is! Map) {
        setState(() => _error = 'The Creator Studio is not available from CHE yet (${r.statusCode}).');
        return;
      }
      setState(() { _view = Map<String, dynamic>.from(j); _error = ''; });
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach CHE for the Creator Studio.');
    }
  }

  void _ask(String button) {
    HapticFeedback.selectionClick();
    widget.onAsk(cheStudioPrompts[button]!);
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final series = v?['series'] is Map ? Map<String, dynamic>.from(v!['series'] as Map) : const <String, dynamic>{};
    final pilot = v?['pilot'] is Map ? Map<String, dynamic>.from(v!['pilot'] as Map) : const <String, dynamic>{};
    final platforms = (v?['platforms'] as List?)?.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() ?? const <Map<String, dynamic>>[];
    final render = '${pilot['render'] ?? 'not_started'}';
    final pilotLine = pilot.isEmpty ? '' : 'Pilot ${pilot['episode']} "${pilot['title']}", ${pilot['seconds']} seconds, ${pilot['scenes']} scenes: ${cheStudioStateWords[render] ?? render}.';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: _panel, border: Border.all(color: const Color(0x40FF3D8B)), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text('${series['title'] ?? 'Series'}', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
          IconButton(tooltip: 'Refresh the Creator Studio', onPressed: _load, icon: const Icon(Icons.refresh, color: _dim)),
          TextButton(onPressed: () => _ask('Read aloud'), child: const Text('Read aloud')),
        ]),
        if (pilotLine.isNotEmpty)
          Semantics(
            label: '${series['format_label'] ?? ''}. $pilotLine',
            excludeSemantics: true,
            child: Text(pilotLine, style: const TextStyle(color: Colors.white70, fontSize: 16)),
          ),
        if (v?['capability'] != null)
          Padding(padding: const EdgeInsets.only(top: 4), child: Text('${v!['capability']}', style: const TextStyle(color: _dim, fontSize: 13))),
        if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error, style: const TextStyle(color: _dim, fontSize: 14))),
        for (final p in platforms)
          Semantics(
            label: '${p['label']}: ${cheStudioStateWords['${p['connection']}'] ?? p['connection']}'
                '${p['posted'] != null ? ', posted unlisted' : p['exported'] == true ? ', package checked' : ''}.',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(children: [
                Expanded(child: Text('${p['label']}', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700))),
                Text(
                  p['posted'] != null ? 'posted' : cheStudioStateWords['${p['connection']}'] ?? '${p['connection']}',
                  style: TextStyle(color: p['connection'] == 'connected' ? _good : _warn, fontSize: 13, fontWeight: FontWeight.w800),
                ),
              ]),
            ),
          ),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final button in cheStudioPrompts.keys.where((b) => b != 'Read aloud'))
            OutlinedButton(onPressed: () => _ask(button), child: Text(button)),
        ]),
      ]),
    );
  }
}
