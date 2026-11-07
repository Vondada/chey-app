// Fast films on Modal (owner, 2026-11-07: "at least a 1-minute video in 5 minutes", Modal for speed inside the $10 a
// month cap, then "the closest thing possible to free": fast mode is opt-in per film, the default stays free).
// No network and no money: every Modal answer is a fake, and the tests count what would have been sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FILM_MODAL_USD_S, FILM_WORKER_TIMEOUT_S, fastAsked, fastDoneLine, fastEstimate, fastQuote, planFast, settleFastFarm, startFastFarm } from './film_fast.js';
import { MODAL_POOL_KEY, modalMonthCheckFor, modalMonthWorstUsd, modalStateOf, nextKey, openCalls } from './modal_gpu.js';
import { filmIntent } from './film_studio.js';
import { routeWork } from './compute_pool.js';

const T = Date.parse('2026-11-07T18:00:00Z');
const BASE = 'https://chey-app.henryjavoni.workers.dev';
const CRED = `bearer:${'b'.repeat(40)}@https://ownerws--che-gpu.modal.run`;
function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) };
}
function fakeModal({ functions = ['health', 'blender_preview', 'txt2img', 'film_farm'], status = null } = {}) {
  const sent = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ method: init.method, path: u.pathname, body });
    if (u.pathname === '/health') return new Response(JSON.stringify({ ok: true, app: 'che-gpu', version: 'che-modal-3', functions }), { status: 200 });
    if (u.pathname === '/film_farm') {
      const calls = [...Array(body.clips)].map((_, i) => ({ kind: 'clip', call_id: `fc-clip${i}aaaaaaaa` })).concat([...Array(body.lips)].map((_, i) => ({ kind: 'lipsync', call_id: `fc-lips${i}aaaaaaaa` })));
      return new Response(JSON.stringify({ ok: true, dispatch: 'new', state: 'started', calls }), { status: 200 });
    }
    if (u.pathname === '/film_farm/status') return new Response(JSON.stringify(status || { ok: true, state: 'running', calls: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { fetcher, sent };
}
const film = (extra = {}) => ({ id: 'film_0123456789abcdef', title: 'Brewed Anarchy', fast: { on: true, estimate_usd: 1.2 }, ...extra });

test('fast mode is opt-in: only when Modal (or "fast mode") is named for this film; the default stays free', () => {
  for (const q of ['make it fast with Modal', 'Re-render Brewed Anarchy with Modal', 'use Modal for this film', 'make a movie about a cat in fast mode']) assert.equal(fastAsked(q), true, q);
  for (const q of ['make me a 1-minute movie about a lighthouse keeper', 'make it fast', 'not on Modal please', 'do not use Modal for this']) assert.equal(fastAsked(q), false, q);
  const office = filmIntent('Che, make a short story about the office: the coffee machine breaks, and make it fast with Modal');
  assert.equal(office.fast, true);
  assert.doesNotMatch(office.topic, /modal|fast/i, 'the phrase never becomes part of the topic');
  assert.deepEqual(filmIntent('re-render Brewed Anarchy with Modal'), { kind: 'rerender', title: 'Brewed Anarchy', bare: true, fast: true });
  assert.equal(filmIntent('make me a 1-minute movie about a lighthouse keeper').fast, undefined, 'a plain film never goes to Modal');
  assert.equal(filmIntent('Re-render Brewed Anarchy').fast, undefined);
});

test('a 1-minute film (10 moving shots, 6 talking) is estimated at about $1 and about 5 minutes, worst case under $4', () => {
  const est = fastEstimate({ clips: 10, lips: 6 });
  assert.equal(est.workers, 16);
  assert.ok(est.usd >= 0.5 && est.usd <= 1.5, `${est.usd}`);
  assert.equal(est.worst_usd, Math.round(16 * FILM_WORKER_TIMEOUT_S * FILM_MODAL_USD_S * 10000) / 10000);
  assert.ok(est.worst_usd < 4);
  assert.ok(est.wall_s <= 6 * 60, `${est.wall_s} s`);
  assert.equal(est.provenance, 'ESTIMATED');
  // More shots than GPUs: they queue on the same containers, so the time grows but the worst case does not.
  const long = fastEstimate({ clips: 25, lips: 6 });
  assert.equal(long.clip_workers, 10);
  assert.equal(long.worst_usd, est.worst_usd);
  assert.ok(long.farm_s > est.farm_s);
});

test('CHE says the cost and the money left before anything starts; over the cap the film runs free and says why', async () => {
  const storage = memStorage();
  const q = await fastQuote(storage, { clips: 10, lips: 6 }, T);
  assert.equal(q.ok, true);
  assert.match(q.said, /^Fast mode on Modal: about \$\d\.\d\d for this film \(16 L40S GPUs at once, at most \$3\.64 if every one runs to its time limit\), inside your \$10\.00 a month\./);
  assert.match(q.said, /stays free even if every GPU runs to its limit/);
  // This month already used $8 of Modal: the film's worst case would pass the $9.50 stop line.
  const pool = {}; const m = modalStateOf(pool);
  m.calls['job:old:modal:1'] = { key: 'job:old:modal:1', provider: 'modal', job_ids: ['old'], state: 'done', dispatched_ms: T - 3600_000, ended_ms: T, gpu_seconds: Math.round(8 * 3600 / 0.59) - 120, usd_hr: 0.59 };
  await storage.put(MODAL_POOL_KEY, pool);
  const over = await fastQuote(storage, { clips: 10, lips: 6 }, T);
  assert.equal(over.ok, false);
  assert.match(over.said, /^Fast mode is not available, so this film runs free: Modal's monthly cap is reached/);
  // The router's own words agree: the fast workload is Modal only, and only within the cap.
  assert.equal(routeWork('film_clip_fast', [], { modal: { ok: false, reason: 'cap' } }).route, null);
  const plan = { tier_a: 10, lip_sync: 6, shots: 10, segments: 1 };
  const declined = await planFast({ storage, now: T }, plan, true);
  assert.equal(declined.fast.on, false);
  assert.equal(plan.segments, 1, 'a declined film keeps its plan');
  assert.equal((await planFast({ storage, now: T }, plan, false)).fast, null, 'not asked: nothing quoted');
});

test('dispatch: the cap is checked again, the farm is counted at its worst case while open, and every shot starts at once', async () => {
  const storage = memStorage();
  await storage.put('che:keys', undefined);
  const { fetcher, sent } = fakeModal();
  const ctx = { storage, env: { MODAL_TOKEN: CRED }, base: BASE, now: T, fetcher };
  const f = film();
  const out = await startFastFarm(ctx, f, { token: 'a'.repeat(64), record: { token_hash: 'h', expires: T + 1, revoked: false }, clips: 10, lips: 6 });
  assert.equal(out.ok, true);
  assert.equal(out.farm.provider, 'modal');
  const post = sent.find((s) => s.path === '/film_farm');
  assert.deepEqual([post.body.clips, post.body.lips, post.body.deadline_s, post.body.che_base, post.body.film_id], [10, 6, FILM_WORKER_TIMEOUT_S, BASE, f.id]);
  const pool = await storage.get(MODAL_POOL_KEY);
  const call = Object.values(modalStateOf(pool).calls)[0];
  assert.equal(call.kind, 'film');
  assert.equal(call.state, 'started');
  assert.ok(Math.abs(modalMonthWorstUsd(pool, T) - call.worst_usd) < 1e-9, 'open: counted at its worst case');
  assert.equal(openCalls(pool).length, 0, 'the Blender reconciler never touches (or cancels) a film farm');
  assert.equal(nextKey(pool, 'gpu_000000000001'), 'job:gpu_000000000001:modal:1', 'Blender keys still work beside a film call');
  const after = await modalMonthCheckFor(storage, 0, T);
  assert.ok(after.used_usd >= call.worst_usd, 'the next caller sees the film reserved');

  // Every container returned: the ledger takes the measured seconds, and the finished film says the real cost.
  f.farm = out.farm;
  const done = fakeModal({ status: { ok: true, state: 'done', calls: [...Array(16)].map((_, i) => ({ kind: i < 10 ? 'clip' : 'lipsync', state: 'done', gpu_seconds: 100 })) } });
  const end = await settleFastFarm({ ...ctx, fetcher: done.fetcher }, f);
  assert.equal(end, 'the Modal GPUs finished');
  const settled = Object.values(modalStateOf(await storage.get(MODAL_POOL_KEY)).calls)[0];
  assert.equal(settled.state, 'done');
  assert.equal(settled.gpu_seconds, 16 * 120);
  assert.ok(Math.abs(modalMonthWorstUsd(await storage.get(MODAL_POOL_KEY), T) - 16 * 120 * FILM_MODAL_USD_S) < 1e-3, 'reconciled to the measured cost');
  assert.match(fastDoneLine(f), /^ Fast mode on Modal cost \$1\.04 \(1920 GPU seconds, measured\); I estimated \$1\.24\.$/);
});

test('an app without the film workers, a refusal, or a missing connection sends no GPU work and the film runs free', async () => {
  const storage = memStorage();
  const old = fakeModal({ functions: ['health', 'blender_preview', 'txt2img'] });
  const r = await startFastFarm({ storage, env: { MODAL_TOKEN: CRED }, base: BASE, now: T, fetcher: old.fetcher }, film(), { token: 'a'.repeat(64), record: {}, clips: 10, lips: 6 });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not have the fast film workers yet/);
  assert.equal(old.sent.filter((s) => s.path === '/film_farm').length, 0);
  assert.equal(Object.keys(modalStateOf((await storage.get(MODAL_POOL_KEY)) || {}).calls).length, 0, 'nothing reserved');
  const none = await startFastFarm({ storage, env: {}, base: BASE, now: T, fetcher: old.fetcher }, film(), { token: 'a'.repeat(64), record: {}, clips: 1, lips: 0 });
  assert.match(none.why, /Modal is not connected/);
  assert.equal(fastDoneLine({ fast: { declined: 'Modal is not connected' } }), ' Fast mode did not run: Modal is not connected.');
  assert.equal(fastDoneLine({}), '', 'a free film says nothing about Modal');
});

test('a 500 from /film_farm is a definite failure: nothing runs, nothing is reserved at its worst case, the film runs free at once', async () => {
  const storage = memStorage();
  const sent = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    sent.push(u.pathname);
    if (u.pathname === '/health') return new Response(JSON.stringify({ ok: true, app: 'che-gpu', version: 'che-modal-3', functions: ['film_farm'] }), { status: 200 });
    return new Response(JSON.stringify({ ok: false, error: 'spawn failed: ModuleNotFoundError' }), { status: 500 });
  };
  const r = await startFastFarm({ storage, env: { MODAL_TOKEN: CRED }, base: BASE, now: T, fetcher }, film(), { token: 'a'.repeat(64), record: {}, clips: 10, lips: 6 });
  assert.equal(r.ok, false);
  assert.match(r.why, /HTTP 500: spawn failed: ModuleNotFoundError\); nothing was charged/);
  const call = Object.values(modalStateOf(await storage.get(MODAL_POOL_KEY)).calls)[0];
  assert.equal(call.state, 'not_started');
  assert.equal(modalMonthWorstUsd(await storage.get(MODAL_POOL_KEY), T), 0, 'nothing counted against the cap');
});
