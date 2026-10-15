// Owner, 2026-10-15: Connie's ElevenLabs voice was much too quiet on the
// iPhone. Through the real app on a simulated iPhone: a typed request goes
// through Chat's send pipeline, the reply is fetched from CHE's server voice
// route and reaches the iPhone player with its words (so CHE never takes her
// own voice for an interruption), the owner's Voice Volume and his Audio
// Output choice, which he can change by voice.
import 'dart:convert';

import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:chey/home/che_ui_controls_screen.dart';
import 'package:chey/main.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('a spoken reply reaches the iPhone player with its words, the Voice Volume and the output choice', (tester) async {
    SharedPreferences.setMockInitialValues({
      'che_agent_base_url': 'https://che.test',
      'che_agent_device_token': 'test-device',
    });
    await CheUiPreferences.instance.load();
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    // CHE's iPhone voice bridge, as the new native code answers it.
    final native = <MethodCall>[];
    var preference = 'auto';
    Map<String, Object?> report() => {
          'route': preference == 'receiver' ? 'receiver' : 'speaker',
          'outputs': [
            {'type': preference == 'receiver' ? 'Receiver' : 'Speaker', 'name': 'iPhone'}
          ],
          'preference': preference,
          'output_volume': 0.5,
        };
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), (call) async {
      native.add(call);
      switch (call.method) {
        case 'setAudioOutput':
          preference = call.arguments as String;
          return report();
        case 'audioRoute':
          return report();
        case 'playClip':
          final args = call.arguments as Map;
          preference = args['output'] as String;
          return {...report(), 'played': true, 'volume': args['volume'], 'rms_db': -19.5, 'peak_db': -1.8, 'gain_db': 0.0};
      }
      return null;
    });
    // The WebRTC plugin the Realtime engine uses; its session helper is a no-op here.
    messenger.setMockMethodCallHandler(const MethodChannel('FlutterWebRTC.Method'), (call) async => null);
    addTearDown(() {
      messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), null);
      messenger.setMockMethodCallHandler(const MethodChannel('FlutterWebRTC.Method'), null);
    });

    // CHE's server: the voice route answers with an ElevenLabs clip.
    final voiceRequests = <String>[];
    final clip = Uint8List.fromList(List<int>.generate(48, (i) => (i * 7) % 256));
    final client = MockClient((request) async {
      if (request.url.path == '/api/voice/edge') {
        voiceRequests.add((jsonDecode(request.body) as Map)['text'] as String);
        return http.Response.bytes(clip, 200, headers: {'content-type': 'audio/mpeg', 'x-che-voice': 'elevenlabs', 'x-che-mary': 'healthy'});
      }
      return http.Response('{}', 200, headers: {'content-type': 'application/json'});
    });

    await http.runWithClient(() async {
      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.tap(find.text('Chat'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byTooltip('Show keyboard'));
      await tester.pump(const Duration(milliseconds: 300));

      Future<void> send(String words) async {
        await tester.enterText(find.byType(TextField).last, words);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
      }

      List<Map> clips() => [for (final c in native) if (c.method == 'playClip') c.arguments as Map];

      await send('Set your volume to 40 percent');
      expect(find.textContaining('Done. Volume is 40 percent.'), findsWidgets);
      expect(voiceRequests, ['Done. Volume is 40 percent.'], reason: 'the reply was spoken with CHE\'s server voice');
      expect(clips(), hasLength(1));
      expect(clips().single['bytes'], clip, reason: 'the same ElevenLabs bytes reach the iPhone player');
      expect(clips().single['text'], 'Done. Volume is 40 percent.', reason: 'her words go with the clip');
      expect(clips().single['volume'], 0.4, reason: 'Voice Volume now reaches ElevenLabs and Fish playback');
      expect(clips().single['output'], 'auto', reason: 'the loudspeaker unless headphones or Bluetooth are connected');

      await send('Use the earpiece');
      expect(native.where((c) => c.method == 'setAudioOutput').map((c) => c.arguments), contains('receiver'));
      expect(voiceRequests.last, 'Done. I will speak through the earpiece. Hold the iPhone to your ear. '
          'Right now I am playing through the earpiece.');
      expect(clips().last['output'], 'receiver', reason: 'that reply itself plays where he chose');

      await send('Chay, put your voice on speaker.');
      expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.speaker);
      expect(clips().last['output'], 'speaker');

      await send('Which speaker are you using?');
      expect(voiceRequests.last, 'I am playing through the loudspeaker. Audio Output is set to Speaker. '
          'My Voice Volume is 40 percent, and your iPhone volume is at 50 percent.');
      expect(clips().last['text'], voiceRequests.last);
      expect(voiceRequests, hasLength(4), reason: 'one clip per reply: no double playback');
      // No Chat model was asked about any of this.
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    }, () => client);
    debugDefaultTargetPlatformOverride = null;
    await CheUiPreferences.instance.setVoiceVolume(1.0);
    await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.auto);
  });

  testWidgets('UI Controls: Audio Output is a labelled choice that tells the iPhone, and says where she plays', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await CheUiPreferences.instance.load();
    final native = <MethodCall>[];
    var route = 'speaker';
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), (call) async {
      native.add(call);
      if (call.method == 'setAudioOutput') route = call.arguments == 'receiver' ? 'receiver' : 'speaker';
      return {'route': route, 'outputs': const [], 'output_volume': 0.7};
    });
    addTearDown(() => messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), null));
    final announced = listenForAnnouncements();
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(const MaterialApp(home: CheUiControlsScreen()));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Audio output'), 200);
    await tester.pumpAndSettle();
    expect(find.textContaining('Now playing through the loudspeaker.'), findsOneWidget);
    // VoiceOver reads each choice as a button and which one is selected.
    expect(tester.getSemantics(find.text('Automatic')), matchesSemantics(label: 'Automatic', isButton: true, isSelected: true, hasSelectedState: true,
        isInMutuallyExclusiveGroup: true, hasTapAction: true));
    expect(tester.getSemantics(find.text('Earpiece')), matchesSemantics(label: 'Earpiece', isButton: true,
        isInMutuallyExclusiveGroup: true, hasTapAction: true, hasSelectedState: true));

    await tester.tap(find.text('Earpiece'));
    await tester.pumpAndSettle();
    expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.receiver);
    expect(native.where((c) => c.method == 'setAudioOutput').single.arguments, 'receiver');
    expect(find.textContaining('The earpiece: hold the iPhone to your ear. Now playing through the earpiece.'), findsOneWidget);
    expect(find.textContaining("CHE's voice (ElevenLabs and Fish) plays at this level."), findsOneWidget);
    // Codex on #315: the choice is reported, seen and heard, like the spoken command.
    const done = 'Done. I will speak through the earpiece. Hold the iPhone to your ear. Right now I am playing through the earpiece.';
    expect(find.descendant(of: find.byType(SnackBar), matching: find.text(done)), findsOneWidget);
    expect(announced, [done]);
    semantics.dispose();
    await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.auto);
  });

  testWidgets('UI Controls: an earpiece choice an older build cannot apply is reported, not silently ignored', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await CheUiPreferences.instance.load();
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    // An older iPhone build: no route calls, so the bridge answers nothing.
    messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), (call) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(const MethodChannel('che/native_voice'), null));
    final announced = listenForAnnouncements();

    await tester.pumpWidget(const MaterialApp(home: CheUiControlsScreen()));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Audio output'), 200);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Earpiece'));
    await tester.pumpAndSettle();
    const why = 'This CHE build always speaks through the loudspeaker. Install the newest CHE build from Updates to use the earpiece.';
    expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.auto, reason: 'nothing was changed');
    expect(find.descendant(of: find.byType(SnackBar), matching: find.text(why)), findsOneWidget);
    expect(announced, [why]);
  });
}

/// What VoiceOver is asked to read aloud.
List<String> listenForAnnouncements() {
  final said = <String>[];
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, (message) async {
    final map = message as Map?;
    final data = map?['data'];
    if (map?['type'] == 'announce' && data is Map) said.add(data['message'] as String);
    return null;
  });
  addTearDown(() => messenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, null));
  return said;
}
