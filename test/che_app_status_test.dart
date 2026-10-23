import 'package:chey/self_update/che_mobile_update.dart';
import 'package:chey/self_update/che_self_update_intent.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('che/native_shell');
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  test('native bundle metadata is read through the existing device channel', () async {
    final calls = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return {'version': '1.4.5678', 'build': '123456'};
    });
    final installed = await CheInstalledBuild.read();
    expect(calls, ['appVersion']);
    final report = installed!.chatMetadata();
    expect(report['version'], '1.4.5678');
    expect(report['build'], '123456');
    expect(report['source'], 'ios_bundle');
    expect(DateTime.tryParse(report['checked_at']!), isNotNull);
  });

  test('unavailable native source returns no installed build', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => throw PlatformException(code: 'unavailable'));
    expect(await CheInstalledBuild.read(), isNull);
  });

  test('status requests cannot fall through to offline model and Settings uses actual details page', () {
    for (final phrase in ['What version of CHE am I running?', 'What’s my installed build number?', 'What backend version are you connected to?', 'Open Settings and show my app version.', 'What GitHub commit is deployed?']) {
      expect(cheIsAppStatusRequest(phrase), isTrue, reason: phrase);
    }
    expect(cheOpensAppVersion('Open Settings and show my app version.'), isTrue);
    expect(cheIsAppStatusRequest('Deploy a new version of CHE'), isFalse);
    expect(cheIsAppStatusRequest('Install app version 9'), isFalse);
    expect(cheIsAppStatusRequest('What commit added the app status tests?'), isFalse);
    expect(cheIsAppStatusRequest('What version of the CHE app added Rithmic?'), isFalse);
    expect(cheIsAppStatusRequest('What version was running when Rithmic was added?'), isFalse);
    expect(cheIsAppStatusRequest('What deployed commit added Rithmic?'), isFalse);
  });
}
