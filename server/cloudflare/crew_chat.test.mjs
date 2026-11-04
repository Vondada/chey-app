// Crew discussion questions (crew_chat.js; R-16). "What is my coding team discussing for coding job X? Show the
// crew's latest messages." went to repository inspection and returned HTTP 500 (status probes 41787795973,
// 41790544924). It is answered from the stored job and crew records: the job's latest crew messages, or that none
// exist yet.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { crewThreadReply, crewThreadRequest } from './crew_chat.js';
import { CREW_THREADS_KEY, recordCrewThread } from './conversations.js';

const Q = "What is my coding team discussing for coding job 6407f0b8? Show the crew's latest messages.";

test('a crew-discussion question names its job; other questions are not taken', () => {
  assert.deepEqual(crewThreadRequest(Q), { jobId: '6407f0b8' });
  assert.deepEqual(crewThreadRequest('Show the crew messages for job 98238043-aa31.'), { jobId: '98238043' });
  for (const q of ['Coding status', 'What is my coding team discussing?', 'Why did coding job 6407f0b8 fail?', 'Inspect your coding pipeline code.']) {
    assert.equal(crewThreadRequest(q), null, q);
  }
});

test('the reply comes from the records: a job\'s latest messages, a running job with none yet, an unknown job', () => {
  const jobs = [{ id: '6407f0b8-aaaa', status: 'running', request: 'Owner task: Jay, backtest a pairs trade' }, { id: '09b806cc-bbbb', status: 'failed', request: 'Owner task: older' }];
  const threads = [{ id: 't1', job_id: '09b806cc-bbbb', title: 'Owner task: older', outcome: 'stopped at the budget', at: '2026-11-04T10:40:00.000Z', messages: [{ from: 'Atlas', text: 'Plan: read trading_lab.js.' }, { from: 'Engineer', text: 'No usable answer from the engine.' }] }];
  assert.match(crewThreadReply({ jobId: '6407f0b8' }, { jobs, threads }), /^Coding job 6407f0b8 is running, sir\. My crew's discussion is saved when a run ends, so there is no crew record for it yet\./);
  const old = crewThreadReply({ jobId: '09b806cc' }, { jobs, threads });
  assert.match(old, /^Here are the last 2 messages from my crew on coding job 09b806cc, sir \(saved 2026-11-04 10:40 UTC\)\. Outcome: stopped at the budget\./);
  assert.match(old, /1\. Atlas: Plan: read trading_lab\.js\.\n2\. Engineer: No usable answer from the engine\./);
  assert.match(crewThreadReply({ jobId: 'deadbeef' }, { jobs, threads }), /^I have no coding job deadbeef in my records, sir/);
  // An older thread without a job id is matched by its request title.
  assert.match(crewThreadReply({ jobId: '09b806cc' }, { jobs, threads: [{ ...threads[0], job_id: undefined }] }), /^Here are the last 2 messages/);
});

test('Codex on #932: the thread linked to the job wins over a later unlinked thread with the same request', () => {
  const jobs = [{ id: '09b806cc-bbbb', status: 'failed', request: 'Owner task: older' }];
  const threads = [
    { id: 't1', job_id: '09b806cc-bbbb', title: 'Owner task: older', at: '2026-11-04T10:40:00.000Z', messages: [{ from: 'Atlas', text: 'The job\'s own plan.' }] },
    { id: 't2', title: 'Owner task: older', at: '2026-11-04T11:00:00.000Z', messages: [{ from: 'Atlas', text: 'A foreground run.' }] },
  ];
  const reply = crewThreadReply({ jobId: '09b806cc' }, { jobs, threads });
  assert.match(reply, /The job's own plan\./);
  assert.doesNotMatch(reply, /A foreground run/);
});

test('Codex on #932: an older thread with a request over 90 characters is found by the title as it was saved', async () => {
  const request = 'Owner task: Jay, backtest a pairs-trading strategy on two correlated ETFs using historical market data from 2018 through 2023.';
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); } };
  await recordCrewThread(storage, { request, discussion: [{ from: 'Atlas', msg: 'Plan.' }], outcome: 'failed' });
  const threads = saved.get(CREW_THREADS_KEY);
  assert.equal(threads[0].job_id, undefined);
  assert.match(crewThreadReply({ jobId: '98238043' }, { jobs: [{ id: '98238043-aa31', status: 'failed', request }], threads }), /^Here are the last 1 messages from my crew on coding job 98238043/);
});

test('a saved crew thread records its job id', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); } };
  await recordCrewThread(storage, { request: 'Owner task: x', discussion: [{ from: 'Atlas', msg: 'hi' }], outcome: 'done', jobId: 'abc12345' });
  assert.equal(saved.get(CREW_THREADS_KEY)[0].job_id, 'abc12345');
});

// Through the real /api/chat.
const generated = new URL('./.crew_chat.test.generated.mjs', import.meta.url);
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

test('/api/chat: the crew question is answered from the records, with no model call', async () => {
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls += 1; return { response: 'MODEL TEXT' }; } } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const data = await storage.get('che');
  const now = new Date().toISOString();
  data.jobs = [{ id: '6407f0b8-aaaa', kind: 'self_development', status: 'running', request: 'Owner task: Jay, backtest', created_at: now, updated_at: now }];
  await storage.put('che', data);
  const out = (await (await post('/api/chat', { message: Q, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.match(out.find((f) => f.type === 'delta').delta, /^Coding job 6407f0b8 is running, sir\./);
  assert.equal(out.find((f) => f.type === 'done').source, 'che_crew_thread');
  assert.equal(modelCalls, 0);
});
