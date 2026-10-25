// Screenshots of the Brain Room for the owner's review (UI cleanup, 2026-10-25): the seven-region first glance, one
// region sheet, its search, Memory Details, Live Activity with Real-Time Learning, the record constellation on
// request, the sidebar, an empty brain and a very large one. Rendered at the iPhone portrait size (440 × 956 logical
// points, 2× pixels) with the real fonts. Sample records only (che_brain_overview_fixture.dart). Every scene runs in
// CI (no ErrorWidget, no exception); PNGs are written only when CHE_SHOTS_DIR names a folder:
//   CHE_SHOTS_DIR=docs/ui_cleanup/brain/after FLUTTER_ROOT=/opt/flutter flutter test test/che_brain_overview_shots_test.dart
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

  const scenes = ['1_brain_overview', '2_region_sheet', '3_region_search', '4_memory_details', '5_live_activity_learning', '6_constellation_on_request', '7_sidebar', '8_empty_brain', '9_large_brain'];
  for (final scene in scenes) {
    testWidgets('screenshot $scene', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 956));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final key = GlobalKey();
      final dots = switch (scene) {
        '8_empty_brain' => <CheMemoryDot>[],
        '9_large_brain' => cheLargeTestDots(6000),
        _ => cheTestDots(),
      };
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
                    onReadAloud: (_) async {},
                    initialSection: scene == '5_live_activity_learning' ? CheBrainNav.activity : CheBrainNav.overview,
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
      Future<void> settle() async {
        for (var i = 0; i < 30; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
      }
      if (scene == '2_region_sheet' || scene == '3_region_search' || scene == '4_memory_details') {
        await tester.tap(find.byKey(ValueKey(scene == '2_region_sheet' ? 'brain-lobe-memory' : 'brain-lobe-conversations')));
        await settle();
      }
      if (scene == '3_region_search' || scene == '4_memory_details') {
        await tester.enterText(find.byKey(const ValueKey('brain-lobe-search')), 'red');
        await tester.pump();
        FocusManager.instance.primaryFocus?.unfocus();
      }
      if (scene == '4_memory_details') {
        await tester.tap(find.byKey(const ValueKey('brain-lobe-record-conv:outfits')));
        await settle();
      }
      if (scene == '5_live_activity_learning') {
        await tester.tap(find.byKey(const ValueKey('brain-learning-toggle')));
      }
      if (scene == '6_constellation_on_request') {
        await tester.tap(find.byKey(const ValueKey('brain-constellation-toggle')));
        await settle();
      }
      if (scene == '7_sidebar') {
        await tester.tap(find.byKey(const ValueKey('brain-sidebar-toggle')));
      }
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(tester.takeException(), isNull);
      expect(find.byType(ErrorWidget), findsNothing);
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
