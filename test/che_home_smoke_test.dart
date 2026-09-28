import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('CHE boots to the kit home: orb state, empty state, composer', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const CHEApp());
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('What should we do?'), findsOneWidget);
    expect(find.text('New Chat'), findsOneWidget);
    expect(find.text('Tell CHE what to build or do…'), findsOneWidget);
    expect(find.text('Agent'), findsOneWidget);

    // Mode chip switches Agent -> Chat.
    await tester.tap(find.text('Agent'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Chat'), findsOneWidget);
    expect(find.text('Ask CHE anything…'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
  });
}
