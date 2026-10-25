// The Brain Room's first glance (owner, 2026-10-25 UI cleanup: "not acceptable: cluttered, too many nodes and
// cards"). Seven readable category regions of one glowing neural brain, seen from above, each with its real record
// count. Individual records appear only on drill-down: tapping a region (or saying "open memory in the brain")
// opens one detail sheet with a capped, paged, searchable list.
//
// Data versus decoration:
// - Data-backed: the seven regions (name, real count, verified count, records added in the last day). Each is one
//   VoiceOver button. A pulse runs from the core to a region only when that region holds records dated in the last
//   24 hours, and a ring bursts on a region when its count grows while the room is open.
// - Decoration: the brain outline, the folds, the faint ambient neurons and the slow dim pulses on every pathway.
//   They carry no data, are painted by one CustomPainter under ExcludeSemantics, and never get a widget each.
//
// Performance: one AnimationController drives one CustomPainter (repaint: controller); the decorative geometry is
// built once per size and reused, so a frame costs the same with 0 or 100,000 records. The activity runs for five
// cycles (30 seconds) after the room opens, a touch or new records, then rests on a still frame until woken. Reduced motion
// (MediaQuery.disableAnimations) stops the controller: the brain is drawn once, still, with fresh regions shown by
// a steady ring instead of a moving pulse. Quiet by design (AGENTS.md): nothing here speaks on its own.

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../home/che_memory_brain.dart' show CheMemoryDot;
import 'che_brain_regions.dart';

/// The seven first-glance regions, each a union of the record regions (che_brain_regions.dart) that belong to it.
/// Verified is a state counted across every region, so it is shown inside each region, never as a region.
enum CheBrainLobe { memory, conversations, knowledge, work, trading, creation, review }

/// No more than this many regions are ever drawn at first glance (owner: "never overcrowded").
const int cheBrainLobeCap = 7;

/// Records shown per page in a region's detail sheet; "Show more" adds another page.
const int cheBrainLobePageSize = 20;

/// "New" for the activity pulse: a record dated within this window.
const Duration cheBrainFreshWindow = Duration(hours: 24);

extension CheBrainLobeInfo on CheBrainLobe {
  String get label => switch (this) {
    CheBrainLobe.memory => 'Memory',
    CheBrainLobe.conversations => 'Conversations',
    CheBrainLobe.knowledge => 'Knowledge',
    CheBrainLobe.work => 'Agents & Work',
    CheBrainLobe.trading => 'Trading',
    CheBrainLobe.creation => 'Creation',
    CheBrainLobe.review => 'Needs Review',
  };

  /// What the region holds, read by VoiceOver and shown in its sheet.
  String get meaning => switch (this) {
    CheBrainLobe.memory => 'What you asked CHE to remember: your preferences and facts about you.',
    CheBrainLobe.conversations => 'Your chats with CHE and the corrections you made.',
    CheBrainLobe.knowledge => 'What CHE learned: facts, lessons, Knowledge Atlas cards and research.',
    CheBrainLobe.work => 'Office agent tasks and coding jobs.',
    CheBrainLobe.trading => 'Trading research, paper trades and strategy decisions.',
    CheBrainLobe.creation => 'Videos, images, music and designs CHE made.',
    CheBrainLobe.review => 'Failed or contradicted records that need checking.',
  };

  /// The record regions this region gathers.
  List<CheBrainRegion> get regions => switch (this) {
    CheBrainLobe.memory => const [CheBrainRegion.memories],
    CheBrainLobe.conversations => const [CheBrainRegion.conversations],
    CheBrainLobe.knowledge => const [CheBrainRegion.knowledge, CheBrainRegion.research],
    CheBrainLobe.work => const [CheBrainRegion.agents, CheBrainRegion.coding],
    CheBrainLobe.trading => const [CheBrainRegion.trading],
    CheBrainLobe.creation => const [CheBrainRegion.creative, CheBrainRegion.media],
    CheBrainLobe.review => const [CheBrainRegion.errors],
  };

  /// Black-and-teal identity: teal and cyan lead; warm accents only where the meaning needs them.
  Color get color => switch (this) {
    CheBrainLobe.memory => const Color(0xFF2EF2D0),
    CheBrainLobe.conversations => const Color(0xFF22D3F2),
    CheBrainLobe.knowledge => const Color(0xFF7FB8FF),
    CheBrainLobe.work => const Color(0xFFFFD27A),
    CheBrainLobe.trading => const Color(0xFFFFA25E),
    CheBrainLobe.creation => const Color(0xFFE08CFF),
    CheBrainLobe.review => const Color(0xFFFF5C6E),
  };

  IconData get icon => switch (this) {
    CheBrainLobe.memory => Icons.person_outline_rounded,
    CheBrainLobe.conversations => Icons.forum_rounded,
    CheBrainLobe.knowledge => Icons.menu_book_rounded,
    CheBrainLobe.work => Icons.work_outline_rounded,
    CheBrainLobe.trading => Icons.show_chart_rounded,
    CheBrainLobe.creation => Icons.auto_awesome_rounded,
    CheBrainLobe.review => Icons.error_outline_rounded,
  };

  /// Where the region sits in the brain seen from above (0..1 of the brain's box): memory, conversations and work
  /// down the left hemisphere, knowledge, trading and creation down the right, review at the brain stem.
  Offset get anchor => switch (this) {
    CheBrainLobe.memory => const Offset(.27, .17),
    CheBrainLobe.conversations => const Offset(.22, .45),
    CheBrainLobe.work => const Offset(.29, .72),
    CheBrainLobe.knowledge => const Offset(.73, .17),
    CheBrainLobe.trading => const Offset(.78, .45),
    CheBrainLobe.creation => const Offset(.71, .72),
    CheBrainLobe.review => const Offset(.5, .93),
  };
}

/// The region a record region belongs to.
CheBrainLobe cheBrainLobeOfRegion(CheBrainRegion r) =>
    CheBrainLobe.values.firstWhere((l) => l.regions.contains(r), orElse: () => CheBrainLobe.knowledge);

/// The region a spoken or typed name means ("memory", "the trading region", "agents", "region 3"), or null. A number
/// counts from 1 in the order CHE reads the regions aloud.
CheBrainLobe? cheBrainLobeFromWords(String words) {
  var t = words.toLowerCase().replaceAll('&', ' and ').replaceAll(RegExp(r'[^a-z0-9 ]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  t = t.replaceFirst(RegExp(r'^(?:the|my|your|che s|ches) '), '').replaceFirst(RegExp(r' (?:region|lobe|area|part)$'), '').trim();
  final n = RegExp(r'^(?:region |number |region number )?(\d{1,2}|one|two|three|four|five|six|seven)$').firstMatch(t);
  if (n != null) {
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    final g = n.group(1)!;
    final i = int.tryParse(g) ?? (names.indexOf(g) + 1);
    return i >= 1 && i <= CheBrainLobe.values.length ? CheBrainLobe.values[i - 1] : null;
  }
  return switch (t) {
    'memory' || 'memories' || 'personal' || 'personal memory' || 'people' || 'owner' || 'about me' => CheBrainLobe.memory,
    'conversation' || 'conversations' || 'chat' || 'chats' || 'corrections' => CheBrainLobe.conversations,
    'knowledge' || 'learning' || 'learned knowledge' || 'research' || 'facts' || 'lessons' => CheBrainLobe.knowledge,
    'work' || 'agents and work' || 'agents' || 'agent' || 'tasks' || 'office' || 'coding' || 'code' || 'jobs' => CheBrainLobe.work,
    'trading' || 'trade' || 'trades' || 'markets' => CheBrainLobe.trading,
    'creation' || 'creations' || 'creative' || 'media' || 'videos' || 'images' || 'music' => CheBrainLobe.creation,
    'needs review' || 'review' || 'errors' || 'error' || 'failed' || 'failures' || 'mistakes' => CheBrainLobe.review,
    _ => null,
  };
}

/// One region's real figures.
class CheBrainLobeStat {
  const CheBrainLobeStat({this.count = 0, this.verified = 0, this.fresh = 0});
  final int count;
  final int verified;

  /// Records dated within [cheBrainFreshWindow] of now: the only thing that sends a data pulse.
  final int fresh;
}

/// Real counts per region in one pass over the records. Nothing is invented: no records, every count zero.
Map<CheBrainLobe, CheBrainLobeStat> cheBrainLobeStats(Iterable<CheMemoryDot> dots, {DateTime? now}) {
  final count = {for (final l in CheBrainLobe.values) l: 0};
  final verified = {for (final l in CheBrainLobe.values) l: 0};
  final fresh = {for (final l in CheBrainLobe.values) l: 0};
  final since = (now ?? DateTime.now()).subtract(cheBrainFreshWindow);
  for (final d in dots) {
    final l = cheBrainLobeOfRegion(cheBrainRegionOf(d));
    count[l] = count[l]! + 1;
    if (cheBrainIsVerifiedRecord(d)) verified[l] = verified[l]! + 1;
    final at = d.at;
    if (at != null && at.isAfter(since)) fresh[l] = fresh[l]! + 1;
  }
  return {for (final l in CheBrainLobe.values) l: CheBrainLobeStat(count: count[l]!, verified: verified[l]!, fresh: fresh[l]!)};
}

/// A region's records, newest first, optionally narrowed to one record region and to words in the title or body.
List<CheMemoryDot> cheBrainLobeRecords(CheBrainLobe lobe, Iterable<CheMemoryDot> dots, {CheBrainRegion? only, String query = ''}) {
  final q = query.trim().toLowerCase();
  final out = <CheMemoryDot>[
    for (final d in dots)
      if (_inLobe(lobe, d, only) && (q.isEmpty || d.title.toLowerCase().contains(q) || d.body.toLowerCase().contains(q))) d,
  ];
  out.sort((a, b) => (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0)));
  return out;
}

bool _inLobe(CheBrainLobe lobe, CheMemoryDot d, CheBrainRegion? only) {
  final r = cheBrainRegionOf(d);
  return only != null ? r == only : lobe.regions.contains(r);
}

String _records(int n) => '$n record${n == 1 ? '' : 's'}';

/// "1,234" for big counts.
String cheBrainCount(int n) {
  final s = '$n';
  if (s.length <= 3) return s;
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

/// VoiceOver label of one region: its name, real count, what it is and what activating it does.
String cheBrainLobeSemantics(CheBrainLobe l, CheBrainLobeStat s) {
  final parts = <String>['${l.label} region', _records(s.count)];
  if (s.verified > 0) parts.add('${s.verified} verified');
  if (s.fresh > 0) parts.add('${s.fresh} new today');
  return '${parts.join(', ')}. ${l.meaning} Opens its records.';
}

/// The regions as a numbered spoken list ("1, Memory: 2 records; …"), the order a spoken number picks.
String cheBrainLobesSpoken(Map<CheBrainLobe, CheBrainLobeStat> stats) => [
      for (final (i, l) in CheBrainLobe.values.indexed) '${i + 1}, ${l.label}: ${_records(stats[l]?.count ?? 0)}',
    ].join('; ');

// ─── The view ───────────────────────────────────────────────────────────────

/// The first-glance brain: seven regions, real counts, electrical pathways. [onOpen] opens a region's sheet.
class CheBrainNeuralView extends StatefulWidget {
  const CheBrainNeuralView({super.key, required this.stats, required this.onOpen, this.selected, this.period = const Duration(seconds: 6), this.awakeCycles = 5});

  final Map<CheBrainLobe, CheBrainLobeStat> stats;
  final ValueChanged<CheBrainLobe> onOpen;

  /// The region whose sheet is open (drawn brighter), or null.
  final CheBrainLobe? selected;

  /// One cycle of the ambient animation.
  final Duration period;

  /// Cycles the activity runs after the room opens, a touch or a data change, before it rests on a still frame
  /// (battery; and the screen settles). New records, a tap or reopening wake it again.
  final int awakeCycles;

  @override
  State<CheBrainNeuralView> createState() => _CheBrainNeuralViewState();
}

class _CheBrainNeuralViewState extends State<CheBrainNeuralView> with SingleTickerProviderStateMixin {
  late final AnimationController _clock = AnimationController(vsync: this, duration: widget.period);
  final _geometry = CheBrainNeuralGeometry();

  // When a region last grew while the room was open (in clock cycles), for its burst ring.
  final Map<CheBrainLobe, double> _burstAt = {};
  double _cycles = 0;
  double _last = 0;

  bool _still = false; // reduced motion: never animates
  bool _resting = false; // ran its awake cycles; drawn still until woken
  double _wokeAt = 0;

  @override
  void initState() {
    super.initState();
    _clock.addListener(_count);
  }

  void _count() {
    final v = _clock.value;
    if (v < _last) {
      _cycles += 1;
      if (_cycles - _wokeAt >= widget.awakeCycles) {
        _clock.stop();
        setState(() => _resting = true);
      }
    }
    _last = v;
  }

  /// Starts the activity again (new records, a touch).
  void _wake() {
    _wokeAt = _cycles;
    if (_resting) setState(() => _resting = false);
    _syncClock();
  }

  double get _now => _cycles + _clock.value;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _syncClock();
  }

  @override
  void didUpdateWidget(covariant CheBrainNeuralView old) {
    super.didUpdateWidget(old);
    if (old.period != widget.period) _clock.duration = widget.period;
    var grew = false;
    for (final l in CheBrainLobe.values) {
      if ((widget.stats[l]?.count ?? 0) > (old.stats[l]?.count ?? 0)) {
        _burstAt[l] = _now;
        grew = true;
      }
    }
    if (grew) _wake();
  }

  void _syncClock() {
    if (_still || _resting) {
      if (_clock.isAnimating) _clock.stop();
    } else if (!_clock.isAnimating) {
      _clock.repeat();
    }
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  /// The brain's box inside the view: as large as fits, a little taller than wide (seen from above).
  static Rect brainBox(Size size) {
    const aspect = 1.28; // height / width
    final w = math.min(size.width - 40, (size.height - 36) / aspect).clamp(120.0, 620.0).toDouble();
    final h = w * aspect;
    return Rect.fromLTWH((size.width - w) / 2, math.max(8, (size.height - h) / 2 - 6), w, h);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final size = Size(c.maxWidth, c.maxHeight);
      final box = brainBox(size);
      return Stack(
        clipBehavior: Clip.none,
        children: [
          // Decoration and the region glows: one painter, no semantics, no per-node widgets.
          Positioned.fill(
            child: ExcludeSemantics(
              key: const ValueKey('brain-neural-decor'),
              child: RepaintBoundary(
                child: CustomPaint(
                  key: const ValueKey('brain-neural-paint'),
                  painter: CheBrainNeuralPainter(
                    clock: _clock,
                    geometry: _geometry,
                    stats: widget.stats,
                    selected: widget.selected,
                    still: _still || _resting,
                    cycles: () => _now,
                    bursts: _burstAt,
                  ),
                ),
              ),
            ),
          ),
          // Data: the seven regions, each one VoiceOver button with its name, count and meaning.
          for (final l in CheBrainLobe.values.take(cheBrainLobeCap)) _region(l, box, size),
        ],
      );
    });
  }

  Widget _region(CheBrainLobe l, Rect box, Size size) {
    final s = widget.stats[l] ?? const CheBrainLobeStat();
    final p = box.topLeft + Offset(l.anchor.dx * box.width, l.anchor.dy * box.height);
    const w = 132.0;
    final left = (p.dx - w / 2).clamp(4.0, math.max(4.0, size.width - w - 4)).toDouble();
    final on = widget.selected == l;
    final empty = s.count == 0;
    return Positioned(
      left: left,
      top: p.dy - 22,
      width: w,
      child: Semantics(
        button: true,
        selected: on,
        label: cheBrainLobeSemantics(l, s),
        excludeSemantics: true,
        child: GestureDetector(
          key: ValueKey('brain-lobe-${l.name}'),
          behavior: HitTestBehavior.opaque,
          onTap: () {
            _wake();
            widget.onOpen(l);
          },
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // The hub itself is painted; this keeps the 44-point touch target over it.
              const SizedBox(height: 44),
              Text(
                l.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, letterSpacing: .3, color: empty ? Colors.white54 : Colors.white, shadows: const [Shadow(color: Colors.black, blurRadius: 6)]),
              ),
              Text(
                empty ? 'none yet' : cheBrainCount(s.count),
                key: ValueKey('brain-lobe-count-${l.name}'),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: empty ? 13 : 19, fontWeight: FontWeight.w800, color: empty ? Colors.white38 : l.color, fontFeatures: const [FontFeature.tabularFigures()], shadows: const [Shadow(color: Colors.black, blurRadius: 6)]),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Decorative geometry, built once per size: the outline, the folds, ambient neurons and their faint links.
class CheBrainNeuralGeometry {
  Size? _size;
  late Rect box;
  late Path body;
  late Path outline;
  late Path folds;
  late List<Offset> neurons;
  late List<double> phases;
  late List<(int, int)> links;
  late Offset core;
  late Map<CheBrainLobe, Offset> hubs;
  late List<(Offset, Offset, Offset)> pathways; // start, control, end
  late List<CheBrainLobe?> pathwayLobe; // the region a core pathway leads to; null for a region-to-region one
  late List<Path> pathwayPaths;

  static const int ambientNeurons = 72;

  void ensure(Size size) {
    if (_size == size) return;
    _size = size;
    box = _CheBrainNeuralViewState.brainBox(size);
    Offset at(double x, double y) => box.topLeft + Offset(x * box.width, y * box.height);
    core = at(.5, .45);
    hubs = {for (final l in CheBrainLobe.values) l: at(l.anchor.dx, l.anchor.dy)};

    // Two hemispheres seen from above: rounded superellipses, a little wider at the back, with a gentle ripple of
    // folds along the rim, flat along the fissure between them; the stem below.
    Path hemi(double side, {double scale = 1, double ripple = .008, int folds = 16}) {
      final cx = .5 + side * .2 * scale + side * .2 * (1 - scale) * 1.1, cy = .44;
      const n = 2.3, steps = 160;
      final pts = <Offset>[];
      for (var i = 0; i < steps; i++) {
        final th = i / steps * math.pi * 2;
        final c = math.cos(th), sn = math.sin(th);
        final ex = c.sign * math.pow(c.abs(), 2 / n);
        final ey = sn.sign * math.pow(sn.abs(), 2 / n);
        final taper = .9 + .1 * (ey + 1) / 2;
        final bump = 1 + ripple * math.sin(folds * th + side);
        var x = cx + .29 * scale * taper * ex * bump;
        final y = cy + .415 * scale * ey * bump;
        if (side * (x - .5) < .012 + (1 - scale) * .08) x = .5 + side * (.012 + (1 - scale) * .08);
        pts.add(at(x, y));
      }
      final path = Path()..moveTo((pts.last.dx + pts.first.dx) / 2, (pts.last.dy + pts.first.dy) / 2);
      for (var i = 0; i < pts.length; i++) {
        final p = pts[i], q = pts[(i + 1) % pts.length];
        path.quadraticBezierTo(p.dx, p.dy, (p.dx + q.dx) / 2, (p.dy + q.dy) / 2);
      }
      return path..close();
    }

    body = Path()
      ..addPath(hemi(-1), Offset.zero)
      ..addPath(hemi(1), Offset.zero);
    outline = Path()
      ..addPath(body, Offset.zero)
      ..moveTo(at(.47, .86).dx, at(.47, .86).dy)
      ..quadraticBezierTo(at(.475, .94).dx, at(.475, .94).dy, at(.485, .99).dx, at(.485, .99).dy)
      ..moveTo(at(.53, .86).dx, at(.53, .86).dy)
      ..quadraticBezierTo(at(.525, .94).dx, at(.525, .94).dy, at(.515, .99).dx, at(.515, .99).dy);

    // Gyri: two inner rims per hemisphere with a deeper ripple.
    folds = Path();
    for (final side in [-1.0, 1.0]) {
      folds
        ..addPath(hemi(side, scale: .76, ripple: .035, folds: 11), Offset.zero)
        ..addPath(hemi(side, scale: .5, ripple: .05, folds: 8), Offset.zero);
    }

    // Seeded so the brain looks the same every time; points kept inside the outline.
    final rnd = math.Random(7);
    neurons = [];
    phases = [];
    var guard = 0;
    while (neurons.length < ambientNeurons && guard++ < 4000) {
      final p = at(.06 + rnd.nextDouble() * .88, .05 + rnd.nextDouble() * .80);
      if (!body.contains(p)) continue;
      neurons.add(p);
      phases.add(rnd.nextDouble() * math.pi * 2);
    }
    links = [];
    for (var i = 0; i < neurons.length; i++) {
      final near = [for (var j = 0; j < neurons.length; j++) if (j != i) j]
        ..sort((a, b) => (neurons[a] - neurons[i]).distanceSquared.compareTo((neurons[b] - neurons[i]).distanceSquared));
      for (final j in near.take(2)) {
        if (j > i) links.add((i, j));
      }
    }

    (Offset, Offset, Offset) curve(Offset a, Offset b, double bend) {
      final mid = Offset.lerp(a, b, .5)!;
      final d = b - a;
      final normal = Offset(-d.dy, d.dx) / (d.distance == 0 ? 1 : d.distance);
      return (a, mid + normal * bend * d.distance, b);
    }

    pathways = [];
    pathwayLobe = [];
    for (final l in CheBrainLobe.values) {
      pathways.add(curve(core, hubs[l]!, l.anchor.dx < .5 ? .12 : -.12));
      pathwayLobe.add(l);
    }
    const ring = [
      (CheBrainLobe.memory, CheBrainLobe.conversations),
      (CheBrainLobe.conversations, CheBrainLobe.work),
      (CheBrainLobe.knowledge, CheBrainLobe.trading),
      (CheBrainLobe.trading, CheBrainLobe.creation),
      (CheBrainLobe.memory, CheBrainLobe.knowledge),
      (CheBrainLobe.work, CheBrainLobe.review),
      (CheBrainLobe.creation, CheBrainLobe.review),
      (CheBrainLobe.work, CheBrainLobe.creation),
    ];
    for (final (a, b) in ring) {
      pathways.add(curve(hubs[a]!, hubs[b]!, .10));
      pathwayLobe.add(null);
    }
    pathwayPaths = [
      for (final (a, k, b) in pathways)
        Path()
          ..moveTo(a.dx, a.dy)
          ..quadraticBezierTo(k.dx, k.dy, b.dx, b.dy),
    ];
  }
}

Offset _quad((Offset, Offset, Offset) c, double t) {
  final (a, k, b) = c;
  final u = 1 - t;
  return a * (u * u) + k * (2 * u * t) + b * (t * t);
}

/// Paints the whole brain in one pass. Public for the frame-cost test.
class CheBrainNeuralPainter extends CustomPainter {
  CheBrainNeuralPainter({
    required this.clock,
    required this.stats,
    this.selected,
    this.still = false,
    this.cycles,
    Map<CheBrainLobe, double>? bursts,
    CheBrainNeuralGeometry? geometry,
  })  : _geometry = geometry ?? CheBrainNeuralGeometry(),
        _bursts = bursts ?? const {},
        super(repaint: clock);

  final Animation<double> clock;
  final Map<CheBrainLobe, CheBrainLobeStat> stats;
  final CheBrainLobe? selected;
  final bool still;
  /// Clock cycles since the view opened (for burst rings); the clock's value when null.
  final double Function()? cycles;
  final Map<CheBrainLobe, double> _bursts;
  final CheBrainNeuralGeometry _geometry;

  static const _teal = Color(0xFF2EF2D0);
  static const _ice = Color(0xFF9FFFF0);

  final Paint _stroke = Paint()..style = PaintingStyle.stroke;
  final Paint _fill = Paint();

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final g = _geometry..ensure(size);
    final t = still ? 0.0 : clock.value; // 0..1 per cycle
    final wave = t * math.pi * 2;

    // Brain body: a soft teal haze, the outline and the folds (decoration).
    _fill.shader = RadialGradient(colors: [_teal.withValues(alpha: .10), _teal.withValues(alpha: .03), Colors.transparent], stops: const [0, .6, 1])
        .createShader(Rect.fromCircle(center: g.core, radius: g.box.height * .62));
    canvas.drawPath(g.outline, _fill);
    _fill.shader = null;
    _stroke
      ..strokeWidth = 1.4
      ..color = _teal.withValues(alpha: .34);
    canvas.drawPath(g.outline, _stroke);
    _stroke
      ..strokeWidth = 1
      ..color = _teal.withValues(alpha: .10);
    canvas.drawPath(g.folds, _stroke);

    // Ambient neurons and their faint links, twinkling slowly (decoration).
    _stroke
      ..strokeWidth = .7
      ..color = _ice.withValues(alpha: .07);
    for (final (a, b) in g.links) {
      canvas.drawLine(g.neurons[a], g.neurons[b], _stroke);
    }
    for (var i = 0; i < g.neurons.length; i++) {
      final a = still ? .30 : .18 + .22 * (.5 + .5 * math.sin(wave + g.phases[i]));
      _fill.color = _ice.withValues(alpha: a);
      canvas.drawCircle(g.neurons[i], 1.3, _fill);
    }

    // Pathways: every one carries a slow dim pulse (decoration); a region with records from the last day also gets
    // bright pulses from the core (data).
    for (var i = 0; i < g.pathways.length; i++) {
      final c = g.pathways[i];
      final lobe = g.pathwayLobe[i];
      final s = lobe == null ? null : stats[lobe];
      final live = (s?.count ?? 0) > 0;
      final color = lobe?.color ?? _teal;
      final path = g.pathwayPaths[i];
      if (live) {
        // A soft wide glow under a pathway that leads to records.
        _stroke
          ..strokeWidth = 6
          ..color = color.withValues(alpha: .07);
        canvas.drawPath(path, _stroke);
      }
      _stroke
        ..strokeWidth = lobe == null ? 1 : 1.6
        ..color = color.withValues(alpha: lobe == null ? .12 : (live ? .38 : .10));
      canvas.drawPath(path, _stroke);
      if (still) continue;
      final p = _quad(c, (t + i * .137) % 1);
      _fill.color = _ice.withValues(alpha: .22);
      canvas.drawCircle(p, 1.6, _fill);
      final fresh = s?.fresh ?? 0;
      if (fresh > 0) {
        final n = math.min(3, fresh);
        for (var k = 0; k < n; k++) {
          final q = (t * 1.6 + k / n) % 1;
          final pos = _quad(c, q);
          _fill.shader = RadialGradient(colors: [Colors.white, color, color.withValues(alpha: 0)], stops: const [0, .3, 1]).createShader(Rect.fromCircle(center: pos, radius: 9));
          canvas.drawCircle(pos, 9, _fill);
          _fill.shader = null;
        }
      }
    }

    // CHE's core, where the pathways meet (decoration).
    final coreR = 9 + (still ? 0 : 1.5 * math.sin(wave));
    _fill.shader = RadialGradient(colors: [Colors.white.withValues(alpha: .9), _teal.withValues(alpha: .55), _teal.withValues(alpha: 0)], stops: const [0, .3, 1])
        .createShader(Rect.fromCircle(center: g.core, radius: coreR * 2.6));
    canvas.drawCircle(g.core, coreR * 2.6, _fill);
    _fill.shader = null;

    // Region hubs: size from the real count, a steady ring for fresh records, a burst when a count grows.
    final now = cycles?.call() ?? t;
    for (final l in CheBrainLobe.values.take(cheBrainLobeCap)) {
      final s = stats[l] ?? const CheBrainLobeStat();
      final c = g.hubs[l]!;
      final empty = s.count == 0;
      final r = empty ? 7.0 : (9 + 3.2 * math.log(1 + s.count) / math.ln10).clamp(9.0, 22.0).toDouble();
      final on = selected == l;
      final glow = r * (on ? 3.4 : 2.6);
      _fill.shader = RadialGradient(colors: [l.color.withValues(alpha: empty ? .10 : (on ? .55 : .38)), l.color.withValues(alpha: 0)])
          .createShader(Rect.fromCircle(center: c, radius: glow));
      canvas.drawCircle(c, glow, _fill);
      _fill.shader = null;
      _fill.color = const Color(0xFF02080A);
      canvas.drawCircle(c, r, _fill);
      _stroke
        ..strokeWidth = on ? 2.6 : 1.8
        ..color = l.color.withValues(alpha: empty ? .35 : .95);
      canvas.drawCircle(c, r, _stroke);
      _fill.color = l.color.withValues(alpha: empty ? .25 : .85);
      canvas.drawCircle(c, r * .36, _fill);
      if (s.fresh > 0) {
        _stroke
          ..strokeWidth = 1.2
          ..color = l.color.withValues(alpha: still ? .55 : .25 + .35 * (.5 + .5 * math.sin(wave * 2)));
        canvas.drawCircle(c, r + 5, _stroke);
      }
      final burst = _bursts[l];
      if (!still && burst != null) {
        final age = now - burst; // in cycles
        if (age >= 0 && age < .5) {
          final k = age / .5;
          _stroke
            ..strokeWidth = 2
            ..color = l.color.withValues(alpha: (1 - k) * .8);
          canvas.drawCircle(c, r + 4 + k * 26, _stroke);
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant CheBrainNeuralPainter old) => old.stats != stats || old.selected != selected || old.still != still;
}

// ─── The region sheet ───────────────────────────────────────────────────────

/// One region's detail sheet: its meaning and real figures, a search box, a filter per record region it gathers,
/// and its records newest first, [cheBrainLobePageSize] at a time. Only one sheet is ever open; [onClose] returns
/// to the brain.
class CheBrainLobeSheet extends StatefulWidget {
  const CheBrainLobeSheet({
    super.key,
    required this.lobe,
    required this.dots,
    required this.stat,
    required this.onClose,
    required this.onOpenRecord,
    this.onReadAloud,
    this.now,
    this.initialOnly,
  });

  final CheBrainLobe lobe;
  final List<CheMemoryDot> dots;
  final CheBrainLobeStat stat;
  final VoidCallback onClose;
  final ValueChanged<CheMemoryDot> onOpenRecord;
  final Future<void> Function(String text)? onReadAloud;
  final DateTime? now;

  /// Opens narrowed to one record region ("open the coding region" opens Agents & Work on Coding).
  final CheBrainRegion? initialOnly;

  @override
  State<CheBrainLobeSheet> createState() => _CheBrainLobeSheetState();
}

/// What a region's sheet says when read aloud (its Read button) or answered by voice.
String cheBrainLobeSummary(CheBrainLobe l, CheBrainLobeStat s, List<CheMemoryDot> newestFirst) {
  if (s.count == 0) return '${l.label}: no records on this phone yet. ${l.meaning}';
  final newest = newestFirst.take(3).map((d) => d.title).join('; ');
  return '${l.label}: ${_records(s.count)}, ${s.verified} verified${s.fresh > 0 ? ', ${s.fresh} new today' : ''}. ${l.meaning}${newest.isEmpty ? '' : ' Newest: $newest.'}';
}

class _CheBrainLobeSheetState extends State<CheBrainLobeSheet> {
  final _query = TextEditingController();
  late CheBrainRegion? _only = widget.initialOnly;
  int _shown = cheBrainLobePageSize;

  @override
  void didUpdateWidget(covariant CheBrainLobeSheet old) {
    super.didUpdateWidget(old);
    if (old.lobe != widget.lobe || old.initialOnly != widget.initialOnly) {
      _query.clear();
      _only = widget.initialOnly;
      _shown = cheBrainLobePageSize;
    }
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.lobe;
    final s = widget.stat;
    final all = cheBrainLobeRecords(l, widget.dots, only: _only, query: _query.text);
    final page = all.take(_shown).toList();
    final now = widget.now ?? DateTime.now();
    return Container(
      key: ValueKey('brain-lobe-sheet-${l.name}'),
      decoration: BoxDecoration(
        color: const Color(0xFF040B0E),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
        border: Border(top: BorderSide(color: l.color.withValues(alpha: .55), width: 1.2)),
        boxShadow: [BoxShadow(color: l.color.withValues(alpha: .18), blurRadius: 30, spreadRadius: -6)],
      ),
      // Its own Material, so the record rows' ink shows above the sheet's colour.
      child: Material(type: MaterialType.transparency, child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          ExcludeSemantics(child: Center(child: Container(width: 40, height: 4, decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2))))),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 8, 0),
            child: Row(children: [
              Semantics(
                button: true,
                label: 'Close ${l.label} and go back to the brain',
                excludeSemantics: true,
                child: IconButton(
                  key: const ValueKey('brain-lobe-close'),
                  tooltip: 'Back to the brain',
                  constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                  icon: const Icon(Icons.arrow_back_rounded, color: Colors.white),
                  onPressed: widget.onClose,
                ),
              ),
              Icon(l.icon, color: l.color, size: 22),
              const SizedBox(width: 8),
              Expanded(
                child: Semantics(
                  header: true,
                  label: '${l.label}. ${_records(s.count)}, ${s.verified} verified.',
                  excludeSemantics: true,
                  child: Text(l.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Colors.white)),
                ),
              ),
              if (widget.onReadAloud != null)
                Semantics(
                  button: true,
                  label: 'Read ${l.label} aloud',
                  excludeSemantics: true,
                  child: IconButton(
                    key: const ValueKey('brain-lobe-read'),
                    tooltip: 'Read aloud',
                    constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                    icon: Icon(Icons.volume_up_rounded, color: l.color),
                    onPressed: () => widget.onReadAloud!(cheBrainLobeSummary(l, s, all)),
                  ),
                ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Text(
              '${cheBrainCount(s.count)} record${s.count == 1 ? '' : 's'} · ${cheBrainCount(s.verified)} verified${s.fresh > 0 ? ' · ${s.fresh} new today' : ''}\n${l.meaning}',
              style: const TextStyle(fontSize: 14, height: 1.35, color: Colors.white70),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
            child: TextField(
              key: const ValueKey('brain-lobe-search'),
              controller: _query,
              onChanged: (_) => setState(() => _shown = cheBrainLobePageSize),
              style: const TextStyle(color: Colors.white, fontSize: 16),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Search ${l.label.toLowerCase()}',
                hintStyle: const TextStyle(color: Colors.white38),
                prefixIcon: const Icon(Icons.search_rounded, color: Colors.white54),
                filled: true,
                fillColor: Colors.white.withValues(alpha: .06),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
              ),
            ),
          ),
          if (l.regions.length > 1)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
              child: Wrap(spacing: 6, children: [
                _filter(null, 'All'),
                for (final r in l.regions) _filter(r, r.label),
              ]),
            ),
          Expanded(
            child: page.isEmpty
                ? Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      s.count == 0 ? 'Nothing in ${l.label} on this phone yet. A record appears here only when CHE really saves one.' : 'Nothing in ${l.label} matches "${_query.text}".',
                      key: const ValueKey('brain-lobe-empty'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white60, fontSize: 15),
                    ),
                  )
                : ListView.builder(
                    key: const ValueKey('brain-lobe-list'),
                    padding: EdgeInsets.only(bottom: 16 + MediaQuery.viewPaddingOf(context).bottom),
                    itemCount: page.length + 1,
                    itemBuilder: (_, i) {
                      if (i == page.length) return _footer(page.length, all.length);
                      final d = page[i];
                      final status = cheBrainIsVerifiedRecord(d) ? 'verified' : 'not verified';
                      return Semantics(
                        button: true,
                        label: '${d.title}. $status. ${cheBrainAgo(d.at, now: now)}. Opens the record.',
                        excludeSemantics: true,
                        child: ListTile(
                          key: ValueKey('brain-lobe-record-${d.id}'),
                          minVerticalPadding: 10,
                          onTap: () => widget.onOpenRecord(d),
                          leading: Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: cheBrainLobeOfRegion(cheBrainRegionOf(d)).color)),
                          title: Text(d.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 16)),
                          subtitle: Text('${cheBrainAgo(d.at, now: now)} · $status', style: const TextStyle(color: Colors.white54, fontSize: 13)),
                          trailing: const Icon(Icons.chevron_right_rounded, color: Colors.white38),
                        ),
                      );
                    },
                  ),
          ),
        ],
      )),
    );
  }

  Widget _filter(CheBrainRegion? r, String label) {
    final on = _only == r;
    return Semantics(
      button: true,
      selected: on,
      label: r == null ? 'Show all of ${widget.lobe.label}' : 'Show only ${r.label.toLowerCase()}',
      excludeSemantics: true,
      child: ChoiceChip(
        key: ValueKey('brain-lobe-filter-${r?.name ?? 'all'}'),
        label: Text(label),
        selected: on,
        onSelected: (_) => setState(() {
          _only = r;
          _shown = cheBrainLobePageSize;
        }),
      ),
    );
  }

  Widget _footer(int shown, int total) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(children: [
        Text('Showing ${cheBrainCount(shown)} of ${cheBrainCount(total)}', key: const ValueKey('brain-lobe-showing'), style: const TextStyle(color: Colors.white54, fontSize: 13)),
        if (shown < total)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: OutlinedButton(
              key: const ValueKey('brain-lobe-more'),
              onPressed: () => setState(() => _shown += cheBrainLobePageSize),
              child: Text('Show ${math.min(cheBrainLobePageSize, total - shown)} more'),
            ),
          ),
      ]),
    );
  }
}
