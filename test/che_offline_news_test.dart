// Owner, 2026-10-15: CHE invented an MIT Technology Review article. When her
// server cannot be reached the iPhone answers from its on-device model, which
// has no sources at all; a news question must get an honest "I can't check"
// instead of a guess. Through the real app on a simulated iPhone.
import 'dart:io';

import 'package:chey/main.dart';
import 'package:chey/self_update/che_self_update_intent.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('offline, a news question gets "I can\'t check", never an on-device guess', (tester) async {
    // Paired, but CHE's server cannot be reached.
    SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.test', 'che_agent_device_token': 'test-device'});
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final asked = <String>[];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    // The on-device model would answer anything; it must not be asked.
    messenger.setMockMethodCallHandler(const MethodChannel('che/local_ai'), (call) async {
      asked.add(call.method);
      return call.method == 'respond' ? 'Google released MedMind, MIT Technology Review reports.' : true;
    });
    // The iPhone's voice and WebRTC plugins, idle here.
    for (final name in ['che/native_voice', 'FlutterWebRTC.Method']) {
      messenger.setMockMethodCallHandler(MethodChannel(name), (call) async => null);
    }
    for (final name in ['che/native_voice_events', 'FlutterWebRTC.Event']) {
      messenger.setMockStreamHandler(EventChannel(name), MockStreamHandler.inline(onListen: (_, _) {}));
    }
    addTearDown(() {
      for (final name in ['che/local_ai', 'che/native_voice', 'FlutterWebRTC.Method']) {
        messenger.setMockMethodCallHandler(MethodChannel(name), null);
      }
      for (final name in ['che/native_voice_events', 'FlutterWebRTC.Event']) {
        messenger.setMockStreamHandler(EventChannel(name), null);
      }
    });
    final client = MockClient((request) async => throw const SocketException('network is unreachable'));

    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.enterText(find.byType(TextField).last, 'What was the biggest AI news story today?');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      // CHE's own startup reads files for real; let real time pass for them.
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
        await tester.pump(const Duration(milliseconds: 250));
      }
      expect(find.textContaining("I can't reach my research tools right now, so I can't check the news."), findsWidgets);
      expect(find.textContaining('MedMind'), findsNothing);
      expect(asked.where((m) => m == 'respond'), isEmpty, reason: 'the on-device model was not asked');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    }, () => client);
    debugDefaultTargetPlatformOverride = null;
    expect(cheOfflineNewsReply, contains("I won't guess"));
  });
}
