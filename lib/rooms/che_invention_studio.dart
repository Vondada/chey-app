// CHE's Invention Studio page (owner, 2026-10-22). Shows a saved invention project: its concept picture, the parts by
// subsystem with a sourcing label on every part, cost bands per tier, feasibility notes, stages and the testing checklist.
// Every value is read from the Worker's project record; nothing is made up here. Quiet text: nothing speaks on load.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';

/// One saved project, read from GET /api/inventions/:id. Missing fields read as empty, never as invented values.
class CheInventionView {
  CheInventionView(this.json);

  final Map<String, dynamic> json;

  String get title => '${json['title'] ?? 'Invention'}';
  String get id => '${json['id'] ?? ''}';
  String get conceptMediaId => '${(json['concept'] as Map?)?['media_id'] ?? ''}';
  String get conceptReason => '${(json['concept'] as Map?)?['reason'] ?? ''}';

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
  const CheInventionDetail({super.key, required this.project, this.imageUrl});

  final CheInventionView project;
  final String? imageUrl;

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
              child: Image.network(imageUrl!, errorBuilder: (_, _, _) => const Text('The concept picture could not be shown.')),
            )
          else
            Text(project.conceptReason.isEmpty ? 'No concept picture yet.' : project.conceptReason),
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
  const CheInventionStudioPage({super.key, required this.baseUrl, required this.headers});

  final String baseUrl;
  final Map<String, String> headers;

  static Route<void> route({required String baseUrl, required Map<String, String> headers}) =>
      MaterialPageRoute<void>(builder: (_) => CheInventionStudioPage(baseUrl: baseUrl, headers: headers));

  @override
  State<CheInventionStudioPage> createState() => _CheInventionStudioPageState();
}

class _CheInventionStudioPageState extends State<CheInventionStudioPage> {
  List<Map<String, dynamic>> _items = const [];
  CheInventionView? _open;
  String _error = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadList();
  }

  Future<void> _loadList() async {
    try {
      final res = await http.get(Uri.parse('${widget.baseUrl}/api/inventions'), headers: widget.headers);
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
      final res = await http.get(Uri.parse('${widget.baseUrl}/api/inventions/$id'), headers: widget.headers);
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
