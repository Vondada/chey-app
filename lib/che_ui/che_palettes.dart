// Theme palettes for CHE (owner, 2026-10-21): dark (the current CHE look), silver and black, and light.
// Pure data: no widget reads these yet. Each palette is checked for WCAG contrast in test/che_palettes_test.dart,
// so a palette that makes text hard to read cannot be added or chosen.
import 'package:flutter/material.dart';

class CheColorPalette {
  const CheColorPalette({
    required this.id,
    required this.label,
    required this.brightness,
    required this.bg,
    required this.surface,
    required this.surfaceHi,
    required this.stroke,
    required this.text,
    required this.textDim,
    required this.accent,
  });

  /// Stable id saved in the owner's settings (never change an id once shipped).
  final String id;
  final String label;
  final Brightness brightness;
  final Color bg;
  final Color surface;
  final Color surfaceHi;
  final Color stroke;
  final Color text;
  final Color textDim;
  final Color accent;
}

/// The current CHE palette: teal on near-black. Kept as the default so nothing changes until the owner picks another.
const kCheDarkPalette = CheColorPalette(
  id: 'che_dark',
  label: 'CHE dark',
  brightness: Brightness.dark,
  bg: Color(0xFF030607),
  surface: Color(0xFF0A1214),
  surfaceHi: Color(0xFF101B1E),
  stroke: Color(0xFF1B2A2D),
  text: Color(0xFFEAF4F2),
  textDim: Color(0xFF8FA4A1),
  accent: Color(0xFF34E0B8),
);

/// Metallic CHE (owner, 2026-10-22): layered blacks with graphite and gunmetal surfaces, brushed-silver borders and a
/// teal-cyan energy accent. The id stays "silver_black" so the owner's saved choice now shows this look.
const kCheSilverBlackPalette = CheColorPalette(
  id: 'silver_black',
  label: 'Metallic silver and teal',
  brightness: Brightness.dark,
  bg: Color(0xFF050709),
  surface: Color(0xFF0E1418),
  surfaceHi: Color(0xFF141A1F),
  stroke: Color(0xFF2E4147),
  text: Color(0xFFF3F8F9),
  textDim: Color(0xFFA4B8BC),
  accent: Color(0xFF3FE6D2),
);

/// Clean daylight look: white and soft gray surfaces, graphite text.
const kCheLightPalette = CheColorPalette(
  id: 'che_light',
  label: 'Light',
  brightness: Brightness.light,
  bg: Color(0xFFF4F5F7),
  surface: Color(0xFFFFFFFF),
  surfaceHi: Color(0xFFEBEDF1),
  stroke: Color(0xFFD2D6DD),
  text: Color(0xFF111418),
  textDim: Color(0xFF4A5260),
  accent: Color(0xFF1F6F5C),
);

const kCheColorPalettes = <CheColorPalette>[kCheDarkPalette, kCheSilverBlackPalette, kCheLightPalette];

/// The palette for a saved id, or the dark default for an unknown or missing id (never a crash).
CheColorPalette cheColorPaletteFor(String? id) {
  for (final p in kCheColorPalettes) {
    if (p.id == id) return p;
  }
  return kCheDarkPalette;
}

/// WCAG 2.x contrast ratio between two colours (1.0 to 21.0).
double cheContrastRatio(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
