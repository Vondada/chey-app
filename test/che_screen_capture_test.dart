// "Look at my screen" (owner, 2026-10-20): CHE captures her own screen and
// never one with a password or vault note on it.
import 'dart:convert';

import 'package:chey/che_ui/che_screen_capture.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _app(Widget body) => CheScreenCapture.wrap(MaterialApp(home: Scaffold(body: body)));

void main() {
  test('the owner\'s ways of asking CHE to look, and sentences that are not that', () {
    for (final m in [
      'Look at my screen',
      'CHE, look at my screen.',
      'Chay, take a look at my screen',
      'Can you see my screen?',
      'Please look at this screen',
      'What do you see?',
      'what do you see now',
      'Analyze my screen',
      'scan the whole screen',
      'Look at this',
      "look at what I'm looking at",
    ]) {
      expect(cheAsksToLookAtScreen(m), isTrue, reason: m);
    }
    for (final m in [
      // Answered from the page report, instantly and for free.
      'What is on my screen?',
      'Describe my screen',
      // Ordinary sentences.
      'Look at this code: function f() {}',
      'What do you see in the market today?',
      'I can see my screen fine',
      'Look at my portfolio',
      'screen recording settings',
    ]) {
      expect(cheAsksToLookAtScreen(m), isFalse, reason: m);
    }
  });

  testWidgets('a capture is a PNG of the app as shown', (tester) async {
    await tester.pumpWidget(_app(const Center(child: Text('Trading Room'))));
    final shot = await tester.runAsync(() => CheScreenCapture.capture());
    expect(shot, isNotNull);
    expect(shot!.ok, isTrue, reason: shot.reason);
    expect(shot.width, greaterThan(0));
    expect(shot.height, greaterThan(0));
    final bytes = base64Decode(shot.base64);
    // The PNG signature.
    expect(bytes.sublist(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
    expect(shot.width <= CheScreenCapture.maxSide && shot.height <= CheScreenCapture.maxSide, isTrue);
  });

  testWidgets('a password or vault surface on screen refuses the capture until it closes', (tester) async {
    await tester.pumpWidget(_app(const CheSensitiveScreen(child: Text('Password: hunter2'))));
    expect(CheScreenCapture.blocked, isTrue);
    final refused = await tester.runAsync(() => CheScreenCapture.capture());
    expect(refused!.ok, isFalse);
    expect(refused.base64, isEmpty);
    expect(refused.reason, contains('never leave this iPhone'));

    await tester.pumpWidget(_app(const Text('Chat')));
    expect(CheScreenCapture.blocked, isFalse);
    final shot = await tester.runAsync(() => CheScreenCapture.capture());
    expect(shot!.ok, isTrue, reason: shot.reason);
  });

  testWidgets('with no app on screen the capture says so instead of failing silently', (tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    final shot = await tester.runAsync(() => CheScreenCapture.capture());
    expect(shot!.ok, isFalse);
    expect(shot.reason, isNotEmpty);
  });
}
