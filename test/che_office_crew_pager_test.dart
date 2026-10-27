// The Office crew pager (owner, 2026-10-26: swipe through real profiles). Seeded agents give a pager that swipes; an empty
// roster keeps the honest empty state and no pager. The simulator gate runs the same swipe on a device.
import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/che_office_fixture.dart';

void main() {
  testWidgets('seeded crew: the pager is there, the first member shows, and a swipe moves to the next member', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheOfficeFloorScreen(client: fixtureOfficeClient()))));
    await _pumpUntilFound(tester, find.byType(PageView));
    final pager = find.byType(PageView);
    expect(pager, findsOneWidget);
    expect(find.text('Nova'), findsWidgets);
    expect(tester.widget<PageView>(pager.first).controller!.page ?? 0, closeTo(0, 0.01));
    await tester.fling(pager.first, const Offset(-300, 0), 1200);
    await tester.pumpAndSettle();
    expect(tester.widget<PageView>(pager.first).controller!.page, closeTo(1, 0.01));
    await tester.fling(pager.first, const Offset(300, 0), 1200);
    await tester.pumpAndSettle();
    expect(tester.widget<PageView>(pager.first).controller!.page, closeTo(0, 0.01));
  });

  testWidgets('empty roster: the honest empty state shows and there is no pager', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheOfficeFloorScreen(client: fixtureOfficeClient(agents: const [])))));
    await _pumpUntilFound(tester, find.text('No agents yet. Ask CHE to staff the Office.'));
    expect(find.byType(PageView), findsNothing);
    expect(find.text('No agents yet. Ask CHE to staff the Office.'), findsOneWidget);
  });
}

/// The Office loads its roster after the first frame, and the crew section sits below the floor plan in a lazy ListView,
/// so it is not built until it scrolls near the screen (an 800x600 test surface shows only the floor plan). Let the
/// roster arrive, then scroll the Office's list until what the test checks is built, and bring it fully on screen.
Future<void> _pumpUntilFound(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  final officeList = find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first;
  await tester.scrollUntilVisible(finder, 200, scrollable: officeList);
  await tester.ensureVisible(finder.first);
  await tester.pumpAndSettle();
}
