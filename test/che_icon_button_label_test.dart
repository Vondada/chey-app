// VoiceOver (AGENTS.md): every button needs a spoken label. An IconButton has
// no text, so without a tooltip VoiceOver reads only "button". This scans every
// IconButton( / IconButton.filled( ... in lib/ and requires `tooltip:` inside
// its arguments. A justified exception carries the comment
// `// icon-button-label-ok: <reason>` on the line above (for example a button
// whose wrapping Semantics already gives the label and excludes semantics).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Unlabeled IconButtons in [source], as 1-based line numbers.
List<int> unlabeledIconButtons(String source) {
  final found = <int>[];
  for (final match in RegExp(r'\bIconButton(?:\.\w+)?\(').allMatches(source)) {
    var depth = 1;
    var i = match.end;
    while (depth > 0 && i < source.length) {
      final c = source[i];
      if (c == '(') depth++;
      if (c == ')') depth--;
      i++;
    }
    final args = source.substring(match.start, i);
    final lineStart = source.lastIndexOf('\n', match.start);
    final prevLineStart = lineStart <= 0 ? 0 : source.lastIndexOf('\n', lineStart - 1);
    final before = source.substring(prevLineStart < 0 ? 0 : prevLineStart, match.start);
    if (!args.contains('tooltip:') && !before.contains('icon-button-label-ok')) {
      found.add('\n'.allMatches(source.substring(0, match.start)).length + 1);
    }
  }
  return found;
}

void main() {
  test('the scanner flags an unlabeled IconButton and accepts a labeled or opted-out one', () {
    expect(unlabeledIconButtons("IconButton(icon: const Icon(Icons.close), onPressed: f)"), [1]);
    expect(unlabeledIconButtons("IconButton.filled(icon: Icon(x(1)), onPressed: f)"), [1]);
    expect(unlabeledIconButtons("IconButton(tooltip: 'Close', icon: const Icon(Icons.close), onPressed: f)"), isEmpty);
    expect(unlabeledIconButtons("// icon-button-label-ok: Semantics above labels it\nIconButton(icon: i, onPressed: f)"), isEmpty);
  });

  test('every IconButton in lib/ has a VoiceOver label (tooltip)', () {
    final misses = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      for (final line in unlabeledIconButtons(entity.readAsStringSync())) {
        misses.add('${entity.path}:$line');
      }
    }
    expect(misses, isEmpty, reason: 'Add tooltip: to these IconButtons so VoiceOver can say what they do.');
  });
}
