import 'package:chey/che_native_voice.dart';
import 'package:chey/che_ui/che_ui_preferences.dart';
import 'package:chey/che_ui/che_ui_voice_command.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('clear UI commands are recognized', () {
    for (final phrase in [
      'Dark mode',
      'Chay, switch to light mode.',
      'make the text bigger',
      'smaller text',
      'normal text size',
      'compact desks',
      'portrait avatars',
      'turn your voice off',
      'unmute your voice',
      'volume down',
      'louder',
      'set volume to 40 percent',
    ]) {
      expect(CheUiVoiceCommand.parse(phrase), isNotNull, reason: phrase);
    }
  });

  test('normal requests that only mention UI words go to CHE', () {
    for (final phrase in [
      'write an essay about why dark mode saves battery',
      'what is the best font for a resume',
      'tell me a story',
      'stand down',
      'turn up the heat in the living room please and thanks',
    ]) {
      expect(CheUiVoiceCommand.parse(phrase), isNull, reason: phrase);
    }
  });

  test('volume percent is parsed and clamped', () {
    expect(CheUiVoiceCommand.parse('volume 250')!.value, 1.0);
    expect(CheUiVoiceCommand.parse('set your volume to 30%')!.value, 0.3);
  });

  test('hands-free wake is opt-in and toggled by voice', () {
    for (final phrase in ['turn on hands-free', 'hands free on', 'Che, always listen', 'hands free mode']) {
      final c = CheUiVoiceCommand.parse(phrase);
      expect(c?.kind, 'handsFree', reason: phrase);
      expect(c?.value, true, reason: phrase);
    }
    for (final phrase in ['turn off hands-free', 'hands free off', 'only listen when I press the mic']) {
      final c = CheUiVoiceCommand.parse(phrase);
      expect(c?.kind, 'handsFree', reason: phrase);
      expect(c?.value, false, reason: phrase);
    }
  });

  group('audio output by voice', () {
    const channel = MethodChannel('che/native_voice');
    late List<MethodCall> calls;
    Map<String, Object?> report(String route, {String name = '', double volume = 0.5}) => {
          'route': route,
          'outputs': [
            {'type': route, 'name': name}
          ],
          'output_volume': volume,
        };

    setUp(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      SharedPreferences.setMockInitialValues({});
      calls = [];
      await CheUiPreferences.instance.setAudioOutput(CheAudioOutput.auto);
      await CheUiPreferences.instance.setVoiceVolume(1.0);
    });
    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

    void bridge(Object? Function(MethodCall call) answer) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return answer(call);
      });
    }

    test('natural phrasings choose the loudspeaker, the earpiece or automatic', () {
      for (final (phrase, output) in [
        ('Use the speaker', CheAudioOutput.speaker),
        ('Chay, talk through the loudspeaker.', CheAudioOutput.speaker),
        ('turn on speakerphone', CheAudioOutput.speaker),
        ('put your voice on speaker', CheAudioOutput.speaker),
        ('use the earpiece', CheAudioOutput.receiver),
        ('speakerphone off', CheAudioOutput.receiver),
        ('use my AirPods', CheAudioOutput.auto),
        ('play through bluetooth', CheAudioOutput.auto),
        ('use automatic audio output', CheAudioOutput.auto),
      ]) {
        final c = CheUiVoiceCommand.parse(phrase);
        expect(c?.kind, 'audioOutput', reason: phrase);
        expect(c?.value, output, reason: phrase);
      }
      for (final phrase in ['which speaker are you using?', 'where is your voice playing?', 'what audio output are you using', 'check the audio output']) {
        expect(CheUiVoiceCommand.parse(phrase)?.kind, 'audioRoute', reason: phrase);
      }
      for (final phrase in ['who is the best public speaker', 'write a speech for the speaker of the house', 'buy new headphones']) {
        expect(CheUiVoiceCommand.parse(phrase), isNull, reason: phrase);
      }
    });

    test('choosing an output tells the iPhone, saves it and says where she plays now', () async {
      bridge((call) => call.method == 'setAudioOutput' ? report('speaker') : null);
      final said = await CheUiVoiceCommand.parse('use the speaker')!.apply(CheUiPreferences.instance);
      expect(calls.single.method, 'setAudioOutput');
      expect(calls.single.arguments, 'speaker');
      expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.speaker);
      expect(said, 'Done. I will speak through the loudspeaker, even with headphones or Bluetooth connected. '
          'Right now I am playing through the loudspeaker.');
    });

    test('"which speaker" reports the real route and both volumes, never changing the iPhone volume', () async {
      await CheUiPreferences.instance.setVoiceVolume(0.8);
      bridge((call) => call.method == 'audioRoute' ? report('bluetooth', name: 'AirPods Pro', volume: 0.3) : null);
      final said = await CheUiVoiceCommand.parse('which speaker are you using?')!.apply(CheUiPreferences.instance);
      expect(said, 'I am playing through Bluetooth (AirPods Pro). Audio Output is set to Automatic. '
          'My Voice Volume is 80 percent, and your iPhone volume is at 30 percent.');
      expect(calls.map((c) => c.method), ['audioRoute']);
    });

    test('"louder" at full Voice Volume points to the volume buttons instead of pretending', () async {
      bridge((call) => null);
      final said = await CheUiVoiceCommand.parse('louder')!.apply(CheUiPreferences.instance);
      expect(said, startsWith('My voice is already at full volume. For more, press your iPhone\'s volume up button'));
      expect(CheUiPreferences.instance.voiceVolume, 1.0);
    });

    test('an older build says the earpiece needs the newest build', () async {
      bridge((call) => throw MissingPluginException());
      final said = await CheUiVoiceCommand.parse('use the earpiece')!.apply(CheUiPreferences.instance);
      expect(said, contains('Install the newest CHE build from Updates to use the earpiece.'));
      expect(CheNativeVoice.bridgePresent, isTrue);
      expect(CheUiPreferences.instance.audioOutput, CheAudioOutput.auto, reason: 'not saved where it cannot work');
    });
  });
}
