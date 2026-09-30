// Face ID gate for CHE's on-device password vault.
//
// Before vault secrets are filled into a page or spoken/shown, the owner must
// pass LocalAuthentication via CheAccountBridge.authenticate. A short in-memory
// session TTL avoids re-prompting on every tap. Passwords never leave the
// device; this module only unlocks local use.

import 'package:flutter/foundation.dart' show visibleForTesting;

import '../che_account_bridge.dart';

/// Biometric one-time gate + session TTL for vault fill / reveal.
class CheVaultAuth {
  CheVaultAuth._();
  static final CheVaultAuth instance = CheVaultAuth._();

  /// Successful Face ID unlock lasts this long without re-prompting.
  /// Configurable constant (5–15 minutes per product guidance).
  static const Duration sessionTtl = Duration(minutes: 10);

  static const String defaultReason =
      'Unlock CHE password vault with Face ID to fill or show a saved login';

  DateTime? _unlockedUntil;

  /// True while the in-memory Face ID session is still within [sessionTtl].
  bool get isSessionValid {
    final until = _unlockedUntil;
    return until != null && DateTime.now().isBefore(until);
  }

  /// Remaining time in the current session, or [Duration.zero] if locked.
  Duration get sessionRemaining {
    final until = _unlockedUntil;
    if (until == null) return Duration.zero;
    final left = until.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  /// Clears the in-memory unlock (does not delete vault entries).
  void lock() {
    _unlockedUntil = null;
  }

  @visibleForTesting
  void debugSetUnlockedUntil(DateTime? until) {
    _unlockedUntil = until;
  }

  /// Ensures Face ID (or device passcode via LocalAuthentication) has been
  /// granted for this session. Returns false on fail/cancel — caller must
  /// not fill or reveal secrets.
  Future<bool> ensureUnlocked({String reason = defaultReason}) async {
    if (isSessionValid) return true;
    final ok = await CheAccountBridge.authenticate(reason: reason);
    if (ok) {
      _unlockedUntil = DateTime.now().add(sessionTtl);
    }
    return ok;
  }
}
