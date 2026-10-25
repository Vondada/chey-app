// GPU budget (compute_budget.js) and paid GPU providers (gpu_providers.js) in the compute pool (compute_pool.js):
// ledger maths, cap enforcement (never exceed; stop at the margin), approval required, free-first selection, a paid
// machine deleted after its job / its deadline / the owner's stop / a missed start, runway, adapters against fake
// RunPod and Vast.ai APIs, onboarding and voice through the real /api/chat, and no secret in any response.
// Offline: every outside call goes to a fake fetcher.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { GpuQueue, gpuWorkerRoute } from './gpu_queue.js';
import { ensureCapacity } from './creation_orchestrator.js';
import {
  MIN_PAID_SESSION_S, PAID_SESSION_MAX_S, approveSpend, budgetIntent, budgetOf, canStartPaid, closeSession, marginUsd, openSession,
  reconcileSession, remainingUsd, revokeSpend, runway, sessionCost, setMonthlyCap, speakRunway, spentUsd,
} from './compute_budget.js';
import { PAID_RESERVE_MS, POOL_PROVIDERS, budgetCommand, emptyPool, loadPool, poolRoute, poolView, reapPaid, selectProvider, speakPool } from './compute_pool.js';
import { runpod, vast } from './gpu_providers.js';
import { replyFromNdjson } from './brain_memory.js';

const offline = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = offline;

const T0 = Date.parse('2026-10-25T12:00:00Z');
const H = 3600_000;
const RUNPOD_KEY = 'rpa_TESTSECRETKEY0123456789abcdef';
const VAST_KEY = 'vast_testsecretkey_0123456789abcdef';
const GPU = 'NVIDIA RTX A4000, 550.54.15, 16376 MiB';
const GPU_DEV = "DEVICE OPTIX ['NVIDIA RTX A4000'] 384x480";

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
function setup() {
  let t = T0;
  const storage = memStorage();
  const now = () => t;
  storage.m.set('gpu:seeded', 'test'); storage.m.set('gpu:jobs', []);
  return { storage, now, q: new GpuQueue(storage, now), advance: (ms) => { t += ms; }, t: () => t };
}
const person = (over = {}) => ({ kind: 'person_model', title: 'Test person', views: [0], settings: { MODEL_MODE: 'bust', IDENTITY: 'che' }, priority: 'high', requires: { gpu: 'required' }, ...over });
function glb() {
  const jsonText = JSON.stringify({ asset: { version: '2.0' } }); const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const total = 20 + padded.length; const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true); dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true);
  b.set(new TextEncoder().encode(padded), 20); return b;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A fake RunPod: GraphQL balance, REST create/delete, billing history. Records every call. */
function fakeRunpod({ balance = 12.5, costPerHr = 0.17, billed = 0.05, deleteStatus = 200, auth = RUNPOD_KEY } = {}) {
  const calls = []; const pods = new Map(); let n = 0;
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url)); const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, method, body, auth: init.headers?.Authorization });
    if (init.headers?.Authorization !== `Bearer ${auth}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (u.host === 'api.runpod.io' && u.pathname === '/graphql') return new Response(JSON.stringify({ data: { myself: { id: 'user_1', clientBalance: balance, currentSpendPerHr: 0 } } }), { status: 200 });
    if (u.host !== 'rest.runpod.io') return new Response('{}', { status: 404 });
    if (method === 'POST' && u.pathname === '/v1/pods') { const id = `pod${++n}`; pods.set(id, body); return new Response(JSON.stringify({ id, costPerHr, gpu: { displayName: 'RTX A4000' }, desiredStatus: 'RUNNING' }), { status: 201 }); }
    if (method === 'DELETE' && u.pathname.startsWith('/v1/pods/')) { if (deleteStatus === 200) pods.delete(u.pathname.split('/').pop()); return new Response('{}', { status: deleteStatus }); }
    if (method === 'GET' && u.pathname === '/v1/billing/pods') return new Response(JSON.stringify([...Array(n).keys()].map((i) => ({ podId: `pod${i + 1}`, amount: billed, time: '2026-10-25T00:00:00Z' }))), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls, pods };
}
const allow = async (s, total = 20, monthly = null, fetcher = offline) => budgetCommand({}, { storage: s.storage, now: s.now, fetcher }, { action: 'allow', total_usd: total, monthly_usd: monthly }, `allow up to $${total} for GPUs`);

// ─── Ledger maths ─────────────────────────────────────────────────────────
test('ledger: wall time x hourly price, provider billing replaces the estimate, the margin is kept back, months are calendar months', () => {
  const pool = emptyPool();
  assert.equal(marginUsd(20), 1); assert.equal(marginUsd(1), 0.25); assert.equal(marginUsd(0), 0.25);
  assert.equal(remainingUsd(pool, T0), 0, 'no approval, nothing to spend');
  assert.ok(approveSpend(pool, { totalUsd: 20, text: 'allow up to $20 for GPUs' }, T0).ok);
  const b = budgetOf(pool);
  assert.equal(b.total_cap_usd, 20); assert.equal(b.monthly_cap_usd, 20); assert.equal(b.approved_at, '2026-10-25T12:00:00.000Z');
  assert.equal(b.history.at(-1).text, 'allow up to $20 for GPUs');
  const s = openSession(pool, { provider: 'runpod', ref: 'pod1', gpu: 'RTX A4000', usdHr: 0.2, maxS: 7200 }, T0);
  assert.equal(Math.round(sessionCost(s, T0 + 2 * H) * 1000) / 1000, 0.4);
  assert.equal(Math.round(remainingUsd(pool, T0 + 2 * H) * 1000) / 1000, 18.6, '20 - 0.40 spent - 1.00 margin');
  closeSession(pool, s.id, { reason: 'its job is finished', usdBilled: 0.37 }, T0 + 2 * H);
  assert.equal(spentUsd(pool, T0 + 10 * H), 0.37, 'the provider bill is the truth once known');
  assert.equal(reconcileSession(pool, s.id, -1), null, 'a negative bill is ignored');
  // A monthly cap: a session that crosses midnight on the 1st counts only its November share toward November.
  const p2 = emptyPool();
  approveSpend(p2, { totalUsd: 20, monthlyUsd: 5 }, T0);
  const start = Date.parse('2026-10-31T23:00:00Z');
  openSession(p2, { provider: 'runpod', ref: 'x', usdHr: 1, maxS: 7200 }, start);
  const nov = Date.parse('2026-11-01T01:00:00Z');
  assert.equal(Math.round(spentUsd(p2, nov, { since: Date.parse('2026-11-01T00:00:00Z') }) * 100) / 100, 1);
  assert.equal(Math.round(remainingUsd(p2, nov) * 100) / 100, 3, 'min(20 - 2, 5 - 1) - 1 margin');
  // The monthly cap never exceeds the total; setMonthlyCap needs an approved total.
  assert.equal(setMonthlyCap(emptyPool(), 5).ok, false);
  assert.ok(approveSpend(p2, { totalUsd: 3, monthlyUsd: 10 }, T0).ok);
  assert.equal(budgetOf(p2).monthly_cap_usd, 3);
});

test('caps: approval required, never past the cap (a deadline at the margin), price and balance guards, misheard amounts refused', () => {
  const pool = emptyPool();
  assert.match(canStartPaid(pool, 'runpod', 0.17, T0).reason, /Paid GPUs are off/);
  assert.equal(approveSpend(pool, { totalUsd: 5000 }, T0).ok, false, 'above the voice guard');
  assert.equal(approveSpend(pool, { totalUsd: 'twenty' }, T0).ok, false);
  approveSpend(pool, { totalUsd: 1 }, T0);
  let g = canStartPaid(pool, 'runpod', 0.17, T0);
  assert.equal(g.ok, true); assert.equal(g.max_s, PAID_SESSION_MAX_S, 'never more than 2 h in one go');
  assert.match(canStartPaid(pool, 'runpod', 0.9, T0).reason, /above the most CHE pays/);
  budgetOf(pool).balances.runpod = { usd: 0.1 };
  assert.match(canStartPaid(pool, 'runpod', 0.17, T0).reason, /needs at least one hour of credit/);
  budgetOf(pool).balances.runpod = { usd: 50 };
  openSession(pool, { provider: 'runpod', ref: 'a', usdHr: 0.17, maxS: 60 }, T0);
  assert.match(canStartPaid(pool, 'runpod', 0.17, T0).reason, /one at a time/);
  closeSession(pool, 'runpod:a', { usdBilled: 0.7 }, T0);
  g = canStartPaid(pool, 'runpod', 0.17, T0);
  assert.equal(g.ok, false); assert.equal(g.budget_reached, true, '$0.05 left buys less than 20 minutes');
  assert.match(g.reason, /budget is used up/);
  // Property: sessions that each run to their deadline never spend past cap - margin.
  for (const cap of [1, 2.5, 20, 37.3]) {
    const p = emptyPool(); approveSpend(p, { totalUsd: cap }, T0);
    let t = T0; let n = 0;
    for (;;) {
      const price = [0.17, 0.22, 0.34][n % 3];
      const c = canStartPaid(p, 'runpod', price, t);
      if (!c.ok) break;
      assert.ok(c.max_s >= MIN_PAID_SESSION_S);
      const s = openSession(p, { provider: 'runpod', ref: `s${n}`, usdHr: price, maxS: c.max_s }, t);
      t = s.deadline_ms; closeSession(p, s.id, { reason: 'deadline' }, t); n += 1;
    }
    assert.ok(spentUsd(p, t) <= cap - marginUsd(cap) + 1e-6, `cap ${cap}: spent ${spentUsd(p, t)}`);
    assert.ok(n > 0);
  }
  // "Stop paid GPUs" returns the open sessions and closes the budget.
  const p3 = emptyPool(); approveSpend(p3, { totalUsd: 20 }, T0);
  openSession(p3, { provider: 'vast', ref: '77', usdHr: 0.22, maxS: 600 }, T0);
  assert.equal(revokeSpend(p3, 'stop paid GPUs', T0).length, 1);
  assert.equal(budgetOf(p3).total_cap_usd, 0); assert.equal(budgetOf(p3).approved_at, null);
});

// ─── Selection: free first ────────────────────────────────────────────────
function statuses(over = {}) {
  const base = { github_actions_cpu: 'ready', colab_gpu: 'offline', kaggle: 'no_credential', runpod: 'no_credential', vast: 'no_credential', modal: 'offline', ...over };
  const price = { runpod: 0.17, vast: 0.22 };
  return POOL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, gpu: p.gpu, compatible: p.compatible, paid: Boolean(p.paid), status: base[p.id] || 'no_credential', reason: `${p.id} ${base[p.id]}`, quota: price[p.id] ? { from_usd_hr: price[p.id] } : null }));
}
test('selection: free CPU and free GPUs first; paid only for GPU jobs (or speed when asked), cheapest first; CPU-only work never paid', () => {
  const req = { kind: 'person_model', requires: { gpu: 'required' } };
  const pref = { kind: 'person_model', requires: { gpu: 'preferred' } };
  const none = { kind: 'object_model', requires: { gpu: 'none' } };
  const paid = { runpod: 'unverified', vast: 'ready' };
  assert.equal(selectProvider(statuses({ ...paid, colab_gpu: 'ready' }), req).provider, 'colab_gpu', 'an open Colab before any paid GPU');
  assert.equal(selectProvider(statuses({ ...paid, kaggle: 'unverified' }), req).provider, 'kaggle', 'free Kaggle quota before paid');
  const p = selectProvider(statuses({ ...paid, kaggle: 'cooling_down' }), req);
  assert.equal(p.provider, 'runpod', 'Kaggle out: the cheapest paid GPU'); assert.equal(p.paid, true);
  assert.equal(selectProvider(statuses({ runpod: 'offline', vast: 'ready' }), req).provider, 'vast');
  assert.equal(selectProvider(statuses(paid), pref).provider, 'github_actions_cpu', 'GPU-preferred work stays on the free CPU unless the owner asked for speed');
  assert.equal(selectProvider(statuses(paid), pref, { paidForSpeed: true }).provider, 'runpod');
  assert.equal(selectProvider(statuses({ ...paid, kaggle: 'ready' }), pref, { paidForSpeed: true }).provider, 'kaggle', 'speed still uses free GPUs first');
  assert.equal(selectProvider(statuses(paid), none, { paidForSpeed: true }).provider, 'github_actions_cpu', 'CPU-only work is never sent to a paid GPU');
  assert.equal(selectProvider(statuses({ github_actions_cpu: 'offline', ...paid }), none, { paidForSpeed: true }).provider, null);
  assert.equal(selectProvider(statuses(), req).provider, null, 'no budget or key: a GPU job waits; it never goes to the CPU');
  assert.equal(selectProvider(statuses({ modal: 'offline', runpod: 'offline' }), req).provider, null, 'an unwired or blocked paid provider is never chosen');
});

// ─── Lifecycle with a fake RunPod ─────────────────────────────────────────
async function startPaid(s, rp) {
  s.storage.m.set('provider_keys', { RUNPOD_API_KEY: RUNPOD_KEY });
  await allow(s, 20, null, rp.fetcher);
  const { job } = await s.q.enqueue(person());
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher });
  return { job, cap };
}
const callWorker = (s, rp, token) => async (route, body, { query = '', bytes = null } = {}) => {
  const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, { method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token, 'Content-Type': 'application/json' }, body: bytes || JSON.stringify(body) });
  return (await gpuWorkerRoute({ storage: s.storage, env: {}, now: s.now, fetcher: rp.fetcher }, `/api/gpu/worker/${route}`, req)).json();
};
const bootOf = (rp) => { const body = [...rp.pods.values()].at(-1) || rp.calls.find((c) => c.method === 'POST' && c.path === '/v1/pods').body; return Buffer.from(body.env.CHE_BOOT, 'base64').toString('utf8'); };

test('paid GPU lifecycle: free routes absent, a Community Cloud pod starts with a scoped token, builds, and is deleted after its job with RunPod\'s billed cost', async () => {
  const s = setup(); const rp = fakeRunpod();
  const { job, cap } = await startPaid(s, rp);
  assert.equal(cap.pool_started.provider, 'runpod', JSON.stringify(cap));
  assert.equal(cap.pool_started.usd_hr, 0.17);
  const create = rp.calls.find((c) => c.method === 'POST' && c.path === '/v1/pods').body;
  assert.equal(create.cloudType, 'COMMUNITY'); assert.equal(create.volumeInGb, 0); assert.equal(create.gpuCount, 1);
  assert.deepEqual(create.gpuTypeIds, ['NVIDIA RTX A4000', 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 4090'], 'cheapest GPU first');
  assert.equal(create.gpuTypePriority, 'custom');
  const boot = bootOf(rp);
  assert.match(boot, /WORK = "\/workspace\/che"/); assert.match(boot, /SELF_STOP = "runpod"/); assert.match(boot, /SHA-256 MISMATCH/);
  assert.doesNotMatch(boot, new RegExp(RUNPOD_KEY), 'the owner\'s RunPod key never goes into the machine');
  const token = /TOKEN = "([a-f0-9]{64})"/.exec(boot)[1];
  assert.doesNotMatch(JSON.stringify([...s.storage.m.entries()]), new RegExp(token), 'the worker token is stored only as a hash');
  let pool = await loadPool(s.storage);
  assert.equal(budgetOf(pool).sessions.length, 1);
  const sess = budgetOf(pool).sessions[0];
  assert.equal(sess.ref, 'pod1'); assert.equal(sess.usd_hr, 0.17); assert.ok(sess.deadline_ms - T0 <= PAID_SESSION_MAX_S * 1000);
  // The pod's worker claims its job with the scoped token, builds, completes.
  const call = callWorker(s, rp, token);
  s.advance(10 * 60_000);
  const c = await call('claim', { worker_id: 'runpod-pod1', gpu: GPU, blender: 'Blender 5.0.1' });
  assert.equal(c.job.id, job.id);
  const up = await call('model', null, { query: `?worker=runpod-pod1&job=${job.id}`, bytes: glb() });
  await call('preview', null, { query: `?worker=runpod-pod1&job=${job.id}&view=0`, bytes: PNG });
  assert.equal(rp.pods.size, 1, 'still running while it works');
  s.advance(2 * 60_000);
  const done = await call('complete', { worker_id: 'runpod-pod1', job_id: job.id, status: 'complete',
    receipt: { status: 'complete', blender_version: 'Blender 5.0.1', nvidia_smi: GPU, views: { 0: { status: 'ok', name: 'front', device: GPU_DEV, render_seconds: 3, sha256: 'b'.repeat(64) } }, model: { status: 'ok', sha256: up.sha256, bytes: 100, mode: 'bust' } } });
  assert.equal(done.job?.state, 'completed', JSON.stringify(done)); assert.equal(done.job.receipt.provider, 'runpod');
  assert.equal(rp.pods.size, 0, 'deleted right after its job');
  assert.ok(rp.calls.some((c2) => c2.method === 'DELETE' && c2.path === '/v1/pods/pod1'));
  pool = await loadPool(s.storage);
  const closed = budgetOf(pool).sessions[0];
  assert.equal(closed.end_reason, 'its job is finished'); assert.equal(closed.usd_billed, 0.05); assert.equal(closed.cost_source, 'provider billing');
  assert.equal(pool.tokens.runpod.revoked, true);
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher });
  assert.equal(view.providers.find((p) => p.id === 'runpod').status, 'ready', 'verified by a real GLB receipt');
  assert.equal(view.budget.spent_usd, 0.05);
  assert.equal((await call('claim', { worker_id: 'runpod-pod1', gpu: GPU })).detail, 'Not found.', 'the revoked token opens nothing');
});

test('a paid machine that never picks its job up is deleted after the start window; one past its budget deadline is deleted too', async () => {
  const s = setup(); const rp = fakeRunpod();
  await startPaid(s, rp);
  s.advance(PAID_RESERVE_MS + 1000);
  const r = await reapPaid({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher });
  assert.equal(r.ended[0].reason, 'it did not pick up a job in time');
  assert.equal(rp.pods.size, 0);
  // Deadline: a $0.50 budget leaves $0.25 after the margin, about 88 minutes at $0.17/h.
  const s2 = setup(); const rp2 = fakeRunpod();
  s2.storage.m.set('provider_keys', { RUNPOD_API_KEY: RUNPOD_KEY });
  await allow(s2, 0.5, null, rp2.fetcher);
  const { job } = await s2.q.enqueue(person());
  await ensureCapacity({}, { storage: s2.storage, now: s2.now, fetcher: rp2.fetcher });
  const token = /TOKEN = "([a-f0-9]{64})"/.exec(bootOf(rp2))[1];
  const call = callWorker(s2, rp2, token);
  assert.equal((await call('claim', { worker_id: 'runpod-pod1', gpu: GPU })).job.id, job.id);
  const sess = budgetOf(await loadPool(s2.storage)).sessions[0];
  assert.ok(Math.abs(sess.deadline_ms - T0 - Math.floor((0.25 / 0.17) * 3600) * 1000) < 2000, `deadline ${(sess.deadline_ms - T0) / 60000} min`);
  s2.advance(sess.deadline_ms - T0 - 60_000);
  await call('heartbeat', { worker_id: 'runpod-pod1', gpu: GPU });
  assert.equal(rp2.pods.size, 1, 'working and inside the budget: kept');
  s2.advance(60_000);
  await call('heartbeat', { worker_id: 'runpod-pod1', gpu: GPU });
  assert.equal(rp2.pods.size, 0, 'deleted at its deadline although it was still working');
  const pool = await loadPool(s2.storage);
  assert.equal(budgetOf(pool).sessions[0].end_reason, 'it reached its budget time limit');
  assert.ok(spentUsd(pool, s2.t()) <= 0.5 - marginUsd(0.5) + 0.06, 'billed amount stays inside the cap');
});

test('"stop paid GPUs" deletes the running machine at once; a failed delete is reported, keeps counting, and is retried', async () => {
  const s = setup(); const rp = fakeRunpod({ deleteStatus: 500 });
  await startPaid(s, rp);
  s.advance(5 * 60_000);
  let out = await budgetCommand({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher }, { action: 'stop' }, 'stop paid GPUs');
  assert.equal(out.ok, false);
  assert.match(out.spoken, /Paid GPUs are off/); assert.match(out.spoken, /could not delete/);
  let pool = await loadPool(s.storage);
  assert.equal(budgetOf(pool).total_cap_usd, 0);
  assert.equal(budgetOf(pool).sessions[0].ended_ms, null, 'still open: it may still be charging');
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher, refreshQuota: false });
  assert.match(speakPool(view), /could not delete/);
  // RunPod recovers: the next check deletes it.
  const ok = fakeRunpod(); ok.pods.set('pod1', {});
  await reapPaid({}, { storage: s.storage, now: s.now, fetcher: ok.fetcher });
  pool = await loadPool(s.storage);
  assert.equal(budgetOf(pool).sessions[0].end_reason, 'paid GPUs were stopped');
  assert.ok(ok.calls.some((c) => c.method === 'DELETE'));
  // With paid GPUs stopped, nothing paid starts again.
  const { job } = await s.q.enqueue(person({ title: 'second' }));
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: ok.fetcher });
  assert.equal(cap.pool_started, null);
  assert.ok(!ok.calls.some((c) => c.method === 'POST' && c.path === '/v1/pods'));
  out = await budgetCommand({}, { storage: s.storage, now: s.now, fetcher: ok.fetcher }, { action: 'runway' }, 'how long');
  assert.match(out.spoken, /Paid GPUs are off/);
  assert.ok(job.id);
});

test('without the owner\'s budget a saved key starts nothing, and a free GPU route still goes first', async () => {
  const s = setup(); const rp = fakeRunpod();
  s.storage.m.set('provider_keys', { RUNPOD_API_KEY: RUNPOD_KEY });
  await s.q.enqueue(person());
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher });
  assert.equal(cap.pool_started, null);
  assert.ok(!rp.calls.some((c) => c.method === 'POST' && c.path === '/v1/pods'));
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher });
  const r = view.providers.find((p) => p.id === 'runpod');
  assert.equal(r.status, 'offline'); assert.match(r.reason, /not set a GPU budget/);
  assert.equal(r.quota.balance_usd, 12.5, 'the balance is read (free) and shown');
  // A saved Kaggle token with quota takes the job before RunPod.
  const s2 = setup(); const rp2 = fakeRunpod();
  const fetcher = async (url, init) => (String(url).endsWith('GetAcceleratorQuotaStatistics') ? new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '0s' } }), { status: 200 })
    : String(url).endsWith('SaveKernel') ? new Response(JSON.stringify({ ref: 'owneruser/che-character-worker' }), { status: 200 }) : rp2.fetcher(url, init));
  s2.storage.m.set('provider_keys', { RUNPOD_API_KEY: RUNPOD_KEY, KAGGLE_API_TOKEN: 'owneruser:KGAT_test_secret_value_1234567890' });
  await allow(s2, 20, null, fetcher);
  await s2.q.enqueue(person());
  const cap2 = await ensureCapacity({}, { storage: s2.storage, now: s2.now, fetcher });
  assert.equal(cap2.pool_started.provider, 'kaggle', 'free first');
  assert.ok(!rp2.calls.some((c) => c.method === 'POST' && c.path === '/v1/pods'));
});

// ─── Runway ───────────────────────────────────────────────────────────────
test('runway: from recent use and the money left, in weeks or hours; never "forever"', () => {
  const pool = emptyPool();
  let r = runway(pool, T0);
  assert.match(speakRunway(r), /Paid GPUs are off/);
  approveSpend(pool, { totalUsd: 20 }, T0 - 14 * 86400_000);
  r = runway(pool, T0);
  assert.equal(r.weeks_left, null);
  assert.equal(r.hours_on_cheapest, Math.round((19 / 0.17) * 10) / 10);
  assert.match(speakRunway(r, { kaggleLeftS: 30 * 3600 }), /buys about 111\.8 hours on the cheapest GPU/);
  for (let i = 0; i < 3; i++) {
    const s = openSession(pool, { provider: 'runpod', ref: `r${i}`, usdHr: 0.2, maxS: 7200 }, T0 - (14 - i * 5) * 86400_000);
    closeSession(pool, s.id, { reason: 'done' }, s.started_ms + H);
  }
  r = runway(pool, T0);
  assert.equal(r.recent_gpu_hours_per_week, 1.5); assert.equal(r.recent_usd_per_week, 0.3);
  assert.equal(r.left_usd, 18.4); assert.equal(r.weeks_left, 61.3);
  const said = speakRunway(r, { kaggleLeftS: 12 * 3600 });
  assert.match(said, /At your recent use of 1\.5 paid GPU hours a week \(about \$0\.30 a week\), the money left lasts about 61\.3 weeks/);
  assert.match(said, /12\.0 hours left this week/);
  assert.doesNotMatch(said, /forever/i);
  // A lower monthly cap slows the pace and lengthens the runway.
  approveSpend(pool, { totalUsd: 20, monthlyUsd: 0.5 }, T0);
  assert.ok(runway(pool, T0).weeks_left > 61.3);
});

// ─── Words ────────────────────────────────────────────────────────────────
test('budget words: allow, monthly, stop, runway, which GPUs, speed; unrelated sentences do not match', () => {
  assert.deepEqual(budgetIntent('CHE, allow up to $20 for GPUs.'), { action: 'allow', total_usd: 20, monthly_usd: null });
  assert.deepEqual(budgetIntent('allow up to twenty dollars for GPUs, 5 dollars a month'), { action: 'allow', total_usd: 20, monthly_usd: 5 });
  assert.deepEqual(budgetIntent('set my GPU budget to 15'), { action: 'allow', total_usd: 15, monthly_usd: null });
  assert.deepEqual(budgetIntent('limit GPUs to $5 a month'), { action: 'monthly', monthly_usd: 5 });
  assert.deepEqual(budgetIntent('stop paid GPUs'), { action: 'stop' });
  assert.deepEqual(budgetIntent('turn off paid GPUs now'), { action: 'stop' });
  assert.deepEqual(budgetIntent('how long will my GPU money last'), { action: 'runway' });
  assert.deepEqual(budgetIntent('what GPUs can CHE use'), { action: 'gpus' });
  assert.deepEqual(budgetIntent('use paid GPUs for speed'), { action: 'speed', on: true });
  assert.deepEqual(budgetIntent('only use free GPUs'), { action: 'speed', on: false });
  for (const no of ['stop the GPU job', 'allow notifications', 'stop GPUs', 'allow up to $20 for groceries', 'how long will my battery last']) assert.equal(budgetIntent(no), null, no);
});

// ─── Adapters against fake APIs ───────────────────────────────────────────
test('adapters: balance reads verify keys; RunPod refuses a dearer machine and deletes it; Vast picks the cheapest verified offer under the cap', async () => {
  const rp = fakeRunpod();
  assert.deepEqual(await runpod.balance(RUNPOD_KEY, rp.fetcher), { ok: true, usd: 12.5, spend_per_hr: 0 });
  assert.equal((await runpod.balance('wrong', rp.fetcher)).status, 'unauthorized');
  const gqlErr = async () => new Response(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }), { status: 200 });
  assert.equal((await runpod.balance(RUNPOD_KEY, gqlErr)).ok, false, 'a GraphQL error is never a balance');
  const dear = fakeRunpod({ costPerHr: 0.89 });
  const res = await runpod.start(RUNPOD_KEY, { script: 'print(1)', gpuTypeIds: ['NVIDIA RTX A4000'], maxUsdHr: 0.34 }, dear.fetcher);
  assert.equal(res.ok, false); assert.equal(res.status, 'too_expensive');
  assert.equal(dear.pods.size, 0, 'deleted at once');
  const calls = [];
  const vf = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.headers?.Authorization !== `Bearer ${VAST_KEY}`) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v0/users/current/') return new Response(JSON.stringify({ credit: 7.25, id: 1 }), { status: 200 });
    if (u.pathname === '/api/v0/bundles/') return new Response(JSON.stringify({ offers: [{ id: 11, gpu_name: 'RTX 4090', dph_total: 0.39 }, { id: 12, gpu_name: 'RTX 3090', dph_total: 0.19 }, { id: 13, gpu_name: 'RTX 3090', dph_total: 0.55 }] }), { status: 200 });
    if (u.pathname === '/api/v0/asks/12/') return new Response(JSON.stringify({ success: true, new_contract: 9001 }), { status: 200 });
    if (u.pathname === '/api/v0/instances/9001/') return new Response('{"success":true}', { status: 200 });
    return new Response('{}', { status: 404 });
  };
  assert.deepEqual(await vast.balance(VAST_KEY, vf), { ok: true, usd: 7.25 });
  const v = await vast.start(VAST_KEY, { script: 'print(1)', gpuNames: ['RTX A4000', 'RTX 3090', 'RTX 4090'], maxUsdHr: 0.4 }, vf);
  assert.deepEqual(v, { ok: true, ref: '9001', usd_hr: 0.19, gpu: 'RTX 3090' });
  const search = calls.find((c) => c.path === '/api/v0/bundles/').body;
  assert.deepEqual(search.dph_total, { lte: 0.4 }); assert.deepEqual(search.verified, { eq: true }); assert.deepEqual(search.order, [['dph_total', 'asc']]);
  assert.equal(calls.find((c) => c.path === '/api/v0/asks/12/').method, 'PUT');
  assert.ok((await vast.stop(VAST_KEY, '9001', vf)).ok);
  const none = await vast.start(VAST_KEY, { script: 'x', gpuNames: ['RTX A4000'], maxUsdHr: 0.2 }, vf);
  assert.equal(none.ok, false); assert.match(none.error, /no verified RTX A4000/);
});

// ─── No secrets ───────────────────────────────────────────────────────────
test('no key or worker token in any pool, budget or spoken response', async () => {
  const s = setup(); const rp = fakeRunpod();
  await startPaid(s, rp);
  const token = /TOKEN = "([a-f0-9]{64})"/.exec(bootOf(rp))[1];
  const texts = [];
  for (const path of ['/api/creations/pool', '/api/creations/probe/pool']) texts.push(await (await poolRoute({ storage: s.storage, env: {}, now: s.now, fetcher: rp.fetcher }, path, new Request(`https://che.example${path}`))).text());
  for (const action of ['runway', 'gpus']) texts.push(JSON.stringify(await budgetCommand({}, { storage: s.storage, now: s.now, fetcher: rp.fetcher }, { action }, '')));
  const set = await poolRoute({ storage: s.storage, env: {}, now: s.now, fetcher: rp.fetcher }, '/api/creations/pool/settings', new Request('https://che.example/api/creations/pool/settings', { method: 'POST' }), { gpu_budget: { total_usd: 25 }, confirm: true });
  texts.push(await set.text());
  for (const t of texts) { assert.doesNotMatch(t, new RegExp(RUNPOD_KEY)); assert.doesNotMatch(t, new RegExp(token)); assert.doesNotMatch(t, /CHE_BOOT/); }
  assert.equal(JSON.parse(texts.at(-1)).budget.total_cap_usd, 25);
  const unconfirmed = await poolRoute({ storage: s.storage, env: {}, now: s.now }, '/api/creations/pool/settings', new Request('https://che.example/api/creations/pool/settings', { method: 'POST' }), { gpu_budget: { total_usd: 99 } });
  assert.equal(unconfirmed.status, 422, 'the screen needs confirm: true');
});

// ─── Through the real Worker: onboarding and voice ────────────────────────
const generated = new URL('./.compute_budget.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

async function owner() {
  const saved = new Map(); const inputs = []; const pending = []; const wire = [];
  const storage = {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key), list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { inputs.push(input); return { response: 'Here is the answer, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = inputs.length;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    while (pending.length) await pending.shift();
    wire.push(raw);
    const done = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).find((e) => e.type === 'done') || {};
    return { done, reply: replyFromNdjson(raw), modelCalls: inputs.length - before };
  };
  const post = async (path, body) => { const text = await (await send(path, body, token)).text(); wire.push(text); return JSON.parse(text); };
  return { say, post, saved, wire };
}

test('"CHE, connect RunPod" is guided through the existing onboarding: secure field, numbered once-only steps, a free balance read, three separate lines', async () => {
  const che = await owner();
  const said = await che.say('CHE, connect RunPod');
  assert.equal(said.modelCalls, 0);
  assert.equal(said.done.source, 'che_onboarding');
  assert.equal(said.done.onboarding.action, 'guided');
  assert.equal(said.done.open_screen, 'service_onboarding');
  assert.match(said.reply, /Never paste a key into chat/);
  assert.match(said.reply, /1\. Sign in at runpod\.io/); assert.match(said.reply, /Add prepaid credit yourself/); assert.match(said.reply, /I never pay/);
  const rp = fakeRunpod();
  globalThis.fetch = rp.fetcher;
  const out = await che.post('/api/onboarding/runpod/secret', { token: RUNPOD_KEY });
  globalThis.fetch = offline;
  assert.equal(out.state, 'verified', JSON.stringify(out));
  assert.match(out.lines[0], /^Token saved: yes, ending cdef \(you created it; I keep only its fingerprint sha256:[0-9a-f]{12}\)\.$/);
  assert.match(out.lines[1], /^Secret configured: CHE Worker runtime key store/);
  assert.match(out.lines[2], /^Connection verified: RunPod accepted the key; prepaid balance \$12\.50 \(a read-only balance check; nothing was started or spent\)\.$/);
  assert.match(out.speech, /^Connected: RunPod accepted the key\. I can use RunPod GPUs for GPU jobs no free GPU can take, only within the GPU budget you set\./);
  assert.ok(!rp.calls.some((c) => c.host === 'rest.runpod.io'), 'verification never starts a machine');
  assert.ok(!che.wire.join('\n').includes(RUNPOD_KEY));
  assert.equal(che.saved.get('provider_keys').RUNPOD_API_KEY, RUNPOD_KEY, 'stored where the pool reads it');
});

test('Modal is Connected only after its app answers an authenticated /health; a format-only key is refused; voice sets the credit policy with no model; Kaggle needs username:token', async () => {
  const che = await owner();
  const said = await che.say('connect modal');
  assert.equal(said.done.onboarding.action, 'guided');
  assert.match(said.reply, /set the workspace spend limit to \$0/); assert.match(said.reply, /MODAL_TOKEN_ID and MODAL_TOKEN_SECRET/); assert.match(said.reply, /CHE Modal deploy/);
  const bad = await che.post('/api/onboarding/modal/secret', { token: 'not-a-modal-token-at-all' });
  assert.match(bad.detail, /does not look like a Modal Proxy Auth Token/);
  const deploy = await che.post('/api/onboarding/modal/secret', { token: 'ak-AbCdEf123456:as-ZyXwVu987654' });
  assert.match(deploy.detail, /Modal API token, the deploy key/);
  const cred = 'wk-AbCdEf123456:ws-ZyXwVu987654@https://ownerws--che-gpu.modal.run';
  globalThis.fetch = async (url, init = {}) => (String(url) === 'https://ownerws--che-gpu.modal.run/health' && init.headers?.['Modal-Key'] === 'wk-AbCdEf123456'
    ? new Response(JSON.stringify({ ok: true, app: 'che-gpu', version: 'che-modal-1', gpu: 'T4' }), { status: 200 }) : new Response('{}', { status: 404 }));
  const m = await che.post('/api/onboarding/modal/secret', { token: cred });
  globalThis.fetch = offline;
  assert.equal(m.state, 'verified', JSON.stringify(m));
  assert.equal(m.outcomes.connection_verified, true);
  assert.match(m.speech, /^Connected: Modal accepted the Proxy Auth Token/);
  assert.ok(!che.wire.join('\n').includes('ws-ZyXwVu987654'), 'the secret never comes back');
  const on = await che.say("CHE, use Modal's free credit");
  assert.equal(on.modelCalls, 0); assert.equal(on.done.command, 'cloud-gpu', JSON.stringify(on.done));
  assert.match(on.reply, /Recorded at \d\d:\d\d UTC/); assert.match(on.reply, /spend limit is \$0/);
  const lim = await che.say("I set Modal's spend limit to zero");
  assert.equal(lim.modelCalls, 0); assert.match(lim.reply, /you said Modal's spend limit is \$0/);
  const cr = await che.say('my Modal credit is 30 dollars');
  assert.match(cr.reply, /I stop sending jobs when my estimate reaches \$25\.00/);
  assert.equal(cr.done.modal.dispatch_allowed, true);
  assert.equal(che.saved.get('pool:state').modal.opt_in.words, "use Modal's free credit");
  const st = await che.say('How much Modal credit have I used?');
  assert.equal(st.modelCalls, 0); assert.match(st.reply, /Modal is connected and verified/); assert.match(st.reply, /not available to CHE/);
  await che.say('connect kaggle');
  const k1 = await che.post('/api/onboarding/kaggle/secret', { token: 'KGAT_onlythetoken_1234567890' });
  assert.equal(k1.state, 'failed'); assert.match(k1.lines[2], /username:token/);
  globalThis.fetch = async (url) => (String(url).endsWith('GetAcceleratorQuotaStatistics') ? new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '7200s' } }), { status: 200 }) : new Response('{}', { status: 404 }));
  const k2 = await che.post('/api/onboarding/kaggle/secret', { token: 'owneruser:KGAT_test_secret_value_1234567890' });
  globalThis.fetch = offline;
  assert.equal(k2.state, 'verified', JSON.stringify(k2));
  assert.match(k2.lines[2], /28\.0 GPU hours left this week \(read only, nothing spent\)/);
  assert.ok(!che.wire.join('\n').includes('KGAT_test_secret_value'));
});

test('voice: "allow up to $20 for GPUs", "how long will my GPU money last?", "what GPUs can CHE use", "stop paid GPUs" run with no model', async () => {
  const che = await owner();
  const a = await che.say('CHE, allow up to $20 for GPUs');
  assert.equal(a.modelCalls, 0);
  assert.equal(a.done.command, 'cloud-gpu', JSON.stringify(a.done));
  assert.equal(a.done.gpu_budget.total_cap_usd, 20);
  assert.match(a.reply, /you allowed up to \$20\.00 in total for paid GPUs/); assert.match(a.reply, /I never pay or add credit myself/);
  assert.match(a.reply, /No paid GPU provider is connected yet/);
  assert.match(che.saved.get('pool:state').budget.history.at(-1).text, /allow up to \$20 for gpus/i);
  const r = await che.say('How long will my GPU money last?');
  assert.equal(r.modelCalls, 0);
  assert.match(r.reply, /Left to spend: \$19\.00, after a \$1\.00 safety margin/);
  assert.match(r.reply, /Free GPUs always come first/);
  assert.doesNotMatch(r.reply, /forever/i);
  const g = await che.say('what GPUs can CHE use');
  assert.match(g.reply, /free ones first: 1\. /); assert.match(g.reply, /RunPod Community Cloud GPU \(prepaid\) \(paid\)/);
  const typed = await che.say('/cloud-gpu budget limit GPUs to $5 a month');
  assert.match(typed.reply, /at most \$5\.00 a month, within your \$20\.00 total/);
  const st = await che.say('stop paid GPUs');
  assert.match(st.reply, /Paid GPUs are off and the GPU budget is zero dollars\. Nothing paid was running\./);
  assert.equal(che.saved.get('pool:state').budget.total_cap_usd, 0);
});
