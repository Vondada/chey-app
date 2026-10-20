// Screen sharing through the ReplayKit extension (owner, 2026-10-20): the
// phrases, the native channel's answers, and older builds without it.
import 'dart:convert';

import 'package:chey/che_ui/che_screen_share.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _channel = MethodChannel('che/screen_share');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(_channel, null));

  test('the ways the owner starts and stops sharing, and sentences that are not that', () {
    for (final m in ['Share my screen', 'CHE, share my screen with you.', 'Start screen sharing', 'start sharing my screen', 'Watch my screen', 'turn on screen sharing']) {
      expect(cheAsksToShareScreen(m), isTrue, reason: m);
      expect(cheAsksToStopSharing(m), isFalse, reason: m);
    }
    for (final m in ['Stop sharing my screen', 'CHE, stop screen sharing', 'end the screen share', 'stop watching my screen', 'stop broadcasting']) {
      expect(cheAsksToStopSharing(m), isTrue, reason: m);
      expect(cheAsksToShareScreen(m), isFalse, reason: m);
    }
    for (final m in ['How do I share my screen on Zoom?', 'Look at my screen', 'Share this article with Mike', 'stop the music', 'What is screen sharing?']) {
      expect(cheAsksToShareScreen(m) || cheAsksToStopSharing(m), isFalse, reason: m);
    }
  });

  test('a build without the extension (an older IPA with this patch) says sharing is not available', () async {
    final status = await CheScreenShare.status();
    expect(status.available, isFalse);
    expect(status.active, isFalse);
    expect(await CheScreenShare.frame(), isNull);
    expect(await CheScreenShare.showPicker(), isFalse);
  });

  test('a running broadcast hands over its frame with its time and whether it was taken before the switch', () async {
    final jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
    final calls = <String>[];
    messenger.setMockMethodCallHandler(_channel, (call) async {
      calls.add(call.method);
      switch (call.method) {
        case 'status':
          return {'available': true, 'active': true, 'paused': false};
        case 'latestFrame':
          return {'bytes': jpeg, 'at': 1760950000.5, 'width': 1290, 'height': 2796, 'before_switch': true};
        case 'showPicker':
          return true;
      }
      return null;
    });
    final status = await CheScreenShare.status();
    expect(status.available && status.active, isTrue);
    final frame = await CheScreenShare.frame();
    expect(frame, isNotNull);
    expect(frame!.ok, isTrue);
    expect(frame.shared, isTrue);
    expect(frame.beforeSwitch, isTrue);
    expect(base64Decode(frame.base64), jpeg);
    expect(frame.width, 1290);
    expect(frame.at, DateTime.fromMillisecondsSinceEpoch(1760950000500));
    expect(await CheScreenShare.showPicker(), isTrue);
    expect(calls, ['status', 'latestFrame', 'showPicker']);
  });

  test('no frame (sharing ended) or a native error is null, never a stale picture', () async {
    messenger.setMockMethodCallHandler(_channel, (call) async => call.method == 'latestFrame' ? null : throw PlatformException(code: 'x'));
    expect(await CheScreenShare.frame(), isNull);
    expect((await CheScreenShare.status()).available, isFalse);
  });
}
