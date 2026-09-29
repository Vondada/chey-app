// CHE Office world: every agent as a little animated character who walks
// between CHE's rooms — the Office desks, the Lounge, the Studio, the Art
// Gallery and the Music room. Where each agent goes comes from the server's
// real runtime state (agent_runtime.js → agentLocation): working agents go to
// the room that fits their assignment, idle agents take breaks in social
// rooms. Nothing is animated as fake work.
//
// Pinch or double-tap to zoom anywhere; tap an agent (or use the voice-friendly
// list below the world) to zoom in on them. When an agent receives a new
// assignment they hop and show a "Got it" bubble, like a pet that heard you.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_agents.dart';
import '../che_ui/che_theme.dart';
import 'che_agent_runtime.dart';

/// A room in the Office world, laid out in world coordinates.
class _Room {
  const _Room(this.id, this.label, this.icon, this.color, this.rect);
  final String id;
  final String label;
  final IconData icon;
  final Color color;
  final Rect rect;
}

const _roomNames = {
  'office': 'the Office',
  'lounge': 'the Lounge',
  'studio': 'the Studio',
  'gallery': 'the Art Gallery',
  'music': 'the Music room',
  'theater': 'the Theater',
};

String cheActivityLabel(String activity) => switch (activity) {
      'making_art' => 'making art',
      'djing' => 'DJing',
      'composing' => 'working on music',
      'creating' => 'creating',
      'on_break' => 'on a break',
      'watching_with_you' => 'watching with you',
      'meeting' => 'in a meeting',
      'researching' => 'researching',
      'building' => 'building',
      'analyzing' => 'analyzing',
      'reviewing' => 'reviewing',
      'waiting' => 'waiting',
      'offline' => 'offline',
      _ => 'idle',
    };

class CheOfficeWorld extends StatefulWidget {
  const CheOfficeWorld({
    super.key,
    required this.che,
    required this.agents,
    required this.level,
    required this.onOpenAgent,
    this.onUpgrade,
    this.height = 460,
  });

  final CheAgent che;
  final List<CheAgentProfile> agents;

  /// Office size level 1–3 (owner-upgradeable).
  final int level;
  final void Function(CheAgent agent) onOpenAgent;
  final Future<void> Function(int level)? onUpgrade;
  final double height;

  @override
  State<CheOfficeWorld> createState() => _CheOfficeWorldState();
}

class _CheOfficeWorldState extends State<CheOfficeWorld> with TickerProviderStateMixin {
  final TransformationController _view = TransformationController();
  late final AnimationController _zoom = AnimationController(vsync: this, duration: const Duration(milliseconds: 520));
  late final AnimationController _bob = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();
  Animation<Matrix4>? _zoomAnim;
  final Map<String, Offset> _spot = {};
  final Map<String, String> _seenAssignment = {};
  final Map<String, DateTime> _ack = {};
  final Map<String, String> _ackText = {};
  final math.Random _rng = math.Random();
  Timer? _wander;
  bool _fitted = false;
  double _viewportWidth = 0;
  String _announcement = '';
  String? _focusedId;

  Size get _world => Size(900 + 320.0 * (widget.level - 1), 640 + 200.0 * (widget.level - 1));

  List<_Room> get _rooms {
    final w = _world.width, h = _world.height;
    const pad = 24.0;
    final colW = (w - pad * 4) / 3;
    final col4 = (w - pad * 5) / 4;
    final topH = h * 0.56;
    final botH = h - topH - pad * 3;
    final botY = pad * 2 + topH;
    return [
      _Room('office', 'Office', Icons.work_outline_rounded, CheColors.office,
          Rect.fromLTWH(pad, pad, colW * 2 + pad, topH)),
      _Room('lounge', 'Lounge', Icons.weekend_outlined, CheColors.warning,
          Rect.fromLTWH(pad * 3 + colW * 2, pad, colW, topH)),
      _Room('studio', 'Studio', Icons.movie_creation_outlined, CheColors.create,
          Rect.fromLTWH(pad, botY, col4, botH)),
      _Room('gallery', 'Art Gallery', Icons.palette_outlined, CheColors.insights,
          Rect.fromLTWH(pad * 2 + col4, botY, col4, botH)),
      _Room('music', 'Music', Icons.graphic_eq_rounded, CheColors.music,
          Rect.fromLTWH(pad * 3 + col4 * 2, botY, col4, botH)),
      _Room('theater', 'Theater', Icons.theaters_outlined, CheColors.danger,
          Rect.fromLTWH(pad * 4 + col4 * 3, botY, col4, botH)),
    ];
  }

  _Room _roomFor(String id) => _rooms.firstWhere((r) => r.id == id, orElse: () => _rooms.first);

  @override
  void initState() {
    super.initState();
    _zoom.addListener(() {
      final a = _zoomAnim;
      if (a != null) _view.value = a.value;
    });
    for (final p in widget.agents) {
      _seenAssignment[p.agent.id] = p.assignmentId;
    }
    _placeAll(initial: true);
    _wander = Timer.periodic(const Duration(milliseconds: 2600), (_) => _wanderStep());
  }

  @override
  void didUpdateWidget(CheOfficeWorld old) {
    super.didUpdateWidget(old);
    final now = DateTime.now();
    for (final p in widget.agents) {
      final id = p.agent.id;
      final seen = _seenAssignment[id];
      final fresh = p.assignmentId.isNotEmpty && seen != null && seen != p.assignmentId &&
          (p.assignmentStatus == 'queued' || p.assignmentStatus == 'running');
      _seenAssignment[id] = p.assignmentId;
      if (fresh) {
        _ack[id] = now;
        final words = p.assignmentTask.trim().split(RegExp(r'\s+'));
        final task = words.length <= 4 ? words.join(' ') : '${words.take(4).join(' ')}…';
        _ackText[id] = 'Got it! $task';
        _announcement = '${p.agent.name} heard you and is on it: ${p.assignmentTask}';
        HapticFeedback.mediumImpact();
      }
    }
    if (old.level != widget.level) _fitted = false;
    _placeAll();
  }

  @override
  void dispose() {
    _wander?.cancel();
    _zoom.dispose();
    _bob.dispose();
    _view.dispose();
    super.dispose();
  }

  // Personality shapes movement: curious/fast/bold agents wander more.
  double _energy(CheAgent a) {
    final p = a.personality.toLowerCase();
    if (RegExp(r'curious|fast|bold|debat|big-picture').hasMatch(p)) return 1.0;
    if (RegExp(r'steady|calm|dry|pragmatic').hasMatch(p)) return 0.45;
    return 0.7;
  }

  Offset _randomSpotIn(_Room room) {
    final r = room.rect.deflate(46);
    final dx = r.left + (_rng.nextDouble() * 0.8 + 0.1) * r.width;
    final dy = r.top + 40 + (_rng.nextDouble() * 0.75) * math.max(1.0, r.height - 40);
    return Offset(dx, dy);
  }

  Offset _deskSpot(int index) {
    final office = _roomFor('office').rect;
    const perRow = 5;
    final col = index % perRow, row = index ~/ perRow;
    return Offset(office.left + 80 + col * ((office.width - 140) / (perRow - 1)), office.top + 110 + row * 120.0);
  }

  void _placeAll({bool initial = false}) {
    for (var i = 0; i < widget.agents.length; i++) {
      final p = widget.agents[i];
      final room = _roomFor(p.room);
      final current = _spot[p.agent.id];
      final inRoom = current != null && room.rect.contains(current);
      if (inRoom && !initial) continue;
      _spot[p.agent.id] = p.room == 'office' && p.working ? _deskSpot(i) : _randomSpotIn(room);
    }
    _spot.putIfAbsent('che', () {
      final office = _roomFor('office').rect;
      return Offset(office.center.dx, office.bottom - 70);
    });
    _spot.removeWhere((id, _) => id != 'che' && !widget.agents.any((p) => p.agent.id == id));
  }

  void _wanderStep() {
    if (!mounted || CheMotion.reduced(context)) return;
    setState(() {
      for (var i = 0; i < widget.agents.length; i++) {
        final p = widget.agents[i];
        // Workers stay at their station; others stroll around their room.
        if (p.working && p.room == 'office') continue;
        if (_rng.nextDouble() > _energy(p.agent) * 0.6) continue;
        _spot[p.agent.id] = _randomSpotIn(_roomFor(p.room));
      }
      _ack.removeWhere((_, at) => DateTime.now().difference(at) > const Duration(seconds: 4));
    });
  }

  void _fit(double viewportWidth) {
    _viewportWidth = viewportWidth;
    if (_fitted) return;
    _fitted = true;
    // Never change the view controller during build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Open at a roomy, readable scale: fill the height and start on the
      // Office itself; pan sideways to walk to the other rooms.
      final fitWidth = _viewportWidth / _world.width;
      final s = math.max(fitWidth, math.min(1.0, widget.height / _world.height));
      final office = _roomFor('office').rect;
      final tx = math.min(0.0, math.max(_viewportWidth - _world.width * s, -(office.left * s) + 8));
      _view.value = Matrix4(s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1);
    });
  }

  void _animateTo(Matrix4 target) {
    _zoomAnim = Matrix4Tween(begin: _view.value, end: target)
        .animate(CurvedAnimation(parent: _zoom, curve: Curves.easeInOutCubic));
    _zoom.forward(from: 0);
  }

  void zoomToAgent(String id) {
    final spot = _spot[id];
    if (spot == null || _viewportWidth == 0) return;
    const s = 2.6;
    final tx = _viewportWidth / 2 - spot.dx * s;
    final ty = widget.height / 2 - spot.dy * s;
    HapticFeedback.selectionClick();
    setState(() => _focusedId = id);
    _animateTo(Matrix4(s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1));
  }

  void _resetView() {
    final s = _viewportWidth / _world.width;
    setState(() => _focusedId = null);
    _animateTo(Matrix4(s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));
  }

  String _describe(CheAgentProfile p) =>
      '${p.agent.name}, ${p.agent.role}, in ${_roomNames[p.room] ?? p.room}, ${cheActivityLabel(p.activity)}'
      '${p.agent.task != null && p.working ? ': ${p.agent.task}' : ''}';

  Widget _roomView(_Room room) {
    final here = widget.agents.where((p) => p.room == room.id).length;
    return Positioned.fromRect(
      rect: room.rect,
      child: Container(
        decoration: BoxDecoration(
          color: room.color.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(28),
          border: Border.all(color: room.color.withValues(alpha: 0.35), width: 2),
        ),
        padding: const EdgeInsets.all(14),
        alignment: Alignment.topLeft,
        child: Row(children: [
          Icon(room.icon, color: room.color, size: 22),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              '${room.label} · $here',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: CheType.label.copyWith(color: room.color, fontSize: 18),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _props() {
    final office = _roomFor('office').rect;
    final lounge = _roomFor('lounge').rect;
    final music = _roomFor('music').rect;
    final gallery = _roomFor('gallery').rect;
    Widget prop(Rect r, Color c, {double radius = 10}) => Positioned.fromRect(
          rect: r,
          child: DecoratedBox(decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(radius))),
        );
    return Stack(children: [
      for (var i = 0; i < 10; i++)
        if (_deskSpot(i).dy + 40 < office.bottom)
          prop(Rect.fromCenter(center: _deskSpot(i) + const Offset(0, 34), width: 92, height: 22), CheColors.surfaceHi),
      prop(Rect.fromLTWH(lounge.left + 30, lounge.bottom - 90, lounge.width - 60, 40), CheColors.warning.withValues(alpha: 0.25), radius: 20),
      prop(Rect.fromLTWH(music.center.dx - 60, music.top + 60, 120, 34), CheColors.music.withValues(alpha: 0.3)),
      for (var i = 0; i < 3; i++)
        prop(Rect.fromLTWH(gallery.left + 24 + i * (gallery.width - 48) / 3, gallery.top + 56, (gallery.width - 48) / 3 - 14, 46),
            CheColors.insights.withValues(alpha: 0.22), radius: 4),
    ]);
  }

  Widget _walker(CheAgent agent, {CheAgentProfile? profile}) {
    final spot = _spot[agent.id] ?? Offset.zero;
    final acked = _ack.containsKey(agent.id);
    final energy = _energy(agent);
    final label = profile == null ? 'CHE, your manager. Double tap to talk to her.' : '${_describe(profile)}. Double tap to zoom in.';
    return AnimatedPositioned(
      key: ValueKey(agent.id),
      duration: Duration(milliseconds: (2400 / (0.6 + energy)).round()),
      curve: Curves.easeInOutSine,
      left: spot.dx - 34,
      top: spot.dy - 70,
      child: Semantics(
        button: true,
        label: label,
        child: GestureDetector(
          onTap: () => zoomToAgent(agent.id),
          onDoubleTap: () => widget.onOpenAgent(agent),
          onLongPress: () => widget.onOpenAgent(agent),
          child: AnimatedBuilder(
            animation: _bob,
            builder: (context, child) {
              final t = _bob.value * 2 * math.pi;
              final hop = acked ? -math.max(0.0, math.sin(t * 2)) * 18 : -math.max(0.0, math.sin(t)) * 3 * energy;
              return Transform.translate(offset: Offset(0, hop), child: child);
            },
            child: SizedBox(
              width: 68,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                if (acked)
                  Container(
                    constraints: const BoxConstraints(maxWidth: 150),
                    margin: const EdgeInsets.only(bottom: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(color: CheColors.accent, borderRadius: BorderRadius.circular(12)),
                    child: Text(_ackText[agent.id] ?? 'Got it!',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: CheType.caption.copyWith(color: const Color(0xFF03120F), fontWeight: FontWeight.w700)),
                  ),
                DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    boxShadow: _focusedId == agent.id
                        ? [BoxShadow(color: agent.color.withValues(alpha: 0.6), blurRadius: 24)]
                        : const [],
                  ),
                  child: CheMiniPerson(agent: agent, size: 54),
                ),
                Text(agent.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: CheType.caption.copyWith(color: CheColors.text, fontWeight: FontWeight.w600)),
                if (profile != null && profile.activity != 'idle')
                  Text(cheActivityLabel(profile.activity),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.caption.copyWith(fontSize: 10)),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final world = _world;
    final working = widget.agents.where((p) => p.working).length;
    final onBreak = widget.agents.where((p) => p.activity == 'on_break').length;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Semantics(
        liveRegion: true,
        child: Text(
          _announcement.isNotEmpty
              ? _announcement
              : '${widget.agents.length} agents · $working working · $onBreak on a break',
          style: CheType.label,
        ),
      ),
      const SizedBox(height: CheSpace.sm),
      ClipRRect(
        borderRadius: BorderRadius.circular(CheRadius.lg),
        child: Container(
          height: widget.height,
          color: CheColors.surface,
          child: LayoutBuilder(builder: (context, constraints) {
            _fit(constraints.maxWidth);
            return Semantics(
              label: 'Office world map. Pinch to zoom. Agents are listed below for voice control.',
              child: InteractiveViewer(
                transformationController: _view,
                constrained: false,
                minScale: 0.2,
                maxScale: 4,
                boundaryMargin: const EdgeInsets.all(240),
                child: SizedBox(
                  width: world.width,
                  height: world.height,
                  child: Stack(clipBehavior: Clip.none, children: [
                    for (final room in _rooms) _roomView(room),
                    Positioned.fill(child: _props()),
                    _walker(widget.che),
                    for (final p in widget.agents) _walker(p.agent, profile: p),
                  ]),
                ),
              ),
            );
          }),
        ),
      ),
      const SizedBox(height: CheSpace.sm),
      Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.sm, children: [
        Semantics(
          button: true,
          label: 'Show the whole office',
          child: OutlinedButton.icon(
            onPressed: _resetView,
            icon: const Icon(Icons.zoom_out_map_rounded, size: 18),
            label: const Text('Whole office'),
          ),
        ),
        if (widget.onUpgrade != null && widget.level < 3)
          Semantics(
            button: true,
            label: 'Upgrade the office to size ${widget.level + 1} of 3, with more room to work and socialize',
            child: FilledButton.icon(
              onPressed: () => widget.onUpgrade!(widget.level + 1),
              icon: const Icon(Icons.open_in_full_rounded, size: 18),
              label: Text('Bigger office (${widget.level + 1}/3)'),
            ),
          ),
        if (widget.onUpgrade != null && widget.level > 1)
          Semantics(
            button: true,
            label: 'Make the office smaller, size ${widget.level - 1} of 3',
            child: TextButton(
              onPressed: () => widget.onUpgrade!(widget.level - 1),
              child: const Text('Smaller'),
            ),
          ),
      ]),
      const SizedBox(height: CheSpace.md),
      Text('WHERE EVERYONE IS', style: CheType.overline),
      const SizedBox(height: CheSpace.xs),
      for (var i = 0; i < widget.agents.length; i++)
        Semantics(
          button: true,
          label: '${i + 1}. ${_describe(widget.agents[i])}. Double tap to zoom in on ${widget.agents[i].agent.name}.',
          excludeSemantics: true,
          onTap: () => zoomToAgent(widget.agents[i].agent.id),
          onLongPress: () => widget.onOpenAgent(widget.agents[i].agent),
          child: ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: CheMiniPerson(agent: widget.agents[i].agent, size: 30),
            title: Text(widget.agents[i].agent.name, style: CheType.body),
            subtitle: Text(
              '${_roomNames[widget.agents[i].room] ?? widget.agents[i].room} · ${cheActivityLabel(widget.agents[i].activity)}',
              style: CheType.caption,
            ),
            trailing: const Icon(Icons.zoom_in_rounded, size: 20),
            onTap: () => zoomToAgent(widget.agents[i].agent.id),
            onLongPress: () => widget.onOpenAgent(widget.agents[i].agent),
          ),
        ),
    ]);
  }
}

/// Office agents who are currently in one of CHE's other rooms (the Music
/// studio, the Art Gallery…), walking along the bottom of that tab so the
/// owner sees who is working or hanging out there. Hidden when nobody is.
class CheRoomVisitors extends StatefulWidget {
  const CheRoomVisitors({super.key, required this.runtime, required this.rooms, this.onOpenOffice});

  final CheAgentRuntimeController runtime;

  /// Server room ids shown here, e.g. {'music', 'studio'} or {'gallery'}.
  final Set<String> rooms;
  final VoidCallback? onOpenOffice;

  @override
  State<CheRoomVisitors> createState() => _CheRoomVisitorsState();
}

class _CheRoomVisitorsState extends State<CheRoomVisitors> with SingleTickerProviderStateMixin {
  late final AnimationController _walk = AnimationController(vsync: this, duration: const Duration(seconds: 14))..repeat();

  @override
  void initState() {
    super.initState();
    widget.runtime.addListener(_changed);
  }

  @override
  void dispose() {
    widget.runtime.removeListener(_changed);
    _walk.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final here = widget.runtime.agents.where((p) => widget.rooms.contains(p.room)).toList();
    if (here.isEmpty) return const SizedBox.shrink();
    final reduced = CheMotion.reduced(context);
    final spoken = here.map((p) => '${p.agent.name} is ${cheActivityLabel(p.activity)}').join(', ');
    return Semantics(
      button: widget.onOpenOffice != null,
      label: '$spoken here. ${widget.onOpenOffice != null ? 'Double tap to open the Office.' : ''}',
      excludeSemantics: true,
      onTap: widget.onOpenOffice,
      child: GestureDetector(
        onTap: widget.onOpenOffice,
        child: SizedBox(
          height: 92,
          child: LayoutBuilder(builder: (context, constraints) {
            final width = constraints.maxWidth;
            return AnimatedBuilder(
              animation: _walk,
              builder: (context, _) => Stack(children: [
                for (var i = 0; i < here.length; i++)
                  Positioned(
                    bottom: 0,
                    left: reduced
                        ? 12.0 + i * 70
                        : (((_walk.value + i / here.length) % 1.0) * (width + 70)) - 70,
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      CheMiniPerson(agent: here[i].agent, size: 44),
                      Text(
                        '${here[i].agent.name} · ${cheActivityLabel(here[i].activity)}',
                        style: CheType.caption.copyWith(fontSize: 10, color: CheColors.text),
                      ),
                    ]),
                  ),
              ]),
            );
          }),
        ),
      ),
    );
  }
}
