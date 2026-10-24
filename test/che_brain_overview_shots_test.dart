// Screenshots of the Brain Room overview for the owner's review (Brain Overview, Live Activity, Search, Memory
// Details, Real-Time Learning, dashboard cards, sidebar), rendered at the iPhone 17 Pro Max size with the real fonts.
// Sample records only (che_brain_overview_fixture.dart). Runs only when CHE_SHOTS_DIR names a folder to write to:
//   CHE_SHOTS_DIR=/tmp/shots flutter test test/che_brain_overview_shots_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/brain/che_brain_overview.dart';
import 'package:chey/brain/che_brain_regions.dart';
import 'package:chey/brain/che_brain_space.dart' show CheBrainSpaceController;
import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/home/che_memory_brain.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_brain_overview_fixture.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

final _dir = Platform.environment['CHE_SHOTS_DIR'] ?? '';

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    // Text the brain paints itself (lobe and worker labels) would otherwise use the test's box font.
    CheBrainSpaceController.labelFontFamily = 'Roboto';
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  const scenes = ['1_brain_overview', '2_live_activity', '3_search', '4_memory_details', '5_real_time_learning', '6_dashboard_cards', '7_sidebar'];
  for (final scene in scenes) {
    testWidgets('screenshot $scene', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 956));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final key = GlobalKey();
      final dots = cheTestDots();
      final theme = cheThemeFor(kCheHudPalette);
      await tester.pumpWidget(RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
          home: MediaQuery(
            data: const MediaQueryData(size: Size(440, 956), padding: EdgeInsets.only(top: 62, bottom: 34), viewPadding: EdgeInsets.only(top: 62, bottom: 34)),
            child: CheHudBackdrop(
              child: Scaffold(
                backgroundColor: Colors.transparent,
                body: SafeArea(
                  child: CheBrainOverview(
                    dots: dots,
                    clock: () => cheTestNow,
                    loadLearning: () async => cheTestLedger(),
                    initialSection: switch (scene) {
                      '2_live_activity' => CheBrainNav.activity,
                      '3_search' || '4_memory_details' => CheBrainNav.search,
                      _ => CheBrainNav.overview,
                    },
                    brain: CheMemoryBrainRoom(dots: dots, onRefresh: () async {}),
                  ),
                ),
              ),
            ),
          ),
        ),
      ));
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      if (scene == '3_search' || scene == '4_memory_details') {
        await tester.enterText(find.byKey(const ValueKey('brain-search-field')), 'red');
        await tester.pump();
        if (scene == '3_search') FocusManager.instance.primaryFocus?.unfocus();
      }
      if (scene == '4_memory_details') {
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.tap(find.byKey(const ValueKey('brain-record-mem:red')));
        for (var i = 0; i < 30; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
      }
      if (scene == '5_real_time_learning') {
        await tester.tap(find.byKey(const ValueKey('brain-learning-toggle')));
      }
      if (scene == '6_dashboard_cards') {
        await tester.drag(find.byKey(const ValueKey('brain-dashboard')), const Offset(-300, 0));
      }
      if (scene == '7_sidebar') {
        await tester.tap(find.byKey(const ValueKey('brain-sidebar-toggle')));
      }
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(tester.takeException(), isNull);
      if (_dir.isNotEmpty) {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 2);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          File('$_dir/$scene.png')
            ..createSync(recursive: true)
            ..writeAsBytesSync(png!.buffer.asUint8List());
        });
      }
      await tester.pumpWidget(const SizedBox());
    });
  }
}
