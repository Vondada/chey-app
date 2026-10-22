// CHE Plan Room (Concept-to-Plan, owner 2026-10-20; server: project_plan.js
// and world_scene.js planScene). Any idea CHE planned, drawn from the Worker's
// plan scene: a map of every part, feature or task in its group lane and its
// build stage, boxes sized by size class, lines for what each one needs; the
// same items as a sortable list; the stages in order; and the cost and time
// for the cheapest, balanced and premium versions. Every figure is CHE's
// estimate and says so; fiction and speculation are kept apart from real parts.
//
// Voice-first: the list is the map in words, every item opens to its details
// with "Read aloud", and "sort by cheapest", "show premium", "what comes
// first" work while the room is open. Opening the room is silent (the chat
// reply already spoke the plan).

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';

const _tiers = ['cheapest', 'balanced', 'premium'];
const _tierNames = {'cheapest': 'Cheapest', 'balanced': 'Balanced', 'premium': 'Premium'};

/// The orders the owner asked for, as the Worker names them (SORTS).
const chePlanSorts = {
  'dependency': 'earliest to latest dependency',
  'size': 'smallest to largest',
  'complexity': 'simplest to most complex',
  'cost': 'cheapest to most expensive',
  'priority': 'highest to lowest priority',
  'required': 'required before optional',
};

typedef CheRange = (double, double);

CheRange _range(Object? raw) {
  if (raw is List && raw.length == 2) return ((raw[0] as num).toDouble(), (raw[1] as num).toDouble());
  return (0, 0);
}

String cheMoney(CheRange r) {
  String f(double n) {
    final s = n.round().toString().replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]},');
    return '\$$s';
  }
  return r.$1 == r.$2 ? f(r.$1) : '${f(r.$1)} to ${f(r.$2)}';
}

class ChePlanItem {
  ChePlanItem.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}'.replaceFirst('item:', ''),
        kind = '${j['kind'] ?? ''}',
        name = '${j['label'] ?? ''}',
        system = '${j['system'] ?? ''}',
        purpose = '${j['purpose'] ?? ''}',
        required = j['status'] == 'required',
        asked = j['asked'] == true,
        per = '${j['per'] ?? 'once'}',
        size = (j['size'] as num?)?.toInt() ?? 1,
        sizeLabel = '${j['size_label'] ?? ''}',
        complexity = (j['complexity'] as num?)?.toInt() ?? 1,
        stage = (j['stage'] as num?)?.toInt() ?? 1,
        priority = (j['priority'] as num?)?.toInt() ?? 0,
        needs = [for (final n in (j['needs'] as List? ?? const [])) '$n'],
        cost = {for (final t in _tiers) t: _range((j['cost'] as Map?)?[t])},
        options = {for (final t in _tiers) t: '${(j['options'] as Map?)?[t] ?? ''}'},
        hours = j['effort_hours'] == null ? null : _range(j['effort_hours']),
        spoken = '${j['spoken'] ?? ''}',
        provenanceSpoken = '${j['provenance_spoken'] ?? 'CHE\'s estimate, not a quote'}',
        sourceId = '${(j['source'] as Map?)?['id'] ?? ''}';

  final String id, kind, name, system, purpose, per, sizeLabel, spoken, provenanceSpoken, sourceId;
  final bool required, asked;
  final int size, complexity, stage, priority;
  final List<String> needs;
  final Map<String, CheRange> cost;
  final Map<String, String> options;
  final CheRange? hours;

  String get unit => per == 'unit' ? ' per unit' : per == 'month' ? ' a month' : '';
}

class ChePlanNote {
  const ChePlanNote(this.label, this.text, this.provenanceSpoken, {this.url = ''});
  final String label, text, provenanceSpoken, url;
}

class ChePlanTier {
  ChePlanTier.fromJson(Map? j)
      : oneTime = _range(j?['one_time']),
        perUnit = _range(j?['per_unit']),
        monthly = _range(j?['monthly']),
        weeks = _range(j?['weeks']);
  final CheRange oneTime, perUnit, monthly, weeks;

  String get phrase => [
        if (oneTime.$2 > 0) cheMoney(oneTime),
        if (perUnit.$2 > 0) '${cheMoney(perUnit)} per unit',
        if (monthly.$2 > 0) '${cheMoney(monthly)} a month',
      ].join(' plus ').ifEmpty('\$0');
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}

class ChePlan {
  ChePlan._(this.raw);
  final Map<String, dynamic> raw;

  late final String id = '${raw['id']}';
  late final String title = '${raw['title'] ?? ''}';
  late final String typeLabel = '${raw['type_label'] ?? ''}';
  late final String structureLabel = '${raw['structure_label'] ?? ''}';
  late final String spoken = '${raw['spoken'] ?? ''}';
  late final String complexity = '${raw['complexity'] ?? ''}';
  late final String feasibility = '${raw['feasibility'] ?? ''}';
  late final String safetyLevel = '${raw['safety_level'] ?? 'ok'}';
  late final String method = '${(raw['estimate_basis'] as Map?)?['method'] ?? ''}';
  late final bool refused = raw['stage'] == 'refused';
  late final List<Map<String, dynamic>> _objects = [for (final o in (raw['objects'] as List? ?? const [])) if (o is Map && (o['source'] as Map?)?['store'] != null) o.cast<String, dynamic>()];
  late final List<ChePlanItem> items = [for (final o in _objects) if ('${o['id']}'.startsWith('item:')) ChePlanItem.fromJson(o)];
  late final List<String> systems = [for (final o in _objects) if (o['kind'] == 'system') '${o['label']}'];
  List<ChePlanNote> _notes(String kind) => [for (final o in _objects) if (o['kind'] == kind) ChePlanNote('${o['label']}', '${o['text'] ?? ''}', '${o['provenance_spoken'] ?? ''}', url: '${o['url'] ?? ''}')];
  late final List<ChePlanNote> speculative = _notes('speculative');
  late final List<ChePlanNote> safety = _notes('safety');
  late final List<ChePlanNote> sources = _notes('source');
  late final Map<String, ChePlanTier> tiers = {for (final t in _tiers) t: ChePlanTier.fromJson((raw['tiers'] as Map?)?[t] as Map?)};
  late final List<(int, String, List<String>)> stages = [
    for (final s in (raw['stages'] as List? ?? const []))
      if (s is Map) ((s['n'] as num).toInt(), '${s['name']}', [for (final i in (s['items'] as List? ?? const [])) '$i']),
  ];
  List<String> _strings(String k) => [for (final s in (raw[k] as List? ?? const [])) '$s'];
  late final List<String> openQuestions = _strings('open_questions');
  late final List<String> nextActions = _strings('next_actions');
  late final List<String> assumptions = _strings('assumptions');

  ChePlanItem? item(String id) => items.where((i) => i.id == id).firstOrNull;

  static ChePlan? fromJson(Map<String, dynamic>? j) => j == null || j['scene'] != 'plan' || '${j['id'] ?? ''}'.isEmpty ? null : ChePlan._(j);
}

/// The items in one of [chePlanSorts]' orders; [tier] picks the cost column. Stable, like the Worker's.
List<ChePlanItem> chePlanSort(List<ChePlanItem> items, String by, {String tier = 'balanced'}) {
  num key(ChePlanItem i) => switch (by) {
        'size' => i.size,
        'complexity' => i.complexity,
        'cost' => (i.cost[tier]!.$1 + i.cost[tier]!.$2) / 2,
        'priority' => -i.priority,
        'required' => i.required ? 0 : 1,
        _ => i.stage,
      };
  final indexed = items.indexed.toList()..sort((a, b) => key(a.$2).compareTo(key(b.$2)) != 0 ? key(a.$2).compareTo(key(b.$2)) : a.$1.compareTo(b.$1));
  return [for (final (_, i) in indexed) i];
}

/// Voice inside the Plan Room. Returns (answer, sort to show, tier to show), or null when it is not a plan question.
(String, String?, String?)? chePlanAnswer(ChePlan plan, String raw, {String tier = 'balanced'}) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.?!]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+)?'), '').trim();
  final tierAsked = RegExp(r'^(?:show|switch to|use|what about|read)(?: me)? (?:the )?(cheapest|balanced|realistic|premium|luxury)(?: version| tier| one)?$').firstMatch(t);
  if (tierAsked != null) {
    final picked = switch (tierAsked.group(1)) { 'realistic' => 'balanced', 'luxury' => 'premium', final v => v! };
    final p = plan.tiers[picked]!;
    return ('${_tierNames[picked]} version: about ${p.phrase}, ${p.weeks.$1.round()} to ${p.weeks.$2.round()} weeks. CHE\'s estimate, not a quote.', null, picked);
  }
  const sortWords = {
    'size': r'smallest|biggest|largest|by size',
    'complexity': r'simplest|most complex|by complexity',
    'cost': r'cheapest to|most expensive|by (?:cost|price)',
    'priority': r'priority|most important',
    'required': r'required|optional',
    'dependency': r'dependenc|comes? first|happen first|by stage|in order',
  };
  if (RegExp(r'^(?:sort|order|rank|list|show|read|what)').hasMatch(t) && RegExp(r'parts|items|features|assets|tasks|it|them|dependenc|first|by ').hasMatch(t)) {
    for (final e in sortWords.entries) {
      if (RegExp(e.value).hasMatch(t)) {
        final list = chePlanSort(plan.items, e.key, tier: tier);
        final body = e.key == 'dependency'
            ? [for (final (n, name, ids) in plan.stages) 'Stage $n, $name: ${ids.map((id) => plan.item(id)?.name ?? id).join(', ')}.'].join(' ')
            : [for (final (n, i) in list.indexed) '${n + 1}. ${i.name}${e.key == 'cost' ? ', ${cheMoney(i.cost[tier]!)}${i.unit}' : e.key == 'size' ? ', ${i.sizeLabel}' : ''}.'].join(' ');
        return ('${chePlanSorts[e.key]}${e.key == 'cost' ? ', ${_tierNames[tier]!.toLowerCase()} prices, CHE\'s estimates' : ''}: $body', e.key, null);
      }
    }
    if (RegExp(r'^(?:read|list|what are)(?: me)? (?:the |all )?(?:parts|items|features|assets|tasks)$').hasMatch(t)) {
      return ('${plan.items.length} items: ${[for (final (n, i) in plan.items.indexed) '${n + 1}. ${i.name}'].join('. ')}.', 'dependency', null);
    }
  }
  if (RegExp(r"^(?:what(?:'s| is) the (?:total|cost|price)|how much(?: does it| will it| would it)? cost|read (?:me )?the (?:costs?|tiers|totals))").hasMatch(t)) {
    final parts = [for (final k in _tiers) '${_tierNames[k]} about ${plan.tiers[k]!.phrase}'];
    return ('${parts.join('; ')}. Required items only; CHE\'s estimates, not quotes.', null, null);
  }
  if (RegExp(r"possible today|what(?:'s| is) real|speculative|fiction").hasMatch(t)) {
    return (plan.speculative.isEmpty
        ? 'Everything in this plan uses parts or services that exist today, sir.'
        : 'Not real today: ${[for (final s in plan.speculative) '${s.label}, ${s.text}'].join('; ')}. Everything else uses parts that exist now.', null, null);
  }
  if (RegExp(r'^(?:read |what are )?(?:the )?(?:safety|risks?)(?: notes| rules)?$').hasMatch(t)) {
    return (plan.safety.isEmpty ? 'No special safety notes for this plan, sir.' : [for (final s in plan.safety) s.text].join(' '), null, null);
  }
  if (RegExp(r"^(?:read (?:me )?the plan|what(?:'s| is) the plan|summari[sz]e (?:it|the plan))$").hasMatch(t)) return (plan.spoken, null, null);
  return null;
}

class ChePlanRoom extends StatefulWidget {
  const ChePlanRoom({super.key, required this.planId, required this.load, required this.onSpeak});

  final String planId;

  /// Fetches the plan scene (CheAgentRuntimeClient.planScene in the app).
  final Future<Map<String, dynamic>> Function(String id) load;
  final Future<void> Function(String text) onSpeak;

  /// The room on screen and its current tier, for voice questions asked while it is open.
  static final current = ValueNotifier<ChePlanRoomState?>(null);

  static Route<void> route({required Future<Map<String, dynamic>> Function(String) load, required String planId, required Future<void> Function(String) onSpeak}) =>
      MaterialPageRoute<void>(builder: (_) => ChePlanRoom(planId: planId, load: load, onSpeak: onSpeak));

  @override
  State<ChePlanRoom> createState() => ChePlanRoomState();
}

class ChePlanRoomState extends State<ChePlanRoom> {
  static const _teal = Color(0xFF3FD0C9);
  static const _gold = CheColors.markets;
  ChePlan? plan;
  String? _error;
  String tier = 'balanced';
  String sort = 'dependency';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (ChePlanRoom.current.value == this) ChePlanRoom.current.value = null;
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final next = ChePlan.fromJson(await widget.load(widget.planId));
      if (!mounted) return;
      setState(() {
        plan = next;
        _error = next == null ? 'This plan is not available.' : null;
      });
      if (next != null) ChePlanRoom.current.value = this;
    } catch (error) {
      if (mounted) setState(() => _error = 'Could not load the plan: $error');
    }
  }

  /// Answers a voice question from the plan and shows what was asked for.
  String? answer(String message) {
    final p = plan;
    if (p == null) return null;
    final got = chePlanAnswer(p, message, tier: tier);
    if (got == null) return null;
    setState(() {
      if (got.$2 != null) sort = got.$2!;
      if (got.$3 != null) tier = got.$3!;
    });
    HapticFeedback.selectionClick();
    return got.$1;
  }

  void _inspect(ChePlanItem i) {
    final needs = [for (final n in i.needs) plan?.item(n)?.name ?? n];
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.8),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(i.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('${i.system} · ${i.required ? 'required' : 'optional'}${i.asked ? ', you asked for it' : ''} · ${i.sizeLabel} · complexity ${i.complexity} of 5 · stage ${i.stage}', style: const TextStyle(fontSize: 15, color: Colors.white70)),
                  const SizedBox(height: 10),
                  Text(i.purpose, style: const TextStyle(fontSize: 19, height: 1.4)),
                  const SizedBox(height: 12),
                  for (final t in _tiers)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text('${_tierNames[t]}: ${i.options[t]}, ${cheMoney(i.cost[t]!)}${i.unit}', style: TextStyle(fontSize: 17, fontWeight: t == tier ? FontWeight.w700 : FontWeight.w400)),
                    ),
                  if (i.hours != null) Text('Effort: ${i.hours!.$1.round()} to ${i.hours!.$2.round()} hours', style: const TextStyle(fontSize: 16)),
                  if (needs.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Needs first: ${needs.join(', ')}', style: const TextStyle(fontSize: 16))),
                  const SizedBox(height: 8),
                  Text('${i.provenanceSpoken[0].toUpperCase()}${i.provenanceSpoken.substring(1)}. From project_plans #${i.sourceId}', style: const TextStyle(fontSize: 13, color: Colors.white54)),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: () => widget.onSpeak('${i.spoken} That is ${i.provenanceSpoken}.'),
                    icon: const Icon(Icons.volume_up_rounded),
                    label: const Text('Read aloud'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = plan;
    return Scaffold(
      appBar: AppBar(
        title: Text(p?.title ?? 'Plan'),
        actions: [
          if (p != null)
            IconButton(tooltip: 'Read the plan aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => widget.onSpeak(p.spoken)),
        ],
      ),
      body: p == null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error ?? 'Loading the plan…', style: const TextStyle(fontSize: 18, color: Colors.white70))))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                Text('${p.typeLabel[0].toUpperCase()}${p.typeLabel.substring(1)} · ${p.structureLabel} · complexity ${p.complexity}', style: const TextStyle(fontSize: 16, color: Colors.white70)),
                if (p.safetyLevel != 'ok') Padding(padding: const EdgeInsets.only(top: 6), child: Text(p.safetyLevel == 'high_level' ? 'High-level plan: a regulated or safety-critical system.' : 'Some parts were left out for safety.', style: const TextStyle(fontSize: 16, color: _gold))),
                const SizedBox(height: 12),
                Semantics(
                  label: 'Version to price',
                  child: SegmentedButton<String>(
                    segments: [for (final t in _tiers) ButtonSegment(value: t, label: Text(_tierNames[t]!))],
                    selected: {tier},
                    onSelectionChanged: (s) => setState(() => tier = s.first),
                  ),
                ),
                const SizedBox(height: 10),
                _TierCard(name: _tierNames[tier]!, tier: p.tiers[tier]!, method: p.method),
                const SizedBox(height: 16),
                _Heading('Map'),
                Semantics(
                  label: 'Plan map: ${p.items.length} items in ${p.systems.length} groups across ${p.stages.length} stages. The list below reads the same items.',
                  excludeSemantics: true,
                  child: _PlanMap(plan: p, tier: tier, onTap: _inspect),
                ),
                const SizedBox(height: 16),
                _Heading('Items, ${chePlanSorts[sort]}'),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    for (final e in chePlanSorts.entries)
                      ChoiceChip(label: Text(e.value), selected: sort == e.key, onSelected: (_) => setState(() => sort = e.key)),
                  ],
                ),
                const SizedBox(height: 8),
                for (final (n, i) in chePlanSort(p.items, sort, tier: tier).indexed)
                  Semantics(
                    button: true,
                    label: '${n + 1}. ${i.name}. ${i.required ? 'Required' : 'Optional'}, ${i.sizeLabel}, stage ${i.stage}, ${_tierNames[tier]} about ${cheMoney(i.cost[tier]!)}${i.unit}. Estimate.',
                    excludeSemantics: true,
                    child: ListTile(
                      contentPadding: EdgeInsets.zero,
                      onTap: () => _inspect(i),
                      leading: CircleAvatar(backgroundColor: i.required ? _teal : Colors.white24, foregroundColor: Colors.black, child: Text('${n + 1}')),
                      title: Text(i.name, style: const TextStyle(fontSize: 18)),
                      subtitle: Text('${i.system} · ${i.sizeLabel} · stage ${i.stage}${i.required ? '' : ' · optional'}', style: const TextStyle(fontSize: 14)),
                      trailing: Text('${cheMoney(i.cost[tier]!)}${i.per == 'unit' ? '/unit' : i.per == 'month' ? '/mo' : ''}', style: const TextStyle(fontSize: 15, fontFeatures: [FontFeature.tabularFigures()])),
                    ),
                  ),
                const SizedBox(height: 16),
                _Heading('Stages'),
                for (final (n, name, ids) in p.stages)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text('$n. $name: ${ids.map((id) => p.item(id)?.name ?? id).join(', ')}', style: const TextStyle(fontSize: 17, height: 1.35)),
                  ),
                if (p.speculative.isNotEmpty) ...[
                  _Heading('Not real today'),
                  for (final s in p.speculative) _Note(title: s.label, text: s.text, label: s.provenanceSpoken),
                ],
                if (p.safety.isNotEmpty) ...[
                  _Heading('Safety and rules'),
                  for (final s in p.safety) _Note(text: s.text, label: s.provenanceSpoken),
                ],
                _Heading('Feasibility'),
                Text(p.feasibility, style: const TextStyle(fontSize: 17, height: 1.35)),
                _Heading('Next steps'),
                for (final a in p.nextActions) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• $a', style: const TextStyle(fontSize: 17))),
                _Heading('Open questions'),
                for (final q in p.openQuestions) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• $q', style: const TextStyle(fontSize: 17))),
                _Heading('Assumptions'),
                for (final a in p.assumptions) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• $a', style: const TextStyle(fontSize: 15, color: Colors.white70))),
                _Heading('Sources'),
                if (p.sources.isEmpty) const Text('No public source was read for this plan; every figure is CHE\'s estimate.', style: TextStyle(fontSize: 15, color: Colors.white70)),
                for (final s in p.sources) _Note(title: s.label, text: '${s.text}\n${s.url}', label: s.provenanceSpoken),
              ],
            ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 6),
        child: Semantics(header: true, child: Text(text, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700))),
      );
}

class _Note extends StatelessWidget {
  const _Note({this.title = '', required this.text, required this.label});
  final String title, text, label;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (title.isNotEmpty) Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          SelectableText(text, style: const TextStyle(fontSize: 16, height: 1.35)),
          Text(label, style: const TextStyle(fontSize: 13, color: Colors.white54)),
        ]),
      );
}

class _TierCard extends StatelessWidget {
  const _TierCard({required this.name, required this.tier, required this.method});
  final String name, method;
  final ChePlanTier tier;
  @override
  Widget build(BuildContext context) {
    final body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('$name version: about ${tier.phrase}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
      const SizedBox(height: 4),
      Text('About ${tier.weeks.$1.round()} to ${tier.weeks.$2.round()} weeks · required items only', style: const TextStyle(fontSize: 16)),
      const SizedBox(height: 4),
      Text('CHE\'s estimate, not a quote: $method.', style: const TextStyle(fontSize: 13, color: Colors.white54)),
    ]);
    // HUD glass: the estimate on a glass pane. Other palettes keep the outlined box.
    if (cheHudActive) {
      return CheGlass(radius: 14, shadow: false, padding: const EdgeInsets.all(14), child: SizedBox(width: double.infinity, child: body));
    }
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: Colors.white24)),
      child: body,
    );
  }
}

/// Group lanes down, build stages across. Each box is one item, taller for a
/// bigger part; a line runs from what it needs; optional items are outlined.
class _PlanMap extends StatelessWidget {
  const _PlanMap({required this.plan, required this.tier, required this.onTap});
  final ChePlan plan;
  final String tier;
  final void Function(ChePlanItem) onTap;

  static const laneLabel = 96.0, stageWidth = 132.0, laneHeight = 92.0, header = 26.0;

  Map<String, Rect> _layout() {
    final rects = <String, Rect>{};
    for (final (lane, system) in plan.systems.indexed) {
      final byStage = <int, List<ChePlanItem>>{};
      for (final i in plan.items.where((i) => i.system == system)) {
        byStage.putIfAbsent(i.stage, () => []).add(i);
      }
      for (final MapEntry(key: stage, value: list) in byStage.entries) {
        list.sort((a, b) => a.size.compareTo(b.size));
        for (final (k, i) in list.indexed) {
          final h = 26.0 + i.size * 9;
          final w = (stageWidth - 16) / list.length;
          rects[i.id] = Rect.fromLTWH(laneLabel + (stage - 1) * stageWidth + 8 + k * w, header + lane * laneHeight + (laneHeight - h) / 2, w - 4, h);
        }
      }
    }
    return rects;
  }

  @override
  Widget build(BuildContext context) {
    final rects = _layout();
    final size = Size(laneLabel + math.max(1, plan.stages.length) * stageWidth + 8, header + plan.systems.length * laneHeight);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: GestureDetector(
        onTapUp: (d) {
          final hit = rects.entries.where((e) => e.value.inflate(4).contains(d.localPosition)).firstOrNull;
          final item = hit == null ? null : plan.item(hit.key);
          if (item != null) onTap(item);
        },
        child: CustomPaint(size: size, painter: _PlanMapPainter(plan: plan, rects: rects)),
      ),
    );
  }
}

class _PlanMapPainter extends CustomPainter {
  _PlanMapPainter({required this.plan, required this.rects});
  final ChePlan plan;
  final Map<String, Rect> rects;

  void _text(Canvas c, String s, Offset at, double maxWidth, {double size = 11, Color color = Colors.white, FontWeight weight = FontWeight.w500, int lines = 3}) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(fontSize: size, color: color, fontWeight: weight, height: 1.15)), textDirection: TextDirection.ltr, maxLines: lines, ellipsis: '…')..layout(maxWidth: math.max(10, maxWidth));
    tp.paint(c, at);
  }

  @override
  void paint(Canvas canvas, Size size) {
    const teal = Color(0xFF3FD0C9);
    const gold = CheColors.markets;
    for (final (n, name, _) in plan.stages) {
      _text(canvas, '$n. $name', Offset(_PlanMap.laneLabel + (n - 1) * _PlanMap.stageWidth + 8, 4), _PlanMap.stageWidth - 16, color: Colors.white70, size: 11, weight: FontWeight.w700, lines: 1);
    }
    for (final (lane, system) in plan.systems.indexed) {
      final top = _PlanMap.header + lane * _PlanMap.laneHeight;
      canvas.drawLine(Offset(0, top), Offset(size.width, top), Paint()..color = Colors.white12);
      _text(canvas, system, Offset(4, top + 8), _PlanMap.laneLabel - 10, color: Colors.white70, size: 12, weight: FontWeight.w700);
    }
    final line = Paint()
      ..color = gold.withValues(alpha: 0.55)
      ..strokeWidth = 1.4
      ..style = PaintingStyle.stroke;
    for (final i in plan.items) {
      final to = rects[i.id];
      for (final need in i.needs) {
        final from = rects[need];
        if (from == null || to == null) continue;
        final a = from.centerRight;
        final b = to.centerLeft;
        final mid = (a.dx + b.dx) / 2;
        canvas.drawPath(Path()..moveTo(a.dx, a.dy)..cubicTo(mid, a.dy, mid, b.dy, b.dx, b.dy), line);
      }
    }
    for (final i in plan.items) {
      final r = rects[i.id];
      if (r == null) continue;
      final rr = RRect.fromRectAndRadius(r, const Radius.circular(8));
      canvas.drawRRect(rr, Paint()..color = (i.required ? teal : Colors.white).withValues(alpha: i.required ? 0.22 : 0.06));
      canvas.drawRRect(rr, Paint()
        ..color = i.required ? teal : Colors.white38
        ..style = PaintingStyle.stroke
        ..strokeWidth = i.asked ? 2.4 : 1.2);
      _text(canvas, i.name, r.topLeft + const Offset(5, 4), r.width - 10, size: 10.5, lines: math.max(1, ((r.height - 8) / 13).floor()));
    }
  }

  @override
  bool shouldRepaint(_PlanMapPainter old) => old.plan != plan;
}
