// Owner, live iPhone 2026-10-22: the Chat header showed "?" boxes. The installed app's icon font holds only the icons
// its build used (Flutter keeps just those glyphs), and a Shorebird patch cannot add glyphs. An icon first used after
// that build draws as a "?" box until a new IPA ships. test/fixtures/release_icons.txt lists the icons of the build
// on the owner's iPhone (b81cbe4, #395 [ios-build]). When a new IPA ships, regenerate it from that commit:
//   git grep -ohE "Icons\.[a-z0-9_]+" <ipa-commit> -- lib | sed 's/^[^:]*://; s/^Icons\.//' | sort -u > test/fixtures/release_icons.txt
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every Material icon in lib/ exists in the installed build, so a patch never shows a "?" box', () {
    final shipped = File('test/fixtures/release_icons.txt').readAsLinesSync().map((l) => l.trim()).where((l) => l.isNotEmpty).toSet();
    final used = <String, String>{};
    for (final file in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
      for (final m in RegExp(r'\bIcons\.([a-z0-9_]+)\b').allMatches(file.readAsStringSync())) {
        used.putIfAbsent(m.group(1)!, () => file.path);
      }
    }
    final missing = {for (final e in used.entries) if (!shipped.contains(e.key)) e.key: e.value};
    expect(missing, isEmpty,
        reason: 'These icons are not in the installed build and would draw as "?" after a Shorebird patch. '
            'Use an icon from test/fixtures/release_icons.txt, or ship a new IPA and regenerate the list: $missing');
  });
}
