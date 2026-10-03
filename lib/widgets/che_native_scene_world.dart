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
enum CheSceneMode {
  office,
  brain,
  warRoom,
  theater,
  artStudio,
  musicStudio,
  workshop,
  projects,
  markets,
  pipeline,
  store,
  creator,
}

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
    this.appearance = const {},
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

  /// Saved CHE character-creator choices. These style the procedural fallback
  /// and stay useful even when no GLB model is installed.
  final Map<String, dynamic> appearance;
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
    this.onPrimarySurfaceTap,
    this.primarySurfaceLabel,
    this.semanticsLabel = 'CHE 3D world',
    this.fallback,
  });

  final CheSceneMode mode;
  final List<CheSceneEntity> entities;
  final List<CheSceneLink> links;
  final CheSceneQuality quality;
  final double height;
  final ValueChanged<String>? onEntityTap;
  final VoidCallback? onPrimarySurfaceTap;
  final String? primarySurfaceLabel;
  final String semanticsLabel;
  final Widget? fallback;

  @override
  State<CheNativeSceneWorld> createState() => _CheNativeSceneWorldState();
}

class _CheNativeSceneWorldState extends State<CheNativeSceneWorld> {
  final Scene _scene = Scene();
  final Map<String, Node> _entityNodes = {};
  final Map<String, vm.Vector3> _basePositions = {};
  final List<PhysicallyBasedMaterial> _brainLinkMaterials = [];

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
              (e.modelAsset ?? '') +
              '|' +
              e.appearance.toString(),
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
    _brainLinkMaterials.clear();

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

  Color get _roomAccent => switch (widget.mode) {
        CheSceneMode.warRoom => const Color(0xFFE8B04A),
        CheSceneMode.theater => const Color(0xFFB98A62),
        CheSceneMode.artStudio => const Color(0xFFE4D8C8),
        CheSceneMode.musicStudio => const Color(0xFFFF3D8B),
        CheSceneMode.workshop => const Color(0xFF34E0B8),
        CheSceneMode.projects => const Color(0xFF8E86FF),
        CheSceneMode.markets => const Color(0xFFE8B04A),
        CheSceneMode.pipeline => const Color(0xFF4EA4FF),
        CheSceneMode.store => const Color(0xFF34E0B8),
        CheSceneMode.creator => const Color(0xFFFF3D8B),
        _ => const Color(0xFF34E0B8),
      };

  void _addRoomShell() {
    final realistic = widget.quality == CheSceneQuality.realistic;
    final wallColor = switch (widget.mode) {
      CheSceneMode.theater => const Color(0xFF1B1411),
      CheSceneMode.artStudio => const Color(0xFF25231F),
      CheSceneMode.musicStudio || CheSceneMode.creator => const Color(0xFF140D18),
      CheSceneMode.markets => const Color(0xFF081013),
      CheSceneMode.store => const Color(0xFF0C1715),
      _ => const Color(0xFF0D171A),
    };
    final floorColor = switch (widget.mode) {
      CheSceneMode.theater => const Color(0xFF201713),
      CheSceneMode.artStudio => const Color(0xFF2A2823),
      CheSceneMode.musicStudio || CheSceneMode.creator => const Color(0xFF160E1A),
      _ => const Color(0xFF11191C),
    };

    _scene.add(
      Node(
        mesh: Mesh(
          CuboidGeometry(vm.Vector3(13, .18, 9)),
          _pbr(
            floorColor,
            roughness: realistic ? .16 : .42,
            metallic: realistic ? .28 : .06,
          ),
        ),
        localTransform: vm.Matrix4.translation(vm.Vector3(0, -.16, 0)),
      ),
    );

    // Back, side walls and ceiling create an actual room rather than a
    // floating diorama. The front remains open to the camera.
    for (final wall in <(vm.Vector3, vm.Vector3)>[
      (vm.Vector3(13, 4.8, .16), vm.Vector3(0, 2.25, -4.45)),
      (vm.Vector3(.16, 4.8, 9), vm.Vector3(-6.45, 2.25, 0)),
      (vm.Vector3(.16, 4.8, 9), vm.Vector3(6.45, 2.25, 0)),
      (vm.Vector3(13, .12, 9), vm.Vector3(0, 4.62, 0)),
    ]) {
      _scene.add(
        Node(
          mesh: Mesh(
            CuboidGeometry(wall.$1),
            _pbr(wallColor, roughness: realistic ? .38 : .62),
          ),
          localTransform: vm.Matrix4.translation(wall.$2),
        ),
      );
    }

    final accent = _roomAccent;
    _scene.add(
      Node(
        localTransform: vm.Matrix4.translation(vm.Vector3(0, 4.05, 1.2)),
      )..addComponent(
          PointLightComponent(
            PointLight(
              color: vm.Vector3(accent.r, accent.g, accent.b),
              intensity: realistic ? 20 : 12,
              range: 12,
            ),
          ),
        ),
    );

    switch (widget.mode) {
      case CheSceneMode.warRoom:
        _addWarRoomFurniture(realistic);
      case CheSceneMode.theater:
        _addTheaterFurniture(realistic);
      case CheSceneMode.musicStudio:
      case CheSceneMode.creator:
        _addStudioFurniture(realistic);
      case CheSceneMode.artStudio:
      case CheSceneMode.projects:
        _addGalleryFurniture(realistic);
      case CheSceneMode.workshop:
        _addWorkshopFurniture(realistic);
      case CheSceneMode.markets:
        _addMarketsFurniture(realistic);
      case CheSceneMode.pipeline:
      case CheSceneMode.store:
        _addBusinessFurniture(realistic);
      case CheSceneMode.office:
        _addOfficeFurniture(realistic);
      case CheSceneMode.brain:
        break;
    }
  }

  void _addBox(
    vm.Vector3 size,
    vm.Vector3 position,
    Color color, {
    double roughness = .45,
    double metallic = .05,
    String? name,
    VoidCallback? onTap,
    String? semanticsLabel,
  }) {
    final node = Node(
      name: name ?? '',
      mesh: Mesh(
        CuboidGeometry(size),
        _pbr(color, roughness: roughness, metallic: metallic),
      ),
      localTransform: vm.Matrix4.translation(position),
    );
    if (onTap != null || semanticsLabel != null) {
      node.addComponent(
        SemanticsComponent(
          label: semanticsLabel ?? 'Interactive room object',
          hint: onTap == null ? null : 'Activate',
          button: onTap != null,
          onTap: onTap,
        ),
      );
    }
    _scene.add(node);
  }

  void _addWarRoomFurniture(bool realistic) {
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
        localTransform: vm.Matrix4.translation(vm.Vector3(0, .62, 0)),
      ),
    );
    for (var i = 0; i < 8; i++) {
      final angle = i / 8 * math.pi * 2;
      _addBox(
        vm.Vector3(.72, .18, .72),
        vm.Vector3(math.sin(angle) * 3.35, .42, math.cos(angle) * 3.35),
        const Color(0xFF171A1D),
        roughness: .35,
        metallic: .18,
      );
    }
    _addBox(
      vm.Vector3(5.8, 1.9, .10),
      vm.Vector3(0, 2.55, -4.28),
      const Color(0xFF101A1D),
      roughness: .12,
      metallic: .45,
    );
  }

  void _addTheaterFurniture(bool realistic) {
    // Large native 3D TV. This is the primary Theater interaction.
    final screen = Node(
      name: 'prop:primary',
      mesh: Mesh(
        CuboidGeometry(vm.Vector3(5.9, 3.15, .12)),
        _pbr(
          const Color(0xFF050708),
          roughness: realistic ? .08 : .24,
          metallic: realistic ? .55 : .18,
        ),
      ),
      localTransform: vm.Matrix4.translation(vm.Vector3(0, 2.35, -4.24)),
    );
    screen.addComponent(
      SemanticsComponent(
        label: widget.primarySurfaceLabel ??
            'Theater screen. Activate to watch inside CHE.',
        hint: widget.onPrimarySurfaceTap == null
            ? null
            : 'Activate to open the in-app Theater player',
        button: widget.onPrimarySurfaceTap != null,
        onTap: widget.onPrimarySurfaceTap,
      ),
    );
    _scene.add(screen);

    for (final x in const [-4.35, 4.35]) {
      _addBox(
        vm.Vector3(.8, 2.5, .8),
        vm.Vector3(x, 1.25, -3.85),
        const Color(0xFF111214),
        roughness: .32,
      );
    }
    for (var row = 0; row < 2; row++) {
      for (var col = 0; col < 3; col++) {
        _addBox(
          vm.Vector3(1.45, .62, .92),
          vm.Vector3((col - 1) * 2.0, .36, 1.4 + row * 1.35),
          const Color(0xFF37261E),
          roughness: realistic ? .62 : .75,
        );
      }
    }
  }

  void _addStudioFurniture(bool realistic) {
    _addBox(
      vm.Vector3(5.5, .75, 1.55),
      vm.Vector3(0, .45, -2.0),
      const Color(0xFF20232A),
      roughness: realistic ? .18 : .42,
      metallic: realistic ? .38 : .12,
    );
    for (final x in const [-4.0, 4.0]) {
      _addBox(
        vm.Vector3(1.1, 2.4, 1.0),
        vm.Vector3(x, 1.2, -2.9),
        const Color(0xFF111216),
        roughness: .45,
      );
    }
  }

  void _addGalleryFurniture(bool realistic) {
    for (var i = 0; i < 5; i++) {
      _addBox(
        vm.Vector3(1.65, 1.8, .12),
        vm.Vector3((i - 2) * 2.25, 2.15, -4.25),
        i.isEven ? const Color(0xFFDBD3C6) : const Color(0xFF8E86FF),
        roughness: realistic ? .28 : .5,
      );
    }
    _addBox(
      vm.Vector3(4.8, .22, 1.0),
      vm.Vector3(0, .45, 1.5),
      const Color(0xFF342F28),
      roughness: .62,
    );
  }

  void _addWorkshopFurniture(bool realistic) {
    for (final x in const [-3.7, 0.0, 3.7]) {
      _addBox(
        vm.Vector3(2.55, .85, 1.15),
        vm.Vector3(x, .48, -1.2),
        const Color(0xFF172025),
        roughness: realistic ? .24 : .48,
        metallic: realistic ? .32 : .12,
      );
    }
  }

  void _addMarketsFurniture(bool realistic) {
    _addBox(
      vm.Vector3(7.8, .72, 1.25),
      vm.Vector3(0, .42, -.6),
      const Color(0xFF11181C),
      roughness: .24,
      metallic: realistic ? .42 : .16,
    );
    for (var i = 0; i < 4; i++) {
      _addBox(
        vm.Vector3(1.65, 1.05, .10),
        vm.Vector3((i - 1.5) * 2.05, 1.55, -1.18),
        const Color(0xFF081014),
        roughness: .10,
        metallic: .35,
      );
    }
  }

  void _addBusinessFurniture(bool realistic) {
    for (var i = 0; i < 4; i++) {
      _addBox(
        vm.Vector3(2.1, .8, 1.15),
        vm.Vector3((i - 1.5) * 2.65, .45, -.8),
        const Color(0xFF152025),
        roughness: realistic ? .25 : .48,
        metallic: .16,
      );
    }
  }

  void _addOfficeFurniture(bool realistic) {
    for (var row = 0; row < 2; row++) {
      for (var col = 0; col < 4; col++) {
        _addBox(
          vm.Vector3(1.55, .72, .92),
          vm.Vector3((col - 1.5) * 2.25, .38, (row - .55) * 2.25),
          const Color(0xFF172126),
          roughness: realistic ? .24 : .46,
          metallic: realistic ? .28 : .10,
        );
      }
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

    final actionable = widget.onEntityTap != null;
    root.addComponent(
      SemanticsComponent(
        label: entity.description.isEmpty
            ? entity.label
            : entity.label + '. ' + entity.description,
        hint: actionable ? 'Activate to open this item' : null,
        button: actionable,
        sortOrder: index.toDouble(),
        onTap: actionable ? () => widget.onEntityTap!(entity.id) : null,
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
    final look = entity.appearance;
    final bodyColor = _outfitColor(look, entity.color);
    final skin = _skinToneColor(look);
    final dark = const Color(0xFF14191B);

    switch ('${look['body_type'] ?? 'standard'}') {
      case 'compact':
        root.scale = vm.Vector3(.92, .92, .92);
        break;
      case 'tall':
        root.scale = vm.Vector3(.96, 1.08, .96);
        break;
    }

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
    _addCharacterDetails(root, look, segments, realistic);

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

  Color _skinToneColor(Map<String, dynamic> look) {
    return switch ('${look['skin_tone'] ?? ''}'.toLowerCase()) {
      'deep' => const Color(0xFF4A2418),
      'brown' => const Color(0xFF74432D),
      'warm' => const Color(0xFF9A6245),
      'tan' => const Color(0xFFB9825E),
      'golden' => const Color(0xFFC99666),
      'light' => const Color(0xFFE0B395),
      _ => const Color(0xFFB77A5D),
    };
  }

  Color _outfitColor(Map<String, dynamic> look, Color fallback) {
    return switch ('${look['outfit'] ?? ''}'.toLowerCase()) {
      'suit' => const Color(0xFF202B34),
      'jacket-red' => const Color(0xFF9E2F3B),
      'jacket-teal' => const Color(0xFF177C76),
      'hoodie' => const Color(0xFF3A4148),
      'studio' => const Color(0xFF7D285A),
      'tech' => const Color(0xFF243D58),
      'che' => const Color(0xFF1F8F84),
      _ => fallback,
    };
  }

  void _addCharacterDetails(
    Node root,
    Map<String, dynamic> look,
    int segments,
    bool realistic,
  ) {
    final hair = '${look['hair'] ?? ''}'.toLowerCase();
    if (hair.isNotEmpty && hair != 'bald' && hair != 'close') {
      final scale = hair == 'bun' ? vm.Vector3(.23, .23, .23) : vm.Vector3(.29, .18, .29);
      final hairNode = Node(
        mesh: Mesh(
          SphereGeometry(
            radius: 1,
            segments: math.max(10, segments ~/ 2),
            rings: math.max(8, segments ~/ 3),
          ),
          _pbr(const Color(0xFF171311), roughness: realistic ? .46 : .68),
        ),
        localTransform: vm.Matrix4.compose(
          vm.Vector3(0, hair == 'bun' ? 1.94 : 1.83, -.03),
          vm.Quaternion.identity(),
          scale,
        ),
      );
      root.add(hairNode);
    }

    final accessory = '${look['accessory'] ?? ''}'.toLowerCase();
    if (accessory == 'chain') {
      root.add(
        Node(
          mesh: Mesh(
            TorusGeometry(
              radius: .20,
              tubeRadius: .025,
              radialSegments: math.max(12, segments),
              tubularSegments: 6,
            ),
            _pbr(
              const Color(0xFFD8A72D),
              roughness: .22,
              metallic: .82,
            ),
          ),
          localTransform: vm.Matrix4.translation(vm.Vector3(0, 1.26, .20)),
        ),
      );
    } else if (accessory == 'hat') {
      root.add(
        Node(
          mesh: Mesh(
            CylinderGeometry(
              bottomRadius: .34,
              topRadius: .30,
              height: .14,
              radialSegments: math.max(12, segments),
            ),
            _pbr(const Color(0xFF171A1D), roughness: .48),
          ),
          localTransform: vm.Matrix4.translation(vm.Vector3(0, 1.91, 0)),
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
    var index = 0;
    for (final link in widget.links) {
      if (!visibleIds.contains(link.from) || !visibleIds.contains(link.to)) {
        continue;
      }
      final a = _basePositions[link.from];
      final b = _basePositions[link.to];
      if (a == null || b == null) continue;

      final delta = b - a;
      if (delta.length2 < 0.0001) continue;
      var sideways = delta.cross(vm.Vector3(0, 1, 0));
      if (sideways.length2 < 0.0001) {
        sideways = delta.cross(vm.Vector3(1, 0, 0));
      }
      if (sideways.length2 > 0.0001) sideways.normalize();
      final bend = .12 + (index % 7) * .025;
      final midpoint = (a + b) * .5 +
          sideways * bend +
          vm.Vector3(0, math.sin(index * .91) * .10, 0);
      final path = CatmullRomPath([a, midpoint, b]);

      final material = PhysicallyBasedMaterial()
        ..baseColorFactor = vm.Vector4(.018, .26, .25, 1)
        ..metallicFactor = .08
        ..roughnessFactor = .42
        ..emissiveFactor = vm.Vector4(.03, .86, .78, 1)
        ..emissiveStrength =
            widget.quality == CheSceneQuality.realistic ? 1.8 : 1.35;
      _brainLinkMaterials.add(material);

      final radius = switch (widget.quality) {
        CheSceneQuality.performance => .010,
        CheSceneQuality.balanced => .014,
        CheSceneQuality.realistic => .018,
      };
      final radialSegments = switch (widget.quality) {
        CheSceneQuality.performance => 4,
        CheSceneQuality.balanced => 6,
        CheSceneQuality.realistic => 8,
      };
      final stations = switch (widget.quality) {
        CheSceneQuality.performance => 8,
        CheSceneQuality.balanced => 12,
        CheSceneQuality.realistic => 18,
      };
      _scene.add(
        Node(
          name: 'brain-link:' + link.from + ':' + link.to,
          mesh: Mesh(
            TubeGeometry(
              path,
              radius: radius,
              radialSegments: radialSegments,
              stations: stations,
              caps: true,
            ),
            material,
          ),
        ),
      );
      index++;
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
    if (widget.mode == CheSceneMode.office ||
        widget.mode == CheSceneMode.workshop ||
        widget.mode == CheSceneMode.markets ||
        widget.mode == CheSceneMode.pipeline ||
        widget.mode == CheSceneMode.store ||
        widget.mode == CheSceneMode.creator ||
        widget.mode == CheSceneMode.musicStudio ||
        widget.mode == CheSceneMode.artStudio ||
        widget.mode == CheSceneMode.projects) {
      const cols = 4;
      final row = index ~/ cols;
      final col = index % cols;
      return vm.Vector3(
        (col - 1.5) * 2.25,
        .35,
        (row - .65) * 2.25,
      );
    }

    if (widget.mode == CheSceneMode.theater) {
      final col = index % 3;
      final row = index ~/ 3;
      return vm.Vector3((col - 1) * 2.0, .35, 1.4 + row * 1.35);
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
    final media = MediaQuery.maybeOf(context);
    if (media?.disableAnimations == true ||
        media?.accessibleNavigation == true) {
      return;
    }

    _elapsed += deltaSeconds;
    for (var i = 0; i < _brainLinkMaterials.length; i++) {
      final wave = .5 + .5 * math.sin(_elapsed * 2.15 + i * .37);
      _brainLinkMaterials[i].emissiveStrength =
          (widget.quality == CheSceneQuality.realistic ? 1.45 : 1.05) +
              wave * (widget.quality == CheSceneQuality.realistic ? 1.35 : .9);
    }

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
      if (name == 'prop:primary' && widget.onPrimarySurfaceTap != null) {
        HapticFeedback.selectionClick();
        widget.onPrimarySurfaceTap!();
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
