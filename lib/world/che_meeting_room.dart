// CHE Meeting Room (Spatial World MVP 1, owner 2026-10-20). A real War Room
// meeting drawn as a room: the agents walk to seats at the table, the
// objective is on the centre display, each real draft and cross-check lands
// as a card in front of its author, and after CHE's synthesis one recommended
// path lights up in the centre. Everything comes from the Worker's scene
// (world_scene.js); nothing moves unless the meeting record changed.
//
// Voice-first: the numbered list under the room is the same scene, read by
// VoiceOver; every item opens to its full text with "Read aloud". Passive
// arrivals are silent (quiet text and a light haptic); CHE speaks once, when
// the meeting the owner started finishes.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_agents.dart';
import 'che_scene_model.dart';

class CheMeetingRoom extends StatefulWidget {
  const CheMeetingRoom({super.key, required this.meetingId, required this.load, required this.onSpeak, this.pollEvery = const Duration(seconds: 3)});

  final String meetingId;

  /// Fetches the scene (CheAgentRuntimeClient.meetingScene in the app).
  final Future<Map<String, dynamic>> Function(String id) load;
  final Future<void> Function(String text) onSpeak;
  final Duration pollEvery;

  /// The room on screen, for voice questions asked while it is open.
  static final current = ValueNotifier<CheScene?>(null);

  static Route<void> route({required CheAgentRuntimeClient client, required String meetingId, required Future<void> Function(String) onSpeak}) =>
      MaterialPageRoute<void>(builder: (_) => CheMeetingRoom(meetingId: meetingId, load: client.meetingScene, onSpeak: onSpeak));

  @override
  State<CheMeetingRoom> createState() => _CheMeetingRoomState();
}

class _CheMeetingRoomState extends State<CheMeetingRoom> {
  static const _gold = Color(0xFFE8B04A);
  CheScene? _scene;
  String? _error;
  Timer? _timer;
  final Set<String> _seen = {};

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (CheMeetingRoom.current.value?.id == widget.meetingId) CheMeetingRoom.current.value = null;
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final next = CheScene.fromJson(await widget.load(widget.meetingId));
      if (!mounted) return;
      if (next == null) {
        setState(() => _error = 'This meeting is not available.');
        return;
      }
      final before = _scene;
      if (before?.version != next.version) {
        final fresh = next.objects.where((o) => !_seen.contains(o.id) && !o.isAvatar).length;
        if (before != null && fresh > 0) HapticFeedback.selectionClick();
        _seen.addAll(next.objects.map((o) => o.id));
        setState(() {
          _scene = next;
          _error = null;
        });
        CheMeetingRoom.current.value = next;
        // The owner started this meeting: say once how it ended.
        if (before != null && !before.finished && next.finished) {
          unawaited(widget.onSpeak(next.path == null ? next.spoken : '${next.spoken} ${next.path!.spoken}'));
        }
      }
      _timer?.cancel();
      if (!next.finished) _timer = Timer(widget.pollEvery, _refresh);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = 'Could not load the meeting: $error');
      _timer?.cancel();
      _timer = Timer(widget.pollEvery * 2, _refresh);
    }
  }

  void _inspect(CheSceneObject o) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(o.label, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              _ProvenanceBadge(o),
              const SizedBox(height: 12),
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.5),
                child: SingleChildScrollView(child: SelectableText(o.text.isNotEmpty ? o.text : o.detail, style: const TextStyle(fontSize: 19, height: 1.4))),
              ),
              const SizedBox(height: 8),
              Text('From ${o.sourceStore}${o.sourceId.isEmpty ? '' : ' #${o.sourceId}'}', style: const TextStyle(fontSize: 13, color: Colors.white54)),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () => widget.onSpeak('${o.spoken} That is ${o.provenanceSpoken}.'),
                icon: const Icon(Icons.volume_up_rounded),
                label: const Text('Read aloud'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Meeting Room'),
        actions: [
          if (scene != null)
            IconButton(
              tooltip: 'Read the meeting aloud',
              icon: const Icon(Icons.record_voice_over_rounded),
              onPressed: () => widget.onSpeak(scene.path == null ? scene.spoken : '${scene.spoken} ${scene.path!.spoken}'),
            ),
        ],
      ),
      body: scene == null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error ?? 'Gathering the team…', style: const TextStyle(fontSize: 18), textAlign: TextAlign.center)))
          : ListView(
              padding: const EdgeInsets.only(bottom: 32),
              children: [
                // Quiet status: visible, readable by VoiceOver, never announced on its own.
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(scene.title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(scene.spoken, style: const TextStyle(fontSize: 16, color: Colors.white70)),
                ),
                if (!scene.finished)
                  Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: LinearProgressIndicator(value: scene.progress.clamp(0.02, 1.0))),
                if (_error != null) Padding(padding: const EdgeInsets.all(16), child: Text(_error!, style: const TextStyle(color: Colors.orangeAccent))),
                ExcludeSemantics(child: AspectRatio(aspectRatio: 1.05, child: _Table(scene: scene, onTap: _inspect))),
                for (final (i, o) in scene.readingOrder.indexed)
                  Semantics(
                    button: true,
                    label: '${i + 1}. ${o.label}. ${o.provenanceSpoken}. ${o.preview}',
                    excludeSemantics: true,
                    child: ListTile(
                      leading: CircleAvatar(
                        backgroundColor: o.isPath ? _gold : (o.isOutcome ? Colors.white24 : Colors.white10),
                        child: Text('${i + 1}', style: TextStyle(color: o.isPath ? Colors.black : Colors.white)),
                      ),
                      title: Text(o.label, style: TextStyle(fontWeight: o.isPath ? FontWeight.w700 : FontWeight.w500)),
                      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(o.preview, maxLines: 3, overflow: TextOverflow.ellipsis),
                        const SizedBox(height: 4),
                        _ProvenanceBadge(o),
                      ]),
                      onTap: () => _inspect(o),
                    ),
                  ),
              ],
            ),
    );
  }
}

/// Provenance is drawn the same way everywhere: filled for live state and the
/// owner's request, outlined for model output, gold outline for CHE's synthesis.
class _ProvenanceBadge extends StatelessWidget {
  const _ProvenanceBadge(this.o);
  final CheSceneObject o;

  @override
  Widget build(BuildContext context) {
    final synthesis = o.provenance == 'che_synthesis_unverified';
    final filled = o.provenance == 'live' || o.provenance == 'owner_request';
    final color = synthesis ? const Color(0xFFE8B04A) : (filled ? const Color(0xFF5FD3B3) : Colors.white70);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: filled ? color.withValues(alpha: 0.25) : null,
        border: Border.all(color: color),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(o.provenanceSpoken.isEmpty ? o.provenance : o.provenanceSpoken, style: TextStyle(fontSize: 12, color: color)),
    );
  }
}

/// The room: a table, seats around it, the centre display, and the cards in
/// front of their authors. Positions come only from the scene's zones.
class _Table extends StatelessWidget {
  const _Table({required this.scene, required this.onTap});
  final CheScene scene;
  final void Function(CheSceneObject) onTap;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final w = box.maxWidth, h = box.maxHeight;
      final center = Offset(w / 2, h * 0.48);
      final rx = w * 0.36, ry = h * 0.30;
      final avatars = scene.avatars;
      Offset seat(int i) {
        final a = -math.pi / 2 + (2 * math.pi * i / math.max(1, avatars.length)) + math.pi / math.max(2, avatars.length);
        return Offset(center.dx + rx * 1.18 * math.cos(a), center.dy + ry * 1.25 * math.sin(a));
      }

      final seatOf = {for (final (i, a) in avatars.indexed) a.id: seat(i)};
      final path = scene.path;
      return Stack(children: [
        Positioned(
          left: center.dx - rx, top: center.dy - ry, width: rx * 2, height: ry * 2,
          child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: const Color(0xFF3A2A1C), border: Border.all(color: const Color(0xFF6B4E33), width: 4))),
        ),
        // Centre display: the objective, replaced by the recommended path once CHE has one.
        Positioned(
          left: center.dx - rx * 0.62, top: center.dy - ry * 0.45, width: rx * 1.24, height: ry * 0.9,
          child: GestureDetector(
            onTap: path == null ? null : () => onTap(path),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 500),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: path == null ? Colors.black54 : const Color(0xFF2C2410),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: path == null ? Colors.white24 : const Color(0xFFE8B04A), width: path == null ? 1 : 2),
              ),
              child: Center(
                child: Text(
                  path == null ? scene.objective : 'Recommended path\n${path.preview}',
                  textAlign: TextAlign.center, maxLines: 5, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: path == null ? Colors.white70 : const Color(0xFFE8B04A)),
                ),
              ),
            ),
          ),
        ),
        // Cards in front of their authors, newest on top (at most two per seat, the rest counted).
        for (final a in avatars) ..._cardsFor(a, seatOf[a.id]!, center),
        // Avatars walk from the door to their seat the first time they appear.
        for (final a in avatars)
          TweenAnimationBuilder<Offset>(
            key: ValueKey(a.id),
            tween: Tween(begin: Offset(w / 2, h + 40), end: seatOf[a.id]!),
            duration: const Duration(milliseconds: 1400),
            curve: Curves.easeOutCubic,
            builder: (context, at, child) => Positioned(left: at.dx - 28, top: at.dy - 40, child: child!),
            child: GestureDetector(
              onTap: () => onTap(a),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                CheMiniPerson(agent: _agent(a), size: 52),
                Text(a.name, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
      ]);
    });
  }

  List<Widget> _cardsFor(CheSceneObject avatar, Offset seat, Offset center) {
    final mine = scene.cards.where((c) => c.author == avatar.name).toList();
    if (mine.isEmpty) return const [];
    final toward = Offset(seat.dx + (center.dx - seat.dx) * 0.42, seat.dy + (center.dy - seat.dy) * 0.42);
    final shown = mine.reversed.take(2).toList();
    return [
      for (final (i, c) in shown.indexed)
        Positioned(
          key: ValueKey(c.id),
          left: toward.dx - 26 + i * 6, top: toward.dy - 16 + i * 6,
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: const Duration(milliseconds: 600),
            builder: (context, v, child) => Opacity(opacity: v, child: Transform.scale(scale: 0.8 + 0.2 * v, child: child)),
            child: GestureDetector(
              onTap: () => onTap(c),
              child: Container(
                width: 52, height: 34, padding: const EdgeInsets.all(3),
                decoration: BoxDecoration(
                  color: c.status == 'failed' ? Colors.red.withValues(alpha: 0.25) : (c.kind == 'critique' ? const Color(0xFF26314A) : const Color(0xFFF3EBD8)),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: c.kind == 'critique' ? const Color(0xFF8FB3FF) : Colors.black26),
                ),
                child: Text(c.kind == 'critique' ? 'check' : c.kind, style: TextStyle(fontSize: 9, color: c.kind == 'critique' ? Colors.white : Colors.black87)),
              ),
            ),
          ),
        ),
      if (mine.length > 2)
        Positioned(left: toward.dx + 24, top: toward.dy - 22, child: Text('+${mine.length - 2}', style: const TextStyle(fontSize: 11))),
    ];
  }

  static CheAgent _agent(CheSceneObject a) => CheAgent(
        id: a.id,
        name: a.name,
        role: a.role,
        status: CheAgentStatus.values.firstWhere((s) => s.name == a.status, orElse: () => CheAgentStatus.meeting),
      );
}
