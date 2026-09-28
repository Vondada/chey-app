import 'package:flutter/material.dart';

typedef CheImmersivePageBuilder = Widget Function(bool active);

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
  late final TabController _controller;
  late int _index;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex.clamp(0, widget.tabs.length - 1);
    _controller = TabController(
      length: widget.tabs.length,
      initialIndex: _index,
      vsync: this,
    )..addListener(_syncIndex);
  }

  void _syncIndex() {
    final next = _controller.index;
    if (next == _index) return;
    setState(() => _index = next);
    widget.onIndexChanged?.call(next);
  }

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
          const SizedBox(height: 12),
          const Text(
            'CHE',
            style: TextStyle(
              color: Color(0xFF67E8D1),
              fontSize: 26,
              fontWeight: FontWeight.w800,
              letterSpacing: 4,
            ),
          ),
          const Text(
            'COGNITIVE.HORIZON.ENGINE',
            style: TextStyle(
              color: Colors.white54,
              fontSize: 9,
              letterSpacing: 1.5,
            ),
          ),
          const SizedBox(height: 12),
          TabBar(
            controller: _controller,
            isScrollable: true,
            tabs: widget.tabs,
          ),
          Expanded(
            child: TabBarView(
              controller: _controller,
              children: List<Widget>.generate(
                widget.pages.length,
                (i) => TickerMode(
                  enabled: i == _index,
                  child: widget.pages[i](i == _index),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
