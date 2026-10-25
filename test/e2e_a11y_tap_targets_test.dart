// VoiceOver (AGENTS.md): every tap target needs a spoken label. che_icon_button_label_test.dart covers IconButton;
// this covers GestureDetector / InkWell / InkResponse with a tap or long-press handler.
// A tap target counts as labelled when its own arguments hold Semantics(, semanticsLabel:, semanticLabel:, Tooltip(,
// tooltip:, Text( or label:, or when Semantics( / Tooltip( / MergeSemantics( or the opt-out comment
// `a11y-label-ok: <reason>` appears in the six lines above it.
// Ratchet (reliability lane, 2026-10-25): the unlabeled targets that exist today are listed per file in
// docs/CHE_A11Y_AUDIT.md and frozen in BASELINE below. A file may only go DOWN. A new unlabeled target fails this
// test; fix it with a Semantics label (or lower the baseline after fixing one).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

final _open = RegExp(r'\b(GestureDetector|InkWell|InkResponse)\(');
final _tap = RegExp(r'\bon(Tap|LongPress|DoubleTap|TapUp|TapDown)\s*:');
final _labelInside = RegExp(r'Semantics\(|semanticsLabel\s*:|semanticLabel\s*:|Tooltip\(|tooltip\s*:|\bText\(|Text\.rich\(|\blabel\s*:');
final _labelBefore = RegExp(r'Semantics\(|Tooltip\(|MergeSemantics\(|a11y-label-ok');

/// Unlabeled tap targets in [source], as 1-based line numbers.
List<int> unlabeledTapTargets(String source) {
  final found = <int>[];
  for (final m in _open.allMatches(source)) {
    var depth = 1;
    var i = m.end;
    while (depth > 0 && i < source.length) {
      final c = source[i];
      if (c == '(') depth++;
      if (c == ')') depth--;
      i++;
    }
    final args = source.substring(m.start, i);
    if (!_tap.hasMatch(args)) continue;
    var start = m.start;
    for (var k = 0; k < 6 && start > 0; k++) {
      start = source.lastIndexOf('\n', start - 1);
      if (start < 0) start = 0;
    }
    final before = source.substring(start, m.start);
    if (_labelBefore.hasMatch(before) || _labelInside.hasMatch(args)) continue;
    found.add('\n'.allMatches(source.substring(0, m.start)).length + 1);
  }
  return found;
}

// Unlabeled tap targets per file at main 0c43197 (see docs/CHE_A11Y_AUDIT.md for each one and its fix).
const baseline = <String, int>{
  'lib/brain/che_knowledge_atlas.dart': 1,
  'lib/che_theme.dart': 1,
  'lib/che_ui/che_agent_chat.dart': 1,
  'lib/che_ui/che_plugins.dart': 1,
  'lib/che_ui/che_widgets.dart': 1,
  'lib/che_voice_ui.dart': 1,
  'lib/conversations/che_conversations_screen.dart': 1,
  'lib/devices_hub_scene.dart': 1,
  'lib/home/che_home_chat.dart': 2,
  'lib/insights_brain_scene.dart': 1,
  'lib/main.dart': 1,
  'lib/visual/che_image_canvas.dart': 1,
  'lib/widgets/che_native_scene_world.dart': 1,
  'lib/world/che_plan_room.dart': 1,
};

void main() {
  test('the scanner flags an unlabeled tap target and accepts a labelled, non-tap or opted-out one', () {
    expect(unlabeledTapTargets('GestureDetector(onTap: f, child: Icon(Icons.close))'), [1]);
    expect(unlabeledTapTargets('InkWell(onLongPress: f, child: Container())'), [1]);
    expect(unlabeledTapTargets("InkWell(onTap: f, child: Text('Open'))"), isEmpty);
    expect(unlabeledTapTargets("Semantics(\n  button: true,\n  label: 'Close',\n  child: GestureDetector(onTap: f, child: Icon(x)))"), isEmpty);
    expect(unlabeledTapTargets('GestureDetector(onScaleUpdate: f, child: Container())'), isEmpty, reason: 'pan/zoom only is not a button');
    expect(unlabeledTapTargets('// a11y-label-ok: dismisses the keyboard only\nGestureDetector(onTap: f, child: x)'), isEmpty);
  });

  test('no file in lib/ gains an unlabeled GestureDetector/InkWell tap target', () {
    final grown = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final path = entity.path.replaceAll(r'\', '/');
      final lines = unlabeledTapTargets(entity.readAsStringSync());
      final allowed = baseline[path] ?? 0;
      if (lines.length > allowed) grown.add('$path: ${lines.length} unlabeled (baseline $allowed) at lines ${lines.join(', ')}');
    }
    expect(grown, isEmpty, reason: 'Wrap these tap targets in Semantics(button: true, label: ...) so VoiceOver can say what they do.');
  });
}
