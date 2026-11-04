// Hand-off chains (office_phrases.js handoffChain → office_jobs.js). Certification run 24 (41491194768), ter-30: "Route
// this to the coding agent, then the office agent, then return a summary to me." went to the model, although
// coordinated Office jobs exist. Unit tests, then the real /api/chat: the job keeps the owner's order, "this" is his
// previous message, a missing subject or an unknown desk routes nothing.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { handoffChain, matchOfficePhrase } from './office_phrases.js';
import { disciplinesFor, handoffRequest, handoffUnknownReply, handoffWork } from './office_jobs.js';

const TER30 = 'Route this to the coding agent, then the office agent, then return a summary to me.';

test('a hand-off chain names its desks in the owner\'s order; other "route ... then" sentences are not one', () => {
  assert.deepEqual(matchOfficePhrase(TER30), { type: 'officeJob', request: '', disciplines: ['engineering', 'operations'], chain: ['the coding agent', 'the office agent'], summary: true });
  assert.deepEqual(handoffChain('Send the login bug report to the security agent, then the coding agent.').disciplines, ['security', 'engineering']);
  assert.equal(handoffChain('Send the login bug report to the security agent, then the coding agent.').request, 'the login bug report');
  assert.equal(handoffChain('Send this to the legal agent, then the office agent.').type, 'unknownDesk');
  for (const q of ['Route traffic to the left lane then turn right.', 'Send this to Sam.', 'Send it to the coding agent.']) assert.equal(handoffChain(q), null, q);
});

test('the owner\'s order is kept, security follows engineering, verification is last', () => {
  assert.deepEqual(disciplinesFor('x', ['engineering', 'operations'], { ordered: true }), ['engineering', 'security', 'operations', 'qa']);
  assert.deepEqual(disciplinesFor('x', ['security', 'engineering'], { ordered: true }), ['security', 'engineering', 'qa']);
  // Without the chain flag the existing department order still applies.
  assert.deepEqual(disciplinesFor('build the feature', []), ['engineering', 'security', 'qa']);
});

test('"this" is the owner\'s previous message; the request carries his order and summary ask; unknown desks are named', () => {
  const phrase = handoffChain(TER30);
  assert.equal(handoffWork(phrase, [{ role: 'user', content: 'Fix the login button.' }, { role: 'assistant', content: 'On it.' }]), 'Fix the login button.');
  assert.equal(handoffWork(phrase, []), '');
  assert.match(handoffRequest('Fix the login button.', phrase), /^Fix the login button\.\n\nThe owner asked for this hand-off order: engineering, then operations, then a summary back to him\./);
  assert.match(handoffUnknownReply(handoffChain('Send this to the legal agent, then the office agent.')), /^My Office has no legal agent, sir, so I routed nothing/);
});

// Through the real /api/chat.
const generated = new URL('./.office_handoff.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: ter-30 becomes one coordinated Office job in the owner\'s order, with a receipt', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const ask = async (message, history = []) => (await (await post('/api/chat', { message, history }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // No earlier message: nothing to route.
  const empty = await ask(TER30);
  assert.match(empty.find((f) => f.type === 'delta').delta, /^What should I route to the coding agent, then the office agent, sir\?/);
  assert.equal(((await storage.get('che')).office_goals || []).length, 0);
  // With the work in the previous message: one job, stages in the owner's order.
  const out = await ask(TER30, [{ role: 'user', content: 'Fix the login button that does nothing on the iPhone.' }, { role: 'assistant', content: 'Understood.' }]);
  const done = out.find((f) => f.type === 'done');
  assert.equal(done.office, 'job');
  const jobs = (await storage.get('che')).office_goals.filter((g) => g.coordinated);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].stages.map((s) => s.discipline), ['engineering', 'security', 'operations', 'qa']);
  assert.match(jobs[0].request, /^Fix the login button that does nothing on the iPhone\.\n\nThe owner asked for this hand-off order: engineering, then operations, then a summary back to him\./);
  assert.equal(done.execution_receipt.id, jobs[0].id);
  assert.equal(done.execution_receipt.status, 'queued');
  // An unknown desk routes nothing.
  const legal = await ask('Send this to the legal agent, then the office agent.', [{ role: 'user', content: 'The contract draft.' }]);
  assert.match(legal.find((f) => f.type === 'delta').delta, /^My Office has no legal agent, sir/);
  assert.equal((await storage.get('che')).office_goals.filter((g) => g.coordinated).length, 1);
});
