// Owner screenshots (2026-11-06): grey boxes in the Trading room's crypto desk and setup board, at their expandable
// sections. A release build draws a widget that throws as a grey box. An ExpansionTile restores its open state from
// PageStorage; with no PageStorageKey of its own it shared the slot the Trading room list saves its scroll offset in,
// and threw "type 'double' is not a subtype of type 'bool?'" (reproduced in test/che_trading_room_grey_box_test.dart,
// diagnostic run 42154237391). Every ExpansionTile carries a PageStorageKey, and this guard keeps it that way.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(ValueNotifier<bool> show, {Key? tileKey}) => MaterialApp(
      home: Scaffold(
        body: ValueListenableBuilder<bool>(
          valueListenable: show,
          builder: (context, v, _) => SingleChildScrollView(
            child: Column(children: [
              const SizedBox(height: 3000),
              if (v) ExpansionTile(key: tileKey, title: const Text('Recent simulated trades'), children: const [Text('row')]),
            ]),
          ),
        ),
      ),
    );

Future<Object?> _scrollThenShow(WidgetTester tester, {Key? tileKey}) async {
  final show = ValueNotifier(false);
  await tester.pumpWidget(_host(show, tileKey: tileKey));
  await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -600));
  await tester.pumpAndSettle();
  show.value = true;
  await tester.pump();
  return tester.takeException();
}

void main() {
  testWidgets('an ExpansionTile with a PageStorageKey, created after a scroll, builds without an error', (tester) async {
    expect(await _scrollThenShow(tester, tileKey: const PageStorageKey<String>('recent')), isNull);
  });

  test('every ExpansionTile in lib/ has a PageStorageKey, so none can share a scroll view\'s saved state', () {
    final missing = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
      final text = f.readAsStringSync();
      for (final m in RegExp(r'ExpansionTile\(').allMatches(text)) {
        final head = text.substring(m.end, (m.end + 160).clamp(0, text.length));
        if (!RegExp(r'^\s*key:\s*(const\s+)?PageStorageKey').hasMatch(head)) {
          missing.add('${f.path}:${'\n'.allMatches(text.substring(0, m.start)).length + 1}');
        }
      }
    }
    expect(missing, isEmpty, reason: 'give each ExpansionTile key: PageStorageKey<String>(...) (unique per item in a list)');
  });
}
