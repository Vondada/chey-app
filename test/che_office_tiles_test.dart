// Office voice tiles at iPhone width: labels wrap in full, never cut off with "1. O…".
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_ui/che_voice_actions.dart';

void main() {
  testWidgets('horizontal voice tiles wrap their labels at 375pt', (tester) async {
    tester.view.physicalSize = const Size(375 * 3, 812 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: CheVoiceActionList(
            horizontal: true,
            actions: [
              for (final (i, label) in ['Status', 'Find agent', 'War Room', 'Meetings'].indexed)
                CheVoiceAction(number: i + 1, label: label, onTap: () {}),
            ],
          ),
        ),
      ),
    ));

    expect(tester.takeException(), isNull);
    for (final label in ['1. Status', '2. Find agent', '3. War Room', '4. Meetings']) {
      final text = tester.widget<Text>(find.text(label));
      expect(text.overflow, isNot(TextOverflow.ellipsis), reason: '$label must not be cut off');
      expect(text.maxLines, 2, reason: '$label wraps to two lines');
    }
  });
}
