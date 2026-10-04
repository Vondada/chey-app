import 'package:chey/che_world_hub.dart';
import 'package:chey/world/che_world_globe.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('one continent per CHE room, same shape every launch', () {
    final rooms = [for (final b in cheCampusBuildings) (tab: b.tab, name: b.title, color: b.color)];
    final a = cheBuildContinents(rooms), b = cheBuildContinents(rooms);
    expect(a.map((c) => c.name), cheCampusBuildings.map((b) => b.title));
    expect(a.first.outline.first, b.first.outline.first);
    expect({for (final c in a) '${c.lat.toStringAsFixed(2)},${c.lon.toStringAsFixed(2)}'}.length, a.length, reason: 'continents do not overlap');
  });

  testWidgets('tapping a continent that faces you opens that room; the room buttons do too', (tester) async {
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final opened = <int>[];
    await tester.pumpWidget(MaterialApp(home: CheWorldHubScreen(onOpenTab: opened.add)));
    await tester.pump();
    final state = tester.state<CheWorldGlobeState>(find.byType(CheWorldGlobe));
    final trading = state.widget.continents.firstWhere((c) => c.name == 'Trading Room');
    state.face(trading);
    await tester.pump();
    final box = tester.getRect(find.byType(CheWorldGlobe));
    await tester.tapAt(box.center);
    await tester.pump();
    expect(opened, [1]);
    await tester.tap(find.text('Brain'));
    expect(opened.last, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the globe turns on its own while it is on screen', (tester) async {
    await tester.pumpWidget(MaterialApp(home: CheWorldHubScreen(onOpenTab: (_) {})));
    await tester.pump();
    final state = tester.state<CheWorldGlobeState>(find.byType(CheWorldGlobe));
    final start = state.yaw;
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    expect(state.yaw, greaterThan(start));
    await tester.pumpWidget(const SizedBox());
  });
}
