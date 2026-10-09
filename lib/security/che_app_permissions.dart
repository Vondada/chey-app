// CHE's per-app permission grants.
//
// When the owner explicitly says "open X", that utterance is the permission:
// X is recorded here permanently, so later uses of the same app are not asked
// about again. Every chat turn sends these grants to the Worker, which
// enforces the ask-first rule in code. Not secret: passwords stay in the
// on-device Keychain vault, never here.

import 'package:shared_preferences/shared_preferences.dart';

/// The owner's per-app permissions, one permanent grant per app he opened
/// himself. Stored in shared_preferences because the Worker only needs to
/// read the names, never anything secret.
class CheAppPermissions {
  CheAppPermissions._();

  static const String _key = 'che_granted_apps';

  /// Apps the owner has granted, as lowercase names.
  static Future<Set<String>> granted() async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_key) ?? const <String>[]).toSet();
  }

  /// Remembers the owner's explicit permission for [app]; returns the new set.
  /// Ignores empty names and duplicate grants. Writes a sorted string list.
  static Future<Set<String>> grant(String app) async {
    final prefs = await SharedPreferences.getInstance();
    final name = app.toLowerCase().trim();
    final apps = (prefs.getStringList(_key) ?? const <String>[]).toSet();
    if (name.isEmpty || !apps.add(name)) return apps;
    final sorted = apps.toList()..sort();
    await prefs.setStringList(_key, sorted);
    return apps;
  }
}
