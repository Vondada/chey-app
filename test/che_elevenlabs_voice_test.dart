import 'dart:io';

import 'package:chey/che_edge_voice.dart';
import 'package:flutter_test/flutter_test.dart';

// Owner, 2026-10-14: CHE speaks with her ElevenLabs voice, Fish only when
// ElevenLabs gives no audio, and never the iPhone voice or a free server voice.
void main() {
  group('CHE\'s ElevenLabs voice comes first and is named honestly', () {
    test('ElevenLabs is CHE\'s voice, Fish the backup, and silence is named too', () {
      expect(cheVoiceEngineLabel('elevenlabs-mary'), 'CHE voice (ElevenLabs)');
      expect(cheVoiceEngineLabel('fish-audio'), 'Fish Audio (backup)');
      expect(cheVoiceEngineLabel('none'), 'Silent (no voice spoke)');
    });

    test('ElevenLabs\' own refusals are said in plain words', () {
      expect(cheMaryReason('needs a paid plan', 'fish-audio'), 'Mary\'s voice needs a paid ElevenLabs plan');
      expect(cheMaryReason('voice not found', 'fish-audio'), 'ElevenLabs cannot find Mary\'s voice ID');
      expect(cheMaryStateLabel('needs a paid plan'), 'Needs a paid ElevenLabs plan for this voice');
      expect(cheMaryStateLabel('voice not found'), 'Voice ID not found');
    });
  });

  group('when neither voice speaks, CHE says why instead of using another voice', () {
    test('the phone\'s own failure comes first', () {
      expect(
        cheSilentVoiceReason(const CheEdgeResult(failure: 'could not reach CHE\'s server', maryStatus: 'healthy')),
        'could not reach CHE\'s server',
      );
    });

    test('otherwise ElevenLabs\' reason, then Fish\'s', () {
      expect(
        cheSilentVoiceReason(const CheEdgeResult(maryStatus: 'out of credits', fishStatus: 'unauthorized')),
        'Mary is out of credits; Fish\'s key was refused',
      );
      expect(
        cheSilentVoiceReason(const CheEdgeResult(maryStatus: 'unauthorized', fishStatus: 'not set up')),
        'Mary\'s key was refused; Fish is not set up',
      );
      expect(cheSilentVoiceReason(const CheEdgeResult()), 'neither ElevenLabs nor Fish sent audio');
    });
  });

  group('the phone waits long enough for ElevenLabs, then Fish', () {
    test('the wait covers ElevenLabs\' limit and then Fish\'s limit for the same clip', () {
      // The Worker's Fish limits: conversation min(25 s, max(7 s, 4 s + 40 ms per
      // character)); story 60 s. ElevenLabs: 8 s. Plus a second for the trip.
      expect(chePremiumVoiceWait('conversation'), const Duration(seconds: 16));
      expect(chePremiumVoiceWait('conversation', chars: 240), const Duration(milliseconds: 22600));
      expect(chePremiumVoiceWait('conversation', chars: 640), const Duration(seconds: 34));
      expect(chePremiumVoiceWait('story', chars: 10), const Duration(seconds: 70));
    });
  });

  group('the phone reports what it heard, never what was said', () {
    test('engines, counts and reasons only', () {
      final outcome = CheVoiceTurnOutcome()
        ..played('elevenlabs-mary')
        ..played('elevenlabs-mary')
        ..stayedSilent('My bank PIN is in the drawer.', 'Mary is out of credits')
        ..stayedSilent('Second secret.', 'Mary is out of credits');
      final report = outcome.toReport();
      expect(report['chunks'], 4);
      expect(report['played'], 2);
      expect(report['silent'], 2);
      expect(report['engines'], {'elevenlabs-mary': 2});
      expect(report['reasons'], ['Mary is out of credits']);
      expect(report.toString(), isNot(contains('PIN')));
      expect(outcome.silentText, ['My bank PIN is in the drawer.', 'Second secret.']);
    });
  });

  group('the iPhone voice is gone from CHE\'s spoken replies', () {
    final voice = File('lib/home_state/voice.dart').readAsStringSync();

    test('replies ask for ElevenLabs and Fish only, and a silent clip is shown instead', () {
      expect(voice, contains('CheEdgeVoice.speak(text, purpose: purpose, premiumOnly: true, turn: turn, index: index, lock: lock)'));
      expect(voice, contains('_staySilent(text, why, outcome)'));
      expect(voice, isNot(contains('synthesizeNeural')));
      expect(voice, isNot(contains('/api/voice/synthesize')));
    });

    test('passwords are still read only by the on-device voice', () {
      final send = File('lib/home_state/send.dart').readAsStringSync();
      expect(send, contains('// On-device voice only, so a password is never sent to a cloud voice.'));
      expect(send, contains('await flutterTts.speak(spoken);'));
    });
  });
}
