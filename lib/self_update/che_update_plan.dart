// The decisions behind CHE's one-button update. Pure Dart with no Flutter
// imports, so every rule here is tested without a device.
//
// Two lanes:
// - Fast lane: a Shorebird patch for Dart changes. It downloads silently and
//   applies the next time CHE starts. CHE never says it is active before then.
// - Full lane: a new IPA. iOS will not install an app by itself, so SideStore
//   does the install after the owner confirms it there. CHE checks the result
//   the next time it opens, by reading the installed build number.

enum CheFastPatchState { unavailable, idle, downloading, ready, failed }

enum CheFullInstallState {
  idle,
  sideStoreMissing,
  waitingForSideStore,
  failed,
  notConfirmed,
}

enum CheUpdateStage {
  installed,
  installing,
  sideStoreMissing,
  installFailed,
  fullReady,
  recoveryReady,
  fastDownloading,
  fastReady,
  checking,
  checkFailed,
  upToDate,
}

enum CheUpdateAction { none, installFullBuild, repairFullBuild, explainRestart, checkAgain, stopWaiting }

class CheUpdatePlan {
  const CheUpdatePlan({
    required this.stage,
    required this.headline,
    required this.detail,
    this.showProgress = false,
    this.action = CheUpdateAction.none,
  });

  final CheUpdateStage stage;
  final String headline;
  final String detail;
  final bool showProgress;
  final CheUpdateAction action;

  /// What CHE says aloud when this stage settles.
  String get spoken => '$headline. $detail';
}

CheUpdatePlan planCheUpdate({
  required CheFastPatchState fast,
  required CheFullInstallState install,
  required bool fullNewer,
  bool recoveryBuildAvailable = false,
  required String fullLabel,
  required String installLabel,
  // Null when the running build could not be read. Then CHE never claims an
  // install is missing, and never compares against a guessed build.
  required String? installedLabel,
  required bool checking,
  required bool checkFailed,
  required bool newestBuildFailed,
  required String? verifiedLabel,
}) {
  // A pending install that is now confirmed is shown once, then cleared.
  if (verifiedLabel != null) {
    return CheUpdatePlan(
      stage: CheUpdateStage.installed,
      headline: 'Update complete',
      detail: '$verifiedLabel is installed.',
      action: CheUpdateAction.checkAgain,
    );
  }
  switch (install) {
    case CheFullInstallState.waitingForSideStore:
      return CheUpdatePlan(
        stage: CheUpdateStage.installing,
        headline: 'Waiting for SideStore',
        detail:
            'Confirm the install of $installLabel in SideStore. ${installedLabel == null ? 'CHE could not read the build it is running.' : 'CHE is running $installedLabel now.'} CHE checks again each time it opens. If the new build still does not show, swipe CHE away in the app switcher and open it again. If SideStore showed an error, press Stop waiting.',
        showProgress: true,
        action: CheUpdateAction.stopWaiting,
      );
    case CheFullInstallState.sideStoreMissing:
      return const CheUpdatePlan(
        stage: CheUpdateStage.sideStoreMissing,
        headline: 'SideStore is needed',
        detail: 'SideStore is not on this iPhone, so CHE cannot install the full update. Install SideStore once, then try again. CHE is unchanged.',
        action: CheUpdateAction.checkAgain,
      );
    case CheFullInstallState.failed:
      return const CheUpdatePlan(
        stage: CheUpdateStage.installFailed,
        headline: 'The install did not start',
        detail: 'SideStore did not open. CHE is unchanged.',
        action: CheUpdateAction.checkAgain,
      );
    case CheFullInstallState.notConfirmed:
      return CheUpdatePlan(
        stage: CheUpdateStage.installFailed,
        headline: 'The install was not confirmed',
        detail: installedLabel == null
            ? 'CHE could not read the build it is running. Say "check for updates" to try again.'
            : '$installedLabel is still running. Say "check for updates" to try again.',
        action: CheUpdateAction.checkAgain,
      );
    case CheFullInstallState.idle:
      break;
  }
  // A newer release is only offered against a build CHE could read. An unknown
  // running build falls through to the "could not read" stage below.
  if (fullNewer && installedLabel != null) {
    return CheUpdatePlan(
      stage: CheUpdateStage.fullReady,
      headline: 'Full update ready',
      detail: '$fullLabel. SideStore installs it, and you confirm there.',
      action: CheUpdateAction.installFullBuild,
    );
  }
  if (installedLabel == null && recoveryBuildAvailable &&
      !checkFailed && !newestBuildFailed) {
    return CheUpdatePlan(
      stage: CheUpdateStage.recoveryReady,
      headline: 'Repair CHE installation',
      detail: 'CHE cannot identify the installed version. A verified release is available: $fullLabel. You can reinstall it through SideStore to restore the native voice and update checks. CHE cannot tell whether this build is newer until it can read the installed version.',
      action: CheUpdateAction.repairFullBuild,
    );
  }
  if (fast == CheFastPatchState.downloading) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.fastDownloading,
      headline: 'Downloading CHE update',
      detail: 'CHE keeps running as it is until the download finishes.',
      showProgress: true,
    );
  }
  if (fast == CheFastPatchState.ready) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.fastReady,
      headline: 'Update ready',
      detail:
          'Reopen CHE to finish. The update applies the next time CHE starts.',
      action: CheUpdateAction.explainRestart,
    );
  }
  if (checking) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.checking,
      headline: 'Checking for updates',
      detail: 'This takes a few seconds.',
      showProgress: true,
    );
  }
  if (installedLabel == null) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.checkFailed,
      headline: 'Could not read the installed version',
      detail:
          'CHE could not tell which build is running, so it will not offer an install. Say "check for updates" to try again.',
      action: CheUpdateAction.checkAgain,
    );
  }
  if (checkFailed) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.checkFailed,
      headline: 'Could not check for updates',
      detail: 'CHE is unchanged. Try again when you have a connection.',
      action: CheUpdateAction.checkAgain,
    );
  }
  if (newestBuildFailed) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.checkFailed,
      headline: 'The newest build failed',
      detail: 'Your current CHE is still safe.',
      action: CheUpdateAction.checkAgain,
    );
  }
  if (fast == CheFastPatchState.failed) {
    return const CheUpdatePlan(
      stage: CheUpdateStage.checkFailed,
      headline: 'The update did not finish',
      detail: 'CHE is unchanged. It will try again the next time it checks.',
      action: CheUpdateAction.checkAgain,
    );
  }
  return CheUpdatePlan(
    stage: CheUpdateStage.upToDate,
    headline: 'CHE is up to date',
    detail: 'Installed: $installedLabel.',
    action: CheUpdateAction.checkAgain,
  );
}

/// The line the Updates screen always shows, so the owner can confirm which
/// version, build and patch this iPhone is running. A patch applies only after
/// CHE restarts, so this names the patch actually running, not one downloaded.
String cheInstalledSummary({
  required String? installedLabel,
  required int? patchNumber,
  required bool patchesAvailable,
}) {
  if (installedLabel == null) {
    return 'Installed: unknown. CHE could not read the build it is running.';
  }
  if (!patchesAvailable) return 'Installed: $installedLabel.';
  return 'Installed: $installedLabel, ${patchNumber == null ? 'no patch yet' : 'patch $patchNumber'}.';
}

enum CheInstallCheck { none, waiting, confirmed, notConfirmed }

/// Decides whether a SideStore install that CHE handed off has happened.
///
/// It compares the version and build that are running now with the release CHE
/// asked SideStore for, and both must match. A missing reading never matches.
/// It never assumes success: until they match the install is waiting, and
/// after [timeout] it is reported as not confirmed. A saved target without a
/// version (an older save) is compared by build only.
CheInstallCheck checkPendingInstall({
  required String? targetVersion,
  required String? targetBuild,
  required DateTime? startedAt,
  required String? installedVersion,
  required String? installedBuild,
  required DateTime now,
  Duration timeout = const Duration(hours: 2),
}) {
  if (targetBuild == null || targetBuild.isEmpty) return CheInstallCheck.none;
  final versionMatches = targetVersion == null || targetVersion.isEmpty
      ? true
      : installedVersion == targetVersion;
  if (installedBuild != null &&
      installedBuild == targetBuild &&
      versionMatches) {
    return CheInstallCheck.confirmed;
  }
  if (startedAt == null || now.difference(startedAt) > timeout) {
    return CheInstallCheck.notConfirmed;
  }
  return CheInstallCheck.waiting;
}

/// Probe for canLaunchUrl. The scheme must be listed in LSApplicationQueriesSchemes.
final Uri sideStoreProbeUri = Uri.parse('sidestore://install');

/// SideStore's documented install link. Uri encodes the IPA URL for us.
Uri sideStoreInstallUri(String ipaUrl) =>
    Uri(scheme: 'sidestore', host: 'install', queryParameters: {'url': ipaUrl});
