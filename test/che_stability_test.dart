// App stability guards (owner, 2026-10-23: "diagnose freezes, lag ... unstable animations ... respect accessibility
// text-scale settings"). Measured before the fixes in this file's PR: every tab drew 60 frames a second while idle
// (the presence orb breathed forever and the Office backdrop repainted the whole screen each frame), and with the
// iPhone's Larger Text the bottom tabs, the Office header and the voice action tiles overflowed.
import 'package:chey/che_ui/che_phone_shell.dart';
import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

var _drawn = 0;
var _counting = false;

/// Frames drawn during about one idle second (60 pumps of 16 ms).
Future<int> idleFrames(WidgetTester tester) async {
  if (!_counting) {
    SchedulerBinding.instance.addPersistentFrameCallback((_) => _drawn++);
    _counting = true;
  }
  _drawn = 0;
  for (var i = 0; i < 60; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  // Each pump draws once when something asked for a frame; an idle screen asks for none.
  return tester.binding.hasScheduledFrame ? _drawn + 1 : _drawn;
}

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets('idle tabs stay still and fit at text scale $scale', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      SharedPreferences.setMockInitialValues({});
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      expect(tester.takeException(), isNull, reason: 'Home fits');
      final bar = find.byType(ChePhoneBottomNav);

      await tester.tap(find.descendant(of: bar, matching: find.text('Chat')));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(tester.takeException(), isNull, reason: 'Chat fits');
      expect(await idleFrames(tester), 0, reason: 'an idle Chat draws nothing (the presence orb holds still)');

      await tester.tap(find.descendant(of: bar, matching: find.text('Office')));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(tester.takeException(), isNull, reason: 'the Office fits');
      final office = await idleFrames(tester);
      expect(office, lessThanOrEqualTo(20), reason: 'the Office backdrop and idle crew update a few times a second (16 measured), not 60');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  }
}
