// CHE design system — colors, type, spacing, radii, motion, ThemeData.
// Every CHE screen should pull from here instead of hard-coding values.

import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

class CheColors {
  CheColors._();

  // ── LOGO COLORS ────────────────────────────────────────────────────────
  // Sample these three from the CHE app icon / logo and paste the hex here.
  // Everything else (glows, gradients, highlights) is derived from them.
  static const Color accent = Color(0xFF34E0B8); // main logo color (glow, CHE title)
  static const Color accentDeep = Color(0xFF0C9A7E); // darker shade of the logo color
  static const Color accentAlt = Color(0xFF4F8DFF); // secondary logo color (2nd glow stop)
  // ───────────────────────────────────────────────────────────────────────

  static const Color bg = Color(0xFF030607);
  static const Color bgTop = Color(0xFF06100F);
  static const Color surface = Color(0xFF0A1214);
  static const Color surfaceHi = Color(0xFF101B1E);
  static const Color stroke = Color(0xFF1B2A2D);
  static const Color strokeHi = Color(0xFF28403F);

  static const Color text = Color(0xFFEAF4F2);
  static const Color textDim = Color(0xFF8FA4A1);
  static const Color textFaint = Color(0xFF55696A);

  static const Color success = Color(0xFF3DDC97);
  static const Color warning = Color(0xFFFFB547);
  static const Color danger = Color(0xFFFF5C7A);

  // ── ALIASES (legacy names used by older screens) ───────────────────────
  static const Color panel = surface;
  static const Color textPrimary = text;
  static const Color bgDeep = bg;
  static const Color amber = warning;
  // ───────────────────────────────────────────────────────────────────────

  // Section hues for the Virtual Office tiles (kept from CHE's current look).
  static const Color memory = Color(0xFF2FD6B0);
  static const Color insights = Color(0xFF8B7BFF);
  static const Color markets = Color(0xFFE8B04A);
  static const Color business = Color(0xFFFF6B8B);
  static const Color devices = Color(0xFF4FA3FF);
  static const Color music = Color(0xFF53E08A);
  static const Color create = Color(0xFFFF8A4C);
  static const Color office = Color(0xFF7C8CFF);
  static const Color apps = Color(0xFF3FD0F0);

  static LinearGradient get accentGradient => const LinearGradient(
        colors: [accent, accentAlt],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      );
}

class CheSpace {
  CheSpace._();
  static const double xxs = 2;
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
  static const double gutter = 16; // side padding on every screen
}

class CheRadius {
  CheRadius._();
  static const double sm = 10;
  static const double md = 16;
  static const double lg = 22;
  static const double xl = 28;
  static const double pill = 999;
}

class CheMotion {
  CheMotion._();
  static const Duration fast = Duration(milliseconds: 160);
  static const Duration base = Duration(milliseconds: 260);
  static const Duration slow = Duration(milliseconds: 420);
  static const Curve curve = Curves.easeOutCubic;
  static const Curve spring = Curves.easeOutBack;

  /// Honors iOS "Reduce Motion".
  static bool reduced(BuildContext context) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  static Duration d(BuildContext context, Duration normal) =>
      reduced(context) ? Duration.zero : normal;
}

class CheType {
  CheType._();
  static const TextStyle display = TextStyle(
      fontSize: 34, fontWeight: FontWeight.w800, letterSpacing: 6, color: CheColors.accent, height: 1.05);
  static const TextStyle title = TextStyle(
      fontSize: 24, fontWeight: FontWeight.w700, color: CheColors.text, height: 1.15, letterSpacing: -0.3);
  static const TextStyle headline = TextStyle(
      fontSize: 17, fontWeight: FontWeight.w600, color: CheColors.text, height: 1.25);
  static const TextStyle body = TextStyle(
      fontSize: 15.5, fontWeight: FontWeight.w400, color: CheColors.text, height: 1.45);
  static const TextStyle bodyDim = TextStyle(
      fontSize: 14, fontWeight: FontWeight.w400, color: CheColors.textDim, height: 1.4);
  static const TextStyle label = TextStyle(
      fontSize: 13, fontWeight: FontWeight.w600, color: CheColors.text, letterSpacing: 0.2);
  static const TextStyle caption = TextStyle(
      fontSize: 11.5, fontWeight: FontWeight.w500, color: CheColors.textDim, height: 1.3);
  static const TextStyle overline = TextStyle(
      fontSize: 10.5, fontWeight: FontWeight.w700, color: CheColors.textDim, letterSpacing: 3);
  static const TextStyle mono = TextStyle(
      fontFamily: 'Menlo',
      fontFamilyFallback: ['Courier', 'monospace'],
      fontSize: 13,
      height: 1.5,
      color: CheColors.text,
      fontFeatures: [FontFeature.tabularFigures()]);
}

class CheTheme {
  CheTheme._();

  static ThemeData dark() {
    final scheme = const ColorScheme.dark(
      primary: CheColors.accent,
      onPrimary: Colors.black,
      secondary: CheColors.accentAlt,
      onSecondary: Colors.black,
      surface: CheColors.surface,
      onSurface: CheColors.text,
      error: CheColors.danger,
      onError: Colors.black,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: scheme,
      scaffoldBackgroundColor: CheColors.bg,
      canvasColor: CheColors.bg,
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
      textTheme: const TextTheme(
        headlineMedium: CheType.title,
        titleMedium: CheType.headline,
        bodyLarge: CheType.body,
        bodyMedium: CheType.body,
        bodySmall: CheType.caption,
        labelLarge: CheType.label,
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: CheColors.accent,
        selectionColor: CheColors.accent.withValues(alpha: 0.3),
        selectionHandleColor: CheColors.accent,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        foregroundColor: CheColors.text,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: CheColors.surface,
        modalBackgroundColor: CheColors.surface,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: CheColors.surfaceHi,
        contentTextStyle: CheType.label,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md)),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
      }),
    );
  }


  /// Light companion theme — soft paper surfaces with the same teal accent.
  static ThemeData light() {
    const scheme = ColorScheme.light(
      primary: CheColors.accentDeep,
      onPrimary: Colors.white,
      secondary: CheColors.accentAlt,
      onSecondary: Colors.white,
      surface: Color(0xFFFFFFFF),
      onSurface: Color(0xFF0C1614),
      error: CheColors.danger,
      onError: Colors.white,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: scheme,
      scaffoldBackgroundColor: const Color(0xFFF3F7F6),
      canvasColor: const Color(0xFFF3F7F6),
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
      textTheme: const TextTheme(
        headlineMedium: TextStyle(
            fontSize: 24, fontWeight: FontWeight.w700, color: Color(0xFF0C1614), height: 1.15, letterSpacing: -0.3),
        titleMedium: TextStyle(
            fontSize: 17, fontWeight: FontWeight.w600, color: Color(0xFF0C1614), height: 1.25),
        bodyLarge: TextStyle(
            fontSize: 15.5, fontWeight: FontWeight.w400, color: Color(0xFF0C1614), height: 1.45),
        bodyMedium: TextStyle(
            fontSize: 15.5, fontWeight: FontWeight.w400, color: Color(0xFF0C1614), height: 1.45),
        bodySmall: TextStyle(
            fontSize: 11.5, fontWeight: FontWeight.w500, color: Color(0xFF55696A), height: 1.3),
        labelLarge: TextStyle(
            fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF0C1614), letterSpacing: 0.2),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: CheColors.accentDeep,
        selectionColor: CheColors.accent.withValues(alpha: 0.3),
        selectionHandleColor: CheColors.accentDeep,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        foregroundColor: Color(0xFF0C1614),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: Color(0xFFFFFFFF),
        modalBackgroundColor: Color(0xFFFFFFFF),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(CheRadius.xl))),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: const Color(0xFF0A1214),
        contentTextStyle: CheType.label,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md)),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
      }),
    );
  }
}

bool cheIsLight(BuildContext context) =>
    Theme.of(context).brightness == Brightness.light;

Color cheBgOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFFF3F7F6) : CheColors.bg;

Color cheBgTopOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFFE8F2EF) : CheColors.bgTop;

Color cheSurfaceOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFFFFFFFF) : CheColors.surface;

Color cheStrokeOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFFD5E2DE) : CheColors.stroke;

Color cheTextOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFF0C1614) : CheColors.text;

Color cheTextDimOf(BuildContext context) =>
    cheIsLight(context) ? const Color(0xFF55696A) : CheColors.textDim;
