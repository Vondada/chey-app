// Owner (2026-10-21): a palette builds a theme in its own colours; the CHE dark palette builds the current dark look.
import 'package:chey/che_ui/che_palette_theme.dart';
import 'package:chey/che_ui/che_palettes.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the CHE dark palette builds the current dark theme: same background, accent, text and surface colours', () {
    final built = cheThemeFor(kCheDarkPalette);
    final current = CheTheme.dark();
    expect(built.brightness, Brightness.dark);
    expect(built.scaffoldBackgroundColor, current.scaffoldBackgroundColor);
    expect(built.colorScheme.primary, current.colorScheme.primary);
    expect(built.colorScheme.surface, current.colorScheme.surface);
    expect(built.colorScheme.onSurface, current.colorScheme.onSurface);
    expect(built.textTheme.bodyLarge?.color, current.textTheme.bodyLarge?.color);
    expect(built.appBarTheme.foregroundColor, current.appBarTheme.foregroundColor);
  });

  test('the metallic silver palette uses its own background, text and teal accent', () {
    final t = cheThemeFor(kCheSilverBlackPalette);
    expect(t.brightness, Brightness.dark);
    expect(t.scaffoldBackgroundColor, kCheSilverBlackPalette.bg);
    expect(t.colorScheme.primary, kCheSilverBlackPalette.accent);
    expect(t.textTheme.bodyLarge?.color, kCheSilverBlackPalette.text);
    expect(t.appBarTheme.foregroundColor, kCheSilverBlackPalette.text);
  });

  test('the light palette is light, with dark text on its light background', () {
    final t = cheThemeFor(kCheLightPalette);
    expect(t.brightness, Brightness.light);
    expect(t.colorScheme.brightness, Brightness.light);
    expect(t.scaffoldBackgroundColor, kCheLightPalette.bg);
    expect(t.textTheme.bodyLarge?.color, kCheLightPalette.text);
  });
}
