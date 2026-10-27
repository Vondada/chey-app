import 'dart:io';

import 'package:chey/che_edge_voice.dart';
import 'package:chey/che_native_voice.dart';
import 'package:chey/che_private_voice.dart';
import 'package:chey/che_realtime_voice.dart';
import 'package:chey/che_voice_health.dart';
import 'package:chey/che_voice_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    ChePrivateVoice.enabled.value = false;
  });

  test('the Private voice setting is saved on the device and read back', () async {
    expect(await ChePrivateVoice.load(), isFalse);
    expect(await ChePrivateVoice.setEnabled(true), isTrue);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(ChePrivateVoice.prefsKey), isTrue);

    ChePrivateVoice.enabled.value = false; // a fresh launch
    expect(await ChePrivateVoice.load(), isTrue);
    expect(ChePrivateVoice.isOn, isTrue);

    await ChePrivateVoice.setEnabled(false);
    ChePrivateVoice.enabled.value = true;
    expect(await ChePrivateVoice.load(), isFalse);
  });

  test('live voice is never chosen while Private voice is on', () {
    final now = DateTime(2026, 10, 25, 12);
    final past = now.subtract(const Duration(hours: 1));
    expect(cheUseLiveVoice(liveConfigured: true, skipUntil: past, now: now), isTrue);
    expect(cheUseLiveVoice(liveConfigured: true, skipUntil: past, now: now, privateVoice: true), isFalse);
  });

  test('the Realtime engine refuses to connect under Private voice, before any network call', () async {
    await ChePrivateVoice.setEnabled(true);
    var requests = 0;
    final engine = CheRealtimeVoiceEngine(
      baseUrl: 'https://che.example',
      deviceToken: 'token',
      state: CheVoiceStateMachine(),
      onSnapshot: (_) {},
      onUserTranscript: (_, _) {},
      onAssistantTranscript: (_, _, _) {},
      onCapabilityRequest: (_, _) async => '',
      onStandDown: () async {},
    );
    await http.runWithClient(() async {
      await expectLater(
        engine.connect(),
        throwsA(isA<StateError>().having((e) => e.message, 'message', ChePrivateVoice.realtimeRefusal)),
      );
    }, () => MockClient((request) async {
      requests++;
      return http.Response('{}', 200);
    }));
    expect(requests, 0, reason: 'no live-voice token was requested and nothing reached OpenAI');
    expect(engine.connected, isFalse);
  });

  test('ElevenLabs and Fish are never asked for a clip under Private voice', () async {
    SharedPreferences.setMockInitialValues({'che_agent_base_url': 'https://che.example'});
    await ChePrivateVoice.setEnabled(true);
    var requests = 0;
    final result = await http.runWithClient(
      () => CheEdgeVoice.speak('Here is my private answer.', premiumOnly: true),
      () => MockClient((request) async {
        requests++;
        return http.Response('', 204);
      }),
    );
    expect(requests, 0);
    expect(result.clip, isNull);
    expect(result.failure, ChePrivateVoice.serverVoiceRefusal);
  });

  test('chat requests carry the private flag only while Private voice is on', () async {
    expect(ChePrivateVoice.chatFields(), isEmpty);
    await ChePrivateVoice.setEnabled(true);
    expect(ChePrivateVoice.chatFields(), {'private': true});
    // The /api/chat body spreads these fields (streaming.dart).
    final streaming = File('lib/home_state/streaming.dart').readAsStringSync();
    final chatBody = streaming.substring(streaming.indexOf("Uri.parse('\$cheAgentBaseUrl/api/chat')"));
    expect(chatBody.substring(0, chatBody.indexOf("'client': {")), contains('...ChePrivateVoice.chatFields(),'));
  });

  group('on-device recognition', () {
    const channel = MethodChannel('che/native_voice');
    late List<String> calls;

    void nativeReports({required bool onDevice}) {
      calls = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return switch (call.method) {
          'status' => {'native_recognition': true, 'on_device_recognition': onDevice},
          'start' || 'wake' => true,
          _ => null,
        };
      });
    }

    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

    test('unsupported on-device recognition is reported, and the recognizer is not started', () async {
      await ChePrivateVoice.setEnabled(true);
      nativeReports(onDevice: false);
      expect(await CheNativeVoice.start(), isFalse);
      expect(calls, isNot(contains('start')), reason: 'Apple server recognition is never used as a fallback');
      expect(CheNativeVoice.lastPrivateRefusal, ChePrivateVoice.unsupportedRecognitionReply);
      expect(await CheNativeVoice.wake(), isFalse);
      expect(calls, isNot(contains('wake')));
      expect(ChePrivateVoice.unsupportedRecognitionReply, contains('did not open the microphone'));
    });

    test('supported on-device recognition starts the recognizer under Private voice', () async {
      await ChePrivateVoice.setEnabled(true);
      nativeReports(onDevice: true);
      expect(await CheNativeVoice.start(), isTrue);
      expect(calls, contains('start'));
      expect(CheNativeVoice.lastPrivateRefusal, isEmpty);
    });

    test('with Private voice off nothing extra is checked', () async {
      nativeReports(onDevice: false);
      expect(await CheNativeVoice.start(), isTrue);
      expect(calls, contains('start'));
    });
  });

  test('spoken and typed commands', () {
    for (final on in ['turn on private voice', 'Chay, turn on private voice.', 'switch private voice on', 'enable private mode', 'go private']) {
      expect(ChePrivateVoice.parse(on), ChePrivateVoiceCommand.on, reason: on);
    }
    for (final off in ['turn off private voice', 'Che turn private voice off', 'disable private voice', 'stop private mode']) {
      expect(ChePrivateVoice.parse(off), ChePrivateVoiceCommand.off, reason: off);
    }
    for (final ask in ['is my voice private?', 'Is private voice on', 'where does my voice go', 'what leaves my phone', 'how private is my voice']) {
      expect(ChePrivateVoice.parse(ask), ChePrivateVoiceCommand.status, reason: ask);
    }
    for (final other in ['turn on the lights', 'tell me about private schools', 'private message Sam']) {
      expect(ChePrivateVoice.parse(other), isNull, reason: other);
    }
  });

  test('"is my voice private?" answers with the actual data flow', () {
    final on = ChePrivateVoice.dataFlowReply(on: true, onDeviceRecognition: true, kokoroReady: true, liveVoiceConfigured: true);
    expect(on, startsWith('Yes, Private voice is on.'));
    expect(on, contains('audio never leaves the phone'));
    expect(on, contains('text of your words goes to my own server'));
    expect(on, contains('Cloudflare'));
    expect(on, contains('does not have yet'), reason: 'no on-device language model is claimed');

    final unsupported = ChePrivateVoice.dataFlowReply(on: true, onDeviceRecognition: false, kokoroReady: false, liveVoiceConfigured: true);
    expect(unsupported, contains('keep the microphone closed'));
    expect(unsupported, contains('still loading'));

    final off = ChePrivateVoice.dataFlowReply(on: false, onDeviceRecognition: true, kokoroReady: true, liveVoiceConfigured: true);
    expect(off, startsWith('No, Private voice is off.'));
    expect(off, contains('OpenAI'));
    expect(off, contains('ElevenLabs'));

    expect(ChePrivateVoice.changedReply(true, saved: true), contains('stays on this iPhone'));
    expect(ChePrivateVoice.changedReply(true, saved: false), contains('could not save'));
  });

  test('the reply voice under Private voice is the on-device voice only (source guard)', () {
    final voice = File('lib/home_state/voice.dart').readAsStringSync();
    final turn = voice.substring(voice.indexOf('CheSpeechPipeline<CheVoiceClip>? _openSpeechTurn('));
    final privateBranch = turn.indexOf('if (privateVoice) {');
    expect(privateBranch, greaterThan(0));
    expect(turn.indexOf('CheNativeVoice.synthesizeNeural(text)'), greaterThan(privateBranch));
    expect(turn.indexOf('CheNativeVoice.synthesizeNeural(text)'), lessThan(turn.indexOf('voice.synthesize(text)')),
        reason: 'the on-device voice is chosen before the ElevenLabs/Fish voice is ever asked');
    // A clip Kokoro could not make stays silent with its words shown; never the iPhone or a server voice.
    final fallback = turn.substring(turn.indexOf('fallback: (text) {'));
    expect(fallback.indexOf('if (privateVoice) {'), lessThan(fallback.indexOf('_speakFallbackChunk')));
  });

  testWidgets('the Private voice banner is visible and labelled only while on', (tester) async {
    var turnedOff = false;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ChePrivateVoiceBanner(onTurnOff: () => turnedOff = true))));
    expect(find.byKey(const ValueKey('private-voice-banner')), findsNothing);
    ChePrivateVoice.enabled.value = true;
    await tester.pump();
    expect(find.byKey(const ValueKey('private-voice-banner')), findsOneWidget);
    expect(find.bySemanticsLabel(ChePrivateVoiceBanner.label), findsOneWidget);
    expect(find.bySemanticsLabel('Turn off private voice'), findsOneWidget);
    await tester.tap(find.text('Turn off'));
    expect(turnedOff, isTrue);
    expect(cheVoiceEngineLabel('kokoro-on-device'), 'On-device voice (private)');
  });
}
