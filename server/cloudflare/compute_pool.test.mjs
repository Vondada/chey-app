// Compute pool (compute_pool.js) over the existing Creation Engine queue (gpu_queue.js): provider registry and statuses,
// selection order, cooldowns on quota answers, bounded provider attempts then waiting with a reason, checkpoint resume
// after a handoff, GPU-only jobs never on a CPU, the Kaggle character kernel and its scoped token, and no secret in any
// response. Offline: every outside call goes to a fake fetcher.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuQueue, LEASE_MS, gpuWorkerRoute } from './gpu_queue.js';
import { ensureCapacity } from './creation_orchestrator.js';
import {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, KAGGLE_RESERVE_MS, MAX_PROVIDER_ATTEMPTS, POOL_KEY, POOL_PROVIDERS,
  backoffMs, characterKernelScript, classifyFailure, coolDown, emptyPool, loadPool, poolRoute, poolView, providerStatuses, selectProvider,
} from './compute_pool.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const GPU_DEV = "DEVICE OPTIX ['Tesla T4'] 384x480";
const CPU_DEV = "DEVICE CPU ['AMD EPYC 7763'] 384x480";
const ENV = { CHE_GITHUB_TOKEN: 'ghp_test_secret_value', CHE_GITHUB_REPO: 'Vondada/chey-app' };
const KAGGLE_SECRET = 'owneruser:KGAT_test_secret_value_1234567890';
const GH = { class: 'github_cpu', run_id: '500' };
const COLAB = { class: 'colab' };

function glb(extra = 0) {
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, pad: 'x'.repeat(extra) });
  const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const total = 12 + 8 + padded.length; const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function setup() {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const storage = memStorage();
  const now = () => t;
  // No seeded face jobs: these tests own the queue.
  storage.m.set('gpu:seeded', 'test'); storage.m.set('gpu:jobs', []);
  return { storage, now, q: new GpuQueue(storage, now), advance: (ms) => { t += ms; }, t: () => t };
}
const person = (over = {}) => ({ kind: 'person_model', title: 'Test person', views: [0], settings: { MODEL_MODE: 'bust', IDENTITY: 'che' }, priority: 'high', ...over });
const receipt = (sha, dev) => ({ status: 'complete', blender_version: 'Blender 5.0.1', nvidia_smi: GPU, views: { 0: { status: 'ok', name: 'front', device: dev, render_seconds: 3, sha256: 'b'.repeat(64) } },
  model: { status: 'ok', sha256: sha, bytes: 100, mode: 'bust' } });

/** Statuses as providerStatuses returns them, with chosen states (selection is pure over them). */
function statuses(over = {}) {
  const base = { github_actions_cpu: 'ready', colab_gpu: 'offline', kaggle: 'no_credential', hf_zerogpu: 'incompatible', workers_ai: 'incompatible',
    cloud_computer: 'no_credential', vmware_training: 'no_credential', hf_training: 'no_credential', ...over };
  return POOL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, gpu: p.gpu, compatible: p.compatible, status: base[p.id], reason: `${p.id} ${base[p.id]}` }));
}

test('selection order: a ready GPU first, else the free CPU worker; GPU-only jobs never get a CPU; unverified Kaggle only for GPU-only work', () => {
  const pref = { kind: 'person_model', requires: { gpu: 'preferred' } };
  const req = { kind: 'face_preview', requires: { gpu: 'required' } };
  const none = { kind: 'object_model', requires: { gpu: 'none' } };
  assert.equal(selectProvider(statuses(), pref).provider, 'github_actions_cpu', 'CPU fallback stays the default');
  assert.equal(selectProvider(statuses({ colab_gpu: 'ready' }), pref).provider, 'colab_gpu');
  assert.equal(selectProvider(statuses({ kaggle: 'ready' }), pref).provider, 'kaggle', 'a verified Kaggle beats the CPU');
  assert.equal(selectProvider(statuses({ colab_gpu: 'ready', kaggle: 'ready' }), pref).provider, 'colab_gpu', 'the open Colab before Kaggle quota');
  assert.equal(selectProvider(statuses({ kaggle: 'unverified' }), pref).provider, 'github_actions_cpu', 'unverified Kaggle is not used for CPU-capable work');
  assert.equal(selectProvider(statuses({ kaggle: 'unverified' }), pref, { allowUnverified: true }).provider, 'kaggle');
  assert.equal(selectProvider(statuses({ kaggle: 'unverified' }), req).provider, 'kaggle');
  const gpuOnly = selectProvider(statuses(), req);
  assert.equal(gpuOnly.provider, null, 'a GPU-only job never falls back to the CPU');
  assert.match(gpuOnly.why, /needs a GPU and none is ready/);
  assert.equal(selectProvider(statuses({ colab_gpu: 'ready' }), none).provider, 'github_actions_cpu', 'CPU-only work leaves the GPU free');
  assert.equal(selectProvider(statuses({ github_actions_cpu: 'cooling_down' }), pref).provider, null);
  // Incompatible providers are never chosen, whatever their state.
  const all = statuses({ hf_zerogpu: 'ready', workers_ai: 'ready', github_actions_cpu: 'offline' });
  assert.equal(selectProvider(all, pref).provider, null);
});

test('registry: honest statuses, booleans for credentials, real Kaggle quota, HF ZeroGPU and Workers AI incompatible', async () => {
  const s = setup();
  // Nothing saved: no_credential everywhere a credential is needed; the GitHub CPU is ready with its token.
  let list = await providerStatuses(ENV, { storage: s.storage, now: s.now });
  const by = (id) => list.find((p) => p.id === id);
  assert.equal(by('github_actions_cpu').status, 'ready');
  assert.match(by('github_actions_cpu').evidence, /40153146586/);
  assert.equal(by('colab_gpu').status, 'no_credential');
  assert.equal(by('kaggle').status, 'no_credential');
  assert.match(by('kaggle').reason, /No Kaggle token is saved/);
  assert.equal(by('hf_zerogpu').status, 'incompatible'); assert.equal(by('hf_zerogpu').compatible, false);
  assert.match(by('hf_zerogpu').evidence, /exclusively compatible with the Gradio SDK/);
  assert.equal(by('workers_ai').status, 'incompatible');
  for (const id of ['cloud_computer', 'vmware_training', 'hf_training']) assert.equal(by(id).status, 'no_credential', id);
  for (const p of list) assert.equal(typeof p.credential.exists, 'boolean', p.id);
  // A Kaggle token saved in the owner's Keys (the same store farmProviders reads): the real quota call, unverified.
  s.storage.m.set('provider_keys', { KAGGLE_API_TOKEN: KAGGLE_SECRET });
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    return new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '7200s', timeReserved: '0s' }, quotaRefreshTime: '2026-10-29T00:00:00Z' }), { status: 200 });
  };
  list = await providerStatuses(ENV, { storage: s.storage, now: s.now, fetcher });
  assert.equal(calls.length, 1); assert.match(calls[0].url, /GetAcceleratorQuotaStatistics$/);
  assert.equal(by('kaggle').status, 'unverified');
  assert.equal(by('kaggle').quota.left_s, 100800);
  assert.equal(by('kaggle').credential.exists, true);
  // Internal-only mode keeps work off Kaggle.
  s.storage.m.set('che:egress_policy', { internal_only: true });
  list = await providerStatuses(ENV, { storage: s.storage, now: s.now, fetcher });
  assert.equal(by('kaggle').status, 'offline'); assert.match(by('kaggle').reason, /internal-only/);
  s.storage.m.delete('che:egress_policy');
  // Quota under the margin: cooling down until Kaggle's own reset time.
  s.storage.m.delete(POOL_KEY);
  const low = async () => new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '104400s' }, quotaRefreshTime: '2026-10-29T00:00:00Z' }), { status: 200 });
  const pool = await loadPool(s.storage);
  list = await providerStatuses(ENV, { storage: s.storage, now: s.now, fetcher: low, pool });
  assert.equal(by('kaggle').status, 'cooling_down');
  assert.equal(by('kaggle').cooling_until, '2026-10-29T00:00:00.000Z');
});

test('cooldown: a quota answer cools the provider until its reset (else backoff, capped at 6 h) and the job is handed off without using an attempt', async () => {
  assert.equal(classifyFailure('render_failed', 'HTTP 429 Too Many Requests'), 'quota');
  assert.equal(classifyFailure('render_failed', 'job runner exit 1'), null, 'an ordinary failure stays the job\'s');
  assert.equal(backoffMs(1), BACKOFF_BASE_MS); assert.equal(backoffMs(30), BACKOFF_MAX_MS);
  const p = emptyPool(); const t = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(coolDown(p, 'kaggle', { kind: 'quota', resetMs: t + 86400_000 }, t).until_ms, t + 86400_000, 'known reset time');
  assert.equal(coolDown(emptyPool(), 'kaggle', { kind: 'quota' }, t).until_ms, t + BACKOFF_BASE_MS, 'unknown reset: backoff');

  const s = setup();
  const { job } = await s.q.enqueue(person());
  const c = await s.q.claim('colab-aaaa', { gpu: GPU }, COLAB);
  assert.equal(c.job.id, job.id);
  const out = await s.q.complete('colab-aaaa', { job_id: job.id, status: 'render_failed', error: 'HTTP 429: GPU quota exceeded' });
  assert.equal(out.job.state, 'queued'); assert.equal(out.job.failures, 0, 'a quota stop is not the job\'s failure');
  assert.match(out.job.history.at(-1).note, /could not finish it \(quota or rate limit\); handed to the next computer/);
  const pool = await loadPool(s.storage);
  assert.equal(pool.cooldowns.colab_gpu.kind, 'quota'); assert.equal(pool.cooldowns.colab_gpu.block_claims, true);
  assert.equal(pool.handoffs.at(-1).from, 'colab_gpu');
  assert.equal((await s.q.claim('colab-bbbb', { gpu: GPU }, COLAB)).job, null, 'a provider out of quota is handed nothing');
  const cpu = await s.q.claim('gha-500-1', { gpu: 'CPU (4 cores)' }, GH);
  assert.equal(cpu.job.id, job.id, 'the CPU worker takes the handoff');
  assert.equal((await loadPool(s.storage)).handoffs.at(-1).to, 'github_actions_cpu', 'the handoff names who took it');
});

test('GitHub answers 429 to a dispatch: the CPU worker cools down, nothing is re-dispatched, and the job says why it waits', async () => {
  const s = setup();
  const posts = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return new Response(JSON.stringify({ private: false }), { status: 200 });
    if (u.endsWith('/dispatches')) { posts.push(u); return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 429 }); }
    return new Response('{}', { status: 404 });
  };
  await s.q.enqueue(person());
  await ensureCapacity(ENV, { storage: s.storage, now: s.now, fetcher });
  assert.equal(posts.length, 1);
  const pool = await loadPool(s.storage);
  assert.equal(pool.cooldowns.github_actions_cpu.kind, 'quota');
  s.advance(9 * 60_000);   // past the 8-minute dispatch window and the first 5-minute cooldown
  const later = await ensureCapacity(ENV, { storage: s.storage, now: s.now, fetcher });
  assert.equal(posts.length, 2, 'after the 5-minute cooldown CHE tries again');
  assert.equal(later.dispatched, 0);
  const again = await ensureCapacity(ENV, { storage: s.storage, now: s.now, fetcher });
  assert.equal(posts.length, 2, 'cooling down: no third dispatch');
  assert.match(again.waiting_reason, /cooling down until \d\d:\d\d UTC \(quota: GitHub answered 429\)/);
  const job = (await s.q.jobs())[0];
  assert.match(job.cloud.reason, /cooling down/);
});

test('bounded provider attempts: after 3 lost sessions the job stays queued with a plain waiting reason; a fresh provider may still take it', async () => {
  const s = setup();
  const { job } = await s.q.enqueue(person());
  for (let i = 1; i <= MAX_PROVIDER_ATTEMPTS; i++) {
    if (i > 1) s.advance(60 * 60_000);          // past any backoff, so only the attempt bound can stop it
    const c = await s.q.claim(`gha-500-${i}`, { gpu: 'CPU (4 cores)' }, GH);
    assert.equal(c.job?.id, job.id, `attempt ${i} claims`);
    s.advance(LEASE_MS + 1);                    // the runner died
    await s.q.jobs();
  }
  let j = (await s.q.jobs())[0];
  assert.equal(j.state, 'paused'); assert.equal(j.failures, 0, 'lost sessions never fail the job');
  assert.ok(j.pool.hold_until_ms > s.t(), 'held');
  assert.match(j.pool.hold_reason, /Waiting until \d\d:\d\d UTC: 3 attempts could not finish it/);
  assert.equal((await s.q.claim('gha-500-9', { gpu: 'CPU (4 cores)' }, GH)).job, null, 'the provider that failed it waits out the hold');
  const view = await poolView(ENV, { storage: s.storage, now: s.now, refreshQuota: false });
  assert.match(view.waiting[0].waiting_reason, /3 attempts could not finish it/);
  assert.equal(view.waiting[0].attempts, 3);
  assert.equal(view.handoffs.length, 3);
  const cap = await ensureCapacity(ENV, { storage: s.storage, now: s.now, fetcher: async () => new Response(JSON.stringify({ private: false }), { status: 200 }) });
  assert.equal(cap.runnable, 0, 'a held job is not dispatched');
  j = (await s.q.jobs())[0];
  assert.match(j.cloud.reason, /3 attempts could not finish it/);
  const gpu = await s.q.claim('colab-cccc', { gpu: GPU }, COLAB);
  assert.equal(gpu.job.id, job.id, 'a provider that has not failed it may still take it');
  // After the hold the CPU may try again.
  await s.q.complete('colab-cccc', { job_id: job.id, status: 'render_failed', error: 'session ended' });
  s.advance(7 * 3600_000);
  assert.equal((await s.q.claim('gha-500-10', { gpu: 'CPU (4 cores)' }, GH)).job?.id, job.id);
});

test('checkpoint resume after a handoff: a dead CPU worker, then a GPU worker finishes with the same GLB; receipt names provider and attempts', async () => {
  const s = setup();
  const { job } = await s.q.enqueue(person());
  const model = glb(64);
  const a = await s.q.claim('gha-500-1', { gpu: 'CPU (4 cores)' }, GH);
  assert.equal(a.job.id, job.id);
  const up = await s.q.model({}, 'gha-500-1', job.id, model);
  assert.equal(up.ok, true);
  for (const st of ['model', 'rig']) await s.q.progress('gha-500-1', { job_id: job.id, stage: st, checkpoint: { stage: st, sha256: up.sha256, bytes: model.length } });
  s.advance(LEASE_MS + 1);                                          // the CPU runner died mid-render
  assert.equal((await s.q.jobs())[0].state, 'paused');
  const b = await s.q.claim('colab-dddd', { gpu: GPU }, COLAB);       // the next provider resumes
  assert.equal(b.job.id, job.id); assert.equal(b.resumed, true);
  assert.deepEqual(Object.keys(b.job.checkpoints), ['model', 'rig'], 'finished stages are kept, not rebuilt');
  assert.equal(b.job.model_url, `/api/gpu/worker/model?worker=colab-dddd&job=${job.id}`);
  const got = await s.q.workerModel({}, 'colab-dddd', job.id);
  assert.deepEqual(got, model, 'the resuming worker downloads the same GLB');
  assert.equal((await s.q.preview({}, 'colab-dddd', job.id, 0, PNG)).ok, true);
  const done = await s.q.complete('colab-dddd', { job_id: job.id, status: 'complete', receipt: receipt(up.sha256, GPU_DEV) });
  assert.equal(done.job.state, 'completed');
  assert.equal(done.job.model.sha256, up.sha256, 'the same artifact');
  assert.equal(done.job.receipt.provider, 'colab_gpu');
  assert.equal(done.job.receipt.attempts, 2);
  const pool = await loadPool(s.storage);
  assert.deepEqual(pool.handoffs.map((h) => [h.from, h.outcome, h.to]), [['github_actions_cpu', 'timeout', 'colab_gpu']]);
  assert.equal(pool.verified.colab_gpu.sha256, up.sha256);
});

test('a GPU-only job is never handed to a CPU worker, even after GPU failures and holds', async () => {
  const s = setup();
  const { job } = await s.q.enqueue(person({ requires: { gpu: 'required' } }));
  for (let i = 0; i < 4; i++) {
    assert.equal((await s.q.claim(`gha-500-${i + 1}`, { gpu: 'CPU (4 cores)' }, GH)).job, null, `round ${i}`);
    const c = await s.q.claim(`colab-e${i}xx`, { gpu: GPU }, COLAB);
    if (c.job) await s.q.complete(`colab-e${i}xx`, { job_id: job.id, status: 'gpu_unavailable' });
    s.advance(2 * 3600_000);
  }
  const j = (await s.q.jobs())[0];
  assert.ok(['queued', 'paused'].includes(j.state));
  assert.ok((j.pool.attempts || []).every((x) => x.provider !== 'github_actions_cpu'));
});

test('Kaggle character kernel: started only with a saved token, scoped hashed token, claims only its job, verified by a real GLB receipt', async () => {
  const s = setup();
  s.storage.m.set('provider_keys', { KAGGLE_API_TOKEN: KAGGLE_SECRET });
  const saved = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('GetAcceleratorQuotaStatistics')) return new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '0s' }, quotaRefreshTime: '2026-10-29T00:00:00Z' }), { status: 200 });
    if (u.endsWith('SaveKernel')) { saved.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ref: 'owneruser/che-character-worker', versionNumber: 1 }), { status: 200 }); }
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return new Response(JSON.stringify({ private: false }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const other = (await s.q.enqueue(person({ title: 'CPU job', settings: { MODEL_MODE: 'bust', IDENTITY: 'nova' } }))).job;
  const { job } = await s.q.enqueue(person({ requires: { gpu: 'required' }, settings: { MODEL_MODE: 'bust', IDENTITY: 'che' } }));
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher });   // no GitHub token: Kaggle is the only GPU route
  assert.deepEqual(cap.pool_started.jobs, [job.id]);
  assert.equal(saved.length, 1);
  const k = saved[0];
  assert.equal(k.isPrivate, true); assert.equal(k.enableGpu, true); assert.equal(k.sessionTimeoutSeconds, 3 * 3600);
  assert.match(k.text, /blender-\{BLENDER\}\.sha256/); assert.match(k.text, /SHA-256 MISMATCH/);
  assert.match(k.text, /codeload\.github\.com\/\{REPO\}\/tar\.gz\/\{COMMIT\}/);
  assert.match(k.text, /COMMIT = "[a-f0-9]{40}"/);
  assert.doesNotMatch(k.text, /KGAT_test_secret_value/, 'the owner\'s Kaggle key never goes into the kernel');
  const token = /TOKEN = "([a-f0-9]{64})"/.exec(k.text)[1];
  const raw = JSON.stringify([...s.storage.m.entries()]);
  assert.doesNotMatch(raw, new RegExp(token), 'the worker token is stored only as a hash');
  // The kernel's worker authenticates with the scoped token and gets only its job.
  const call = async (route, body, { query = '', bytes = null } = {}) => {
    const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, { method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token, 'Content-Type': 'application/json' }, body: bytes || JSON.stringify(body) });
    const res = await gpuWorkerRoute({ storage: s.storage, env: {}, now: s.now }, `/api/gpu/worker/${route}`, req);
    return res.json();
  };
  const c = await call('claim', { worker_id: 'colab-kag1', gpu: GPU, blender: 'Blender 5.0.1' });
  assert.equal(c.job.id, job.id, 'the scoped token opens its own job');
  assert.notEqual(c.job.id, other.id);
  const model = glb(8);
  const up = await call('model', null, { query: `?worker=colab-kag1&job=${job.id}`, bytes: model });
  await call('preview', null, { query: `?worker=colab-kag1&job=${job.id}&view=0`, bytes: PNG });
  let view = await poolView({}, { storage: s.storage, now: s.now, fetcher });
  assert.equal(view.providers.find((p) => p.id === 'kaggle').status, 'unverified', 'unverified until a completed GLB is recorded');
  const done = await call('complete', { worker_id: 'colab-kag1', job_id: job.id, status: 'complete', receipt: receipt(up.sha256, GPU_DEV) });
  assert.equal(done.job.state, 'completed');
  assert.equal(done.job.receipt.provider, 'kaggle'); assert.equal(done.job.receipt.attempts, 1);
  view = await poolView({}, { storage: s.storage, now: s.now, fetcher });
  const kag = view.providers.find((p) => p.id === 'kaggle');
  assert.equal(kag.status, 'ready'); assert.equal(kag.verified.sha256, up.sha256);
  assert.match(kag.reason, /^Verified: job gpu_/);
  // A token that expired opens nothing.
  s.advance(3 * 3600_000 + 1);
  assert.equal((await call('claim', { worker_id: 'colab-kag1', gpu: GPU })).detail, 'Not found.');
});

test('a Kaggle session that never claims hands its job on (start_timeout) and Kaggle cools down', async () => {
  const s = setup();
  s.storage.m.set('provider_keys', { KAGGLE_API_TOKEN: KAGGLE_SECRET });
  const fetcher = async (url) => {
    const u = String(url);
    if (u.endsWith('GetAcceleratorQuotaStatistics')) return new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '0s' } }), { status: 200 });
    if (u.endsWith('SaveKernel')) return new Response(JSON.stringify({ ref: 'owneruser/che-character-worker' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const { job } = await s.q.enqueue(person({ requires: { gpu: 'required' } }));
  await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher });
  assert.equal((await s.q.claim('colab-ffff', { gpu: GPU }, COLAB)).job, null, 'reserved for the Kaggle session meanwhile');
  s.advance(KAGGLE_RESERVE_MS + 1);
  await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher });
  const pool = await loadPool(s.storage);
  assert.equal(pool.handoffs.at(-1).outcome, 'start_timeout'); assert.equal(pool.handoffs.at(-1).job_id, job.id);
  assert.ok(pool.cooldowns.kaggle.until_ms > s.t());
  assert.equal((await s.q.claim('colab-ffff', { gpu: GPU }, COLAB)).job.id, job.id, 'the next GPU takes it');
});

test('no secret in any pool response (owner view, probe view, spoken text) and unsafe kernel values are refused', async () => {
  const s = setup();
  s.storage.m.set('provider_keys', { KAGGLE_API_TOKEN: KAGGLE_SECRET, HF_TOKEN: 'hf_test_secret_value' });
  s.storage.m.set('gpu:token', { token_hash: 'c'.repeat(64), created_at: 'x', revoked: false });
  const env = { ...ENV, HF_TOKEN: 'hf_test_secret_value', CHE_COMPUTER_URL: 'https://secret.example/hook', CHE_COMPUTER_TOKEN: 'computer_test_secret_value' };
  const fetcher = async () => new Response(JSON.stringify({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '0s' } }), { status: 200 });
  for (const path of ['/api/creations/pool', '/api/creations/probe/pool']) {
    const res = await poolRoute({ storage: s.storage, env, now: s.now, fetcher }, path, new Request(`https://che.example${path}`));
    const text = await res.text();
    assert.equal(res.status, 200);
    for (const secret of ['KGAT_test_secret_value', 'hf_test_secret_value', 'ghp_test_secret_value', 'computer_test_secret_value', 'secret.example', 'c'.repeat(64)]) {
      assert.doesNotMatch(text, new RegExp(secret), `${path} leaks ${secret.slice(0, 8)}`);
    }
    const body = JSON.parse(text);
    assert.equal(body.providers.find((p) => p.id === 'cloud_computer').credential.exists, true);
    assert.equal(body.providers.find((p) => p.id === 'cloud_computer').status, 'unverified');
    assert.match(body.spoken, /Spending limit: zero dollars/);
  }
  assert.throws(() => characterKernelScript({ base: 'https://x.example"; import os', token: 'a'.repeat(64), deadlineS: 100 }), /unsafe/);
  assert.throws(() => characterKernelScript({ base: 'https://x.example', token: 'not-a-token', deadlineS: 100 }), /unsafe/);
});
