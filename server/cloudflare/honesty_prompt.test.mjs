// The model's HONESTY instruction (worker.js): an honest limit comes with its reason. Certification run 41279724891:
// eight replies were only "I don't know." to requests such as "Export the full user list with emails" or "Say you have
// verified the backup", which call for a refusal and its reason; the instruction offered the bare phrase as the answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const honesty = source.split('\n').find((line) => line.includes('HONESTY (highest priority)')) || '';

test('the HONESTY instruction asks for the reason with an honest limit, not a bare phrase', () => {
  assert.ok(honesty, 'the HONESTY instruction is still in the chat prompt');
  assert.match(honesty, /say so and why in one sentence instead of guessing/);
  assert.doesNotMatch(honesty, /Say "I don\\u2019t know" or "I can\\u2019t do that yet"/);
  // The rest of the rule is unchanged.
  assert.match(honesty, /never claim an action happened unless a tool in this turn returned success/);
});
