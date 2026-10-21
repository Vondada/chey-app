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
    save: async () => {},
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

test('work requested politely, or as a plain command, is work (re-review of #394)', () => {
  for (const work of [
    'Do a competitive analysis of brass lamp sellers on Etsy',
    'Have someone research the lamp market and write a summary',
    'Have the team draft three Instagram captions for the launch',
    'Tell me the top lamp trends and draft a post about them',
    'Research brass lamp suppliers and draft an outreach email, ok?',
    'Build the landing page, what do you think?',
    'Will you write a blog post about our spring collection',
    'Can you build me a landing page for the lamp store?',
    'Could you research the top 5 CRMs and draft a comparison?',
    'Can Atlas research the lamp market?',
    'I need you to build the landing page',
  ]) assert.equal(isOwnerQuestion(work), false, work);
  for (const question of ['Iris is great. Who are you?', 'Tell me a joke', 'Can you tell me who you are?', 'What should we build next?', 'Is it possible to build a rocket at home?', 'How do I make pasta?']) {
    assert.equal(isOwnerQuestion(question), true, question);
  }
});

test('agent names are names only when used as names (re-review of #394)', () => {
  const agents = (goal) => splitGoal(goal).map((s) => s.agent);
  assert.ok(!agents('Write a post about Sage green lamps and Iris flowers').includes('Sage'));
  assert.ok(!agents('Write a post about Sage green lamps and Iris flowers').includes('Iris'));
  assert.ok(!agents('Find suppliers and also iris-themed packaging ideas').includes('Iris'));
  assert.ok(!agents("Research the market and Knox's notes on the API").includes('Knox'));
  assert.deepEqual(agents('Atlas and Mira research the market together'), ['Atlas', 'Mira'], 'a shared job goes to both');
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

test('voice: "stop the Atlas task" cancels it in storage, and "review it again" re-reviews a held result', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  await che.say('Have Atlas research lamp prices and Mira write a product description from it.');
  const atlasTask = che.tasks().find((x) => x.partner_name === 'Atlas' && x.status === 'queued');
  assert.ok(atlasTask);
  await che.say('Stop the Atlas task.');
  assert.equal(che.tasks().find((x) => x.id === atlasTask.id).status, 'cancelled');
  assert.equal(che.tasks().find((x) => x.partner_name === 'Mira' && x.task.startsWith('Mira')).status, 'queued', "Mira's task is untouched");
  // A held result, then "review Mira's task again".
  const mira = che.tasks().find((x) => x.partner_name === 'Mira' && x.status === 'queued');
  Object.assign(mira, { status: 'needs_review', result: 'A product description.' });
  await che.save();
  await che.say("Review Mira's task again");
  assert.equal(che.tasks().find((x) => x.id === mira.id).status, 'review_pending');
});
