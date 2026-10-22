import 'package:chey/che_edge_voice.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('the voice that actually spoke is named honestly', () {
    test('a reply without a label is Edge Ava, and a Mary label is kept', () {
      expect(cheEdgeEngine(null), 'edge-ava');
      expect(cheEdgeEngine('  '), 'edge-ava');
      expect(cheEdgeEngine('elevenlabs-mary'), 'elevenlabs-mary');
    });

    test('the diagnostics name each engine in plain words', () {
      expect(cheVoiceEngineLabel('elevenlabs-mary'), 'CHE voice (ElevenLabs)');
      expect(cheVoiceEngineLabel('edge-ava'), 'Edge Ava (free server voice)');
      expect(cheVoiceEngineLabel('iphone-tts'), 'iPhone system voice');
      expect(cheVoiceEngineLabel(null), '—');
      expect(cheVoiceEngineLabel(''), '—');
      expect(cheVoiceEngineLabel('some-new-engine'), 'some-new-engine');
    });
  });

  group('why Mary did not speak', () {
    test('a key at its own credit limit is not described as an empty account', () {
      final reason = cheMaryReason('key limit reached', 'edge-ava');
      expect(reason, contains('API key'));
      expect(reason, contains('may still have credits'));
      expect(reason.toLowerCase(), isNot(contains('out of credits')));
      expect(cheMaryStateLabel('key limit reached'), 'API key limit reached (account may still have credits)');
    });

    test('no reason when Mary spoke', () {
      expect(cheMaryReason('healthy', 'elevenlabs-mary'), '');
    });

    test('no reason when the server did not report Mary at all', () {
      expect(cheMaryReason('', 'edge-ava'), '');
    });

    test('a rate limit, a refused key and spent credits each say so', () {
      expect(cheMaryReason('rate-limited', 'edge-ava'),
          'Mary is resting after a rate limit');
      expect(cheMaryReason('unauthorized', 'edge-ava'), 'Mary\'s key was refused');
      expect(cheMaryReason('out of credits', 'edge-ava'), 'Mary is out of credits');
      expect(cheMaryReason('not set up', 'iphone-tts'), 'Mary is not set up on the server');
    });

    test('the state label for the diagnostics sheet matches the Keys words', () {
      expect(cheMaryStateLabel(''), 'Not asked yet this session');
      expect(cheMaryStateLabel('healthy'), 'Working');
      expect(cheMaryStateLabel('not set up'), 'Not set up on the server');
    });
  });
}
