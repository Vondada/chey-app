// Builds a ThemeData from a palette (che_palettes.dart), so the owner's theme choice is one value.
// CheTheme.dark() and CheTheme.light() are unchanged and still the app's default until the owner picks a palette.
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import 'che_hud.dart';
import 'che_palettes.dart';
import 'che_theme.dart';

ThemeData cheThemeFor(CheColorPalette p) {
  final isDark = p.brightness == Brightness.dark;
  final scheme = ColorScheme(
    brightness: p.brightness,
    primary: p.accent,
    onPrimary: isDark ? Colors.black : Colors.white,
    secondary: p.accent,
    onSecondary: isDark ? Colors.black : Colors.white,
    error: CheColors.danger,
    onError: Colors.black,
    surface: p.surface,
    onSurface: p.text,
  );
  TextStyle on(TextStyle base, Color color) => base.copyWith(color: color);
  // HUD glass: pages are clear over the HUD backdrop each page carries, and cards are ice-edged glass.
  final hud = p.id == kCheHudPalette.id;
  const pageBuilder = CupertinoPageTransitionsBuilder();
  const hudPageBuilder = CheHudPageTransitionsBuilder();
  return ThemeData(
    useMaterial3: true,
    brightness: p.brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: hud ? Colors.transparent : p.bg,
    canvasColor: p.bg,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    textTheme: TextTheme(
      headlineMedium: on(CheType.title, p.text),
      titleMedium: on(CheType.headline, p.text),
      bodyLarge: on(CheType.body, p.text),
      bodyMedium: on(CheType.body, p.text),
      bodySmall: on(CheType.caption, p.textDim),
      labelLarge: on(CheType.label, p.text),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: p.accent,
      selectionColor: p.accent.withValues(alpha: 0.3),
      selectionHandleColor: p.accent,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: p.text,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.surface,
      modalBackgroundColor: p.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.surfaceHi,
      contentTextStyle: on(CheType.label, p.text),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md)),
    ),
    pageTransitionsTheme: PageTransitionsTheme(builders: {
      TargetPlatform.iOS: hud ? hudPageBuilder : pageBuilder,
      TargetPlatform.android: hud ? hudPageBuilder : pageBuilder,
    }),
    cardTheme: hud
        ? CardThemeData(
            color: const Color(0xFF9FE9FF).withValues(alpha: 0.07),
            surfaceTintColor: Colors.transparent,
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
              side: BorderSide(color: const Color(0xFF9FE9FF).withValues(alpha: 0.28)),
            ),
          )
        : null,
  );
}
