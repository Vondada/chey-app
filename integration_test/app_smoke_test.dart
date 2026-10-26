// Runs on an iOS simulator (see .github/workflows/che-ios-simulator-test.yml).
// It starts the real CHE app and fails if the first frames throw an error.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chey/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CHE starts on the simulator without an uncaught error', (tester) async {
    app.main();
    await tester.pump(const Duration(seconds: 5));
    expect(tester.takeException(), isNull);
    expect(find.byType(MaterialApp), findsWidgets);
  });
}
