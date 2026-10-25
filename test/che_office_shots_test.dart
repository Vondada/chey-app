// Screenshots of the Office operations center for the owner's review, rendered at the iPhone 17 Pro Max size
// (440 x 956 points) in the HUD palette with sample Worker answers (che_office_fixture.dart). Writes PNGs only when
// CHE_SHOTS_DIR names a folder:
//   CHE_SHOTS_DIR=docs/ui_cleanup/office CHE_SHOTS_PREFIX=after flutter test test/che_office_shots_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/agents/che_office_floor_screen.dart';
import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'che_office_fixture.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

final _dir = Platform.environment['CHE_SHOTS_DIR'] ?? '';
final _prefix = Platform.environment['CHE_SHOTS_PREFIX'] ?? 'after';

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  // Each scene: whether the Office is empty, and how far down the page it is scrolled.
  const scenes = <(String, bool, double)>[
    ('1_top', false, 0),
    ('2_middle', false, 900),
    ('3_lower', false, 1800),
    ('4_bottom', false, 2700),
    ('5_empty_office', true, 0),
  ];
  for (final (name, empty, offset) in scenes) {
    testWidgets('screenshot $name', (tester) async {
      await tester.binding.setSurfaceSize(const Size(440, 956));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final key = GlobalKey();
      final theme = cheThemeFor(kCheHudPalette);
      await tester.pumpWidget(RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(440, 956),
              padding: EdgeInsets.only(top: 62, bottom: 34),
              viewPadding: EdgeInsets.only(top: 62, bottom: 34),
            ),
            child: CheHudBackdrop(
              child: Scaffold(
                backgroundColor: Colors.transparent,
                body: SafeArea(
                  child: CheOfficeFloorScreen(client: cheFixtureClient(empty: empty), embedded: true),
                ),
              ),
            ),
          ),
        ),
      ));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      final pictures = find.byType(Image).evaluate().toList();
      await tester.runAsync(() async {
        for (final e in pictures) {
          await precacheImage((e.widget as Image).image, e);
        }
      });
      if (offset > 0) {
        final scrollable = find.byType(Scrollable).first;
        final state = tester.state<ScrollableState>(scrollable);
        state.position.jumpTo(offset.clamp(0, state.position.maxScrollExtent));
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
          File('$_dir/${_prefix}_$name.png')
            ..createSync(recursive: true)
            ..writeAsBytesSync(png!.buffer.asUint8List());
        });
      }
      await tester.pumpWidget(const SizedBox());
    });
  }
}
