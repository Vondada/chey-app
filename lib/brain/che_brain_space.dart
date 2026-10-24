// CHE Brain space: the immersive renderer and gestures for the Brain room.
//
// Rendering: one CustomPainter. Nodes are projected with CHE's own camera and
// drawn as a single batched atlas of glow sprites (one draw call for every
// orb), edges as batched line lists, labels only for the few nodes that need
// them (level of detail). Nodes behind the camera or off-screen are culled.
// The camera animates through a repaint notifier, so no widgets rebuild per
// frame; the memory card listens to a separate state notifier.
//
// Gestures (one recognizer each, no fights):
//   one-finger drag      orbit the brain / look around when inside
//   pinch / spread       travel deeper / back out (all the way to the center)
//   two-finger drag      pan the view
//   tap                  select an orb (camera flies to it); tap again opens it
//   tap a cluster orb    expand the cluster
//   long-press + drag    grab an orb and move it (this session only)
//
// Alive: the brain never stands still. Memories drift like neurons, signals
// fire along real links and cascade from memory to memory, the brain slowly
// turns on its own, and a new memory is born with a flash that fires into
// the memories it builds on. iPhone Reduce Motion holds it still.

import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:vector_math/vector_math.dart' as vm;

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import '../home/che_memory_brain.dart' show CheMemoryDot, cheMemoryCategoryColor;
import 'che_brain_navigation.dart';
import 'che_brain_regions.dart';
import 'che_brain_sections.dart';
import 'che_brain_space_model.dart';
import 'che_frame_budget.dart';

/// Drives the Brain space: selection, camera flights, clusters, filters.
class CheBrainSpaceController {
  CheBrainSpaceController(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const [], List<Map<String, dynamic>> roster = const []})
      : _dots = dots,
        _links = brainLinks,
        _roster = List<Map<String, dynamic>>.of(roster),
        layout = CheBrainLayout.build(dots, brainLinks: brainLinks) {
    _wire();
    _layoutWorkers();
    camera.distance = overviewDistance;
  }

  List<CheMemoryDot> _dots;
  List<Map<String, dynamic>> _links;
  List<Map<String, dynamic>> _roster;

  /// The worker brain in view, or null for CHE's whole brain.
  String? scope;

  /// Facets narrowing the view (verified, recent, archived, personal, outcome, project).
  CheBrainLens lens = CheBrainLens.none;

  /// Adaptive 60/30 frame budget from measured frame times (see che_frame_budget.dart).
  final CheFrameBudget budget = CheFrameBudget();
  bool get economy => budget.economy;

  /// Internal Office workers with a brain around CHE's (CHE's view only).
  List<CheBrainWorkerOrb> workers = const [];

  /// Where the owner was before each navigation step, newest last.
  final List<CheBrainViewState> _history = [];
  static const int maxHistory = 40;

  /// Time source for "recent" (tests pin it).
  DateTime Function() clock = DateTime.now;

  /// The ring the worker brains sit on, outside the brain's shape.
  static const double workerRing = 11.6;

  /// How far out "the whole brain" is: the brain alone, or the brain with its ring of worker brains.
  double get overviewDistance => scope == null && workers.isNotEmpty ? 23 : CheBrainCamera.overview;

  /// The Brain room on screen right now (voice commands reach it here).
  static CheBrainSpaceController? current;

  /// The font of the labels the brain paints itself; null is the platform's (San Francisco on iPhone). Screenshot
  /// tests set a font they have loaded.
  static String? labelFontFamily;

  CheBrainLayout layout;

  /// "40 memories", or "40 memories and 20 Knowledge Atlas records": curated cards are never counted as memories.
  String get countWords {
    final atlas = layout.clusters['Knowledge Atlas']?.members.length ?? 0;
    final memories = layout.nodes.length - atlas;
    return atlas == 0 ? '${layout.nodes.length} memories' : '$memories memor${memories == 1 ? 'y' : 'ies'} and $atlas Knowledge Atlas record${atlas == 1 ? '' : 's'}';
  }
  final CheBrainCamera camera = CheBrainCamera();

  /// Repaints only (camera, animation).
  final ValueNotifier<int> frame = ValueNotifier<int>(0);

  /// Selection, card and filter changes (rebuilds the overlay only).
  final ValueNotifier<int> state = ValueNotifier<int>(0);

  final Set<String> filter = {};
  String? selectedId;
  bool cardOpen = false;
  String? grabbedId;
  double time = 0;

  /// iPhone Reduce Motion: no drift, no firing; frames stop when idle.
  bool reduceMotion = false;

  /// Signals travelling along real links right now.
  final List<CheNeuralPulse> pulses = [];
  static const int maxPulses = 90;
  final math.Random _rng = math.Random(7);
  List<List<int>> _adjacency = const [];
  List<int> _recent = const [];
  Float32List _flash = Float32List(0);
  final Map<String, double> _born = {};
  double _spawnClock = 0;
  double _idle = 0;

  CheBrainCamera? _flyFrom;
  CheBrainCamera? _flyTo;
  double _flyT = 1;
  double _spinX = 0, _spinY = 0;

  /// Label text painters, capped; evicted ones are disposed.
  final Map<String, TextPainter> labels = {};

  TextPainter label(String key, String text, double size, Color color) {
    // The text is in the key: a lobe or worker count that changed is never drawn stale.
    final k = '$key|$size|$text';
    final hit = labels.remove(k);
    if (hit != null) return labels[k] = hit;
    if (labels.length >= 240) labels.remove(labels.keys.first)?.dispose();
    return labels[k] = TextPainter(
      text: TextSpan(text: text, style: TextStyle(fontFamily: labelFontFamily, fontSize: size, color: color, fontWeight: FontWeight.w600, shadows: const [Shadow(blurRadius: 6)])),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: 200);
  }

  CheBrainNode? get selected => selectedId == null ? null : layout.node(selectedId!);
  bool get flying => _flyT < 1;

  void update(List<CheMemoryDot> dots, List<Map<String, dynamic>> brainLinks, {List<Map<String, dynamic>>? roster}) {
    _dots = dots;
    _links = brainLinks;
    if (roster != null) _roster = roster;
    final before = {for (final n in layout.nodes) n.id};
    final moved = {for (final n in layout.nodes) if (n.moved != null) n.id: n.moved!};
    final expanded = {for (final c in layout.clusters.values) c.name: c.expanded};
    layout = CheBrainLayout.build(_scopedDots, brainLinks: brainLinks);
    _layoutWorkers();
    for (final n in layout.nodes) {
      n.moved = moved[n.id];
    }
    for (final c in layout.clusters.values) {
      c.expanded = expanded[c.name] ?? c.expanded;
    }
    if (selectedId != null && layout.node(selectedId!) == null) {
      selectedId = null;
      cardOpen = false;
    }
    _wire();
    // New memories are born: they flash, grow in, and fire into the earlier
    // memories they build on.
    for (var i = 0; i < layout.nodes.length; i++) {
      final id = layout.nodes[i].id;
      if (before.contains(id) || before.isEmpty) continue;
      _born[id] = time;
      _flash[i] = 1;
      for (final j in _adjacency[i]) {
        if (pulses.length < maxPulses) pulses.add(CheNeuralPulse(i, j, .9));
      }
    }
    _changed();
  }

  bool _inBrain(CheMemoryDot d, String worker) {
    final lower = worker.toLowerCase();
    return d.workers.any((w) => w.toLowerCase() == lower);
  }

  List<CheMemoryDot> get _scopedDots => scope == null ? _dots : [for (final d in _dots) if (_inBrain(d, scope!)) d];

  /// The worker a record name stands for, or null when it is not an internal
  /// worker: the roster decides (temporary provider workers and outside AIs are
  /// excluded; a name is matched without regard to case); with no roster at
  /// hand (offline before the first load) the record's own name stands, still
  /// never an outside AI or the Office's generic fallback names.
  String? _canonicalWorker(String name, Map<String, String> internal, Set<String> excluded, Map<String, String> seen) {
    final lower = name.trim().toLowerCase();
    if (lower.isEmpty || lower == 'che' || lower == 'office' || lower == 'office agent' || lower.startsWith('http') || excluded.contains(lower) || cheBrainExternalAi.hasMatch(name) || cheBrainMentionsExternalAi.hasMatch(name)) return null;
    if (internal.isNotEmpty) return internal[lower];
    // No roster: the first spelling seen stands for every later casing of the name.
    return seen.putIfAbsent(lower, () => name.trim());
  }

  /// One orb per internal worker (the roster's permanent workers, so an idle
  /// worker is shown as having no experience yet, never invented). Experience
  /// is what the worker did: tasks, skills, notes; never the worker's own
  /// profile record. Placed on a ring around the brain, top first.
  void _layoutWorkers() {
    final internal = <String, String>{};
    final excluded = <String>{};
    final roles = <String, String>{};
    final states = <String, String>{};
    for (final member in _roster) {
      final name = '${member['name'] ?? ''}'.trim();
      if (name.isEmpty) continue;
      // A retired worker keeps no orb (the Worker's core record drops retired names too).
      if (member['temporary'] == true || member['retired'] == true || cheBrainExternalAi.hasMatch(name)) {
        excluded.add(name.toLowerCase());
        continue;
      }
      internal[name.toLowerCase()] = name;
      roles[name] = '${member['role'] ?? ''}';
      final live = '${member['runtime_status'] ?? ''}';
      states[name] = live == 'working' || live == 'waiting' ? 'working' : 'idle';
    }
    final counts = <String, int>{for (final name in internal.values) name: 0};
    final shared = <String, Set<String>>{};
    final seen = <String, String>{};
    for (final d in _dots) {
      final mine = <String>{};
      for (final w in d.workers) {
        final canonical = _canonicalWorker(w, internal, excluded, seen);
        if (canonical != null) mine.add(canonical);
      }
      for (final w in mine) {
        counts.putIfAbsent(w, () => 0);
        if (d.kind != 'worker') counts[w] = counts[w]! + 1;
        for (final other in mine) {
          if (other != w) shared.putIfAbsent(w, () => {}).add(other);
        }
      }
    }
    final names = counts.keys.toList()..sort((a, b) => counts[b]!.compareTo(counts[a]!) != 0 ? counts[b]!.compareTo(counts[a]!) : a.compareTo(b));
    final n = names.length;
    workers = [
      for (var i = 0; i < n; i++)
        CheBrainWorkerOrb(
          name: names[i],
          records: counts[names[i]]!,
          role: roles[names[i]] ?? '',
          state: counts[names[i]] == 0 ? 'no experience yet' : states[names[i]] ?? '',
          collaborators: shared[names[i]] ?? const {},
          // Evenly around the ring, the first at the top, slightly behind the brain so the ring
          // never covers it.
          position: () {
            final a = -math.pi / 2 + 2 * math.pi * i / n;
            return vm.Vector3(math.cos(a) * workerRing, math.sin(a) * workerRing * .94, -1.5);
          }(),
        ),
    ];
  }

  /// Visible = in its expanded lobe, through the category filter and the lens.
  bool shows(CheBrainNode n) => layout.visible(n, filter) && (lens.isEmpty || lens.matches(n.dot, now: clock()));

  /// A collapsed cluster is drawn when the filter allows it and the lens leaves it a member.
  bool clusterShown(CheBrainCluster c) => !c.expanded && (filter.isEmpty || filter.contains(c.name)) && (lens.isEmpty || c.members.any((n) => lens.matches(n.dot, now: clock())));

  /// Members of a cluster the lens keeps (what its orb's count shows).
  int clusterCount(CheBrainCluster c) => lens.isEmpty ? c.members.length : c.members.where((n) => lens.matches(n.dot, now: clock())).length;

  /// Memories the category filter and the lens leave (collapsed lobes count their members: they are one tap away).
  int get visibleCount => layout.nodes.where((n) => (filter.isEmpty || filter.contains(n.cluster)) && (lens.isEmpty || lens.matches(n.dot, now: clock()))).length;

  CheBrainWorkerOrb? worker(String? name) {
    if (name == null) return null;
    final lower = name.toLowerCase();
    for (final w in workers) {
      if (w.name.toLowerCase() == lower) return w;
    }
    return null;
  }

  /// The brain in view, as the owner hears it.
  String get brainName => scope == null ? "CHE's brain" : "$scope's brain";

  /// Where the owner is: brain, lobe, facets, selection, and how close.
  String describe() {
    final parts = <String>[brainName];
    if (filter.isNotEmpty) parts.add('${filter.join(', ')} memories');
    if (!lens.isEmpty) parts.add(lens.describe());
    final sel = selected;
    if (sel != null) parts.add('${sel.dot.title} selected');
    parts.add(mode);
    return parts.join(', ');
  }

  /// 'overview', 'inside', 'inspecting' or 'close up' (from where the camera is heading).
  String get mode {
    if (cardOpen) return 'inspecting';
    final d = _flyT < 1 && _flyTo != null ? _flyTo!.distance : camera.distance;
    if (d < LayoutRadius.inner) return 'inside';
    if (d >= overviewDistance - .5) return 'overview';
    return 'close up';
  }

  CheBrainViewState snapshot() => CheBrainViewState(
        scope: scope, lens: lens, filter: {...filter}, selectedId: selectedId, cardOpen: cardOpen, focusedCluster: focusedCluster,
        camera: (_flyT < 1 && _flyTo != null ? _flyTo! : camera).copy(),
      );

  void _remember() {
    final s = snapshot();
    if (_history.isNotEmpty && _history.last.sameAs(s)) return;
    _history.add(s);
    if (_history.length > maxHistory) _history.removeAt(0);
  }

  bool get canGoBack => _history.isNotEmpty;

  /// Back to where the owner was: the same brain, filters, selection and camera.
  String goBack() {
    if (_history.isEmpty) return "Nowhere to go back to: this is the start, CHE's whole brain.";
    final s = _history.removeLast();
    if (s.scope != scope) {
      scope = s.scope;
      _rebuildForScope();
    }
    filter
      ..clear()
      ..addAll(s.filter);
    lens = s.lens;
    selectedId = layout.node(s.selectedId ?? '') == null ? null : s.selectedId;
    cardOpen = s.cardOpen && selectedId != null;
    focusedCluster = s.focusedCluster;
    if (selectedId != null) layout.clusters[selected!.cluster]?.expanded = true;
    flyTo(s.camera);
    _changed();
    return 'Back to ${describe()}.';
  }

  void _rebuildForScope() {
    final expanded = {for (final c in layout.clusters.values) c.name: c.expanded};
    layout = CheBrainLayout.build(_scopedDots, brainLinks: _links);
    for (final c in layout.clusters.values) {
      c.expanded = expanded[c.name] ?? c.expanded;
    }
    _wire();
    _born.clear();
    pulses.clear();
  }

  /// Opens a worker's brain in this same space (null: back to CHE's). Same
  /// lobes, same gestures, same panels; only the records are that worker's.
  String setScope(String? name) {
    if (name != null) {
      final orb = worker(name);
      if (orb == null) {
        final known = workers.map((w) => w.name).toList();
        return known.isEmpty
            ? 'No Office worker has experience in the Brain yet, sir.'
            : 'There is no worker brain called $name. The worker brains are: ${known.join(', ')}.';
      }
      name = orb.name;
    }
    if (name == scope) return name == null ? "You are in CHE's brain." : "You are already in $name's brain.";
    _remember();
    scope = name;
    selectedId = null;
    cardOpen = false;
    grabbedId = null;
    focusedCluster = null;
    filter.clear();
    lens = CheBrainLens.none;
    _rebuildForScope();
    flyTo(CheBrainCamera(yaw: math.pi, pitch: .08, distance: overviewDistance));
    _changed();
    if (name == null) return "CHE's brain: ${layout.nodes.length} memories and ${workers.length} worker brain${workers.length == 1 ? '' : 's'}.";
    final orb = worker(name)!;
    if (orb.records == 0) return "$name has no experience recorded yet${orb.role.isNotEmpty ? ' (${orb.role})' : ''}. Nothing is invented here; the brain fills as $name works.";
    final lobes = layout.clusters.values.map((c) => '${c.name} ${c.members.length}').join('; ');
    return "$name's brain${orb.role.isNotEmpty ? ', ${orb.role}' : ''}: ${orb.records} record${orb.records == 1 ? '' : 's'} of experience in ${layout.clusters.length} lobe${layout.clusters.length == 1 ? '' : 's'}: $lobes."
        '${orb.collaborators.isNotEmpty ? ' Works with ${(orb.collaborators.toList()..sort()).join(', ')}.' : ''}';
  }

  /// The top of the Brain system: CHE's brain, no filters, nothing selected, the whole view.
  String goHome() {
    _remember();
    if (scope != null) {
      scope = null;
      _rebuildForScope();
    }
    filter.clear();
    lens = CheBrainLens.none;
    selectedId = null;
    cardOpen = false;
    focusedCluster = null;
    flyTo(CheBrainCamera(yaw: math.pi, pitch: .08, distance: overviewDistance));
    _changed();
    return "CHE's brain: $countWords${workers.isNotEmpty ? ' and ${workers.length} worker brain${workers.length == 1 ? '' : 's'}' : ''}.";
  }

  /// This brain, whole: filters and selection cleared, the camera where it is.
  String clearView() {
    _remember();
    filter.clear();
    lens = CheBrainLens.none;
    selectedId = null;
    cardOpen = false;
    _changed();
    return '$brainName: showing all ${scope == null ? countWords : '${layout.nodes.length} records'}.';
  }

  /// Narrows the view by facets; the orbs the lens hides are not drawn, counted or stepped to.
  String setLens(CheBrainLens next) {
    if (next == lens) return next.isEmpty ? 'No filters are set.' : 'Already showing ${next.describe()}.';
    _remember();
    lens = next;
    if (selectedId != null && !shows(selected!)) {
      selectedId = null;
      cardOpen = false;
    }
    _changed();
    if (next.isEmpty) return 'Filters cleared: showing all ${layout.nodes.length} memories.';
    final n = visibleCount;
    return n == 0 ? 'No memories match ${next.describe()} in $brainName.' : 'Showing ${next.describe()}: $n of ${layout.nodes.length}.';
  }

  String clearAll() {
    final had = filter.isNotEmpty || !lens.isEmpty;
    if (!had) return 'No filters are set.';
    _remember();
    filter.clear();
    lens = CheBrainLens.none;
    _changed();
    return 'Filters cleared: showing all ${layout.nodes.length} memories.';
  }

  String zoomIn() {
    _remember();
    final to = (_flyT < 1 && _flyTo != null ? _flyTo! : camera).copy();
    to.distance = math.max(0, (to.distance + 1) / 1.6 - 1);
    if (to.distance < .05) to.distance = 0;
    flyTo(to);
    _changed();
    return to.distance == 0 ? 'At the center of the brain.' : 'Closer: $mode.';
  }

  String zoomOut() {
    _remember();
    final to = (_flyT < 1 && _flyTo != null ? _flyTo! : camera).copy();
    to.distance = math.min(CheBrainCamera.maxDistance, (to.distance + 1) * 1.6 - 1);
    flyTo(to);
    _changed();
    return 'Farther out: $mode.';
  }

  /// Fits everything in view: the brain, and in CHE's view the ring of worker brains.
  String fit() {
    _remember();
    cardOpen = false;
    flyTo(CheBrainCamera(yaw: math.pi, pitch: .08, distance: overviewDistance));
    _changed();
    return scope == null && workers.isNotEmpty
        ? "Fitted: CHE's brain, ${layout.nodes.length} memories, with ${workers.length} worker brain${workers.length == 1 ? '' : 's'} around it."
        : 'Fitted: $brainName, ${layout.nodes.length} memories.';
  }

  /// Back to CHE at the center, from any brain, keeping nothing selected.
  String centerOnChe() {
    if (scope != null) return setScope(null);
    _remember();
    selectedId = null;
    cardOpen = false;
    focusedCluster = null;
    flyTo(CheBrainCamera(yaw: camera.yaw, pitch: .08, distance: overviewDistance));
    _changed();
    return "Centered on CHE: ${layout.nodes.length} memories${workers.isNotEmpty ? ', ${workers.length} worker brain${workers.length == 1 ? '' : 's'} around her' : ''}.";
  }

  String centerOnSelected() {
    final node = selected;
    if (node == null) return 'Nothing is selected. Tap a memory, or say "find my memory about" and a topic.';
    _remember();
    flyTo(CheBrainCamera(target: node.position.clone(), yaw: camera.yaw, pitch: camera.pitch, distance: 3.4));
    _changed();
    return 'Centered on ${node.dot.title}.';
  }

  void _wire() {
    final n = layout.nodes.length;
    _adjacency = [for (var i = 0; i < n; i++) <int>[]];
    for (final e in layout.edges) {
      _adjacency[e.$1].add(e.$2);
      _adjacency[e.$2].add(e.$1);
    }
    _flash = Float32List(n);
    pulses.removeWhere((p) => p.from >= n || p.to >= n);
    final dated = [for (var i = 0; i < n; i++) if (layout.nodes[i].dot.at != null && _adjacency[i].isNotEmpty) i]
      ..sort((a, b) => layout.nodes[b].dot.at!.compareTo(layout.nodes[a].dot.at!));
    _recent = dated.take(24).toList();
  }

  /// Where node [i] is drawn right now: its place plus a slow neural drift.
  vm.Vector3 livePosition(int i) {
    final node = layout.nodes[i];
    final p = node.position;
    if (reduceMotion || node.moved != null) return p;
    final ph = i * 1.618;
    const a = .14;
    return vm.Vector3(
      p.x + math.sin(time * .50 + ph) * a,
      p.y + math.sin(time * .43 + ph * 1.3) * a,
      p.z + math.cos(time * .37 + ph * .7) * a,
    );
  }

  /// 0..1 activity of node [i] (it just received or fired a signal).
  double flash(int i) => i < _flash.length ? _flash[i] : 0;

  final Map<CheBrainRegion, double> _regionGlow = {};

  /// 0..1: how brightly [region] is lit by a real learning event right now.
  double regionGlow(CheBrainRegion region) => _regionGlow[region] ?? 0;

  /// A real learning event (the Brain Population Ledger) arrived for [region]: the region lights up briefly and
  /// signals run out along its real links. Only the Real-Time Learning feed calls this, with ledger events; nothing
  /// here invents one. Returns how many records of that region lit up (0: the region holds none on this phone).
  int illuminate(CheBrainRegion region) {
    final members = [for (var i = 0; i < layout.nodes.length; i++) if (layout.nodes[i].region == region) i];
    if (members.isEmpty) return 0;
    _regionGlow[region] = 1;
    if (!reduceMotion) {
      for (final i in members.take(24)) {
        _flash[i] = 1;
        final next = _adjacency[i];
        if (next.isNotEmpty && pulses.length < maxPulses) pulses.add(CheNeuralPulse(i, next[_rng.nextInt(next.length)], .9));
      }
    }
    _repaint();
    return members.length;
  }

  /// Grows a just-born memory in from nothing (ease-out with a small pop).
  double birthScale(String id) {
    final b = _born[id];
    if (b == null) return 1;
    final t = ((time - b) / 1.2).clamp(0.0, 1.0);
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * math.pow(t - 1, 3) + c1 * math.pow(t - 1, 2);
  }

  void _fireFrom(int i) {
    final next = _adjacency[i];
    if (next.isEmpty || pulses.length >= maxPulses) return;
    _flash[i] = math.max(_flash[i], .7);
    pulses.add(CheNeuralPulse(i, next[_rng.nextInt(next.length)], .55 + _rng.nextDouble() * .6));
  }

  /// Signals travel, arrive, light up the memory, and often carry on to one
  /// of its neighbours: chains of thought across real links.
  void _advanceNeurons(double dt) {
    final n = layout.nodes.length;
    if (n == 0 || layout.edges.isEmpty) return;
    final decay = math.exp(-2.4 * dt);
    for (var i = 0; i < n; i++) {
      _flash[i] *= decay;
    }
    _spawnClock += dt;
    final interval = .9 / math.max(1, math.sqrt(layout.edges.length / 4));
    while (_spawnClock > interval) {
      _spawnClock -= interval;
      final fromRecent = _recent.isNotEmpty && _rng.nextDouble() < .4;
      _fireFrom(fromRecent ? _recent[_rng.nextInt(_recent.length)] : _rng.nextInt(n));
    }
    final arrived = <CheNeuralPulse>[];
    for (final p in pulses) {
      p.t += dt * p.speed;
      if (p.t >= 1) arrived.add(p);
    }
    for (final p in arrived) {
      pulses.remove(p);
      _flash[p.to] = 1;
      if (_rng.nextDouble() < .6) {
        final next = [for (final j in _adjacency[p.to]) if (j != p.from) j];
        if (next.isNotEmpty && pulses.length < maxPulses) {
          pulses.add(CheNeuralPulse(p.to, next[_rng.nextInt(next.length)], p.speed));
        }
      }
    }
  }

  void _changed() {
    state.value++;
    _repaint();
  }

  void _repaint() => frame.value++;

  /// Advances animations. Returns true while something is still moving.
  bool tick(double dt, {bool repaint = true}) {
    time += dt;
    var moving = false;
    if (_flyT < 1 && _flyFrom != null && _flyTo != null) {
      _flyT = math.min(1, _flyT + dt / .75);
      camera.lerpTo(_flyFrom!, _flyTo!, _flyT);
      moving = true;
    } else if (_spinX.abs() > .0004 || _spinY.abs() > .0004) {
      camera.rotate(_spinX, _spinY);
      final decay = math.pow(.9, dt * 60).toDouble();
      _spinX *= decay;
      _spinY *= decay;
      moving = true;
    }
    if (!reduceMotion) {
      _idle += dt;
      // Left alone, the brain slowly sways side to side by itself.
      if (!moving && grabbedId == null && !cardOpen && _idle > 2.5) camera.rotate(dt * .06 * math.cos(time * .12), 0);
      _advanceNeurons(dt);
    }
    _born.removeWhere((_, b) => time - b > 1.2);
    if (_regionGlow.isNotEmpty) {
      final decay = math.exp(-1.1 * dt);
      _regionGlow.updateAll((_, v) => v * decay);
      _regionGlow.removeWhere((_, v) => v < .02);
      moving = true;
    }
    if (repaint) _repaint();
    // Alive: always ticking. Reduce Motion: stop when nothing moves.
    return !reduceMotion || moving || selectedId != null || grabbedId != null;
  }

  void flyTo(CheBrainCamera to) {
    _spinX = _spinY = 0;
    _flyFrom = camera.copy();
    _flyTo = to;
    _flyT = 0;
  }

  void fling(double vx, double vy) {
    _idle = 0;
    _spinX = vx;
    _spinY = vy;
  }

  void stop() {
    _idle = 0;
    _flyT = 1;
    _spinX = _spinY = 0;
  }

  // ─── Actions (gestures, buttons and voice all use these) ───────────────

  String select(CheBrainNode node, {bool fly = true}) {
    if (node.id != selectedId) _remember();
    selectedId = node.id;
    final cluster = layout.clusters[node.cluster];
    if (cluster != null && !cluster.expanded) cluster.expanded = true;
    if (fly) flyTo(CheBrainCamera(target: node.position.clone(), yaw: camera.yaw, pitch: camera.pitch, distance: 3.4));
    _changed();
    return '${node.dot.title}. ${node.dot.category}. Say "open this memory" or tap it again to read it.';
  }

  String openSelected() {
    final node = selected;
    if (node == null) return 'No memory is selected. Tap one, or say "find my memory about" and a topic.';
    cardOpen = true;
    _changed();
    return '${node.dot.title}. ${node.dot.body}';
  }

  void closeCard() {
    cardOpen = false;
    _changed();
  }

  void deselect() {
    selectedId = null;
    cardOpen = false;
    _changed();
  }

  String overview() {
    _remember();
    cardOpen = false;
    flyTo(CheBrainCamera(yaw: math.pi, pitch: .08, distance: overviewDistance));
    _changed();
    return 'Showing the whole ${scope == null ? 'brain' : "of $scope's brain"}: ${layout.nodes.length} memories in ${layout.clusters.length} clusters'
        '${scope == null && workers.isNotEmpty ? ', ${workers.length} worker brains around it' : ''}.';
  }

  String inside() {
    _remember();
    cardOpen = false;
    flyTo(CheBrainCamera(yaw: camera.yaw, pitch: 0, distance: 0));
    _changed();
    return 'You are at the center of my brain. Memories surround you; drag to look around.';
  }

  String backOut() {
    final d = camera.distance;
    final next = d < 2 ? 9.0 : d < 12 ? 20.0 : overviewDistance;
    if (next >= overviewDistance) return overview();
    _remember();
    cardOpen = false;
    flyTo(CheBrainCamera(target: camera.target.clone(), yaw: camera.yaw, pitch: camera.pitch, distance: next));
    _changed();
    return 'Backing out.';
  }

  String setFilter(String? category) {
    if (category == null && filter.isEmpty) return 'Showing all ${layout.nodes.length} memories.';
    _remember();
    filter
      ..clear()
      ..addAll([?category]);
    if (category != null) {
      final c = layout.clusters[category];
      final what = category == 'Knowledge Atlas' ? 'Knowledge Atlas records' : '$category memories';
      if (c == null) {
        _changed();
        return 'There are no $what yet.';
      }
      c.expanded = true;
      flyTo(CheBrainCamera(target: c.center.clone(), yaw: math.atan2(-c.center.x, c.center.z), pitch: .15, distance: 11));
      _changed();
      return category == 'Knowledge Atlas'
          ? 'Showing the Knowledge Atlas records, curated lessons and your practice: ${c.members.length}.'
          : 'Showing your $category memories: ${c.members.length}.';
    }
    _changed();
    return 'Showing all ${layout.nodes.length} memories.';
  }

  String toggleCluster(String name, {bool? expand}) {
    final c = layout.clusters[name];
    if (c == null) return 'There is no $name cluster.';
    _remember();
    focusedCluster = name;
    c.expanded = expand ?? !c.expanded;
    if (c.expanded) flyTo(CheBrainCamera(target: c.center.clone(), yaw: math.atan2(-c.center.x, c.center.z), pitch: .15, distance: 9));
    if (!c.expanded && selected?.cluster == name) {
      selectedId = null;
      cardOpen = false;
    }
    _changed();
    return c.expanded ? '$name cluster expanded: ${c.members.length} memories.' : '$name cluster collapsed.';
  }

  String find(String query) {
    final node = layout.find(query);
    if (node == null) return 'I could not find a memory about $query.';
    filter.clear();
    return 'Found it. ${select(node)}';
  }

  /// Live agent work, spoken from real task orbs: "what is Atlas working
  /// on". A named agent with no live orb says so honestly; "who is working"
  /// lists every agent with live work, or says the crew is free.
  String agentStatus(String? agent) {
    final live = [for (final n in layout.nodes) if (n.dot.category == 'Agents') n];
    String cap(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
    if (agent != null) {
      final mine = [for (final n in live) if (n.dot.source.toLowerCase() == agent) n];
      if (mine.isEmpty) return '${cap(agent)} has no live work in the brain right now.';
      select(mine.first);
      final rest = mine.skip(1).map((n) => n.dot.title).join('; ');
      return '${cap(agent)} is working on: ${mine.first.dot.title}. ${mine.first.dot.body}${rest.isEmpty ? '' : ' Also: $rest'}';
    }
    if (live.isEmpty) return 'No agent has live work in the brain right now.';
    final byAgent = <String, List<CheBrainNode>>{};
    for (final n in live) {
      byAgent.putIfAbsent(n.dot.source, () => []).add(n);
    }
    return 'Working now: ${byAgent.entries.map((e) => '${e.key} — ${e.value.map((n) => n.dot.title).join('; ')}').join('. ')}.';
  }

  /// Cluster the owner last reached (VoiceOver step, tap, filter).
  String? focusedCluster;

  String focusCluster(CheBrainCluster cl) {
    _remember();
    focusedCluster = cl.name;
    selectedId = null;
    cardOpen = false;
    flyTo(CheBrainCamera(target: cl.center.clone(), yaw: math.atan2(-cl.center.x, cl.center.z), pitch: .15, distance: 11));
    _changed();
    return '${cl.name} cluster, ${cl.members.length} memories, collapsed. Say "expand this cluster" to open it.';
  }

  /// Next/previous stop for VoiceOver users: collapsed clusters first, then
  /// visible memories, most important first.
  String step(int delta) {
    final clusters = [
      for (final cl in layout.clusters.values)
        if (clusterShown(cl)) cl,
    ];
    final nodes = [
      for (final n in layout.nodes)
        if (shows(n)) n,
    ]..sort((a, b) => b.dot.importance.compareTo(a.dot.importance) != 0 ? b.dot.importance.compareTo(a.dot.importance) : a.id.compareTo(b.id));
    final stops = <Object>[...clusters, ...nodes];
    if (stops.isEmpty) return 'No memories are visible.';
    final i = stops.indexWhere((x) => x is CheBrainNode ? x.id == selectedId : (x as CheBrainCluster).name == focusedCluster && selectedId == null);
    final next = stops[((i < 0 ? (delta > 0 ? -1 : 0) : i) + delta) % stops.length];
    return next is CheBrainNode ? select(next) : focusCluster(next as CheBrainCluster);
  }

  String? get _targetCluster {
    if (selected != null) return selected!.cluster;
    if (focusedCluster != null) return focusedCluster;
    for (final cl in layout.clusters.values) {
      if (!cl.expanded) return cl.name;
    }
    return null;
  }

  String execute(CheBrainCommand command) => switch (command.action) {
        CheBrainAction.open => overview(),
        CheBrainAction.inside => inside(),
        CheBrainAction.overview => overview(),
        CheBrainAction.backOut => backOut(),
        CheBrainAction.filter => setFilter(command.category),
        CheBrainAction.clearFilter => clearAll(),
        CheBrainAction.find => find(command.query ?? ''),
        CheBrainAction.openSelected => openSelected(),
        CheBrainAction.expand => _targetCluster == null ? 'Every cluster is already open.' : toggleCluster(_targetCluster!, expand: true),
        CheBrainAction.collapse => _targetCluster == null ? 'No cluster is selected.' : toggleCluster(_targetCluster!, expand: false),
        CheBrainAction.agentStatus => agentStatus(command.agent),
        CheBrainAction.zoomIn => zoomIn(),
        CheBrainAction.zoomOut => zoomOut(),
        CheBrainAction.fit => fit(),
        CheBrainAction.back => goBack(),
        CheBrainAction.centerChe => centerOnChe(),
        CheBrainAction.centerSelected => centerOnSelected(),
        CheBrainAction.openWorker => setScope(command.worker),
        CheBrainAction.lens => setLens(command.lens ?? CheBrainLens.none),
        CheBrainAction.list => showList(command.section),
        CheBrainAction.space => showSpace(),
      };

  // ─── List view (owner, 2026-10-23) ─────────────────────────────────────

  /// True while the Brain Room shows the searchable list instead of the neural view.
  bool listMode = false;

  /// The list's section, or null for every section.
  CheBrainSection? listSection;

  /// Shows the list (one section or all) and says what it holds, from the real records.
  String showList([CheBrainSection? section]) {
    listMode = true;
    listSection = section;
    state.value++;
    final counts = cheBrainSectionCounts(_dots);
    if (section != null) {
      final n = counts[section] ?? 0;
      return '${section.label}: $n record${n == 1 ? '' : 's'}. ${section.meaning}';
    }
    return 'The Brain list: ${[for (final s in CheBrainSection.values) '${counts[s]} ${s.label.toLowerCase()}'].join(', ')}.';
  }

  String showSpace() {
    listMode = false;
    state.value++;
    return 'Back to the neural view.';
  }

  // ─── Hit testing ───────────────────────────────────────────────────────

  /// The orb or collapsed cluster under a screen point (nearest wins).
  ({CheBrainNode? node, CheBrainCluster? cluster, CheBrainWorkerOrb? worker}) hit(Offset at, Size size) {
    // A worker brain on the ring is a big, labelled target too (CHE's view only).
    if (scope == null) {
      for (final w in workers) {
        final p = camera.project(w.position, size, worldRadius: w.radius);
        if (p != null && (p.offset - at).distance <= math.max(p.radius, 26)) return (node: null, cluster: null, worker: w);
      }
    }
    // A collapsed cluster is a big, labelled target: a tap inside its orb
    // always means the cluster.
    for (final c in layout.clusters.values) {
      if (!clusterShown(c)) continue;
      final p = camera.project(c.center, size, worldRadius: _clusterRadius(c));
      if (p != null && (p.offset - at).distance <= math.max(p.radius, 26)) return (node: null, cluster: c, worker: null);
    }
    CheBrainNode? best;
    var bestDepth = double.infinity;
    for (var i = 0; i < layout.nodes.length; i++) {
      final n = layout.nodes[i];
      if (!shows(n)) continue;
      final p = camera.project(livePosition(i), size, worldRadius: n.size);
      if (p == null) continue;
      if ((p.offset - at).distance <= math.max(p.radius * 1.6, 18) && p.depth < bestDepth) {
        best = n;
        bestDepth = p.depth;
      }
    }
    return (node: best, cluster: null, worker: null);
  }

  static double _clusterRadius(CheBrainCluster c) => .8 + math.min(2.2, math.sqrt(c.members.length) * .18);

  void dispose() {
    if (identical(current, this)) current = null;
    for (final t in labels.values) {
      t.dispose();
    }
    labels.clear();
    frame.dispose();
    state.dispose();
  }
}

/// The interactive space. Fills its parent.
class CheBrainSpace extends StatefulWidget {
  const CheBrainSpace({
    super.key,
    required this.controller,
    this.onSpeak,
    this.active = true,
    this.cardBottomInset = 0,
    this.onOpenAgent,
  });

  final CheBrainSpaceController controller;

  /// Says what was selected (CHE's voice).
  final void Function(String text)? onSpeak;
  final bool active;

  /// Keeps the memory card above controls the parent floats at the bottom.
  final double cardBottomInset;

  /// Deep link for live agent orbs: the agent's name. Null hides the button.
  final void Function(String agentName)? onOpenAgent;

  @override
  State<CheBrainSpace> createState() => _CheBrainSpaceState();
}

/// A scale recognizer that claims the gesture the moment a finger lands, so
/// the hub's tab swipe or the sheet's drag-to-dismiss can never steal an
/// orbit. Tap and long-press are recognized inside it (see the state).
class _BrainGestureRecognizer extends ScaleGestureRecognizer {
  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event);
    resolve(GestureDisposition.accepted);
  }
}

class _CheBrainSpaceState extends State<CheBrainSpace> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_onTick);
  Duration _last = Duration.zero;
  Size _size = Size.zero;
  Offset _lastFocal = Offset.zero;
  double _lastScale = 1;
  int _maxPointers = 0;
  Offset _velocity = Offset.zero;
  // Tap / long-press detection inside the one recognizer.
  Offset _downAt = Offset.zero;
  double _travel = 0;
  DateTime _downTime = DateTime.now();
  Timer? _holdTimer;
  double _grabDepth = 0;
  Offset _grabOffset = Offset.zero;
  // Large-text caption for everything CHE says here (deaf-friendly).
  final ValueNotifier<String?> _caption = ValueNotifier<String?>(null);
  Timer? _captionTimer;

  CheBrainSpaceController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    SchedulerBinding.instance.addTimingsCallback(_onTimings);
    c.state.addListener(_wake);
    if (widget.active) {
      CheBrainSpaceController.current = c;
      _wake();
    }
  }

  @override
  void didUpdateWidget(covariant CheBrainSpace old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, c)) {
      old.controller.state.removeListener(_wake);
      c.state.addListener(_wake);
    }
    // Voice commands reach the Brain only while it is on screen.
    if (widget.active) {
      CheBrainSpaceController.current = c;
      _wake();
    } else {
      if (identical(CheBrainSpaceController.current, c)) CheBrainSpaceController.current = null;
      if (_ticker.isActive) _ticker.stop();
    }
  }

  @override
  void dispose() {
    SchedulerBinding.instance.removeTimingsCallback(_onTimings);
    c.state.removeListener(_wake);
    _holdTimer?.cancel();
    _captionTimer?.cancel();
    _caption.dispose();
    _ticker.dispose();
    if (identical(CheBrainSpaceController.current, c)) CheBrainSpaceController.current = null;
    super.dispose();
  }

  /// Starts frames on interaction; they stop again when nothing moves.
  void _wake() {
    if (!widget.active || _ticker.isActive || !mounted) return;
    _last = Duration.zero;
    _ticker.start();
  }

  void _onTick(Duration elapsed) {
    final dt = _last == Duration.zero ? 1 / 60 : (elapsed - _last).inMicroseconds / 1e6;
    _last = elapsed;
    // In economy the camera still advances every tick; the painter runs every other one.
    if (!c.tick(dt.clamp(0, .05).toDouble(), repaint: c.budget.admitTick())) _ticker.stop();
  }

  /// Real frame times (build + raster) feed the frame budget while the Brain is on screen.
  void _onTimings(List<FrameTiming> timings) {
    if (!widget.active || !_ticker.isActive) return;
    for (final t in timings) {
      c.budget.observe(t.totalSpan.inMicroseconds / 1000);
    }
  }

  void _say(String text) {
    _caption.value = text;
    _captionTimer?.cancel();
    _captionTimer = Timer(const Duration(seconds: 5), () => _caption.value = null);
    if (widget.onSpeak != null) {
      widget.onSpeak!(text);
    } else {
      // No CHE voice wired: VoiceOver reads it instead (never both at once).
      final view = View.maybeOf(context);
      if (view != null) SemanticsService.sendAnnouncement(view, text, TextDirection.ltr);
    }
  }

  // ─── Gestures ──────────────────────────────────────────────────────────

  void _scaleStart(ScaleStartDetails d) {
    c.stop();
    _wake();
    _lastFocal = d.localFocalPoint;
    _lastScale = 1;
    _velocity = Offset.zero;
    if (d.pointerCount <= 1 && _maxPointers == 0) {
      _downAt = d.localFocalPoint;
      _downTime = DateTime.now();
      _travel = 0;
      _holdTimer?.cancel();
      _holdTimer = Timer(const Duration(milliseconds: 450), _hold);
    }
    _maxPointers = d.pointerCount > _maxPointers ? d.pointerCount : _maxPointers;
    if (d.pointerCount > 1) _holdTimer?.cancel();
  }

  void _scaleUpdate(ScaleUpdateDetails d) {
    final delta = d.localFocalPoint - _lastFocal;
    _lastFocal = d.localFocalPoint;
    _travel += delta.distance;
    if (d.pointerCount > _maxPointers) _maxPointers = d.pointerCount;
    if (_travel > 10 || d.pointerCount > 1) _holdTimer?.cancel();
    final grabbed = c.grabbedId == null ? null : c.layout.node(c.grabbedId!);
    if (grabbed != null) {
      grabbed.moved = c.camera.unproject(d.localFocalPoint + _grabOffset, _grabDepth, _size);
      c.tick(0);
      return;
    }
    if (d.pointerCount >= 2) {
      final step = d.scale / _lastScale;
      _lastScale = d.scale;
      if (step.isFinite && step > 0) c.camera.zoom(step);
      c.camera.pan(delta.dx, delta.dy);
    } else {
      // Grab-the-world: dragging right turns the brain right.
      const k = .0055;
      c.camera.rotate(-delta.dx * k, -delta.dy * k);
      _velocity = Offset(-delta.dx * k, -delta.dy * k);
    }
    c.tick(0);
  }

  void _scaleEnd(ScaleEndDetails d) {}

  // Fingers on the canvas, counted directly: the recognizer restarts when a
  // finger lifts mid-pinch, so its end event cannot tell the last lift.
  int _down = 0;

  void _pointerDown(PointerDownEvent e) => _down++;

  void _pointerUp(PointerEvent e) {
    _down = _down > 0 ? _down - 1 : 0;
    if (_down == 0) _gestureFinished();
  }

  void _gestureFinished() {
    _holdTimer?.cancel();
    final multi = _maxPointers > 1;
    _maxPointers = 0;
    if (c.grabbedId != null) {
      final node = c.layout.node(c.grabbedId!);
      c.grabbedId = null;
      HapticFeedback.lightImpact();
      c.state.value++;
      if (node != null) _say('Placed ${node.dot.title}.');
      return;
    }
    if (!multi && _travel < 10 && DateTime.now().difference(_downTime) < const Duration(milliseconds: 450)) {
      _tap(_downAt);
      return;
    }
    if (!multi && _velocity.distance > .002) c.fling(_velocity.dx, _velocity.dy);
    if (multi && c.camera.inside) _say('Inside my brain. Drag to look around; spread fingers apart to back out.');
  }

  void _tap(Offset at) {
    final hit = c.hit(at, _size);
    if (hit.worker != null) {
      HapticFeedback.mediumImpact();
      _say(c.setScope(hit.worker!.name));
      return;
    }
    if (hit.cluster != null) {
      HapticFeedback.mediumImpact();
      _say(c.toggleCluster(hit.cluster!.name, expand: true));
      return;
    }
    final node = hit.node;
    if (node == null) {
      if (c.cardOpen || c.selectedId != null) c.deselect();
      return;
    }
    HapticFeedback.selectionClick();
    _say(node.id == c.selectedId ? c.openSelected() : c.select(node));
  }

  /// Long-press: grab the orb under the finger. On empty space nothing is
  /// grabbed and the drag keeps orbiting.
  void _hold() {
    if (_maxPointers > 1 || _travel > 10) return;
    final node = c.hit(_downAt, _size).node;
    if (node == null) return;
    final p = c.camera.project(node.position, _size);
    if (p == null) return;
    HapticFeedback.heavyImpact();
    c.stop();
    c.grabbedId = node.id;
    c.selectedId = node.id;
    _grabDepth = p.depth;
    _grabOffset = p.offset - _lastFocal;
    c.state.value++;
    _say('Holding ${node.dot.title}. Move your finger to place it.');
  }

  @override
  Widget build(BuildContext context) {
    final labelScale = MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.4).toDouble();
    final still = MediaQuery.disableAnimationsOf(context);
    if (c.reduceMotion != still) {
      c.reduceMotion = still;
      if (!still) WidgetsBinding.instance.addPostFrameCallback((_) => _wake());
    }
    return LayoutBuilder(builder: (context, constraints) {
      _size = constraints.biggest;
      return Stack(fit: StackFit.expand, children: [
        Positioned.fill(
          child: ValueListenableBuilder<int>(
            valueListenable: c.state,
            builder: (context, _, _) {
              final sel = c.selected;
              return Semantics(
                label: '${c.brainName}: ${c.scope == null && c.countWords.contains('Knowledge Atlas') ? 'real ${c.countWords}' : '${c.layout.nodes.length} real ${c.scope == null ? 'memories' : 'records'}'} in ${c.layout.clusters.length} clusters. '
                    '${sel == null ? 'Nothing selected.' : 'Selected: ${sel.dot.title}, ${sel.dot.category}.'}',
                hint: 'Use the actions to move between memories and clusters, open one, go inside, back out, or show the whole brain.',
                customSemanticsActions: {
                  const CustomSemanticsAction(label: 'Next memory'): () => _say(c.step(1)),
                  const CustomSemanticsAction(label: 'Previous memory'): () => _say(c.step(-1)),
                  const CustomSemanticsAction(label: 'Open selected memory'): () => _say(c.openSelected()),
                  const CustomSemanticsAction(label: 'Expand cluster'): () => _say(c.execute(const CheBrainCommand(CheBrainAction.expand))),
                  const CustomSemanticsAction(label: 'Collapse cluster'): () => _say(c.execute(const CheBrainCommand(CheBrainAction.collapse))),
                  const CustomSemanticsAction(label: 'Go inside the brain'): () => _say(c.inside()),
                  const CustomSemanticsAction(label: 'Back out'): () => _say(c.backOut()),
                  const CustomSemanticsAction(label: 'Show the whole brain'): () => _say(c.overview()),
                },
                child: Listener(
                  onPointerDown: _pointerDown,
                  onPointerUp: _pointerUp,
                  onPointerCancel: _pointerUp,
                  child: RawGestureDetector(
                  behavior: HitTestBehavior.opaque,
                  gestures: {
                    _BrainGestureRecognizer: GestureRecognizerFactoryWithHandlers<_BrainGestureRecognizer>(
                      _BrainGestureRecognizer.new,
                      (r) => r
                        ..onStart = _scaleStart
                        ..onUpdate = _scaleUpdate
                        ..onEnd = _scaleEnd,
                    ),
                  },
                  child: RepaintBoundary(
                    child: CustomPaint(
                      key: const ValueKey('che-brain-canvas'),
                      painter: CheBrainPainter(c, textScale: labelScale),
                      size: Size.infinite,
                    ),
                  ),
                ),
                ),
              );
            },
          ),
        ),
        // What CHE just said, as large text at the top.
        Positioned(
          left: 12,
          right: 12,
          top: 8,
          child: ValueListenableBuilder<String?>(
            valueListenable: _caption,
            builder: (context, text, _) => text == null
                ? const SizedBox.shrink()
                : ExcludeSemantics(
                    child: cheBrainPanel(
                      radius: 14,
                      fill: const Color(0xCC071012),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        child: Text(text, maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 18, height: 1.25)),
                      ),
                    ),
                  ),
          ),
        ),
        // The selected memory's callout (title, date and time), pinned to its
        // orb by a line, like a label in space. Tap it to open the memory.
        ValueListenableBuilder<int>(
          valueListenable: c.frame,
          builder: (context, _, _) {
            final sel = c.selected;
            final i = sel == null ? null : c.layout.byId[sel.id];
            if (sel == null || i == null || c.cardOpen || _size.isEmpty) return const SizedBox.shrink();
            final p = c.camera.project(c.livePosition(i), _size, worldRadius: sel.size);
            if (p == null) return const SizedBox.shrink();
            return _MemoryCallout(node: sel, anchor: p.offset, area: _size, onOpen: () => _say(c.openSelected()));
          },
        ),
        ValueListenableBuilder<int>(
          valueListenable: c.state,
          builder: (context, _, _) {
            final sel = c.selected;
            if (!c.cardOpen || sel == null) return const SizedBox.shrink();
            // Phones: a bottom sheet over the lower part of the space. Wider
            // screens (tablet, desktop, landscape): a side panel on the right,
            // so the brain stays in view beside what is being read.
            final side = _size.width >= cheBrainSidePanelWidth;
            final card = _MemoryCard(controller: c, node: sel, onSpeak: _say, onOpenAgent: widget.onOpenAgent, side: side);
            if (side) return Positioned(top: 52, right: 12, bottom: 12 + widget.cardBottomInset, width: 360, child: Align(alignment: Alignment.topRight, child: card));
            return Positioned(left: 12, right: 12, bottom: 12 + widget.cardBottomInset, child: card);
          },
        ),
      ]);
    });
  }
}

/// A panel over the brain space: the Brain's own dark panel, or in HUD glass a glossy glass pane over a deep navy
/// underlay (so text over bright orbs stays readable), its edge lit in the memory's category colour.
Widget cheBrainPanel({
  required Widget child,
  required double radius,
  required Color fill,
  Color? edge,
  double edgeAlpha = .55,
  double edgeWidth = 1,
  double shadowAlpha = .22,
  double shadowBlur = 24,
}) {
  if (cheHudActive) {
    return DecoratedBox(
      decoration: BoxDecoration(color: CheHud.navyMid.withValues(alpha: .94), borderRadius: BorderRadius.circular(radius)),
      child: CheGlass(radius: radius, glow: edge, child: child),
    );
  }
  return DecoratedBox(
    decoration: BoxDecoration(
      color: fill,
      borderRadius: BorderRadius.circular(radius),
      border: edge == null ? null : Border.all(color: edge.withValues(alpha: edgeAlpha), width: edgeWidth),
      boxShadow: edge == null ? null : [BoxShadow(color: edge.withValues(alpha: shadowAlpha), blurRadius: shadowBlur)],
    ),
    child: child,
  );
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "Apr 12, 2024 • 4:32 PM" in the phone's local time.
String cheMemoryWhen(DateTime at) {
  final t = at.toLocal();
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${_months[t.month - 1]} ${t.day}, ${t.year} • $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

IconData cheMemoryIcon(String category) => switch (category.toLowerCase()) {
      'conversations' => Icons.forum_outlined,
      'about you' => Icons.person_outline_rounded,
      'research' => Icons.travel_explore_rounded,
      'learning' || 'ml learning' => Icons.school_outlined,
      'knowledge' => Icons.menu_book_outlined,
      'suggestion' => Icons.lightbulb_outline_rounded,
      'translation' => Icons.translate_rounded,
      _ => Icons.bookmark_outline_rounded,
    };

class _MemoryCallout extends StatelessWidget {
  const _MemoryCallout({required this.node, required this.anchor, required this.area, required this.onOpen});

  final CheBrainNode node;
  final Offset anchor;
  final Size area;
  final VoidCallback onOpen;

  static const double _w = 248, _h = 64;

  @override
  Widget build(BuildContext context) {
    final color = cheMemoryCategoryColor(node.dot.category);
    final right = anchor.dx + 36 + _w <= area.width - 8;
    final left = (right ? anchor.dx + 36 : anchor.dx - 36 - _w).clamp(8.0, math.max(8.0, area.width - _w - 8)).toDouble();
    final top = (anchor.dy - 70 - _h / 2).clamp(56.0, math.max(56.0, area.height - _h - 8)).toDouble();
    final at = node.dot.at;
    final joint = Offset(right ? left : left + _w, top + _h / 2);
    return Stack(children: [
      IgnorePointer(child: CustomPaint(size: area, painter: _LeaderLine(anchor, joint, color))),
      Positioned(
        left: left,
        top: top,
        width: _w,
        child: Semantics(
          button: true,
          label: '${node.dot.title}. ${at == null ? '' : cheMemoryWhen(at)}. Open this memory.',
          excludeSemantics: true,
          child: GestureDetector(
            onTap: onOpen,
            child: cheBrainPanel(
              radius: 16,
              fill: const Color(0xE6061614),
              edge: color,
              edgeAlpha: .7,
              edgeWidth: 1.2,
              shadowAlpha: .25,
              shadowBlur: 18,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                child: Row(children: [
                  Icon(cheMemoryIcon(node.dot.category), color: color, size: 24),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(node.dot.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
                      if (at != null)
                        Text(cheMemoryWhen(at), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Color(0xFFA9B8B6), fontSize: 12.5)),
                    ]),
                  ),
                  const Icon(Icons.chevron_right_rounded, color: Color(0xFFA9B8B6)),
                ]),
              ),
            ),
          ),
        ),
      ),
    ]);
  }
}

class _LeaderLine extends CustomPainter {
  _LeaderLine(this.from, this.to, this.color);
  final Offset from, to;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawLine(from, to, Paint()
      ..color = Colors.white.withValues(alpha: .85)
      ..strokeWidth = 1.4);
    canvas.drawCircle(to, 3, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_LeaderLine old) => old.from != from || old.to != to || old.color != color;
}

/// The readable card for one memory; surrounding memories stay visible.
class _MemoryCard extends StatelessWidget {
  const _MemoryCard({required this.controller, required this.node, required this.onSpeak, this.onOpenAgent, this.side = false});

  final CheBrainSpaceController controller;
  final CheBrainNode node;
  final void Function(String) onSpeak;

  /// Deep link for live agent orbs; shown only on Agents cards when set.
  final void Function(String agentName)? onOpenAgent;

  /// Laid out as a side panel (wide screens) instead of a bottom sheet.
  final bool side;

  @override
  Widget build(BuildContext context) {
    final dot = node.dot;
    final color = cheMemoryCategoryColor(dot.category);
    final related = controller.layout.related(node, limit: 5);
    final cluster = controller.layout.clusters[node.cluster];
    final maxHeight = side ? MediaQuery.sizeOf(context).height - 80 : MediaQuery.sizeOf(context).height * .42;
    final at = dot.at?.toLocal();
    final verification = cheBrainVerificationLabel(dot.verification);
    // Every state is words and an icon, never a color alone.
    final facts = <(IconData, String)>[
      (verification.$2, verification.$1),
      if (dot.workers.isNotEmpty) (Icons.badge_outlined, dot.workers.length == 1 ? 'Worker · ${dot.workers.first}' : 'Workers · ${dot.workers.join(', ')}'),
      if (dot.region.isNotEmpty) (Icons.folder_outlined, 'Folder · ${dot.region}${dot.path.isNotEmpty ? ' / ${dot.path}' : ''}'),
      if (dot.outcome.isNotEmpty) (dot.outcome == 'failed' ? Icons.error_outline_rounded : dot.outcome == 'done' ? Icons.task_alt_rounded : Icons.timelapse_rounded, 'Status · ${dot.status}${dot.outcome == 'live' ? ' (still live, not finished)' : ''}'),
      if (dot.project.isNotEmpty) (Icons.account_tree_outlined, 'Project · ${dot.project}'),
      (dot.isPersonal ? Icons.lock_outline_rounded : Icons.groups_outlined, dot.isPersonal ? 'Personal memory' : 'Shared Office knowledge'),
      if (dot.archived) (Icons.inventory_2_outlined, 'Archived'),
      (Icons.source_outlined, 'Source · ${dot.source}'),
      if (at != null) (Icons.schedule_rounded, 'Saved · ${cheMemoryWhen(at)}'),
      if (dot.confidence != null) (Icons.percent_rounded, 'Confidence · ${(dot.confidence! * 100).round()}%'),
    ];
    return Semantics(
      container: true,
      label: 'Memory card: ${dot.title}. ${dot.category}. ${verification.$1}.',
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: cheBrainPanel(
          radius: 18,
          fill: const Color(0xEE071012),
          edge: color,
          edgeAlpha: .55,
          shadowAlpha: .22,
          shadowBlur: 24,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              Row(children: [
                Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: color)),
                const SizedBox(width: 6),
                Icon(cheMemoryIcon(dot.category), size: 14, color: color),
                const SizedBox(width: 4),
                Expanded(child: Text(dot.category, style: CheType.caption.copyWith(color: color, fontWeight: FontWeight.w700))),
                IconButton(
                  tooltip: 'Close memory',
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.close_rounded, size: 20),
                  onPressed: controller.closeCard,
                ),
              ]),
              Semantics(header: true, child: Text(dot.title, style: CheType.label.copyWith(color: Colors.white, fontSize: 16))),
              Wrap(spacing: 6, children: [
                TextButton.icon(
                  onPressed: () => onSpeak('${dot.title}. ${dot.body}'),
                  icon: const Icon(Icons.volume_up_rounded, size: 18),
                  label: const Text('Read aloud'),
                ),
                TextButton.icon(
                  onPressed: () => onSpeak(controller.centerOnSelected()),
                  icon: const Icon(Icons.center_focus_weak_rounded, size: 18),
                  label: const Text('Center on this'),
                ),
                for (final worker in dot.workers)
                  if (controller.scope != worker && controller.worker(worker) != null)
                    TextButton.icon(
                      onPressed: () => onSpeak(controller.setScope(worker)),
                      icon: const Icon(Icons.hub_outlined, size: 18),
                      label: Text("Open $worker's brain"),
                    ),
                if (dot.category == 'Agents' && onOpenAgent != null)
                  TextButton.icon(
                    onPressed: () => onOpenAgent!(dot.workers.isNotEmpty ? dot.workers.first : dot.source),
                    icon: const Icon(Icons.business_center_rounded, size: 18),
                    label: Text('Open ${dot.workers.isNotEmpty ? dot.workers.first : dot.source} in Office'),
                  ),
                if (cluster != null)
                  TextButton.icon(
                    onPressed: () => onSpeak(controller.toggleCluster(cluster.name, expand: false)),
                    icon: const Icon(Icons.unfold_less_rounded, size: 18),
                    label: Text('Collapse ${cluster.name}'),
                  ),
              ]),
              const SizedBox(height: 6),
              Text(dot.body, style: CheType.body.copyWith(fontSize: 14, height: 1.35)),
              const SizedBox(height: 8),
              for (final (icon, text) in facts)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(icon, size: 13, color: CheColors.textDim),
                    const SizedBox(width: 6),
                    Expanded(child: Text(text, style: CheType.caption.copyWith(fontSize: 11))),
                  ]),
                ),
              if (related.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Related', style: CheType.caption.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final r in related)
                    ActionChip(
                      visualDensity: VisualDensity.compact,
                      avatar: Icon(cheMemoryIcon(r.dot.category), size: 14, color: cheMemoryCategoryColor(r.dot.category)),
                      label: Text(r.dot.title, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                      tooltip: 'Go to related memory ${r.dot.title}, ${r.dot.category}',
                      onPressed: () => onSpeak(controller.select(r)),
                    ),
                ]),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

/// Batched painter for the whole space.
class CheBrainPainter extends CustomPainter {
  CheBrainPainter(this.c, {this.textScale = 1}) : super(repaint: c.frame);

  final CheBrainSpaceController c;

  static ui.Image? _glow;

  /// Brain-shaped backdrop: fine dust along the brain's surface and distant
  /// soft lights. Scenery only — never memories, never tappable or counted.
  static final List<vm.Vector3> _dust = () {
    final rng = math.Random(11);
    final out = <vm.Vector3>[];
    for (var k = 0; k < 60000 && out.length < 1400; k++) {
      final p = vm.Vector3(rng.nextDouble() * 18 - 9, rng.nextDouble() * 16 - 9, rng.nextDouble() * 10 - 5);
      final f = cheBrainShape(p);
      if (f > .78 && f < 1) out.add(p);
    }
    return out;
  }();
  static final List<vm.Vector3> _bokeh = () {
    final rng = math.Random(23);
    return [
      for (var k = 0; k < 90; k++)
        (vm.Vector3(rng.nextDouble() * 2 - 1, rng.nextDouble() * 2 - 1, rng.nextDouble() * 2 - 1)..normalize()) * (16 + rng.nextDouble() * 22),
    ];
  }();
  static ui.Image? _glowSprite() {
    if (_glow != null) return _glow;
    try {
      // Two 64px cells, tinted per category when drawn:
      //  [0..64)   the orb body: a glowing glass sphere lit from the top-left
      //            (bright core, coloured body, darker rim, rim light);
      //  [64..128) the light layer (wide soft glow + specular), added on top.
      const s = 64.0;
      const c = Offset(s / 2, s / 2);
      const r = s * .24;
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      canvas.drawCircle(c, r, Paint()
        ..shader = ui.Gradient.radial(c, r, const [Color(0xFFFFFFFF), Color(0xFFD8D8D8), Color(0xFF8A8A8A), Color(0xFF3C3C3C)],
            const [0, .3, .78, 1], TileMode.clamp, null, c + const Offset(-r * .35, -r * .4), r * .1));
      canvas.drawArc(Rect.fromCircle(center: c, radius: r - .9), .2, 1.4, false, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = const Color(0x99FFFFFF));
      const g = Offset(s * 1.5, s / 2);
      canvas.drawCircle(g, s / 2, Paint()
        ..shader = ui.Gradient.radial(g, s / 2, const [Color(0x48FFFFFF), Color(0x22FFFFFF), Color(0x08FFFFFF), Color(0x00FFFFFF)], const [0, .30, .60, 1]));
      final spec = g + const Offset(-r * .36, -r * .42);
      canvas.drawCircle(spec, r * .32, Paint()
        ..shader = ui.Gradient.radial(spec, r * .32, const [Color(0xFFFFFFFF), Color(0x00FFFFFF)]));
      _glow = recorder.endRecording().toImageSync(s.toInt() * 2, s.toInt());
    } catch (_) {
      _glow = null;
    }
    return _glow;
  }

  /// Label size follows the owner's text setting (capped so labels stay tidy).
  final double textScale;

  TextPainter _label(String key, String text, double size, Color color) => c.label(key, text, (size * textScale).roundToDouble(), color);

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final cam = c.camera;
    // Deep space with a faint teal core. In HUD glass the space is clear: the navy HUD backdrop behind the room is the
    // space, and the brain floats in it.
    if (!cheHudActive) canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF020506));
    final core = cam.project(vm.Vector3.zero(), size, worldRadius: 8, margin: 400);
    if (core != null) {
      canvas.drawCircle(core.offset, math.min(core.radius * 1.4, size.longestSide), Paint()
        ..shader = ui.Gradient.radial(core.offset, math.max(1, math.min(core.radius * 1.4, size.longestSide)), const [Color(0x2239E6C5), Color(0x00000000)]));
    }

    final far = <double>[], dust = <double>[];
    for (final b in _bokeh) {
      final p = cam.project(b, size, worldRadius: .5);
      if (p != null) far.addAll([p.offset.dx, p.offset.dy]);
    }
    for (final d in _dust) {
      final p = cam.project(d, size, worldRadius: .05);
      if (p != null) dust.addAll([p.offset.dx, p.offset.dy]);
    }
    // The blurred bokeh is the one costly pass of the backdrop; economy skips it.
    if (!c.economy) {
      canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(far), Paint()
        ..color = const Color(0x3352E8B0)
        ..strokeWidth = 7
        ..strokeCap = StrokeCap.round
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3));
    }
    canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(dust), Paint()
      ..color = const Color(0x8062E3F0)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round);

    final layout = c.layout;
    final n = layout.nodes.length;
    final proj = List<CheProjected?>.filled(n, null);
    for (var i = 0; i < n; i++) {
      final node = layout.nodes[i];
      if (!c.shows(node)) continue;
      proj[i] = cam.project(c.livePosition(i), size, worldRadius: node.size);
    }

    // Edges: batched into faint / strong line lists; edges of the selected
    // memory pulse with a travelling spark.
    // Not selected, links are drawn by their real strength: verified (a recorded relationship between two
    // verified records), developing (recorded, one side unverified) and weak (shared words only).
    final faint = <double>[], developing = <double>[], verifiedLinks = <double>[], strong = <double>[], sparks = <double>[];
    final selIndex = c.selectedId == null ? -1 : (layout.byId[c.selectedId!] ?? -1);
    for (var k = 0; k < layout.edges.length; k++) {
      final e = layout.edges[k];
      final a = proj[e.$1], b = proj[e.$2];
      if (a == null || b == null) continue;
      final hot = e.$1 == selIndex || e.$2 == selIndex;
      (hot
              ? strong
              : switch (layout.edgeStrength[k]) {
                  CheBrainLinkStrength.verified => verifiedLinks,
                  CheBrainLinkStrength.developing => developing,
                  CheBrainLinkStrength.weak => faint,
                })
        ..add(a.offset.dx)
        ..add(a.offset.dy)
        ..add(b.offset.dx)
        ..add(b.offset.dy);
      if (hot) {
        final t = (c.time * .6 + (e.$1 + e.$2) * .13) % 1.0;
        final from = e.$1 == selIndex ? a.offset : b.offset;
        final to = e.$1 == selIndex ? b.offset : a.offset;
        final p = Offset.lerp(from, to, t)!;
        sparks
          ..add(p.dx)
          ..add(p.dy);
      }
    }
    if (faint.isNotEmpty) {
      canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(faint), Paint()
        ..color = const Color(0x2E8FA8FF)
        ..strokeWidth = .6);
    }
    if (developing.isNotEmpty) {
      canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(developing), Paint()
        ..color = const Color(0x66B98BFF)
        ..strokeWidth = .9);
    }
    if (verifiedLinks.isNotEmpty) {
      canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(verifiedLinks), Paint()
        ..color = const Color(0x9922E4F2)
        ..strokeWidth = 1.2
        ..blendMode = BlendMode.plus);
    }
    if (strong.isNotEmpty) {
      canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(strong), Paint()
        ..color = const Color(0xAA9FFFF0)
        ..strokeWidth = 1.4);
      canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(sparks), Paint()
        ..color = Colors.white
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round);
    }

    // Neural signals: a bright head with a short trail along the link.
    if (c.pulses.isNotEmpty) {
      final trails = <double>[], heads = <double>[];
      for (final pulse in c.pulses) {
        final a = proj[pulse.from], b = proj[pulse.to];
        if (a == null || b == null) continue;
        final head = Offset.lerp(a.offset, b.offset, pulse.t)!;
        final tail = Offset.lerp(a.offset, b.offset, math.max(0, pulse.t - .14))!;
        trails.addAll([tail.dx, tail.dy, head.dx, head.dy]);
        heads.addAll([head.dx, head.dy]);
      }
      if (heads.isNotEmpty) {
        canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(trails), Paint()
          ..color = const Color(0x8CBFFFF4)
          ..strokeWidth = 1.8
          ..strokeCap = StrokeCap.round);
        canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(heads), Paint()
          ..color = const Color(0xFFEFFFFC)
          ..strokeWidth = 3.6
          ..strokeCap = StrokeCap.round
          ..blendMode = BlendMode.plus);
      }
    }

    // Nodes far → near, one atlas draw.
    final order = [for (var i = 0; i < n; i++) if (proj[i] != null) i]..sort((x, y) => proj[y]!.depth.compareTo(proj[x]!.depth));
    final sprite = _glowSprite();
    final transforms = Float32List(order.length * 4);
    final rects = Float32List(order.length * 4);
    final lightRects = Float32List(order.length * 4);
    final colors = Int32List(order.length);
    final lightColors = Int32List(order.length);
    for (var k = 0; k < order.length; k++) {
      final i = order[k];
      final p = proj[i]!;
      final node = layout.nodes[i];
      final breathe = 1 + math.sin(c.time * 1.4 + i * .7) * .06;
      final presence = 1 + math.min(node.degree, 8) * .05;
      final fire = c.flash(i);
      final radius = (math.max(p.radius, 1.4) * 1.45 * breathe * presence * (1 + math.max(fire, c.regionGlow(node.region)) * .45) * c.birthScale(node.id)).clamp(0.0, 64.0);
      final depthFade = (1.0 - (p.depth - 4) / 60).clamp(.25, 1.0);
      // The owner's colour key (che_brain_regions.dart); a real learning event lights its region up.
      final glow = math.max(fire, c.regionGlow(node.region));
      final base = node.region.color;
      final color = (glow > .02 ? Color.lerp(base, Colors.white, glow * .5)! : base).withValues(alpha: (i == selIndex ? 1.0 : .82) * depthFade);
      final scale = radius * 2 / 64;
      transforms
        ..[k * 4] = scale
        ..[k * 4 + 1] = 0
        ..[k * 4 + 2] = p.offset.dx - 32 * scale
        ..[k * 4 + 3] = p.offset.dy - 32 * scale;
      rects
        ..[k * 4] = 0
        ..[k * 4 + 1] = 0
        ..[k * 4 + 2] = 64
        ..[k * 4 + 3] = 64;
      lightRects
        ..[k * 4] = 64
        ..[k * 4 + 1] = 0
        ..[k * 4 + 2] = 128
        ..[k * 4 + 3] = 64;
      colors[k] = color.toARGB32();
      // Verified records carry a white core (white = verified in the owner's key).
      lightColors[k] = Color.lerp(color, Colors.white, node.verified ? .85 : .55)!.withValues(alpha: color.a).toARGB32();
      if (sprite == null) canvas.drawCircle(p.offset, radius * .4, Paint()..color = color);
    }
    if (sprite != null && order.isNotEmpty) {
      // Body alpha-blended (so shading can darken), light layer added on top.
      canvas.drawRawAtlas(sprite, transforms, rects, colors, BlendMode.modulate, null, Paint());
      canvas.drawRawAtlas(sprite, transforms, lightRects, lightColors, BlendMode.modulate, null, Paint()..blendMode = BlendMode.plus);
    }

    // Selection ring.
    if (selIndex >= 0 && proj[selIndex] != null) {
      final p = proj[selIndex]!;
      final r = math.max(p.radius * 3.2, 14.0) * (1 + math.sin(c.time * 3) * .06);
      canvas.drawCircle(p.offset, r * 1.15, Paint()
        ..shader = ui.Gradient.radial(p.offset, r * 1.15, const [Color(0x553EE6C9), Color(0x003EE6C9)]));
      canvas.drawCircle(p.offset, r, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.8
        ..color = const Color(0xDD7FFFE8));
      canvas.drawCircle(p.offset, r * .62, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = const Color(0x997FFFE8));
    }

    // Collapsed clusters: one orb with its name and count.
    for (final cl in layout.clusters.values) {
      if (!c.clusterShown(cl)) continue;
      final p = cam.project(cl.center, size, worldRadius: CheBrainSpaceController._clusterRadius(cl));
      if (p == null) continue;
      final color = cheMemoryCategoryColor(cl.name);
      final r = math.max(p.radius, 14.0);
      canvas.drawCircle(p.offset, r * 1.6, Paint()..shader = ui.Gradient.radial(p.offset, r * 1.6, [color.withValues(alpha: .55), color.withValues(alpha: 0)]));
      canvas.drawCircle(p.offset, r, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = color.withValues(alpha: .9));
      final tp = _label('cluster:${cl.name}', '${cl.name} · ${c.clusterCount(cl)}', 12, Colors.white);
      tp.paint(canvas, p.offset + Offset(-tp.width / 2, r + 4));
    }

    // The Office around CHE (CHE's view only): one orb per internal worker on
    // the ring, in the same style as a collapsed lobe, in the Agents color the
    // brain already uses for specialist work. Lines are real connections: each
    // worker to CHE at the center, and workers who share records to each other.
    if (c.scope == null && c.workers.isNotEmpty) {
      final core = cam.project(vm.Vector3.zero(), size, worldRadius: 0, margin: 2000);
      final projected = <String, CheProjected>{};
      for (final w in c.workers) {
        final p = cam.project(w.position, size, worldRadius: w.radius, margin: 400);
        if (p != null) projected[w.name] = p;
      }
      final spokes = <double>[], ties = <double>[];
      for (final w in c.workers) {
        final p = projected[w.name];
        if (p == null) continue;
        if (core != null) spokes.addAll([p.offset.dx, p.offset.dy, core.offset.dx, core.offset.dy]);
        for (final other in w.collaborators) {
          if (w.name.compareTo(other) >= 0) continue;
          final q = projected[other];
          if (q != null) ties.addAll([p.offset.dx, p.offset.dy, q.offset.dx, q.offset.dy]);
        }
      }
      if (spokes.isNotEmpty) {
        canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(spokes), Paint()
          ..color = const Color(0x3362E3F0)
          ..strokeWidth = .8);
      }
      if (ties.isNotEmpty) {
        canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(ties), Paint()
          ..color = const Color(0x7AFFB54D)
          ..strokeWidth = 1.1);
      }
      final color = cheMemoryCategoryColor('Agents');
      for (final w in c.workers) {
        final p = projected[w.name];
        if (p == null) continue;
        final r = math.max(p.radius, 13.0);
        final dim = w.records == 0 ? .45 : 1.0;
        canvas.drawCircle(p.offset, r * 1.7, Paint()..shader = ui.Gradient.radial(p.offset, r * 1.7, [color.withValues(alpha: .5 * dim), color.withValues(alpha: 0)]));
        canvas.drawCircle(p.offset, r, Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..color = color.withValues(alpha: .9 * dim));
        if (w.state == 'working') {
          canvas.drawCircle(p.offset, r * .55 * (1 + math.sin(c.time * 2.2) * .08), Paint()..color = color.withValues(alpha: .35));
        }
        final tp = _label('worker:${w.name}', '${w.name} · ${w.records}', 12, Colors.white.withValues(alpha: .6 + .4 * dim));
        tp.paint(canvas, p.offset + Offset(-tp.width / 2, r + 4));
      }
      if (cam.distance > 14) {
        final under = cam.project(vm.Vector3(0, -9.6, 0), size);
        if (under != null) {
          final tp = _label('core:che', 'CHE · ${layout.nodes.length}', 12, CheColors.accent.withValues(alpha: .9));
          tp.paint(canvas, under.offset - Offset(tp.width / 2, 0));
        }
      }
    }

    // Labels (level of detail): the selected memory, plus the nearest large
    // orbs when the camera is close; cluster names in the overview.
    final labelled = <int>[if (selIndex >= 0 && proj[selIndex] != null) selIndex];
    for (final i in order.reversed) {
      if (labelled.length >= (c.economy ? 3 : 7)) break;
      // Memory names only once the owner has moved in; the overview shows
      // lobe names instead, so labels never pile up.
      if (i != selIndex && cam.distance < 14 && proj[i]!.radius > 5) labelled.add(i);
    }
    for (final i in labelled) {
      final p = proj[i]!;
      final node = layout.nodes[i];
      final tp = _label(node.id, node.dot.title, i == selIndex ? 14 : 11, i == selIndex ? Colors.white : const Color(0xCCFFFFFF));
      tp.paint(canvas, p.offset + Offset(-tp.width / 2, math.max(p.radius * 2.4, 8) + 4));
    }
    if (cam.distance > 14) {
      for (final cl in layout.clusters.values) {
        if (!cl.expanded || (c.filter.isNotEmpty && !c.filter.contains(cl.name)) || c.clusterCount(cl) == 0) continue;
        final p = cam.project(cl.center + vm.Vector3(0, 4.6, 0), size);
        if (p == null) continue;
        final tp = _label('lobe:${cl.name}', cl.name, 11, cheMemoryCategoryColor(cl.name).withValues(alpha: .9));
        tp.paint(canvas, p.offset - Offset(tp.width / 2, 0));
      }
    }
  }

  @override
  bool shouldRepaint(covariant CheBrainPainter old) => !identical(old.c, c);
}

/// One signal travelling from memory [from] to memory [to] (layout indices).
class CheNeuralPulse {
  CheNeuralPulse(this.from, this.to, this.speed);

  final int from;
  final int to;

  /// Fraction of the link travelled per second.
  final double speed;
  double t = 0;
}
