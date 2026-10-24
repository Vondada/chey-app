// Per-tenant limits, fair scheduling, rate limits and the $0 spending gate (job_quota.js), plus the queue never
// dropping waiting work (gpu_queue.js keepJobs) and a load test through the real GpuQueue with many tenants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, admit, fairOrder, planOf, rateLimit, spendGate, tenantUsage } from './job_quota.js';
import { GpuQueue, MAX_JOBS, keepJobs } from './gpu_queue.js';
import { estimateVideo } from './capacity_model.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const job = (id, tenant, over = {}) => ({ id, tenant_id: tenant, state: 'queued', priority: 'normal', created_at: iso(T0), history: [], ...over });

test('plans: the owner gets the owner plan; any other tenant is free unless a plan is set', () => {
  assert.equal(planOf('owner').id, 'owner');
  assert.equal(planOf('ana').id, 'free');
  assert.equal(planOf({ id: 'ana', plan: 'paid' }).id, 'paid');
  assert.equal(planOf({ id: 'ana', plan: 'nonsense' }).id, 'free');
});

test('usage counts each tenant\'s worker time in the last 24 hours from the jobs themselves', () => {
  const jobs = [
    job('a', 'ana', { state: 'completed', history: [{ state: 'rendering', at: iso(T0 - 600_000) }, { state: 'completed', at: iso(T0 - 300_000) }] }),
    job('b', 'ana', { state: 'rendering', history: [{ state: 'rendering', at: iso(T0 - 60_000) }] }),
    job('c', 'bob'),
  ];
  const u = tenantUsage(jobs, T0);
  assert.equal(u.ana.worker_s, 360);
  assert.equal(u.bob.queued, 1);
});

test('fair order: within a priority, the tenant who used less goes first; paused resumes before new; then oldest', () => {
  const heavy = job('h', 'heavy', { created_at: iso(T0 - 9_000) });
  const light = job('l', 'light', { created_at: iso(T0) });
  const done = job('d', 'heavy', { state: 'completed', history: [{ state: 'rendering', at: iso(T0 - 7200_000) }, { state: 'completed', at: iso(T0 - 3600_000) }] });
  const urgent = job('u', 'heavy', { priority: 'high', created_at: iso(T0) });
  const jobs = [heavy, light, done, urgent];
  const order = jobs.filter((j) => j.state === 'queued').sort(fairOrder(jobs, T0)).map((j) => j.id);
  assert.deepEqual(order, ['u', 'l', 'h'], 'priority first, then the light tenant ahead of the heavy one despite being newer');
});

test('admission: job length, queued jobs, daily minutes, storage, duplicates, rate limit; every refusal is plain', () => {
  const base = { now: T0, tenant: 'ana', jobs: [] };
  assert.equal(admit({ minutes: 5 }, base).ok, true);
  assert.match(admit({ minutes: 30 }, base).reason, /longer than this plan allows \(10 minutes\)/);
  const three = [1, 2, 3].map((n) => job(`q${n}`, 'ana'));
  assert.match(admit({ minutes: 1 }, { ...base, jobs: three }).reason, /already have 3 jobs waiting/);
  const today = [job('m', 'ana', { state: 'completed', video_minutes: 28 })];
  assert.match(admit({ minutes: 5 }, { ...base, jobs: today }).reason, /33 video minutes today; this plan allows 30/);
  assert.match(admit({ minutes: 1 }, { ...base, storageGb: 5 }).reason, /5 GB limit/);
  const dup = [job('x', 'ana', { fingerprint: 'f1', created_at: iso(T0 - 10_000) })];
  assert.equal(admit({ minutes: 1, fingerprint: 'f1' }, { ...base, jobs: dup }).duplicate, true);
  let bucket;
  for (let i = 0; i < PLANS.free.creations_per_minute; i++) bucket = admit({ minutes: 1 }, { ...base, bucket }).bucket;
  const limited = admit({ minutes: 1 }, { ...base, bucket });
  assert.equal(limited.ok, false); assert.match(limited.reason, /Too many requests in a minute/);
  assert.ok(limited.retry_s > 0);
  // Another tenant is not affected by Ana's limits.
  assert.equal(admit({ minutes: 1 }, { ...base, tenant: 'bob', jobs: three }).ok, true);
});

test('rate limit refills over time', () => {
  let s = rateLimit(undefined, { perMinute: 2, now: T0 }).state;
  s = rateLimit(s, { perMinute: 2, now: T0 }).state;
  assert.equal(rateLimit(s, { perMinute: 2, now: T0 }).ok, false);
  assert.equal(rateLimit(s, { perMinute: 2, now: T0 + 30_000 }).ok, true);
});

test('spending gate: $0 limit runs only on free capacity; paid work is refused with the estimate and never starts', () => {
  const est = estimateVideo({ minutes: 30, profile: 'gen_quality' });
  assert.equal(spendGate(est, { spendLimitUsd: 0, freeCapacity: true }).path, 'free');
  const refused = spendGate(est, { spendLimitUsd: 0, freeCapacity: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /needs paid compute \(about \$\d+\.\d\d by CHE's estimate\) and your spending limit is \$0/);
  assert.match(admit({ minutes: 1, estimate: est }, { tenant: 'owner', jobs: [], now: T0, freeCapacity: false }).reason, /spending limit is \$0/);
});

test('the queue never drops waiting or running jobs, however many finished ones there are', () => {
  const jobs = [
    ...Array.from({ length: MAX_JOBS }, (_, i) => job(`done${i}`, 'owner', { state: 'completed' })),
    job('waiting', 'owner'), job('running', 'owner', { state: 'rendering' }), job('paused', 'owner', { state: 'paused' }),
  ];
  const kept = keepJobs(jobs);
  assert.equal(kept.length, MAX_JOBS);
  for (const id of ['waiting', 'running', 'paused']) assert.ok(kept.some((j) => j.id === id), id);
  assert.ok(!kept.some((j) => j.id === 'done0'), 'the oldest finished job goes first');
});

function memStorage() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k), list: async () => new Map() };
}

test('load: 300 tenants and 5 GPU workers through the real queue: quotas hold, light tenants are not starved, claims stay fast', async () => {
  let t = T0;
  const q = new GpuQueue(memStorage(), () => t);
  const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
  let n = 0;
  const spec = (tenant) => ({ kind: 'face_preview', title: 'load', views: [0], samples: (n++ % 1000) + 1, res: 64 + (n % 900), tenant_id: tenant });
  // A heavy tenant floods the queue; only its plan's 3 are accepted.
  const heavy = [];
  for (let i = 0; i < 20; i++) heavy.push(await q.enqueue(spec('heavy')));
  assert.equal(heavy.filter((r) => r.ok).length, 3);
  assert.match(heavy.find((r) => !r.ok).detail, /already have 3 jobs waiting/);
  // 299 light tenants, one job each, arriving after the heavy tenant's.
  t += 1000;
  for (let i = 0; i < 299; i++) assert.equal((await q.enqueue(spec(`light${i}`))).ok, true);
  // 5 workers; each job takes 2 simulated minutes; the heavy tenant re-submits as soon as it can.
  const workers = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const order = []; const claimMs = [];
  for (let round = 0; round < 70; round++) {
    for (const w of workers) {
      const s = performance.now();
      const c = await q.claim(w, { gpu: GPU, blender: 'Blender 5.0.1' }, { class: 'colab' });
      claimMs.push(performance.now() - s);
      if (c.job) order.push(c.job.tenant_id || 'owner');
    }
    t += 120_000;
    for (const j of (await q.jobs()).filter((x) => x.state === 'rendering')) await q.control('cancel', j.id);
    await q.enqueue(spec('heavy'));
  }
  const heavyShare = order.filter((x) => x === 'heavy').length / order.length;
  const lightDone = new Set(order.filter((x) => x.startsWith('light'))).size;
  assert.ok(order.length >= 300, `claimed ${order.length}`);
  assert.equal(lightDone, 299, 'every light tenant got its job run');
  assert.ok(heavyShare < 0.1, `the heavy tenant took ${Math.round(heavyShare * 100)}% of runs, not the queue`);
  claimMs.sort((a, b) => a - b);
  const p95 = claimMs[Math.floor(claimMs.length * 0.95)];
  assert.ok(p95 < 50, `p95 claim ${p95.toFixed(1)} ms`);
});
