import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/trading/che_sim_controls.dart';

void main() {
  Future<List<String>> pump(WidgetTester tester, {bool paused = false}) async {
    final asked = <String>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheSimControls(onAsk: asked.add, paused: paused))));
    return asked;
  }

  testWidgets('pause, stop and resume send the words the owner can also say, so CHE reports the real result aloud', (tester) async {
    final asked = await pump(tester);
    await tester.tap(find.byKey(const Key('sim_pause')));
    await tester.tap(find.byKey(const Key('sim_stop')));
    expect(asked, [kSimPause, kSimStop]);
    expect(find.bySemanticsLabel(RegExp('Stop the strategy simulation: pause and cancel waiting signals')), findsOneWidget);

    final resumed = await pump(tester, paused: true);
    expect(find.byKey(const Key('sim_pause')), findsNothing);
    await tester.tap(find.byKey(const Key('sim_resume')));
    expect(resumed, [kSimResume]);
  });

  testWidgets('reset asks first: cancel sends nothing, "Archive and reset" sends the confirmation', (tester) async {
    final asked = await pump(tester);
    await tester.tap(find.byKey(const Key('sim_reset')));
    await tester.pumpAndSettle();
    expect(find.textContaining('archived and kept'), findsOneWidget);
    await tester.tap(find.byKey(const Key('sim_reset_cancel')));
    await tester.pumpAndSettle();
    expect(asked, isEmpty);

    await tester.tap(find.byKey(const Key('sim_reset')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sim_reset_confirm')));
    await tester.pumpAndSettle();
    expect(asked, [kSimReset]);
  });
}
