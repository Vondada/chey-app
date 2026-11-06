// Owner screenshots (2026-11-06): grey boxes in the Trading room. Flutter saves widget state (a scroll offset, an
// ExpansionTile's open state, a text field's scroll) in PageStorage under the path of PageStorageKeys above it; with no
// PageStorageKey nothing is saved, so nothing can collide. The Trading room list had one, every ExpansionTile under it
// read the list's scroll offset as its open state and threw ("type 'double' is not a subtype of type 'bool?'"), and a
// release build drew a grey box (test/che_trading_room_grey_box_test.dart). Keying the tiles instead made each tile
// share a slot with the text fields inside it (CI run 42154263918). So lib/ uses no PageStorageKey.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('lib/ has no PageStorageKey, so no two widgets can share a saved-state slot', () {
    final found = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final code = lines[i].split('//').first;
        if (code.contains('PageStorageKey')) found.add('${f.path}:${i + 1}');
      }
    }
    expect(found, isEmpty, reason: 'a list that must keep its place should use a ScrollController owned by its State, never a PageStorageKey');
  });
}
