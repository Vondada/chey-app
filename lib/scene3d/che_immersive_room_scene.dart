import 'dart:math' as math;

import 'package:flutter/material.dart' hide Material;
import 'package:flutter/services.dart';
import 'package:flutter_scene/scene.dart' hide Material;
import 'package:vector_math/vector_math.dart' as vm;

import 'che_scene_quality.dart';

enum CheImmersiveRoomKind {
  office,
  warRoom,
  theater,
  art,
  music,
  workshop,
  markets,
  pipeline,
  store,
  creator,
}

class CheImmersiveRoomAgent {
  const CheImmersiveRoomAgent({
    required this.id,
    required this.name,
    required this.role,
    this.status = 'idle',
    this.task = '',
    this.isChe = false,
    this.appearance = const {},
  });

  final String id;
  final String name;
  final String role;
  final String status;
  final String task;
  final bool isChe;
  final Map<String, dynamic> appearance;
}

class CheImmersiveRoomScene extends StatefulWidget {
  const CheImmersiveRoomScene({
    super.key,
    required this.kind,
    this.agents = const [],
    this.quality = CheSceneQuality.immersive,
    this.onObjectTap,
    this.height = 380,
    this.semanticsLabel,
  });

  final CheImmersiveRoomKind kind;
  final List<CheImmersiveRoomAgent> agents;
  final CheSceneQuality quality;
  final ValueChanged<String>? onObjectTap;
  final double height;
  final String? semanticsLabel;

  @override
  State<CheImmersiveRoomScene> createState() => _CheImmersiveRoomSceneState();
}

class _CheImmersiveRoomSceneState extends State<CheImmersiveRoomScene> {
  Scene? _scene;
  Camera? _lastCamera;
  Size _viewSize = Size.zero;
  String? _error;
  String? _fingerprint;
  int _generation = 0;

  final List<Node> _animated = [];
  final Map<Node, double> _animatedBaseY = {};
  double _azimuth = 0.52;
  double _elevation = 0.26;
  double _radius = 15.5;
  double _scaleStartRadius = 15.5;

  @override
  void initState() {
    super.initState();
    _rebuild();
  }

  @override
  void didUpdateWidget(covariant CheImmersiveRoomScene oldWidget) {
    super.didUpdateWidget(oldWidget);
    final next = _makeFingerprint();
    if (next != _fingerprint) _rebuild();
  }

  @override
  void dispose() {
    _scene?.removeAll();
    super.dispose();
  }

  String _makeFingerprint() {
    final agents = widget.agents
        .map((a) => '${a.id}|${a.name}|${a.role}|${a.status}|${a.task}|${a.appearance}')
        .join(';');
    return '${widget.kind.name}|${widget.quality.name}|$agents';
  }

  Future<void> _rebuild() async {
    final generation = ++_generation;
    final fingerprint = _makeFingerprint();
    try {
      await Scene.initializeStaticResources();
      if (!mounted || generation != _generation) return;
      final scene = Scene();
      _configureScene(scene);
      _animated.clear();
      _animatedBaseY.clear();
      _buildRoom(scene);
      _addAgents(scene);
      if (!mounted || generation != _generation) {
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
      if (!mounted || generation != _generation) return;
      setState(() {
        _scene = null;
        _error = 'Native 3D room unavailable: $e';
        _fingerprint = fingerprint;
      });
    }
  }

  void _configureScene(Scene scene) {
    scene.exposure = switch (widget.quality) {
      CheSceneQuality.efficient => 1.0,
      CheSceneQuality.immersive => 1.08,
      CheSceneQuality.realistic => 1.14,
    };
    scene.antiAliasingMode = switch (widget.quality) {
      CheSceneQuality.efficient => AntiAliasingMode.fxaa,
      CheSceneQuality.immersive => AntiAliasingMode.auto,
      CheSceneQuality.realistic => AntiAliasingMode.msaa,
    };
    scene.directionalLight = DirectionalLight(
      direction: vm.Vector3(-0.35, -1, -0.3),
      color: vm.Vector3(0.92, 0.97, 1),
      intensity: widget.quality == CheSceneQuality.realistic ? 3.4 : 2.6,
      castsShadow: widget.quality != CheSceneQuality.efficient,
      shadowMapResolution: widget.quality == CheSceneQuality.realistic ? 1024 : 512,
      contactShadows: widget.quality == CheSceneQuality.realistic,
    );

    scene.postProcess.bloom
      ..enabled = true
      ..threshold = 0.72
      ..intensity = widget.quality == CheSceneQuality.efficient ? 0.22 : 0.36
      ..scatter = 0.65;
    scene.postProcess.vignette
      ..enabled = true
      ..intensity = 0.26
      ..radius = 0.88
      ..smoothness = 0.58;
    scene.postProcess.colorGrading
      ..enabled = true
      ..brightness = 0.96
      ..contrast = 1.06
      ..saturation = 1.02;
  }

  vm.Vector3 get _accent => switch (widget.kind) {
        CheImmersiveRoomKind.office => vm.Vector3(0.15, 0.9, 0.78),
        CheImmersiveRoomKind.warRoom => vm.Vector3(0.92, 0.60, 0.18),
        CheImmersiveRoomKind.theater => vm.Vector3(0.95, 0.14, 0.28),
        CheImmersiveRoomKind.art => vm.Vector3(1.0, 0.40, 0.20),
        CheImmersiveRoomKind.music => vm.Vector3(0.20, 0.75, 1.0),
        CheImmersiveRoomKind.workshop => vm.Vector3(0.18, 0.90, 0.78),
        CheImmersiveRoomKind.markets => vm.Vector3(0.20, 0.95, 0.58),
        CheImmersiveRoomKind.pipeline => vm.Vector3(0.38, 0.62, 1.0),
        CheImmersiveRoomKind.store => vm.Vector3(0.20, 0.90, 0.72),
        CheImmersiveRoomKind.creator => vm.Vector3(1.0, 0.16, 0.54),
      };

  PhysicallyBasedMaterial _material(
    vm.Vector3 color, {
    double metallic = 0.05,
    double roughness = 0.52,
    double emissive = 0,
    double alpha = 1,
  }) {
    final material = PhysicallyBasedMaterial()
      ..baseColorFactor = vm.Vector4(color.x, color.y, color.z, alpha)
      ..metallicFactor = metallic
      ..roughnessFactor = roughness;
    if (emissive > 0) {
      material
        ..emissiveFactor = vm.Vector4(color.x, color.y, color.z, 1)
        ..emissiveStrength = emissive;
    }
    if (alpha < 1) material.alphaMode = AlphaMode.blend;
    return material;
  }

  Node _box(
    Scene scene,
    String name,
    vm.Vector3 size,
    vm.Vector3 position,
    PhysicallyBasedMaterial material, {
    bool interactive = false,
    String? label,
    String? hint,
  }) {
    final node = Node(name: interactive ? 'action:$name' : name, mesh: Mesh(CuboidGeometry(size), material));
    node.position = position;
    if (interactive) {
      node.addComponent(
        SemanticsComponent(
          label: label ?? name,
          hint: hint ?? 'Activate',
          button: true,
          onTap: () => _activate(name),
        ),
      );
    }
    scene.add(node);
    return node;
  }

  void _buildShell(Scene scene, {vm.Vector3? wallColor, vm.Vector3? floorColor}) {
    final wall = _material(wallColor ?? vm.Vector3(0.035, 0.045, 0.055), metallic: 0.08, roughness: 0.74);
    final floor = _material(floorColor ?? vm.Vector3(0.055, 0.06, 0.065), metallic: 0.16, roughness: 0.38);
    _box(scene, 'floor', vm.Vector3(12.8, 0.28, 10.5), vm.Vector3(0, -0.58, 0), floor);
    _box(scene, 'back-wall', vm.Vector3(12.8, 6.4, 0.26), vm.Vector3(0, 2.48, 5.05), wall);
    _box(scene, 'left-wall', vm.Vector3(0.25, 6.4, 10.5), vm.Vector3(-6.27, 2.48, 0), wall);
    _box(scene, 'right-wall', vm.Vector3(0.25, 6.4, 10.5), vm.Vector3(6.27, 2.48, 0), wall);

    final accent = _material(_accent, metallic: 0.18, roughness: 0.28, emissive: 2.4);
    _box(scene, 'accent-left', vm.Vector3(0.07, 0.07, 9.6), vm.Vector3(-6.08, 5.1, 0), accent);
    _box(scene, 'accent-right', vm.Vector3(0.07, 0.07, 9.6), vm.Vector3(6.08, 5.1, 0), accent);
    _box(scene, 'accent-back', vm.Vector3(11.7, 0.07, 0.07), vm.Vector3(0, 5.1, 4.86), accent);
  }

  void _buildRoom(Scene scene) {
    switch (widget.kind) {
      case CheImmersiveRoomKind.theater:
        _buildTheater(scene);
        break;
      case CheImmersiveRoomKind.warRoom:
        _buildWarRoom(scene);
        break;
      case CheImmersiveRoomKind.office:
        _buildOffice(scene);
        break;
      case CheImmersiveRoomKind.art:
        _buildArt(scene);
        break;
      case CheImmersiveRoomKind.music:
      case CheImmersiveRoomKind.creator:
        _buildStudio(scene);
        break;
      case CheImmersiveRoomKind.workshop:
        _buildWorkshop(scene);
        break;
      case CheImmersiveRoomKind.markets:
        _buildMarkets(scene);
        break;
      case CheImmersiveRoomKind.pipeline:
        _buildPipeline(scene);
        break;
      case CheImmersiveRoomKind.store:
        _buildStore(scene);
        break;
    }
  }

  void _buildTheater(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.025, 0.01, 0.018), floorColor: vm.Vector3(0.035, 0.012, 0.02));
    final screen = _material(vm.Vector3(0.01, 0.015, 0.022), metallic: 0.42, roughness: 0.18);
    final frame = _material(vm.Vector3(0.12, 0.13, 0.15), metallic: 0.8, roughness: 0.2);
    final glow = _material(_accent, roughness: 0.24, emissive: 2.8);
    _box(scene, 'theater-screen-frame', vm.Vector3(8.3, 4.75, 0.22), vm.Vector3(0, 2.42, 4.72), frame);
    _box(
      scene,
      'theater:screen',
      vm.Vector3(7.8, 4.28, 0.16),
      vm.Vector3(0, 2.42, 4.54),
      screen,
      interactive: true,
      label: 'Theater screen. Open CHE in-app TV.',
      hint: 'Activate to open the in-CHE web video player without leaving CHE.',
    );
    _box(scene, 'theater-screen-glow', vm.Vector3(8.05, 0.055, 0.07), vm.Vector3(0, 0.22, 4.40), glow);
    final seat = _material(vm.Vector3(0.12, 0.025, 0.045), metallic: 0.04, roughness: 0.62);
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 5; col++) {
        _box(
          scene,
          'seat-$row-$col',
          vm.Vector3(1.0, 0.62, 0.82),
          vm.Vector3((col - 2) * 1.32, 0.0 + row * 0.12, -0.8 - row * 1.35),
          seat,
        );
      }
    }
  }

  void _buildWarRoom(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.025, 0.032, 0.04), floorColor: vm.Vector3(0.045, 0.052, 0.06));
    final glass = _material(vm.Vector3(0.12, 0.22, 0.26), metallic: 0.15, roughness: 0.12, alpha: 0.34);
    final rim = _material(_accent, metallic: 0.38, roughness: 0.22, emissive: 1.8);
    _box(scene, 'war-table', vm.Vector3(6.8, 0.22, 3.0), vm.Vector3(0, 0.62, 0.35), glass);
    _box(scene, 'war-table-rim-front', vm.Vector3(6.9, 0.08, 0.08), vm.Vector3(0, 0.78, -1.16), rim);
    _box(scene, 'war-table-rim-back', vm.Vector3(6.9, 0.08, 0.08), vm.Vector3(0, 0.78, 1.86), rim);
    final wallScreen = _material(vm.Vector3(0.02, 0.035, 0.05), metallic: 0.28, roughness: 0.22, emissive: 0.25);
    _box(scene, 'war-screen', vm.Vector3(6.2, 2.8, 0.14), vm.Vector3(0, 2.65, 4.65), wallScreen);
    for (var i = 0; i < 8; i++) {
      final angle = i / 8 * math.pi * 2;
      final p = vm.Vector3(math.sin(angle) * 4.1, 0.0, math.cos(angle) * 2.45 + 0.35);
      _box(scene, 'war-chair-$i', vm.Vector3(0.75, 0.85, 0.75), p, _material(vm.Vector3(0.22, 0.15, 0.07), roughness: 0.58));
    }
  }

  void _buildOffice(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.045, 0.055, 0.065), floorColor: vm.Vector3(0.12, 0.11, 0.095));
    final desk = _material(vm.Vector3(0.24, 0.16, 0.09), metallic: 0.03, roughness: 0.58);
    final monitor = _material(vm.Vector3(0.01, 0.025, 0.03), metallic: 0.38, roughness: 0.2, emissive: 0.35);
    for (var i = 0; i < 6; i++) {
      final x = (i % 3 - 1) * 3.5;
      final z = (i ~/ 3) * 3.0 - 1.2;
      _box(scene, 'desk-$i', vm.Vector3(2.5, 0.18, 1.25), vm.Vector3(x, 0.38, z), desk);
      _box(scene, 'monitor-$i', vm.Vector3(1.15, 0.75, 0.08), vm.Vector3(x, 1.05, z + 0.18), monitor);
    }
  }

  void _buildArt(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.16, 0.105, 0.065), floorColor: vm.Vector3(0.15, 0.10, 0.06));
    final frame = _material(vm.Vector3(0.24, 0.14, 0.06), metallic: 0.05, roughness: 0.48);
    final colors = [
      vm.Vector3(0.88, 0.12, 0.18),
      vm.Vector3(0.10, 0.45, 0.90),
      vm.Vector3(0.92, 0.48, 0.08),
      vm.Vector3(0.35, 0.10, 0.70),
    ];
    for (var i = 0; i < 4; i++) {
      final x = (i - 1.5) * 2.7;
      _box(scene, 'art-frame-$i', vm.Vector3(2.0, 2.45, 0.18), vm.Vector3(x, 2.55, 4.72), frame);
      _box(scene, 'art-canvas-$i', vm.Vector3(1.72, 2.16, 0.12), vm.Vector3(x, 2.55, 4.58), _material(colors[i], roughness: 0.5, emissive: 0.18));
    }
    _box(scene, 'art-table', vm.Vector3(5.0, 0.18, 2.0), vm.Vector3(0, 0.35, -1.2), _material(vm.Vector3(0.28, 0.18, 0.10), roughness: 0.6));
  }

  void _buildStudio(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.025, 0.012, 0.03), floorColor: vm.Vector3(0.04, 0.018, 0.045));
    final panel = _material(vm.Vector3(0.02, 0.02, 0.025), metallic: 0.42, roughness: 0.24);
    final neon = _material(_accent, roughness: 0.24, emissive: 2.6);
    _box(scene, 'studio-console', vm.Vector3(7.2, 0.35, 2.0), vm.Vector3(0, 0.4, -0.2), panel);
    _box(scene, 'studio-display', vm.Vector3(5.4, 2.2, 0.14), vm.Vector3(0, 2.45, 4.65), panel);
    _box(scene, 'studio-neon', vm.Vector3(5.8, 0.06, 0.08), vm.Vector3(0, 3.75, 4.45), neon);
    for (final x in [-4.7, 4.7]) {
      _box(scene, 'speaker-$x', vm.Vector3(1.2, 2.6, 1.0), vm.Vector3(x, 1.0, 2.8), _material(vm.Vector3(0.055, 0.055, 0.065), metallic: 0.25, roughness: 0.3));
    }
  }

  void _buildWorkshop(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.035, 0.045, 0.045), floorColor: vm.Vector3(0.07, 0.07, 0.065));
    final bench = _material(vm.Vector3(0.18, 0.12, 0.07), roughness: 0.6);
    for (final z in [-1.8, 1.0]) {
      _box(scene, 'workbench-$z', vm.Vector3(8.2, 0.25, 1.25), vm.Vector3(0, 0.42, z), bench);
    }
    final screen = _material(vm.Vector3(0.01, 0.025, 0.028), metallic: 0.4, roughness: 0.18, emissive: 0.3);
    for (var i = 0; i < 4; i++) {
      _box(scene, 'work-monitor-$i', vm.Vector3(1.25, 0.8, 0.08), vm.Vector3((i - 1.5) * 2.0, 1.25, 1.0), screen);
    }
  }

  void _buildMarkets(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.012, 0.02, 0.025), floorColor: vm.Vector3(0.025, 0.032, 0.035));
    final display = _material(vm.Vector3(0.01, 0.028, 0.025), metallic: 0.35, roughness: 0.18, emissive: 0.45);
    _box(scene, 'market-wall', vm.Vector3(9.4, 3.45, 0.12), vm.Vector3(0, 2.5, 4.65), display);
    final desk = _material(vm.Vector3(0.05, 0.07, 0.075), metallic: 0.28, roughness: 0.34);
    for (final x in [-3.4, 0.0, 3.4]) {
      _box(scene, 'market-desk-$x', vm.Vector3(2.6, 0.25, 1.3), vm.Vector3(x, 0.4, -0.6), desk);
      _box(scene, 'market-monitor-$x', vm.Vector3(1.7, 1.0, 0.08), vm.Vector3(x, 1.28, -0.2), display);
    }
  }

  void _buildPipeline(Scene scene) {
    _buildShell(scene);
    final panel = _material(vm.Vector3(0.025, 0.035, 0.055), metallic: 0.18, roughness: 0.32);
    final accent = _material(_accent, roughness: 0.25, emissive: 1.8);
    for (var i = 0; i < 4; i++) {
      _box(scene, 'pipeline-stage-$i', vm.Vector3(2.2, 2.8, 0.18), vm.Vector3((i - 1.5) * 2.8, 2.2, 4.65), panel);
      _box(scene, 'pipeline-light-$i', vm.Vector3(1.65, 0.07, 0.08), vm.Vector3((i - 1.5) * 2.8, 3.0, 4.45), accent);
    }
  }

  void _buildStore(Scene scene) {
    _buildShell(scene, wallColor: vm.Vector3(0.025, 0.04, 0.04), floorColor: vm.Vector3(0.055, 0.06, 0.055));
    final shelf = _material(vm.Vector3(0.12, 0.09, 0.055), roughness: 0.55);
    final product = _material(_accent, roughness: 0.3, emissive: 0.65);
    for (var i = 0; i < 3; i++) {
      final y = 0.65 + i * 1.25;
      _box(scene, 'store-shelf-$i', vm.Vector3(8.8, 0.12, 0.72), vm.Vector3(0, y, 4.2), shelf);
      for (var j = 0; j < 6; j++) {
        _box(scene, 'store-product-$i-$j', vm.Vector3(0.72, 0.82, 0.48), vm.Vector3((j - 2.5) * 1.28, y + 0.48, 3.95), product);
      }
    }
    _box(scene, 'store-counter', vm.Vector3(5.2, 1.0, 1.5), vm.Vector3(0, 0.0, -1.9), shelf);
  }

  void _addAgents(Scene scene) {
    final agents = widget.agents.take(12).toList(growable: false);
    for (var i = 0; i < agents.length; i++) {
      final a = agents[i];
      final placement = _agentPosition(i, agents.length);
      final root = Node(name: 'action:agent:${a.id}');
      root.position = placement;
      final statusColor = _statusColor(a.status);
      final outfit = a.isChe ? _accent : statusColor;
      final body = Node(
        mesh: Mesh(
          CuboidGeometry(vm.Vector3(0.58, 1.0, 0.36)),
          _material(outfit, metallic: 0.08, roughness: 0.46, emissive: a.isChe ? 0.25 : 0.08),
        ),
      )..position = vm.Vector3(0, 0.65, 0);
      final head = Node(
        mesh: Mesh(
          SphereGeometry(
            radius: 0.34,
            segments: widget.quality.sphereSegments,
            rings: widget.quality.sphereRings,
          ),
          _material(_skinColor(a.appearance), roughness: 0.58),
        ),
      )..position = vm.Vector3(0, 1.48, 0);
      root
        ..add(body)
        ..add(head)
        ..addComponent(
          SemanticsComponent(
            label: '${a.name}. ${a.role}. ${a.status}.',
            value: a.task.isEmpty ? null : a.task,
            hint: 'Activate to open this agent.',
            button: true,
            onTap: () => _activate('agent:${a.id}'),
          ),
        );
      scene.add(root);
      _animated.add(root);
      _animatedBaseY[root] = placement.y;
    }
  }

  vm.Vector3 _agentPosition(int index, int count) {
    if (widget.kind == CheImmersiveRoomKind.warRoom) {
      final angle = index / math.max(count, 1) * math.pi * 2;
      return vm.Vector3(math.sin(angle) * 4.0, 0.15, math.cos(angle) * 2.35 + 0.35);
    }
    if (widget.kind == CheImmersiveRoomKind.theater) {
      final row = index ~/ 5;
      final col = index % 5;
      return vm.Vector3((col - 2) * 1.32, 0.15 + row * 0.12, -0.8 - row * 1.35);
    }
    final col = index % 4;
    final row = index ~/ 4;
    return vm.Vector3((col - 1.5) * 2.5, 0.1, 0.5 - row * 2.25);
  }

  vm.Vector3 _statusColor(String status) {
    final s = status.toLowerCase();
    if (s.contains('block') || s.contains('offline')) return vm.Vector3(0.62, 0.12, 0.18);
    if (s.contains('think') || s.contains('review')) return vm.Vector3(0.45, 0.28, 0.92);
    if (s.contains('done') || s.contains('celebr')) return vm.Vector3(0.18, 0.86, 0.46);
    if (s.contains('work') || s.contains('talk') || s.contains('meet')) return _accent;
    return vm.Vector3(0.28, 0.34, 0.40);
  }

  vm.Vector3 _skinColor(Map<String, dynamic> appearance) {
    final tone = '${appearance['skin_tone'] ?? ''}'.toLowerCase();
    return switch (tone) {
      'deep' => vm.Vector3(0.20, 0.095, 0.055),
      'brown' => vm.Vector3(0.34, 0.16, 0.09),
      'warm' => vm.Vector3(0.50, 0.26, 0.15),
      'tan' => vm.Vector3(0.62, 0.36, 0.22),
      'golden' => vm.Vector3(0.70, 0.44, 0.26),
      'light' => vm.Vector3(0.82, 0.62, 0.48),
      _ => vm.Vector3(0.48, 0.26, 0.16),
    };
  }

  Camera _camera() {
    final target = widget.kind == CheImmersiveRoomKind.theater
        ? vm.Vector3(0, 1.3, 1.3)
        : vm.Vector3(0, 1.0, 0.8);
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
    for (var i = 0; i < _animated.length; i++) {
      final node = _animated[i];
      final base = node.position;
      final y = (_animatedBaseY[node] ?? base.y) + math.sin(t * 1.6 + i * 0.7) * 0.025;
      node.position = vm.Vector3(base.x, y, base.z);
    }
  }

  void _activate(String id) {
    HapticFeedback.selectionClick();
    widget.onObjectTap?.call(id);
  }

  void _pick(Offset point) {
    final scene = _scene;
    final camera = _lastCamera;
    if (scene == null || camera == null || _viewSize.isEmpty) return;
    final hit = scene.raycast(camera.screenPointToRay(point, _viewSize));
    if (hit == null) return;
    for (Node? node = hit.node; node != null; node = node.parent) {
      final name = node.name;
      if (name.startsWith('action:')) {
        _activate(name.substring('action:'.length));
        return;
      }
    }
  }

  void _onScaleStart(ScaleStartDetails details) {
    _scaleStartRadius = _radius;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    if (details.pointerCount >= 2) {
      _radius = (_scaleStartRadius / math.max(details.scale, 0.35)).clamp(4.5, 26.0).toDouble();
      return;
    }
    _azimuth -= details.focalPointDelta.dx * 0.006;
    _elevation = (_elevation + details.focalPointDelta.dy * 0.005).clamp(-0.15, 0.90).toDouble();
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    if (_error != null) {
      return SizedBox(
        height: widget.height,
        child: Semantics(
          liveRegion: true,
          label: _error,
          child: ColoredBox(
            color: Colors.black,
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
              ),
            ),
          ),
        ),
      );
    }
    if (scene == null) {
      return SizedBox(
        height: widget.height,
        child: const ColoredBox(color: Colors.black, child: Center(child: CircularProgressIndicator())),
      );
    }
    return SizedBox(
      height: widget.height,
      child: Semantics(
        container: true,
        label: widget.semanticsLabel ??
            '${widget.kind.name} immersive 3D room. Swipe one finger to look around and pinch to zoom.',
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: ColoredBox(
            color: Colors.black,
            child: LayoutBuilder(
              builder: (context, constraints) {
                _viewSize = constraints.biggest;
                return GestureDetector(
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
                    loadingBuilder: (context, progress) =>
                        const ColoredBox(color: Colors.black, child: Center(child: CircularProgressIndicator())),
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
