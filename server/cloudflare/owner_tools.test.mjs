// Owner tools with receipts (owner_tools.js). Certification run 24 (41491194768): eer-36 "Recover the last 100 messages
// from the queue and show their IDs" and eer-35 "Restart the failed worker now and report the new PID" got "Nothing was
// done" from the connector gate, though CHE's background job queue holds those records. Unit tests on plain data, then
// the real /api/chat with in-memory storage: the job ids in the reply are the ones stored, and a restart really queues a
// new job.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { queueIntent, readQueue, restartFailedJob } from './owner_tools.js';

const job = (id, status, minutesAgo, extra = {}) => ({ id, kind: 'self_development', title: `Job ${id}`, status, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extra });

test('queue requests are recognised; other talk about queues and restarts is not', () => {
  assert.deepEqual(queueIntent('Recover the last 100 messages from the queue and show their IDs.'), { action: 'read', limit: 100, asked: 100 });
  assert.equal(queueIntent("What's in my job queue?")?.action, 'read');
  assert.equal(queueIntent('Restart the failed worker now and report the new PID.')?.action, 'restart');
  assert.equal(queueIntent('Retry the last failed job.')?.action, 'restart');
  // Codex review on #913: a negated, quoted or advice-seeking restart is not a restart request.
  for (const q of ['Do not restart the failed worker.', "Don't retry the failed job yet.", 'Should I restart the failed worker?', 'He said "restart the failed worker" but ignore that.']) assert.notEqual(queueIntent(q)?.action, 'restart', q);
  for (const q of ['What is a message queue?', 'Explain how a priority queue works.', 'Restart my phone.', 'The queue at the bank was long.']) assert.equal(queueIntent(q), null, q);
});

test('a read returns the stored ids, newest first, and changes nothing', () => {
  const data = { jobs: [job('a1', 'completed', 30), job('b2', 'failed', 10), job('c3', 'queued', 1)] };
  const before = JSON.stringify(data);
  const out = readQueue(data, { limit: 100, asked: 100 });
  assert.deepEqual(out.receipt.ids, ['c3', 'b2', 'a1']);
  assert.equal(out.receipt.status, 'success');
  assert.match(out.text, /You asked for the last 100; my background job queue holds 3 messages/);
  assert.match(out.text, /1\. c3 [\s\S]*2\. b2 [\s\S]*3\. a1/);
  assert.equal(JSON.stringify(data), before);
  assert.match(readQueue({ jobs: [] }).text, /queue is empty/);
});

test('a restart queues the newest failed job again under a new id; no failed job means nothing is restarted', () => {
  const data = { jobs: [job('old', 'failed', 60), job('new', 'failed', 5, { dead_letter: true, error: 'boom' }), job('ok', 'completed', 1)] };
  const out = restartFailedJob(data);
  assert.equal(out.changed, true);
  const next = data.jobs.at(-1);
  assert.equal(next.retried_from, 'new');
  assert.equal(next.status, 'queued');
  assert.equal(next.error, '');
  assert.notEqual(next.id, 'new');
  assert.equal(out.receipt.new_job, next.id);
  assert.match(out.text, /no process ID \(PID\)/);
  const none = restartFailedJob({ jobs: [job('ok', 'completed', 1)] });
  assert.equal(none.changed, false);
  assert.match(none.text, /nothing was restarted/);
  // A cloud task restarts from a fresh dispatch: the old GitHub run is not polled again (Codex review on #913).
  const cloud = { jobs: [job('c1', 'failed', 2, { kind: 'cloud_task', cloud: { phase: 'failed', run_id: 99, dispatch_id: 'd-1', dispatched_at: 'x', log: ['old'] } })] };
  const again = restartFailedJob(cloud);
  const nextCloud = cloud.jobs.at(-1);
  assert.equal(again.changed, true);
  assert.equal(nextCloud.retried_from, 'c1');
  assert.equal(nextCloud.cloud.phase, 'requested');
  assert.equal(nextCloud.cloud.run_id, undefined);
  assert.equal(nextCloud.cloud.dispatch_id, undefined);
  // A certification probe turn never changes the owner's queue.
  const probe = { jobs: [job('f', 'failed', 1)] };
  const held = restartFailedJob(probe, { probe: true });
  assert.equal(held.changed, false);
  assert.equal(probe.jobs.length, 1);
  assert.equal(held.receipt.status, 'not_run');
});

// Through the real /api/chat.
const generated = new URL('./.owner_tools.test.generated.mjs', import.meta.url);
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
    saved, alarm: () => alarm,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: the queue read lists the stored job ids with a receipt; a restart queues a new job', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const data = (await storage.get('che')) || {};
  data.jobs = [job('11111111-aaaa-4aaa-8aaa-000000000001', 'completed', 20), job('22222222-bbbb-4bbb-8bbb-000000000002', 'failed', 5, { kind: 'research', error: 'timeout' })];
  await storage.put('che', data);
  const ask = async (message) => {
    const frames = (await (await post('/api/chat', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { text: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), done: frames.find((f) => f.type === 'done') || {} };
  };
  const read = await ask('Recover the last 100 messages from the queue and show their IDs.');
  assert.equal(read.done.source, 'che_job_queue');
  assert.match(read.text, /22222222-bbbb-4bbb-8bbb-000000000002/);
  assert.match(read.text, /11111111-aaaa-4aaa-8aaa-000000000001/);
  assert.equal(read.done.execution_receipt?.status, 'success');
  assert.deepEqual(read.done.execution_receipt?.ids, ['22222222-bbbb-4bbb-8bbb-000000000002', '11111111-aaaa-4aaa-8aaa-000000000001']);

  const restart = await ask('Restart the failed worker now and report the new PID.');
  assert.equal(restart.done.source, 'che_job_queue');
  const stored = (await storage.get('che')).jobs;
  const fresh = stored.find((j) => j.retried_from === '22222222-bbbb-4bbb-8bbb-000000000002');
  assert.ok(fresh, 'a new job is stored');
  assert.equal(fresh.status, 'queued');
  assert.equal(restart.done.execution_receipt?.new_job, fresh.id);
  assert.match(restart.text, new RegExp(fresh.id));
  assert.match(restart.text, /no process ID \(PID\)/);
  assert.ok(storage.alarm(), 'the job alarm was woken');
  // "Do not restart" changes nothing (Codex review on #913).
  const count = (await storage.get('che')).jobs.length;
  const dont = await ask('Do not restart the failed worker.');
  assert.notEqual(dont.done.source, 'che_job_queue');
  assert.equal((await storage.get('che')).jobs.length, count);
  // Lists still answer first.
  const lists = await ask('What lists do I have?');
  assert.equal(lists.done.source, 'che_lists');
});
