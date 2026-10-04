import 'package:chey/che_ui/che_ui_voice_command.dart';
import 'package:flutter_test/flutter_test.dart';

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
}
