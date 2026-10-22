// Owner (2026-10-21): every CHE palette keeps text readable (WCAG AA, 4.5:1 for body text) and ids stay stable.
import 'package:chey/che_ui/che_palettes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final p in kCheColorPalettes) {
    test('${p.label}: body text, dim text and the accent meet WCAG AA on every surface', () {
      for (final background in [p.bg, p.surface, p.surfaceHi]) {
        expect(cheContrastRatio(p.text, background), greaterThanOrEqualTo(4.5), reason: '${p.id} text on $background');
        expect(cheContrastRatio(p.textDim, background), greaterThanOrEqualTo(4.5), reason: '${p.id} dim text on $background');
        expect(cheContrastRatio(p.accent, background), greaterThanOrEqualTo(3.0), reason: '${p.id} accent on $background');
      }
    });

    test('${p.label}: brightness matches the background it is drawn on', () {
      final isDark = p.bg.computeLuminance() < 0.5;
      expect(p.brightness == Brightness.dark, isDark, reason: p.id);
    });
  }

  test('ids are stable and unique', () {
    expect(kCheColorPalettes.map((p) => p.id).toList(), ['hud_glass', 'che_dark', 'silver_black', 'che_light']);
  });

  test('an unknown or missing saved id falls back to HUD glass, the approved default', () {
    expect(cheColorPaletteFor(null).id, 'hud_glass');
    expect(cheColorPaletteFor('neon_pink').id, 'hud_glass');
    expect(cheColorPaletteFor('che_dark').id, 'che_dark');
    expect(cheColorPaletteFor('silver_black').id, 'silver_black');
  });
}
