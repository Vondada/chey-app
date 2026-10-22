import 'package:chey/che_ui/che_phone_shell.dart';
import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('CHE boots to mockup Home with voice chip and shell tabs', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    // CHE 2.0 Home: one Talk control, the five destinations and CHE's real state (offline in a test: no device token).
    expect(find.text('Talk to CHE'), findsOneWidget);
    for (final destination in ['The Office', 'Brain', 'Trading', 'Create']) {
      expect(find.text(destination), findsOneWidget, reason: destination);
    }
    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Voice on'), findsOneWidget);

    // Bottom shell tabs (CHE World is also a Home destination, so the tabs are read from the bar itself).
    final bar = find.byType(ChePhoneBottomNav);
    for (final tab in ['Home', 'Chat', 'Office', 'CHE World', 'More']) {
      expect(find.descendant(of: bar, matching: find.text(tab)), findsOneWidget, reason: tab);
    }

    // One-tap Voice mute on Home.
    await tester.tap(find.text('Voice on'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Voice off'), findsOneWidget);

    // More → UI Controls entry.
    await tester.tap(find.text('More'));
    await tester.pump(const Duration(milliseconds: 400));
    // The clock strip above the tabs takes some height, so the lazy list builds this row only once it is scrolled to.
    await tester.scrollUntilVisible(find.text('UI Controls'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('UI Controls'), findsOneWidget);
    // The More list is lazy and now has Connections and voice rows above this one.
    await tester.scrollUntilVisible(find.textContaining('Voice replies:'), 200,
        scrollable: find.byType(Scrollable).first);
    expect(find.textContaining('Voice replies:'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('UI Controls'), -200,
        scrollable: find.byType(Scrollable).first);

    await tester.tap(find.text('UI Controls'));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));
    expect(find.text('Appearance'), findsOneWidget);
    expect(find.text('Theme'), findsOneWidget);
    expect(find.text('Speak replies'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
  testWidgets('Chat is full screen and omits status and developer chrome', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    await tester.tap(find.text('Chat'));
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('What can I help with?'), findsOneWidget);
    expect(find.byTooltip('Conversations'), findsOneWidget);
    expect(find.byTooltip('New chat'), findsOneWidget);
    expect(find.byTooltip('Minimize chat'), findsNothing);

    for (final hidden in [
      'Ready',
      'Online',
      'Voice off',
      'SLEEPING',
      'AWAKE',
      'Wake listener',
      'Voice fallback',
    ]) {
      expect(find.text(hidden), findsNothing, reason: '$hidden should not render in normal Chat');
    }

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

}
