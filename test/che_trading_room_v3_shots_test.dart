// Trading Room v3 screenshots for the owner's review (owner, 2026-10-25): the room at the iPhone portrait size
// (440 x 956 points) in the HUD look, with realistic and empty Worker answers (trading_room_v3_fixture.dart). Each scene
// is captured twice: the first screen as the owner sees it, and the whole scrolled page in one tall picture.
// Runs everywhere (it must build without errors); PNGs are written only when CHE_SHOTS_DIR names a folder:
//   CHE_SHOTS_DIR=docs/trading_room_v3/after flutter test test/che_trading_room_v3_shots_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/rooms/che_trading_room.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'trading_room_v3_fixture.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

final _dir = Platform.environment['CHE_SHOTS_DIR'] ?? '';

Future<void> _shoot(WidgetTester tester, GlobalKey key, String name) async {
  if (_dir.isEmpty) return;
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    File('$_dir/$name.png')
      ..createSync(recursive: true)
      ..writeAsBytesSync(png!.buffer.asUint8List());
  });
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    // Text painted straight onto a canvas (chart price labels) uses the test's default font, which draws boxes.
    await _font('FlutterTest', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  const sections = {
    'chart': CheTradingSection.chart,
    'journal': CheTradingSection.cheTrades,
    'history': CheTradingSection.history,
    'account': CheTradingSection.account,
    'crypto': CheTradingSection.crypto,
  };
  for (final empty in [false, true]) {
    for (final entry in sections.entries) {
      for (final tall in [false, true]) {
        final name = '${empty ? 'empty' : 'realistic'}_${entry.key}${tall ? '_full' : ''}';
        testWidgets('screenshot $name', (tester) async {
          final size = Size(440, tall ? 2600 : 956);
          await tester.binding.setSurfaceSize(size);
          addTearDown(() => tester.binding.setSurfaceSize(null));
          ChePaperEngine.sharedForTest = ChePaperEngine.load(ChePaperMemoryStore(), clock: () => kFixtureNow);
          addTearDown(() => ChePaperEngine.sharedForTest = null);
          final key = GlobalKey();
          final theme = cheThemeFor(kCheHudPalette);
          await tester.pumpWidget(RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
              home: MediaQuery(
                data: MediaQueryData(size: size, padding: const EdgeInsets.only(top: 62, bottom: 34), viewPadding: const EdgeInsets.only(top: 62, bottom: 34)),
                child: CheHudBackdrop(
                  floor: 0.6,
                  child: Scaffold(
                    backgroundColor: Colors.transparent,
                    body: SafeArea(
                      child: CheTradingRoom(
                        baseUrl: () => 'https://che.test',
                        headers: () => const {},
                        onAsk: (_) {},
                        onRead: (_) {},
                        client: fixtureWorker(empty: empty),
                        initialSection: entry.value,
                        setupDesk: CheSetupDesk(),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ));
          for (var i = 0; i < 6; i++) {
            await tester.pump(const Duration(milliseconds: 100));
            await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
          }
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull);
          await _shoot(tester, key, name);
          await tester.pumpWidget(const SizedBox());
          await tester.pump(const Duration(seconds: 2));
        });
      }
    }
  }
}
