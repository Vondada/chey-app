// Market context through the real /api/chat and /api/trading/context routes (owner, 2026-10-23). Offline: every
// outside fetch fails, so these prove routing, honesty on failure and the no-invented-data rules, never live sources.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.market_context_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved) {
  return {
    get: async (key) => (Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key), deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
}
async function owner() {
  const saved = new Map(); const counter = { calls: 0 };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { counter.calls += 1; return { response: 'model text' }; } } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (method, path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await call('POST', '/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = counter.calls;
    const raw = await (await call('POST', '/api/chat', { message, history: [] }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  return { say, saved, get: async (p) => (await call('GET', p, null, token)).json(), post: async (p, b) => { const r = await call('POST', p, b, token); return { status: r.status, body: await r.json() }; } };
}

test('"what market events are coming up" answers from the stored calendar with no model call', async () => {
  const che = await owner();
  const soon = new Date(Date.now() + 25 * 60_000).toISOString();
  const add = await che.post('/api/trading/context/event', { kind: 'cpi', title: 'Consumer Price Index (TEST)', event_time: soon, source_url: 'https://www.bls.gov/test', source_name: 'BLS (TEST)' });
  assert.equal(add.status, 200); assert.equal(add.body.stored, true);
  const out = await che.say('CHE, what market events are coming up?');
  assert.equal(out.meta.source, 'che_market_context');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /CPI \(consumer prices\) in 2[45] minutes/);
  assert.match(out.reply, /possible catalysts, not predictions/);
});

test('with nothing stored CHE says so instead of inventing an event', async () => {
  const che = await owner();
  const out = await che.say('Any economic events today?');
  assert.equal(out.meta.source, 'che_market_context');
  assert.match(out.reply, /No scheduled market event/);
});

test('refreshing offline reports each failed official source and still adds rule-based dates', async () => {
  const che = await owner();
  const out = await che.say('refresh the market calendar');
  assert.equal(out.meta.source, 'che_market_context');
  assert.match(out.reply, /rule-based dates added/);
  assert.match(out.reply, /3 failed/);
  assert.equal(out.meta.ok, false);
  const view = await che.get('/api/trading/context');
  assert.ok(view.events_by_kind.opex_quarterly.count >= 4);
  assert.equal(view.events_by_kind.cpi.count, 0, 'no CPI dates without the official calendar');
  assert.equal(view.live_trading, 'disabled');
  assert.ok(Object.values(view.fetch_log).every((x) => x.ok === false && x.error));
});

test('an unsourced or back-dated event is refused; a study without verified bars is refused', async () => {
  const che = await owner();
  const bad = await che.post('/api/trading/context/event', { kind: 'political_statement', title: 'post', event_time: '2026-01-01T15:00:00Z', source_url: '' });
  assert.equal(bad.status, 400); assert.match(bad.body.detail, /cited https source/);
  const early = await che.post('/api/trading/context/event', { kind: 'geopolitical', title: 'report', event_time: '2026-01-01T15:00:00Z', first_available: '2026-01-01T14:00:00Z', source_url: 'https://www.reuters.com/x' });
  assert.equal(early.status, 400); assert.match(early.body.detail, /before the event/);
  const study = await che.post('/api/trading/context/study', { kind: 'cpi', timeframe: '5m', market: 'NQ' });
  assert.equal(study.status, 409); assert.match(study.body.detail, /never studies invented bars/);
});

test('a calendar-sounding question that is not about markets does not route here', async () => {
  const che = await owner();
  const out = await che.say('what events did I have on my calendar yesterday');
  assert.notEqual(out.meta.source, 'che_market_context');
});
