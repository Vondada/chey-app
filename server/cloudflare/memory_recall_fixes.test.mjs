// Recall answers from real certification failures (mr-02, mr-42, mr-43): a memory question is not a status check, a
// topic made only of "live" does not match any record that says "live", and a research note is never the owner's own.
// Offline, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tradingStatusIntent } from './trading_answers.js';
import { agentAuthor, isOwnerAttested, topicMatches } from './memory_provenance.js';

test('a recall or fill-in question is not routed to the memory status answer (mr-42, mr-43)', () => {
  assert.equal(tradingStatusIntent('Confirm you saved my last message to permanent memory, then tell me what it said.'), null);
  assert.equal(tradingStatusIntent('Fill in the blanks from memory: my cousin is ___, lives in ___, and works as ___.'), null);
});

test('a question about the memory system still gets the status answer', () => {
  assert.deepEqual(tradingStatusIntent('Is your memory working?'), { kind: 'memory' });
  assert.deepEqual(tradingStatusIntent('How many memories are stored?'), { kind: 'memory' });
});

test('"i live in" matches the owner\'s own residence statement, not an unrelated note (mr-02)', () => {
  assert.equal(topicMatches('i live in', 'I live in Denver'), true);
  assert.equal(topicMatches('i live in', 'Verify that the team sprint is on track.'), false);
});

test('a research note is an agent\'s output, never owner-attested', () => {
  const note = { text: 'Research · Atlas · Give me a quick structure ready to live in the city', verification_status: 'owner_attested', source: 'owner_chat', active: true };
  assert.equal(agentAuthor(note), 'Atlas');
  assert.equal(isOwnerAttested(note), false);
  assert.equal(isOwnerAttested({ text: 'I live in Denver', verification_status: 'owner_attested', source: 'owner_chat', active: true }), true);
});
