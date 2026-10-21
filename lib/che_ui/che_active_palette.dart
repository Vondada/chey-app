// The palette the whole app is drawn with right now (owner, 2026-10-21: the Settings theme choice must change CHE's
// screens). CheColors and CheType read it, so every screen that rebuilds takes the owner's choice. The app root is
// remounted when the choice changes (main.dart), so screens already on the page take it too.
import 'che_palettes.dart';

class CheActivePalette {
  CheActivePalette._();

  /// Set by CheUiPreferences when the owner picks a palette, and at load from the saved id.
  static CheColorPalette current = kCheDarkPalette;
}
