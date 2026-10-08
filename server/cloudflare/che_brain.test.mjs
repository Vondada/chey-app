import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remember, recall, brainSize, promote } from './che_brain.js';

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

test('an agent finds its own lesson by its words; another agent does not see it', async () => {
  const s = memoryStore();
  await remember(s, { kind: 'lesson', text: 'Always read the owner settings before changing the Soul prompt', agent: 'Nova' });
  await remember(s, { kind: 'lesson', text: 'Keep Flutter widgets under 300 lines', agent: 'Mira' });
  const hits = await recall(s, 'Where do I change the Soul prompt?', { agent: 'Nova' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].agent, 'Nova');
  assert.equal((await recall(s, 'Soul prompt', { agent: 'Mira' })).length, 0);
  assert.deepEqual(await recall(s, 'what is the weather', { agent: 'Nova' }), []);
});

test('an agent brain is private until promoted; promotion needs evidence or review', async () => {
  const s = memoryStore();
  const own = await remember(s, { kind: 'lesson', text: 'Atlas checks Flutter analyze before pushing', agent: 'Atlas' });
  assert.equal((await recall(s, 'Flutter analyze', { agent: 'Mira' })).length, 0, 'Mira cannot see Atlas private entry');
  assert.equal((await recall(s, 'Flutter analyze', { agent: 'Atlas' })).length, 1, 'Atlas sees its own entry');
  assert.deepEqual(await promote(s, 'Atlas', own.id), { promoted: false, reason: 'needs_evidence_or_review' });
  const withEvidence = await remember(s, { kind: 'fact', text: 'Flutter analyze runs in the PR check', evidence: '.github/workflows/ci.yml:12', agent: 'Atlas' });
  assert.equal((await promote(s, 'Atlas', withEvidence.id)).promoted, true);
  assert.equal((await recall(s, 'Flutter analyze', { agent: 'Mira' })).length, 1, 'Mira sees the promoted shared fact');
  assert.equal(await brainSize(s, 'shared'), 1);
});

test('promote refuses another agent\'s entry', async () => {
  const s = memoryStore();
  const e = await remember(s, { kind: 'lesson', text: 'Knox keeps the spend log up to date', agent: 'Knox', reviewed: true });
  assert.equal((await promote(s, 'Nova', e.id)).reason, 'not_found');
});
