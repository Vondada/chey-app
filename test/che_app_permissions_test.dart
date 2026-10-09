import 'package:chey/security/che_app_permissions.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('granted() is empty before the owner grants anything', () async {
    expect(await CheAppPermissions.granted(), isEmpty);
  });

  test('grant() stores the app as a lowercase name', () async {
    final granted = await CheAppPermissions.grant('Notes');
    expect(granted, contains('notes'));
    // A fresh read comes from the same SharedPreferences store, so the
    // grant survives past the call that wrote it.
    expect(await CheAppPermissions.granted(), contains('notes'));
  });

  test('granting the same app twice does not duplicate it', () async {
    await CheAppPermissions.grant('Notes');
    final granted = await CheAppPermissions.grant('notes');
    expect(granted, {'notes'});
    expect(await CheAppPermissions.granted(), {'notes'});
  });

  test('grant() trims the padding spoken around a name', () async {
    final granted = await CheAppPermissions.grant('  Spotify  ');
    expect(granted, contains('spotify'));
    expect(await CheAppPermissions.granted(), contains('spotify'));
  });
}
