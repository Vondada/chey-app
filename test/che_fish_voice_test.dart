import 'dart:io';

import 'package:chey/che_edge_voice.dart';
import 'package:chey/che_pronunciation.dart';
import 'package:chey/self_update/che_update_plan.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('CHE\'s Fish voice is named honestly', () {
    test('a Fish clip is labelled as CHE\'s backup voice', () {
      expect(cheEdgeEngine('fish-audio'), 'fish-audio');
      expect(cheVoiceEngineLabel('fish-audio'), 'Fish Audio (backup)');
    });

    test('no Fish reason when Fish spoke, was not reported, or is not set up', () {
      expect(cheFishReason('healthy', 'fish-audio'), '');
      expect(cheFishReason('', 'edge-ava'), '');
      expect(cheFishReason('not set up', 'edge-ava'), '');
    });

    test('each Fish failure has a plain reason', () {
      expect(cheFishReason('unauthorized', 'edge-ava'), "Fish's key was refused");
      expect(cheFishReason('model not available', 'elevenlabs-mary'),
          "Fish's model is not available on this account");
      expect(cheFishReason('slow', 'edge-ava'), 'Fish was too slow, so a faster voice answered');
      expect(cheFishReason('out of credits', 'edge-ava'), 'Fish is out of credits');
      expect(cheFishReason('something new', 'edge-ava'), 'Fish did not speak this clip (something new)');
    });

    test('the diagnostics state words cover every Fish status', () {
      expect(cheFishStateLabel(''), 'Not asked yet this session');
      expect(cheFishStateLabel('healthy'), 'Working');
      expect(cheFishStateLabel('needs a voice'), 'Needs a voice ID');
      expect(cheFishStateLabel('rate-limited'), 'Resting after a rate limit');
      expect(cheFishStateLabel('daily limit reached'), 'Story limit reached today');
    });
  });

  group('story voice only when the owner asked for a story', () {
    test('asking for a story picks the story voice', () {
      expect(cheVoicePurposeFor('CHE, tell me a bedtime story about a fox'), 'story');
      expect(cheVoicePurposeFor('Read me a short story'), 'story');
      expect(cheVoicePurposeFor('Can you make up a tale for my nephew?'), 'story');
      expect(cheVoicePurposeFor('Narrate the opening of my video'), 'story');
    });

    test('ordinary questions stay on the everyday voice', () {
      expect(cheVoicePurposeFor("What's the story with my order?"), 'conversation');
      expect(cheVoicePurposeFor('Tell me the weather'), 'conversation');
      expect(cheVoicePurposeFor('Read my messages'), 'conversation');
      expect(cheVoicePurposeFor(''), 'conversation');
    });

    test('a story clip may take longer; everyday clips keep their wait', () {
      expect(cheVoiceWait('story', everyday: const Duration(seconds: 5)), const Duration(seconds: 30));
      expect(cheVoiceWait('conversation', everyday: const Duration(seconds: 5)), const Duration(seconds: 5));
    });

    test('the wait grows with the clip, because Fish\'s time does', () {
      // A 240-character reply chunk took Fish about 8.5 s; the old fixed
      // 12 s and 5 s waits cut longer chunks off.
      expect(cheVoiceWait('conversation', everyday: const Duration(seconds: 12), chars: 40),
          const Duration(seconds: 12));
      expect(cheVoiceWait('conversation', everyday: const Duration(seconds: 12), chars: 240),
          const Duration(milliseconds: 14600));
      expect(cheVoiceWait('conversation', everyday: const Duration(seconds: 5), chars: 640),
          const Duration(seconds: 30), reason: 'never longer than 30 seconds');
      final edge = File('lib/che_edge_voice.dart').readAsStringSync();
      expect(edge, contains('chePremiumVoiceWait(purpose, chars: said.length)'));
    });

    test('the purpose reaches the one voice request', () {
      final voice = File('lib/home_state/voice.dart').readAsStringSync();
      final send = File('lib/home_state/send.dart').readAsStringSync();
      expect(voice, contains('CheEdgeVoice.speak(text, purpose: purpose, premiumOnly: true)'));
      expect(send, contains('_openSpeechTurn(purpose: cheVoicePurposeFor(message))'));
    });
  });

  group('CHE is said "Chay"', () {
    test('only the spoken words change', () {
      expect(cheSpokenText("I'm CHE. CHE's update is ready."), "I'm Chay. Chay's update is ready.");
      expect(cheSpokenText('Che here.'), 'Chay here.');
      expect(cheSpokenText('Check the cheese, CHEF.'), 'Check the cheese, CHEF.');
    });

    test('the transcript keeps CHE; the voice pipeline gets the spoken form', () {
      final voice = File('lib/home_state/voice.dart').readAsStringSync();
      expect(voice, contains('turn.add(cheSpokenText(chunk));'));
      expect(voice, contains("messages.add({'role': 'assistant', 'text': text})"));
    });
  });

  group('quiet on launch and navigation', () {
    test('the server voice is only reached from a spoken turn', () {
      // CHE speaks only in a voice conversation or on Read This. The Fish,
      // Mary and Edge voices are reached through one call, inside the speech
      // pipeline that a spoken turn opens; no screen or startup code calls it.
      final hits = <String>[];
      for (final file in Directory('lib').listSync(recursive: true).whereType<File>()) {
        if (!file.path.endsWith('.dart')) continue;
        if (file.readAsStringSync().contains('CheEdgeVoice.speak(')) hits.add(file.path.replaceAll('\\', '/'));
      }
      expect(hits, ['lib/home_state/voice.dart']);
      final voice = File('lib/home_state/voice.dart').readAsStringSync();
      final turn = voice.indexOf('CheSpeechPipeline<CheVoiceClip>? _openSpeechTurn(');
      expect(turn, greaterThan(0));
      expect(voice.indexOf('CheEdgeVoice.speak('), greaterThan(turn));
    });
  });

  group('the installed version is always visible', () {
    test('version, build and running patch', () {
      expect(
        cheInstalledSummary(
          installedLabel: 'CHE 1.4.1024603585, build 3828969674601',
          patchNumber: 2,
          patchesAvailable: true,
        ),
        'Installed: CHE 1.4.1024603585, build 3828969674601, patch 2.',
      );
    });

    test('a build without a patch says so', () {
      expect(
        cheInstalledSummary(installedLabel: 'CHE 1.4.1, build 3700', patchNumber: null, patchesAvailable: true),
        'Installed: CHE 1.4.1, build 3700, no patch yet.',
      );
      expect(
        cheInstalledSummary(installedLabel: 'CHE 1.4.1, build 3700', patchNumber: null, patchesAvailable: false),
        'Installed: CHE 1.4.1, build 3700.',
      );
    });

    test('an unreadable build is never guessed', () {
      expect(
        cheInstalledSummary(installedLabel: null, patchNumber: 3, patchesAvailable: true),
        'Installed: unknown. CHE could not read the build it is running.',
      );
    });
  });
}
