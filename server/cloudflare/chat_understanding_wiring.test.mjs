// Source-level guard for the /api/chat understanding step: it must run before the
// owner gates, and the gates must read the words it resolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('the understanding step runs before the owner money/delete hold', () => {
  const understand = source.indexOf('interpretOwnerTurn(message, { history: ownerHistory');
  const resolved = source.indexOf('message = interpretation.text;');
  const hold = source.indexOf('let ownerGrant = {};');
  assert.ok(understand > 0, 'interpretOwnerTurn is wired into /api/chat');
  assert.ok(understand < resolved && resolved < hold, 'resolved words reach the gates');
});

test('a clarifying question returns before anything runs, and claims no action', () => {
  const clarify = source.indexOf('if (interpretation.clarify) {');
  const hold = source.indexOf('let ownerGrant = {};');
  const block = source.slice(clarify, hold);
  assert.ok(block.includes('clarification: true'), 'clarification is flagged in the reply');
  assert.ok(block.includes('held_for_owner: false'), 'clarification is not a hold');
  assert.ok(!/\b(deleted|sent|bought|paid|merged|published)\b/i.test(block), 'the reply does not claim anything happened');
});

test('model reading uses the fast engine only, and only through the routed AI binding', () => {
  const runner = source.slice(source.indexOf('async runInterpreterText(messages)'), source.indexOf('// Mail news found by the last background check'));
  assert.ok(runner.includes('this.env.AI.run'), 'goes through the routed AI binding');
  assert.ok(runner.includes('max_tokens: 160'), 'capped output');
  assert.ok(!/\bfetch\(/.test(runner), 'no direct provider call');
});
