import 'package:chey/self_update/che_mobile_update.dart';
import 'package:chey/self_update/che_update_plan.dart';
import 'package:flutter_test/flutter_test.dart';

CheUpdatePlan planFor({
  CheFastPatchState fast = CheFastPatchState.idle,
  CheFullInstallState install = CheFullInstallState.idle,
  bool fullNewer = false,
  bool recoveryBuildAvailable = false,
  bool checking = false,
  bool checkFailed = false,
  bool newestBuildFailed = false,
  String? verifiedLabel,
  String? installedLabel = 'CHE 1.4.1, build 3700',
}) => planCheUpdate(
  fast: fast,
  install: install,
  fullNewer: fullNewer,
  recoveryBuildAvailable: recoveryBuildAvailable,
  fullLabel: 'CHE 1.4.2, build 3800',
  installLabel: 'CHE 1.4.2, build 3800',
  installedLabel: installedLabel,
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
      expect(plan.action, CheUpdateAction.stopWaiting);
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
      expect(plan.detail, contains('"check for updates"'));
      expect(plan.detail.toLowerCase(), isNot(contains('tap')));
      expect(plan.action, CheUpdateAction.checkAgain);
    });

    test('a confirmed install shows once and names the installed build', () {
      final plan = planFor(
        verifiedLabel: 'CHE 1.4.2, build 3800',
        fullNewer: true,
      );
      expect(plan.stage, CheUpdateStage.installed);
      expect(plan.headline, 'Update complete');
      expect(plan.detail, 'CHE 1.4.2, build 3800 is installed.');
    });
  });

  group('checkPendingInstall', () {
    final started = DateTime.utc(2026, 10, 10, 12);

    CheInstallCheck check({
      String? targetVersion = '1.4.1024603585',
      String? targetBuild = '3828969674601',
      DateTime? at,
      String? installedVersion,
      String? installedBuild,
      Duration after = const Duration(minutes: 5),
    }) => checkPendingInstall(
      targetVersion: targetVersion,
      targetBuild: targetBuild,
      startedAt: at ?? started,
      installedVersion: installedVersion,
      installedBuild: installedBuild,
      now: started.add(after),
    );

    test('no pending install means nothing to check', () {
      expect(
        check(targetBuild: null, installedVersion: '1.4.1024603585', installedBuild: '3828969674601'),
        CheInstallCheck.none,
      );
    });

    test('the exact version and build running now are confirmed', () {
      expect(
        check(installedVersion: '1.4.1024603585', installedBuild: '3828969674601'),
        CheInstallCheck.confirmed,
      );
    });

    test('the same build number under another version is not confirmed', () {
      expect(
        check(installedVersion: '1.4.1024480253', installedBuild: '3828969674601'),
        CheInstallCheck.waiting,
      );
    });

    test('an older build still running is waiting, not confirmed', () {
      expect(
        check(installedVersion: '1.4.1024480253', installedBuild: '3812328516001'),
        CheInstallCheck.waiting,
      );
    });

    test('an unreadable running build is waiting, never confirmed', () {
      expect(
        check(installedVersion: null, installedBuild: null),
        CheInstallCheck.waiting,
      );
    });

    test('an old build after the timeout is not confirmed', () {
      expect(
        check(
          installedVersion: '1.4.1024480253',
          installedBuild: '3812328516001',
          after: const Duration(hours: 3),
        ),
        CheInstallCheck.notConfirmed,
      );
    });

    test('a pending install with no start time is not confirmed', () {
      expect(
        checkPendingInstall(
          targetVersion: '1.4.1024603585',
          targetBuild: '3828969674601',
          startedAt: null,
          installedVersion: '1.4.1024480253',
          installedBuild: '3812328516001',
          now: started,
        ),
        CheInstallCheck.notConfirmed,
      );
    });

    test('an older save without a version is compared by build only', () {
      expect(
        check(targetVersion: null, installedVersion: '1.4.1024603585', installedBuild: '3828969674601'),
        CheInstallCheck.confirmed,
      );
    });

    test('a rollback is confirmed when the older build is running', () {
      expect(
        check(
          targetVersion: '1.4.1024480253',
          targetBuild: '3812328516001',
          after: const Duration(minutes: 1),
          installedVersion: '1.4.1024480253',
          installedBuild: '3812328516001',
        ),
        CheInstallCheck.confirmed,
      );
    });
  });

  group('the running build is never guessed', () {
    test('an unreadable running build reads as unknown, not as an old release', () {
      expect(CheInstalledBuild.fromNative(null), isNull);
      expect(CheInstalledBuild.fromNative({'version': '', 'build': '3828969674601'}), isNull);
      expect(CheInstalledBuild.fromNative({'version': '1.4.1024603585'}), isNull);
    });

    test('a real native reply is read exactly', () {
      final build = CheInstalledBuild.fromNative({
        'version': '1.4.1024603585',
        'build': '3828969674601',
      });
      expect(build?.version, '1.4.1024603585');
      expect(build?.build, '3828969674601');
    });

    test('with the running build unknown, the plan never offers Full update ready', () {
      final plan = planFor(fullNewer: true, installedLabel: null);
      expect(plan.stage, CheUpdateStage.checkFailed);
      expect(plan.headline, 'Could not read the installed version');
      expect(plan.action, isNot(CheUpdateAction.installFullBuild));
    });

    test('an unknown installed version offers explicit repair only with a verified release', () {
      final plan = planFor(installedLabel: null, recoveryBuildAvailable: true);
      expect(plan.stage, CheUpdateStage.recoveryReady);
      expect(plan.action, CheUpdateAction.repairFullBuild);
      expect(plan.detail, contains('cannot tell whether this build is newer'));
      expect(plan.headline, isNot('CHE is up to date'));
    });

    test('a failed check blocks recovery even with stale release metadata', () {
      final plan = planFor(installedLabel: null, recoveryBuildAvailable: true, checkFailed: true);
      expect(plan.action, CheUpdateAction.checkAgain);
    });

    test('waiting SideStore takes precedence over repair', () {
      final plan = planFor(installedLabel: null, recoveryBuildAvailable: true, install: CheFullInstallState.waitingForSideStore);
      expect(plan.action, CheUpdateAction.stopWaiting);
    });

    test('a build handed to SideStore and still waiting never offers Update again', () {
      final plan = planFor(
        fullNewer: true,
        install: CheFullInstallState.waitingForSideStore,
        installedLabel: 'CHE 1.4.1024480253, build 3812328516001',
      );
      expect(plan.stage, CheUpdateStage.installing);
      expect(plan.action, CheUpdateAction.stopWaiting);
      expect(plan.action, isNot(CheUpdateAction.installFullBuild));
    });

    test('an install that was not confirmed offers Check again, never Update', () {
      final plan = planFor(
        fullNewer: true,
        install: CheFullInstallState.notConfirmed,
        installedLabel: 'CHE 1.4.1024480253, build 3812328516001',
      );
      expect(plan.stage, CheUpdateStage.installFailed);
      expect(plan.action, CheUpdateAction.checkAgain);
    });

    test('a verified install shows Update complete and no Update button', () {
      final plan = planFor(
        fullNewer: false,
        verifiedLabel: 'CHE 1.4.1024603585, build 3828969674601',
        installedLabel: 'CHE 1.4.1024603585, build 3828969674601',
      );
      expect(plan.stage, CheUpdateStage.installed);
      expect(plan.action, CheUpdateAction.checkAgain);
      expect(plan.action, isNot(CheUpdateAction.installFullBuild));
    });

    test('when the running build is the newest release, no update is offered', () {
      final plan = planFor(
        fullNewer: false,
        installedLabel: 'CHE 1.4.1024603585, build 3828969674601',
      );
      expect(plan.stage, CheUpdateStage.upToDate);
      expect(plan.action, isNot(CheUpdateAction.installFullBuild));
    });

    test('a waiting install says what is running now, in plain words', () {
      final plan = planCheUpdate(
        fast: CheFastPatchState.unavailable,
        install: CheFullInstallState.waitingForSideStore,
        fullNewer: false,
        fullLabel: 'CHE 1.4.1024603585, build 3828969674601',
        installLabel: 'CHE 1.4.1024603585, build 3828969674601',
        installedLabel: 'CHE 1.4.1024480253, build 3812328516001',
        checking: false,
        checkFailed: false,
        newestBuildFailed: false,
        verifiedLabel: null,
      );
      expect(plan.headline, 'Waiting for SideStore');
      expect(plan.detail, contains('CHE is running CHE 1.4.1024480253, build 3812328516001 now.'));
      expect(plan.detail, contains('swipe CHE away'));
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
