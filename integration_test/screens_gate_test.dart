// The screen gate (owner, 2026-10-26): every main tab opens with real content and no error text, and the Office's
// swipe between sections stays smooth. Runs on an iOS simulator from .github/workflows/che-release-gate.yml and saves
// a screenshot of each screen so the owner can look at them. It is a required check for every feature.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chey/main.dart' as app;

/// Frames over budget allowed while swiping the Office sections. Tune only from measured runs, never to pass a regression.
const int maxMissedFrames = 6;

const List<String> mainTabs = ['Home tab', 'Chat tab', 'Office tab', 'More tab'];

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('every main tab opens with content and no error text', (tester) async {
    // iOS needs the Flutter surface converted before a screenshot can be taken; without it every capture fails silently.
    if (defaultTargetPlatform == TargetPlatform.iOS) await binding.convertFlutterSurfaceToImage();
    app.main();
    await tester.pump(const Duration(seconds: 5));
    for (final label in mainTabs) {
      await tester.tap(find.bySemanticsLabel(label));
      await tester.pump(const Duration(seconds: 2));
      expect(tester.takeException(), isNull, reason: '$label threw an error');
      expect(find.textContaining('Something went wrong'), findsNothing, reason: '$label shows an error');
      expect(find.byType(Text), findsWidgets, reason: '$label has no visible text: an empty screen');
      await _shot(binding, label.replaceAll(' ', '_'));
    }
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
  });

  testWidgets('the Office sections swipe smoothly', (tester) async {
    app.main();
    await tester.pump(const Duration(seconds: 5));
    await tester.tap(find.bySemanticsLabel('Office tab'));
    await tester.pump(const Duration(seconds: 2));
    final pager = find.byType(PageView);
    if (pager.evaluate().isEmpty) {
      fail('The Office has no section pager to swipe');
    }
    await binding.watchPerformance(() async {
      for (var i = 0; i < 4; i++) {
        await tester.fling(pager.first, const Offset(-300, 0), 1200);
        await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
        await tester.fling(pager.first, const Offset(300, 0), 1200);
        await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
      }
    }, reportKey: 'office_swipe');
    final missed = binding.reportData?['office_swipe']?['missed_frame_build_budget_count'] as int? ?? 0;
    expect(missed, lessThanOrEqualTo(maxMissedFrames), reason: 'The Office swipe dropped $missed frames');
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
  });
}

/// Takes a screenshot; the driver saves it to the CI workspace. A capture failure never fails the gate by itself.
Future<void> _shot(IntegrationTestWidgetsFlutterBinding binding, String name) async {
  try {
    await binding.takeScreenshot(name);
  } catch (_) {
    // Screenshots are evidence for the owner's review; a capture failure shows as a missing file.
  }
}
