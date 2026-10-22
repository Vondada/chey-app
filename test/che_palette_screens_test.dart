// The owner's theme choice must change CHE's real screens (owner, 2026-10-21: "the interface is still completely
// unchanged"). This renders a real screen, the Settings > Appearance page, under each palette and checks the palette
// reached it; the images in test/goldens are the visible evidence.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:chey/che_ui/che_active_palette.dart';
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:chey/home/che_ui_controls_screen.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  for (final palette in kCheColorPalettes) {
    testWidgets('the ${palette.label} palette reaches the Appearance screen', (tester) async {
      await CheUiPreferences.instance.setPalette(palette);
      expect(CheActivePalette.current.id, palette.id);
      expect(CheColors.bg, palette.bg, reason: 'CheColors reads the active palette');
      expect(CheColors.accent, palette.accent);

      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        ListenableBuilder(
          listenable: CheUiPreferences.instance,
          builder: (context, _) => KeyedSubtree(
            key: ValueKey(palette.id),
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: cheThemeFor(palette),
              home: const CheUiControlsScreen(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      // HUD glass pages are clear over the HUD backdrop each page carries; every other palette paints its background.
      expect(scaffold.backgroundColor ?? Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor,
          palette.id == kCheHudPalette.id ? Colors.transparent : palette.bg);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/appearance_${palette.id}.png'),
      );
    });
  }
}
