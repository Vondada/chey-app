import 'dart:convert';

import 'package:chey/che_reply_outcome.dart';
import 'package:flutter_test/flutter_test.dart';

/// Runs NDJSON lines through the same tally the chat stream uses, in the same order.
CheStreamTally tallyOf(List<String> lines) {
  final tally = CheStreamTally();
  for (final line in lines) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) continue;
    tally.add(Map<String, dynamic>.from(jsonDecode(trimmed)));
  }
  return tally;
}

const delta = '{"type":"delta","delta":"Hello, sir."}';
const done = '{"type":"done","model":"x","request_id":"req-42"}';
const step = '{"type":"step","text":"Looking it up"}';

void main() {
  test('a stream with no frames at all is noFrames, and the message does not claim nothing ran', () {
    final tally = tallyOf([]);
    expect(tally.end, CheStreamEnd.noFrames);
    final message = cheNoReplyMessage(tally.end);
    expect(message, isNot(contains('Nothing was run')));
    expect(message, contains('I will not say'));
  });

  test('a complete reply (delta then done) is done and keeps its text', () {
    final tally = tallyOf([delta, done]);
    expect(tally.end, CheStreamEnd.done);
    expect(tally.requestId, 'req-42');
    expect(cheFinalReplyText('Hello, sir.', tally.end), 'Hello, sir.');
  });

  test('a stream cut off after its delta keeps the partial text, with a note that it was cut off', () {
    final tally = tallyOf([delta]);
    expect(tally.end, CheStreamEnd.cutOff);
    final text = cheFinalReplyText('Hello, sir.', tally.end);
    expect(text, startsWith('Hello, sir.'));
    expect(text, contains('cut off'));
    expect(text, isNot(contains('Nothing was run')));
  });

  test('a stream that sent only steps and then stopped is cutOff, with no reply text', () {
    final tally = tallyOf([step, step]);
    expect(tally.end, CheStreamEnd.cutOff);
    final text = cheFinalReplyText('', tally.end);
    expect(text, cheNoReplyMessage(CheStreamEnd.cutOff));
    expect(text, contains('may already have run'));
    expect(text, isNot(contains('Nothing was run')));
  });

  test('a done frame with no reply text gets the done message, not a claim about execution', () {
    final tally = tallyOf([done]);
    expect(tally.end, CheStreamEnd.done);
    expect(cheFinalReplyText('', tally.end), cheNoReplyMessage(CheStreamEnd.done));
  });

  test('an owner-approval hold (a plain JSON answer, no type) is complete, not cut off', () {
    final tally = tallyOf(['{"message":"Shall I go ahead?","held_for_owner":true}']);
    expect(tally.end, CheStreamEnd.done);
  });

  test('an unknown frame type alone is still cut off, never done', () {
    final tally = tallyOf(['{"type":"tool_result","text":"partial"}']);
    expect(tally.end, CheStreamEnd.cutOff);
  });

  test('no message in any ending says that nothing ran', () {
    for (final end in CheStreamEnd.values) {
      expect(cheNoReplyMessage(end), isNot(contains('Nothing was run')), reason: '$end');
      expect(cheFinalReplyText('', end), isNot(contains('Nothing was run')), reason: '$end');
      expect(cheFinalReplyText('partial', end), isNot(contains('Nothing was run')), reason: '$end');
    }
  });

  test('a picture job started in a stream that was then cut off: the message does not repeat the start', () {
    // The Worker sent its step before the picture started and then the stream was cut. The owner gets the cut-off
    // message, not a second picture: nothing here re-sends the turn.
    final tally = tallyOf(['{"type":"step","text":"Making the picture"}']);
    expect(tally.end, CheStreamEnd.cutOff);
    expect(cheNoReplyMessage(tally.end), contains('I have not run it again'));
  });
}
