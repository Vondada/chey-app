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

import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

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
      : layout = CheBrainLayout.build(dots, brainLinks: brainLinks);

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

  CheBrainCamera? _flyFrom;
  CheBrainCamera? _flyTo;
  double _flyT = 1;
  double _spinX = 0, _spinY = 0;

  CheBrainNode? get selected => selectedId == null ? null : layout.node(selectedId!);
  bool get flying => _flyT < 1;

  void update(List<CheMemoryDot> dots, List<Map<String, dynamic>> brainLinks) {
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
    _changed();
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
      _spinX *= .9;
      _spinY *= .9;
      moving = true;
    }
    _repaint();
    return moving;
  }

  void flyTo(CheBrainCamera to) {
    _spinX = _spinY = 0;
    _flyFrom = camera.copy();
    _flyTo = to;
    _flyT = 0;
  }

  void fling(double vx, double vy) {
    _spinX = vx;
    _spinY = vy;
  }

  void stop() {
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
    flyTo(CheBrainCamera(yaw: camera.yaw, pitch: .25));
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
      flyTo(CheBrainCamera(target: c.center.clone(), yaw: math.atan2(c.center.x, -c.center.z), pitch: .15, distance: 11));
      _changed();
      return 'Showing your $category memories: ${c.members.length}.';
    }
    _changed();
    return 'Showing all ${layout.nodes.length} memories.';
  }

  String toggleCluster(String name, {bool? expand}) {
    final c = layout.clusters[name];
    if (c == null) return 'There is no $name cluster.';
    c.expanded = expand ?? !c.expanded;
    if (c.expanded) flyTo(CheBrainCamera(target: c.center.clone(), yaw: math.atan2(c.center.x, -c.center.z), pitch: .15, distance: 9));
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

  /// Next/previous memory for VoiceOver users (most important first).
  String step(int delta) {
    final order = [
      for (final n in layout.nodes)
        if (layout.visible(n, filter)) n,
    ]..sort((a, b) => b.dot.importance.compareTo(a.dot.importance) != 0 ? b.dot.importance.compareTo(a.dot.importance) : a.id.compareTo(b.id));
    if (order.isEmpty) return 'No memories are visible.';
    final i = order.indexWhere((n) => n.id == selectedId);
    final next = order[((i < 0 ? (delta > 0 ? -1 : 0) : i) + delta) % order.length];
    return select(next);
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
        CheBrainAction.expand => selected == null
            ? 'Select a memory or say "show my research memories" first.'
            : toggleCluster(selected!.cluster, expand: true),
        CheBrainAction.collapse => selected == null ? 'No cluster is selected.' : toggleCluster(selected!.cluster, expand: false),
      };

  // ─── Hit testing ───────────────────────────────────────────────────────

  /// The orb or collapsed cluster under a screen point (nearest wins).
  ({CheBrainNode? node, CheBrainCluster? cluster}) hit(Offset at, Size size) {
    CheBrainNode? best;
    var bestDepth = double.infinity;
    for (final n in layout.nodes) {
      if (!layout.visible(n, filter)) continue;
      final p = camera.project(n.position, size, worldRadius: n.size);
      if (p == null) continue;
      if ((p.offset - at).distance <= math.max(p.radius * 1.6, 18) && p.depth < bestDepth) {
        best = n;
        bestDepth = p.depth;
      }
    }
    for (final c in layout.clusters.values) {
      if (c.expanded || (filter.isNotEmpty && !filter.contains(c.name))) continue;
      final p = camera.project(c.center, size, worldRadius: _clusterRadius(c));
      if (p == null) continue;
      if ((p.offset - at).distance <= math.max(p.radius, 26) && p.depth < bestDepth) {
        return (node: null, cluster: c);
      }
    }
    return (node: best, cluster: null);
  }

  static double _clusterRadius(CheBrainCluster c) => .8 + math.min(2.2, math.sqrt(c.members.length) * .18);

  void dispose() {
    if (identical(current, this)) current = null;
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

class _CheBrainSpaceState extends State<CheBrainSpace> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_onTick);
  Duration _last = Duration.zero;
  Size _size = Size.zero;
  Offset _lastFocal = Offset.zero;
  double _lastScale = 1;
  int _pointers = 0;
  double _grabDepth = 0;
  Offset _velocity = Offset.zero;

  CheBrainSpaceController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    if (widget.active) {
      CheBrainSpaceController.current = c;
      _ticker.start();
    }
  }

  @override
  void didUpdateWidget(covariant CheBrainSpace old) {
    super.didUpdateWidget(old);
    // Voice commands reach the Brain only while it is on screen.
    if (widget.active) {
      CheBrainSpaceController.current = c;
    } else if (identical(CheBrainSpaceController.current, c)) {
      CheBrainSpaceController.current = null;
    }
    if (widget.active && !_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    } else if (!widget.active && _ticker.isActive) {
      _ticker.stop();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    if (identical(CheBrainSpaceController.current, c)) CheBrainSpaceController.current = null;
    super.dispose();
  }

  void _onTick(Duration elapsed) {
    final dt = _last == Duration.zero ? 1 / 60 : (elapsed - _last).inMicroseconds / 1e6;
    _last = elapsed;
    c.tick(dt.clamp(0, .05).toDouble());
  }

  void _say(String text) {
    widget.onSpeak?.call(text);
    final view = View.maybeOf(context);
    if (view != null) SemanticsService.sendAnnouncement(view, text, TextDirection.ltr);
  }

  // ─── Gestures ──────────────────────────────────────────────────────────

  void _scaleStart(ScaleStartDetails d) {
    c.stop();
    _lastFocal = d.localFocalPoint;
    _lastScale = 1;
    _pointers = d.pointerCount;
    _velocity = Offset.zero;
  }

  void _scaleUpdate(ScaleUpdateDetails d) {
    if (c.grabbedId != null) return;
    final delta = d.localFocalPoint - _lastFocal;
    _lastFocal = d.localFocalPoint;
    _pointers = d.pointerCount;
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

  void _scaleEnd(ScaleEndDetails d) {
    if (_pointers <= 1 && _velocity.distance > .002) c.fling(_velocity.dx, _velocity.dy);
    final inside = c.camera.inside;
    if (inside && _pointers >= 2) _say('Inside my brain. Drag to look around; spread fingers apart to back out.');
  }

  void _tap(TapUpDetails d) {
    final hit = c.hit(d.localPosition, _size);
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
    if (node.id == c.selectedId) {
      _say(c.openSelected());
    } else {
      _say(c.select(node));
    }
  }

  void _grabStart(LongPressStartDetails d) {
    final node = c.hit(d.localPosition, _size).node;
    if (node == null) return;
    final p = c.camera.project(node.position, _size);
    if (p == null) return;
    HapticFeedback.heavyImpact();
    c.stop();
    c.grabbedId = node.id;
    c.selectedId = node.id;
    _grabDepth = p.depth;
    c.state.value++;
    _say('Holding ${node.dot.title}. Move your finger to place it.');
  }

  void _grabMove(LongPressMoveUpdateDetails d) {
    final node = c.grabbedId == null ? null : c.layout.node(c.grabbedId!);
    if (node == null) return;
    node.moved = c.camera.unproject(d.localPosition, _grabDepth, _size);
    c.tick(0);
  }

  void _grabEnd(LongPressEndDetails d) {
    final node = c.grabbedId == null ? null : c.layout.node(c.grabbedId!);
    c.grabbedId = null;
    if (node == null) return;
    HapticFeedback.lightImpact();
    c.state.value++;
    _say('Placed ${node.dot.title}.');
  }

  @override
  Widget build(BuildContext context) {
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
                hint: 'Use the actions to move between memories, open one, go inside, or show the whole brain.',
                customSemanticsActions: {
                  const CustomSemanticsAction(label: 'Next memory'): () => _say(c.step(1)),
                  const CustomSemanticsAction(label: 'Previous memory'): () => _say(c.step(-1)),
                  const CustomSemanticsAction(label: 'Open selected memory'): () => _say(c.openSelected()),
                  const CustomSemanticsAction(label: 'Go inside the brain'): () => _say(c.inside()),
                  const CustomSemanticsAction(label: 'Show the whole brain'): () => _say(c.overview()),
                },
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onScaleStart: _scaleStart,
                  onScaleUpdate: _scaleUpdate,
                  onScaleEnd: _scaleEnd,
                  onTapUp: _tap,
                  onLongPressStart: _grabStart,
                  onLongPressMoveUpdate: _grabMove,
                  onLongPressEnd: _grabEnd,
                  child: RepaintBoundary(
                    child: CustomPaint(
                      key: const ValueKey('che-brain-canvas'),
                      painter: CheBrainPainter(c),
                      size: Size.infinite,
                    ),
                  ),
                ),
              );
            },
          ),
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
  CheBrainPainter(this.c) : super(repaint: c.frame);

  final CheBrainSpaceController c;

  static ui.Image? _glow;
  static ui.Image? _glowSprite() {
    if (_glow != null) return _glow;
    try {
      const s = 64.0;
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      canvas.drawCircle(
        const Offset(s / 2, s / 2),
        s / 2,
        Paint()
          ..shader = ui.Gradient.radial(const Offset(s / 2, s / 2), s / 2, const [
            Color(0xFFFFFFFF),
            Color(0xCCFFFFFF),
            Color(0x33FFFFFF),
            Color(0x00FFFFFF),
          ], const [0, .18, .45, 1]),
      );
      _glow = recorder.endRecording().toImageSync(s.toInt(), s.toInt());
    } catch (_) {
      _glow = null;
    }
    return _glow;
  }

  final Map<String, TextPainter> _labels = {};

  TextPainter _label(String key, String text, double size, Color color) {
    return _labels.putIfAbsent('$key|$size', () => TextPainter(
          text: TextSpan(text: text, style: TextStyle(fontSize: size, color: color, fontWeight: FontWeight.w600, shadows: const [Shadow(blurRadius: 6)])),
          textDirection: TextDirection.ltr,
          maxLines: 1,
          ellipsis: '…',
        )..layout(maxWidth: 200));
  }

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

    final layout = c.layout;
    final n = layout.nodes.length;
    final proj = List<CheProjected?>.filled(n, null);
    for (var i = 0; i < n; i++) {
      final node = layout.nodes[i];
      if (!layout.visible(node, c.filter)) continue;
      proj[i] = cam.project(node.position, size, worldRadius: node.size);
    }

    // Edges: batched into faint / strong line lists; edges of the selected
    // memory pulse with a travelling spark.
    final faint = <double>[], strong = <double>[], sparks = <double>[];
    final selIndex = c.selectedId == null ? -1 : (layout.byId[c.selectedId!] ?? -1);
    for (final e in layout.edges) {
      final a = proj[e.$1], b = proj[e.$2];
      if (a == null || b == null) continue;
      final hot = e.$1 == selIndex || e.$2 == selIndex;
      (hot ? strong : faint).addAll([a.offset.dx, a.offset.dy, b.offset.dx, b.offset.dy]);
      if (hot) {
        final t = (c.time * .6 + (e.$1 + e.$2) * .13) % 1.0;
        final from = e.$1 == selIndex ? a.offset : b.offset;
        final to = e.$1 == selIndex ? b.offset : a.offset;
        final p = Offset.lerp(from, to, t)!;
        sparks.addAll([p.dx, p.dy]);
      }
    }
    if (faint.isNotEmpty) {
      canvas.drawRawPoints(ui.PointMode.lines, Float32List.fromList(faint), Paint()
        ..color = const Color(0x2E7FF5E0)
        ..strokeWidth = .8);
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

    // Nodes far → near, one atlas draw.
    final order = [for (var i = 0; i < n; i++) if (proj[i] != null) i]..sort((x, y) => proj[y]!.depth.compareTo(proj[x]!.depth));
    final sprite = _glowSprite();
    final transforms = Float32List(order.length * 4);
    final rects = Float32List(order.length * 4);
    final colors = Int32List(order.length);
    for (var k = 0; k < order.length; k++) {
      final i = order[k];
      final p = proj[i]!;
      final node = layout.nodes[i];
      final breathe = 1 + math.sin(c.time * 1.4 + i * .7) * .06;
      final presence = 1 + math.min(node.degree, 8) * .05;
      final radius = (math.max(p.radius, 1.6) * 2.4 * breathe * presence).clamp(1.6, 160.0);
      final depthFade = (1.0 - (p.depth - 4) / 60).clamp(.25, 1.0);
      final color = cheMemoryCategoryColor(node.dot.category).withValues(alpha: (i == selIndex ? 1.0 : .82) * depthFade);
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
      colors[k] = color.toARGB32();
      if (sprite == null) canvas.drawCircle(p.offset, radius * .4, Paint()..color = color);
    }
    if (sprite != null && order.isNotEmpty) {
      canvas.drawRawAtlas(sprite, transforms, rects, colors, BlendMode.modulate, null, Paint()..blendMode = BlendMode.plus);
    }

    // Selection ring.
    if (selIndex >= 0 && proj[selIndex] != null) {
      final p = proj[selIndex]!;
      final r = math.max(p.radius * 3.2, 14.0) * (1 + math.sin(c.time * 3) * .06);
      canvas.drawCircle(p.offset, r, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6
        ..color = Colors.white.withValues(alpha: .85));
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
      if (i != selIndex && proj[i]!.radius > 5) labelled.add(i);
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
