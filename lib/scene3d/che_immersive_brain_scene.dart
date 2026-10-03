import 'dart:math' as math;

import 'package:flutter/material.dart' hide Material;
import 'package:flutter/services.dart';
import 'package:flutter_scene/scene.dart' hide Material;
import 'package:vector_math/vector_math.dart' as vm;

enum CheSceneQuality { efficient, immersive, realistic }

extension CheSceneQualityConfig on CheSceneQuality {
  int get renderNodeBudget => switch (this) {
        CheSceneQuality.efficient => 220,
        CheSceneQuality.immersive => 700,
        CheSceneQuality.realistic => 560,
      };

  int get renderEdgeBudget => switch (this) {
        CheSceneQuality.efficient => 320,
        CheSceneQuality.immersive => 1200,
        CheSceneQuality.realistic => 900,
      };

  double get maxFrameRate => switch (this) {
        CheSceneQuality.efficient => 30,
        CheSceneQuality.immersive => 45,
        CheSceneQuality.realistic => 60,
      };

  double get pixelRatio => switch (this) {
        CheSceneQuality.efficient => 0.85,
        CheSceneQuality.immersive => 1.10,
        CheSceneQuality.realistic => 1.35,
      };

  int get sphereSegments => switch (this) {
        CheSceneQuality.efficient => 14,
        CheSceneQuality.immersive => 22,
        CheSceneQuality.realistic => 30,
      };

  int get sphereRings => switch (this) {
        CheSceneQuality.efficient => 8,
        CheSceneQuality.immersive => 12,
        CheSceneQuality.realistic => 16,
      };

  int get tubeSegments => switch (this) {
        CheSceneQuality.efficient => 4,
        CheSceneQuality.immersive => 6,
        CheSceneQuality.realistic => 8,
      };
}

class CheBrain3DNode {
  const CheBrain3DNode({
    required this.id,
    required this.label,
    required this.category,
    required this.color,
    this.importance = 3,
    this.value,
    this.hint,
  });

  final String id;
  final String label;
  final String category;
  final Color color;
  final int importance;
  final String? value;
  final String? hint;
}

class CheBrain3DEdge {
  const CheBrain3DEdge(this.sourceId, this.targetId);

  final String sourceId;
  final String targetId;
}

class CheImmersiveBrainScene extends StatefulWidget {
  const CheImmersiveBrainScene({
    super.key,
    required this.nodes,
    required this.edges,
    required this.onNodeTap,
    this.quality = CheSceneQuality.immersive,
    this.height,
  });

  final List<CheBrain3DNode> nodes;
  final List<CheBrain3DEdge> edges;
  final ValueChanged<String> onNodeTap;
  final CheSceneQuality quality;
  final double? height;

  @override
  State<CheImmersiveBrainScene> createState() => _CheImmersiveBrainSceneState();
}

class _CheImmersiveBrainSceneState extends State<CheImmersiveBrainScene> {
  Scene? _scene;
  Camera? _lastCamera;
  Size _viewSize = Size.zero;
  String? _error;
  String? _fingerprint;
  int _buildGeneration = 0;

  final Map<String, Node> _orbNodes = {};
  final Map<String, double> _orbBaseScale = {};
  final Map<String, double> _orbPhase = {};
  final Map<String, vm.Vector3> _positions = {};
  final List<PhysicallyBasedMaterial> _linkMaterials = [];

  String? _selectedId;
  double _azimuth = 0.42;
  double _elevation = 0.28;
  double _radius = 17.0;
  double _scaleStartRadius = 17.0;

  @override
  void initState() {
    super.initState();
    _rebuild();
  }

  @override
  void didUpdateWidget(covariant CheImmersiveBrainScene oldWidget) {
    super.didUpdateWidget(oldWidget);
    final next = _makeFingerprint(widget);
    if (_fingerprint != next) _rebuild();
  }

  @override
  void dispose() {
    _scene?.removeAll();
    super.dispose();
  }

  String _makeFingerprint(CheImmersiveBrainScene w) {
    final nodePart = w.nodes
        .map((n) => '${n.id}|${n.category}|${n.importance}|${n.color.toARGB32()}')
        .join(';');
    final edgePart = w.edges.map((e) => '${e.sourceId}>${e.targetId}').join(';');
    return '${w.quality.name}::$nodePart::$edgePart';
  }

  Future<void> _rebuild() async {
    final generation = ++_buildGeneration;
    final fingerprint = _makeFingerprint(widget);
    try {
      await Scene.initializeStaticResources();
      if (!mounted || generation != _buildGeneration) return;

      final scene = Scene();
      _configureScene(scene);

      _orbNodes.clear();
      _orbBaseScale.clear();
      _orbPhase.clear();
      _positions.clear();
      _linkMaterials.clear();

      final ordered = [...widget.nodes]
        ..sort((a, b) {
          final importance = b.importance.compareTo(a.importance);
          return importance != 0 ? importance : a.id.compareTo(b.id);
        });
      final visible = ordered.take(widget.quality.renderNodeBudget).toList(growable: false);
      final visibleIds = <String>{for (final n in visible) n.id};

      for (var i = 0; i < visible.length; i++) {
        final data = visible[i];
        final position = cheBrainDeterministicPosition(data.id, i, visible.length);
        _positions[data.id] = position;

        final color = _linearColor(data.color);
        final importance = data.importance.clamp(1, 5);
        final radius = 0.16 + importance * 0.035;
        final material = PhysicallyBasedMaterial()
          ..baseColorFactor = vm.Vector4(color.x, color.y, color.z, 1)
          ..metallicFactor = widget.quality == CheSceneQuality.realistic ? 0.28 : 0.08
          ..roughnessFactor = widget.quality == CheSceneQuality.realistic ? 0.26 : 0.42
          ..emissiveFactor = vm.Vector4(color.x, color.y, color.z, 1)
          ..emissiveStrength = widget.quality == CheSceneQuality.realistic ? 1.25 : 2.3;

        final node = Node(
          name: 'brain:${data.id}',
          mesh: Mesh(
            SphereGeometry(
              radius: radius,
              segments: widget.quality.sphereSegments,
              rings: widget.quality.sphereRings,
            ),
            material,
          ),
        );
        node.position = position;
        node.addComponent(
          SemanticsComponent(
            label: '${data.category}. ${data.label}',
            value: data.value,
            hint: data.hint ?? 'Activate to expand and open this memory.',
            button: true,
            sortOrder: i.toDouble(),
            onTap: () => _selectNode(data.id, announce: false),
          ),
        );
        scene.add(node);
        _orbNodes[data.id] = node;
        _orbBaseScale[data.id] = 1.0;
        _orbPhase[data.id] = (cheBrainStableHash(data.id) % 6283) / 1000.0;
      }

      var edgeCount = 0;
      for (final edge in widget.edges) {
        if (edgeCount >= widget.quality.renderEdgeBudget) break;
        if (!visibleIds.contains(edge.sourceId) || !visibleIds.contains(edge.targetId)) continue;
        final a = _positions[edge.sourceId]!;
        final b = _positions[edge.targetId]!;
        if ((a - b).length < 0.25) continue;

        final midpoint = (a + b) * 0.5;
        final cross = (b - a).cross(vm.Vector3(0, 1, 0));
        if (cross.length2 > 1e-8) {
          midpoint.add(cross.normalized() * (0.18 + (edgeCount % 5) * 0.025));
        }
        midpoint.y += math.sin(edgeCount * 0.83) * 0.12;

        final path = CatmullRomPath([a, midpoint, b]);
        final source = widget.nodes.firstWhere((n) => n.id == edge.sourceId);
        final c = _linearColor(source.color);
        final material = PhysicallyBasedMaterial()
          ..baseColorFactor = vm.Vector4(c.x * 0.32, c.y * 0.32, c.z * 0.32, 1)
          ..metallicFactor = 0.05
          ..roughnessFactor = 0.5
          ..emissiveFactor = vm.Vector4(c.x, c.y, c.z, 1)
          ..emissiveStrength = 1.2;

        final link = Node(
          name: 'link:${edge.sourceId}:${edge.targetId}',
          mesh: Mesh(
            TubeGeometry(
              path,
              radius: widget.quality == CheSceneQuality.efficient ? 0.012 : 0.018,
              radialSegments: widget.quality.tubeSegments,
              stations: widget.quality == CheSceneQuality.realistic ? 20 : 14,
              caps: true,
            ),
            material,
          ),
        );
        scene.add(link);
        _linkMaterials.add(material);
        edgeCount++;
      }

      if (!mounted || generation != _buildGeneration) {
        scene.removeAll();
        return;
      }
      setState(() {
        _scene?.removeAll();
        _scene = scene;
        _error = null;
        _fingerprint = fingerprint;
      });
    } catch (e) {
      if (!mounted || generation != _buildGeneration) return;
      setState(() {
        _scene = null;
        _error = 'Native 3D Brain unavailable: $e';
        _fingerprint = fingerprint;
      });
    }
  }

  void _configureScene(Scene scene) {
    scene.exposure = widget.quality == CheSceneQuality.realistic ? 1.10 : 1.25;
    scene.antiAliasingMode = switch (widget.quality) {
      CheSceneQuality.efficient => AntiAliasingMode.fxaa,
      CheSceneQuality.immersive => AntiAliasingMode.auto,
      CheSceneQuality.realistic => AntiAliasingMode.msaa,
    };

    scene.postProcess.bloom
      ..enabled = true
      ..threshold = widget.quality == CheSceneQuality.realistic ? 0.7 : 0.45
      ..intensity = widget.quality == CheSceneQuality.realistic ? 0.38 : 0.62
      ..scatter = 0.72;

    scene.postProcess.vignette
      ..enabled = true
      ..intensity = widget.quality == CheSceneQuality.realistic ? 0.32 : 0.48
      ..radius = 0.82
      ..smoothness = 0.58;

    scene.postProcess.colorGrading
      ..enabled = true
      ..brightness = 0.92
      ..contrast = widget.quality == CheSceneQuality.realistic ? 1.08 : 1.14
      ..saturation = widget.quality == CheSceneQuality.realistic ? 0.96 : 1.08
      ..temperature = -0.04
      ..tint = 0.02;
  }

  Camera _camera() {
    final target = vm.Vector3.zero();
    final ce = math.cos(_elevation);
    final offset = vm.Vector3(
      ce * math.sin(_azimuth),
      math.sin(_elevation),
      ce * math.cos(_azimuth),
    );
    return PerspectiveCamera(position: target + offset * _radius, target: target);
  }

  void _tick(Duration elapsed, double deltaSeconds) {
    final t = elapsed.inMicroseconds / 1000000.0;
    for (final entry in _orbNodes.entries) {
      final phase = _orbPhase[entry.key] ?? 0;
      final selected = entry.key == _selectedId;
      final pulse = 1.0 + math.sin(t * 1.45 + phase) * (selected ? 0.07 : 0.025);
      final target = selected ? 1.75 : 1.0;
      final base = _orbBaseScale[entry.key] ?? 1.0;
      final s = base * target * pulse;
      entry.value.scale = vm.Vector3.all(s);
    }
    final linkPulse = 1.45 + (math.sin(t * 2.1) + 1) * 0.55;
    for (var i = 0; i < _linkMaterials.length; i++) {
      _linkMaterials[i].emissiveStrength = linkPulse + (i % 7) * 0.035;
    }
  }

  void _selectNode(String id, {bool announce = true}) {
    final previous = _selectedId;
    if (previous != null) _orbNodes[previous]?.highlightColor = null;
    _selectedId = id;
    final selected = _orbNodes[id];
    if (selected != null) {
      selected.highlightColor = vm.Vector4(0.75, 1.0, 0.96, 1.0);
    }
    HapticFeedback.selectionClick();
    widget.onNodeTap(id);
  }

  void _pick(Offset point) {
    final scene = _scene;
    final camera = _lastCamera;
    if (scene == null || camera == null || _viewSize.isEmpty) return;
    final hit = scene.raycast(camera.screenPointToRay(point, _viewSize));
    if (hit == null) return;
    for (Node? node = hit.node; node != null; node = node.parent) {
      final name = node.name ?? '';
      if (name.startsWith('brain:')) {
        _selectNode(name.substring('brain:'.length));
        return;
      }
    }
  }

  void _onScaleStart(ScaleStartDetails details) {
    _scaleStartRadius = _radius;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    if (details.pointerCount >= 2) {
      final next = (_scaleStartRadius / math.max(0.35, details.scale)).clamp(3.6, 34.0);
      _radius = next.toDouble();
      return;
    }
    final delta = details.focalPointDelta;
    _azimuth -= delta.dx * 0.006;
    _elevation = (_elevation + delta.dy * 0.005).clamp(-1.05, 1.05).toDouble();
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    final height = widget.height;
    if (_error != null) {
      return Semantics(
        liveRegion: true,
        label: _error,
        child: Container(
          height: height,
          color: Colors.black,
          alignment: Alignment.center,
          padding: const EdgeInsets.all(20),
          child: Text(
            _error!,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70),
          ),
        ),
      );
    }
    if (scene == null) {
      return SizedBox(
        height: height,
        child: const ColoredBox(
          color: Colors.black,
          child: Center(child: CircularProgressIndicator()),
        ),
      );
    }

    return Semantics(
      container: true,
      label:
          'Immersive 3D Brain. ${widget.nodes.length} memories retained. '
          'Showing up to ${widget.quality.renderNodeBudget} at once in ${widget.quality.name} quality. '
          'Swipe one finger to orbit. Pinch to zoom. Activate an orb to expand it.',
      child: LayoutBuilder(
        builder: (context, constraints) {
          _viewSize = constraints.biggest;
          final view = GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapUp: (details) => _pick(details.localPosition),
            onScaleStart: _onScaleStart,
            onScaleUpdate: _onScaleUpdate,
            child: SceneView(
              scene,
              cameraBuilder: (_) => _lastCamera = _camera(),
              onTick: _tick,
              maxFrameRate: widget.quality.maxFrameRate,
              pixelRatio: widget.quality.pixelRatio,
              loadingBuilder: (context, progress) => const ColoredBox(
                color: Colors.black,
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
          );
          if (height == null) return ColoredBox(color: Colors.black, child: view);
          return SizedBox(height: height, child: ColoredBox(color: Colors.black, child: view));
        },
      ),
    );
  }
}

int cheBrainStableHash(String text) {
  var hash = 0x811C9DC5;
  for (final unit in text.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

vm.Vector3 cheBrainDeterministicPosition(String id, int index, int total) {
  final hash = cheBrainStableHash(id);
  final count = math.max(total, 1);
  final y = 1.0 - (2.0 * (index + 0.5) / count);
  final radiusAtY = math.sqrt(math.max(0.0, 1.0 - y * y));
  final golden = math.pi * (3.0 - math.sqrt(5.0));
  final jitter = (hash % 1000) / 1000.0 * 0.45;
  final theta = index * golden + jitter;
  final shell = 3.7 + ((hash >> 10) % 1000) / 1000.0 * 3.3;
  return vm.Vector3(
    math.cos(theta) * radiusAtY * shell,
    y * shell * 0.82,
    math.sin(theta) * radiusAtY * shell,
  );
}

vm.Vector3 _linearColor(Color color) {
  double linear(double v) => v <= 0.04045
      ? v / 12.92
      : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return vm.Vector3(linear(color.r), linear(color.g), linear(color.b));
}
