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
  fastDownloading,
  fastReady,
  checking,
  checkFailed,
  upToDate,
}

enum CheUpdateAction { none, installFullBuild, explainRestart, checkAgain }

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
  required String fullLabel,
  required String installLabel,
  required String installedLabel,
  required bool checking,
  required bool checkFailed,
  required bool newestBuildFailed,
  required String? verifiedLabel,
}) {
  // A pending install that is now confirmed is shown once, then cleared.
  if (verifiedLabel != null) {
    return CheUpdatePlan(
      stage: CheUpdateStage.installed,
      headline: 'CHE is updated',
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
            'SideStore is open. Confirm the install of $installLabel there. CHE checks the result when it next opens.',
        showProgress: true,
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
        detail: '$installedLabel is still running. Tap Update to try again.',
        action: CheUpdateAction.checkAgain,
      );
    case CheFullInstallState.idle:
      break;
  }
  if (fullNewer) {
    return CheUpdatePlan(
      stage: CheUpdateStage.fullReady,
      headline: 'Full update ready',
      detail: '$fullLabel. SideStore installs it, and you confirm there.',
      action: CheUpdateAction.installFullBuild,
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

enum CheInstallCheck { none, waiting, confirmed, notConfirmed }

/// Decides whether a SideStore install that CHE handed off has happened.
///
/// It compares the build that is running now with the build CHE asked for.
/// It never assumes success: until the build matches, the install is waiting,
/// and after [timeout] it is reported as not confirmed.
CheInstallCheck checkPendingInstall({
  required String? targetBuild,
  required DateTime? startedAt,
  required String installedBuild,
  required DateTime now,
  Duration timeout = const Duration(hours: 2),
}) {
  if (targetBuild == null || targetBuild.isEmpty) return CheInstallCheck.none;
  if (installedBuild == targetBuild) return CheInstallCheck.confirmed;
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
