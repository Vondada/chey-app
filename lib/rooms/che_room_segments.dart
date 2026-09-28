// Two or three views inside one room (e.g. Create: Projects | Art Studio).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';

class CheRoomSegments extends StatefulWidget {
  const CheRoomSegments({super.key, required this.labels, required this.icons, required this.children});
  final List<String> labels;
  final List<IconData> icons;
  final List<Widget Function()> children;
  @override
  State<CheRoomSegments> createState() => _CheRoomSegmentsState();
}

class _CheRoomSegmentsState extends State<CheRoomSegments> {
  int _i = 0;
  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
          child: SegmentedButton<int>(
            showSelectedIcon: false,
            segments: [
              for (var i = 0; i < widget.labels.length; i++)
                ButtonSegment(value: i, icon: Icon(widget.icons[i], size: 16), label: Text(widget.labels[i])),
            ],
            selected: {_i},
            onSelectionChanged: (v) {
              HapticFeedback.selectionClick();
              setState(() => _i = v.first);
            },
          ),
        ),
        Expanded(child: KeyedSubtree(key: ValueKey(_i), child: widget.children[_i]())),
      ]),
    );
  }
}
