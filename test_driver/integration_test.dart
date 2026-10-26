// Runs the screen gate on the iOS simulator and saves each screenshot to the CI workspace (screens/), where the upload
// step finds it. The app runs in the simulator's sandbox, so a file written by the test itself never reaches the runner.
import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver(
      onScreenshot: (name, bytes, [args]) async {
        final dir = Directory('screens')..createSync(recursive: true);
        File('${dir.path}/$name.png').writeAsBytesSync(bytes);
        return true;
      },
    );
