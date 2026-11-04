// Capability acquisition (capability_acquisition.js): "Do X. If you cannot, find what's missing, build it and show it
// works." Certification challenge run 41726903209 (owner's unknown-capability challenge, 2026-11-03): CHE queued a
// coding job without trying the task, said nothing about what was missing, and the job could never run because Office
// autonomy was paused. Unit tests on plain data, then the real /api/chat and the real alarm with in-memory storage.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { acquireCapability, acquisitionJobRequest, acquisitionRequest, attemptOutcome, gapId, recordGap } from './capability_acquisition.js';
import { CAPABILITY_REGISTRY_KEY } from './capability_registry.js';
import { intelligenceIntent } from './historical_intelligence.js';
import { tradingIntent } from './trading_lab.js';

const CHALLENGE = "Jay, backtest a pairs-trading strategy on two correlated ETFs using historical market data from 2018 through 2023. If you cannot perform this today, independently determine what's missing, find the solution, implement the capability, and demonstrate that it works.";
const TASK = 'Jay, backtest a pairs-trading strategy on two correlated ETFs using historical market data from 2018 through 2023.';

test('an acquisition request splits into the task and the owner\'s "if you cannot, build it"', () => {
  const out = acquisitionRequest(CHALLENGE);
  assert.equal(out.task, TASK);
  assert.match(out.clause, /^If you cannot perform this today/);
  assert.equal(acquisitionRequest("Make me a jazz playlist. If you can't do that yet, build the feature for it.").task, 'Make me a jazz playlist.');
  assert.equal(acquisitionRequest('Summarise my unread email, and if you are unable to, add that ability.').task, 'Summarise my unread email.');
  for (const q of [
    "If you can't, build it.", // no task of its own
    'What would you do if you cannot implement it?', // a question about the idea
    'Send Bob $50. If you cannot, add the ability.', // money is never built this way
    'Delete my old photos. If you cannot, build a tool for it.', // nor deletion
    'Backtest SPY since 2020.', // no acquisition clause: the trading lab answers it as before
    'Backtest SPY. If you cannot, tell me why.', // asks for a reason, not a build
  ]) assert.equal(acquisitionRequest(q), null, q);
});

test('the try decides: a success receipt is done; anything else is the diagnosis, in the tool\'s own words', () => {
  assert.equal(attemptOutcome({ ok: true, reply: 'Done.', done: { source: 'che_lists' }, receipts: [{ status: 'success' }] }).done, true);
  const declined = attemptOutcome({ ok: true, reply: "I can't run that backtest, sir: one market at a time.", done: { source: 'che_trading' }, receipts: [] });
  assert.deepEqual([declined.done, declined.declined, declined.route], [false, true, 'che_trading']);
  // Handled with no receipt and no refusal (Codex review on #920: "Paper trade SPY" adds SPY without a receipt): not a gap.
  assert.equal(attemptOutcome({ ok: true, reply: 'Added SPY to your paper watchlist, sir.', done: { source: 'che_trading' }, receipts: [] }).declined, false);
  // Queued, awaiting approval or not run is not a result.
  assert.equal(attemptOutcome({ reply: 'Queued.', done: { source: 'x' }, receipts: [{ status: 'queued' }] }).done, false);
  assert.equal(attemptOutcome({ reply: '', done: {}, receipts: [] }).route, 'model');
  const prompt = acquisitionJobRequest(acquisitionRequest(CHALLENGE), declined);
  assert.match(prompt, /^Owner task: Jay, backtest a pairs-trading strategy/);
  assert.match(prompt, /the che_trading route answered: "I can't run that backtest, sir: one market at a time\."/);
  assert.match(prompt, /Open a pull request only: do not merge, deploy, spend money, place any live trade/);
  // The owner's "do not open a PR" reaches the job's own instructions (Codex review on #920).
  assert.match(acquisitionJobRequest(acquisitionRequest(CHALLENGE), declined, { openPr: false }), /do not open a pull request, because the owner said not to/);
});

test('one turn: try, diagnose, queue; nothing is queued when the try worked or the turn may not build', async () => {
  const acquire = acquisitionRequest(CHALLENGE);
  const declined = { ok: true, reply: "I can't run that backtest, sir: my backtests test one market at a time.", done: { source: 'che_trading_lab' }, receipts: [] };
  const queuedTexts = [];
  const frames = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const built = await frames(await acquireCapability(acquire, { tryTurn: async (task) => { assert.equal(task, TASK); return declined; }, queue: async (text) => { queuedTexts.push(text); return { job: { id: 'job-1234abcd', status: 'queued' } }; } }));
  const reply = built[0].delta;
  assert.match(reply, /^I tried it first, sir\. My trading lab route answered: "I can't run that backtest/);
  assert.match(reply, /I queued coding job job-1234 to build it/);
  assert.match(reply, /Nothing merges or deploys until you approve it/);
  assert.equal(queuedTexts.length, 1);
  assert.deepEqual(built[1].execution_receipts.map((r) => [r.operation, r.status]), [['attempt', 'failed'], ['coding_job', 'queued']]);
  // Worked on the try: its reply and receipts, nothing built.
  const done = await frames(await acquireCapability(acquire, { tryTurn: async () => ({ ok: true, reply: 'Backtest done.', done: { source: 'che_trading_lab' }, receipts: [{ tool: 'backtest', status: 'success' }] }), queue: async () => assert.fail('nothing to build') }));
  assert.equal(done[0].delta, 'Backtest done.');
  assert.equal(done[1].source, 'che_capability_acquisition');
  // Handled without a refusal: the try's answer stands, nothing is built.
  const handled = await frames(await acquireCapability(acquire, { tryTurn: async () => ({ ok: true, reply: 'Added SPY, sir.', done: { source: 'che_trading' }, receipts: [] }), queue: async () => assert.fail('nothing to build') }));
  assert.match(handled[0].delta, /^Added SPY, sir\. I did not start a coding job: my trading route handled it and did not say it was unable\./);
  // No build allowed (a certification turn the owner did not authorize): the diagnosis, and a not_run job receipt.
  const probe = await frames(await acquireCapability(acquire, { tryTurn: async () => declined, queue: null }));
  assert.match(probe[0].delta, /I did not start a coding job: this is a certification turn/);
  assert.deepEqual(probe[1].execution_receipts.map((r) => r.status), ['failed', 'not_run']);
});

test('the missing ability is saved in the capability registry as DISCOVERED, never usable', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const acquire = acquisitionRequest(CHALLENGE);
  await recordGap(storage, acquire, { route: 'che_trading_lab', reply: "I can't run that backtest." }, 'job-1');
  const cap = saved.get(CAPABILITY_REGISTRY_KEY).capabilities[gapId(acquire.task)];
  assert.equal(cap.status, 'DISCOVERED');
  assert.equal(cap.implementation_location, 'coding job job-1');
  assert.match(cap.known_limitations[0], /^che_trading_lab: I can't run that backtest/);
  assert.match(gapId(acquire.task), /^acquire\.backtest_a_pairs_trading_strategy/);
});

test('a pairs backtest is the strategy lab\'s, not the Nasdaq history study\'s, and "Jay," still reads as a command', () => {
  assert.equal(intelligenceIntent(TASK), null);
  assert.ok(intelligenceIntent('Run the historical study on NQ since 2010.'));
  const lab = tradingIntent(TASK);
  assert.equal(lab?.kind, 'decline');
  assert.match(lab.question, /one market at a time/);
  assert.equal(tradingIntent('Jay, backtest SPY since 2020.')?.kind, 'backtest');
});

// Through the real /api/chat, the probe route and the alarm.
const generated = new URL('./.capability_acquisition.test.generated.mjs', import.meta.url);
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
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

function setup() {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  return { env, storage, state, post };
}

test('/api/chat: the owner\'s challenge is tried through the trading route, diagnosed, queued as an owner job and registered', async () => {
  const { storage, post } = setup();
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const data = await storage.get('che');
  data.autonomy = false; // the owner's Office autonomy is paused, as in production
  await storage.put('che', data);
  const frames = (await (await post('/api/chat', { message: CHALLENGE, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const text = frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('');
  const done = frames.find((f) => f.type === 'done');
  assert.equal(done.source, 'che_self_development');
  assert.equal(done.attempt_route, 'che_trading');
  assert.match(text, /I tried it first, sir\. My trading route answered: "I can't run that backtest, sir: my backtests test one market at a time/);
  const jobs = (await storage.get('che')).jobs.filter((j) => j.kind === 'self_development');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].owner_requested, true);
  assert.equal(jobs[0].id, done.background_job_id);
  assert.match(jobs[0].request, /^Owner task: Jay, backtest a pairs-trading strategy/);
  assert.doesNotMatch(text, /autonomy is paused/, 'the owner\'s own request is not held by the Office pause');
  assert.equal((await storage.get(CAPABILITY_REGISTRY_KEY)).capabilities[gapId(TASK)].status, 'DISCOVERED');
});

test('/api/chat: "do not open a PR" is kept on the job, and a task that already works starts no coding job', async () => {
  const { storage, post } = setup();
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const ask = async (message) => (await (await post('/api/chat', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await ask(`${CHALLENGE} Do not open a PR.`);
  const jobs = (await storage.get('che')).jobs.filter((j) => j.kind === 'self_development');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].no_pr, true);
  assert.match(jobs[0].request, /do not open a pull request, because the owner said not to/);
  const before = (await storage.get('che')).jobs.length;
  const frames = await ask('Paper trade SPY for me. If you cannot, implement the capability in your code.');
  assert.equal(frames.find((f) => f.type === 'done').source, 'che_capability_acquisition');
  assert.equal((await storage.get('che')).jobs.filter((j) => j.kind === 'self_development').length, 1, 'no coding job for a task the route handled');
  assert.ok((await storage.get('che')).jobs.length >= before);
});

test('probe: a certification turn diagnoses but queues nothing, unless the owner authorized the run', async () => {
  const { storage, state } = setup();
  const plain = await state.probeChat({ message: CHALLENGE });
  assert.match(plain.reply, /I did not start a coding job: this is a certification turn/);
  assert.deepEqual(plain.execution_receipts.map((r) => r.status), ['failed', 'not_run']);
  assert.equal(((await storage.get('che'))?.jobs || []).filter((j) => j.kind === 'self_development').length, 0);
  const authorized = await state.probeChat({ message: CHALLENGE, authorize_build: true });
  assert.match(authorized.reply, /I queued coding job [0-9a-f]{8} to build it/);
  const jobs = (await storage.get('che')).jobs.filter((j) => j.kind === 'self_development');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].owner_requested, true);
});

test('alarm with autonomy paused: the owner-requested coding job runs; other paused coding work still waits', async () => {
  const { storage, state } = setup();
  const now = new Date().toISOString();
  await storage.put('che', { autonomy: false, devices: {}, memories: [], jobs: [
    { id: 'owner', kind: 'self_development', prompt: 'Owner task: x', request: 'Owner task: x', owner_requested: true, status: 'queued', attempts: 0, retry_at: 0, created_at: now, updated_at: now },
    { id: 'self', kind: 'self_development', prompt: 'Add ability: y', request: 'y', status: 'queued', attempts: 0, retry_at: 0, created_at: now, updated_at: now },
  ] });
  await state.alarm();
  const jobs = Object.fromEntries((await storage.get('che')).jobs.map((j) => [j.id, j]));
  assert.equal(jobs.owner.attempts, 1, 'the owner-requested job was started');
  assert.notEqual(jobs.owner.status, 'queued');
  assert.equal(jobs.self.attempts, 0, 'a job the owner did not ask for waits for "resume"');
  assert.equal(jobs.self.status, 'queued');
});

test('a coding run that stopped at its time limit continues: no retry or attempt is used, and continuations are bounded', () => {
  const { state } = setup();
  const error = Object.assign(new Error('time limit'), { failure_class: 'B', continuation: true, checkpoint: { genuine_passes: 1, round_offset: 1 } });
  const out = state.jobFailureOutcome({ id: 'j', attempts: 4, retry_count: 2, continuations: 0 }, error);
  assert.deepEqual([out.status, out.attempts, out.continuations, out.retry_count], ['queued', 3, 1, undefined]);
  assert.equal(out.checkpoint.round_offset, 1);
  assert.ok(out.retry_at - Date.now() <= 60_000);
  // After eight continuations the ordinary retry rule applies again.
  const capped = state.jobFailureOutcome({ id: 'j', attempts: 4, retry_count: 2, continuations: 8 }, error);
  assert.equal(capped.dead_letter, true);
});

test('a run cut off by a new Worker version gets its attempt back; an ordinary interruption still counts (challenge job fa1d318a)', async () => {
  const { env, storage, state } = setup();
  env.CF_VERSION_METADATA = { id: 'v2' };
  const old = new Date(Date.now() - 25 * 60_000).toISOString();
  const job = (id, extra) => ({ id, kind: 'self_development', prompt: 'Owner task: x', request: 'Owner task: x', owner_requested: true, status: 'running', attempts: 4, created_at: old, updated_at: old, ...extra });
  await storage.put('che', { autonomy: false, devices: {}, memories: [], jobs: [
    job('redeployed', { worker_version: 'v1' }),
    job('same', { worker_version: 'v2' }),
    job('capped', { worker_version: 'v1', redeploys: 8 }),
  ] });
  await state.alarm();
  const jobs = Object.fromEntries((await storage.get('che')).jobs.map((j) => [j.id, j]));
  assert.deepEqual([jobs.redeployed.status, jobs.redeployed.attempts, jobs.redeployed.redeploys, Boolean(jobs.redeployed.dead_letter)], ['queued', 3, 1, false]);
  assert.ok(jobs.redeployed.retry_at - Date.now() <= 60_000);
  assert.match(jobs.redeployed.activity.at(-1).text, /new Worker version restarted this run/);
  // The same version: the run itself was cut off, so the attempt ceiling applies as before.
  assert.equal(jobs.same.dead_letter, true);
  // After eight redeploys the ordinary rule applies again.
  assert.equal(jobs.capped.dead_letter, true);
});

test('a job that starts records the Worker version it runs on', async () => {
  const { env, storage, state } = setup();
  env.CF_VERSION_METADATA = { id: 'v7' };
  const now = new Date().toISOString();
  await storage.put('che', { autonomy: false, devices: {}, memories: [], jobs: [
    { id: 'owner', kind: 'self_development', prompt: 'Owner task: x', request: 'Owner task: x', owner_requested: true, status: 'queued', attempts: 0, retry_at: 0, created_at: now, updated_at: now },
  ] });
  await state.alarm();
  assert.equal((await storage.get('che')).jobs[0].worker_version, 'v7');
});
