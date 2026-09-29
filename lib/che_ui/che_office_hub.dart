// ignore_for_file: use_null_aware_elements
// CHE Virtual Office hub + section shell.
// Replaces the crowded top tab row: the hub grid is home, and inside a section
// a single scrolling section bar lets you hop between sections (no overlap).

import 'package:flutter/material.dart';

import 'che_rooms.dart';
import 'che_theme.dart';
import 'che_transitions.dart';
import 'che_widgets.dart';

class CheSection {
  const CheSection({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.hue,
    required this.builder,
    this.badge,
    this.room,
  });
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final Color hue;

  /// Build the EXISTING screen body for this section (no Scaffold/AppBar needed).
  final WidgetBuilder builder;
  final String? badge;

  /// Optional immersive environment shown behind this section.
  final CheRoom? room;
}

/// The nine standard CHE sections. Pass the existing screen for each one.
List<CheSection> cheDefaultSections({
  required WidgetBuilder memory,
  required WidgetBuilder insights,
  required WidgetBuilder markets,
  required WidgetBuilder business,
  required WidgetBuilder devices,
  required WidgetBuilder music,
  required WidgetBuilder create,
  required WidgetBuilder office,
  required WidgetBuilder apps,
  WidgetBuilder? theater,
  WidgetBuilder? plugins,
}) =>
    [
      CheSection(room: CheRoom.brain, id: 'memory', title: 'Memory', subtitle: 'What CHE remembers', icon: Icons.memory_rounded, hue: CheColors.memory, builder: memory),
      CheSection(room: CheRoom.brain, id: 'insights', title: 'Insights', subtitle: 'Learned & summaries', icon: Icons.auto_awesome_rounded, hue: CheColors.insights, builder: insights),
      CheSection(room: CheRoom.markets, id: 'markets', title: 'Markets', subtitle: 'Trading & data', icon: Icons.show_chart_rounded, hue: CheColors.markets, builder: markets),
      CheSection(room: CheRoom.conference, id: 'business', title: 'Business', subtitle: 'Ops & cash flow', icon: Icons.business_center_rounded, hue: CheColors.business, builder: business),
      CheSection(room: CheRoom.core, id: 'devices', title: 'Devices', subtitle: 'Connections', icon: Icons.devices_other_rounded, hue: CheColors.devices, builder: devices),
      CheSection(room: CheRoom.studio, id: 'music', title: 'Music', subtitle: 'Studio & playlists', icon: Icons.graphic_eq_rounded, hue: CheColors.music, builder: music),
      CheSection(room: CheRoom.art, id: 'create', title: 'Create', subtitle: 'Creator studio', icon: Icons.lightbulb_outline_rounded, hue: CheColors.create, builder: create),
      CheSection(room: CheRoom.office, id: 'office', title: 'Office', subtitle: 'AI coworkers', icon: Icons.groups_rounded, hue: CheColors.office, builder: office),
      CheSection(room: CheRoom.core, id: 'apps', title: 'Apps', subtitle: 'Connected apps', icon: Icons.apps_rounded, hue: CheColors.apps, builder: apps),
      if (theater != null)
        CheSection(room: CheRoom.studio, id: 'theater', title: 'Theater', subtitle: 'Watch together', icon: Icons.theaters_rounded, hue: CheColors.danger, builder: theater),
      if (plugins != null)
        CheSection(room: CheRoom.core, id: 'plugins', title: 'Plugins', subtitle: 'Add skills to CHE', icon: Icons.extension_rounded, hue: CheColors.accent, builder: plugins),
    ];

class CheOfficeHub extends StatelessWidget {
  const CheOfficeHub({
    super.key,
    required this.sections,
    required this.onOpenChat,
    this.greeting,
  });
  final List<CheSection> sections;
  final VoidCallback onOpenChat;
  final String? greeting;

  void _open(BuildContext context, int i) {
    Navigator.of(context).push(CheRoute(builder: (_) => CheSectionShell(sections: sections, initialIndex: i, onOpenChat: onOpenChat)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        child: SafeArea(
          child: CustomScrollView(slivers: [
            SliverToBoxAdapter(
              child: CheHeader(
                subtitle: 'VIRTUAL OFFICE',
                trailing: CheIconButton(
                  icon: Icons.chat_bubble_rounded,
                  glow: true,
                  size: 48,
                  onTap: onOpenChat,
                  tooltip: 'Talk to CHE',
                ),
              ),
            ),
            SliverToBoxAdapter(child: _WorldCarousel(sections: sections, onOpen: (i) => _open(context, i))),
            if (greeting != null)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, CheSpace.md),
                  child: Text(greeting!, style: CheType.bodyDim),
                ),
              ),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.xxl),
              sliver: SliverGrid(
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  mainAxisSpacing: CheSpace.md,
                  crossAxisSpacing: CheSpace.md,
                  childAspectRatio: 0.86,
                ),
                delegate: SliverChildBuilderDelegate(
                  (context, i) {
                    final s = sections[i];
                    return _Stagger(
                      index: i,
                      child: CheTile(
                        icon: s.icon,
                        title: s.title,
                        subtitle: s.subtitle,
                        hue: s.hue,
                        badge: s.badge,
                        onTap: () => _open(context, i),
                      ),
                    );
                  },
                  childCount: sections.length,
                ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// "Enter CHE's world": big live room cards you swipe through.
class _WorldCarousel extends StatefulWidget {
  const _WorldCarousel({required this.sections, required this.onOpen});
  final List<CheSection> sections;
  final void Function(int index) onOpen;
  @override
  State<_WorldCarousel> createState() => _WorldCarouselState();
}

class _WorldCarouselState extends State<_WorldCarousel> {
  final _page = PageController(viewportFraction: 0.86);
  double _p = 0;

  @override
  void initState() {
    super.initState();
    _page.addListener(() => setState(() => _p = _page.page ?? 0));
  }

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // one card per distinct room, pointing at the first section in that room
    final seen = <CheRoom>{};
    final entries = <(int, CheSection)>[];
    for (var i = 0; i < widget.sections.length; i++) {
      final r = widget.sections[i].room;
      if (r == null || r == CheRoom.core || !seen.add(r)) continue;
      entries.add((i, widget.sections[i]));
    }
    if (entries.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 190,
      child: PageView.builder(
        controller: _page,
        itemCount: entries.length,
        itemBuilder: (context, k) {
          final (index, sec) = entries[k];
          final room = sec.room!;
          final delta = (_p - k).clamp(-1.0, 1.0);
          return Transform.scale(
            scale: 1 - delta.abs() * 0.06,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: ChePressable(
                onTap: () => widget.onOpen(index),
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(CheRadius.xl),
                    border: Border.all(color: room.accent.withValues(alpha: 0.55)),
                    boxShadow: [BoxShadow(color: room.accent.withValues(alpha: 0.28), blurRadius: 24)],
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(CheRadius.xl),
                    child: CheRoomBackdrop(
                      room: room,
                      scrim: 0.35,
                      child: Padding(
                        padding: const EdgeInsets.all(CheSpace.lg),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            Text(room.title.toUpperCase(),
                                style: CheType.overline.copyWith(color: room.accent)),
                            const SizedBox(height: 4),
                            Row(children: [
                              Expanded(
                                child: Text('Enter ${sec.title}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: CheType.title.copyWith(fontSize: 22, color: Colors.white)),
                              ),
                              Icon(Icons.arrow_forward_rounded, color: room.accent),
                            ]),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _Stagger extends StatelessWidget {
  const _Stagger({required this.index, required this.child});
  final int index;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    if (CheMotion.reduced(context)) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 320 + index * 45),
      curve: CheMotion.curve,
      builder: (_, t, c) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, (1 - t) * 14), child: Transform.scale(scale: 0.96 + 0.04 * t, child: c)),
      ),
      child: child,
    );
  }
}

/// Inside a section: compact header + scrolling section bar + animated body.
class CheSectionShell extends StatefulWidget {
  const CheSectionShell({super.key, required this.sections, required this.initialIndex, required this.onOpenChat});
  final List<CheSection> sections;
  final int initialIndex;
  final VoidCallback onOpenChat;
  @override
  State<CheSectionShell> createState() => _CheSectionShellState();
}

class _CheSectionShellState extends State<CheSectionShell> {
  late int _i = widget.initialIndex;

  @override
  Widget build(BuildContext context) {
    final s = widget.sections[_i];
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: Stack(fit: StackFit.expand, children: [
        AnimatedSwitcher(
          duration: CheMotion.d(context, CheMotion.slow),
          child: s.room == null
              ? CheBackground(key: const ValueKey('plain'), auraColor: s.hue, child: const SizedBox.expand())
              : CheRoomBackdrop(key: ValueKey(s.room), room: s.room!, scrim: 0.72),
        ),
        SafeArea(
          bottom: false,
          child: Column(children: [
            CheHeader(
              compact: true,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              trailing: CheIconButton(icon: Icons.chat_bubble_rounded, glow: true, onTap: widget.onOpenChat),
            ),
            CheSectionBar(
              items: [for (final x in widget.sections) CheSectionBarItem(label: x.title, icon: x.icon, hue: x.hue)],
              index: _i,
              onChanged: (i) => setState(() => _i = i),
            ),
            const SizedBox(height: CheSpace.sm),
            Expanded(
              child: AnimatedSwitcher(
                duration: CheMotion.d(context, CheMotion.base),
                switchInCurve: CheMotion.curve,
                transitionBuilder: cheSwitchTransition,
                child: KeyedSubtree(key: ValueKey(s.id), child: s.builder(context)),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}

/// Standard section page layout for feature screens: title, description,
/// then content cards. Use it so every section looks consistent.
class CheSectionPage extends StatelessWidget {
  const CheSectionPage({super.key, required this.title, this.description, required this.children, this.action});
  final String title;
  final String? description;
  final List<Widget> children;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewPadding.bottom;
    return ListView(
      padding: EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.xxl + bottom),
      children: [
        Row(children: [
          Expanded(child: Text(title, style: CheType.title, maxLines: 2, overflow: TextOverflow.ellipsis)),
          if (action != null) action!,
        ]),
        if (description != null) ...[
          const SizedBox(height: CheSpace.xs),
          Text(description!, style: CheType.bodyDim),
        ],
        const SizedBox(height: CheSpace.lg),
        for (final c in children) Padding(padding: const EdgeInsets.only(bottom: CheSpace.md), child: c),
      ],
    );
  }
}

/// Standard feature card (e.g. "Analyze Markets", "Backtesting Lab").
class CheFeatureCard extends StatelessWidget {
  const CheFeatureCard({super.key, required this.icon, required this.title, required this.body, this.onTap, this.hue, this.trailing});
  final IconData icon;
  final String title;
  final String body;
  final VoidCallback? onTap;
  final Color? hue;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final h = hue ?? CheColors.accent;
    return ChePressable(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(CheSpace.lg),
        decoration: BoxDecoration(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.lg),
          border: Border.all(color: CheColors.stroke),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: h.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(CheRadius.sm),
              border: Border.all(color: h.withValues(alpha: 0.5)),
            ),
            child: Icon(icon, size: 20, color: h),
          ),
          const SizedBox(width: CheSpace.md),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: CheType.headline, maxLines: 2, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 4),
              Text(body, style: CheType.bodyDim),
            ]),
          ),
          if (trailing != null) trailing! else if (onTap != null)
            const Padding(
              padding: EdgeInsets.only(left: 6, top: 10),
              child: Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
            ),
        ]),
      ),
    );
  }
}
