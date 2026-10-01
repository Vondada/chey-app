import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/browser/che_embedded_app_shell.dart';

void main() {
  test('embedded webview does not eagerly capture gestures', () {
    expect(cheEmbeddedWebViewGestures(), isEmpty);
  });

  test('embedded app route expands instead of sliding', () {
    final route = CheEmbeddedAppRoute<void>(builder: (_) => const SizedBox());
    expect(route.transitionDuration, const Duration(milliseconds: 420));
    expect(route.opaque, isTrue);
    expect(route.barrierDismissible, isFalse);
  });

  testWidgets('shell shows close and back, hides address chrome', (tester) async {
    var closed = 0;
    var backed = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: CheEmbeddedAppShell(
          title: 'TradingView',
          onClose: () => closed++,
          onBack: () => backed++,
          moreItems: const [
            PopupMenuItem(value: 'controls', child: Text('Show browser controls')),
          ],
          showBrowserControls: false,
          child: const Text('page'),
        ),
      ),
    );

    expect(find.text('TradingView'), findsOneWidget);
    expect(find.text('Search or enter address'), findsNothing);
    expect(find.byTooltip('Close'), findsOneWidget);
    expect(find.byTooltip('Back'), findsOneWidget);
    expect(find.byTooltip('More'), findsOneWidget);

    await tester.tap(find.byTooltip('Close'));
    await tester.pump();
    expect(closed, 1);

    await tester.tap(find.byTooltip('Back'));
    await tester.pump();
    expect(backed, 1);
  });

  testWidgets('header swipe down closes and does not depend on the page', (tester) async {
    var closed = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: CheEmbeddedAppShell(
          title: 'GitHub',
          onClose: () => closed++,
          child: const SizedBox.expand(),
        ),
      ),
    );

    await tester.fling(find.text('GitHub'), const Offset(0, 400), 800);
    await tester.pumpAndSettle();
    expect(closed, 1);
  });
}
