import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';
import 'package:url_launcher/url_launcher.dart';

import 'che_mobile_update.dart';
import 'che_update_plan.dart';

const _pendingVersionKey = 'che_update_pending_version';
const _pendingBuildKey = 'che_update_pending_build';
const _pendingAtKey = 'che_update_pending_at';
const _recheckAfter = Duration(minutes: 20);

/// The one source of truth for CHE's updates. The top banner and the CHE
/// Updates screen both read it, so a patch is never downloaded twice.
///
/// Fast lane: Shorebird downloads Dart patches in the background. A patch
/// applies only after CHE restarts, and this controller reports it as ready,
/// never as active.
///
/// Full lane: SideStore installs a new IPA after the owner confirms there. The
/// result is read from the running build (version and build number) every time
/// CHE comes back to the front, and it is never assumed.
class CheUpdateController extends ChangeNotifier {
  CheUpdateController._();
  static final CheUpdateController instance = CheUpdateController._();

  final ShorebirdUpdater _shorebird = ShorebirdUpdater();
  AppLifecycleListener? _lifecycle;
  String _baseUrl = '';
  DateTime? _lastCheck;
  bool _refreshing = false;
  bool _refreshAgain = false;

  /// The build this copy is running, or null when iOS would not say.
  CheInstalledBuild? installed;
  /// The Shorebird patch this copy is running, or null for none.
  int? currentPatch;
  CheMobileUpdateInfo? latest;
  List<CheMobileUpdateInfo> history = const [];
  CheFastPatchState fast = CheFastPatchState.unavailable;
  CheFullInstallState install = CheFullInstallState.idle;
  CheMobileUpdateInfo? installTarget;
  String? verifiedLabel;
  bool checking = false;
  bool checkFailed = false;
  bool newestBuildFailed = false;

  /// True only when the running build is known and the newest verified build is
  /// newer. An unknown running build never offers an install.
  bool get fullNewer {
    final current = installed;
    final candidate = latest;
    return current != null &&
        candidate != null &&
        candidate.isNewerThan(current);
  }

  String? get _installedLabel {
    final current = installed;
    return current == null ? null : _labelFor(current);
  }

  static String _labelFor(CheInstalledBuild build) =>
      'CHE ${build.version}, build ${build.build}';

  /// Version, build and running patch, for the Updates screen.
  String get installedSummary => cheInstalledSummary(
    installedLabel: _installedLabel,
    patchNumber: currentPatch,
    patchesAvailable: _shorebird.isAvailable,
  );

  CheUpdatePlan get plan => planCheUpdate(
    fast: fast,
    install: install,
    fullNewer: fullNewer,
    fullLabel: latest?.label ?? '',
    installLabel: installTarget?.label ?? 'CHE',
    installedLabel: _installedLabel,
    checking: checking,
    checkFailed: checkFailed,
    newestBuildFailed: newestBuildFailed,
    verifiedLabel: verifiedLabel,
  );

  /// The build just before the installed one, for the "roll back" voice command.
  CheMobileUpdateInfo? previousVerifiedBuild() {
    final current = installed;
    if (current == null) return null;
    for (final build in history) {
      if (build.buildNumber == current.build) continue;
      if (!build.isNewerThan(current)) return build;
    }
    return null;
  }

  /// Sets the update service address. Refreshes when it changes.
  void configure(String baseUrl) {
    final base = baseUrl.replaceFirst(RegExp(r'/+$'), '');
    if (base == _baseUrl) return;
    _baseUrl = base;
    unawaited(refresh(force: true));
  }

  /// Checks on launch and on every return to CHE. The running build is read at
  /// once on each return; the network and Shorebird checks keep their 20-minute gap.
  void start() {
    if (_lifecycle != null) return;
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_onResume()));
    unawaited(refresh());
  }

  Future<void> _onResume() async {
    await refreshInstalled();
    await refresh();
  }

  /// Reads the running build and settles any pending SideStore install. It is
  /// local only (no network, no Shorebird call), so it runs on every return.
  Future<void> refreshInstalled() async {
    await _readInstalledAndPending();
    notifyListeners();
  }

  Future<void> refresh({bool force = false}) async {
    if (_refreshing) {
      if (force) _refreshAgain = true;
      return;
    }
    final last = _lastCheck;
    if (!force &&
        last != null &&
        DateTime.now().difference(last) < _recheckAfter) {
      return;
    }
    _refreshing = true;
    checking = true;
    // start() and configure() run inside a widget build. Let that build finish
    // before any listener rebuilds, or Flutter rejects the setState.
    await Future<void>.value();
    notifyListeners();
    try {
      await _readInstalledAndPending();
      await _checkFastPatch();
      await _checkFullBuilds();
      _lastCheck = DateTime.now();
    } finally {
      _refreshing = false;
      checking = false;
      notifyListeners();
      if (_refreshAgain) {
        _refreshAgain = false;
        unawaited(refresh(force: true));
      }
    }
  }

  /// Hands a full IPA to SideStore. Returns true only when SideStore opened.
  /// The install itself is confirmed later, from the running build.
  Future<bool> installFullBuild(CheMobileUpdateInfo target, {bool rollback = false}) async {
    if (!canHandOffInstall(installed: installed, target: target, rollback: rollback)) {
      return false;
    }
    installTarget = target;
    verifiedLabel = null;
    try {
      if (!await canLaunchUrl(sideStoreProbeUri)) {
        install = CheFullInstallState.sideStoreMissing;
        notifyListeners();
        return false;
      }
      await _savePending(target.version, target.buildNumber);
      final opened = await launchUrl(
        sideStoreInstallUri(target.downloadUrl),
        mode: LaunchMode.externalApplication,
      );
      if (!opened) {
        await _clearPending(await _preferences());
        install = CheFullInstallState.failed;
        notifyListeners();
        return false;
      }
      install = CheFullInstallState.waitingForSideStore;
      notifyListeners();
      return true;
    } catch (_) {
      await _clearPending(await _preferences());
      install = CheFullInstallState.failed;
      notifyListeners();
      return false;
    }
  }

  /// Stops waiting for a SideStore install that CHE handed off. Used when the
  /// owner reports that SideStore showed an error, so the update can be offered again.
  Future<void> stopWaiting() async {
    if (install != CheFullInstallState.waitingForSideStore) return;
    await _clearPending(await _preferences());
    install = CheFullInstallState.idle;
    notifyListeners();
  }

  /// Called when the owner closes the "installed" notice.
  void dismissVerified() {
    if (verifiedLabel == null) return;
    verifiedLabel = null;
    notifyListeners();
  }

  Future<void> _readInstalledAndPending() async {
    installed = await CheInstalledBuild.read();
    if (_shorebird.isAvailable) {
      try {
        currentPatch = (await _shorebird.readCurrentPatch())?.number;
      } catch (_) {
        currentPatch = null;
      }
    }
    await _checkPendingInstall(installed);
  }

  Future<void> _checkPendingInstall(CheInstalledBuild? current) async {
    final prefs = await _preferences();
    final outcome = checkPendingInstall(
      targetVersion: prefs?.getString(_pendingVersionKey),
      targetBuild: prefs?.getString(_pendingBuildKey),
      startedAt: DateTime.tryParse(prefs?.getString(_pendingAtKey) ?? ''),
      installedVersion: current?.version,
      installedBuild: current?.build,
      now: DateTime.now(),
    );
    switch (outcome) {
      case CheInstallCheck.none:
        // Nothing is pending, so nothing is waiting. A stopped attempt (SideStore
        // missing, a failed handoff, or an install never confirmed) starts over,
        // so "check for updates" can move past it.
        install = CheFullInstallState.idle;
        return;
      case CheInstallCheck.waiting:
        install = CheFullInstallState.waitingForSideStore;
        return;
      case CheInstallCheck.confirmed:
        if (current != null) verifiedLabel = _labelFor(current);
        install = CheFullInstallState.idle;
        await _clearPending(prefs);
        return;
      case CheInstallCheck.notConfirmed:
        install = CheFullInstallState.notConfirmed;
        await _clearPending(prefs);
        return;
    }
  }

  Future<void> _checkFastPatch() async {
    if (!_shorebird.isAvailable) {
      fast = CheFastPatchState.unavailable;
      return;
    }
    // A staged patch stays staged until CHE restarts.
    if (fast == CheFastPatchState.ready) return;
    try {
      var status = await _shorebird.checkForUpdate();
      if (status == UpdateStatus.outdated) {
        fast = CheFastPatchState.downloading;
        notifyListeners();
        await _shorebird.update();
        status = await _shorebird.checkForUpdate();
      }
      final next = await _shorebird.readNextPatch();
      fast = status == UpdateStatus.restartRequired && next != null
          ? CheFastPatchState.ready
          : CheFastPatchState.idle;
    } catch (_) {
      fast = CheFastPatchState.failed;
    }
  }

  Future<void> _checkFullBuilds() async {
    if (_baseUrl.isEmpty) return;
    try {
      final builds = await fetchMobileBuilds(_baseUrl);
      latest = builds.latest;
      history = builds.history;
      newestBuildFailed = builds.newestBuildFailed;
      checkFailed = false;
    } catch (_) {
      checkFailed = true;
    }
  }

  Future<SharedPreferences?> _preferences() async {
    try {
      return await SharedPreferences.getInstance();
    } catch (_) {
      return null;
    }
  }

  Future<void> _savePending(String version, String build) async {
    final prefs = await _preferences();
    try {
      await prefs?.setString(_pendingVersionKey, version);
      await prefs?.setString(_pendingBuildKey, build);
      await prefs?.setString(_pendingAtKey, DateTime.now().toIso8601String());
    } catch (_) {}
  }

  Future<void> _clearPending(SharedPreferences? prefs) async {
    try {
      await prefs?.remove(_pendingVersionKey);
      await prefs?.remove(_pendingBuildKey);
      await prefs?.remove(_pendingAtKey);
    } catch (_) {}
  }
}
