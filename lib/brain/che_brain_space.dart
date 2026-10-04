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

import '../che_ui/che_theme.dart';
import '../home/che_memory_brain.dart' show CheMemoryDot, cheMemoryCategoryColor;
import 'che_brain_space_model.dart';

/// Drives the Brain space: selection, camera flights, clusters, filters.
class CheBrainSpaceController {
  CheBrainSpaceController(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const []})
      : layout = CheBrainLayout.build(dots, brainLinks: brainLinks) {
    _wire();
  }

  /// The Brain room on screen right now (voice commands reach it here).
  static CheBrainSpaceController? current;

  CheBrainLayout layout;
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
    final k = '$key|$size';
    final hit = labels.remove(k);
    if (hit != null) return labels[k] = hit;
    if (labels.length >= 240) labels.remove(labels.keys.first)?.dispose();
    return labels[k] = TextPainter(
      text: TextSpan(text: text, style: TextStyle(fontSize: size, color: color, fontWeight: FontWeight.w600, shadows: const [Shadow(blurRadius: 6)])),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: 200);
  }

  CheBrainNode? get selected => selectedId == null ? null : layout.node(selectedId!);
  bool get flying => _flyT < 1;

  void update(List<CheMemoryDot> dots, List<Map<String, dynamic>> brainLinks) {
    final before = {for (final n in layout.nodes) n.id};
    final moved = {for (final n in layout.nodes) if (n.moved != null) n.id: n.moved!};
    final expanded = {for (final c in layout.clusters.values) c.name: c.expanded};
    layout = CheBrainLayout.build(dots, brainLinks: brainLinks);
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
  bool tick(double dt) {
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
    _repaint();
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
    cardOpen = false;
    flyTo(CheBrainCamera(yaw: math.pi, pitch: .08));
    _changed();
    return 'Showing the whole brain: ${layout.nodes.length} memories in ${layout.clusters.length} clusters.';
  }

  String inside() {
    cardOpen = false;
    flyTo(CheBrainCamera(yaw: camera.yaw, pitch: 0, distance: 0));
    _changed();
    return 'You are at the center of my brain. Memories surround you; drag to look around.';
  }

  String backOut() {
    final d = camera.distance;
    final next = d < 2 ? 9.0 : d < 12 ? 20.0 : CheBrainCamera.overview;
    cardOpen = false;
    flyTo(CheBrainCamera(target: d >= 12 ? vm.Vector3.zero() : camera.target.clone(), yaw: camera.yaw, pitch: camera.pitch, distance: next));
    _changed();
    return next >= CheBrainCamera.overview ? overview() : 'Backing out.';
  }

  String setFilter(String? category) {
    filter
      ..clear()
      ..addAll([?category]);
    if (category != null) {
      final c = layout.clusters[category];
      if (c == null) {
        _changed();
        return 'There are no $category memories yet.';
      }
      c.expanded = true;
      flyTo(CheBrainCamera(target: c.center.clone(), yaw: math.atan2(-c.center.x, c.center.z), pitch: .15, distance: 11));
      _changed();
      return 'Showing your $category memories: ${c.members.length}.';
    }
    _changed();
    return 'Showing all ${layout.nodes.length} memories.';
  }

  String toggleCluster(String name, {bool? expand}) {
    final c = layout.clusters[name];
    if (c == null) return 'There is no $name cluster.';
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

  /// Cluster the owner last reached (VoiceOver step, tap, filter).
  String? focusedCluster;

  String focusCluster(CheBrainCluster cl) {
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
        if (!cl.expanded && (filter.isEmpty || filter.contains(cl.name))) cl,
    ];
    final nodes = [
      for (final n in layout.nodes)
        if (layout.visible(n, filter)) n,
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
        CheBrainAction.clearFilter => setFilter(null),
        CheBrainAction.find => find(command.query ?? ''),
        CheBrainAction.openSelected => openSelected(),
        CheBrainAction.expand => _targetCluster == null ? 'Every cluster is already open.' : toggleCluster(_targetCluster!, expand: true),
        CheBrainAction.collapse => _targetCluster == null ? 'No cluster is selected.' : toggleCluster(_targetCluster!, expand: false),
      };

  // ─── Hit testing ───────────────────────────────────────────────────────

  /// The orb or collapsed cluster under a screen point (nearest wins).
  ({CheBrainNode? node, CheBrainCluster? cluster}) hit(Offset at, Size size) {
    // A collapsed cluster is a big, labelled target: a tap inside its orb
    // always means the cluster.
    for (final c in layout.clusters.values) {
      if (c.expanded || (filter.isNotEmpty && !filter.contains(c.name))) continue;
      final p = camera.project(c.center, size, worldRadius: _clusterRadius(c));
      if (p != null && (p.offset - at).distance <= math.max(p.radius, 26)) return (node: null, cluster: c);
    }
    CheBrainNode? best;
    var bestDepth = double.infinity;
    for (var i = 0; i < layout.nodes.length; i++) {
      final n = layout.nodes[i];
      if (!layout.visible(n, filter)) continue;
      final p = camera.project(livePosition(i), size, worldRadius: n.size);
      if (p == null) continue;
      if ((p.offset - at).distance <= math.max(p.radius * 1.6, 18) && p.depth < bestDepth) {
        best = n;
        bestDepth = p.depth;
      }
    }
    return (node: best, cluster: null);
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
  });

  final CheBrainSpaceController controller;

  /// Says what was selected (CHE's voice).
  final void Function(String text)? onSpeak;
  final bool active;

  /// Keeps the memory card above controls the parent floats at the bottom.
  final double cardBottomInset;

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
    if (!c.tick(dt.clamp(0, .05).toDouble())) _ticker.stop();
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
                label: 'CHE brain space: ${c.layout.nodes.length} real memories in ${c.layout.clusters.length} clusters. '
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
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: const Color(0xCC071012), borderRadius: BorderRadius.circular(14)),
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
            return Positioned(
              left: 12,
              right: 12,
              bottom: 12 + widget.cardBottomInset,
              child: _MemoryCard(controller: c, node: sel, onSpeak: _say),
            );
          },
        ),
      ]);
    });
  }
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
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xE6061614),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: color.withValues(alpha: .7), width: 1.2),
                boxShadow: [BoxShadow(color: color.withValues(alpha: .25), blurRadius: 18)],
              ),
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
  const _MemoryCard({required this.controller, required this.node, required this.onSpeak});

  final CheBrainSpaceController controller;
  final CheBrainNode node;
  final void Function(String) onSpeak;

  @override
  Widget build(BuildContext context) {
    final color = cheMemoryCategoryColor(node.dot.category);
    final related = controller.layout.related(node, limit: 5);
    final cluster = controller.layout.clusters[node.cluster];
    final maxHeight = MediaQuery.sizeOf(context).height * .42;
    final at = node.dot.at?.toLocal();
    return Semantics(
      container: true,
      label: 'Memory card',
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: const Color(0xEE071012),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: color.withValues(alpha: .55)),
            boxShadow: [BoxShadow(color: color.withValues(alpha: .22), blurRadius: 24)],
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              Row(children: [
                Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: color)),
                const SizedBox(width: 6),
                Expanded(child: Text(node.dot.category, style: CheType.caption.copyWith(color: color, fontWeight: FontWeight.w700))),
                IconButton(
                  tooltip: 'Close memory',
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.close_rounded, size: 20),
                  onPressed: controller.closeCard,
                ),
              ]),
              Semantics(header: true, child: Text(node.dot.title, style: CheType.label.copyWith(color: Colors.white, fontSize: 16))),
              Wrap(spacing: 6, children: [
                TextButton.icon(
                  onPressed: () => onSpeak('${node.dot.title}. ${node.dot.body}'),
                  icon: const Icon(Icons.volume_up_rounded, size: 18),
                  label: const Text('Read aloud'),
                ),
                if (cluster != null)
                  TextButton.icon(
                    onPressed: () => onSpeak(controller.toggleCluster(cluster.name, expand: false)),
                    icon: const Icon(Icons.unfold_less_rounded, size: 18),
                    label: Text('Collapse ${cluster.name}'),
                  ),
              ]),
              const SizedBox(height: 6),
              Text(node.dot.body, style: CheType.body.copyWith(fontSize: 14, height: 1.35)),
              const SizedBox(height: 8),
              Text(
                [
                  'Source · ${node.dot.source}',
                  if (at != null) 'Saved · ${at.month}/${at.day}/${at.year}',
                  if (node.dot.confidence != null) 'Confidence · ${(node.dot.confidence! * 100).round()}%',
                ].join('   '),
                style: CheType.caption.copyWith(fontSize: 11),
              ),
              if (related.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Related', style: CheType.caption.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final r in related)
                    ActionChip(
                      visualDensity: VisualDensity.compact,
                      label: Text(r.dot.title, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                      tooltip: 'Go to related memory ${r.dot.title}',
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
    // Deep space with a faint teal core.
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF020506));
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
    canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(far), Paint()
      ..color = const Color(0x3352E8B0)
      ..strokeWidth = 7
      ..strokeCap = StrokeCap.round
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3));
    canvas.drawRawPoints(ui.PointMode.points, Float32List.fromList(dust), Paint()
      ..color = const Color(0x8062E3F0)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round);

    final layout = c.layout;
    final n = layout.nodes.length;
    final proj = List<CheProjected?>.filled(n, null);
    for (var i = 0; i < n; i++) {
      final node = layout.nodes[i];
      if (!layout.visible(node, c.filter)) continue;
      proj[i] = cam.project(c.livePosition(i), size, worldRadius: node.size);
    }

    // Edges: batched into faint / strong line lists; edges of the selected
    // memory pulse with a travelling spark.
    final faint = <double>[], strong = <double>[], sparks = <double>[];
    final selIndex = c.selectedId == null ? -1 : (layout.byId[c.selectedId!] ?? -1);
    for (final e in layout.edges) {
      final a = proj[e.$1], b = proj[e.$2];
      if (a == null || b == null) continue;
      final hot = e.$1 == selIndex || e.$2 == selIndex;
      (hot ? strong : faint)
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
        ..color = const Color(0x4A62E3F0)
        ..strokeWidth = .7);
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
      final radius = (math.max(p.radius, 1.4) * 1.45 * breathe * presence * (1 + fire * .45) * c.birthScale(node.id)).clamp(0.0, 64.0);
      final depthFade = (1.0 - (p.depth - 4) / 60).clamp(.25, 1.0);
      final base = cheMemoryCategoryColor(node.dot.category);
      final color = (fire > .02 ? Color.lerp(base, Colors.white, fire * .5)! : base).withValues(alpha: (i == selIndex ? 1.0 : .82) * depthFade);
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
      lightColors[k] = Color.lerp(color, Colors.white, .55)!.withValues(alpha: color.a).toARGB32();
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
      if (cl.expanded || (c.filter.isNotEmpty && !c.filter.contains(cl.name))) continue;
      final p = cam.project(cl.center, size, worldRadius: CheBrainSpaceController._clusterRadius(cl));
      if (p == null) continue;
      final color = cheMemoryCategoryColor(cl.name);
      final r = math.max(p.radius, 14.0);
      canvas.drawCircle(p.offset, r * 1.6, Paint()..shader = ui.Gradient.radial(p.offset, r * 1.6, [color.withValues(alpha: .55), color.withValues(alpha: 0)]));
      canvas.drawCircle(p.offset, r, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = color.withValues(alpha: .9));
      final tp = _label('cluster:${cl.name}', '${cl.name} · ${cl.members.length}', 12, Colors.white);
      tp.paint(canvas, p.offset + Offset(-tp.width / 2, r + 4));
    }

    // Labels (level of detail): the selected memory, plus the nearest large
    // orbs when the camera is close; cluster names in the overview.
    final labelled = <int>[if (selIndex >= 0 && proj[selIndex] != null) selIndex];
    for (final i in order.reversed) {
      if (labelled.length >= 7) break;
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
        if (!cl.expanded || (c.filter.isNotEmpty && !c.filter.contains(cl.name))) continue;
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
