import 'dart:async';

import 'package:chey/che_native_voice.dart';
import 'package:chey/che_speech_pipeline.dart';
import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:chey/che_ui/che_ui_voice_command.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Audio delivery checked at the native channel boundary. The bytes CHE should
// speak must reach the iPhone player, and a dead or failing player must hand
// the chunk to the device voice instead of leaving the owner in silence.
const _channel = MethodChannel('che/native_voice');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<MethodCall> calls;

  void mockBridge(Future<Object?> Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _channel,
      (call) async {
        calls.add(call);
        return handler(call);
      },
    );
  }

  setUp(() {
    calls = <MethodCall>[];
    SharedPreferences.setMockInitialValues({});
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _channel,
      null,
    );
  });

  test('device voice speaks at once when the neural model is not loaded', () async {
    mockBridge((call) async => call.method == 'speakText' ? true : null);

    final spoken = await CheNativeVoice.speakText('Here is your memory.')
        .timeout(const Duration(seconds: 2));

    expect(spoken, isTrue);
    final speak = calls.where((c) => c.method == 'speakText').toList();
    expect(speak, hasLength(1));
    expect((speak.single.arguments as Map)['text'], contains('memory'));
  });

  test('neural voice never holds the speech path while it loads', () async {
    mockBridge((call) async => null);

    final played = await CheNativeVoice.speakNeural('Hello there')
        .timeout(const Duration(seconds: 2));

    expect(played, isFalse);
  });

  test('server audio reaches the iPhone player as the same bytes', () async {
    final clip = Uint8List.fromList(List<int>.generate(64, (i) => i));
    mockBridge((call) async => call.method == 'playClip' ? {'played': true} : null);

    final played = await CheNativeVoice.playAudioBounded(clip);

    expect(played, isTrue);
    final play = calls.singleWhere((c) => c.method == 'playClip');
    expect((play.arguments as Map)['bytes'], clip);
  });

  test('a clip carries its words, the Voice Volume and Audio Output to the iPhone player', () async {
    await CheUiPreferences.instance.setVoiceVolume(0.4);
    await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.receiver);
    addTearDown(() async {
      await CheUiPreferences.instance.setVoiceVolume(1.0);
      await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.auto);
    });
    mockBridge((call) async => call.method == 'playClip'
        ? {'played': true, 'route': 'receiver', 'output_volume': 0.25, 'volume': 0.4, 'rms_db': -31.0, 'peak_db': -14.0, 'gain_db': 12.0}
        : null);

    expect(await CheNativeVoice.playAudioBounded(Uint8List(8), text: 'Here is the news.'), isTrue);

    final args = calls.singleWhere((c) => c.method == 'playClip').arguments as Map;
    expect(args['text'], 'Here is the news.', reason: 'the iPhone tells her own voice from the owner\'s');
    expect(args['volume'], 0.4, reason: 'Voice Volume reaches ElevenLabs and Fish playback');
    expect(args['output'], 'receiver');
    expect(args['normalize'], isTrue, reason: 'an unusually quiet clip may be raised (never past its peak)');
    // What the iPhone measured is kept for Voice diagnostics.
    expect(CheNativeVoice.lastPlayback['route'], 'receiver');
    expect(cheIphoneVolumePercent(CheNativeVoice.lastPlayback), 25);
    expect(cheAudioRouteSpoken(CheNativeVoice.lastPlayback), 'the earpiece');
  });

  test('an iPhone build from before playClip plays the same bytes the old way', () async {
    final clip = Uint8List.fromList([1, 2, 3, 4]);
    mockBridge((call) async {
      if (call.method == 'playClip') throw MissingPluginException();
      return call.method == 'playAudio' ? true : null;
    });

    expect(await CheNativeVoice.playAudioBounded(clip, text: 'Hello'), isTrue);
    expect(calls.map((c) => c.method), ['playClip', 'playAudio']);
    expect(calls.last.arguments, clip);
    expect(CheNativeVoice.bridgePresent, isTrue);
  });

  test('route calls on an older build answer null without calling the bridge missing', () async {
    mockBridge((call) async => throw MissingPluginException());
    expect(await CheNativeVoice.audioRoute(), isNull);
    expect(await CheNativeVoice.setAudioOutput('speaker'), isNull);
    expect(CheNativeVoice.bridgePresent, isTrue);

    mockBridge((call) async => {'route': 'bluetooth', 'outputs': [{'type': 'BluetoothA2DPOutput', 'name': 'AirPods Pro'}], 'output_volume': 0.6});
    final report = (await CheNativeVoice.audioRoute())!;
    expect(cheAudioRouteSpoken(report), 'Bluetooth (AirPods Pro)');
    expect(cheIphoneVolumePercent(report), 60);
    expect(cheAudioRouteLabel('speaker'), 'the loudspeaker');
  });

  test('native output routing failure keeps the previous private output preference', () async {
    await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.receiver);
    addTearDown(() => CheUiPreferences.instance.setAudioOutput(CheAudioOutput.auto));
    mockBridge((call) async {
      if (call.method == 'setAudioOutput') {
        throw PlatformException(code: 'audio_route_failed', message: 'Unable to override output port');
      }
      return null;
    });

    final result = await cheSetAudioOutput(CheAudioOutput.speaker);
    expect(result.applied, isFalse);
    expect(result.text, contains('Nothing was changed'));
    expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.receiver);
    expect(calls.where((call) => call.method == 'setAudioOutput'), hasLength(1));
  });

  test('a player that never reports completion is stopped and treated as not played', () async {
    final stuck = Completer<Object?>();
    mockBridge((call) {
      if (call.method == 'playClip') return stuck.future;
      return Future<Object?>.value(null);
    });

    final played = await CheNativeVoice.playAudioBounded(
      Uint8List(8),
      limit: const Duration(milliseconds: 50),
    );

    expect(played, isFalse);
    expect(calls.map((c) => c.method), contains('stopAudio'));
  });

  test('a native playback error counts as not played, so the chunk falls back', () async {
    mockBridge((call) async {
      if (call.method == 'playClip') {
        throw PlatformException(code: 'audio_playback_failed', message: 'could not play');
      }
      return null;
    });

    expect(await CheNativeVoice.playAudioBounded(Uint8List(8)), isFalse);
    // The iPhone's own reason is kept for the diagnostics and the voice log.
    expect(CheNativeVoice.lastPlaybackError, 'audio_playback_failed: could not play');
  });

  test('a build without the voice bridge says to install the newest build', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null);
    expect(await CheNativeVoice.playAudioBounded(Uint8List(8)), isFalse);
    expect(CheNativeVoice.lastPlaybackError, contains('install the newest CHE build from Updates'));
  });

  test('a stuck player and a played clip leave the right playback reason', () async {
    final stuck = Completer<Object?>();
    mockBridge((call) => call.method == 'playClip' ? stuck.future : Future<Object?>.value(null));
    await CheNativeVoice.playAudioBounded(Uint8List(8), limit: const Duration(milliseconds: 50));
    expect(CheNativeVoice.lastPlaybackError, 'playback did not finish within 0 seconds');
    mockBridge((call) async => call.method == 'playClip' ? {'played': true} : null);
    expect(await CheNativeVoice.playAudioBounded(Uint8List(8)), isTrue);
    expect(CheNativeVoice.lastPlaybackError, '');
  });

  test('playback deadline is capped, so uncompressed audio cannot hold a turn for minutes', () {
    expect(CheNativeVoice.playbackDeadline(0), const Duration(seconds: 3));
    // About 20 seconds of 24 kHz PCM16 WAV: the Gemini route's uncompressed clip.
    expect(CheNativeVoice.playbackDeadline(960000), const Duration(seconds: 60));
  });

  test('a clip that fails to play is spoken on the device voice, in order', () async {
    final spoken = <String>[];
    final pipeline = CheSpeechPipeline<String>(
      synthesize: (text) async => 'audio:$text',
      play: (audio) async => audio != 'audio:second',
      fallback: (text) async {
        spoken.add(text);
        return true;
      },
    );

    pipeline.add('first');
    pipeline.add('second');
    pipeline.add('third');
    pipeline.close();
    await pipeline.done;

    expect(spoken, ['second']);
  });
}
