// CHE's Invention Studio page (owner, 2026-10-22). Shows a saved invention project: its concept picture, the parts by
// subsystem with a sourcing label on every part, cost bands per tier, feasibility notes, stages and the testing checklist.
// Every value is read from the Worker's project record; nothing is made up here. Quiet text: nothing speaks on load.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';
import 'che_invention_viewer.dart';

/// One saved project, read from GET /api/inventions/:id. Missing fields read as empty, never as invented values.
class CheInventionView {
  CheInventionView(this.json);

  final Map<String, dynamic> json;

  String get title => '${json['title'] ?? 'Invention'}';
  String get id => '${json['id'] ?? ''}';
  String get conceptMediaId => '${(json['concept'] as Map?)?['media_id'] ?? ''}';
  String get conceptReason => '${(json['concept'] as Map?)?['reason'] ?? ''}';

  /// Saved concept pictures and 3D model versions (invention_visuals.js), oldest first.
  List<Map<String, dynamic>> get images => _maps((json['visuals'] as Map?)?['images']);
  List<Map<String, dynamic>> get models => _maps((json['visuals'] as Map?)?['models']);

  List<Map<String, dynamic>> get parts => _maps(json['parts']);
  List<Map<String, dynamic>> get subsystems => _maps(json['subsystems']);
  List<String> get stages => _maps(json['stages']).map((s) => '${s['name'] ?? ''}').toList();
  List<String> get tests => _strings(json['tests']);

  /// Low and high cost band for a tier ("budget", "mid", "premium"), or null when the record holds none.
  ({num low, num high})? tierBand(String tier) {
    final tiers = (json['cost'] as Map?)?['tiers'];
    final band = tiers is Map ? tiers[tier] : null;
    if (band is! Map || band['low'] is! num || band['high'] is! num) return null;
    return (low: band['low'] as num, high: band['high'] as num);
  }

  /// Feasibility notes under one heading: realistic_today, too_heavy, power_limited, unsafe, and the rest.
  List<String> feasibility(String key) {
    final f = json['feasibility'];
    return f is Map ? _strings(f[key]) : const [];
  }

  /// Subsystem cost band for one tier, or null.
  ({num low, num high})? subsystemBand(Map<String, dynamic> subsystem, String tier) {
    final cost = subsystem['cost'];
    final band = cost is Map ? cost[tier] : null;
    if (band is! Map || band['low'] is! num || band['high'] is! num) return null;
    return (low: band['low'] as num, high: band['high'] as num);
  }

  static List<Map<String, dynamic>> _maps(Object? value) =>
      value is List ? value.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : const [];

  static List<String> _strings(Object? value) =>
      value is List ? value.map((v) => '$v').where((v) => v.trim().isNotEmpty).toList() : const [];
}

/// The sourcing label a part carries, as shown. Anything not one of the five labels is "unavailable / unknown".
String cheInventionLabel(Map<String, dynamic> part) {
  const known = {
    'verified source',
    'estimated source',
    'conceptual',
    'custom fabrication required',
    'unavailable / unknown',
  };
  final label = '${part['label'] ?? ''}';
  return known.contains(label) ? label : 'unavailable / unknown';
}

String cheInventionBand(({num low, num high})? band) {
  if (band == null) return 'not costed';
  return '${band.low.round()} to ${band.high.round()} USD';
}

/// The project in full: concept, parts by subsystem with labels, costs, feasibility, stages and tests. Stateless, so it
/// can be tested without a network.
class CheInventionDetail extends StatelessWidget {
  const CheInventionDetail({super.key, required this.project, this.imageUrl, this.headers = const {}, this.onAction, this.busy = false});

  final CheInventionView project;
  final String? imageUrl;

  /// The owner's device headers: concept pictures are owner-only files.
  final Map<String, String> headers;

  /// A visual action: concept, model, view3d.
  final void Function(String action)? onAction;
  final bool busy;

  static const _tiers = {'budget': 'Low-budget prototype', 'mid': 'Mid-range', 'premium': 'Premium / advanced'};

  @override
  Widget build(BuildContext context) {
    final header = Theme.of(context).textTheme.titleMedium?.copyWith(color: CheColors.accent);
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter, vertical: CheSpace.md),
      children: [
        Text(project.title, style: header, semanticsLabel: 'Invention: ${project.title}'),
        const SizedBox(height: CheSpace.sm),
        _section('Concept', [
          if (imageUrl != null && project.conceptMediaId.isNotEmpty)
            Semantics(
              image: true,
              label: 'Concept picture for ${project.title}',
              child: Image.network(imageUrl!, headers: headers, errorBuilder: (_, _, _) => const Text('The concept picture could not be shown.')),
            )
          else
            Text(project.conceptReason.isEmpty ? 'No concept picture yet.' : project.conceptReason),
          if (project.images.isNotEmpty)
            Text('Concept picture ${project.images.last['v']} of ${project.images.length}: ${project.images.last['provenance'] ?? project.images.last['engine']}.'),
          Text(project.models.isEmpty
              ? 'No 3D model yet.'
              : '3D model version ${project.models.last['v']} (${project.models.last['colour']}, ${project.models.last['meshes']} parts): ${project.models.last['kind']}.'),
          if (onAction != null)
            Wrap(
              spacing: CheSpace.sm,
              children: [
                _action('New concept picture', 'Make a new concept picture and save it to this project', Icons.image_outlined, 'concept'),
                if (project.models.isEmpty)
                  _action('Make 3D model', 'Build a 3D model of this invention and save it', Icons.view_in_ar_rounded, 'model')
                else
                  _action('View in 3D', 'Open the 3D model to rotate, zoom and change the colour', Icons.view_in_ar, 'view3d'),
              ],
            ),
        ]),
        _section('Cost by tier (planning bands, not quotes)', [
          for (final tier in _tiers.entries) Text('${tier.value}: ${cheInventionBand(project.tierBand(tier.key))}'),
          const Text('Supplier lookup is not connected, so no vendor, link, exact price or lead time is confirmed.'),
        ]),
        _section('Subsystems', [
          for (final s in project.subsystems)
            Text('${s['name']}: ${cheInventionBand(project.subsystemBand(s, 'mid'))} mid-range'),
        ]),
        _section('Parts', [
          for (final p in project.parts) _partRow(p),
        ]),
        _section('Feasibility', [
          for (final entry in const {
            'realistic_today': 'Realistic today',
            'too_heavy': 'Likely too heavy',
            'power_limited': 'Power-limited',
            'unsafe': 'Unsafe without controls',
            'advanced_fabrication': 'Needs advanced fabrication',
            'prototype_first': 'Prototype first',
            'concept_only': 'Concept only',
          }.entries)
            for (final note in project.feasibility(entry.key)) Text('${entry.value}: $note'),
        ]),
        _section('Stages', [for (final stage in project.stages) Text(stage)]),
        _section('Testing checklist', [for (final test in project.tests) Text('• $test')]),
      ],
    );
  }

  Widget _action(String label, String semantics, IconData icon, String action) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: OutlinedButton.icon(onPressed: busy ? null : () => onAction!(action), icon: Icon(icon, size: 18), label: Text(label)),
      );

  Widget _partRow(Map<String, dynamic> p) {
    final label = cheInventionLabel(p);
    final cats = p['sourcing'] is Map ? (p['sourcing']['categories'] as List? ?? const []).join(', ') : '';
    return Semantics(
      label: '${p['name']}. ${p['subsystem']}. Quantity ${p['quantity']}. $label.',
      child: Padding(
        padding: const EdgeInsets.only(bottom: CheSpace.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${p['name']} × ${p['quantity']}', style: const TextStyle(fontWeight: FontWeight.w700)),
            Text('${p['subsystem']} · $label · ${p['kind'] == 'custom_fabricated' ? 'custom-fabricated' : p['kind'] == 'conceptual' ? 'conceptual only' : 'off the shelf'}'),
            if (p['kind'] != 'conceptual') Text('Where it could come from: ${cats.isEmpty ? 'not recorded' : cats}'),
            if (p['kind'] == 'conceptual') const Text('Not costed: no source CHE can name or check.'),
          ],
        ),
      ),
    );
  }

  Widget _section(String title, List<Widget> children) => Padding(
        padding: const EdgeInsets.only(top: CheSpace.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2)),
            const SizedBox(height: CheSpace.xs),
            ...children,
          ],
        ),
      );
}

/// The saved projects, newest first. Opening one loads its full record. Failure is shown on screen, never spoken.
class CheInventionStudioPage extends StatefulWidget {
  const CheInventionStudioPage({super.key, required this.baseUrl, required this.headers, this.openId, this.onSpeak, this.client});

  final String baseUrl;
  final Map<String, String> headers;

  /// A project to open straight away (a Showroom card or a chat reply names it).
  final String? openId;

  /// Speaks the result of a button action (voice results are spoken by the voice route).
  final void Function(String text)? onSpeak;
  final http.Client? client;

  /// While the page is open, "show me", "open it in 3D" and "change the colour to …" reach it first.
  static Future<String?> Function(String words)? voiceHandler;

  static Route<void> route({required String baseUrl, required Map<String, String> headers, String? openId, void Function(String text)? onSpeak}) =>
      MaterialPageRoute<void>(builder: (_) => CheInventionStudioPage(baseUrl: baseUrl, headers: headers, openId: openId, onSpeak: onSpeak));

  @override
  State<CheInventionStudioPage> createState() => _CheInventionStudioPageState();
}

class _CheInventionStudioPageState extends State<CheInventionStudioPage> {
  List<Map<String, dynamic>> _items = const [];
  CheInventionView? _open;
  String _error = '';
  bool _loading = true;
  bool _busy = false;
  late final http.Client _http = widget.client ?? http.Client();

  @override
  void initState() {
    super.initState();
    CheInventionStudioPage.voiceHandler = voice;
    _loadList();
    final id = widget.openId;
    if (id != null && id.isNotEmpty) _openProject(id);
  }

  @override
  void dispose() {
    if (CheInventionStudioPage.voiceHandler == voice) CheInventionStudioPage.voiceHandler = null;
    if (widget.client == null) _http.close();
    super.dispose();
  }

  /// Runs one visual action on the open project and returns what the Worker really did.
  Future<String> act(String action, {String? colour}) async {
    final project = _open;
    if (project == null) return 'Open an invention project first.';
    if (action == 'view3d') {
      if (project.models.isEmpty) return act('model');
      unawaited(Navigator.of(context).push(CheInventionViewer.route(
        baseUrl: widget.baseUrl, headers: widget.headers, inventionId: project.id, title: project.title, onSpeak: widget.onSpeak)));
      return 'Opening 3D model version ${project.models.last['v']} of ${project.title}.';
    }
    setState(() => _busy = true);
    try {
      final res = await _http.post(
        Uri.parse('${widget.baseUrl}/api/inventions/${project.id}/visual'),
        headers: {...widget.headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'action': action, 'colour': ?colour}),
      );
      final body = jsonDecode(res.body);
      if (body is Map && body['project'] is Map) _open = CheInventionView(Map<String, dynamic>.from(body['project'] as Map));
      final said = body is Map && body['spoken'] != null ? '${body['spoken']}' : 'That did not work (HTTP ${res.statusCode}).';
      if (action == 'model' && body is Map && body['ok'] == true && mounted) {
        unawaited(Navigator.of(context).push(CheInventionViewer.route(
          baseUrl: widget.baseUrl, headers: widget.headers, inventionId: project.id, title: project.title, onSpeak: widget.onSpeak)));
      }
      return said;
    } catch (_) {
      return 'That did not work. Check the connection and try again.';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Voice and typing while the page shows a project; null when the words are not the page's.
  Future<String?> voice(String words) async {
    if (_open == null) return null;
    final t = words.toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').trim();
    if (RegExp(r'\b(?:in|into) 3d\b|\b3d (?:model|view)\b|\bview in 3d\b').hasMatch(t)) return act('view3d');
    if (RegExp(r'^(?:show me|let me see|what does it look like|new (?:concept|picture)|show me (?:it|the \w+))$').hasMatch(t)) return act('concept');
    final colour = cheInventionViewerIntent(words);
    if (colour?.colour != null) return act('colour', colour: colour!.colour);
    if (colour?.say != null) return colour!.say;
    return null;
  }

  Future<void> _button(String action) async {
    final said = await act(action);
    widget.onSpeak?.call(said);
  }

  Future<void> _loadList() async {
    try {
      final res = await _http.get(Uri.parse('${widget.baseUrl}/api/inventions'), headers: widget.headers);
      final body = jsonDecode(res.body);
      if (res.statusCode != 200 || body is! Map) throw StateError('HTTP ${res.statusCode}');
      setState(() {
        _items = [for (final item in (body['items'] as List? ?? const [])) if (item is Map) Map<String, dynamic>.from(item)];
        _error = '';
        _loading = false;
      });
    } catch (_) {
      setState(() {
        _error = 'I could not load your invention projects. Check the connection and try again.';
        _loading = false;
      });
    }
  }

  Future<void> _openProject(String id) async {
    try {
      final res = await _http.get(Uri.parse('${widget.baseUrl}/api/inventions/$id'), headers: widget.headers);
      final body = jsonDecode(res.body);
      if (res.statusCode != 200 || body is! Map) throw StateError('HTTP ${res.statusCode}');
      setState(() => _open = CheInventionView(Map<String, dynamic>.from(body)));
    } catch (_) {
      setState(() => _error = 'I could not open that project.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final project = _open;
    return Scaffold(
      appBar: AppBar(
        title: Text(project?.title ?? 'Invention Studio'),
        leading: project == null
            ? null
            : IconButton(
                tooltip: 'Back to projects',
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() => _open = null),
              ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error.isNotEmpty
              ? Padding(padding: const EdgeInsets.all(CheSpace.gutter), child: Text(_error))
              : project != null
                  ? CheInventionDetail(
                      project: project,
                      headers: widget.headers,
                      busy: _busy,
                      onAction: _button,
                      imageUrl: project.conceptMediaId.isEmpty
                          ? null
                          : '${widget.baseUrl}/api/media/${project.conceptMediaId}/image',
                    )
                  : _items.isEmpty
                      ? const Padding(
                          padding: EdgeInsets.all(CheSpace.gutter),
                          child: Text('No invention projects yet. Ask CHE to design one, such as "design me an Iron Man-style suit".'),
                        )
                      : ListView(
                          padding: const EdgeInsets.all(CheSpace.gutter),
                          children: [
                            for (final item in _items)
                              Semantics(
                                button: true,
                                label: 'Invention: ${item['title']}. ${item['parts']} parts.',
                                child: ListTile(
                                  title: Text('${item['title']}'),
                                  subtitle: Text('${item['parts']} parts, ${item['created_at']}'),
                                  onTap: () => _openProject('${item['id']}'),
                                ),
                              ),
                          ],
                        ),
    );
  }
}
