// "Collectively" in a normal follow-up produced a bare "Stopped." (2026-10-22). Only a stop tapped during that request
// may say "Stopped.", and only an explicit playback command stops speech.
import 'package:chey/che_request_session.dart';
import 'package:chey/che_speech_playback.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a stop during one request never marks the next request as stopped', () {
    final gate = CheRequestGate();
    final first = gate.begin();
    gate.cancelCurrent();
    expect(first.cancelled, isTrue);

    final second = gate.begin();
    expect(second.cancelled, isFalse, reason: 'a new request starts with no stop from the last one');
  });

  test('a stop cancels only the request that is in flight', () {
    final gate = CheRequestGate();
    final request = gate.begin();
    gate.cancelCurrent();
    expect(request.cancelled, isTrue);
    expect(gate.current.cancelled, isTrue, reason: 'the cancelled request stays the current one until the next begins');
  });

  test('ordinary conversational words are never a playback command', () {
    for (final words in ['Collectively', 'collectively, what do you think?', 'stop', 'Stop, that is not what I meant']) {
      final command = parseSpeechCommand(words);
      if (words == 'stop') {
        expect(command?.kind, 'stop');
      } else {
        expect(command, isNull, reason: words);
      }
    }
  });

  test('explicit interruptions still stop speech', () {
    for (final words in ['stop talking', 'be quiet', 'stop speaking', 'Chay, be quiet']) {
      expect(parseSpeechCommand(words)?.kind, 'stop', reason: words);
    }
  });
}
