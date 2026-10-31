// End to end through the real /api/chat and the Durable Object alarm, offline (fake model, no network).
// Checks receipts and stored state, not reply wording: a timer request is executed by the timer connector (stored,
// read back, receipted, alarm scheduled), fired by the alarm, and announced once; an action with no connector is
// answered by the gate with no model call and nothing stored.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503 });

const generated = new URL('./.action_execution_e2e.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    saved,
    get alarmAt() { return alarm; },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async (at) => { alarm = at; },
    getAlarm: async () => alarm,
    deleteAlarm: async () => { alarm = null; },
  };
}

const PROBE = 'probe-token-0123456789abcdef0123456789';

async function che() {
  const storage = storageMap();
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TIMEZONE: 'UTC', CHE_VOICE_PROBE_TOKEN: PROBE,
    AI: { run: async () => { modelCalls += 1; return { response: 'Sure thing, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
    const frames = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    return { done: frames.find((f) => f.type === 'done') || {}, reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') };
  };
  const probe = async (message) => (await post('/api/probe/chat', { message }, PROBE)).json();
  return { say, probe, state, storage, models: () => modelCalls };
}

test('a timer request is executed: stored, read back, receipted, alarm set, fired by the alarm, announced once', async () => {
  const c = await che();
  const before = c.models();
  const set = await c.say('Set a timer for 10 minutes.');
  assert.equal(set.done.source, 'che_timer');
  assert.equal(c.models(), before, 'no model call for an executed action');
  const receipt = set.done.execution_receipt;
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.verified, 'read_back');
  const stored = c.storage.saved.get('owner_timers').find((t) => t.id === receipt.timer_id);
  assert.equal(stored.status, 'scheduled');
  assert.equal(stored.fire_at, receipt.fire_at);
  assert.ok(c.storage.alarmAt && c.storage.alarmAt <= Date.parse(receipt.fire_at), 'the Durable Object alarm wakes by the fire time');
  assert.ok(c.storage.saved.get('che_receipts').some((r) => r.kind === 'timer_set' && r.timer_id === receipt.timer_id));

  // Time passes: the stored fire time is moved into the past and the real alarm handler runs.
  const timers = c.storage.saved.get('owner_timers');
  timers.find((t) => t.id === receipt.timer_id).fire_at = new Date(Date.now() - 1000).toISOString();
  c.storage.saved.set('owner_timers', timers);
  await c.state.alarm();
  const fired = c.storage.saved.get('owner_timers').find((t) => t.id === receipt.timer_id);
  assert.equal(fired.status, 'fired');
  assert.ok(Date.parse(fired.fired_at) <= Date.now());
  assert.ok(c.storage.saved.get('che_receipts').some((r) => r.kind === 'timer_fired' && r.timer_id === receipt.timer_id));

  const next = await c.say('Hey CHE, what time is it?');
  assert.ok(next.reply.startsWith('Your 10 minutes timer went off at'), next.reply.slice(0, 120));
  assert.ok(next.reply.includes(receipt.timer_id));
  const again = await c.say('Hey CHE, what time is it?');
  assert.ok(!again.reply.includes('went off'), 'announced once');
});

test('a timer is cancelled for real: the record is cancelled and the alarm never fires it', async () => {
  const c = await che();
  const set = await c.say('Remind me to call Sam in 20 minutes.');

  const id = set.done.execution_receipt.timer_id;
  // Cancelling a reminder removes the owner's data, so the authorization gate holds it for his yes first.
  await c.say('Cancel my reminder.');
  assert.equal(c.storage.saved.get('owner_timers').find((t) => t.id === id).status, 'scheduled', 'nothing cancelled before the yes');
  const cancel = await c.say('yes');
  assert.deepEqual(cancel.done.execution_receipt.timer_ids, [id]);
  assert.equal(c.storage.saved.get('owner_timers').find((t) => t.id === id).status, 'cancelled');
  await c.state.alarm();
  assert.equal(c.storage.saved.get('owner_timers').find((t) => t.id === id).status, 'cancelled');
});

test('an action with no connector is answered by the gate: no model call, nothing stored, no receipt', async () => {
  const c = await che();
  const before = c.models();
  for (const ask of ['Open the calendar app.', 'Turn off the living room light.', 'Use the image tool, the email tool and the timer tool at the same time.']) {
    const out = await c.say(ask);
    assert.equal(out.done.source, 'che_connector_gate', ask);
    assert.equal(out.done.model_calls, 0, ask);
    assert.ok(!out.done.execution_receipt, ask);
  }
  assert.equal(c.models(), before);
  assert.equal(c.storage.saved.get('owner_timers'), undefined);
});

test('a certification probe timer really runs on the owner object but never touches the owner\'s timers, receipts or replies', async () => {
  const c = await che();
  await c.say('Set a timer for 30 minutes.');
  const ownerBefore = JSON.stringify(c.storage.saved.get('owner_timers'));
  const receiptsBefore = (c.storage.saved.get('che_receipts') || []).length;
  const set = await c.probe('Set a timer for 5 seconds.');
  assert.equal(set.done.source, 'che_timer');
  assert.equal(set.execution_receipts[0].status, 'success');
  const probeTimer = c.storage.saved.get('owner_timers:probe')[0];
  assert.equal(probeTimer.id, set.execution_receipts[0].timer_id);
  assert.ok(c.storage.alarmAt <= Date.parse(probeTimer.fire_at), 'the alarm wakes for the probe timer');
  const cancel = await c.probe('Cancel my timer.');
  assert.match(cancel.reply, /Cancelled, sir/);
  assert.equal(JSON.stringify(c.storage.saved.get('owner_timers')), ownerBefore, 'the owner\'s 30-minute timer is untouched');
  assert.equal((c.storage.saved.get('che_receipts') || []).length, receiptsBefore, 'nothing added to the owner\'s receipt log');
});
