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

    // Avatar-first Home (mockups 02 / 04).
    expect(find.text('Start Chat'), findsOneWidget);
    expect(find.text('Open The Office'), findsOneWidget);
    expect(find.text('Voice Mode'), findsOneWidget);
    expect(find.text('Quick Tools'), findsOneWidget);
    expect(find.text('Voice on'), findsOneWidget);

    // Bottom shell tabs.
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Chat'), findsOneWidget);
    expect(find.text('Office'), findsOneWidget);
    expect(find.text('Apps'), findsOneWidget);
    expect(find.text('More'), findsOneWidget);

    // One-tap Voice mute on Home.
    await tester.tap(find.text('Voice on'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Voice off'), findsOneWidget);

    // More → UI Controls entry.
    await tester.tap(find.text('More'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('UI Controls'), findsOneWidget);
    expect(find.textContaining('Voice replies:'), findsOneWidget);

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
