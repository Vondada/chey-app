// Face ID gate for CHE's on-device password vault.
//
// Before vault secrets are filled into a page or spoken/shown, the owner must
// pass Apple's LocalAuthentication via CheAccountBridge.authenticate. Ordinary
// account-vault browsing may reuse a short in-memory session, but password
// reveal/fill/delete/import callers can force a fresh Face ID check each time.
// Face templates never enter Flutter or leave the iPhone. The Keychain item
// itself also needs a Face ID match to read (see the native bridge), so this
// gate is not the only protection.

import 'package:flutter/foundation.dart' show visibleForTesting;

import '../che_account_bridge.dart';

/// What the owner is unlocking. Each action gets its own Face ID wording, so the system sheet says what it is for.
enum VaultAction {
  fill('fill your saved login'),
  reveal('show a saved password'),
  delete('delete a saved password'),
  importPasswords('import passwords'),
  signIn('sign you in'),
  generic('unlock your password vault');

  const VaultAction(this.phrase);
  final String phrase;
}

/// Biometric one-time gate + session TTL for vault fill / reveal.
class CheVaultAuth {
  CheVaultAuth._();
  static final CheVaultAuth instance = CheVaultAuth._();

  /// Successful Face ID unlock lasts this long without re-prompting.
  /// Configurable constant (5–15 minutes per product guidance).
  static const Duration sessionTtl = Duration(minutes: 10);

  /// After this many failed or cancelled attempts in a row, prompts pause for [cooldown].
  static const int maxFailures = 3;
  static const Duration cooldown = Duration(seconds: 30);

  static const String defaultReason =
      'Unlock CHE password vault with Face ID to fill or show a saved login';

  DateTime? _unlockedUntil;
  int _failures = 0;
  DateTime? _coolingUntil;

  /// Called with a short event name (for example `unlocked`, `failed`, `cooldown`, `locked`). Never carries a secret.
  void Function(String event)? onAudit;

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

  /// Time left before prompts resume after too many failures, or [Duration.zero] when they are allowed.
  Duration get cooldownRemaining {
    final until = _coolingUntil;
    if (until == null) return Duration.zero;
    final left = until.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  /// The line shown and spoken before the system Face ID sheet appears. It names the action, the site or account
  /// when known, and how long the approval lasts, so the owner knows what they are approving.
  static String prePrompt(VaultAction action, {String? target}) =>
      'Face ID will ${_what(action, target)}. The approval lasts ${sessionTtl.inMinutes} minutes.';

  /// The text on the system Face ID sheet: the same action and target the pre-prompt names.
  static String reasonFor(VaultAction action, {String? target}) => 'Use Face ID to ${_what(action, target)}';

  static String _what(VaultAction action, String? target) {
    final named = target?.trim() ?? '';
    return named.isEmpty ? action.phrase : '${action.phrase} for $named';
  }

  /// Clears the in-memory unlock (does not delete vault entries).
  void lock() {
    if (_unlockedUntil != null) onAudit?.call('locked');
    _unlockedUntil = null;
  }

  /// Call when the app leaves the foreground: the session must not survive a background switch.
  void onAppBackgrounded() => lock();

  @visibleForTesting
  void debugSetUnlockedUntil(DateTime? until) {
    _unlockedUntil = until;
  }

  @visibleForTesting
  void debugReset() {
    _unlockedUntil = null;
    _failures = 0;
    _coolingUntil = null;
  }

  /// Ensures the owner is authenticated. Set [freshFaceId] for any password
  /// reveal/fill/delete/import so a valid session never skips the Face ID UI.
  /// Returns false on fail/cancel; callers must not expose or change secrets.
  Future<bool> ensureUnlocked({
    String reason = defaultReason,
    bool freshFaceId = false,
    VaultAction action = VaultAction.generic,
    String? target,
  }) async {
    if (!freshFaceId && isSessionValid) return true;
    if (cooldownRemaining > Duration.zero) {
      onAudit?.call('cooldown');
      return false;
    }
    final ok = await CheAccountBridge.authenticate(
      reason: reason == defaultReason && action != VaultAction.generic ? reasonFor(action, target: target) : reason,
      requireFaceId: freshFaceId,
    );
    if (ok) {
      _failures = 0;
      _coolingUntil = null;
      _unlockedUntil = DateTime.now().add(sessionTtl);
      onAudit?.call('unlocked');
    } else {
      _failures += 1;
      onAudit?.call('failed');
      if (_failures >= maxFailures) {
        _failures = 0;
        _coolingUntil = DateTime.now().add(cooldown);
        onAudit?.call('cooldown');
      }
    }
    return ok;
  }
}
