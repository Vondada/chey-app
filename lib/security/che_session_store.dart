// CHE's sign-in to its Worker, kept in protected storage so the owner signs in once.
//
// - The device token lives in the iOS Keychain / Android Keystore (flutter_secure_storage, already in the installed
//   build), readable after the first unlock following a reboot and never synced off this device.
// - A token left in plain SharedPreferences by an older build is moved once: written to the Keychain, read back, and
//   only then deleted from the plain store.
// - The session ends only when the Worker says this device is unknown or revoked, or when the owner unpairs. Offline,
//   timeouts, server errors and "needs Face ID first" never sign the owner out.
// - The token is never logged, spoken, shown or sent anywhere but the Worker's Authorization header.
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The protected key-value store the session lives in (the Keychain in the app, a map in tests).
abstract class CheSecureKv {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class CheKeychainKv implements CheSecureKv {
  const CheKeychainKv();

  static const _storage = FlutterSecureStorage(
    // Available after the first unlock following a reboot (so CHE can restore the session when it launches), and
    // never copied to another device or a backup.
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// An in-memory store for tests (widget tests have no Keychain plugin).
@visibleForTesting
class CheMemoryKv implements CheSecureKv {
  final items = <String, String>{};
  @override
  Future<String?> read(String key) async => items[key];
  @override
  Future<void> write(String key, String value) async => items[key] = value;
  @override
  Future<void> delete(String key) async => items.remove(key);
}

/// Why the last session ended, so the app can say so plainly.
enum CheSessionEnd { none, revoked, unpaired, serverChanged }

class CheSessionStore {
  CheSessionStore({CheSecureKv? kv, Future<SharedPreferences> Function()? prefs})
      : _kv = kv ?? const CheKeychainKv(),
        _prefs = prefs ?? SharedPreferences.getInstance;

  static CheSessionStore instance = CheSessionStore();

  static const tokenKey = 'che_agent_device_token';
  static const endedKey = 'che_session_ended';

  final CheSecureKv _kv;
  final Future<SharedPreferences> Function() _prefs;
  String? _token;
  bool _loaded = false;

  /// The token already read this run, without touching storage (null before [deviceToken] ran or when signed out).
  String? get cached => _token;

  /// The Worker device token, restored from the Keychain (or moved there from an older build's plain storage).
  Future<String?> deviceToken() async {
    if (_loaded) return _token;
    final prefs = await _prefs();
    final plain = prefs.getString(tokenKey);
    String? secure;
    try {
      secure = await _kv.read(tokenKey);
    } catch (_) {
      // The Keychain could not be read (locked device before the first unlock, or no plugin in a test). Use the plain
      // copy if an older build left one, delete nothing, and try the Keychain again next time.
      return _token = (plain == null || plain.isEmpty) ? null : plain;
    }
    if ((secure == null || secure.isEmpty) && plain != null && plain.isNotEmpty) {
      try {
        await _kv.write(tokenKey, plain);
        if (await _kv.read(tokenKey) == plain) {
          await prefs.remove(tokenKey);
          secure = plain;
        } else {
          return _token = plain;
        }
      } catch (_) {
        return _token = plain;
      }
    } else if (secure != null && secure.isNotEmpty && plain != null) {
      await prefs.remove(tokenKey);
    }
    _loaded = true;
    return _token = (secure == null || secure.isEmpty) ? null : secure;
  }

  /// Stores a token the Worker just issued (pairing). Clears any "signed out" note.
  Future<void> save(String token) async {
    final prefs = await _prefs();
    _token = token;
    _loaded = true;
    await prefs.remove(endedKey);
    try {
      await _kv.write(tokenKey, token);
      await prefs.remove(tokenKey);
    } catch (_) {
      // No Keychain (tests, or a platform without one): keep the old behaviour rather than losing the sign-in.
      await prefs.setString(tokenKey, token);
    }
  }

  /// Ends the session on this device: removes the token from every store and records why.
  Future<void> clear(CheSessionEnd why) async {
    final prefs = await _prefs();
    _token = null;
    _loaded = true;
    await prefs.remove(tokenKey);
    await prefs.setString(endedKey, why.name);
    try {
      await _kv.delete(tokenKey);
    } catch (_) {}
  }

  /// Why the last session ended (none while signed in or never paired).
  Future<CheSessionEnd> lastEnd() async {
    final name = (await _prefs()).getString(endedKey) ?? '';
    return CheSessionEnd.values.firstWhere((e) => e.name == name, orElse: () => CheSessionEnd.none);
  }

  /// For tests: forget what was read this run, as a cold start does.
  void resetForColdStart() {
    _token = null;
    _loaded = false;
  }
}

/// True only when a Worker 401 means this device's sign-in is gone (unknown or revoked token). A 401 that asks for a
/// fresh Face ID session ("needs_scope") keeps the sign-in.
bool cheSessionRevoked(int status, String body) {
  if (status != 401) return false;
  return !body.contains('needs_scope') && !body.contains('Face ID');
}

/// What the owner sees and hears (on request) when the sign-in ended.
String cheSessionEndMessage(CheSessionEnd why) => switch (why) {
      CheSessionEnd.revoked => 'This phone was signed out of CHE: the Worker no longer accepts its sign-in (it was revoked or unpaired elsewhere). Pair again to continue.',
      CheSessionEnd.unpaired => 'You signed this phone out of CHE. Pair again when you want to sign back in.',
      CheSessionEnd.serverChanged => 'The CHE server address changed, so this phone needs to pair with the new server.',
      CheSessionEnd.none => '',
    };
