// Owner, live iPhone 2026-10-22: the Chat header showed "?" boxes. The installed app's icon font holds only the icons
// its build used (Flutter keeps just those glyphs), and a Shorebird patch cannot add glyphs. An icon first used after
// that build draws as a "?" box until a new IPA ships. test/fixtures/release_icons.txt lists the icons compiled into
// the build on the owner's iPhone (b81cbe4, #395 [ios-build]): only files reachable from lib/main.dart count, as in the
// release's tree shaking. When a new IPA ships, regenerate it from that commit:
//   node tool/release_icons.mjs <ipa-commit> > test/fixtures/release_icons.txt
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every Material icon in lib/ exists in the installed build, so a patch never shows a "?" box', () {
    final shipped = File('test/fixtures/release_icons.txt').readAsLinesSync().map((l) => l.trim()).where((l) => l.isNotEmpty).toSet();
    // The files the app compiles: lib/main.dart and everything it imports, exports or includes as a part.
    final used = <String, String>{};
    final seen = <String>{};
    final queue = ['lib/main.dart'];
    while (queue.isNotEmpty) {
      final path = queue.removeLast();
      if (!seen.add(path)) continue;
      final file = File(path);
      if (!file.existsSync()) continue;
      final source = file.readAsStringSync();
      for (final m in RegExp(r'\bIcons\.([a-z0-9_]+)\b').allMatches(source)) {
        used.putIfAbsent(m.group(1)!, () => path);
      }
      for (final m in RegExp(r"^\s*(?:import|export|part)\s+'([^']+)'", multiLine: true).allMatches(source)) {
        final uri = m.group(1)!;
        if (uri.startsWith('package:chey/')) {
          queue.add('lib/${uri.substring('package:chey/'.length)}');
        } else if (!uri.contains(':')) {
          queue.add(File(path).parent.uri.resolve(uri).toFilePath());
        }
      }
    }
    expect(seen.length, greaterThan(50), reason: 'the walk reached the app');
    final missing = {for (final e in used.entries) if (!shipped.contains(e.key)) e.key: e.value};
    expect(missing, isEmpty,
        reason: 'These icons are not in the installed build and would draw as "?" after a Shorebird patch. '
            'Use an icon from test/fixtures/release_icons.txt, or ship a new IPA and regenerate the list: $missing');
  });
}
