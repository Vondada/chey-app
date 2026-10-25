// Compute pool benchmark (not part of the test suite): node compute_pool_bench.mjs
// Measures, on this machine: (1) the scheduling decision (selectProvider + poolAllows + heldReason) over N queued
// jobs, (2) applyPending over N jobs with nothing pending (the per-request cost), and (3) the JSON size of one job
// record and of the pool state, as Durable Object storage holds them (structured clone ~ JSON size).
import { GpuQueue } from './gpu_queue.js';
import { POOL_PROVIDERS, applyPending, emptyPool, heldReason, poolAllows, poolNote, poolOnClaim, selectProvider } from './compute_pool.js';

const mem = () => { const m = new Map(); return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k), list: async () => new Map() }; };
const t0 = Date.parse('2026-10-25T12:00:00Z');
const statuses = POOL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, gpu: p.gpu, compatible: p.compatible, status: p.id === 'github_actions_cpu' ? 'ready' : p.id === 'kaggle' ? 'unverified' : 'offline', reason: 'r' }));

function jobs(n) {
  const q = new GpuQueue(mem(), () => t0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = q.newJob({ kind: 'person_model', title: `Person ${i}`, views: [0, 45, 90], settings: { IDENTITY: 'che', STYLE: 'photoreal', MODEL_MODE: 'full_body', QUALITY: 'standard' }, requires: { gpu: i % 10 ? 'preferred' : 'required' } }, t0 + i);
    out.push(j);
  }
  return out;
}

function time(label, fn, reps = 5) {
  const ms = [];
  for (let r = 0; r < reps; r++) { const a = process.hrtime.bigint(); fn(); ms.push(Number(process.hrtime.bigint() - a) / 1e6); }
  ms.sort((x, y) => x - y);
  console.log(`${label}: median ${ms[Math.floor(reps / 2)].toFixed(2)} ms (min ${ms[0].toFixed(2)}, max ${ms.at(-1).toFixed(2)}, ${reps} runs)`);
  return ms[Math.floor(reps / 2)];
}

console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
for (const n of [1000, 10000]) {
  const list = jobs(n); const pool = emptyPool();
  time(`schedule decision over ${n} queued jobs`, () => {
    let picked = 0;
    for (const j of list) { if (!heldReason(pool, j, t0) && selectProvider(statuses, j, { pool, t: t0 }).provider) picked++; poolAllows(pool, j, 'github_actions_cpu', t0); }
    return picked;
  });
}
const big = jobs(10000);
await (async () => {
  const s = mem(); const a = process.hrtime.bigint();
  await applyPending(s, big, t0);
  console.log(`applyPending over 10000 jobs, nothing pending: ${(Number(process.hrtime.bigint() - a) / 1e6).toFixed(2)} ms`);
})();

// One record before and after the pool's per-job fields (a job that was handed off once, then completed).
const [j] = jobs(1);
const before = JSON.stringify(j).length;
poolOnClaim(j, 'github_actions_cpu', 'gha-40153146586-1', t0); poolNote(j, { provider: 'github_actions_cpu', worker_id: 'gha-40153146586-1' }, 'timeout', t0 + 600_000, 'the worker stopped answering (lease expired)');
poolOnClaim(j, 'colab_gpu', 'colab-0123456789', t0 + 700_000); poolNote(j, { provider: 'colab_gpu', worker_id: 'colab-0123456789' }, 'completed', t0 + 900_000);
await applyPending(mem(), [j], t0 + 1_000_000);   // as stored: outcomes applied
const after = JSON.stringify(j).length;
console.log(`job record (person_model, 3 views, queued): ${before} bytes; with 2 pool attempts: ${after} bytes (+${after - before}); a full attempts list (6, the cap) adds about ${Math.round((after - before) / 2) * 6} bytes`);
const pool = emptyPool();
for (let i = 0; i < 50; i++) pool.handoffs.push({ at: new Date(t0).toISOString(), job_id: 'gpu_0123456789ab', from: 'github_actions_cpu', outcome: 'timeout', reason: 'the worker stopped answering (lease expired)', to: 'colab_gpu', to_at: new Date(t0).toISOString() });
pool.cooldowns.kaggle = { until_ms: t0, until: new Date(t0).toISOString(), kind: 'quota', reason: 'x'.repeat(80), strikes: 1, at: new Date(t0).toISOString(), block_claims: true };
console.log(`pool state with 50 handoffs and one cooldown: ${JSON.stringify(pool).length} bytes (one storage key, ${'pool:state'})`);
