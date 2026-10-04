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

import '../home/che_memory_brain.dart' show CheMemoryDot, cheRelatedMemoryEdges;

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
];

String cheBrainCategoryKey(String category) {
  final lower = category.toLowerCase();
  for (final c in cheBrainCategories) {
    if (c.toLowerCase() == lower) return c;
  }
  return 'Memory';
}

/// One memory placed in the brain.
class CheBrainNode {
  CheBrainNode({required this.dot, required this.home, required this.cluster, required this.size});

  final CheMemoryDot dot;

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
    h = (h * 0x01000193) & 0x7fffffff;
  }
  return h;
}

/// Deterministic pseudo-random in [0,1) for a memory id and salt.
double _rand(String id, int salt) => (_hash('$id#$salt') % 100000) / 100000.0;

/// The laid-out brain: real memories, their lobes and relationships.
class CheBrainLayout {
  CheBrainLayout._(this.nodes, this.clusters, this.edges, this.byId);

  final List<CheBrainNode> nodes;
  final Map<String, CheBrainCluster> clusters;

  /// Index pairs into [nodes].
  final List<(int, int)> edges;
  final Map<String, int> byId;

  static const double radius = 10;

  /// Clusters bigger than this start collapsed so the overview is readable.
  static const int collapseAbove = 40;

  factory CheBrainLayout.build(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const []}) {
    // Lobe centers: categories spread evenly over a sphere (golden spiral).
    final clusters = <String, CheBrainCluster>{};
    for (var i = 0; i < cheBrainCategories.length; i++) {
      final y = 1 - (i + .5) / cheBrainCategories.length * 2;
      final r = math.sqrt(1 - y * y);
      final theta = i * math.pi * (3 - math.sqrt(5));
      clusters[cheBrainCategories[i]] = CheBrainCluster(
        cheBrainCategories[i],
        vm.Vector3(math.cos(theta) * r, y * .82, math.sin(theta) * r) * (radius * .58),
      );
    }
    final nodes = <CheBrainNode>[];
    final byId = <String, int>{};
    for (final dot in dots) {
      if (byId.containsKey(dot.id)) continue;
      final cluster = clusters[cheBrainCategoryKey(dot.category)]!;
      // Inside the lobe: a jittered ball around its center, pulled slightly
      // toward the middle so the whole field reads as one brain.
      final u = _rand(dot.id, 1), v = _rand(dot.id, 2), w = _rand(dot.id, 3);
      final theta = u * 2 * math.pi;
      final phi = math.acos(2 * v - 1);
      final spread = radius * .42 * math.pow(w, 1 / 3);
      final offset = vm.Vector3(math.sin(phi) * math.cos(theta), math.cos(phi), math.sin(phi) * math.sin(theta)) * spread.toDouble();
      final home = cluster.center + offset;
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
    for (final e in cheRelatedMemoryEdges(dots, brainLinks: brainLinks)) {
      final a = byId[e.$1], b = byId[e.$2];
      if (a == null || b == null) continue;
      edges.add((a, b));
      nodes[a].degree++;
      nodes[b].degree++;
    }
    for (final c in clusters.values) {
      c.expanded = c.members.length <= collapseAbove;
    }
    clusters.removeWhere((_, c) => c.members.isEmpty);
    return CheBrainLayout._(nodes, clusters, edges, byId);
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
  CheBrainCamera({vm.Vector3? target, this.yaw = .6, this.pitch = .25, this.distance = overview})
      : target = target ?? vm.Vector3.zero();

  static const double overview = 21;
  static const double maxDistance = 46;
  static const double fov = 60 * math.pi / 180;
  static const double near = .12;

  vm.Vector3 target;
  double yaw;
  double pitch;
  double distance;

  CheBrainCamera copy() => CheBrainCamera(target: target.clone(), yaw: yaw, pitch: pitch, distance: distance);

  vm.Vector3 get forward => vm.Vector3(
        math.cos(pitch) * math.sin(yaw),
        math.sin(pitch),
        -math.cos(pitch) * math.cos(yaw),
      );

  vm.Vector3 get right => forward.cross(vm.Vector3(0, 1, 0)).normalized();
  vm.Vector3 get up => right.cross(forward).normalized();
  vm.Vector3 get eye => target - forward * distance;

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
    final rel = p - eye;
    final z = rel.dot(forward);
    if (z < near) return null;
    final focal = size.shortestSide / (2 * math.tan(fov / 2));
    final x = size.width / 2 + rel.dot(right) / z * focal;
    final y = size.height / 2 - rel.dot(up) / z * focal;
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
enum CheBrainAction { open, inside, overview, backOut, filter, clearFilter, find, openSelected, expand, collapse }

class CheBrainCommand {
  const CheBrainCommand(this.action, {this.category, this.query});
  final CheBrainAction action;
  final String? category;
  final String? query;

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
    if (RegExp(r'^(?:back out|zoom out|go back out|pull back)$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.backOut);
    if (RegExp(r'^(?:show|open) (?:all|every) (?:my |your )?memories$|^clear (?:the )?filter$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.clearFilter);
    final cat = RegExp(r'^(?:show|open|filter to|only show) (?:me )?(?:my |your |the )?(.+?) memories$').firstMatch(t);
    if (cat != null) {
      final c = _categoryWords[cat.group(1)!.trim()];
      if (c != null) return CheBrainCommand(CheBrainAction.filter, category: c);
    }
    final find = RegExp(r'^(?:find|show me|locate|where is|search (?:for )?) ?(?:my |your |the )?memor(?:y|ies) (?:about|of|on|for) (.+)$').firstMatch(t);
    if (find != null) return CheBrainCommand(CheBrainAction.find, query: find.group(1)!.trim());
    if (RegExp(r'^(?:open|read) (?:this|that|the) memory$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.openSelected);
    if (RegExp(r'^(?:expand|open) (?:this|that|the) cluster$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.expand);
    if (RegExp(r'^collapse (?:this|that|the) cluster$').hasMatch(t)) return const CheBrainCommand(CheBrainAction.collapse);
    return null;
  }
}
