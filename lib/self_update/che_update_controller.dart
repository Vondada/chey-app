import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';
import 'package:url_launcher/url_launcher.dart';

import 'che_mobile_update.dart';
import 'che_update_plan.dart';

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
/// result is read from the installed build number on the next launch.
class CheUpdateController extends ChangeNotifier {
  CheUpdateController._();
  static final CheUpdateController instance = CheUpdateController._();

  final ShorebirdUpdater _shorebird = ShorebirdUpdater();
  AppLifecycleListener? _lifecycle;
  String _baseUrl = '';
  DateTime? _lastCheck;
  bool _refreshing = false;
  bool _refreshAgain = false;

  CheInstalledBuild? installed;
  CheMobileUpdateInfo? latest;
  List<CheMobileUpdateInfo> history = const [];
  CheFastPatchState fast = CheFastPatchState.unavailable;
  CheFullInstallState install = CheFullInstallState.idle;
  CheMobileUpdateInfo? installTarget;
  String? verifiedLabel;
  bool checking = false;
  bool checkFailed = false;
  bool newestBuildFailed = false;

  bool get fullNewer {
    final current = installed;
    final candidate = latest;
    return current != null &&
        candidate != null &&
        candidate.isNewerThan(current);
  }

  String get _installedLabel {
    final current = installed;
    return current == null
        ? 'CHE'
        : 'CHE ${current.version}, build ${current.build}';
  }

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

  /// Checks on launch and on every return to CHE, at most every 20 minutes.
  void start() {
    if (_lifecycle != null) return;
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(refresh()));
    unawaited(refresh());
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
      final current = await CheInstalledBuild.read();
      installed = current;
      await _checkPendingInstall(current);
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
  /// The install itself is confirmed later, from the installed build number.
  Future<bool> installFullBuild(CheMobileUpdateInfo target) async {
    installTarget = target;
    verifiedLabel = null;
    try {
      if (!await canLaunchUrl(sideStoreProbeUri)) {
        install = CheFullInstallState.sideStoreMissing;
        notifyListeners();
        return false;
      }
      await _savePending(target.buildNumber);
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

  /// Called when the owner closes the "installed" notice.
  void dismissVerified() {
    if (verifiedLabel == null) return;
    verifiedLabel = null;
    notifyListeners();
  }

  Future<void> _checkPendingInstall(CheInstalledBuild current) async {
    final prefs = await _preferences();
    final outcome = checkPendingInstall(
      targetBuild: prefs?.getString(_pendingBuildKey),
      startedAt: DateTime.tryParse(prefs?.getString(_pendingAtKey) ?? ''),
      installedBuild: current.build,
      now: DateTime.now(),
    );
    switch (outcome) {
      case CheInstallCheck.none:
        // A stopped attempt (SideStore missing, a failed handoff, or an install
        // that was never confirmed) starts over here, so "check for updates"
        // can move past it.
        if (install != CheFullInstallState.waitingForSideStore) {
          install = CheFullInstallState.idle;
        }
        return;
      case CheInstallCheck.waiting:
        install = CheFullInstallState.waitingForSideStore;
        return;
      case CheInstallCheck.confirmed:
        verifiedLabel = _installedLabel;
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

  Future<void> _savePending(String build) async {
    final prefs = await _preferences();
    try {
      await prefs?.setString(_pendingBuildKey, build);
      await prefs?.setString(_pendingAtKey, DateTime.now().toIso8601String());
    } catch (_) {}
  }

  Future<void> _clearPending(SharedPreferences? prefs) async {
    try {
      await prefs?.remove(_pendingBuildKey);
      await prefs?.remove(_pendingAtKey);
    } catch (_) {}
  }
}
