// Master mission §5 (owner, 2026-10-21): in Agent Mode (the phone's default, agent_mode=full) an ordinary
// question is answered, not turned into Office work; work handed to a named agent goes to that agent as a
// queued task CHE reviews; and a desk's input to one chat answer is recorded as advisory, never complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { splitGoal } from './office_company.js';
import { isOwnerQuestion, shouldAutoDelegateOffice } from './work_agent_mode.js';

const generated = new URL('./.agent_routing.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Here is my answer.' }) } };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    say: async (message) => { const res = await post('/api/chat', { message, agent_mode: 'full' }, token); await res.text(); return res.status; },
    tasks: () => (saved.get('che')?.team_tasks || []),
  };
}

test('Agent Mode: ordinary questions create no Office task', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  for (const question of [
    'Who are you?',
    'How do I fix a for loop in Python that never ends?',
    'What do I prefer for answer style?',
    'What are my agents working on?',
    "What's my Gmail password?",
  ]) {
    assert.equal(await che.say(question), 200);
    assert.deepEqual(che.tasks().map((x) => `${x.partner_name}:${x.status}`), [], question);
  }
});

test('Agent Mode: work for named agents is queued for those agents; their chat input is advisory, never complete', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  await che.say('Have Atlas research lamp prices and Mira write a product description from it.');
  const queued = che.tasks().filter((x) => x.status === 'queued').map((x) => x.partner_name).sort();
  assert.deepEqual(queued, ['Atlas', 'Mira']);
  assert.ok(!che.tasks().some((x) => x.status === 'complete'), 'nothing is complete before CHE reviews it');
  for (const advice of che.tasks().filter((x) => x.status === 'advisory')) assert.equal(advice.verified_by_che, false);
});

test('a question is told apart from handing work to an agent', () => {
  assert.equal(isOwnerQuestion('Who are you?'), true);
  assert.equal(isOwnerQuestion('Chay, how do I fix a loop'), true);
  assert.equal(isOwnerQuestion('Can you have Atlas research lamp prices?'), false);
  assert.equal(isOwnerQuestion('Atlas, can you find three suppliers?'), false);
  assert.equal(isOwnerQuestion('Research the brass lamp market and draft three listings'), false);
  assert.equal(shouldAutoDelegateOffice('How do I fix a for loop in Python that never ends?', { agentMode: true }), false);
  assert.equal(shouldAutoDelegateOffice('Research the brass lamp market and draft three listings', { agentMode: true }), true);
});

test('splitGoal gives a named agent its own slice', () => {
  assert.deepEqual(splitGoal('Have Atlas research lamp prices and Mira write a product description from it.').map((s) => s.agent), ['Atlas', 'Mira']);
  assert.deepEqual(splitGoal('Knox, fix the failing Worker test').map((s) => s.agent), ['Knox']);
  assert.deepEqual(splitGoal('Build the landing page and write the FAQ').map((s) => s.agent), ['Knox', 'Mira']);
});
