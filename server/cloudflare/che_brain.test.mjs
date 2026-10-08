import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remember, recall, brainSize } from './che_brain.js';

function memoryStore() {
  const data = new Map();
  return { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); } };
}

test('a fact or fix without evidence is refused', async () => {
  const s = memoryStore();
  assert.deepEqual(await remember(s, { kind: 'fact', text: 'The Worker uses Durable Objects' }), { saved: false, reason: 'evidence_required' });
  assert.deepEqual(await remember(s, { kind: 'fix', text: 'Raise the cap' }), { saved: false, reason: 'evidence_required' });
  assert.equal(await brainSize(s), 0);
});

test('a fact with evidence is saved, and a duplicate is not saved twice', async () => {
  const s = memoryStore();
  const f = { kind: 'fact', text: 'CHE_STATE is a SQLite Durable Object', evidence: 'server/cloudflare/wrangler.jsonc:14-18', agent: 'Atlas', source: 'job-7' };
  assert.equal((await remember(s, f)).saved, true);
  assert.equal((await remember(s, f)).reason, 'duplicate');
  assert.equal(await brainSize(s), 1);
});

test('unknown kinds and empty text are refused', async () => {
  const s = memoryStore();
  assert.equal((await remember(s, { kind: 'rumour', text: 'something' })).reason, 'unknown_kind');
  assert.equal((await remember(s, { kind: 'lesson', text: 'ok' })).reason, 'too_short');
});

test('one agent writes a lesson and another agent finds it when it matches', async () => {
  const s = memoryStore();
  await remember(s, { kind: 'lesson', text: 'Always read the owner settings before changing the Soul prompt', agent: 'Nova' });
  await remember(s, { kind: 'lesson', text: 'Keep Flutter widgets under 300 lines', agent: 'Mira' });
  const hits = await recall(s, 'Where do I change the Soul prompt?');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].agent, 'Nova');
  assert.deepEqual(await recall(s, 'what is the weather'), []);
});
