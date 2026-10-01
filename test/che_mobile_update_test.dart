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
}
