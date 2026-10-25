// The Office floor plan (owner UI cleanup, 2026-10-25): one clean, futuristic plan of clear zones instead of a
// photo backdrop. CHE's central office sits in the middle; around it the Brain Lab, the War Room, Business
// Operations, the Trading Desk, the Creative Studio and the Agent Desks. Every agent sits at a desk in exactly one
// zone (cheZoneForAgent). Tap a person to open their real desk; tap a zone's name to open that zone. Every zone and
// desk has a VoiceOver label saying what it is and who is working there, and each zone has a spoken route
// ("take me to the trading desk"). States come from CheDeskView (the Office board and the live roster) only.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_agent_contact_card.dart';
import 'che_office_status.dart';
import 'che_office_store.dart';

const List<List<CheOfficeZone>> _rows = [
  [CheOfficeZone.research, CheOfficeZone.warRoom],
  [CheOfficeZone.central],
  [CheOfficeZone.operations, CheOfficeZone.trading],
  [CheOfficeZone.creative, CheOfficeZone.desks],
];

/// Desk ids per zone for the store's current roster. CHE is always in the central office.
Map<CheOfficeZone, List<String>> cheZoneMembers(CheOfficeStore store) {
  final out = {for (final z in CheOfficeZone.values) z: <String>[]};
  if (store.desk(CheOfficeStore.cheId) != null) out[CheOfficeZone.central]!.add(CheOfficeStore.cheId);
  for (final id in store.agentDeskIds) {
    final view = store.desk(id)?.value;
    if (view == null) continue;
    out[cheZoneForAgent(view.agent)]!.add(id);
  }
  return out;
}

/// "Atlas working. Knox blocked." for a zone's desks, or a plain empty line.
String cheZoneActivity(CheOfficeStore store, List<String> ids) {
  if (ids.isEmpty) return 'No desk here yet.';
  final parts = <String>[];
  for (final id in ids) {
    final v = store.desk(id)?.value;
    if (v == null) continue;
    parts.add('${v.agent.isChe ? 'CHE' : v.agent.name} ${v.workState.label.toLowerCase()}');
  }
  return parts.isEmpty ? 'No desk here yet.' : '${parts.join(', ')}.';
}

class CheOfficeFloorPlan extends StatelessWidget {
  const CheOfficeFloorPlan({
    super.key,
    required this.store,
    required this.onTapDesk,
    required this.onWarRoom,
    this.onOpenZone,
  });

  final CheOfficeStore store;
  final void Function(String id) onTapDesk;
  final VoidCallback onWarRoom;

  /// Opens a zone (its desks and the room it leads to). Without it a zone's name opens its first desk.
  final void Function(CheOfficeZone zone)? onOpenZone;

  void _zone(CheOfficeZone zone, List<String> ids) {
    HapticFeedback.selectionClick();
    if (zone == CheOfficeZone.warRoom) {
      onWarRoom();
    } else if (onOpenZone != null) {
      onOpenZone!(zone);
    } else if (ids.isNotEmpty) {
      onTapDesk(ids.first);
    }
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: CustomPaint(
        painter: const _FloorPainter(),
        child: Padding(
          padding: const EdgeInsets.all(CheSpace.md),
          // Rebuilds only when desks are added or removed; status changes reach each zone through its desks.
          child: ValueListenableBuilder<List<String>>(
            valueListenable: store.deskOrder,
            builder: (context, _, _) {
              final members = cheZoneMembers(store);
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text('OFFICE FLOOR PLAN',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.overline.copyWith(color: Colors.white, letterSpacing: 2)),
                    ),
                  ),
                  ValueListenableBuilder<int>(
                    valueListenable: store.working,
                    builder: (context, n, _) => Text('$n working', style: CheType.caption.copyWith(color: Colors.white70)),
                  ),
                ]),
                const SizedBox(height: 2),
                Text('Tap a person for their desk, or a zone name to enter it.',
                    style: CheType.caption.copyWith(color: Colors.white60)),
                const SizedBox(height: CheSpace.sm),
                for (final (i, row) in _rows.indexed) ...[
                  if (i > 0) const _Corridor(),
                  IntrinsicHeight(
                    child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      for (final (j, zone) in row.indexed) ...[
                        if (j > 0) const SizedBox(width: CheSpace.sm),
                        Expanded(
                          child: _ZoneCard(
                            key: ValueKey('office-zone-${zone.id}'),
                            zone: zone,
                            store: store,
                            ids: members[zone]!,
                            onOpen: () => _zone(zone, members[zone]!),
                            onTapDesk: onTapDesk,
                          ),
                        ),
                      ],
                    ]),
                  ),
                ],
              ]);
            },
          ),
        ),
      ),
    );
  }
}

/// A thin lit corridor between rows of zones.
class _Corridor extends StatelessWidget {
  const _Corridor();
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Container(
          height: 14,
          alignment: Alignment.center,
          child: Container(
            height: 1,
            decoration: BoxDecoration(
              gradient: LinearGradient(colors: [
                Colors.transparent,
                CheColors.accent.withValues(alpha: 0.35),
                Colors.transparent,
              ]),
            ),
          ),
        ),
      );
}

class _ZoneCard extends StatelessWidget {
  const _ZoneCard({super.key, required this.zone, required this.store, required this.ids, required this.onOpen, required this.onTapDesk});
  final CheOfficeZone zone;
  final CheOfficeStore store;
  final List<String> ids;
  final VoidCallback onOpen;
  final void Function(String id) onTapDesk;

  @override
  Widget build(BuildContext context) {
    final desks = [for (final id in ids) if (store.desk(id) case final n?) (id: id, view: n)];
    final views = [for (final d in desks) d.view];
    final listen = zone == CheOfficeZone.warRoom ? store.warRoom : Listenable.merge(views);
    return AnimatedBuilder(
      animation: listen,
      builder: (context, _) {
        final war = store.warRoom.value;
        final working = views.where((v) => v.value.workState == CheWorkState.working).length;
        final lit = zone == CheOfficeZone.warRoom ? war.live > 0 : working > 0;
        final activity = zone == CheOfficeZone.warRoom
            ? (war.live > 0
                ? '${war.live} ${war.live == 1 ? 'meeting' : 'meetings'} in session.'
                : war.total > 0
                    ? 'Empty now. ${war.total} past ${war.total == 1 ? 'meeting' : 'meetings'}.'
                    : 'Empty. No meetings yet.')
            : cheZoneActivity(store, ids);
        final c = zone.color;
        final action = zone == CheOfficeZone.warRoom
            ? (war.live > 0 ? 'Open the live meeting.' : 'Convene the War Room.')
            : 'Open the ${zone.title}.';
        return Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(CheRadius.md),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [c.withValues(alpha: lit ? 0.20 : 0.10), const Color(0xFF07111C).withValues(alpha: 0.6)],
            ),
            border: Border.all(color: c.withValues(alpha: lit ? 0.9 : 0.4), width: lit ? 1.5 : 1),
            boxShadow: lit ? [BoxShadow(color: c.withValues(alpha: 0.25), blurRadius: 14)] : null,
          ),
          padding: const EdgeInsets.fromLTRB(CheSpace.sm, CheSpace.sm, CheSpace.sm, CheSpace.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Semantics(
              button: true,
              label: '${zone.title}. ${zone.purpose} $activity $action',
              excludeSemantics: true,
              child: InkWell(
                borderRadius: BorderRadius.circular(CheRadius.sm),
                onTap: onOpen,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 44),
                  child: Row(children: [
                    Icon(zone.icon, size: 18, color: c),
                    const SizedBox(width: 6),
                    Expanded(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(zone.title.toUpperCase(),
                            maxLines: 1, style: CheType.overline.copyWith(color: c, fontWeight: FontWeight.w800, letterSpacing: 1.2)),
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, size: 18, color: c.withValues(alpha: 0.8)),
                  ]),
                ),
              ),
            ),
            if (zone == CheOfficeZone.warRoom)
              Expanded(
                child: ExcludeSemantics(
                  child: GestureDetector(
                    onTap: onOpen,
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Icon(Icons.groups_rounded, size: 30, color: c),
                      const SizedBox(height: 4),
                      Text(activity, textAlign: TextAlign.center, style: CheType.caption.copyWith(color: Colors.white.withValues(alpha: 0.85))),
                      const SizedBox(height: 4),
                      Text(war.live > 0 ? 'Open meeting' : 'Convene', style: CheType.label.copyWith(color: c)),
                    ]),
                  ),
                ),
              )
            else if (views.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: CheSpace.sm),
                child: Text('No desk here yet.', style: CheType.caption.copyWith(color: Colors.white60)),
              )
            else if (zone == CheOfficeZone.central)
              for (final v in views) _CheDesk(view: v, onTap: () => onTapDesk(CheOfficeStore.cheId))
            else
              Wrap(
                spacing: CheSpace.xs,
                runSpacing: CheSpace.xs,
                children: [
                  for (final d in desks) _DeskChip(key: ValueKey('office-desk-${d.id}'), view: d.view, onTap: () => onTapDesk(d.id)),
                ],
              ),
          ]),
        );
      },
    );
  }
}

/// One person at a desk inside a zone.
class _DeskChip extends StatelessWidget {
  const _DeskChip({super.key, required this.view, required this.onTap});
  final ValueNotifier<CheDeskView> view;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CheDeskView>(
      valueListenable: view,
      builder: (context, d, _) {
        final a = d.agent;
        final s = d.workState;
        return Semantics(
          button: true,
          label: '${a.name}${a.role.isNotEmpty ? ', ${a.role}' : ''}. ${d.line}. ${s.label}. Open ${a.name}\'s desk.',
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.sm),
            onTap: () {
              HapticFeedback.selectionClick();
              onTap();
            },
            child: SizedBox(
              width: 70,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  CheAgentAvatar(agent: a, state: s, size: 42),
                  const SizedBox(height: 4),
                  FittedBox(fit: BoxFit.scaleDown, child: Text(a.name, maxLines: 1, style: CheType.label.copyWith(color: Colors.white))),
                  Text(s.label, maxLines: 1, style: CheType.caption.copyWith(color: s.color, fontSize: 11, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// CHE's own desk in the central office: larger, with her live line.
class _CheDesk extends StatelessWidget {
  const _CheDesk({required this.view, required this.onTap});
  final ValueNotifier<CheDeskView> view;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CheDeskView>(
      valueListenable: view,
      builder: (context, d, _) {
        final a = d.agent;
        final s = d.workState;
        final line = cheWorkLine(s, a, note: d.note, job: d.job);
        return Semantics(
          button: true,
          label: '${a.name}, ${a.role}. ${d.line}. ${s.label}. CHE\'s desk, the central office. Open to talk or send a request.',
          excludeSemantics: true,
          child: InkWell(
            key: const ValueKey('office-desk-che'),
            borderRadius: BorderRadius.circular(CheRadius.sm),
            onTap: () {
              HapticFeedback.selectionClick();
              onTap();
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                CheAgentAvatar(agent: a, state: s, size: 56),
                const SizedBox(width: CheSpace.md),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(a.name, style: CheType.headline.copyWith(color: Colors.white)),
                    Text('${a.role} · ${s.label}', style: CheType.caption.copyWith(color: s.color)),
                    Text(line, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: Colors.white70)),
                  ]),
                ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

/// The plan's floor: a dark slab with a faint architectural grid. Drawn in code, no pictures.
class _FloorPainter extends CustomPainter {
  const _FloorPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final r = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(CheRadius.xl));
    canvas.drawRRect(
      r,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0xFF0B1A2C), Color(0xFF060E19)],
        ).createShader(Offset.zero & size),
    );
    canvas.save();
    canvas.clipRRect(r);
    final grid = Paint()
      ..color = const Color(0xFF8FD8FF).withValues(alpha: 0.05)
      ..strokeWidth = 1;
    for (double x = 0; x < size.width; x += 22) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), grid);
    }
    for (double y = 0; y < size.height; y += 22) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    canvas.restore();
    canvas.drawRRect(
      r.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = const Color(0xFF8FD8FF).withValues(alpha: 0.28),
    );
  }

  @override
  bool shouldRepaint(covariant _FloorPainter oldDelegate) => false;
}
