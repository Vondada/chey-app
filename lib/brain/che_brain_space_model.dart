// CHE Brain space: the pure model behind the immersive Brain room.
//
// Every node is one of CHE's real memories (CheMemoryDot from the Worker /
// phone memory). Nothing here invents a memory. Categories become spatial
// lobes; memories sit inside their lobe; related memories (Worker brain
// links, shared ML clusters, shared words) are connected.
//
// The camera can orbit the whole brain, travel inside it, and stop at the
// very center looking outward, with memories all around.

import 'dart:math' as math;
import 'dart:ui' show Offset, Size;

import 'package:vector_math/vector_math.dart' as vm;

import '../home/che_memory_brain.dart' show CheMemoryDot, cheRelatedMemoryEdgesTyped;
import 'che_brain_regions.dart';
import 'che_brain_sections.dart';

/// Fixed category order: each gets its own lobe (direction) in the brain.
const List<String> cheBrainCategories = [
  'Memory',
  'Learning',
  'Knowledge',
  'ML Learning',
  'Research',
  'About you',
  'Suggestion',
  'Translation',
  'Conversations',
  'Agents',
  // Curated teaching cards and the owner's practice on them (#346): their own lobe, never counted as memories.
  'Knowledge Atlas',
];

/// The brain's shape, seen from its left side by default like an anatomy
/// picture: front on the left, cerebellum lower right (world units; x front/back, y up, z left/right): a
/// cerebrum, temporal lobe, cerebellum and brainstem. Memories live inside.
const List<(double, double, double, double, double, double)> _brainVolumes = [
  (0, 1.2, 0, 8.2, 5.4, 4.6), // cerebrum
  (1.6, -2.4, 0, 5.2, 2.6, 4.4), // temporal lobe
  (-5.4, -3.9, 0, 2.9, 1.9, 3.4), // cerebellum
  (-2.2, -6.0, 0, 1.1, 2.6, 1.1), // brainstem
];

/// The brain's volumes (centre x, y, z and radii x, y, z), for the renderer's luminous body.
const List<(double, double, double, double, double, double)> cheBrainVolumes = _brainVolumes;

/// < 1 inside the brain, 1 on its surface.
double cheBrainShape(vm.Vector3 p) {
  var best = double.infinity;
  for (final (cx, cy, cz, rx, ry, rz) in _brainVolumes) {
    final dx = (p.x - cx) / rx, dy = (p.y - cy) / ry, dz = (p.z - cz) / rz;
    best = math.min(best, dx * dx + dy * dy + dz * dz);
  }
  return best;
}

/// Where each kind of memory lives, like regions of a real brain.
const Map<String, (double, double, double, double)> _brainRegions = {
  'Conversations': (2.6, 3.0, 0, 3.6), // frontal / top: everything said together
  'Memory': (0.4, -0.6, 0, 2.4), // deep middle
  'About you': (0.2, 1.8, 0, 2.2),
  'Learning': (-2.4, 4.0, 0, 2.4), // parietal
  'Knowledge': (6.0, 1.0, 0, 2.2), // front
  'ML Learning': (-6.0, 1.4, 0, 2.2), // occipital
  'Research': (2.6, -2.8, 0, 2.4), // temporal
  'Suggestion': (-5.4, -3.9, 0, 1.6), // cerebellum
  'Translation': (-2.2, -5.4, 0, 1.2), // brainstem
  'Agents': (4.8, -3.6, 0, 2.0), // lower front: live specialist work
  'Knowledge Atlas': (-4.4, 3.4, 0, 1.8), // upper back: curated lessons, apart from memories
};

String cheBrainCategoryKey(String category) {
  final lower = category.toLowerCase();
  for (final c in cheBrainCategories) {
    if (c.toLowerCase() == lower) return c;
  }
  return 'Memory';
}

/// One memory placed in the brain.
class CheBrainNode {
  CheBrainNode({required this.dot, required this.home, required this.cluster, required this.size})
      : region = cheBrainRegionOf(dot),
        verified = cheBrainIsVerifiedRecord(dot);

  final CheMemoryDot dot;

  /// The owner's colour region (memories blue, trading orange, errors red ...), worked out once per layout.
  final CheBrainRegion region;

  /// Verified with proof (drawn with a white core; links between two verified records are strong).
  final bool verified;

  /// Layout position (world units).
  final vm.Vector3 home;

  /// Where the owner dragged it this session (null = home).
  vm.Vector3? moved;

  /// Category lobe it belongs to.
  final String cluster;

  /// World radius: importance and connections give stronger presence.
  final double size;

  int degree = 0;

  vm.Vector3 get position => moved ?? home;
  String get id => dot.id;
}

/// A category lobe: a cluster the owner can collapse to one orb or expand.
class CheBrainCluster {
  CheBrainCluster(this.name, this.center);
  final String name;
  final vm.Vector3 center;
  final List<CheBrainNode> members = [];
  bool expanded = true;
}

int _hash(String s) {
  var h = 0x811c9dc5;
  for (final c in s.codeUnits) {
    h ^= c;
    h = (h * 0x01000193) & 0xffffffff;
  }
  // Final avalanche, so ids that differ only in their last character (the
  // salts) give independent numbers instead of points lined up in streaks.
  h ^= h >> 16;
  h = (h * 0x85ebca6b) & 0xffffffff;
  h ^= h >> 13;
  h = (h * 0xc2b2ae35) & 0xffffffff;
  h ^= h >> 16;
  return h & 0x7fffffff;
}

/// Deterministic pseudo-random in [0,1) for a memory id and salt.
double _rand(String id, int salt) => (_hash('$id#$salt') % 100000) / 100000.0;

/// The laid-out brain: real memories, their lobes and relationships.
class CheBrainLayout {
  CheBrainLayout._(this.nodes, this.clusters, this.edges, this.byId, this.edgeStrength);

  final List<CheBrainNode> nodes;
  final Map<String, CheBrainCluster> clusters;

  /// Index pairs into [nodes].
  final List<(int, int)> edges;

  /// Per edge (same index): how strong the connection is, from recorded relationships and verification only.
  final List<CheBrainLinkStrength> edgeStrength;
  final Map<String, int> byId;

  static const double radius = 10;

  /// Clusters bigger than this start collapsed so the overview is readable.
  static const int collapseAbove = 1500;

  factory CheBrainLayout.build(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const []}) {
    // Each category is a region of one brain-shaped volume.
    final clusters = <String, CheBrainCluster>{};
    for (final name in cheBrainCategories) {
      final (x, y, z, _) = _brainRegions[name]!;
      clusters[name] = CheBrainCluster(name, vm.Vector3(x, y, z));
    }
    final nodes = <CheBrainNode>[];
    final byId = <String, int>{};
    for (final dot in dots) {
      if (byId.containsKey(dot.id)) continue;
      final cluster = clusters[cheBrainCategoryKey(dot.category)]!;
      // Inside its region and always inside the brain's shape (stable per
      // memory: the same memory keeps its place).
      // Points fill the whole brain; each memory leans toward its region.
      final sigma = _brainRegions[cluster.name]!.$4 * 1.5;
      var home = cluster.center.clone();
      for (var k = 0; k < 240; k++) {
        final p = vm.Vector3(_rand(dot.id, 4 * k + 1) * 18 - 9, _rand(dot.id, 4 * k + 2) * 16 - 9, _rand(dot.id, 4 * k + 3) * 10 - 5);
        if (cheBrainShape(p) >= .95) continue;
        final d2 = (p - cluster.center).length2;
        if (_rand(dot.id, 4 * k + 4) < math.exp(-d2 / (2 * sigma * sigma)) * .8 + .2) {
          home = p;
          break;
        }
      }
      final node = CheBrainNode(
        dot: dot,
        home: home,
        cluster: cluster.name,
        size: .16 + dot.importance.clamp(1, 5) * .045,
      );
      byId[dot.id] = nodes.length;
      nodes.add(node);
      cluster.members.add(node);
    }
    final edges = <(int, int)>[];
    final strength = <CheBrainLinkStrength>[];
    for (final e in cheRelatedMemoryEdgesTyped(dots, brainLinks: brainLinks)) {
      final a = byId[e.$1], b = byId[e.$2];
      if (a == null || b == null) continue;
      edges.add((a, b));
      strength.add(!e.$3
          ? CheBrainLinkStrength.weak
          : nodes[a].verified && nodes[b].verified
          ? CheBrainLinkStrength.verified
          : CheBrainLinkStrength.developing);
      nodes[a].degree++;
      nodes[b].degree++;
    }
    for (final c in clusters.values) {
      c.expanded = c.members.length <= collapseAbove;
    }
    clusters.removeWhere((_, c) => c.members.isEmpty);
    return CheBrainLayout._(nodes, clusters, edges, byId, strength);
  }

  CheBrainNode? node(String id) {
    final i = byId[id];
    return i == null ? null : nodes[i];
  }

  /// Visible = its lobe is expanded (and it passes the category filter).
  bool visible(CheBrainNode n, Set<String> filter) =>
      (filter.isEmpty || filter.contains(n.cluster)) && (clusters[n.cluster]?.expanded ?? true);

  List<CheBrainNode> related(CheBrainNode n, {int limit = 6}) {
    final i = byId[n.id];
    if (i == null) return const [];
    return [
      for (final e in edges)
        if (e.$1 == i) nodes[e.$2] else if (e.$2 == i) nodes[e.$1],
    ].take(limit).toList();
  }

  /// Best match for "find my memory about …" (title, body, category, words).
  CheBrainNode? find(String query) {
    final words = query.toLowerCase().split(RegExp(r'[^a-z0-9]+')).where((w) => w.length > 2).toList();
    if (words.isEmpty) return null;
    CheBrainNode? best;
    var bestScore = 0.0;
    for (final n in nodes) {
      final title = n.dot.title.toLowerCase();
      final body = n.dot.body.toLowerCase();
      var score = 0.0;
      for (final w in words) {
        if (title.contains(w)) score += 3;
        if (body.contains(w)) score += 1;
        if (n.dot.tokens.contains(w)) score += .5;
      }
      if (score > bestScore) {
        best = n;
        bestScore = score;
      }
    }
    return best;
  }
}

/// Free camera. `distance` > 0 orbits `target`; `distance` == 0 stands at
/// `target` and looks outward ("inside the brain").
class CheBrainCamera {
  CheBrainCamera({vm.Vector3? target, this.yaw = math.pi, this.pitch = .08, this.distance = overview})
      : target = target ?? vm.Vector3.zero();

  static const double overview = 17;
  static const double maxDistance = 46;
  static const double fov = 60 * math.pi / 180;
  static const double near = .12;

  vm.Vector3 target;
  double yaw;
  double pitch;
  double distance;

  CheBrainCamera copy() => CheBrainCamera(target: target.clone(), yaw: yaw, pitch: pitch, distance: distance);

  // Camera basis, recomputed only when the camera changes (not per node).
  double _ky = double.nan, _kp = double.nan, _kd = double.nan;
  final vm.Vector3 _kt = vm.Vector3.zero();
  final vm.Vector3 _f = vm.Vector3.zero(), _r = vm.Vector3.zero(), _u = vm.Vector3.zero(), _e = vm.Vector3.zero();

  void _basis() {
    if (yaw == _ky && pitch == _kp && distance == _kd && target == _kt) return;
    _ky = yaw;
    _kp = pitch;
    _kd = distance;
    _kt.setFrom(target);
    _f.setValues(math.cos(pitch) * math.sin(yaw), math.sin(pitch), -math.cos(pitch) * math.cos(yaw));
    _r
      ..setFrom(_f.cross(vm.Vector3(0, 1, 0)))
      ..normalize();
    _u
      ..setFrom(_r.cross(_f))
      ..normalize();
    _e.setFrom(target - _f * distance);
  }

  vm.Vector3 get forward {
    _basis();
    return _f.clone();
  }

  vm.Vector3 get right {
    _basis();
    return _r.clone();
  }

  vm.Vector3 get up {
    _basis();
    return _u.clone();
  }

  vm.Vector3 get eye {
    _basis();
    return _e.clone();
  }

  bool get inside => distance < LayoutRadius.inner;

  /// Look/orbit: one-finger drag.
  void rotate(double dx, double dy) {
    yaw += dx;
    pitch = (pitch - dy).clamp(-1.45, 1.45).toDouble();
  }

  /// Pinch: scale > 1 moves deeper.
  void zoom(double factor) {
    // Offset scale, so spreading the fingers at the very center (distance 0)
    // still backs out.
    distance = ((distance + 1) / factor - 1).clamp(0.0, maxDistance).toDouble();
    if (distance < .05) distance = 0;
  }

  /// Two-finger pan: slide the view in its own plane.
  void pan(double dx, double dy) {
    final speed = math.max(distance, 6) * .0016;
    target += right * (-dx * speed) + up * (dy * speed);
  }

  /// Projects a world point. Null when behind the camera or off-screen.
  CheProjected? project(vm.Vector3 p, Size size, {double worldRadius = 0, double margin = 40}) {
    _basis();
    // Scalar math: no allocations per projected node.
    final rx = p.x - _e.x, ry = p.y - _e.y, rz = p.z - _e.z;
    final z = rx * _f.x + ry * _f.y + rz * _f.z;
    if (z < near) return null;
    final focal = size.shortestSide / (2 * math.tan(fov / 2));
    final x = size.width / 2 + (rx * _r.x + ry * _r.y + rz * _r.z) / z * focal;
    final y = size.height / 2 - (rx * _u.x + ry * _u.y + rz * _u.z) / z * focal;
    final r = worldRadius / z * focal;
    if (x < -margin - r || x > size.width + margin + r || y < -margin - r || y > size.height + margin + r) return null;
    return CheProjected(Offset(x, y), z, r);
  }

  /// World point under a screen point at a given depth (dragging an orb).
  vm.Vector3 unproject(Offset screen, double depth, Size size) {
    final focal = size.shortestSide / (2 * math.tan(fov / 2));
    final x = (screen.dx - size.width / 2) / focal * depth;
    final y = -(screen.dy - size.height / 2) / focal * depth;
    return eye + forward * depth + right * x + up * y;
  }

  /// Interpolates toward [to] (for smooth fly-to). t in [0,1].
  void lerpTo(CheBrainCamera from, CheBrainCamera to, double t) {
    final e = t < .5 ? 4 * t * t * t : 1 - math.pow(-2 * t + 2, 3) / 2;
    target = from.target + (to.target - from.target) * e.toDouble();
    var dYaw = to.yaw - from.yaw;
    while (dYaw > math.pi) {
      dYaw -= 2 * math.pi;
    }
    while (dYaw < -math.pi) {
      dYaw += 2 * math.pi;
    }
    yaw = from.yaw + dYaw * e;
    pitch = from.pitch + (to.pitch - from.pitch) * e;
    distance = from.distance + (to.distance - from.distance) * e;
  }
}

class LayoutRadius {
  /// Closer than this to the target counts as "inside".
  static const double inner = 1.0;
}

class CheProjected {
  const CheProjected(this.offset, this.depth, this.radius);
  final Offset offset;
  final double depth;
  final double radius;
}

/// Spoken / typed Brain commands.
enum CheBrainAction {
  open, inside, overview, backOut, filter, clearFilter, find, openSelected, expand, collapse, agentStatus,
  // Navigation (same controller, by touch or by voice).
  zoomIn, zoomOut, fit, back, centerChe, centerSelected, openWorker, lens,
  // The searchable list (owner, 2026-10-23) and back to the neural view.
  list, space,
  // The eleven regions (lane brain-visual, 2026-10-25): fly to one, read them as a numbered list, open one's records,
  // and turn the brain by voice as a drag does.
  region, regions, openRegion, rotate,
}

/// Which brain is in view and what is shown of it: the owner's place in the
/// Brain system, kept so going back restores it exactly.
class CheBrainViewState {
  const CheBrainViewState({required this.scope, required this.lens, required this.filter, required this.selectedId, required this.cardOpen, required this.focusedCluster, required this.camera});
  final String? scope;
  final CheBrainLens lens;
  final Set<String> filter;
  final String? selectedId;
  final bool cardOpen;
  final String? focusedCluster;
  final CheBrainCamera camera;

  bool sameAs(CheBrainViewState o) =>
      scope == o.scope && lens == o.lens && selectedId == o.selectedId && focusedCluster == o.focusedCluster &&
      filter.length == o.filter.length && filter.containsAll(o.filter) &&
      (camera.distance - o.camera.distance).abs() < .01 && (camera.target - o.camera.target).length < .01;
}

/// One Office worker's brain as it sits around CHE's: a labelled orb placed on
/// a ring outside the brain, sized by how much experience it holds. Only
/// internal workers appear here (never outside AIs), and only real records
/// count. Tapping it opens that worker's brain in the same space.
class CheBrainWorkerOrb {
  const CheBrainWorkerOrb({required this.name, required this.records, required this.position, this.role = '', this.state = '', this.collaborators = const {}});
  final String name;
  final int records;
  final vm.Vector3 position;
  final String role;

  /// 'working', 'idle', 'no experience yet' or '' when unknown.
  final String state;

  /// Workers this one shares records with (a task both took part in).
  final Set<String> collaborators;

  double get radius => .9 + math.min(1.5, math.sqrt(records) * .14);
}

/// Outside AIs and model providers are never Office worker brains (the Worker
/// applies the same rule when it places records; this keeps the phone honest
/// about records that arrived before it did).
final RegExp cheBrainExternalAi = RegExp(r'^(?:claude|chatgpt|chat\s*gpt|gpt|openai|codex|gemini|google|grok|xai|cursor|copilot|mistral|anthropic|deepseek|llama|meta|perplexity)\b', caseSensitive: false);

/// A name that carries an outside AI anywhere ("Nova (Claude)", "Research by ChatGPT") is a
/// provider-backed label, not an internal worker's name.
final RegExp cheBrainMentionsExternalAi = RegExp(r'\b(?:claude|chatgpt|chat\s*gpt|gpt(?:-\d)?|openai|codex|gemini|grok|xai|copilot|mistral|anthropic|deepseek|llama|perplexity)\b', caseSensitive: false);

/// The facets a Brain view can be narrowed by, beyond the category lobes:
/// verified vs inferred, recent, active vs archived, personal vs shared, a
/// task outcome, a project. Immutable; equality by value so a view state can
/// tell whether it changed.
class CheBrainLens {
  const CheBrainLens({this.verified, this.recentDays, this.archived, this.personal, this.status, this.project});

  static const CheBrainLens none = CheBrainLens();

  /// true: owner-attested or source-backed only. false: inferred, hypothesis, unverified or unknown only.
  final bool? verified;

  /// Only records dated within this many days.
  final int? recentDays;

  /// true: archived or historical only. false: active only.
  final bool? archived;

  /// true: the owner's personal memory. false: shared Office knowledge.
  final bool? personal;

  /// A task outcome: 'done', 'failed' or 'live'.
  final String? status;
  final String? project;

  bool get isEmpty => verified == null && recentDays == null && archived == null && personal == null && status == null && project == null;
  int get count => [verified, recentDays, archived, personal, status, project].where((v) => v != null).length;

  static const Object _keep = Object();
  CheBrainLens copyWith({Object? verified = _keep, Object? recentDays = _keep, Object? archived = _keep, Object? personal = _keep, Object? status = _keep, Object? project = _keep}) => CheBrainLens(
        verified: identical(verified, _keep) ? this.verified : verified as bool?,
        recentDays: identical(recentDays, _keep) ? this.recentDays : recentDays as int?,
        archived: identical(archived, _keep) ? this.archived : archived as bool?,
        personal: identical(personal, _keep) ? this.personal : personal as bool?,
        status: identical(status, _keep) ? this.status : status as String?,
        project: identical(project, _keep) ? this.project : project as String?,
      );

  bool matches(CheMemoryDot d, {DateTime? now}) {
    if (verified != null && d.isVerified != verified) return false;
    if (recentDays != null) {
      final at = d.at;
      if (at == null || (now ?? DateTime.now()).difference(at).inDays > recentDays!) return false;
    }
    if (archived != null && d.archived != archived) return false;
    if (personal != null && d.isPersonal != personal) return false;
    if (status != null && d.outcome != status) return false;
    if (project != null && d.project.toLowerCase() != project!.toLowerCase()) return false;
    return true;
  }

  /// Short chip labels, in a fixed order.
  List<String> get labels => [
        if (verified == true) 'Verified',
        if (verified == false) 'Inferred',
        if (recentDays != null) 'Last $recentDays days',
        if (archived == true) 'Archived',
        if (archived == false) 'Active',
        if (personal == true) 'Personal',
        if (personal == false) 'Shared',
        if (status == 'done') 'Done tasks',
        if (status == 'failed') 'Failed tasks',
        if (status == 'live') 'Live tasks',
        if (project != null) 'Project: $project',
      ];

  String describe() => labels.join(', ');

  /// The lens a spoken word asks for: "verified", "recent", "archived", "failed" …
  static CheBrainLens? fromWord(String word) => switch (word.trim().toLowerCase()) {
        'verified' || 'confirmed' => const CheBrainLens(verified: true),
        'inferred' || 'unverified' || 'uncertain' => const CheBrainLens(verified: false),
        'recent' || 'new' || 'latest' || "this week's" => const CheBrainLens(recentDays: 7),
        'archived' || 'historical' || 'old' || 'past' => const CheBrainLens(archived: true),
        'active' || 'current' => const CheBrainLens(archived: false),
        // The same filter as the "Live tasks" chip, so voice and touch agree.
        'live' || 'running' => const CheBrainLens(status: 'live'),
        'personal' || 'private' || 'my own' => const CheBrainLens(personal: true),
        'shared' || 'office' => const CheBrainLens(personal: false),
        'failed' || 'broken' => const CheBrainLens(status: 'failed'),
        'done' || 'completed' || 'finished' || 'successful' => const CheBrainLens(status: 'done'),
        _ => null,
      };

  @override
  bool operator ==(Object other) =>
      other is CheBrainLens && other.verified == verified && other.recentDays == recentDays && other.archived == archived && other.personal == personal && other.status == status && other.project == project;

  @override
  int get hashCode => Object.hash(verified, recentDays, archived, personal, status, project);
}

class CheBrainCommand {
  const CheBrainCommand(this.action, {this.category, this.query, this.agent, this.worker, this.lens, this.section, this.region, this.direction});
  final CheBrainAction action;
  final String? category;
  final String? query;

  /// One of the Office crew, for "what is Atlas working on".
  final String? agent;

  /// A worker brain to open ("open Atlas's brain").
  final String? worker;

  /// A facet to show ("show verified memories only").
  final CheBrainLens? lens;

  /// A list section ("show the brain's actions").
  final CheBrainSection? section;

  /// One of the eleven regions ("go to the memory region", "open region 4").
  final CheBrainRegion? region;

  /// left, right, up or down ("rotate the brain left").
  final String? direction;

  static const Map<String, CheBrainSection> _sectionWords = {
    'conversations': CheBrainSection.conversations,
    'conversation': CheBrainSection.conversations,
    'research': CheBrainSection.research,
    'knowledge': CheBrainSection.knowledge,
    'memory': CheBrainSection.memory,
    'memories': CheBrainSection.memory,
    'actions': CheBrainSection.actions,
    'action': CheBrainSection.actions,
    'completed actions': CheBrainSection.actions,
  };

  /// CHE plus the Office roster, matched against live agent-task sources.
  static const List<String> crew = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];

  static const Map<String, String> _categoryWords = {
    'research': 'Research',
    'learning': 'Learning',
    'knowledge': 'Knowledge',
    'ml': 'ML Learning',
    'machine learning': 'ML Learning',
    'ml learning': 'ML Learning',
    'about me': 'About you',
    'about you': 'About you',
    'personal': 'Memory',
    'suggestion': 'Suggestion',
    'suggestions': 'Suggestion',
    'translation': 'Translation',
    'translations': 'Translation',
    'agents': 'Agents',
    'agent': 'Agents',
    'agent work': 'Agents',
    // The Knowledge Atlas lobe: curated cards and the owner's practice. Never the bare "atlas", which is the Office worker.
    'knowledge atlas': 'Knowledge Atlas',
    'atlas lesson': 'Knowledge Atlas',
    'atlas lessons': 'Knowledge Atlas',
    'atlas card': 'Knowledge Atlas',
    'atlas cards': 'Knowledge Atlas',
    'curated lessons': 'Knowledge Atlas',
    'practice': 'Knowledge Atlas',
  };

  /// "take me inside", "show my research memories", "find my memory about
  /// the TradeSea login", "open this memory", "expand this cluster", "back
  /// out", "show the whole brain". Null for anything else.
  static CheBrainCommand? parse(String words) {
    var t = words.toLowerCase().trim().replaceAll(RegExp(r'[.!?]+$'), '').trim();
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay|shay)[,:]?\s+'), '').replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').trim();
    if (t.length > 120) return null;
    if (RegExp(r'^(?:open|show me|show|go to|take me to) (?:my |your )?brain$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.open);
    if (RegExp(r'^(?:take me|go|fly|move) (?:inside|in|deeper|into (?:the|my|your) brain)$|^(?:enter|go inside) (?:the |my |your )?brain$').hasMatch(t)) {
      return const CheBrainCommand(CheBrainAction.inside);
    }
    if (RegExp(r'^(?:show|see) (?:me )?(?:the |my |your )?(?:whole|entire|full) brain$|^(?:brain )?overview$|^reset (?:the )?(?:brain|view)$').hasMatch(t)) {
      return const CheBrainCommand(CheBrainAction.overview);
    }
    // The list view: "show the brain list", "show the brain's actions", "show my actions in the brain".
    if (RegExp(r'^(?:show|open|switch to) (?:me )?(?:the |my |your )?brain (?:as a )?list(?: view)?$|^(?:show|open|switch to) (?:the |my |your )?list view$').hasMatch(t)) {
      return const CheBrainCommand(CheBrainAction.list);
    }
    final sectionAsked = RegExp(r"^(?:show|open|list) (?:me )?(?:my |your |the )?brain(?:['’]s)? (completed actions|conversations|research|knowledge|memories|memory|actions)$|^(?:show|open|list) (?:me )?(?:my |your |the )?(completed actions|conversations|research|knowledge|memories|memory|actions) (?:in|from) (?:the |my |your )?brain$").firstMatch(t);
    if (sectionAsked != null) {
      return CheBrainCommand(CheBrainAction.list, section: _sectionWords[sectionAsked.group(1) ?? sectionAsked.group(2)!]);
    }
    if (RegExp(r'^(?:show|open|switch to|back to) (?:the |my |your )?(?:neural|3d|brain|orb) view$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.space);
    if (RegExp(r'^(?:back out|go back out|pull back)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.backOut);
    // The regions: "list the brain regions", "go to the memory region", "fly to region 3", "open the trading region",
    // "rotate the brain left". A name that is not one of the eleven is not a region command.
    if (RegExp(r'^(?:list|read|name|say) (?:me )?(?:the |all |my |your )?(?:brain |eleven )?regions$|^(?:what|which) (?:brain )?regions (?:are there|do you have|does (?:the|my|your) brain have)$|^what are (?:the |my |your )?(?:brain )?regions$').hasMatch(t)) {
      return const CheBrainCommand(CheBrainAction.regions);
    }
    final openRegion = RegExp(r'^(?:open|list|read)(?: me)? (?:the )?(?:records|memories) (?:in|of|from) (?:the |my )?(.+?)(?: region| lobe)?$|^(?:open|list) (?:the |my )?(.+? region|region (?:number )?\w+)(?: records)?$').firstMatch(t);
    if (openRegion != null) {
      final r = cheBrainRegionFromWords(openRegion.group(1) ?? openRegion.group(2)!);
      if (r != null) return CheBrainCommand(CheBrainAction.openRegion, region: r);
    }
    final flyRegion = RegExp(r'^(?:go|fly|take me|move|zoom|jump|travel|head|navigate)(?: in| me)? (?:to|into) (?:the |my )?(.+? (?:region|lobe)|region (?:number )?\w+)$|^(?:show me|show|focus on|center on|centre on) (?:the |my )?(.+? region|region (?:number )?\w+)$').firstMatch(t);
    if (flyRegion != null) {
      final r = cheBrainRegionFromWords(flyRegion.group(1) ?? flyRegion.group(2)!);
      if (r != null) return CheBrainCommand(CheBrainAction.region, region: r);
    }
    final turn = RegExp(r'^(?:rotate|turn|spin)(?: the brain| my brain| your brain| it)?(?: to the| to)? (left|right|up|down)$|^(?:rotate|turn|spin) (?:the |my |your )?brain$').firstMatch(t);
    if (turn != null) return CheBrainCommand(CheBrainAction.rotate, direction: turn.group(1) ?? 'right');
    if (RegExp(r'^(?:zoom out|zoom out a bit|farther|further out|move (?:back|away))$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.zoomOut);
    if (RegExp(r'^(?:zoom in|zoom in a bit|closer|move closer|come closer)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.zoomIn);
    if (RegExp(r'^(?:go back|back|previous view|take me back|return to (?:the )?previous view)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.back);
    if (RegExp(r'^(?:fit|fit (?:everything|all|content|the brain|the view)|show everything|show (?:me )?the whole office)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.fit);
    if (RegExp(r"^(?:cent(?:er|re) on che|back to che|return to che|go (?:back )?to che|(?:open|show|show me|go to) che['’]?s brain|che['’]?s brain)$").hasMatch(t)) return const CheBrainCommand(CheBrainAction.centerChe);
    if (RegExp(r'^(?:cent(?:er|re) on (?:this|that|the|the selected) memory|focus (?:on )?(?:this|that|the selected) memory|cent(?:er|re) on (?:the )?selection)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.centerSelected);
    if (RegExp(r'^(?:show|open) (?:all|every) (?:my |your )?memories$|^clear (?:the |all )?filters?$|^remove (?:the |all )?filters?$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.clearFilter);
    // "show verified memories only", "only show failed tasks", "show me the recent ones".
    final facet = RegExp(r'^(?:show|only show|show only|filter to|filter by) (?:me )?(?:only )?(?:the |my |your )?(verified|confirmed|inferred|unverified|uncertain|recent|new|latest|archived|historical|old|past|active|current|live|running|personal|private|shared|office|failed|broken|done|completed|finished|successful) (?:memories|records|tasks|knowledge|ones|work|items|experience)(?: only)?$').firstMatch(t);
    if (facet != null) {
      final lens = CheBrainLens.fromWord(facet.group(1)!);
      if (lens != null) return CheBrainCommand(CheBrainAction.lens, lens: lens);
    }
    final cat = RegExp(r'^(?:show|open|filter to|only show) (?:me )?(?:my |your |the )?(.+?) (?:memories|records|cards|lessons)$').firstMatch(t);
    if (cat != null) {
      final c = _categoryWords[cat.group(1)!.trim()];
      if (c != null) return CheBrainCommand(CheBrainAction.filter, category: c);
    }
    // "show the knowledge atlas cards", "show my atlas lessons": the atlas lobe by its own words. A bare
    // "lessons" stays with the Learning lobe, where CHE's own lessons live.
    final atlasLobe = RegExp(r'^(?:show|open|filter to|only show) (?:me )?(?:my |your |the )?(?:knowledge atlas (?:lobe|group)|atlas (?:cards|lessons)|curated lessons)$').firstMatch(t);
    if (atlasLobe != null) return const CheBrainCommand(CheBrainAction.filter, category: 'Knowledge Atlas');
    final find = RegExp(r'^(?:find|show me|locate|where is|search (?:for )?) ?(?:my |your |the )?memor(?:y|ies) (?:about|of|on|for) (.+)$').firstMatch(t);
    if (find != null) return CheBrainCommand(CheBrainAction.find, query: find.group(1)!.trim());
    if (RegExp(r'^(?:open|read) (?:this|that|the) memory$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.openSelected);
    // "open Atlas's brain", "switch to Knox's brain", "show me Nova's brain": a worker's brain in the
    // same space. Always with the word brain: a bare "switch to X" is the chart's phrase ("switch to Tesla").
    final workerBrain = RegExp(r"^(?:open|show|show me|go to|switch to|take me to|enter|view|visit) ([a-z][a-z-]{1,30})(?:['’]s)? brain$").firstMatch(t);
    if (workerBrain != null) {
      final name = workerBrain.group(1)!;
      if (!const {'my', 'your', 'the', 'whole', 'entire', 'full', 'her', 'his', 'our', 'che', 'offline', 'live'}.contains(name)) return CheBrainCommand(CheBrainAction.openWorker, worker: name);
    }
    if (RegExp(r'^(?:expand|open) (?:this|that|the) cluster$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.expand);
    if (RegExp(r'^collapse (?:this|that|the) cluster$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.collapse);
    // "what is Atlas working on", "show me what Nova is doing", "is Knox
    // busy", "who is working". Answered from live agent-task orbs only.
    if (RegExp(r'^who is working\??$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.agentStatus);
    final doing = RegExp(r"^(?:what is|what's) (\w+) (?:working on|doing|up to)\??$|^(?:show|tell) me what (\w+) is (?:working on|doing)\??$|^is (\w+) (?:working|busy)\??$").firstMatch(t);
    if (doing != null) {
      final name = (doing.group(1) ?? doing.group(2) ?? doing.group(3)!).toLowerCase();
      if (crew.contains(name)) return CheBrainCommand(CheBrainAction.agentStatus, agent: name);
    }
    return null;
  }
}
