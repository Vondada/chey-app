import 'dart:async';

import 'package:chey/che_native_voice.dart';
import 'package:chey/che_speech_pipeline.dart';
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
    mockBridge((call) async => call.method == 'playAudio' ? true : null);

    final played = await CheNativeVoice.playAudioBounded(clip);

    expect(played, isTrue);
    final play = calls.singleWhere((c) => c.method == 'playAudio');
    expect(play.arguments, clip);
  });

  test('a player that never reports completion is stopped and treated as not played', () async {
    final stuck = Completer<Object?>();
    mockBridge((call) {
      if (call.method == 'playAudio') return stuck.future;
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
      if (call.method == 'playAudio') {
        throw PlatformException(code: 'audio_playback_failed', message: 'could not play');
      }
      return null;
    });

    expect(await CheNativeVoice.playAudioBounded(Uint8List(8)), isFalse);
    // The iPhone's own reason is kept for the diagnostics and the voice log.
    expect(CheNativeVoice.lastPlaybackError, 'audio_playback_failed: could not play');
  });

  test('a stuck player and a played clip leave the right playback reason', () async {
    final stuck = Completer<Object?>();
    mockBridge((call) => call.method == 'playAudio' ? stuck.future : Future<Object?>.value(null));
    await CheNativeVoice.playAudioBounded(Uint8List(8), limit: const Duration(milliseconds: 50));
    expect(CheNativeVoice.lastPlaybackError, 'playback did not finish within 0 seconds');
    mockBridge((call) async => call.method == 'playAudio' ? true : null);
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
