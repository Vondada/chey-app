// Builds a ThemeData from a palette (che_palettes.dart), so the owner's theme choice is one value.
// CheTheme.dark() and CheTheme.light() are unchanged and still the app's default until the owner picks a palette.
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

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
  return ThemeData(
    useMaterial3: true,
    brightness: p.brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: p.bg,
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
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      TargetPlatform.android: CupertinoPageTransitionsBuilder(),
    }),
  );
}
