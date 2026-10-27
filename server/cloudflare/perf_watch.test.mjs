// Performance watch and the per-request owner-state snapshot (owner, 2026-10-22: "she's lagging a lot ... make sure
// every time we add features she can look out for that, tell me, and prevent it").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { PERF_KEY, RUNTIME_BUDGET, performanceBanner, performanceIntent, performanceReport, recordTiming, routeKey, speakPerformance } from './perf_watch.js';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function kvStorage() {
  const kv = new Map();
  let puts = 0;
  return {
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    put: async (k, v) => { puts += 1; kv.set(k, structuredClone(v)); },
    delete: async (k) => kv.delete(k),
    kv, puts: () => puts,
  };
}

test('timings are kept per route; p95 over budget after enough samples turns the status to slow, with one quiet line', async () => {
  const st = kvStorage();
  const t0 = 1_000_000;
  for (let i = 0; i < RUNTIME_BUDGET.min_samples - 1; i++) await recordTiming(st, 'chat:deterministic', { total: 4000, stages: { handler: 3900, finishing: 100 } }, t0 + i);
  let report = await performanceReport(st);
  assert.equal(report.status, 'ok', 'too few samples to judge');
  await recordTiming(st, 'chat:deterministic', { total: 4000, stages: { handler: 3900, finishing: 100 } }, t0 + 99);
  report = await performanceReport(st);
  assert.equal(report.status, 'slow');
  assert.deepEqual(report.over, ['chat:deterministic']);
  assert.equal(report.routes[0].slowest_stage.name, 'handler');
  const banner = performanceBanner(report);
  assert.equal(banner.status, 'slow');
  assert.match(banner.note, /slower than her budget on replies/);
  assert.match(speakPerformance(report), /^Yes, sir: one part is over budget\. replies I answer myself: typical 4000 ms, slowest 5 percent 4000 ms over 10 requests \(budget 1500 ms\), slowest step handler at 3900 ms/);
});

test('a model reply is shown but never judged: provider time is not CHE lag', async () => {
  const st = kvStorage();
  for (let i = 0; i < 20; i++) await recordTiming(st, 'chat:model', { total: 9000 }, 1_000 + i);
  const report = await performanceReport(st);
  assert.equal(report.status, 'ok');
  assert.equal(performanceBanner(report).status, 'ok');
  assert.match(speakPerformance(report), /No, sir: everything I measure is within budget\. replies that use a model: typical 9000 ms[\s\S]*wait on the AI provider/);
});

test('measuring adds at most one storage write a minute and keeps no message text', async () => {
  const st = kvStorage();
  for (let i = 0; i < 50; i++) await recordTiming(st, 'GET /api/state', { total: 20 }, 2_000_000 + i * 1000);
  assert.equal(st.puts(), 1, '50 requests in 50 seconds: one flush');
  await recordTiming(st, 'GET /api/state', { total: 20 }, 2_000_000 + 61_000);
  assert.equal(st.puts(), 2);
  const saved = JSON.stringify(st.kv.get(PERF_KEY));
  assert.doesNotMatch(saved, /message|reply|text/i);
  assert.ok(routeKey('POST', '/api/chat', { modelCalls: 0 }) === 'chat:deterministic' && routeKey('POST', '/api/chat', { modelCalls: 2 }) === 'chat:model');
  assert.equal(routeKey('POST', '/api/memory'), '', 'only chat turns and GETs are watched');
});

test('the owner\'s words reach the report; ordinary sentences about performance do not', () => {
  for (const w of ['Are you lagging?', 'CHE, why are you so slow?', 'Performance report', 'show me your performance', 'how fast are you running', 'is the app lagging']) assert.ok(performanceIntent(w), w);
  for (const w of ['How is my trading performance?', 'performance review for Nova', 'write a performance report for my business', 'are you lagging behind on the video?']) assert.equal(performanceIntent(w), false, w);
});

// ─── Through the Worker ──────────────────────────────────────────────────────

const generated = new URL('./.perf_watch.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  const counts = { cheReads: 0 };
  const st = {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => { if (k === 'che') counts.cheReads += 1; return kv.has(k) ? structuredClone(kv.get(k)) : undefined; },
    put: async (k, v) => { kv.set(k, structuredClone(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'A model answer.' }) } };
  const state = new mod.CheState({ storage: st, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  return {
    st, kv, state, counts, token, send, settle,
    say: async (message) => {
      const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
      await settle();
      const done = raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l?.type === 'done') || {};
      return { reply: replyFromNdjson(raw), route: done.source, done };
    },
    get: async (p, t = token) => { const r = await send(p, null, t, 'GET'); await settle(); return { status: r.status, body: await r.json() }; },
  };
}

test('Worker: every chat turn and polled GET is measured; "are you lagging?" and /che-performance answer from those numbers with no model', async () => {
  const che = await owner();
  await che.say('Good morning CHE');
  await che.get('/api/state');
  await che.get('/api/state');
  const report = (await che.get('/api/performance')).body;
  const chat = report.routes.find((r) => r.route === 'chat:deterministic' || r.route === 'chat:model');
  assert.ok(chat && chat.samples >= 1 && Number.isFinite(chat.p95), `the greeting was measured: ${JSON.stringify(report.routes.map((r) => r.route))}`);
  assert.ok(report.routes.find((r) => r.route === 'GET /api/state')?.samples >= 1);
  const asked = await che.say('Are you lagging?');
  assert.equal(asked.route, 'che_performance');
  assert.equal(asked.done.model_calls, 0);
  assert.match(asked.reply, /within budget|over budget/);
  assert.match(asked.reply, /\d+ ms/, 'real measured numbers');
  assert.equal((await che.say('/che-performance')).route, 'che_performance');
  // The app's state carries one stable field: ok while within budget.
  assert.deepEqual((await che.get('/api/state')).body.performance, { status: 'ok' });
});

test('Worker: a guest device gets no performance report', async () => {
  const che = await owner();
  const guest = await che.get('/api/performance', 'not-a-device');
  assert.notEqual(guest.status, 200);
});

test('Worker: the reply path reads the owner state twice per chat turn, and a write in between is never hidden', async () => {
  const che = await owner();
  await che.say('warm up');
  che.counts.cheReads = 0;
  await che.say('Write me two sentences about the ocean');
  assert.ok(che.counts.cheReads <= 2, `${che.counts.cheReads} full reads of che for one chat turn`);
  // peekData() is dropped by any write to che: a value saved after the first peek is what the next peek returns.
  const fake = new Request('https://che.example/x');
  che.state.currentRequest = fake;
  const first = await che.state.peekData();
  const data = await che.state.loadData();
  data.team_tasks = [{ id: 't-new', status: 'queued' }];
  await che.state.ctx.storage.put('che', data);
  const second = await che.state.peekData();
  assert.notEqual(first, second);
  assert.equal(second.team_tasks[0].id, 't-new');
  assert.equal(await che.state.peekData(), second, 'unchanged since: the same copy, no new read');
});
