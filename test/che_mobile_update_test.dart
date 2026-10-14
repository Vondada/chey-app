import 'package:flutter_test/flutter_test.dart';
import 'package:chey/self_update/che_mobile_update.dart';

void main() {
  test('mobile update metadata parses and compares full builds', () {
    final update = CheMobileUpdateInfo.fromJson({
      'version': '1.4.5',
      'build_number': '1200002',
      'commit_sha': 'abc',
      'build_date': '2026-10-01T05:00:00Z',
      'download_url': 'https://che.example/api/update/download/latest',
      'sha256': 'feedface',
      'size': 123,
      'release_notes': 'Fix voice.',
      'sidestore_install_url':
          'sidestore://install?url=https%3A%2F%2Fche.example%2Fipa',
      'sidestore_source_url':
          'sidestore://source?url=https%3A%2F%2Fche.example%2Fsource',
      'shorebird_base': true,
    });

    expect(update.valid, isTrue);
    expect(update.shorebirdBase, isTrue);
    expect(update.isNewerThan(const CheInstalledBuild('1.4.5', '1200001')),
        isTrue);
    expect(update.isNewerThan(const CheInstalledBuild('1.4.5', '1200002')),
        isFalse);
  });

  test('semantic version comparison does not use string ordering', () {
    expect(CheMobileUpdateInfo.compareVersion('1.10.0', '1.9.9'), greaterThan(0));
    expect(CheMobileUpdateInfo.compareVersion('2.0.0', '10.0.0'), lessThan(0));
    expect(CheMobileUpdateInfo.compareVersion('1.4.5', '1.4.5'), 0);
  });

  test('cross-pipeline IPA versions are newer than the installed Codemagic build', () {
    final latest = CheMobileUpdateInfo.fromJson({
      'version': '1.4.1024200000',
      'build_number': '3769039753601',
      'download_url': 'https://che.example/api/update/download/latest',
    });
    expect(latest.isNewerThan(const CheInstalledBuild('1.4.1000371', '19000371')), isTrue);
    expect(latest.isNewerThan(const CheInstalledBuild('1.4.1000337', '19000337')), isTrue);
    expect(latest.isNewerThan(const CheInstalledBuild('1.4.1024200000', '3769039753601')), isFalse);
    expect(latest.isNewerThan(const CheInstalledBuild('1.4.1024200000', '3769039753700')), isFalse);
    expect(latest.isNewerThan(const CheInstalledBuild('1.4.1024200000', 'invalid')), isFalse);
  });

  group('readLatestBuild', () {
    const published =
        '{"ok":true,"version":"1.4.2","build_number":"3800",'
        '"download_url":"https://che.example/api/update/download/latest",'
        '"latest_attempt":{"state":"success"}}';

    test('a published build is the latest build', () {
      final read = readLatestBuild(200, published);
      expect(read.latest?.buildNumber, '3800');
      expect(read.newestBuildFailed, isFalse);
    });

    test(
      'a failed newest build is reported as failed, never as up to date',
      () {
        final read = readLatestBuild(
          503,
          '{"ok":false,"detail":"The newest CHE mobile build failed.","latest_attempt":{"state":"failure"}}',
        );
        expect(read.latest, isNull);
        expect(read.newestBuildFailed, isTrue);
      },
    );

    test(
      'an outage with no usable build throws so the check counts as failed',
      () {
        expect(
          () => readLatestBuild(503, 'unavailable'),
          throwsFormatException,
        );
        expect(
          () => readLatestBuild(503, '{"ok":false}'),
          throwsFormatException,
        );
      },
    );

    test(
      'a 200 without a valid build throws instead of reporting up to date',
      () {
        expect(
          () => readLatestBuild(200, '{"ok":true}'),
          throwsFormatException,
        );
      },
    );
  });

  group('canHandOffInstall', () {
    const running = CheInstalledBuild('1.4.1024603585', '3828969674601');
    const newer = CheMobileUpdateInfo(
      version: '1.4.1024610000', buildNumber: '3830000000000', commitSha: '', buildDate: '',
      downloadUrl: 'https://example.invalid/a.ipa', sha256: '', size: 0, releaseNotes: '', shorebirdBase: false,
    );
    const older = CheMobileUpdateInfo(
      version: '1.4.1024480253', buildNumber: '3812328516001', commitSha: '', buildDate: '',
      downloadUrl: 'https://example.invalid/b.ipa', sha256: '', size: 0, releaseNotes: '', shorebirdBase: false,
    );
    const same = CheMobileUpdateInfo(
      version: '1.4.1024603585', buildNumber: '3828969674601', commitSha: '', buildDate: '',
      downloadUrl: 'https://example.invalid/c.ipa', sha256: '', size: 0, releaseNotes: '', shorebirdBase: false,
    );

    test('a normal update is handed off only when newer', () {
      expect(canHandOffInstall(installed: running, target: newer), isTrue);
      expect(canHandOffInstall(installed: running, target: older), isFalse);
      expect(canHandOffInstall(installed: running, target: same), isFalse);
    });

    test('a rollback to an earlier verified build is handed off', () {
      expect(canHandOffInstall(installed: running, target: older, rollback: true), isTrue);
    });

    test('a rollback never targets the running build or a newer one', () {
      expect(canHandOffInstall(installed: running, target: same, rollback: true), isFalse);
      expect(canHandOffInstall(installed: running, target: newer, rollback: true), isFalse);
    });

    test('recovery requires unknown build, valid HTTPS metadata and a digest', () {
      const repairRelease = CheMobileUpdateInfo(
        version: '1.4.1024725360', buildNumber: '3850966980301',
        commitSha: 'abc', buildDate: '',
        downloadUrl: 'https://example.invalid/com.cheyapp.chey.ipa',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size: 0, releaseNotes: '', shorebirdBase: false,
      );
      expect(canHandOffInstall(installed: null, target: repairRelease), isFalse);
      expect(canHandOffInstall(installed: null, target: repairRelease, repair: true), isTrue);
      expect(canHandOffInstall(installed: running, target: repairRelease, repair: true), isFalse);
      expect(canHandOffInstall(installed: null, target: repairRelease, repair: true, rollback: true), isFalse);
      expect(canHandOffInstall(installed: null, target: newer, repair: true), isFalse);
    });

    test('an unknown running build hands off nothing, even a rollback', () {
      expect(canHandOffInstall(installed: null, target: older), isFalse);
      expect(canHandOffInstall(installed: null, target: older, rollback: true), isFalse);
    });
  });
}
