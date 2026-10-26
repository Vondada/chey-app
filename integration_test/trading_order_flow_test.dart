// The trading order path (owner, 2026-10-26: "test and see if I can trade easily in there"). It walks the same taps the owner
// would make: Trading, expand the chart, Alpaca PAPER, Order ticket, Buy, Preview order, then cancel. It never presses
// "Yes, place paper order", so it sends nothing to any broker. The Alpaca chart is hidden in the owner's room, so this test
// turns it on for the run only and turns it back off afterwards.
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chey/main.dart' as app;
import 'package:chey/rooms/che_trading_chart.dart' show kShowAlpacaPaper;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the owner can open the paper order ticket and cancel without sending', (tester) async {
    kShowAlpacaPaper = true;
    try {
      app.main();
      await tester.pump(const Duration(seconds: 5));

      // The Home tile's semantics label starts with its name ("Trading. Paper. Double tap to open.").
      await _tapFirst(tester, find.bySemanticsLabel(RegExp(r'^Trading\.')), 'the Trading tile');
      await tester.pump(const Duration(seconds: 3));
      expect(tester.takeException(), isNull, reason: 'Opening Trading threw an error');

      await _waitForAndTap(tester, find.bySemanticsLabel('Expand the chart'), 'Expand the chart');
      await tester.pump(const Duration(seconds: 2));

      await _waitForAndTap(tester, find.bySemanticsLabel('Show the Alpaca PAPER chart'), 'Alpaca PAPER chart');
      await tester.pump(const Duration(seconds: 3));

      await _waitForAndTap(tester, find.text('Order ticket'), 'Order ticket');
      await tester.pumpAndSettle(const Duration(milliseconds: 200), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));

      await _tapFirst(tester, find.text('Buy'), 'Buy');
      await tester.pump(const Duration(milliseconds: 300));

      await _tapFirst(tester, find.text('Preview order'), 'Preview order');
      // The preview calls the Worker. Wait for it to finish, then accept either outcome: the confirmation or a clear reason.
      for (var i = 0; i < 20 && find.text('Checking…').evaluate().isNotEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 500));
      }
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull, reason: 'The order preview threw an error');
      final confirmed = find.textContaining('Yes, place paper order').evaluate().isNotEmpty;
      final explained = find.textContaining('Nothing was sent').evaluate().isNotEmpty;
      expect(confirmed || explained, isTrue, reason: 'The preview showed neither a confirmation nor a clear reason');

      await _tapFirst(tester, find.text('No, cancel. Nothing is sent.'), 'Cancel the order');
      await tester.pumpAndSettle(const Duration(milliseconds: 200), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
      expect(find.textContaining('Yes, place paper order'), findsNothing, reason: 'The order is still open after cancel');
    } finally {
      kShowAlpacaPaper = false;
    }
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
  });
}

/// The trading room loads its data after a tap, so a control can take a few seconds to appear. Pumps until it does,
/// up to 30 seconds, then taps it. Fails with the control's name so the gate says which step broke.
Future<void> _waitForAndTap(WidgetTester tester, Finder finder, String name) async {
  for (var i = 0; i < 60 && finder.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 500));
  }
  await _tapFirst(tester, finder, name);
}

/// Taps the first match, or fails with the name of the control so the gate says which step broke.
Future<void> _tapFirst(WidgetTester tester, Finder finder, String name) async {
  expect(finder.evaluate().isNotEmpty, isTrue, reason: '$name is not on screen');
  await tester.tap(finder.first);
}
