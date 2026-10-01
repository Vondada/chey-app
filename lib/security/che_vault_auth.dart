// Face ID gate for CHE's on-device password vault.
//
// Before vault secrets are filled into a page or spoken/shown, the owner must
// pass Apple's LocalAuthentication via CheAccountBridge.authenticate. Ordinary
// account-vault browsing may reuse a short in-memory session, but password
// reveal/fill/delete/import callers can force a fresh Face ID check each time.
// Face templates never enter Flutter or leave the iPhone.

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

  /// Ensures the owner is authenticated. Set [freshFaceId] for any password
  /// reveal/fill/delete/import so a valid session never skips the Face ID UI.
  /// Returns false on fail/cancel; callers must not expose or change secrets.
  Future<bool> ensureUnlocked({
    String reason = defaultReason,
    bool freshFaceId = false,
  }) async {
    if (!freshFaceId && isSessionValid) return true;
    final ok = await CheAccountBridge.authenticate(
      reason: reason,
      requireFaceId: freshFaceId,
    );
    if (ok) {
      _unlockedUntil = DateTime.now().add(sessionTtl);
    }
    return ok;
  }
}
