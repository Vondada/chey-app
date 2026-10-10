import 'package:chey/self_update/che_update_plan.dart';
import 'package:flutter_test/flutter_test.dart';

CheUpdatePlan planFor({
  CheFastPatchState fast = CheFastPatchState.idle,
  CheFullInstallState install = CheFullInstallState.idle,
  bool fullNewer = false,
  bool checking = false,
  bool checkFailed = false,
  bool newestBuildFailed = false,
  String? verifiedLabel,
}) => planCheUpdate(
  fast: fast,
  install: install,
  fullNewer: fullNewer,
  fullLabel: 'CHE 1.4.2, build 3800',
  installLabel: 'CHE 1.4.2, build 3800',
  installedLabel: 'CHE 1.4.1, build 3700',
  checking: checking,
  checkFailed: checkFailed,
  newestBuildFailed: newestBuildFailed,
  verifiedLabel: verifiedLabel,
);

void main() {
  group('planCheUpdate', () {
    test('a newer full build is ready to install with one Update action', () {
      final plan = planFor(fullNewer: true);
      expect(plan.stage, CheUpdateStage.fullReady);
      expect(plan.action, CheUpdateAction.installFullBuild);
      expect(plan.detail, contains('CHE 1.4.2, build 3800'));
    });

    test('a full build outranks a staged patch', () {
      final plan = planFor(fullNewer: true, fast: CheFastPatchState.ready);
      expect(plan.stage, CheUpdateStage.fullReady);
    });

    test('a staged patch says to reopen CHE and never claims it is active', () {
      final plan = planFor(fast: CheFastPatchState.ready);
      expect(plan.stage, CheUpdateStage.fastReady);
      expect(plan.action, CheUpdateAction.explainRestart);
      expect(plan.detail, contains('Reopen CHE'));
      expect(plan.detail.toLowerCase(), isNot(contains('installed')));
      expect(plan.detail.toLowerCase(), isNot(contains('active')));
      expect(plan.headline.toLowerCase(), isNot(contains('updated')));
    });

    test('a downloading patch shows progress and no action', () {
      final plan = planFor(fast: CheFastPatchState.downloading);
      expect(plan.stage, CheUpdateStage.fastDownloading);
      expect(plan.showProgress, isTrue);
      expect(plan.action, CheUpdateAction.none);
    });

    test('nothing new reports up to date with the installed build', () {
      final plan = planFor();
      expect(plan.stage, CheUpdateStage.upToDate);
      expect(plan.headline, 'CHE is up to date');
      expect(plan.detail, contains('CHE 1.4.1, build 3700'));
    });

    test('a check in progress shows progress', () {
      final plan = planFor(checking: true);
      expect(plan.stage, CheUpdateStage.checking);
      expect(plan.showProgress, isTrue);
    });

    test('a failed check is never reported as up to date', () {
      final plan = planFor(checkFailed: true);
      expect(plan.stage, CheUpdateStage.checkFailed);
      expect(plan.headline, isNot('CHE is up to date'));
      expect(plan.action, CheUpdateAction.checkAgain);
    });

    test('a failed newest build says the current CHE is safe', () {
      final plan = planFor(newestBuildFailed: true);
      expect(plan.stage, CheUpdateStage.checkFailed);
      expect(plan.detail, contains('still safe'));
    });

    test('a failed patch download says CHE is unchanged', () {
      final plan = planFor(fast: CheFastPatchState.failed);
      expect(plan.stage, CheUpdateStage.checkFailed);
      expect(plan.detail, contains('CHE is unchanged'));
    });

    test('a waiting SideStore install shows progress and names the build', () {
      final plan = planFor(
        install: CheFullInstallState.waitingForSideStore,
        fullNewer: true,
      );
      expect(plan.stage, CheUpdateStage.installing);
      expect(plan.showProgress, isTrue);
      expect(plan.action, CheUpdateAction.none);
      expect(plan.spoken, contains('Waiting for SideStore'));
    });

    test('missing SideStore asks for a one-time install and never mentions a browser', () {
      final plan = planFor(install: CheFullInstallState.sideStoreMissing);
      expect(plan.stage, CheUpdateStage.sideStoreMissing);
      expect(plan.detail, contains('SideStore is not on this iPhone'));
      expect(plan.detail.toLowerCase(), isNot(contains('safari')));
      expect(plan.detail.toLowerCase(), isNot(contains('browser')));
      expect(plan.detail, contains('CHE is unchanged'));
    });

    test('a SideStore handoff that fails says CHE is unchanged', () {
      final plan = planFor(install: CheFullInstallState.failed);
      expect(plan.stage, CheUpdateStage.installFailed);
      expect(plan.detail, contains('CHE is unchanged'));
    });

    test('an install that was never confirmed says so and offers a retry', () {
      final plan = planFor(install: CheFullInstallState.notConfirmed);
      expect(plan.stage, CheUpdateStage.installFailed);
      expect(plan.headline, 'The install was not confirmed');
      expect(plan.detail, contains('CHE 1.4.1, build 3700 is still running'));
      expect(plan.action, CheUpdateAction.checkAgain);
    });

    test('a confirmed install shows once and names the installed build', () {
      final plan = planFor(
        verifiedLabel: 'CHE 1.4.2, build 3800',
        fullNewer: true,
      );
      expect(plan.stage, CheUpdateStage.installed);
      expect(plan.headline, 'CHE is updated');
      expect(plan.detail, 'CHE 1.4.2, build 3800 is installed.');
    });
  });

  group('checkPendingInstall', () {
    final started = DateTime.utc(2026, 10, 10, 12);

    test('no pending install means nothing to check', () {
      expect(
        checkPendingInstall(
          targetBuild: null,
          startedAt: started,
          installedBuild: '3800',
          now: started,
        ),
        CheInstallCheck.none,
      );
    });

    test('the target build running now is confirmed', () {
      expect(
        checkPendingInstall(
          targetBuild: '3800',
          startedAt: started,
          installedBuild: '3800',
          now: started.add(const Duration(minutes: 5)),
        ),
        CheInstallCheck.confirmed,
      );
    });

    test('an old build still running is waiting, not confirmed', () {
      expect(
        checkPendingInstall(
          targetBuild: '3800',
          startedAt: started,
          installedBuild: '3700',
          now: started.add(const Duration(minutes: 5)),
        ),
        CheInstallCheck.waiting,
      );
    });

    test('an old build after the timeout is not confirmed', () {
      expect(
        checkPendingInstall(
          targetBuild: '3800',
          startedAt: started,
          installedBuild: '3700',
          now: started.add(const Duration(hours: 3)),
        ),
        CheInstallCheck.notConfirmed,
      );
    });

    test('a pending install with no start time is not confirmed', () {
      expect(
        checkPendingInstall(
          targetBuild: '3800',
          startedAt: null,
          installedBuild: '3700',
          now: started,
        ),
        CheInstallCheck.notConfirmed,
      );
    });

    test('a rollback is confirmed when the older build is running', () {
      expect(
        checkPendingInstall(
          targetBuild: '3600',
          startedAt: started,
          installedBuild: '3600',
          now: started.add(const Duration(minutes: 1)),
        ),
        CheInstallCheck.confirmed,
      );
    });
  });

  group('SideStore links', () {
    test('the install link carries the IPA URL intact', () {
      const ipa =
          'https://chey-app.example/api/update/download/che-ios-v1?x=1&y=2';
      final uri = sideStoreInstallUri(ipa);
      expect(uri.scheme, 'sidestore');
      expect(uri.host, 'install');
      expect(uri.queryParameters['url'], ipa);
    });

    test('the probe uses the same scheme as the install link', () {
      expect(sideStoreProbeUri.scheme, 'sidestore');
      expect(sideStoreProbeUri.host, 'install');
    });
  });
}
