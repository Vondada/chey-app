// The trading order path (owner, 2026-10-26: "test and see if I can trade easily in there"). It walks the taps the owner
// makes in the Trading Room: expand the chart, show the Alpaca PAPER chart, open the Order ticket, Buy, Preview order,
// then cancel. It never presses "Yes, place paper order", so nothing is sent to any broker.
//
// The room runs against deterministic fixture data (test/support/che_trading_fixture.dart) so CI does not depend on a
// live market feed. The live connection is checked separately by test/che_trading_live_feed_test.dart.
// The Alpaca chart is hidden in the owner's room, so this test turns it on for the run only and turns it back off after.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chey/rooms/che_trading_chart.dart' show kShowAlpacaPaper;
import 'package:chey/rooms/che_trading_room.dart';

import '../test/support/che_trading_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the owner can open the paper order ticket and cancel without sending', (tester) async {
    kShowAlpacaPaper = true;
    try {
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: CheTradingRoom(
            baseUrl: () => 'https://che.example',
            headers: () => const {},
            onAsk: (_) {},
            client: fixtureTradingClient(),
            initialSection: CheTradingSection.chart,
            initialAccount: 'alpaca_paper',
          ),
        ),
      ));
      await _waitForAndTap(tester, find.byTooltip('Expand the chart'), 'Expand the chart');
      await tester.pump(const Duration(seconds: 2));

      await _waitForAndTap(tester, find.bySemanticsLabel('Show the Alpaca PAPER chart'), 'Alpaca PAPER chart');
      await tester.pump(const Duration(seconds: 3));

      await _waitForAndTap(tester, find.text('Order ticket'), 'Order ticket');
      await tester.pumpAndSettle(const Duration(milliseconds: 200), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));

      await _tapFirst(tester, find.text('Buy'), 'Buy');
      await tester.pump(const Duration(milliseconds: 300));

      await _tapFirst(tester, find.text('Preview order'), 'Preview order');
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

/// Pumps until the control appears (up to 30 seconds), then taps it. Fails with the control's name so the gate says which
/// step broke.
Future<void> _waitForAndTap(WidgetTester tester, Finder finder, String name) async {
  for (var i = 0; i < 60 && finder.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 500));
  }
  await _tapFirst(tester, finder, name);
}

/// Taps the first match, or fails with the name of the control.
Future<void> _tapFirst(WidgetTester tester, Finder finder, String name) async {
  expect(finder.evaluate().isNotEmpty, isTrue, reason: '$name is not on screen');
  await tester.tap(finder.first);
}
