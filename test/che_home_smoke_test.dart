import 'package:chey/che_ui/che_phone_shell.dart';
import 'package:chey/home/che_mockup_home.dart';
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
    // HUD Home (owner, 2026-10-22): Trading is the MNQ tile, the Office the OFFICE tile, Brain and Create are pills.
    expect(find.text('CHE OFFLINE'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Voice on\.')), findsOneWidget);
    // On this smaller iPhone the room pills sit just below the tiles, one short scroll down.
    final homeList = find.descendant(of: find.byType(CheMockupHome), matching: find.byType(Scrollable)).first;
    for (final destination in ['OFFICE', 'MNQ', 'Brain', 'Create']) {
      await tester.scrollUntilVisible(find.text(destination), 120, scrollable: homeList);
      expect(find.text(destination), findsOneWidget, reason: destination);
    }
    // Back to the top, where the voice switch is.
    tester.state<ScrollableState>(homeList).position.jumpTo(0);
    await tester.pump(const Duration(milliseconds: 100));

    // Bottom shell tabs (CHE World is also a Home destination, so the tabs are read from the bar itself).
    final bar = find.byType(ChePhoneBottomNav);
    for (final tab in ['Home', 'Chat', 'Office', 'CHE World', 'More']) {
      expect(find.descendant(of: bar, matching: find.text(tab)), findsOneWidget, reason: tab);
    }

    // One-tap Voice mute on Home.
    await tester.tap(find.bySemanticsLabel(RegExp(r'^Voice on\.')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.bySemanticsLabel(RegExp(r'^Voice off\.')), findsOneWidget);

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
    // Conversations, New chat and Knowledge live in one Chat options menu; nothing sits beside Talk.
    expect(find.byTooltip('Chat options'), findsOneWidget);
    expect(find.byTooltip('Flagstaff'), findsOneWidget);
    expect(find.byTooltip('Help'), findsWidgets);
    expect(find.text('Commands'), findsOneWidget);
    expect(find.byTooltip('Knowledge Library'), findsNothing, reason: 'Knowledge is in the menu, away from Talk');
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

    // Owner (2026-10-22): no Voice IDs, no canned prompt chips, no repository or Office task text in Chat.
    for (final gone in ['Voice IDs', 'Paste a voice ID, name it, and use it', 'Read me what Atlas finished',
      'What is the Office doing?']) {
      expect(find.text(gone), findsNothing, reason: '$gone is not in Chat');
    }
    expect(find.byType(ActionChip), findsNothing, reason: 'no canned prompt chips');
    expect(find.textContaining('repository inspection report'), findsNothing);

    // Talk and the first action are separate, each at least 44 points, and never overlap.
    final talk = tester.getRect(find.byTooltip('Talk to CHE'));
    expect(talk.width, greaterThanOrEqualTo(44));
    expect(talk.height, greaterThanOrEqualTo(44));
    for (final other in ['Commands', 'Flagstaff', 'Help', 'Chat options']) {
      final f = other == 'Commands' ? find.text('Commands') : find.byTooltip(other).first;
      final rect = tester.getRect(f);
      expect(rect.overlaps(talk), isFalse, reason: '$other must not overlap Talk');
      expect(rect.left - talk.right, greaterThanOrEqualTo(24), reason: '$other is well away from Talk');
    }

    // The menu holds Knowledge, Conversations and New chat.
    await tester.tap(find.byTooltip('Chat options'));
    await tester.pump(const Duration(milliseconds: 400));
    for (final item in ['Knowledge Library', 'Conversations', 'New chat']) {
      expect(find.text(item), findsOneWidget, reason: item);
    }
    await tester.tapAt(const Offset(10, 600));
    await tester.pump(const Duration(milliseconds: 400));

    // Flagstaff is the notification centre: it opens with a Notices tab.
    await tester.tap(find.byTooltip('Flagstaff'));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(find.text('Flagstaff'), findsWidgets);
    expect(find.text('Notices'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('Chat stays usable with large text: the bar fits and the composer is reachable', (tester) async {
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    // CHE's own Large text setting (the app applies its own scale, not the system's).
    SharedPreferences.setMockInitialValues({'che.ui.textScale': 'large'});

    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    await tester.tap(find.descendant(of: find.byType(ChePhoneBottomNav), matching: find.text('Chat')));
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    expect(find.byTooltip('Talk to CHE'), findsOneWidget);
    expect(find.byTooltip('Commands').evaluate().length + find.text('Commands').evaluate().length, 1, reason: 'one Commands control');
    expect(find.byTooltip('Flagstaff'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });


  test('CHE follows the iPhone Larger Text size and multiplies it by her own Text size setting', () {
    expect(cheEffectiveTextScale(TextScaler.noScaling, 1.0), 1.0);
    expect(cheEffectiveTextScale(const TextScaler.linear(1.5), 1.0), 1.5, reason: 'Larger Text applies in CHE');
    expect(cheEffectiveTextScale(const TextScaler.linear(1.5), 1.18), closeTo(1.77, 0.001), reason: 'and CHE Large adds to it');
    expect(cheEffectiveTextScale(const TextScaler.linear(3.1), 1.18), 2.0, reason: 'held where the layouts are tested');
  });

  testWidgets('the system text size reaches CHE screens', (tester) async {
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    tester.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    final context = tester.element(find.text('Talk to CHE'));
    expect(MediaQuery.textScalerOf(context).scale(14), closeTo(21, 0.01));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
}
