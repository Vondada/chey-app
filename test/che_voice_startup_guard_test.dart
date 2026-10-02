import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('iPhone voice startup waits for loaded session and serializes mic ownership', () {
    final main = File('lib/main.dart').readAsStringSync();
    final security = File('lib/home_state/security.dart').readAsStringSync();
    final voice = File('lib/home_state/voice.dart').readAsStringSync();

    final initStart = main.indexOf('void initState()');
    final initEnd = main.indexOf('// ============================================================', initStart);
    final initBody = main.substring(initStart, initEnd);
    expect(initBody, isNot(contains('_initNativeIosVoice();')));

    final loadStart = security.indexOf('Future<void> _loadSecuritySession()');
    final loadEnd = security.indexOf('\n  Future<', loadStart + 1);
    final loadBody = security.substring(loadStart, loadEnd);
    expect(loadBody, contains('_initNativeIosVoice()'));

    expect(security, contains('_localVoice.runMicOp(() => CheNativeVoice.start())'));
    expect(voice, contains('await _restartWakeListener();'));
    expect(voice, contains('_localVoice.runMicOp(() async'));
  });
}
