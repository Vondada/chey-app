// ============================================================================
// C.H.E. VIRTUAL OFFICE
//
// A stylized, isometric-feeling "world map" that replaces the flat tab list
// as the front door to the CHE Hub. Every capability area (Memory, Insights,
// Markets, Business, Devices, Music, Create, Office) is drawn as a glowing
// "building" on a small campus. Tapping a building opens the exact same tab
// content that already exists in main.dart — this screen only changes how
// you get there, not what's behind the door.
//
// Pure Flutter: gradients, Transform and CustomPainter. No new packages,
// no 3D assets, so it runs at full speed on any iPhone.
// ============================================================================

import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'che_theme.dart';

class CheBuilding {
  const CheBuilding({
    required this.tab,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
  });

  final int tab;
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
}

const List<CheBuilding> cheCampusBuildings = [
  CheBuilding(
    tab: 0,
    title: 'Memory',
    subtitle: 'What CHE remembers',
    icon: Icons.memory_outlined,
    color: CheColors.accent,
  ),
  CheBuilding(
    tab: 1,
    title: 'Insights',
    subtitle: 'Learned & suggested',
    icon: Icons.auto_awesome_outlined,
    color: CheColors.violet,
  ),
  CheBuilding(
    tab: 2,
    title: 'Markets',
    subtitle: 'Trading & data',
    icon: Icons.show_chart,
    color: CheColors.amber,
  ),
  CheBuilding(
    tab: 3,
    title: 'Business',
    subtitle: 'Ops & cash flow',
    icon: Icons.business_center_outlined,
    color: CheColors.rose,
  ),
  CheBuilding(
    tab: 4,
    title: 'Devices',
    subtitle: 'Connections',
    icon: Icons.devices_other_outlined,
    color: Color(0xFF6FB6FF),
  ),
  CheBuilding(
    tab: 5,
    title: 'Music',
    subtitle: 'Playlists & audio',
    icon: Icons.music_note_outlined,
    color: Color(0xFF9BFF9B),
  ),
  CheBuilding(
    tab: 6,
    title: 'Create',
    subtitle: 'Creator Studio',
    icon: Icons.lightbulb_outline,
    color: Color(0xFFFF9E6F),
  ),
  CheBuilding(
    tab: 7,
    title: 'Office',
    subtitle: 'AI coworkers',
    icon: Icons.workspaces_outline,
    color: Color(0xFFB6A0FF),
  ),
  CheBuilding(
    tab: 8,
    title: 'Apps',
    subtitle: 'YouTube & web apps',
    icon: Icons.apps_rounded,
    color: Color(0xFF67D8FF),
  ),
];

enum CheWorldState { asleep, listening, thinking, speaking, idle }

class CheWorldHubScreen extends StatelessWidget {
  const CheWorldHubScreen({
    super.key,
    required this.onOpenTab,
    this.state = CheWorldState.idle,
  });

  /// Called with the tab index (matching the existing 8-tab hub order) when
  /// a building is tapped. The caller is expected to open the same modal
  /// hub sheet it already uses today.
  final void Function(int tab) onOpenTab;
  final CheWorldState state;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bgDeep,
      body: CheBackdrop(
        child: SafeArea(
          child: Stack(
            children: [
              const Positioned.fill(child: _CheStarfield()),
              Column(
                children: [
                  _WorldHeader(state: state),
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                      child: _CheCampus(onOpenTab: onOpenTab),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WorldHeader extends StatelessWidget {
  const _WorldHeader({required this.state});
  final CheWorldState state;

  String get _statusLabel => switch (state) {
        CheWorldState.asleep => 'STANDBY',
        CheWorldState.listening => 'LISTENING',
        CheWorldState.thinking => 'THINKING',
        CheWorldState.speaking => 'SPEAKING',
        CheWorldState.idle => 'ONLINE',
      };

  Color get _statusColor => switch (state) {
        CheWorldState.asleep => Colors.white38,
        CheWorldState.listening => CheColors.accent,
        CheWorldState.thinking => CheColors.amber,
        CheWorldState.speaking => CheColors.violet,
        CheWorldState.idle => CheColors.accent,
      };

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 20, 4),
      child: Row(
        children: [
          IconButton(
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.arrow_back_ios_new, color: CheColors.textPrimary, size: 18),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'CHE VIRTUAL OFFICE',
                  style: TextStyle(
                    color: CheColors.textPrimary,
                    fontWeight: FontWeight.w800,
                    fontSize: 18,
                    letterSpacing: 2,
                  ),
                ),
                Row(
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      margin: const EdgeInsets.only(right: 6),
                      decoration: BoxDecoration(
                        color: _statusColor,
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(color: _statusColor.withValues(alpha: 0.7), blurRadius: 6, spreadRadius: 1),
                        ],
                      ),
                    ),
                    Text(
                      _statusLabel,
                      style: TextStyle(
                        color: _statusColor,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.5,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Faint drifting "stars" in the background sky for depth. Cheap: a single
/// CustomPainter, no per-frame rebuild of widgets.
class _CheStarfield extends StatelessWidget {
  const _CheStarfield();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: CustomPaint(
        painter: _StarfieldPainter(),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _StarfieldPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final rnd = math.Random(7);
    final paint = Paint()..color = Colors.white.withValues(alpha: 0.5);
    for (var i = 0; i < 70; i++) {
      final dx = rnd.nextDouble() * size.width;
      final dy = rnd.nextDouble() * size.height * 0.55;
      final r = rnd.nextDouble() * 1.4 + 0.3;
      paint.color = Colors.white.withValues(alpha: rnd.nextDouble() * 0.5 + 0.1);
      canvas.drawCircle(Offset(dx, dy), r, paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The campus: buildings arranged in staggered rows so nearer rows read as
/// "closer" and farther rows read as "in the distance", the classic
/// isometric-game trick done with plain widget offsets instead of 3D.
class _CheCampus extends StatelessWidget {
  const _CheCampus({required this.onOpenTab});
  final void Function(int tab) onOpenTab;

  @override
  Widget build(BuildContext context) {
    final rows = <List<CheBuilding>>[
      cheCampusBuildings.sublist(0, 3),
      cheCampusBuildings.sublist(3, 6),
      cheCampusBuildings.sublist(6, 9),
    ];

    return Column(
      children: [
        for (var r = 0; r < rows.length; r++) ...[
          _CampusRow(
            buildings: rows[r],
            onOpenTab: onOpenTab,
            // Rows further "back" (lower index) sit smaller/dimmer to fake
            // depth-of-field, like distant buildings in a game world.
            depthScale: 0.82 + (r * 0.09),
            stagger: r.isOdd,
          ),
          const SizedBox(height: 18),
        ],
      ],
    );
  }
}

class _CampusRow extends StatelessWidget {
  const _CampusRow({
    required this.buildings,
    required this.depthScale,
    required this.stagger,
    required this.onOpenTab,
  });

  final void Function(int tab) onOpenTab;
  final List<CheBuilding> buildings;
  final double depthScale;
  final bool stagger;

  @override
  Widget build(BuildContext context) {
    final tiles = <Widget>[
      for (var i = 0; i < buildings.length; i++)
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(top: stagger && i.isOdd ? 22 : 0),
            child: CheFloat(
              amplitude: 4,
              phase: i.toDouble(),
              child: _BuildingTile(
                building: buildings[i],
                scale: depthScale,
                onTap: () => onOpenTab(buildings[i].tab),
              ),
            ),
          ),
        ),
    ];

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < tiles.length; i++) ...[
          if (i > 0) const SizedBox(width: 12),
          tiles[i],
        ],
      ],
    );
  }
}

class _BuildingTile extends StatefulWidget {
  const _BuildingTile({
    required this.building,
    required this.onTap,
    this.scale = 1.0,
  });

  final CheBuilding building;
  final VoidCallback onTap;
  final double scale;

  @override
  State<_BuildingTile> createState() => _BuildingTileState();
}

class _BuildingTileState extends State<_BuildingTile> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final b = widget.building;

    return Transform.scale(
      scale: widget.scale,
      alignment: Alignment.bottomCenter,
      child: GestureDetector(
        onTapDown: (_) => setState(() => _pressed = true),
        onTapCancel: () => setState(() => _pressed = false),
        onTapUp: (_) => setState(() => _pressed = false),
        onTap: widget.onTap,
        child: AnimatedScale(
          scale: _pressed ? 0.94 : 1.0,
          duration: const Duration(milliseconds: 120),
          child: AspectRatio(
            aspectRatio: 0.82,
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(18),
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    b.color.withValues(alpha: 0.22),
                    CheColors.panel,
                  ],
                ),
                border: Border.all(color: b.color.withValues(alpha: 0.55)),
                boxShadow: [
                  BoxShadow(
                    color: b.color.withValues(alpha: 0.28),
                    blurRadius: 18,
                    spreadRadius: -2,
                    offset: const Offset(0, 6),
                  ),
                ],
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: b.color.withValues(alpha: 0.18),
                        border: Border.all(color: b.color, width: 1.2),
                      ),
                      child: Icon(b.icon, color: b.color, size: 20),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      b.title,
                      textAlign: TextAlign.center,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: CheColors.textPrimary,
                        fontWeight: FontWeight.w700,
                        fontSize: 12.5,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      b.subtitle,
                      textAlign: TextAlign.center,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: CheColors.textDim,
                        fontSize: 9.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
