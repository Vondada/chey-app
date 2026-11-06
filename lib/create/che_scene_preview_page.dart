// CHE live scene preview (Creative Studio stage 2a, owner 2026-11-06: "I want to touch Nova to select her"). Shows the
// Scene Director's latest scene live in 3D with flutter_scene: the crew's real GLB models and clips at their place on the
// timeline, a scrubbable time slider and play/pause. Tapping an actor (finger or Apple Pencil) selects her; the panel's
// controls send plain words through /api/chat with the selection, so every touch edit is a versioned Scene Director
// edit with undo, re-rendered for real. The preview is a sketch of the scene; the rendered video is the result.

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math' as math;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_scene/scene.dart' hide Material;
import 'package:http/http.dart' as http;
import 'package:vector_math/vector_math.dart' as vm;

import 'che_scene_preview_model.dart';

/// The clips the preview binds on each actor (the crew GLBs carry all of them).
const _clipNames = ['idle', 'walk', 'sit', 'talk', 'wave', 'nod', 'think', 'celebrate', 'shake'];

class CheScenePreviewPage extends StatefulWidget {
  const CheScenePreviewPage({super.key, required this.baseUrl, required this.headers, this.client, this.onSpeak});

  final String baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  /// Speaks a reply aloud (the app's voice); used by Read Aloud and to report a touch edit's result.
  final void Function(String words)? onSpeak;

  /// While the page is open: "play", "pause", "go to 5 seconds", "select Nova", "read the scene", "options",
  /// "option 3", and scene edits ("make her outfit red", "move him left", "undo") sent with this scene and selection.
  /// Returns the spoken result, or null when the words are not for the preview (lib/home_state/send.dart).
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheScenePreviewPage> createState() => _CheScenePreviewPageState();
}

class _CheScenePreviewPageState extends State<CheScenePreviewPage> {
  late final http.Client _http = widget.client ?? http.Client();
  final TextEditingController _ask = TextEditingController();
  ScenePreviewSpec? _spec;
  String _status = 'Loading your scene…';
  String? _reply;
  double _t = 0;
  bool _playing = false;
  String? _selected;
  bool _sending = false;
  PointerDeviceKind _lastKind = PointerDeviceKind.touch;

  // The live 3D view. Widget tests have no Flutter GPU, so the page shows its controls and a text stand-in there.
  final bool _gpu = !Platform.environment.containsKey('FLUTTER_TEST');
  Scene? _scene;
  bool _sceneReady = false;
  Camera? _camera;
  Size _viewSize = Size.zero;
  double _orbit = 0;
  final Map<String, Node> _roots = {};
  final Map<String, Map<String, AnimationClip>> _clips = {};
  final Map<String, Map<String, double>> _clipEnds = {};
  final Map<String, Node> _rings = {};

  @override
  void initState() {
    super.initState();
    CheScenePreviewPage.voiceHandler = voice;
    unawaited(_load());
  }

  @override
  void dispose() {
    if (CheScenePreviewPage.voiceHandler == voice) CheScenePreviewPage.voiceHandler = null;
    _ask.dispose();
    _scene?.removeAll();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/scene/latest'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      if (r.statusCode == 401 || r.statusCode == 403) throw StateError('pair this phone with CHE as the owner first');
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      final spec = ScenePreviewSpec.fromLatest(body);
      if (!mounted) return;
      setState(() {
        _spec = spec;
        _status = spec == null ? '${body['detail'] ?? 'There is no scene yet.'}' : '${spec.title}, version ${spec.version}. ${_renderLine(spec)}';
        _t = spec == null ? 0 : _t.clamp(0, spec.seconds).toDouble();
        if (spec != null && _selected != null && spec.actor(_selected!) == null) _selected = null;
      });
      if (spec != null && _gpu) await _buildScene(spec);
    } catch (e) {
      if (mounted) setState(() => _status = 'Could not load the scene: $e');
    }
  }

  /// What is on screen, for Read Aloud and "read the scene".
  String describe() {
    final spec = _spec;
    if (spec == null) return _status;
    final who = spec.actors.map((a) => a.name).join(', ');
    final sel = _selected == null ? 'Nobody is selected.' : '${spec.actor(_selected!)?.name ?? _selected} is selected.';
    final pose = spec.actors.isEmpty ? null : spec.poseAt(spec.actors.first.id, _t);
    final doing = pose == null ? '' : ' At ${_t.toStringAsFixed(1)} of ${spec.seconds.toStringAsFixed(1)} seconds, ${spec.actors.first.name} is ${_doing(pose)}.';
    return 'Scene preview. $_status In the scene: $who. ${_playing ? 'Playing.' : 'Paused.'}$doing $sel Say "options" to hear what you can do.';
  }

  String _doing(SceneActorPose p) => switch (p.clip) {
        'walk' => 'walking',
        'sit' => p.line == null ? 'sitting' : 'sitting and talking',
        'talk' => 'talking',
        'idle' => 'standing',
        _ => p.clip,
      };

  String _options() {
    final list = scenePreviewOptions(_spec);
    return 'You can say: ${[for (var i = 0; i < list.length; i++) '${i + 1}, ${list[i]}'].join('; ')}. Or say a change, like "make her outfit red".';
  }

  void _seek(double seconds) {
    final spec = _spec;
    setState(() {
      _t = spec == null ? 0 : seconds.clamp(0, spec.seconds).toDouble();
      _playing = false;
    });
    _pose();
  }

  /// The preview's voice commands (see [CheScenePreviewPage.voiceHandler]).
  Future<String?> voice(String words) async {
    final command = scenePreviewCommand(words, _spec);
    if (command == null || !mounted) return null;
    final spec = _spec;
    switch (command.kind) {
      case ScenePreviewVoice.play:
        if (spec == null) return 'There is no scene to play yet.';
        setState(() => _playing = true);
        return 'Playing the scene.';
      case ScenePreviewVoice.pause:
        setState(() => _playing = false);
        return 'Paused at ${_t.toStringAsFixed(1)} seconds.';
      case ScenePreviewVoice.seek:
        if (spec == null) return 'There is no scene yet.';
        _seek(command.seconds ?? 0);
        return 'At ${_t.toStringAsFixed(1)} of ${spec.seconds.toStringAsFixed(1)} seconds.';
      case ScenePreviewVoice.select:
        setState(() => _selected = command.actor);
        _pose();
        HapticFeedback.selectionClick();
        final a = spec?.actor(command.actor ?? '');
        return a == null ? 'Nobody to select.' : '${a.name} is selected. Say a change, like "make ${a.possessive} outfit red" or "move ${a.objectPronoun} left".';
      case ScenePreviewVoice.deselect:
        setState(() => _selected = null);
        _pose();
        return 'Nobody is selected.';
      case ScenePreviewVoice.read:
        return describe();
      case ScenePreviewVoice.options:
        return _options();
      case ScenePreviewVoice.edit:
        if (spec == null) return null;
        return _send(command.words ?? words, spoken: true);
    }
  }

  String _renderLine(ScenePreviewSpec spec) {
    if (spec.renders.isEmpty) return 'Not rendered yet.';
    final r = spec.renders.first;
    return switch ('${r['status']}') {
      'ready' => 'Version ${r['version']} is rendered and in your media library.',
      'failed' => 'The last render failed; say "render it again".',
      _ => 'Version ${r['version']} is rendering on GitHub.',
    };
  }

  // ─── 3D ────────────────────────────────────────────────────────────────────

  Future<void> _buildScene(ScenePreviewSpec spec) async {
    try {
      if (_scene == null) {
        await Scene.initializeStaticResources();
        _scene = Scene();
      }
      final scene = _scene!;
      scene.removeAll();
      _roots.clear();
      _clips.clear();
      _clipEnds.clear();
      _rings.clear();
      _addOffice(scene, spec);
      for (final a in spec.actors) {
        final root = Node(name: 'actor:${a.id}');
        try {
          final model = await Node.fromGlbAsset(a.model);
          model.scale = vm.Vector3.all(a.scale);
          root.add(model);
          final clips = <String, AnimationClip>{};
          final ends = <String, double>{};
          for (final name in _clipNames) {
            final animation = model.findAnimationByName(name);
            if (animation == null) continue;
            clips[name] = model.createAnimationClip(animation)
              ..loop = name != 'sit'
              ..weight = 0;
            ends[name] = animation.endTime;
          }
          _clips[a.id] = clips;
          _clipEnds[a.id] = ends;
        } catch (_) {
          // No model: a plain marker stands in, still selectable.
          root.add(_box(vm.Vector3(.4, 1.6, .4), vm.Vector3(0, .8, 0), const Color(0xFF8E86FF)));
        }
        final ring = Node(
          name: 'ring:${a.id}',
          mesh: Mesh(CylinderGeometry(bottomRadius: .45, topRadius: .45, height: .02, radialSegments: 32), UnlitMaterial()..baseColorFactor = vm.Vector4(.0, .88, .8, 1)),
        )..visible = false;
        root.add(ring);
        _rings[a.id] = ring;
        scene.add(root);
        _roots[a.id] = root;
      }
      _pose();
      if (mounted) setState(() => _sceneReady = true);
    } catch (_) {
      if (mounted) setState(() => _sceneReady = false);
    }
  }

  Node _box(vm.Vector3 size, vm.Vector3 at, Color color, {String name = ''}) => Node(
        name: name,
        mesh: Mesh(CuboidGeometry(size), PhysicallyBasedMaterial()
          ..baseColorFactor = vm.Vector4(color.r, color.g, color.b, color.a)
          ..roughnessFactor = .6
          ..metallicFactor = 0),
        localTransform: vm.Matrix4.translation(at),
      );

  vm.Vector3 _v(double x, double y, double z) {
    final p = cheSceneToView(x, y, z);
    return vm.Vector3(p[0], p[1], p[2]);
  }

  /// The office the renderer builds, in boxes: floor, back and side walls, the desk and a chair at each seat.
  void _addOffice(Scene scene, ScenePreviewSpec spec) {
    scene.add(_box(vm.Vector3(14, .02, 14), _v(0, 0, -.01), const Color(0xFF5B4636)));
    scene.add(_box(vm.Vector3(14, 3.2, .1), _v(0, 3.2, 1.6), const Color(0xFFD9D2C5)));
    scene.add(_box(vm.Vector3(.1, 3.2, 4.6), _v(-3.6, -2.7, 1.6), const Color(0xFFD9D2C5)));
    scene.add(_box(vm.Vector3(.1, 3.2, 2.0), _v(-3.6, 2.2, 1.6), const Color(0xFFD9D2C5)));
    scene.add(_box(vm.Vector3(1.8, .06, .8), _v(.9, 1.5, .74), const Color(0xFF3B2A20)));
    for (final entry in spec.seats.entries) {
      final s = entry.value;
      var x = s[0];
      var y = s[1];
      // The chairs a moved actor sits in move with her (tools/che_scene_layout.py).
      for (final a in spec.actors) {
        if (spec.timeline.any((st) => st.actor == a.id && st.action == 'sit' && st.seat == entry.key)) {
          x += a.offset.isNotEmpty ? a.offset[0] : 0;
          y += a.offset.length > 1 ? a.offset[1] : 0;
        }
      }
      scene.add(_box(vm.Vector3(.55, .08, .55), _v(x, y + .17, .45), const Color(0xFF1F2A36), name: 'chair:${entry.key}'));
    }
    final key = Color(cheSceneLights[spec.light] ?? cheSceneLights['warm']!);
    scene.add(Node(localTransform: vm.Matrix4.translation(_v(-.5, -1.5, 2.8)))
      ..addComponent(PointLightComponent(PointLight(color: vm.Vector3(key.r, key.g, key.b), intensity: spec.light == 'night' ? 10 : 22, range: 14))));
  }

  /// Puts every actor where the timeline has them at [_t], with the clip that step plays.
  void _pose() {
    final spec = _spec;
    if (spec == null) return;
    for (final a in spec.actors) {
      final root = _roots[a.id];
      if (root == null) continue;
      final pose = spec.poseAt(a.id, _t);
      root.position = _v(pose.x, pose.y, 0);
      root.rotation = vm.Quaternion.axisAngle(vm.Vector3(0, 1, 0), pose.heading * math.pi / 180);
      final clips = _clips[a.id] ?? const {};
      final active = clips.containsKey(pose.clip) ? pose.clip : 'idle';
      for (final e in clips.entries) {
        final on = e.key == active;
        e.value.weight = on ? 1 : 0;
        e.value.playing = false;
        // A looping clip (walk, talk) repeats over a longer step; sit holds its last pose (seek clamps to the end).
        final end = _clipEnds[a.id]?[e.key] ?? 0;
        if (on) e.value.seek(e.value.loop && end > 0 ? pose.clipTime % end : pose.clipTime);
      }
      _rings[a.id]?.visible = _selected == a.id;
    }
  }

  void _tick(double dt) {
    final spec = _spec;
    if (!_playing || spec == null) return;
    var next = _t + dt;
    if (next > spec.seconds) next = 0;
    _t = next;
    _pose();
    if (mounted) setState(() {});
  }

  Camera _cameraNow() {
    // The renderer's opening shot (scene_director.js DEFAULT_CAMERA), turned by dragging.
    const target = [-1.3, .4, .85];
    final a = (26 + _orbit) * math.pi / 180;
    return PerspectiveCamera(
      position: _v(target[0] + 6 * math.sin(a), target[1] - 6 * math.cos(a), 1.6),
      target: _v(target[0], target[1], target[2]),
    );
  }

  void _select(Offset at) {
    final scene = _scene;
    final camera = _camera;
    if (scene == null || camera == null || _viewSize.isEmpty) return;
    final hit = scene.raycast(camera.screenPointToRay(at, _viewSize));
    final names = <String>[];
    for (Node? node = hit?.node; node != null; node = node.parent) {
      names.add(node.name);
    }
    final id = cheSceneActorFromNodeNames(names);
    HapticFeedback.selectionClick();
    setState(() => _selected = id);
    _pose();
  }

  // ─── Edits: words through /api/chat, with the selection ────────────────────

  /// Sends [words] to CHE with this scene (and the selected actor, if any) and returns CHE's reply. A touch edit's
  /// result is spoken; a spoken edit's result is spoken by the voice navigator, so [spoken] skips it here.
  Future<String> _send(String words, {bool spoken = false}) async {
    final spec = _spec;
    if (spec == null) return 'There is no scene to change yet.';
    if (_sending) return 'CHE is still answering the last change.';
    setState(() {
      _sending = true;
      _reply = 'Asking CHE: "$words"…';
    });
    String said;
    try {
      final r = await _http
          .post(
            Uri.parse('${widget.baseUrl}/api/chat'),
            headers: {...widget.headers(), 'Content-Type': 'application/json'},
            body: jsonEncode({
              'message': words,
              'history': const <Object>[],
              'owner_mode': true,
              'agent_mode': 'chat',
              // Always the displayed project, so scene-wide controls reach it even after six hours; the actor only
              // when one is selected.
              'scene_selection': {'project_id': spec.projectId, if (_selected != null) 'actor': _selected},
              'client': const {'platform': 'flutter', 'voice_enabled': false, 'screen': 'scene_preview'},
            }),
          )
          .timeout(const Duration(seconds: 60));
      if (r.statusCode >= 300) throw StateError('HTTP ${r.statusCode}');
      final out = StringBuffer();
      for (final line in const LineSplitter().convert(r.body)) {
        try {
          final d = jsonDecode(line);
          if (d is Map && d['type'] == 'delta') out.write('${d['delta'] ?? ''}');
          if (d is Map && d['type'] == 'done' && out.isEmpty) out.write('${d['reply'] ?? ''}');
        } catch (_) {}
      }
      said = out.toString().trim();
      if (said.isEmpty) said = 'CHE did not answer, so nothing changed.';
    } catch (e) {
      said = 'The edit was not sent: $e.';
    }
    if (!mounted) return said;
    setState(() {
      _sending = false;
      _reply = said;
    });
    if (!spoken) widget.onSpeak?.call(said);
    await _load();
    return said;
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final spec = _spec;
    final selected = spec == null || _selected == null ? null : spec.actor(_selected!);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Scene preview'),
        actions: [IconButton(tooltip: 'Reload the scene', icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            // Passive status is readable but never announced on its own (AGENTS.md); Read Aloud speaks it on request.
            Text(_status),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                icon: const Icon(Icons.volume_up),
                label: const Text('Read aloud'),
                onPressed: () => widget.onSpeak?.call(describe()),
              ),
            ),
            const SizedBox(height: 8),
            _view(spec),
            if (spec != null) ...[
              Row(children: [
                IconButton(
                  tooltip: _playing ? 'Pause' : 'Play',
                  icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
                  onPressed: () => setState(() => _playing = !_playing),
                ),
                Expanded(
                  child: Slider(
                    label: '${_t.toStringAsFixed(1)} s',
                    semanticFormatterCallback: (v) => '${v.toStringAsFixed(1)} of ${spec.seconds.toStringAsFixed(1)} seconds',
                    value: _t.clamp(0, spec.seconds).toDouble(),
                    max: spec.seconds,
                    onChanged: (v) {
                      setState(() {
                        _t = v;
                        _playing = false;
                      });
                      _pose();
                    },
                  ),
                ),
                Text('${_t.toStringAsFixed(1)} s'),
              ]),
              Wrap(spacing: 8, children: [
                for (final a in spec.actors)
                  ChoiceChip(
                    label: Text(a.name),
                    selected: _selected == a.id,
                    onSelected: (on) {
                      setState(() => _selected = on ? a.id : null);
                      _pose();
                    },
                  ),
              ]),
            ],
            if (selected != null) _panel(selected),
            if (spec != null) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                for (final preset in cheSceneLights.keys)
                  ActionChip(
                    avatar: Icon(Icons.light_mode, size: 16, color: Color(cheSceneLights[preset]!)),
                    label: Text(preset),
                    tooltip: 'Relight the office: $preset',
                    onPressed: _sending ? null : () => _send(SceneEditWords.light(preset)),
                  ),
              ]),
              const SizedBox(height: 8),
              TextField(
                controller: _ask,
                enabled: !_sending,
                decoration: InputDecoration(
                  labelText: selected == null ? 'Tell CHE what to change' : 'Tell CHE what to change about ${selected.name}',
                  suffixIcon: IconButton(
                    tooltip: 'Send to CHE',
                    icon: const Icon(Icons.send),
                    onPressed: () {
                      final words = _ask.text.trim();
                      if (words.isEmpty) return;
                      _ask.clear();
                      _send(words);
                    },
                  ),
                ),
                onSubmitted: (v) {
                  if (v.trim().isEmpty) return;
                  _ask.clear();
                  _send(v.trim());
                },
              ),
              Row(children: [
                TextButton(onPressed: _sending ? null : () => _send('undo'), child: const Text('Undo')),
                TextButton(onPressed: _sending ? null : () => _send('redo'), child: const Text('Redo')),
                TextButton(onPressed: _sending ? null : () => _send('is my scene ready?'), child: const Text('Is it rendered?')),
              ]),
            ],
            // CHE's answer to an edit is spoken through onSpeak (or by the voice navigator), so it is not a live region too.
            if (_reply != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_reply!)),
          ],
        ),
      ),
    );
  }

  Widget _view(ScenePreviewSpec? spec) {
    final scene = _scene;
    if (!_gpu || scene == null || !_sceneReady || spec == null) {
      final pose = spec == null || spec.actors.isEmpty ? null : spec.poseAt(spec.actors.first.id, _t);
      return Container(
        height: 360,
        alignment: Alignment.center,
        color: const Color(0xFF05090A),
        child: Text(
          pose == null ? 'No scene to show yet.' : '${spec!.actors.first.name}: ${pose.clip} at ${_t.toStringAsFixed(1)} s',
          style: const TextStyle(color: Colors.white70),
        ),
      );
    }
    return Semantics(
      label: 'Live 3D preview of ${spec.title}. Tap a character to select them. Drag to turn the view.',
      child: SizedBox(
        height: 420,
        child: LayoutBuilder(builder: (context, constraints) {
          _viewSize = constraints.biggest;
          return Listener(
            // Apple Pencil and finger both select; the pointer kind decides what a long press does.
            onPointerDown: (e) => _lastKind = e.kind,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (d) => _select(d.localPosition),
              onLongPressStart: (d) {
                // A stylus long-press selects and opens the controls; a finger long-press does the same.
                _select(d.localPosition);
                if (_lastKind == PointerDeviceKind.stylus) HapticFeedback.mediumImpact();
              },
              onHorizontalDragUpdate: (d) => setState(() => _orbit = (_orbit - d.delta.dx * .3) % 360),
              child: SceneView(
                scene,
                cameraBuilder: (elapsed) => _camera = _cameraNow(),
                onTick: (elapsed, deltaSeconds) => _tick(deltaSeconds),
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _panel(SceneActor a) {
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${a.name} selected', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          const Text('Outfit'),
          Wrap(spacing: 6, children: [
            for (final c in cheSceneOutfitColours.entries)
              Semantics(
                button: true,
                label: 'Make ${a.possessive} outfit ${c.key}',
                child: InkWell(
                  onTap: _sending ? null : () => _send(SceneEditWords.outfit(a, c.key)),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(color: Color(c.value), shape: BoxShape.circle, border: Border.all(color: Colors.white54)),
                  ),
                ),
              ),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 4, children: [
            for (final d in ['left', 'right', 'closer', 'back'])
              OutlinedButton(onPressed: _sending ? null : () => _send(SceneEditWords.move(a, d)), child: Text('Move $d')),
            OutlinedButton(onPressed: _sending ? null : () => _send(SceneEditWords.size(a, bigger: true)), child: const Text('Bigger')),
            OutlinedButton(onPressed: _sending ? null : () => _send(SceneEditWords.size(a, bigger: false)), child: const Text('Smaller')),
          ]),
        ]),
      ),
    );
  }
}
