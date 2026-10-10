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
}
