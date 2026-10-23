// CHE trading alerts (owner, 2026-10-23, items 4 and 15): one alert center for setups, the CHE paper
// account and risk thresholds.
//
// - Every alert is visible (a banner the Trading Room shows, with a screen-reader label) and gets a
//   haptic pattern when that type's haptic is on.
// - Sound and speech only for alert types the owner turned audible. Out of the box nothing speaks:
//   per AGENTS.md CHE stays silent on passive status unless the owner asks.
// - Each type can be disabled, muted or customized (the near-entry distance), and everything is kept
//   in SharedPreferences. A master mute silences every alert without losing the settings.
// - Each alert that is raised is also written to the audit trail (che_trade_audit.dart).
//
// The paper-account lane raises paperOpened/paperAdjusted/paperTarget/paperStop/riskLimit/
// balanceThreshold/drawdownThreshold/dailyLossThreshold through [CheTradeAlerts.raise].
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'che_trade_audit.dart';

enum CheAlertType {
  setupStage,
  setupNearEntry,
  setupReady,
  setupInvalidated,
  paperOpened,
  paperAdjusted,
  paperTarget,
  paperStop,
  riskLimit,
  balanceThreshold,
  drawdownThreshold,
  dailyLossThreshold,
}

extension CheAlertTypeText on CheAlertType {
  String get label => switch (this) {
        CheAlertType.setupStage => 'Setup moved to a new stage',
        CheAlertType.setupNearEntry => 'Setup near its planned entry',
        CheAlertType.setupReady => 'Setup ready',
        CheAlertType.setupInvalidated => 'Setup invalidated',
        CheAlertType.paperOpened => 'CHE opened a paper trade',
        CheAlertType.paperAdjusted => 'CHE moved a stop or target',
        CheAlertType.paperTarget => 'CHE paper trade reached its target',
        CheAlertType.paperStop => 'CHE paper trade reached its stop',
        CheAlertType.riskLimit => 'Position near a risk limit',
        CheAlertType.balanceThreshold => 'Balance threshold reached',
        CheAlertType.drawdownThreshold => 'Drawdown threshold reached',
        CheAlertType.dailyLossThreshold => 'Daily loss threshold reached',
      };

  /// Haptic pulses: more for things that need attention.
  int get pulses => switch (this) {
        CheAlertType.setupReady || CheAlertType.paperOpened => 2,
        CheAlertType.paperStop || CheAlertType.riskLimit || CheAlertType.drawdownThreshold || CheAlertType.dailyLossThreshold => 3,
        _ => 1,
      };
}

/// One alert type's settings.
class CheAlertPref {
  const CheAlertPref({this.enabled = true, this.audible = false, this.haptic = true});
  final bool enabled, audible, haptic;

  CheAlertPref copyWith({bool? enabled, bool? audible, bool? haptic}) =>
      CheAlertPref(enabled: enabled ?? this.enabled, audible: audible ?? this.audible, haptic: haptic ?? this.haptic);

  Map<String, dynamic> toJson() => {'enabled': enabled, 'audible': audible, 'haptic': haptic};
  static CheAlertPref fromJson(Object? j) =>
      j is Map ? CheAlertPref(enabled: j['enabled'] != false, audible: j['audible'] == true, haptic: j['haptic'] != false) : const CheAlertPref();
}

class CheTradeAlert {
  const CheTradeAlert({required this.type, required this.title, required this.message, required this.account, required this.at, this.data = const {}});
  final CheAlertType type;
  final String title, message, account;
  final DateTime at;
  final Map<String, dynamic> data;

  /// What VoiceOver reads and what speech says when the type is audible.
  String get spoken => '$account. $title. $message';
}

class CheTradeAlerts extends ChangeNotifier {
  CheTradeAlerts({CheTradeAudit? audit, DateTime Function()? clock, Future<void> Function(int pulses)? haptic, Future<SharedPreferences> Function()? prefs})
      : _audit = audit ?? CheTradeAudit.instance,
        _clock = clock ?? DateTime.now,
        _haptic = haptic ?? _defaultHaptic,
        _prefs = prefs ?? SharedPreferences.getInstance;

  static final instance = CheTradeAlerts();
  static const _key = 'che_trade_alert_prefs_v1';

  final CheTradeAudit _audit;
  final DateTime Function() _clock;
  final Future<void> Function(int pulses) _haptic;
  final Future<SharedPreferences> Function() _prefs;

  /// Speech for audible alerts. The Trading Room sets this to CHE's voice; null means no sound.
  Future<void> Function(String text)? speak;

  final Map<CheAlertType, CheAlertPref> _settings = {};
  bool _muted = false;
  double _nearEntryPoints = 5;
  bool _loaded = false;

  /// Newest first; the banner shows the first. Kept short.
  final List<CheTradeAlert> recent = [];
  final _raised = StreamController<CheTradeAlert>.broadcast();
  Stream<CheTradeAlert> get raised => _raised.stream;

  bool get muted => _muted;

  /// How close (index points) counts as "near the planned entry".
  double get nearEntryPoints => _nearEntryPoints;
  CheAlertPref pref(CheAlertType t) => _settings[t] ?? const CheAlertPref();

  static Future<void> _defaultHaptic(int pulses) async {
    for (var i = 0; i < pulses; i++) {
      await HapticFeedback.mediumImpact();
      if (i + 1 < pulses) await Future<void>.delayed(const Duration(milliseconds: 140));
    }
  }

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final raw = (await _prefs()).getString(_key);
      if (raw == null) return;
      final j = jsonDecode(raw);
      if (j is! Map) return;
      _muted = j['muted'] == true;
      final near = j['near_entry_points'];
      if (near is num && near > 0) _nearEntryPoints = near.toDouble();
      final types = j['types'];
      if (types is Map) {
        for (final t in CheAlertType.values) {
          if (types.containsKey(t.name)) _settings[t] = CheAlertPref.fromJson(types[t.name]);
        }
      }
    } catch (_) {}
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      await (await _prefs()).setString(
          _key,
          jsonEncode({
            'muted': _muted,
            'near_entry_points': _nearEntryPoints,
            'types': {for (final e in _settings.entries) e.key.name: e.value.toJson()},
          }));
    } catch (_) {}
  }

  Future<void> setPref(CheAlertType t, CheAlertPref p) async {
    await load();
    _settings[t] = p;
    notifyListeners();
    await _save();
  }

  Future<void> setMuted(bool v) async {
    await load();
    _muted = v;
    notifyListeners();
    await _save();
  }

  Future<void> setNearEntryPoints(double v) async {
    await load();
    if (v <= 0 || !v.isFinite) return;
    _nearEntryPoints = v;
    notifyListeners();
    await _save();
  }

  /// Raises an alert. Returns it, or null when that type is disabled. A disabled type is still
  /// audited as suppressed so the trail is complete.
  Future<CheTradeAlert?> raise(CheAlertType type, {required String title, required String message, required String account, Map<String, dynamic> data = const {}}) async {
    await load();
    final p = pref(type);
    final alert = CheTradeAlert(type: type, title: title, message: message, account: account, at: _clock(), data: data);
    unawaited(_audit.append('alert', account: account, data: {'type': type.name, 'title': title, 'message': message, 'shown': p.enabled, 'audible': p.enabled && p.audible && !_muted, ...data}));
    if (!p.enabled) return null;
    recent.insert(0, alert);
    if (recent.length > 30) recent.removeRange(30, recent.length);
    _raised.add(alert);
    notifyListeners();
    if (_muted) return alert;
    if (p.haptic) unawaited(_haptic(type.pulses).catchError((_) {}));
    final say = speak;
    if (p.audible && say != null) unawaited(say(alert.spoken).catchError((_) {}));
    return alert;
  }

  void dismiss(CheTradeAlert a) {
    recent.remove(a);
    notifyListeners();
  }
}
