// CHE World and the Create room in the owner's approved HUD glass look (owner, 2026-10-22: "this style for all her
// rooms"), rendered at the owner's iPhone size (440 x 956 points). The images in test/goldens are the evidence: navy
// space backdrop, glass panels with a spectral rim, chrome headings and ice-blue light. Real text and icons are drawn
// with the Roboto and Material Icons fonts that ship with the Flutter SDK. The data below is test data only.
import 'dart:io';

import 'package:chey/che_creations.dart';
import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_world_hub.dart';
import 'package:chey/create_gallery_scene.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

Future<void> _shoot(WidgetTester tester, Widget room, String golden) async {
  await tester.binding.setSurfaceSize(const Size(440, 956));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final theme = cheThemeFor(kCheHudPalette);
  await tester.pumpWidget(MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto')),
    // A pushed room gets the HUD backdrop from the page transition; the app's first page is given it here.
    home: CheHudBackdrop(child: room),
  ));
  await tester.pump(const Duration(milliseconds: 400));
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$golden.png'));
  await tester.pumpWidget(const SizedBox());
}

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    // The HUD labels use Menlo, which iOS ships and the test machine does not; Roboto stands in for the picture.
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
    CheActivePalette.current = kCheHudPalette;
  });

  testWidgets('CHE World hub in HUD glass', (tester) async {
    await _shoot(tester, CheWorldHubScreen(onOpenTab: (_) {}), 'hud_world_hub');
  });

  testWidgets('Create room in HUD glass', (tester) async {
    await _shoot(
      tester,
      Scaffold(
        body: CreateGalleryScene(
          active: true,
          projects: [
            {'id': 'p1', 'title': 'Arc reactor lamp', 'type': 'invention', 'status': 'idle', 'updated_at': '2026-10-20T10:00:00Z'},
            {'id': 'p2', 'title': 'Night city poster', 'type': 'art', 'status': 'idle', 'updated_at': '2026-10-21T10:00:00Z'},
          ],
          vaultCount: 3,
          researchConnected: true,
          imageConnected: true,
          videoConnected: false,
          onNewProject: () {},
          onOpenProject: (_) async {},
          onVault: () {},
          onResearch: () {},
          onImage: () {},
          onVideo: () {},
          onShowroom: () {},
          creations: const CheCreationsTiles(
            items: [
              {'id': 'v1', 'kind': 'video', 'title': 'Launch teaser'},
              {'id': 'v2', 'kind': 'video', 'title': 'Studio walk-through'},
            ],
            baseUrl: 'https://che.test',
            headers: {},
          ),
        ),
      ),
      'hud_world_create',
    );
  });

  testWidgets('World hub room buttons keep a 44-point target on the HUD', (tester) async {
    await tester.binding.setSurfaceSize(const Size(440, 956));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final opened = <int>[];
    await tester.pumpWidget(MaterialApp(theme: cheThemeFor(kCheHudPalette), home: CheWorldHubScreen(onOpenTab: opened.add)));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.getSize(find.ancestor(of: find.text('Brain'), matching: find.byType(InkWell)).first).height, greaterThanOrEqualTo(44));
    await tester.tap(find.text('Brain'));
    expect(opened, [0]);
    await tester.pumpWidget(const SizedBox());
  });
}
