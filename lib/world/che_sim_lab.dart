// CHE Simulation Lab (owner 2026-10-20; server: sim_lab.js and world_scene.js
// simScene). One lab run, drawn from the Worker's simulation scene: how many
// candidate designs were screened (equations, mathematical predictions) and how
// many Monte Carlo simulations actually ran; why designs were eliminated; the
// leading designs with their uncertainty, feasibility, cost and parts; each
// design drawn against the range available today; findings, assumptions, open
// problems, safety and the road to a real prototype. Every number comes from
// the run; nothing here is a measurement.
//
// Voice-first: every section is text in reading order, every design opens with
// "Read aloud", and "what's the best design", "why were designs eliminated",
// "how many simulations ran" work while the lab is open. Opening is silent
// (the chat reply already spoke the run).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

String _num(num v) {
  if (v.abs() < 1 && v != 0) return double.parse(v.toStringAsPrecision(2)).toString();
  final d = v.abs() < 10 ? 1 : 0;
  final s = v.toStringAsFixed(d);
  final parts = s.split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]},');
  return parts.length > 1 && parts[1] != '0' ? '$whole.${parts[1]}' : whole;
}

String cheSimMoney(num v) => '\$${_num(v.round())}';

String _cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

double _d(Object? v) => (v as num?)?.toDouble() ?? 0;

class CheSimParam {
  CheSimParam.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        name = '${j['name'] ?? ''}',
        unit = '${j['unit'] ?? ''}',
        min = _d(j['min']),
        max = _d(j['max']),
        todayLo = _d((j['today'] as List?)?.first),
        todayHi = _d((j['today'] as List?)?.last),
        integer = j['int'] == true;
  final String id, name, unit;
  final double min, max, todayLo, todayHi;
  final bool integer;
}

class CheSimModel {
  CheSimModel.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        version = (j['version'] as num?)?.toInt() ?? 1,
        label = '${j['label'] ?? ''}',
        method = '${j['method'] ?? ''}',
        primaryName = '${(j['primary'] as Map?)?['name'] ?? ''}',
        primaryUnit = '${(j['primary'] as Map?)?['unit'] ?? ''}',
        params = [for (final p in (j['params'] as List? ?? const [])) CheSimParam.fromJson((p as Map).cast<String, dynamic>())],
        seed = (j['seed'] as num?)?.toInt() ?? 0,
        budget = (j['budget'] as num?)?.toInt() ?? 0,
        stop = '${j['stop'] ?? ''}',
        evaluations = ((j['counts'] as Map?)?['screening_evaluations'] as num?)?.toInt() ?? 0,
        samples = ((j['counts'] as Map?)?['monte_carlo_samples'] as num?)?.toInt() ?? 0,
        feasible = ((j['counts'] as Map?)?['feasible'] as num?)?.toInt() ?? 0,
        eliminated = ((j['counts'] as Map?)?['eliminated'] as num?)?.toInt() ?? 0,
        reused = ((j['counts'] as Map?)?['reused_prior'] as num?)?.toInt() ?? 0,
        combinations = ((j['counts'] as Map?)?['combinations'] as num?)?.toInt();
  final String id, label, method, primaryName, primaryUnit, stop;
  final int version, seed, budget, evaluations, samples, feasible, eliminated, reused;
  final int? combinations;
  final List<CheSimParam> params;

  bool get optionSearch => id == 'config_search';

  String get stopSpoken => switch (stop) {
        'exhaustive' => 'every combination was tried',
        'converged' => 'the best score stopped improving',
        'budget' => 'the evaluation budget was spent',
        'max_rounds' => 'the round limit was reached',
        _ => stop,
      };
}

class CheSimPart {
  CheSimPart(Map<String, dynamic> j)
      : name = '${j['name'] ?? ''}',
        spec = '${j['spec'] ?? ''}',
        cost = _d(j['cost']);
  final String name, spec;
  final double cost;
}

class CheSimCandidate {
  CheSimCandidate.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        model = '${j['model'] ?? ''}',
        label = '${j['label'] ?? ''}',
        rank = (j['rank'] as num?)?.toInt() ?? 0,
        realistic = j['status'] == 'realistic',
        params = {for (final e in ((j['params'] as Map?) ?? const {}).entries) '${e.key}': _d(e.value)},
        p10 = _d((j['primary'] as Map?)?['p10']),
        p50 = _d((j['primary'] as Map?)?['p50']),
        p90 = _d((j['primary'] as Map?)?['p90']),
        cost = _d((j['cost'] as Map?)?['nominal']),
        costLo = _d((j['cost'] as Map?)?['p10']),
        costHi = _d((j['cost'] as Map?)?['p90']),
        feasibility = _d(j['feasibility']),
        score = _d(j['score']),
        dims = {for (final e in ((j['dims'] as Map?) ?? const {}).entries) '${e.key}': _d(e.value)},
        parts = [for (final p in (j['parts'] as List? ?? const [])) CheSimPart((p as Map).cast<String, dynamic>())],
        beyondToday = [for (final b in (j['beyond_today'] as List? ?? const [])) '$b'],
        spoken = '${j['spoken'] ?? ''}',
        provenanceSpoken = '${j['provenance_spoken'] ?? ''}';
  final String id, model, label, spoken, provenanceSpoken;
  final int rank;
  final bool realistic;
  final Map<String, double> params, dims;
  final double p10, p50, p90, cost, costLo, costHi, feasibility, score;
  final List<CheSimPart> parts;
  final List<String> beyondToday;
}

class CheSimNote {
  CheSimNote(Map<String, dynamic> j)
      : kind = '${j['kind'] ?? ''}',
        label = '${j['label'] ?? ''}',
        text = '${j['text'] ?? ''}',
        status = '${j['status'] ?? ''}',
        count = (j['count'] as num?)?.toInt() ?? 0,
        model = '${j['model'] ?? ''}',
        url = '${j['url'] ?? ''}',
        spoken = '${j['spoken'] ?? ''}',
        provenanceSpoken = '${j['provenance_spoken'] ?? ''}';
  final String kind, label, text, status, model, url, spoken, provenanceSpoken;
  final int count;
}

class CheSimLab {
  CheSimLab._(Map<String, dynamic> j)
      : id = '${j['id']}',
        title = '${j['title'] ?? ''}',
        typeLabel = '${j['type_label'] ?? ''}',
        spoken = '${j['spoken'] ?? ''}',
        safetyLevel = '${j['safety_level'] ?? 'ok'}',
        budget = (j['budget'] as num?)?.toInt() ?? 0,
        requestedBudget = (j['requested_budget'] as num?)?.toInt() ?? 0,
        readinessStage = '${(j['readiness'] as Map?)?['stage'] ?? ''}',
        ladder = [for (final s in ((j['readiness'] as Map?)?['ladder'] as List? ?? const [])) '$s'],
        roadmap = [for (final s in (j['roadmap'] as List? ?? const [])) '$s'],
        missing = [for (final m in (j['missing_capabilities'] as List? ?? const [])) if (m is Map) '${m['need']}. ${m['how']}'],
        models = [for (final m in (j['models'] as List? ?? const [])) CheSimModel.fromJson((m as Map).cast<String, dynamic>())],
        candidates = [
          for (final o in (j['objects'] as List? ?? const []))
            if (o is Map && o['kind'] == 'candidate' && (o['source'] as Map?)?['store'] != null) CheSimCandidate.fromJson(o.cast<String, dynamic>()),
        ],
        notes = [
          for (final o in (j['objects'] as List? ?? const []))
            if (o is Map && o['kind'] != 'candidate' && (o['source'] as Map?)?['store'] != null) CheSimNote(o.cast<String, dynamic>()),
        ];

  final String id, title, typeLabel, spoken, safetyLevel, readinessStage;
  final int budget, requestedBudget;
  final List<String> ladder, roadmap, missing;
  final List<CheSimModel> models;
  final List<CheSimCandidate> candidates;
  final List<CheSimNote> notes;

  static CheSimLab? fromJson(Map<String, dynamic>? j) => j == null || j['scene'] != 'sim' || '${j['id'] ?? ''}'.isEmpty ? null : CheSimLab._(j);

  int get evaluations => models.fold(0, (n, m) => n + m.evaluations);
  int get samples => models.fold(0, (n, m) => n + m.samples);
  int get eliminatedCount => models.fold(0, (n, m) => n + m.eliminated);
  CheSimModel? model(String id) => models.where((m) => m.id == id).firstOrNull;
  List<CheSimCandidate> candidatesOf(String model) => [for (final c in candidates) if (c.model == model) c];
  List<CheSimNote> of(String kind) => [for (final n in notes) if (n.kind == kind) n];

  /// The lead design: the first model's best candidate (the physics model when there is one).
  CheSimCandidate? get best => models.isEmpty ? null : candidatesOf(models.first.id).firstOrNull;

  String design(CheSimCandidate c) {
    final m = model(c.model);
    if (m == null) return '';
    if (m.optionSearch) {
      final counts = [0, 0, 0];
      for (final p in m.params) {
        if (p.id.startsWith('tier:')) counts[(c.params[p.id] ?? 0).round().clamp(0, 2)] += 1;
      }
      return '${counts[0]} cheapest, ${counts[1]} balanced, ${counts[2]} premium';
    }
    return [for (final p in m.params) '${p.name.toLowerCase()} ${_num(c.params[p.id] ?? 0)}${p.unit.isEmpty ? '' : ' ${p.unit}'}'].join(', ');
  }

  String countsSpoken() => 'I screened ${_num(evaluations)} candidate designs with equations: those are mathematical predictions, not simulations. '
      'Then I ran ${_num(samples)} Monte Carlo simulations on the strongest ${candidates.length}. ${_num(eliminatedCount)} designs were eliminated. '
      'Nothing has been built or measured.';
}

/// Voice inside the lab. Returns the spoken answer from the run, or null when it is not a lab question.
String? cheSimLabAnswer(CheSimLab lab, String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.?!]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+)?'), '').trim();
  const numbers = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5};
  final one = RegExp(r"^(?:read|open|show|what(?:'s| is))(?: me)? (?:the )?(?:design|candidate|option|solution) (?:number )?(\w+)$").firstMatch(t);
  if (one != null) {
    final n = int.tryParse(one.group(1)!) ?? numbers[one.group(1)!];
    final list = lab.models.isEmpty ? <CheSimCandidate>[] : lab.candidatesOf(lab.models.first.id);
    if (n == null || n < 1 || n > list.length) return list.isEmpty ? 'No design met the constraints, sir.' : 'There ${list.length == 1 ? 'is one leading design' : 'are ${list.length} leading designs'}, sir.';
    return '${list[n - 1].spoken} That is ${list[n - 1].provenanceSpoken}.';
  }
  if (RegExp(r"^(?:what(?:'s| is) (?:the )?(?:best|leading|top|closest realistic) (?:design|candidate|option|solution)|(?:read|show) (?:me )?(?:the )?(?:best|leading|top) (?:design|candidate|option|solution)|what(?:'s| is) the closest realistic (?:one|version))$").hasMatch(t)) {
    final b = lab.best;
    if (b == null) {
      final miss = lab.of('closest_miss').firstOrNull;
      return miss?.spoken ?? 'No design met every constraint, sir.';
    }
    return '${b.spoken} Design: ${lab.design(b)}. That is ${b.provenanceSpoken}.';
  }
  if (RegExp(r"^(?:why (?:were|did) (?:the )?(?:designs?|candidates?|options?|others?) (?:get )?(?:eliminated|fail|rejected)|what (?:failed|was eliminated|got eliminated)|(?:read|list) (?:the )?eliminations?|why did (?:the )?others fail)$").hasMatch(t)) {
    final e = lab.of('elimination');
    if (e.isEmpty) return 'No design was eliminated, sir: every one screened met the constraints.';
    return 'Designs eliminated, sir, a design can fail more than one rule: ${[for (final (i, n) in e.indexed) '${i + 1}. ${n.spoken}'].join(' ')}';
  }
  if (RegExp(r"^(?:how many (?:simulations|sims|designs|candidates|evaluations)(?: (?:ran|did you run|were run|were screened|did you (?:try|screen|test)))?|what (?:actually )?ran|how big was the search)$").hasMatch(t)) {
    return lab.countsSpoken();
  }
  if (RegExp(r"^(?:read|list|what are) (?:me )?(?:the )?assumptions$").hasMatch(t)) {
    return 'Assumptions, sir: ${[for (final (i, n) in lab.of('assumption').indexed) '${i + 1}. ${n.text}'].join(' ')}';
  }
  if (RegExp(r"^(?:what(?:'s| is) (?:still )?(?:unresolved|unproven|open)|(?:read|list|what are) (?:me )?(?:the )?(?:open problems|unresolved problems|unknowns))$").hasMatch(t)) {
    return 'Still open, sir: ${[for (final (i, n) in lab.of('unresolved').indexed) '${i + 1}. ${n.text}'].join(' ')}';
  }
  if (RegExp(r"^(?:what(?:'s| is) next|what(?:'s| is) the (?:roadmap|next step)|(?:read|show) (?:me )?the (?:roadmap|prototype roadmap)|how do (?:i|we) build it)$").hasMatch(t)) {
    if (lab.roadmap.isEmpty) return 'There is no roadmap for this run, sir.';
    return 'The road to a real prototype, sir: ${[for (final (i, s) in lab.roadmap.indexed) '${i + 1}. $s'].join(' ')} Today the idea is at: ${lab.readinessStage}.';
  }
  if (RegExp(r"^(?:read (?:me )?(?:the )?findings|what did you find|what are the findings)$").hasMatch(t)) {
    return [for (final n in lab.of('finding')) '${n.text} That is ${n.provenanceSpoken}.'].join(' ');
  }
  return null;
}

class CheSimLabPage extends StatefulWidget {
  const CheSimLabPage({super.key, required this.simId, required this.load, required this.onSpeak});

  final String simId;

  /// Fetches the simulation scene (CheAgentRuntimeClient.simScene in the app).
  final Future<Map<String, dynamic>> Function(String id) load;
  final Future<void> Function(String text) onSpeak;

  /// The lab on screen, for voice questions asked while it is open.
  static final current = ValueNotifier<CheSimLabState?>(null);

  static Route<void> route({required Future<Map<String, dynamic>> Function(String) load, required String simId, required Future<void> Function(String) onSpeak}) =>
      MaterialPageRoute<void>(builder: (_) => CheSimLabPage(simId: simId, load: load, onSpeak: onSpeak));

  @override
  State<CheSimLabPage> createState() => CheSimLabState();
}

class CheSimLabState extends State<CheSimLabPage> {
  static const _teal = Color(0xFF3FD0C9);
  static const _gold = Color(0xFFE8B04A);
  CheSimLab? lab;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (CheSimLabPage.current.value == this) CheSimLabPage.current.value = null;
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final next = CheSimLab.fromJson(await widget.load(widget.simId));
      if (!mounted) return;
      setState(() {
        lab = next;
        _error = next == null ? 'This simulation run is not available.' : null;
      });
      if (next != null) CheSimLabPage.current.value = this;
    } catch (error) {
      if (mounted) setState(() => _error = 'Could not load the simulation run: $error');
    }
  }

  String? answer(String message) {
    final l = lab;
    if (l == null) return null;
    final got = cheSimLabAnswer(l, message);
    if (got != null) HapticFeedback.selectionClick();
    return got;
  }

  void _inspect(CheSimLab l, CheSimCandidate c) {
    final m = l.model(c.model)!;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.85),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Design ${c.rank}: ${m.label}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text('${m.primaryName}: about ${_num(c.p50)} ${m.primaryUnit} (p10 ${_num(c.p10)}, p90 ${_num(c.p90)})', style: const TextStyle(fontSize: 19)),
                  Text('Met every constraint in ${(c.feasibility * 100).round()}% of Monte Carlo runs · about ${cheSimMoney(c.cost)} (${cheSimMoney(c.costLo)} to ${cheSimMoney(c.costHi)})', style: const TextStyle(fontSize: 16)),
                  if (c.beyondToday.isNotEmpty) Text('Needs beyond today: ${c.beyondToday.join(', ')}', style: const TextStyle(fontSize: 16, color: _gold)),
                  const SizedBox(height: 12),
                  const Text('Design', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  Text(l.design(c), style: const TextStyle(fontSize: 16, height: 1.35)),
                  const SizedBox(height: 12),
                  const Text('Ranking', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  for (final e in c.dims.entries) Text('${_cap(e.key)}: ${(e.value * 100).round()} of 100', style: const TextStyle(fontSize: 16)),
                  const SizedBox(height: 12),
                  const Text('Parts and costs', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  for (final p in c.parts) Text('${p.name}: ${p.spec}, about ${cheSimMoney(p.cost)}', style: const TextStyle(fontSize: 16, height: 1.35)),
                  const SizedBox(height: 8),
                  Text('${_cap(c.provenanceSpoken)}. Model ${m.id} v${m.version}, seed ${m.seed}.', style: const TextStyle(fontSize: 13, color: Colors.white54)),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: () => widget.onSpeak('${c.spoken} Design: ${l.design(c)}. That is ${c.provenanceSpoken}.'),
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
    final l = lab;
    return Scaffold(
      appBar: AppBar(
        title: Text(l == null ? 'Simulation Lab' : 'Lab: ${l.title}'),
        actions: [
          if (l != null) IconButton(tooltip: 'Read the run aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => widget.onSpeak(l.spoken)),
        ],
      ),
      body: l == null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error ?? 'Loading the simulation run…', style: const TextStyle(fontSize: 18, color: Colors.white70))))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                if (l.typeLabel.isNotEmpty) Text(_cap(l.typeLabel), style: const TextStyle(fontSize: 16, color: Colors.white70)),
                if (l.safetyLevel != 'ok') Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.safetyLevel == 'high_level' ? 'High-level analysis only: a regulated or safety-critical system.' : 'Some parts were left out for safety.', style: const TextStyle(fontSize: 16, color: _gold))),
                const _Heading('Progress toward a real build'),
                Semantics(
                  label: 'Readiness: ${l.readinessStage}. Steps: ${l.ladder.join(', ')}.',
                  excludeSemantics: true,
                  child: Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final s in l.ladder)
                      Chip(
                        label: Text(s),
                        backgroundColor: s == l.readinessStage ? _teal : null,
                        labelStyle: TextStyle(color: s == l.readinessStage ? Colors.black : null, fontWeight: s == l.readinessStage ? FontWeight.w700 : null),
                      ),
                  ]),
                ),
                const _Heading('What actually ran'),
                Text(l.countsSpoken(), style: const TextStyle(fontSize: 17, height: 1.35)),
                if (l.requestedBudget > l.budget) Text('You asked for ${_num(l.requestedBudget)}; one run is capped at ${_num(l.budget)} evaluations.', style: const TextStyle(fontSize: 15, color: _gold)),
                const SizedBox(height: 8),
                Semantics(
                  label: 'Search funnel chart. The text above reads the same numbers.',
                  excludeSemantics: true,
                  child: _Funnel(stages: [
                    ('Screened (equations)', l.evaluations),
                    ('Met the constraints', l.models.fold(0, (n, m) => n + m.feasible)),
                    ('Monte Carlo simulations', l.samples),
                    ('Leading designs', l.candidates.length),
                  ]),
                ),
                for (final m in l.models)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('${m.label}: ${_num(m.evaluations)} of a ${_num(m.budget)} budget${m.combinations != null ? ' (${_num(m.combinations!)} combinations exist)' : ''}; stopped because ${m.stopSpoken}. Seed ${m.seed}.${m.reused > 0 ? ' Started from ${m.reused} earlier best designs.' : ''}', style: const TextStyle(fontSize: 14, color: Colors.white70)),
                  ),
                for (final m in l.models) ..._modelSection(l, m),
                if (l.of('finding').isNotEmpty) ...[
                  const _Heading('Findings'),
                  const Text('Nothing here is verified by a measurement yet.', style: TextStyle(fontSize: 14, color: Colors.white54)),
                  for (final n in l.of('finding')) _Note(text: n.text, label: n.provenanceSpoken),
                ],
                if (l.roadmap.isNotEmpty) ...[
                  const _Heading('Prototype roadmap'),
                  for (final (i, s) in l.roadmap.indexed) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('${i + 1}. $s', style: const TextStyle(fontSize: 17, height: 1.35))),
                ],
                if (l.of('safety').isNotEmpty) ...[
                  const _Heading('Safety'),
                  for (final n in l.of('safety')) _Note(text: n.text, label: n.provenanceSpoken),
                ],
                const _Heading('Unresolved problems'),
                for (final n in l.of('unresolved')) _Note(text: n.text, label: n.provenanceSpoken),
                if (l.missing.isNotEmpty) ...[
                  const _Heading('Missing capability'),
                  for (final m in l.missing) _Note(text: m, label: 'not built yet'),
                ],
                const _Heading('Assumptions'),
                for (final n in l.of('assumption')) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• ${n.text}', style: const TextStyle(fontSize: 15, color: Colors.white70))),
                if (l.of('reference').isNotEmpty) ...[
                  const _Heading('Methods'),
                  for (final n in l.of('reference')) _Note(title: n.label, text: '${n.text}\n${n.url}', label: n.provenanceSpoken),
                ],
              ],
            ),
    );
  }

  List<Widget> _modelSection(CheSimLab l, CheSimModel m) {
    final list = l.candidatesOf(m.id);
    final eliminated = [for (final n in l.of('elimination')) if (n.model == m.id) n];
    final miss = [for (final n in l.of('closest_miss')) if (n.label.startsWith(m.label)) n];
    return [
      _Heading(m.optionSearch ? 'Option choices: leading designs' : '${m.label}: leading designs'),
      Text(m.method, style: const TextStyle(fontSize: 14, color: Colors.white54)),
      if (list.isEmpty) for (final n in miss) _Note(text: n.text, label: n.provenanceSpoken),
      if (list.isNotEmpty)
        Semantics(
          label: '${m.primaryName} against cost for ${list.length} designs, with p10 to p90 ranges. The list below reads the same numbers.',
          excludeSemantics: true,
          child: _Compare(candidates: list),
        ),
      for (final c in list)
        Semantics(
          button: true,
          label: 'Design ${c.rank}. ${m.primaryName} about ${_num(c.p50)} ${m.primaryUnit}, from ${_num(c.p10)} to ${_num(c.p90)}. Feasible in ${(c.feasibility * 100).round()} percent of runs. About ${cheSimMoney(c.cost)}.${c.realistic ? '' : ' Needs technology beyond today.'} Simulated result.',
          excludeSemantics: true,
          child: InkWell(
            onTap: () => _inspect(l, c),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  CircleAvatar(radius: 14, backgroundColor: c.realistic ? _teal : _gold, foregroundColor: Colors.black, child: Text('${c.rank}')),
                  const SizedBox(width: 10),
                  Expanded(child: Text('${_num(c.p50)} ${m.primaryUnit} · ${(c.feasibility * 100).round()}% feasible · ${cheSimMoney(c.cost)}', style: const TextStyle(fontSize: 18))),
                ]),
                const SizedBox(height: 4),
                Text(l.design(c), style: const TextStyle(fontSize: 14, color: Colors.white70)),
                if (!m.optionSearch) _DesignGauges(model: m, candidate: c),
              ]),
            ),
          ),
        ),
      if (eliminated.isNotEmpty) ...[
        const SizedBox(height: 6),
        Text('Eliminated, and why (a design can fail more than one rule)', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        for (final e in eliminated) _Bar(label: _cap(e.label), value: e.count, max: m.evaluations),
      ],
    ];
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 6),
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

class _Bar extends StatelessWidget {
  const _Bar({required this.label, required this.value, required this.max});
  final String label;
  final int value, max;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$label: ${_num(value)}', style: const TextStyle(fontSize: 15)),
          const SizedBox(height: 3),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(value: max <= 0 ? 0 : value / max, minHeight: 8, color: const Color(0xFFE07A5F), backgroundColor: Colors.white12),
          ),
        ]),
      );
}

/// The search as a funnel: screened, feasible, simulated, leading. Widths are on a log scale so all four show.
class _Funnel extends StatelessWidget {
  const _Funnel({required this.stages});
  final List<(String, int)> stages;
  @override
  Widget build(BuildContext context) {
    final top = stages.first.$2 <= 1 ? 2 : stages.first.$2;
    double w(int n) => n <= 0 ? 0.04 : (0.15 + 0.85 * (n <= 1 ? 0 : (_log(n) / _log(top)))).clamp(0.04, 1.0);
    return Column(children: [
      for (final (i, (label, n)) in stages.indexed)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: LayoutBuilder(builder: (_, box) => Center(
                child: Container(
                  width: box.maxWidth * w(n),
                  height: 30,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: Color.lerp(const Color(0xFF2A6F6B), CheSimLabState._teal, i / 3), borderRadius: BorderRadius.circular(6)),
                  child: FittedBox(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text('$label: ${_num(n)}', style: const TextStyle(color: Colors.black, fontWeight: FontWeight.w600)))),
                ),
              )),
        ),
    ]);
  }

  static double _log(int n) => n <= 1 ? 0 : (n.bitLength.toDouble());
}

/// Each design parameter on its full range, with the range available today shaded: the design drawn in its space.
class _DesignGauges extends StatelessWidget {
  const _DesignGauges({required this.model, required this.candidate});
  final CheSimModel model;
  final CheSimCandidate candidate;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(children: [
          for (final p in model.params)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(children: [
                SizedBox(width: 120, child: Text(p.name, style: const TextStyle(fontSize: 12, color: Colors.white70), overflow: TextOverflow.ellipsis)),
                Expanded(child: SizedBox(height: 14, child: CustomPaint(painter: _GaugePainter(p, candidate.params[p.id] ?? p.min)))),
              ]),
            ),
        ]),
      );
}

class _GaugePainter extends CustomPainter {
  _GaugePainter(this.p, this.value);
  final CheSimParam p;
  final double value;
  @override
  void paint(Canvas canvas, Size size) {
    final span = (p.max - p.min) == 0 ? 1 : p.max - p.min;
    double x(double v) => ((v - p.min) / span).clamp(0.0, 1.0) * size.width;
    final mid = size.height / 2;
    canvas.drawRRect(RRect.fromLTRBR(0, mid - 3, size.width, mid + 3, const Radius.circular(3)), Paint()..color = Colors.white12);
    canvas.drawRRect(RRect.fromLTRBR(x(p.todayLo), mid - 3, x(p.todayHi), mid + 3, const Radius.circular(3)), Paint()..color = const Color(0x553FD0C9));
    final inside = value >= p.todayLo - 1e-9 && value <= p.todayHi + 1e-9;
    canvas.drawCircle(Offset(x(value), mid), 5.5, Paint()..color = inside ? CheSimLabState._teal : CheSimLabState._gold);
  }

  @override
  bool shouldRepaint(_GaugePainter old) => old.value != value || old.p != p;
}

/// Leading designs: cost across, the primary result up, with its p10 to p90 range as a bar.
class _Compare extends StatelessWidget {
  const _Compare({required this.candidates});
  final List<CheSimCandidate> candidates;
  @override
  Widget build(BuildContext context) => SizedBox(height: 170, child: CustomPaint(painter: _ComparePainter(candidates), size: Size.infinite));
}

class _ComparePainter extends CustomPainter {
  _ComparePainter(this.cs);
  final List<CheSimCandidate> cs;
  @override
  void paint(Canvas canvas, Size size) {
    const pad = 28.0;
    final xs = [for (final c in cs) c.cost];
    final lo = cs.map((c) => c.p10).reduce((a, b) => a < b ? a : b);
    final hi = cs.map((c) => c.p90).reduce((a, b) => a > b ? a : b);
    final cMin = xs.reduce((a, b) => a < b ? a : b), cMax = xs.reduce((a, b) => a > b ? a : b);
    double x(double v) => pad + (cMax == cMin ? 0.5 : (v - cMin) / (cMax - cMin)) * (size.width - pad * 2);
    double y(double v) => size.height - pad - (hi == lo ? 0.5 : (v - lo) / (hi - lo)) * (size.height - pad * 2);
    final axis = Paint()..color = Colors.white24..strokeWidth = 1;
    canvas.drawLine(Offset(pad, size.height - pad), Offset(size.width - pad, size.height - pad), axis);
    canvas.drawLine(Offset(pad, pad), Offset(pad, size.height - pad), axis);
    void label(String s, Offset at) => (TextPainter(text: TextSpan(text: s, style: const TextStyle(fontSize: 11, color: Colors.white54)), textDirection: TextDirection.ltr)..layout()).paint(canvas, at);
    label('cost →', Offset(size.width - pad - 34, size.height - pad + 6));
    label('result ↑', const Offset(2, 4));
    for (final c in cs) {
      final color = c.realistic ? CheSimLabState._teal : CheSimLabState._gold;
      canvas.drawLine(Offset(x(c.cost), y(c.p10)), Offset(x(c.cost), y(c.p90)), Paint()..color = color.withValues(alpha: 0.6)..strokeWidth = 3);
      canvas.drawCircle(Offset(x(c.cost), y(c.p50)), 6, Paint()..color = color);
      label('${c.rank}', Offset(x(c.cost) + 7, y(c.p50) - 7));
    }
  }

  @override
  bool shouldRepaint(_ComparePainter old) => old.cs != cs;
}
