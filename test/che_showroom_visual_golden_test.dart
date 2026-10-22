import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_showroom.dart';

import 'che_showroom_fixture.dart';

// The showroom as a picture: stickers, status badges and "How it works" folded away (owner, 2026-10-22: "more visually").
Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(
    family,
  )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

void main() {
  setUpAll(() async {
    final fonts =
        '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets(
    'the showroom category and capability cards read as stickers at phone width',
    (tester) async {
      tester.view.physicalSize = const Size(440 * 2, 956 * 2);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: cheThemeFor(kCheHudPalette).copyWith(textTheme: cheThemeFor(kCheHudPalette).textTheme.apply(fontFamily: 'Roboto')),
          home: CheShowroomPage(load: () async => showroom(), onStart: (_) {}),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/showroom_categories.png'),
      );

      await tester.tap(find.text('1. Inventions & Engineering'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/showroom_cards.png'),
      );
    },
  );
}
