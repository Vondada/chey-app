import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_scene/scene.dart' hide Material;
import 'package:vector_math/vector_math.dart' as vm;

/// Primary native 3D renderer for CHE's Office, Brain and War Room.
///
/// This path uses Flutter Scene on Flutter GPU/Impeller. The legacy Three.js
/// WebView remains available elsewhere only as a temporary fallback while
/// native scenes roll out to every room.
enum CheSceneMode { office, brain, warRoom }

enum CheSceneQuality { performance, balanced, realistic }

String cheSceneQualityLabel(CheSceneQuality quality) => switch (quality) {
      CheSceneQuality.performance => 'Performance',
      CheSceneQuality.balanced => 'Balanced',
      CheSceneQuality.realistic => 'Realistic',
    };

int cheSceneVisualLimit(CheSceneQuality quality) => switch (quality) {
      CheSceneQuality.performance => 300,
      CheSceneQuality.balanced => 900,
      CheSceneQuality.realistic => 1800,
    };

class CheSceneQualityStore {
  CheSceneQualityStore._();

  static final ValueNotifier<CheSceneQuality> value =
      ValueNotifier<CheSceneQuality>(CheSceneQuality.realistic);
}

class CheSceneQualityButton extends StatelessWidget {
  const CheSceneQualityButton({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CheSceneQuality>(
      valueListenable: CheSceneQualityStore.value,
      builder: (context, quality, _) => Semantics(
        button: true,
        label: '3D quality ' +
            cheSceneQualityLabel(quality) +
            '. Activate to change rendering quality.',
        child: PopupMenuButton<CheSceneQuality>(
          tooltip: '3D quality',
          initialValue: quality,
          onSelected: (next) => CheSceneQualityStore.value.value = next,
          itemBuilder: (context) => [
            for (final option in CheSceneQuality.values)
              PopupMenuItem<CheSceneQuality>(
                value: option,
                child: Text(cheSceneQualityLabel(option)),
              ),
          ],
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.view_in_ar_rounded, size: 18),
                const SizedBox(width: 6),
                Text('3D · ' + cheSceneQualityLabel(quality)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class CheSceneEntity {
  const CheSceneEntity({
    required this.id,
    required this.label,
    required this.color,
    this.description = '',
    this.state = 'idle',
    this.importance = 3,
    this.speaking = false,
    this.modelAsset,
    this.modelScale = 1,
  });

  final String id;
  final String label;
  final String description;
  final Color color;
  final String state;
  final int importance;
  final bool speaking;

  /// Optional owner-controlled GLB model. If loading fails, CHE keeps a
  /// procedural PBR body instead of breaking the room.
  final String? modelAsset;
  final double modelScale;
}

class CheSceneLink {
  const CheSceneLink(this.from, this.to);

  final String from;
  final String to;
}

class CheNativeSceneWorld extends StatefulWidget {
  const CheNativeSceneWorld({
    super.key,
    required this.mode,
    required this.entities,
    this.links = const [],
    this.quality = CheSceneQuality.realistic,
    this.height = 420,
    this.onEntityTap,
    this.semanticsLabel = 'CHE 3D world',
    this.fallback,
  });

  final CheSceneMode mode;
  final List<CheSceneEntity> entities;
  final List<CheSceneLink> links;
  final CheSceneQuality quality;
  final double height;
  final ValueChanged<String>? onEntityTap;
  final String semanticsLabel;
  final Widget? fallback;

  @override
  State<CheNativeSceneWorld> createState() => _CheNativeSceneWorldState();
}

class _CheNativeSceneWorldState extends State<CheNativeSceneWorld> {
  final Scene _scene = Scene();
  final Map<String, Node> _entityNodes = {};
  final Map<String, vm.Vector3> _basePositions = {};
  final List<PolylineGeometry> _lines = [];

  bool _ready = false;
  String? _error;
  Camera? _lastCamera;
  Size _viewSize = Size.zero;
  double _azimuth = .42;
  double _elevation = .48;
  double _radius = 11;
  Offset _lastFocal = Offset.zero;
  double _scaleStartRadius = 11;
  double _elapsed = 0;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void didUpdateWidget(covariant CheNativeSceneWorld oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mode != widget.mode ||
        oldWidget.quality != widget.quality ||
        _fingerprint(oldWidget.entities, oldWidget.links) !=
            _fingerprint(widget.entities, widget.links)) {
      _rebuild();
    }
  }

  @override
  void dispose() {
    _scene.removeAll();
    super.dispose();
  }

  String _fingerprint(
    List<CheSceneEntity> entities,
    List<CheSceneLink> links,
  ) {
    final entityPart = entities
        .map(
          (e) =>
              e.id +
              '|' +
              e.label +
              '|' +
              e.state +
              '|' +
              e.importance.toString() +
              '|' +
              e.speaking.toString() +
              '|' +
              (e.modelAsset ?? ''),
        )
        .join(';');
    final linkPart =
        links.map((e) => e.from + '>' + e.to).join(';');
    return entityPart + '#' + linkPart;
  }

  Future<void> _initialize() async {
    try {
      await Scene.initializeStaticResources();
      if (!mounted) return;
      await _rebuild();
      if (!mounted) return;
      setState(() {
        _ready = true;
        _error = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _ready = false;
        _error = 'Native 3D is unavailable.';
      });
    }
  }

  Future<void> _rebuild() async {
    _scene.removeAll();
    _entityNodes.clear();
    _basePositions.clear();
    _lines.clear();

    final realistic = widget.quality == CheSceneQuality.realistic;
    final balanced = widget.quality == CheSceneQuality.balanced;
    _scene.environmentIntensity = realistic ? .9 : (balanced ? .65 : .45);
    _scene.exposure = realistic ? 1.25 : 1.0;
    _scene.screenSpaceReflections.enabled = realistic;

    if (widget.mode == CheSceneMode.brain) {
      _addBrainAccentLight();
    } else {
      _addRoomShell();
    }

    final limit = cheSceneVisualLimit(widget.quality);
    final shown = widget.entities.take(limit).toList(growable: false);
    for (var i = 0; i < shown.length; i++) {
      final entity = shown[i];
      final position = _positionFor(i, shown.length, entity);
      final root = await _buildEntity(entity, i, position);
      _scene.add(root);
      _entityNodes[entity.id] = root;
      _basePositions[entity.id] = position;
    }

    if (widget.mode == CheSceneMode.brain && widget.links.isNotEmpty) {
      _addBrainLinks(shown.map((e) => e.id).toSet());
    }

    if (mounted && _ready) setState(() {});
  }

  void _addRoomShell() {
    final realistic = widget.quality == CheSceneQuality.realistic;
    _scene.add(
      Node(
        mesh: Mesh(
          CuboidGeometry(vm.Vector3(13, .18, 9)),
          _pbr(
            const Color(0xFF11191C),
            roughness: realistic ? .16 : .42,
            metallic: realistic ? .32 : .08,
          ),
        ),
        localTransform: vm.Matrix4.translation(vm.Vector3(0, -.16, 0)),
      ),
    );

    _scene.add(
      Node(
        mesh: Mesh(
          CuboidGeometry(vm.Vector3(13, 4.8, .16)),
          _pbr(const Color(0xFF0D171A), roughness: .55),
        ),
        localTransform: vm.Matrix4.translation(vm.Vector3(0, 2.25, -4.45)),
      ),
    );

    _scene.add(
      Node(
        localTransform: vm.Matrix4.translation(vm.Vector3(0, 4.2, 1.5)),
      )..addComponent(
          PointLightComponent(
            PointLight(
              color: vm.Vector3(.10, .92, .82),
              intensity: realistic ? 18 : 11,
              range: 11,
            ),
          ),
        ),
    );

    if (widget.mode == CheSceneMode.warRoom) {
      _scene.add(
        Node(
          mesh: Mesh(
            CylinderGeometry(
              bottomRadius: 2.55,
              topRadius: 2.55,
              height: .18,
              radialSegments: realistic ? 48 : 24,
            ),
            _pbr(
              const Color(0xFF18272C),
              roughness: realistic ? .12 : .34,
              metallic: realistic ? .62 : .22,
            ),
          ),
          localTransform: vm.Matrix4.translation(vm.Vector3(0, .55, 0)),
        ),
      );
    }
  }

  void _addBrainAccentLight() {
    _scene.add(
      Node(
        localTransform: vm.Matrix4.translation(vm.Vector3(0, 0, 2)),
      )..addComponent(
          PointLightComponent(
            PointLight(
              color: vm.Vector3(.0, .88, .80),
              intensity:
                  widget.quality == CheSceneQuality.realistic ? 15 : 9,
              range: 12,
            ),
          ),
        ),
    );
  }

  Future<Node> _buildEntity(
    CheSceneEntity entity,
    int index,
    vm.Vector3 position,
  ) async {
    final root = Node(
      name: 'entity:' + entity.id,
      localTransform: vm.Matrix4.translation(position),
    );

    var loadedModel = false;
    final asset = entity.modelAsset?.trim();
    if (asset != null && asset.isNotEmpty) {
      try {
        final model = await Node.fromGlbAsset(asset);
        model.scale = vm.Vector3.all(entity.modelScale);
        root.add(model);
        loadedModel = true;
      } catch (_) {
        loadedModel = false;
      }
    }

    if (!loadedModel) {
      if (widget.mode == CheSceneMode.brain) {
        _addBrainNode(root, entity);
      } else {
        _addProceduralPerson(root, entity);
      }
    }

    root.addComponent(
      SemanticsComponent(
        label: entity.description.isEmpty
            ? entity.label
            : entity.label + '. ' + entity.description,
        hint: 'Activate to open this item',
        button: true,
        sortOrder: index.toDouble(),
        onTap: () => widget.onEntityTap?.call(entity.id),
      ),
    );
    return root;
  }

  void _addProceduralPerson(Node root, CheSceneEntity entity) {
    final realistic = widget.quality == CheSceneQuality.realistic;
    final segments = realistic
        ? 32
        : widget.quality == CheSceneQuality.balanced
            ? 20
            : 12;
    final bodyColor = entity.color;
    final skin = const Color(0xFFB77A5D);
    final dark = const Color(0xFF14191B);

    root.add(
      Node(
        mesh: Mesh(
          CapsuleGeometry(
            radius: .28,
            height: .78,
            radialSegments: segments,
          ),
          _pbr(
            bodyColor,
            roughness: realistic ? .34 : .56,
            metallic: realistic ? .12 : .03,
          ),
        ),
        localTransform: vm.Matrix4.translation(vm.Vector3(0, .86, 0)),
      ),
    );
    root.add(
      Node(
        mesh: Mesh(
          SphereGeometry(
            radius: .25,
            segments: segments,
            rings: math.max(8, segments ~/ 2),
          ),
          _pbr(skin, roughness: realistic ? .48 : .68),
        ),
        localTransform: vm.Matrix4.translation(vm.Vector3(0, 1.64, 0)),
      ),
    );

    for (final side in const [-1.0, 1.0]) {
      root.add(
        Node(
          mesh: Mesh(
            CapsuleGeometry(
              radius: .095,
              height: .58,
              radialSegments: math.max(8, segments ~/ 2),
            ),
            _pbr(bodyColor, roughness: .52),
          ),
          localTransform:
              vm.Matrix4.translation(vm.Vector3(side * .39, .90, 0)),
        ),
      );
      root.add(
        Node(
          mesh: Mesh(
            CapsuleGeometry(
              radius: .11,
              height: .66,
              radialSegments: math.max(8, segments ~/ 2),
            ),
            _pbr(dark, roughness: .62),
          ),
          localTransform:
              vm.Matrix4.translation(vm.Vector3(side * .16, .18, 0)),
        ),
      );
    }

    if (entity.speaking ||
        entity.state == 'working' ||
        entity.state == 'thinking') {
      root.add(
        Node(
          mesh: Mesh(
            SphereGeometry(
              radius: entity.speaking ? .14 : .10,
              segments: segments,
              rings: math.max(8, segments ~/ 2),
            ),
            UnlitMaterial()
              ..baseColorFactor = _colorVector(
                entity.speaking
                    ? const Color(0xFFE8B04A)
                    : entity.color,
              ),
          ),
          localTransform: vm.Matrix4.translation(vm.Vector3(0, 1.03, .30)),
        ),
      );
    }
  }

  void _addBrainNode(Node root, CheSceneEntity entity) {
    final importance = entity.importance.clamp(1, 5);
    final radius = .09 + importance * .035;
    final segments = widget.quality == CheSceneQuality.realistic
        ? 24
        : widget.quality == CheSceneQuality.balanced
            ? 16
            : 10;
    root.add(
      Node(
        mesh: Mesh(
          SphereGeometry(
            radius: radius,
            segments: segments,
            rings: math.max(8, segments ~/ 2),
          ),
          PhysicallyBasedMaterial()
            ..baseColorFactor = _colorVector(entity.color)
            ..metallicFactor =
                widget.quality == CheSceneQuality.realistic ? .35 : .08
            ..roughnessFactor =
                widget.quality == CheSceneQuality.realistic ? .18 : .42,
        ),
      ),
    );
  }

  void _addBrainLinks(Set<String> visibleIds) {
    final material = UnlitMaterial()
      ..baseColorFactor = vm.Vector4(.05, .72, .68, .42);
    for (final link in widget.links) {
      if (!visibleIds.contains(link.from) || !visibleIds.contains(link.to)) {
        continue;
      }
      final a = _basePositions[link.from];
      final b = _basePositions[link.to];
      if (a == null || b == null) continue;
      final line = PolylineGeometry(
        [a, b],
        width: .018,
        widthMode: PolylineWidthMode.worldUnits,
      );
      _lines.add(line);
      _scene.add(Node(mesh: Mesh(line, material)));
    }
  }

  PhysicallyBasedMaterial _pbr(
    Color color, {
    double roughness = .5,
    double metallic = 0,
  }) =>
      PhysicallyBasedMaterial()
        ..baseColorFactor = _colorVector(color)
        ..roughnessFactor = roughness
        ..metallicFactor = metallic;

  vm.Vector4 _colorVector(Color color) =>
      vm.Vector4(color.r, color.g, color.b, color.a);

  vm.Vector3 _positionFor(
    int index,
    int total,
    CheSceneEntity entity,
  ) {
    if (widget.mode == CheSceneMode.warRoom) {
      final angle = (index / math.max(1, total)) * math.pi * 2;
      return vm.Vector3(
        math.sin(angle) * 3.25,
        .35,
        math.cos(angle) * 3.25,
      );
    }
    if (widget.mode == CheSceneMode.office) {
      const cols = 4;
      final row = index ~/ cols;
      final col = index % cols;
      return vm.Vector3(
        (col - 1.5) * 2.25,
        .35,
        (row - .65) * 2.25,
      );
    }

    final count = math.max(1, total);
    final y = 1 - (index / math.max(1, count - 1)) * 2;
    final radial = math.sqrt(math.max(0, 1 - y * y));
    final angle = index * 2.399963229728653;
    final shell = 2.6 + entity.importance.clamp(1, 5) * .18;
    return vm.Vector3(
      math.cos(angle) * radial * shell,
      y * shell,
      math.sin(angle) * radial * shell,
    );
  }

  Camera _camera() {
    final target = widget.mode == CheSceneMode.brain
        ? vm.Vector3.zero()
        : vm.Vector3(0, .9, 0);
    final ce = math.cos(_elevation);
    final offset = vm.Vector3(
      ce * math.sin(_azimuth),
      math.sin(_elevation),
      ce * math.cos(_azimuth),
    );
    return PerspectiveCamera(
      position: target + offset * _radius,
      target: target,
    );
  }

  void _tick(double deltaSeconds) {
    final camera = _lastCamera;
    if (camera != null && !_viewSize.isEmpty) {
      for (final line in _lines) {
        line.updateForCamera(camera, _viewSize);
      }
    }

    final media = MediaQuery.maybeOf(context);
    if (media?.disableAnimations == true ||
        media?.accessibleNavigation == true) {
      return;
    }

    _elapsed += deltaSeconds;
    var index = 0;
    for (final entry in _entityNodes.entries) {
      final base = _basePositions[entry.key];
      if (base == null) continue;
      final amount = widget.mode == CheSceneMode.brain ? .035 : .018;
      entry.value.position = base +
          vm.Vector3(
            0,
            math.sin(_elapsed * 1.35 + index * .73) * amount,
            0,
          );
      index++;
    }
  }

  void _onScaleStart(ScaleStartDetails details) {
    _lastFocal = details.localFocalPoint;
    _scaleStartRadius = _radius;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    final delta = details.localFocalPoint - _lastFocal;
    _lastFocal = details.localFocalPoint;
    if (details.pointerCount >= 2) {
      _radius = (_scaleStartRadius / details.scale)
          .clamp(
            widget.mode == CheSceneMode.brain ? 3.5 : 5.5,
            widget.mode == CheSceneMode.brain ? 22.0 : 18.0,
          )
          .toDouble();
    } else {
      _azimuth += delta.dx * .006;
      _elevation =
          (_elevation + delta.dy * .004).clamp(.08, 1.25).toDouble();
    }
  }

  void _onTapUp(TapUpDetails details) {
    final camera = _lastCamera;
    if (camera == null || _viewSize.isEmpty) return;
    final hit = _scene.raycast(
      camera.screenPointToRay(details.localPosition, _viewSize),
    );
    if (hit == null) return;
    for (Node? node = hit.node; node != null; node = node.parent) {
      final name = node.name;
      if (name.startsWith('entity:')) {
        HapticFeedback.selectionClick();
        widget.onEntityTap?.call(name.substring('entity:'.length));
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final fallback = widget.fallback ??
        Center(
          child: Text(
            _error ?? 'Starting native 3D…',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70),
          ),
        );

    if (!_ready) {
      return SizedBox(height: widget.height, child: fallback);
    }

    if (!TickerMode.of(context)) {
      return SizedBox(
        height: widget.height,
        child: Semantics(
          label: widget.semanticsLabel +
              '. 3D rendering paused while this room is off screen.',
          child: const ColoredBox(color: Color(0xFF050708)),
        ),
      );
    }

    return Semantics(
      container: true,
      label: widget.semanticsLabel +
          '. ' +
          widget.entities.length.toString() +
          ' real data items. Drag to orbit and pinch to zoom. Each entity is available to VoiceOver.',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: SizedBox(
          height: widget.height,
          child: ColoredBox(
            color: widget.mode == CheSceneMode.brain
                ? Colors.black
                : const Color(0xFF05090A),
            child: LayoutBuilder(
              builder: (context, constraints) {
                _viewSize = constraints.biggest;
                return GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onScaleStart: _onScaleStart,
                  onScaleUpdate: _onScaleUpdate,
                  onTapUp: _onTapUp,
                  child: SceneView(
                    _scene,
                    cameraBuilder: (elapsed) => _lastCamera = _camera(),
                    onTick: (elapsed, deltaSeconds) => _tick(deltaSeconds),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
