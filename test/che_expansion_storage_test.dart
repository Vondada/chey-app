// Owner screenshots (2026-11-06): grey boxes in the Trading room's crypto desk and setup board, at their expandable
// sections. Release builds draw a failed widget as a grey box. Suspected cause: ExpansionTile restores its open state
// from PageStorage, and with no PageStorageKey above it it shares the slot a scroll view saves its offset in, so an
// ExpansionTile created after a scroll reads a double as a bool and throws.
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

void main() {
  testWidgets('repro: an ExpansionTile created after a scroll, without a PageStorageKey', (tester) async {
    final show = ValueNotifier(false);
    await tester.pumpWidget(_host(show));
    await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -600));
    await tester.pumpAndSettle();
    show.value = true;
    await tester.pump();
    final error = tester.takeException();
    // Printed so the CI log shows the exact exception either way.
    // ignore: avoid_print
    print('REPRO_EXCEPTION: $error');
    expect(error, isNull);
  });

  testWidgets('repro: the same with a PageStorageKey', (tester) async {
    final show = ValueNotifier(false);
    await tester.pumpWidget(_host(show, tileKey: const PageStorageKey<String>('recent')));
    await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -600));
    await tester.pumpAndSettle();
    show.value = true;
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
