// Creation Engine automatic cloud processing (creation_orchestrator.js + gpu_queue.js): Create Person queues a job,
// CHE dispatches the free GitHub CPU worker (only when the repository is verified public), the runner proves itself
// with OIDC, claims by priority and compute class, reports stage checkpoints, resumes from the uploaded GLB after a
// lapse, retries failures, and completes honestly as CPU. All GitHub traffic goes to a fake fetcher.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { creationRoute } from './creation_studio.js';
import { DISPATCH_WINDOW_MS, ensureCapacity } from './creation_orchestrator.js';
import { GpuQueue, LEASE_MS, gpuOwnerRoute, gpuWorkerRoute } from './gpu_queue.js';
import { resetOidcCache } from './gpu_oidc.js';
import { oidcSigner } from './oidc_test_signer.mjs';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const CPU_DEV = "DEVICE CPU ['AMD EPYC 7763'] 384x480";
const ENV = { CHE_GITHUB_TOKEN: 'ghp_test_secret_value', CHE_GITHUB_REPO: 'Vondada/chey-app' };

function glb(extra = 0) {
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, pad: 'x'.repeat(extra) });
  const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const total = 12 + 8 + padded.length; const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}

async function setup({ env = ENV, isPrivate = false, dispatchStatus = 204 } = {}) {
  resetOidcCache();
  let t = Date.parse('2026-10-24T12:00:00Z');
  const storage = memStorage(); const now = () => t;
  const signer = await oidcSigner();
  const github = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://token.actions.githubusercontent.com/')) return new Response(JSON.stringify({ keys: [signer.jwk] }), { status: 200 });
    github.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return new Response(JSON.stringify({ full_name: 'Vondada/chey-app', private: isPrivate }), { status: 200 });
    if (u.endsWith('/actions/workflows/che-creation-worker.yml/dispatches')) return new Response(dispatchStatus === 204 ? null : JSON.stringify({ message: 'Workflow not found' }), { status: dispatchStatus });
    return new Response('{}', { status: 404 });
  };
  const ctx = { storage, env, now, fetcher };
  const call = async (path, method = 'GET', body) => {
    const req = new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await creationRoute(ctx, path, req, body || {});
    return { status: res.status, body: await res.json() };
  };
  const token = async (run = '987654321') => signer.sign({ run_id: run }, Math.floor(t / 1000));
  const worker = async (route, body, { run = '987654321', query = '', bytes = null, method } = {}) => {
    const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
      method: method || (bytes ? 'PUT' : 'POST'), headers: { Authorization: `Bearer ${await token(run)}`, 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' },
      body: method === 'GET' ? undefined : (bytes || JSON.stringify(body)),
    });
    const res = await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, req);
    return { status: res.status, res, body: res.headers.get('Content-Type') === 'application/json' ? await res.json() : null };
  };
  const owner = async (path, method = 'GET', body) => gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
  return { storage, ctx, call, worker, owner, github, token, advance: (ms) => { t += ms; } };
}
const CPU_INFO = (n = 1, run = '987654321') => ({ worker_id: `gha-${run}-${n}`, gpu: 'CPU (4 cores)', blender: 'Blender 5.0.1', class: 'github_cpu', device: 'cpu', cores: 4, ram_gb: 16 });

test('Create Person on a public repo: CHE dispatches the free cloud worker; it claims by OIDC, checkpoints, and completes as CPU', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { base: 'nova' })).body.project;
  const gen = await s.call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 202);
  assert.equal(gen.body.job.priority, 'high'); assert.deepEqual(gen.body.job.requires, { gpu: 'preferred' });
  assert.equal(gen.body.job.display_state, 'Starting a cloud worker');
  assert.match(gen.body.spoken, /CHE is starting a free cloud worker; it builds on the CPU, slower than the GPU/);
  assert.doesNotMatch(gen.body.spoken, /Open Colab/);
  const dispatches = s.github.filter((g) => g.method === 'POST');
  assert.equal(dispatches.length, 1, 'one job, one worker');
  assert.deepEqual(dispatches[0].body, { ref: 'main', inputs: { reason: '1 creation job waiting' } }, 'only a non-secret reason is sent');
  assert.equal(gen.body.project.engine.automatic, true); assert.equal(gen.body.project.engine.status, 'cloud');
  // Polling does not dispatch again while that worker is on its way.
  await s.call(`/api/creations/${p.id}`); await s.call('/api/creations');
  assert.equal(s.github.filter((g) => g.method === 'POST').length, 1);
  assert.equal(s.github.filter((g) => g.method === 'GET').length, 1, 'visibility is cached');

  // The seeded face previews need a GPU, so the CPU worker gets the person job (and never a GPU-only one).
  const claim = await s.worker('claim', CPU_INFO());
  assert.equal(claim.status, 200); assert.equal(claim.body.job.id, gen.body.job.id);
  assert.deepEqual(claim.body.job.checkpoints, {}); assert.equal(claim.body.job.model_url, null);
  assert.equal(claim.body.job.worker_class, 'github_cpu'); assert.equal(claim.body.job.display_state, 'Creating');
  assert.match(claim.body.job.status_line, /free GitHub cloud CPU worker/);
  const id = gen.body.job.id; const wid = CPU_INFO().worker_id;
  assert.equal((await s.worker('progress', { worker_id: wid, job_id: id, stage: 'model', message: 'building' })).status, 200);
  const model = glb(64);
  assert.equal((await s.worker('model', null, { query: `?worker=${wid}&job=${id}`, bytes: model })).status, 200);
  const sha = (await s.call(`/api/creations/${p.id}`)).body.project.job.model.sha256;
  const ck = await s.worker('progress', { worker_id: wid, job_id: id, stage: 'rig', checkpoint: { stage: 'model', sha256: sha, bytes: model.length } });
  assert.equal(ck.status, 200);
  for (const v of [0, 45, 90]) assert.equal((await s.worker('preview', null, { query: `?worker=${wid}&job=${id}&view=${v}`, bytes: PNG })).status, 200);
  const d = (await s.call(`/api/creations/${p.id}`)).body.project;
  assert.equal(d.job.checkpoints.model.sha256, sha);
  assert.match(d.job.status_line, /stage 2 of 6 \(rig\)/);
  const media = [...s.storage.m.entries()].find(([k]) => k === 'media:index' || k === 'media')?.[1] || [];
  assert.ok(!JSON.stringify(media).includes('Colab T4 GPU'), 'CPU previews are never labelled GPU');

  // The rig receipt exactly as tools/avatar_body/verify_glb.py wrote it on a real CPU run (clips keyed by name).
  const rig = JSON.parse(readFileSync(new URL('./fixtures/full_body_rig_receipt.json', import.meta.url), 'utf8'));
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: CPU_DEV, render_seconds: 60, sha256: 'b'.repeat(64) }]));
  const done = await s.worker('complete', { worker_id: wid, job_id: id, status: 'complete',
    receipt: { status: 'complete', device: 'CPU', cores: 4, blender_version: 'Blender 5.0.1', views, model: { status: 'ok', sha256: sha, bytes: model.length, mode: 'full_body', rig } } });
  assert.equal(done.body.job.state, 'completed', JSON.stringify(done.body.job.history.at(-1)));
  assert.equal(done.body.job.rendered_on.class, 'github_cpu'); assert.equal(done.body.job.rendered_on.device, 'CPU');
  assert.match(done.body.job.history.at(-1).note, /CPU of a GitHub cloud runner \(4 cores\)/);
  assert.doesNotMatch(done.body.job.history.at(-1).note, /GPU/);
  assert.equal(done.body.job.display_state, 'Completed');
  // The verifier's keyed clips survive into the job (review of #521): 5 named clips with their real durations.
  const job = (await s.call(`/api/creations/${p.id}`)).body.project.job;
  assert.deepEqual(job.rig.clips, ['idle', 'walk', 'run', 'wave', 'talk']);
  assert.ok(JSON.stringify(done.body.job.history).includes('53 bones, 5 clips (idle, walk, run, wave, talk)'), JSON.stringify(done.body.job.history.map((h) => h.note)));
  assert.ok(!JSON.stringify([...s.storage.m.values()]).includes(ENV.CHE_GITHUB_TOKEN), 'the GitHub token is never stored');
});

test('a GPU view line from a CPU worker, or a CPU line from a Colab worker, is not accepted', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const id = (await s.call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.id;
  const wid = CPU_INFO().worker_id;
  await s.worker('claim', CPU_INFO());
  for (const v of [0, 45, 90]) await s.worker('preview', null, { query: `?worker=${wid}&job=${id}&view=${v}`, bytes: PNG });
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: "DEVICE OPTIX ['Tesla T4'] 384x480" }]));
  const out = await s.worker('complete', { worker_id: wid, job_id: id, status: 'complete', receipt: { status: 'complete', views } });
  assert.equal(out.body.job.state, 'queued'); assert.match(out.body.job.history.at(-1).note, /lack a CPU receipt/);
});

test('OIDC worker ids are tied to the token\'s run; the Colab token cannot use gha- ids; bad tokens see nothing', async () => {
  const s = await setup();
  assert.equal((await s.worker('claim', CPU_INFO(1, '111'))).status, 403, 'gha-111-1 with a run 987654321 token');
  assert.equal((await s.worker('claim', { ...CPU_INFO(), worker_id: 'colab-1' })).status, 403);
  const bad = new Request('https://che.example/api/gpu/worker/claim', { method: 'POST', headers: { Authorization: 'Bearer abc.def.ghi' }, body: '{}' });
  assert.equal((await gpuWorkerRoute(s.ctx, '/api/gpu/worker/claim', bad)).status, 404);
  const tok = await (await s.owner('/api/gpu/worker-token', 'POST', {})).json();
  const colab = new Request('https://che.example/api/gpu/worker/claim', { method: 'POST', headers: { 'X-CHE-GPU-Token': tok.token }, body: JSON.stringify({ worker_id: 'gha-987654321-1', gpu: GPU }) });
  assert.equal((await gpuWorkerRoute(s.ctx, '/api/gpu/worker/claim', colab)).status, 403);
});

test('scheduler: high priority first; a CPU worker never takes a GPU-required job, and takes a preferred one only with no GPU online', async () => {
  const s = await setup({ env: {} });
  const q = new GpuQueue(s.storage, s.ctx.now);
  const pref = (await q.enqueue({ kind: 'person_model', title: 'p', views: [0], settings: { A: '1' } })).job;
  s.advance(10);
  const high = (await q.enqueue({ kind: 'person_model', title: 'h', views: [0], settings: { A: '2' }, priority: 'high' })).job;
  const none = (await q.enqueue({ kind: 'face_preview', title: 'n', views: [0], settings: { A: '3' }, requires: { gpu: 'none' } })).job;
  assert.equal(high.requires.gpu, 'preferred'); assert.equal(none.requires.gpu, 'none');
  // A Colab GPU worker comes online first and claims (it takes the high-priority person job).
  const g = await q.claim('colab-1', { gpu: GPU });
  assert.equal(g.job.id, high.id);
  // With a GPU online, the CPU worker skips the GPU-preferred job and takes the CPU-allowed one.
  const c1 = await q.claim('gha-1-1', CPU_INFO(1, '1'), { class: 'github_cpu', run_id: '1' });
  assert.equal(c1.job.id, none.id);
  s.advance(LEASE_MS + 1);                                             // both go quiet; the GPU worker is offline
  const c2 = await q.claim('gha-1-2', CPU_INFO(2, '1'), { class: 'github_cpu', run_id: '1' });
  assert.equal(c2.job.id, high.id, 'paused high-priority job first, now that no GPU is online');
  assert.equal(c2.resumed, true);
  const c3 = await q.claim('gha-1-3', CPU_INFO(3, '1'), { class: 'github_cpu', run_id: '1' });
  assert.equal(c3.job.id, none.id);
  const c4 = await q.claim('gha-1-4', CPU_INFO(4, '1'), { class: 'github_cpu', run_id: '1' });
  assert.equal(c4.job.id, pref.id);
  // The 4th cloud worker exceeds the default limit of 3 once three hold jobs.
  await q.enqueue({ kind: 'person_model', title: 'x', views: [0], settings: { A: '9' } });
  const c5 = await q.claim('gha-1-5', CPU_INFO(5, '1'), { class: 'github_cpu', run_id: '1' });
  assert.equal(c5.job, null); assert.match(c5.detail, /3 cloud workers are already busy/);
  const seeded = (await q.jobs()).filter((j) => j.kind === 'face_preview' && j.requires?.gpu !== 'none');
  assert.ok(seeded.every((j) => j.state === 'queued'), 'GPU-required face previews never reach a CPU');
});

test('a lapsed lease pauses the job and CHE dispatches again; the resuming worker downloads the GLB and keeps checkpoints', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { base: 'vale' })).body.project;
  const id = (await s.call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.id;
  const w1 = CPU_INFO(1, '500');
  await s.worker('claim', w1, { run: '500' });
  const model = glb(32);
  await s.worker('model', null, { run: '500', query: `?worker=${w1.worker_id}&job=${id}`, bytes: model });
  const sha = (await s.call(`/api/creations/${p.id}`)).body.project.job.model.sha256;
  for (const st of ['model', 'rig', 'animate']) await s.worker('progress', { worker_id: w1.worker_id, job_id: id, stage: st, checkpoint: { stage: st, sha256: sha, bytes: model.length } }, { run: '500' });
  s.advance(DISPATCH_WINDOW_MS + LEASE_MS);                            // the runner died; the old dispatch is stale
  const d = (await s.call(`/api/creations/${p.id}`)).body.project;
  assert.equal(d.job.state, 'paused'); assert.match(d.job.status_line, /Finished stages kept: model, rig, animate/);
  assert.equal(s.github.filter((g) => g.method === 'POST').length, 2, 'a new worker was dispatched for the paused job');
  const w2 = CPU_INFO(1, '501');
  const claim = await s.worker('claim', w2, { run: '501' });
  assert.equal(claim.body.resumed, true);
  assert.deepEqual(Object.keys(claim.body.job.checkpoints), ['model', 'rig', 'animate']);
  assert.equal(claim.body.job.model_url, `/api/gpu/worker/model?worker=${w2.worker_id}&job=${id}`);
  const got = await s.worker('model', null, { run: '501', method: 'GET', query: `?worker=${w2.worker_id}&job=${id}` });
  assert.equal(got.status, 200); assert.deepEqual(new Uint8Array(await got.res.arrayBuffer()), model);
  const other = await s.worker('model', null, { run: '500', method: 'GET', query: `?worker=${w1.worker_id}&job=${id}` });
  assert.equal(other.status, 404, 'only the worker holding the job downloads it');
  // A failed run re-queues with checkpoints kept, three attempts, then fails with the real reason.
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await s.worker('claim', w2, { run: '501' });
    const out = await s.worker('complete', { worker_id: w2.worker_id, job_id: id, status: 'render_failed', error: `Cycles crashed ${i}` }, { run: '501' });
    assert.equal(out.body.job.state, i < 3 ? 'queued' : 'failed');
    assert.deepEqual(Object.keys(out.body.job.checkpoints), ['model', 'rig', 'animate']);
    if (i === 3) { assert.equal(out.body.job.display_state, 'Failed'); assert.match(out.body.job.status_line, /Cycles crashed 3/); }
  }
});

test('gates: a private repository, no token, auto_cloud off or a failing dispatch each wait with a plain reason; spend limit stays $0', async () => {
  const priv = await setup({ isPrivate: true });
  const p = (await priv.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const gen = await priv.call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(priv.github.filter((g) => g.method === 'POST').length, 0);
  assert.equal(gen.body.job.display_state, 'Waiting for Resources'); assert.match(gen.body.job.status_line, /is private, so GitHub runners could cost money/);
  assert.match(gen.body.spoken, /Open Colab/);

  const none = await setup({ env: {} });
  const p2 = (await none.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const g2 = await none.call(`/api/creations/${p2.id}/generate`, 'POST', {});
  assert.match(g2.body.job.status_line, /no GitHub token/); assert.equal(none.github.length, 0);

  const off = await setup();
  assert.equal((await off.call('/api/creations/engine/settings', 'POST', { auto_cloud: false })).status, 200);
  const p3 = (await off.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const g3 = await off.call(`/api/creations/${p3.id}/generate`, 'POST', {});
  assert.match(g3.body.job.status_line, /Automatic cloud workers are off/); assert.equal(off.github.length, 0);
  const spend = await off.call('/api/creations/engine/settings', 'POST', { spend_limit_usd: 5 });
  assert.equal(spend.status, 422); assert.match(spend.body.detail, /stays at \$0/);
  assert.equal((await off.call('/api/creations/engine/settings', 'POST', { max_cloud_workers: 11 })).status, 422);
  const ok = await off.call('/api/creations/engine/settings', 'POST', { max_cloud_workers: 2, auto_cloud: true, spend_limit_usd: 0 });
  assert.deepEqual(ok.body.settings, { auto_cloud: true, max_cloud_workers: 2, spend_limit_usd: 0 });

  const fail = await setup({ dispatchStatus: 404 });
  const p4 = (await fail.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const g4 = await fail.call(`/api/creations/${p4.id}/generate`, 'POST', {});
  assert.match(g4.body.job.status_line, /GitHub did not start the cloud worker \(status 404: Workflow not found\)/);
  await fail.call(`/api/creations/${p4.id}`);
  assert.equal(fail.github.filter((g) => g.method === 'POST').length, 1, 'backs off instead of retrying every poll');
  const eng = (await fail.call('/api/creations/engine')).body;
  assert.equal(eng.dispatches[0].ok, false); assert.equal(eng.dispatches[0].status, 404);
});

test('GET /api/creations/engine: settings, workers, capacity, providers (automatic vs manual), dispatches, spoken', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { base: 'che' })).body.project;
  await s.call(`/api/creations/${p.id}/generate`, 'POST', {});
  await s.worker('claim', CPU_INFO());
  const { status, body } = await s.call('/api/creations/engine');
  assert.equal(status, 200);
  assert.deepEqual(body.settings, { auto_cloud: true, max_cloud_workers: 3, spend_limit_usd: 0 });
  assert.equal(body.automatic, true);
  assert.deepEqual(body.workers.map((w) => [w.id, w.class, w.device, w.online, Boolean(w.job_id)]), [['gha-987654321-1', 'github_cpu', 'cpu', true, true]]);
  assert.deepEqual(body.capacity, { gpu_online: 0, cpu_online: 1, running: 1, max_concurrent: 3, runnable: 3 });
  assert.deepEqual(body.providers.map((x) => [x.id, x.automatic]), [['github_cpu', true], ['colab_t4', false]]);
  assert.ok(body.providers[0].verified_at); assert.match(body.providers[1].manual_step, /Colab/);
  assert.equal(body.dispatches.length, 1); assert.equal(body.dispatches[0].ok, true);
  assert.match(body.spoken, /1 job creating/); assert.match(body.spoken, /zero dollars/);
  assert.equal((await s.call('/api/creations/engine', 'POST', {})).status, 405);
  // The plain engine object the Creation Room reads.
  const list = (await s.call('/api/creations')).body.engine;
  for (const k of ['online', 'gpu', 'last_seen', 'notebook_url', 'automatic', 'status', 'workers_online', 'max_concurrent', 'waiting_reason']) assert.ok(k in list, k);
  assert.equal(list.workers_online, 1);
});

test('ensureCapacity never dispatches for GPU-only jobs and stays within max_cloud_workers', async () => {
  const s = await setup();
  const out = await ensureCapacity(ENV, { storage: s.storage, now: s.ctx.now, fetcher: s.ctx.fetcher });
  assert.equal(out.dispatched, 0, 'the seeded face previews need a GPU'); assert.equal(s.github.length, 0);
  const q = new GpuQueue(s.storage, s.ctx.now);
  for (let i = 0; i < 5; i++) await q.enqueue({ kind: 'person_model', title: `p${i}`, views: [0], settings: { N: String(i) } });
  const many = await ensureCapacity(ENV, { storage: s.storage, now: s.ctx.now, fetcher: s.ctx.fetcher });
  assert.equal(many.dispatched, 3, 'five jobs, at most three cloud workers');
  assert.equal((await ensureCapacity(ENV, { storage: s.storage, now: s.ctx.now, fetcher: s.ctx.fetcher })).dispatched, 0);
});
