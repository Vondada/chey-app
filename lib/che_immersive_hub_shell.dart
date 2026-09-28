import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

typedef CheImmersivePageBuilder = Widget Function(bool active);

/// CHE's room navigator. Replaces the crowded 9-item tab bar with a single
/// line of room pills (icon + one-line label, never wrapped or clipped) and a
/// room title, and clips every page so neighbouring rooms can't paint over
/// each other mid-swipe (the old "Businessiness" / "GALGALLERY" overlap).
class CheImmersiveHubShell extends StatefulWidget {
  const CheImmersiveHubShell({
    super.key,
    required this.initialIndex,
    required this.tabs,
    required this.pages,
    this.onIndexChanged,
  });

  final int initialIndex;
  final List<Tab> tabs;
  final List<CheImmersivePageBuilder> pages;
  final ValueChanged<int>? onIndexChanged;

  @override
  State<CheImmersiveHubShell> createState() => _CheImmersiveHubShellState();
}

class _CheImmersiveHubShellState extends State<CheImmersiveHubShell>
    with SingleTickerProviderStateMixin {
  static const _accent = Color(0xFF67E8D1);

  late final TabController _controller;
  late int _index;
  final _pillKeys = <GlobalKey>[];

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex.clamp(0, widget.tabs.length - 1).toInt();
    _pillKeys.addAll(List.generate(widget.tabs.length, (_) => GlobalKey()));
    _controller = TabController(
      length: widget.tabs.length,
      initialIndex: _index,
      vsync: this,
    )..addListener(_syncIndex);
    WidgetsBinding.instance.addPostFrameCallback((_) => _revealPill(animate: false));
  }

  void _syncIndex() {
    final next = _controller.index;
    if (next == _index) return;
    setState(() => _index = next);
    widget.onIndexChanged?.call(next);
    _revealPill();
  }

  void _revealPill({bool animate = true}) {
    final ctx = _pillKeys[_index].currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(
      ctx,
      alignment: 0.5,
      duration: animate ? const Duration(milliseconds: 260) : Duration.zero,
      curve: Curves.easeOutCubic,
    );
  }

  String _label(int i) => widget.tabs[i].text ?? 'Room ${i + 1}';

  @override
  void dispose() {
    _controller
      ..removeListener(_syncIndex)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 42,
            height: 5,
            decoration: BoxDecoration(
              color: Colors.white24,
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 220),
                    child: Text(
                      _label(_index).toUpperCase(),
                      key: ValueKey(_index),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _accent,
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2.5,
                      ),
                    ),
                  ),
                ),
                Text(
                  '${_index + 1} / ${widget.tabs.length}',
                  style: const TextStyle(color: Colors.white38, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 40,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  for (var i = 0; i < widget.tabs.length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    _RoomPill(
                      key: _pillKeys[i],
                      icon: widget.tabs[i].icon,
                      label: _label(i),
                      selected: i == _index,
                      onTap: () {
                        HapticFeedback.selectionClick();
                        _controller.animateTo(i);
                      },
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          Expanded(
            child: TabBarView(
              controller: _controller,
              children: List<Widget>.generate(
                widget.pages.length,
                (i) => ClipRect(
                  child: TickerMode(
                    enabled: i == _index,
                    child: widget.pages[i](i == _index),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoomPill extends StatelessWidget {
  const _RoomPill({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final Widget? icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    const accent = Color(0xFF67E8D1);
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: selected ? accent.withValues(alpha: 0.16) : Colors.white.withValues(alpha: 0.04),
            borderRadius: BorderRadius.circular(99),
            border: Border.all(color: selected ? accent : Colors.white12),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null)
                IconTheme(
                  data: IconThemeData(size: 16, color: selected ? accent : Colors.white60),
                  child: icon!,
                ),
              if (icon != null) const SizedBox(width: 6),
              Text(
                label,
                maxLines: 1,
                softWrap: false,
                style: TextStyle(
                  color: selected ? Colors.white : Colors.white70,
                  fontSize: 12.5,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
