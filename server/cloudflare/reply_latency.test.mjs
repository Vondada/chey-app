import assert from 'node:assert/strict';
import test from 'node:test';
import { chatModelAttempts, isLikelyCasualChat, splitReplyDeltas } from './reply_latency.js';

test('casual chat heuristic skips heavy and capability-backed turns', () => {
  assert.equal(isLikelyCasualChat('hey'), true);
  assert.equal(isLikelyCasualChat('thanks, sir'), true);
  assert.equal(isLikelyCasualChat('what time is it'), true);
  assert.equal(isLikelyCasualChat('debug this code'), false);
  assert.equal(isLikelyCasualChat('research the latest market'), false);
  assert.equal(isLikelyCasualChat('hey', ['web_research']), false);
  assert.equal(isLikelyCasualChat('x'.repeat(300)), false);
});

test('fast attempts put compact+fast route first', () => {
  const fast = chatModelAttempts({
    preferFast: true,
    model: 'fast-model',
    strongModel: 'strong-model',
    systemPrompt: 'FULL',
    compactPrompt: 'COMPACT',
    turns: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
  });
  assert.equal(fast[0].route, 'fast');
  assert.equal(fast[0].system, 'COMPACT');
  assert.equal(fast[1].route, 'quality');
  assert.equal(fast[1].system, 'FULL');

  const quality = chatModelAttempts({
    preferFast: false,
    model: 'fast-model',
    strongModel: 'strong-model',
    systemPrompt: 'FULL',
    compactPrompt: 'COMPACT',
    turns: [],
  });
  assert.equal(quality[0].route, 'quality');
  assert.equal(quality[0].system, 'FULL');
});

test('reply deltas split on sentences and rejoin to the original', () => {
  const reply = 'Hello there. Next sentence! Trailing';
  const parts = splitReplyDeltas(reply);
  assert.deepEqual(parts, ['Hello there. ', 'Next sentence! ', 'Trailing']);
  assert.equal(parts.join(''), reply);
  assert.deepEqual(splitReplyDeltas('One line'), ['One line']);
  assert.deepEqual(splitReplyDeltas(''), []);
});
