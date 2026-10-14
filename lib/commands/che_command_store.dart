// What the Command Center remembers on this iPhone across restarts:
// favorites, recently used commands, the last catalog CHE sent (so the
// library still opens offline, marked as possibly out of date), and the
// suggestion cards the owner dismissed. Saved workflows live on CHE's
// server (so voice can run them) and are cached here too.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_command_models.dart';

class CheCommandStore extends ChangeNotifier {
  static const favoritesKey = 'che.commands.favorites';
  static const recentsKey = 'che.commands.recents';
  static const catalogKey = 'che.commands.catalog';
  static const dismissedKey = 'che.commands.dismissed_suggestions';
  static const maxRecents = 8;

  final List<String> _favorites = [];
  final List<String> _recents = [];
  final Set<String> _dismissed = {};
  Map<String, dynamic>? _cachedCatalog;
  bool _loaded = false;

  List<String> get favorites => List.unmodifiable(_favorites);
  List<String> get recents => List.unmodifiable(_recents);
  Set<String> get dismissed => Set.unmodifiable(_dismissed);
  bool get loaded => _loaded;
  bool isFavorite(String id) => _favorites.contains(id);

  CheCommandCatalog? get cachedCatalog {
    final raw = _cachedCatalog;
    return raw == null ? null : CheCommandCatalog.fromJson(raw);
  }

  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _favorites
        ..clear()
        ..addAll(prefs.getStringList(favoritesKey) ?? const []);
      _recents
        ..clear()
        ..addAll(prefs.getStringList(recentsKey) ?? const []);
      _dismissed
        ..clear()
        ..addAll(prefs.getStringList(dismissedKey) ?? const []);
      final raw = prefs.getString(catalogKey);
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) _cachedCatalog = Map<String, dynamic>.from(decoded);
      }
    } catch (_) {
      // Unreadable preferences: start empty rather than fail to open.
    }
    _loaded = true;
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(favoritesKey, _favorites);
      await prefs.setStringList(recentsKey, _recents);
      await prefs.setStringList(dismissedKey, _dismissed.toList());
    } catch (_) {}
  }

  /// Returns true when the command is now a favorite.
  Future<bool> toggleFavorite(String id) async {
    final now = !_favorites.contains(id);
    if (now) {
      _favorites.insert(0, id);
    } else {
      _favorites.remove(id);
    }
    notifyListeners();
    await _save();
    return now;
  }

  Future<void> noteUsed(String id) async {
    _recents
      ..remove(id)
      ..insert(0, id);
    if (_recents.length > maxRecents) _recents.removeRange(maxRecents, _recents.length);
    notifyListeners();
    await _save();
  }

  Future<void> dismissSuggestion(String cardId) async {
    if (_dismissed.add(cardId)) {
      notifyListeners();
      await _save();
    }
  }

  Future<void> cacheCatalog(Map<String, dynamic> json) async {
    _cachedCatalog = json;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(catalogKey, jsonEncode(json));
    } catch (_) {}
  }
}
