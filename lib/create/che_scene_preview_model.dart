// CHE live scene preview (Creative Studio stage 2a, owner 2026-11-06): the pure part. A Scene Director spec (the same
// JSON tools/che_scene_render.py draws in Blender) is turned into where each actor stands, which way they face and which
// of their real GLB clips plays at time t, so the app can scrub the scene live before the render is back. Touch edits
// are plain words sent through /api/chat, where the Scene Director versions them with undo; nothing is edited here.
//
// Coordinates follow the spec (metres, Blender's x right, y into the room, z up; headings in degrees about z, 0 faces
// the camera side). [cheSceneToView] turns them into flutter_scene's y-up space.

import 'dart:math' as math;

/// Crew members the director calls "her" (scene_director.js FEMALE); everyone else is "him".
const cheSceneFemale = {'che', 'nova', 'mira', 'sage', 'lyra', 'iris', 'vale'};

/// Outfit colours the director knows by name (scene_director.js COLORS), with the preview swatch colour.
const cheSceneOutfitColours = <String, int>{
  'red': 0xFFC0392B,
  'blue': 0xFF2E5FA8,
  'black': 0xFF151515,
  'white': 0xFFF2F2F2,
  'green': 0xFF2E8B57,
  'purple': 0xFF7D3C98,
  'gold': 0xFFC9A227,
};

/// The renderer's light presets (tools/che_scene_render.py LIGHTING), with the preview's key light colour.
const cheSceneLights = <String, int>{
  'warm': 0xFFFFE0B8,
  'cool': 0xFFD6E6FF,
  'morning': 0xFFFFF4E0,
  'sunset': 0xFFFFB27A,
  'night': 0xFF9FB4FF,
};

/// The seconds of a turn into a chair (8 frames at 24 fps), as the renderer keys it.
const _turnSeconds = 8 / 24;

class SceneActor {
  const SceneActor({required this.id, required this.model, required this.start, this.offset = const [0, 0], this.scale = 1, this.cloth});
  final String id;
  final String model;
  final List<double> start;
  final List<double> offset;
  final double scale;
  final String? cloth;

  String get objectPronoun => cheSceneFemale.contains(id) ? 'her' : 'him';
  String get possessive => cheSceneFemale.contains(id) ? 'her' : 'his';
  String get name => id == 'che' ? 'CHE' : '${id[0].toUpperCase()}${id.substring(1)}';
}

class SceneStep {
  const SceneStep({required this.actor, required this.action, required this.t0, required this.t1, this.to, this.seat, this.line});
  final String actor;
  final String action;
  final double t0;
  final double t1;
  final List<double>? to;
  final String? seat;
  final String? line;
}

/// Where an actor is at one moment: position (x, y), heading in degrees, the clip playing and how far into it.
class SceneActorPose {
  const SceneActorPose({required this.x, required this.y, required this.heading, required this.clip, required this.clipTime, this.seated = false, this.line});
  final double x;
  final double y;
  final double heading;
  final String clip;
  final double clipTime;
  final bool seated;
  final String? line;
}

/// Seconds into a clip that means "hold its last pose" (the player clamps a seek to the clip's end).
const cheSceneHoldEnd = 1e6;

List<double> _nums(Object? v) => [for (final x in (v is List ? v : const [])) (x as num).toDouble()];

class ScenePreviewSpec {
  const ScenePreviewSpec({
    required this.projectId,
    required this.title,
    required this.version,
    required this.seconds,
    required this.actors,
    required this.seats,
    required this.timeline,
    required this.light,
    required this.renders,
  });

  final String projectId;
  final String title;
  final int version;
  final double seconds;
  final List<SceneActor> actors;
  final Map<String, List<double>> seats;
  final List<SceneStep> timeline;
  final String light;
  final List<Map<String, dynamic>> renders;

  /// From the Worker's GET /api/scene/latest body; null when it holds no scene.
  static ScenePreviewSpec? fromLatest(Map<String, dynamic> body) {
    if (body['ok'] != true || body['spec'] is! Map) return null;
    final spec = Map<String, dynamic>.from(body['spec'] as Map);
    final set = spec['set'] is Map ? Map<String, dynamic>.from(spec['set'] as Map) : const <String, dynamic>{};
    return ScenePreviewSpec(
      projectId: '${body['project_id'] ?? ''}',
      title: '${body['title'] ?? spec['title'] ?? 'Scene'}',
      version: (body['version'] as num?)?.toInt() ?? 1,
      seconds: (spec['seconds'] as num?)?.toDouble() ?? 1,
      actors: [
        for (final a in (spec['actors'] as List? ?? const []))
          if (a is Map)
            SceneActor(
              id: '${a['id']}',
              model: '${a['model'] ?? 'assets/characters/crew/${a['id']}.glb'}',
              start: _nums(a['start']),
              offset: a['offset'] is List ? _nums(a['offset']) : const [0, 0],
              scale: (a['scale'] as num?)?.toDouble() ?? 1,
              cloth: a['cloth'] as String?,
            ),
      ],
      seats: {
        for (final e in (spec['seats'] is Map ? Map<String, dynamic>.from(spec['seats'] as Map) : const <String, dynamic>{}).entries) e.key: _nums(e.value),
      },
      timeline: [
        for (final s in (spec['timeline'] as List? ?? const []))
          if (s is Map)
            SceneStep(
              actor: '${s['actor']}',
              action: '${s['action']}',
              t0: (s['t0'] as num?)?.toDouble() ?? 0,
              t1: (s['t1'] as num?)?.toDouble() ?? 0,
              to: s['to'] is List ? _nums(s['to']) : null,
              seat: s['seat'] as String?,
              line: s['line'] as String?,
            ),
      ],
      light: '${set['light'] ?? 'warm'}',
      renders: [for (final r in (body['renders'] as List? ?? const [])) if (r is Map) Map<String, dynamic>.from(r)],
    );
  }

  SceneActor? actor(String id) {
    for (final a in actors) {
      if (a.id == id) return a;
    }
    return null;
  }

  /// The actor's pose at [t] seconds, following the renderer's rules: a walk goes in a straight line to its target,
  /// a sit turns to face the way the chair faces and holds the seated pose, talking while seated keeps the sit, and an
  /// offset moves the walk target and the chair (never the doorway the actor starts at).
  SceneActorPose poseAt(String actorId, double t) {
    final a = actor(actorId);
    if (a == null) return const SceneActorPose(x: 0, y: 0, heading: 0, clip: 'idle', clipTime: 0);
    final dx = a.offset.isNotEmpty ? a.offset[0] : 0.0;
    final dy = a.offset.length > 1 ? a.offset[1] : 0.0;
    var x = a.start.isNotEmpty ? a.start[0] : 0.0;
    var y = a.start.length > 1 ? a.start[1] : 0.0;
    var heading = a.start.length > 2 ? a.start[2] : 0.0;
    var seated = false;
    var sitLength = 0.0;
    final steps = timeline.where((s) => s.actor == actorId).toList()..sort((p, q) => p.t0.compareTo(q.t0));
    for (final s in steps) {
      if (t < s.t0) break;
      final inside = t < s.t1;
      final span = math.max(1e-6, s.t1 - s.t0);
      switch (s.action) {
        case 'walk':
          final to = s.to;
          if (to == null || to.length < 2) break;
          final tx = to[0] + dx;
          final ty = to[1] + dy;
          heading = headingTo(x, y, tx, ty);
          if (inside) {
            final f = (t - s.t0) / span;
            return SceneActorPose(x: x + (tx - x) * f, y: y + (ty - y) * f, heading: heading, clip: 'walk', clipTime: t - s.t0);
          }
          x = tx;
          y = ty;
        case 'sit':
          final seat = seats[s.seat];
          if (seat == null || seat.length < 2) break;
          x = seat[0] + dx;
          y = seat[1] + dy;
          final seatHeading = seat.length > 2 ? seat[2] : heading;
          if (inside) {
            final f = ((t - s.t0) / _turnSeconds).clamp(0.0, 1.0);
            return SceneActorPose(x: x, y: y, heading: _turn(heading, seatHeading, f), clip: 'sit', clipTime: t - s.t0, seated: true);
          }
          heading = seatHeading;
          seated = true;
          sitLength = span;
        default:
          if (inside) {
            return SceneActorPose(
              x: x,
              y: y,
              heading: heading,
              clip: seated ? 'sit' : s.action,
              clipTime: seated ? math.max(sitLength, cheSceneHoldEnd) : t - s.t0,
              seated: seated,
              line: s.line,
            );
          }
      }
    }
    return SceneActorPose(x: x, y: y, heading: heading, clip: seated ? 'sit' : 'idle', clipTime: seated ? cheSceneHoldEnd : t, seated: seated);
  }
}

/// The renderer's heading from (ax, ay) towards (bx, by): the crew face -y at heading 0.
double headingTo(double ax, double ay, double bx, double by) => math.atan2(by - ay, bx - ax) * 180 / math.pi + 90;

double _turn(double from, double to, double f) {
  var d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return from + d * f;
}

/// A spec point (x right, y into the room, z up) in flutter_scene's y-up space.
List<double> cheSceneToView(double x, double y, double z) => [x, z, -y];

/// The actor a raycast hit belongs to: the first `actor:<id>` node from the hit node up to the scene root.
String? cheSceneActorFromNodeNames(Iterable<String> namesFromHitUp) {
  for (final name in namesFromHitUp) {
    if (name.startsWith('actor:') && name.length > 'actor:'.length) return name.substring('actor:'.length);
  }
  return null;
}

/// The words a touch control sends to CHE: the same sentences the Scene Director understands by voice.
class SceneEditWords {
  static String outfit(SceneActor a, String colour) => 'make ${a.possessive} outfit $colour';
  static String move(SceneActor a, String direction) => 'move ${a.objectPronoun} $direction';
  static String size(SceneActor a, {required bool bigger}) => 'make ${a.objectPronoun} ${bigger ? 'bigger' : 'smaller'}';
  static String light(String preset) => 'relight the office ${preset == 'warm' || preset == 'cool' ? preset : 'for $preset'}';
}

// ─── Voice (the preview's handler in lib/home_state/send.dart) ──────────────────────────────────────────────────────

enum ScenePreviewVoice { play, pause, seek, select, deselect, read, options, edit }

/// One spoken command for the open preview. [seconds] for seek, [actor] for select, [words] for an edit.
class ScenePreviewCommand {
  const ScenePreviewCommand(this.kind, {this.seconds, this.actor, this.words});
  final ScenePreviewVoice kind;
  final double? seconds;
  final String? actor;
  final String? words;
}

const _spokenNumbers = {'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'fifteen': 15, 'twenty': 20};

double? _spokenNumber(String w) => double.tryParse(w) ?? _spokenNumbers[w]?.toDouble();

/// The numbered choices the preview reads aloud ("option 2" runs the second). Each is a phrase [scenePreviewCommand]
/// understands, so a choice and the same words spoken do the same thing.
List<String> scenePreviewOptions(ScenePreviewSpec? spec) => [
      'play the scene',
      'pause',
      'go to the start',
      if (spec != null)
        for (final a in spec.actors) 'select ${a.name.toLowerCase()}',
      'relight the office for sunset',
      'undo',
      'is my scene ready',
      'read the scene',
    ];

/// The preview command in [said], or null when the words are not for the preview (the chat answers them then).
/// Scene edits ("make her outfit red", "move him left", "undo") go to CHE with the preview's project and selection.
ScenePreviewCommand? scenePreviewCommand(String said, ScenePreviewSpec? spec) {
  var t = said.toLowerCase().replaceAll(RegExp(r'[.!?,]+$'), '').replaceFirst(RegExp(r'^\W*(?:(?:hey\s+)?(?:che|chey|chay)[,:]?\s+)'), '').trim();
  final option = RegExp(r'^(?:option|number|choice)\s+(\w+)$').firstMatch(t);
  if (option != null) {
    final n = _spokenNumber(option.group(1)!);
    final list = scenePreviewOptions(spec);
    if (n == null || n < 1 || n > list.length) return const ScenePreviewCommand(ScenePreviewVoice.options);
    t = list[n.toInt() - 1];
  }
  if (RegExp(r'^(?:play|play (?:it|the scene|the preview)|resume|start playing)$').hasMatch(t)) return const ScenePreviewCommand(ScenePreviewVoice.play);
  if (RegExp(r'^(?:pause|stop|pause (?:it|the scene)|stop playing)$').hasMatch(t)) return const ScenePreviewCommand(ScenePreviewVoice.pause);
  if (RegExp(r'^(?:restart|go (?:back )?to the (?:start|beginning)|from the (?:start|top))$').hasMatch(t)) {
    return const ScenePreviewCommand(ScenePreviewVoice.seek, seconds: 0);
  }
  if (t == 'go to the end') return ScenePreviewCommand(ScenePreviewVoice.seek, seconds: spec?.seconds ?? 0);
  final seek = RegExp(r'^(?:go|jump|skip|seek) to (\w+(?:\.\d+)?)(?: seconds?)?$').firstMatch(t);
  if (seek != null) {
    final s = _spokenNumber(seek.group(1)!);
    if (s != null) return ScenePreviewCommand(ScenePreviewVoice.seek, seconds: s);
  }
  if (RegExp(r'^(?:deselect|unselect|clear (?:the )?selection|select (?:no ?one|nobody))$').hasMatch(t)) {
    return const ScenePreviewCommand(ScenePreviewVoice.deselect);
  }
  final select = RegExp(r'^(?:select|pick|choose|touch) (\w+)$').firstMatch(t);
  if (select != null && spec != null) {
    for (final a in spec.actors) {
      if (a.id == select.group(1) || a.name.toLowerCase() == select.group(1)) return ScenePreviewCommand(ScenePreviewVoice.select, actor: a.id);
    }
  }
  if (RegExp(r"^(?:read (?:the )?(?:scene|screen|status)(?: aloud)?|read aloud|describe (?:the )?(?:scene|screen)|what(?:'s| is) on (?:the )?screen)$").hasMatch(t)) {
    return const ScenePreviewCommand(ScenePreviewVoice.read);
  }
  if (RegExp(r'^(?:options|what can i (?:do|say)|help|list (?:the )?options)$').hasMatch(t)) return const ScenePreviewCommand(ScenePreviewVoice.options);
  if (RegExp(r'^(?:undo|redo)\b|\b(?:outfit|clothes|move (?:her|him|them)|bigger|smaller|taller|shorter|relight|lighting|camera|music|slow|speed|faster|say|render it again|scene ready)\b|\bmake it (?:sunset|night|morning|evening)\b')
      .hasMatch(t)) {
    return ScenePreviewCommand(ScenePreviewVoice.edit, words: t);
  }
  return null;
}
