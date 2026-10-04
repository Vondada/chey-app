// ============================================================================
// C.H.E. VIRTUAL OFFICE
//
// A stylized, isometric-feeling "world map" that replaces the flat tab list
// as the front door to the CHE Hub. Every capability area (Brain,
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
import 'world/che_world_globe.dart';

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
    title: 'Brain',
    subtitle: 'Constellation · soul · log',
    icon: Icons.hub_outlined,
    color: CheColors.accent,
  ),
  CheBuilding(
    tab: 1,
    title: 'Trading Room',
    subtitle: 'Swings · backtests · paper trades',
    icon: Icons.show_chart,
    color: CheColors.amber,
  ),
  CheBuilding(
    tab: 2,
    title: 'Business',
    subtitle: 'Ops & cash flow',
    icon: Icons.business_center_outlined,
    color: CheColors.rose,
  ),
  CheBuilding(
    tab: 3,
    title: 'Devices',
    subtitle: 'Connections',
    icon: Icons.devices_other_outlined,
    color: Color(0xFF6FB6FF),
  ),
  CheBuilding(
    tab: 4,
    title: 'Music',
    subtitle: 'Playlists & audio',
    icon: Icons.music_note_outlined,
    color: Color(0xFF9BFF9B),
  ),
  CheBuilding(
    tab: 5,
    title: 'Create',
    subtitle: 'Creator Studio',
    icon: Icons.lightbulb_outline,
    color: Color(0xFFFF9E6F),
  ),
  CheBuilding(
    tab: 6,
    title: 'Office',
    subtitle: 'AI coworkers',
    icon: Icons.workspaces_outline,
    color: Color(0xFFB6A0FF),
  ),
  CheBuilding(
    tab: 7,
    title: 'Apps',
    subtitle: 'YouTube & web apps',
    icon: Icons.apps_rounded,
    color: Color(0xFF67D8FF),
  ),
  CheBuilding(
    tab: 8,
    title: 'Theater',
    subtitle: 'Watch together',
    icon: Icons.theaters_outlined,
    color: Color(0xFFFF6F91),
  ),
  CheBuilding(
    tab: 9,
    title: 'Workshop',
    subtitle: 'Watch real work form',
    icon: Icons.construction_rounded,
    color: Color(0xFF34E0B8),
  ),
];

enum CheWorldState { asleep, listening, thinking, speaking, idle }

class CheWorldHubScreen extends StatelessWidget {
  const CheWorldHubScreen({
    super.key,
    required this.onOpenTab,
    this.state = CheWorldState.idle,
  });

  /// Called with the tab index (matching the existing hub tab order) when
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
                  // Each room is a continent on CHE's world.
                  Expanded(
                    child: CheWorldGlobe(
                      continents: cheBuildContinents([for (final b in cheCampusBuildings) (tab: b.tab, name: b.title, color: b.color)]),
                      onOpenTab: onOpenTab,
                    ),
                  ),
                  // Every continent as a button too (VoiceOver, one tap).
                  SizedBox(
                    height: 56,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      children: [
                        for (final b in cheCampusBuildings)
                          Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: Semantics(
                              button: true,
                              label: 'Open ${b.title}. ${b.subtitle}',
                              excludeSemantics: true,
                              child: ActionChip(
                                avatar: Icon(b.icon, size: 16, color: b.color),
                                label: Text(b.title),
                                onPressed: () => onOpenTab(b.tab),
                              ),
                            ),
                          ),
                      ],
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
