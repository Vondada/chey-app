// Runs on an iOS simulator (see .github/workflows/che-ios-simulator-test.yml).
// It starts the real CHE app and fails if startup throws an error.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chey/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CHE starts on the simulator without an uncaught error', (tester) async {
    app.main();
    await tester.pump(const Duration(seconds: 5));
    // CHE loads its plugins, brain and cognition after the first frame. Let
    // those loads finish while the app is still alive, so their late updates
    // do not land after the test has ended and the app is disposed.
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 20)));
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
    expect(find.byType(MaterialApp), findsWidgets);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
  });
}
