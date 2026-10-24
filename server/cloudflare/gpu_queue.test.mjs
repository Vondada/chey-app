// GPU on demand (gpu_queue.js): the persistent queue the owner's Colab T4 notebook works. Covers the job lifecycle,
// leases (a disconnected Colab pauses, the next session resumes), the honesty gates (no "completed" without a GPU
// receipt and real pictures), the worker token, and the owner and worker routes as the Durable Object calls them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuQueue, LEASE_MS, MAX_FAILURES, SEED_JOBS, gpuOwnerRoute, gpuWorkerRoute, isGpuName, speakGpuSummary } from './gpu_queue.js';
import { listMedia } from './media.js';

function memStorage() {
  const m = new Map();
  return {
    m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const DEV = "DEVICE OPTIX ['Tesla T4'] 384x480";
const receipt = (views, over = {}) => ({
  status: 'complete', nvidia_smi: GPU, blender_version: 'Blender 5.0.1', device: 'OPTIX',
  views: Object.fromEntries(views.map((v) => [v, { status: 'ok', name: String(v), device: DEV, render_seconds: 9.5, sha256: 'a'.repeat(64) }])), ...over,
});

function setup() {
  let t = Date.parse('2026-10-24T12:00:00Z');
  const storage = memStorage();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  return { storage, clock, q: new GpuQueue(storage, clock.now) };
}

test('the queue seeds CHE\'s preset face jobs once (one per look), queued and waiting for a Colab session', async () => {
  const { q } = setup();
  const jobs = await q.jobs();
  assert.equal(jobs.length, SEED_JOBS.length);
  assert.equal(jobs[0].state, 'queued');
  assert.deepEqual(jobs[0].views, [0, 45, 90]);
  assert.equal(jobs[0].settings.BROW_W, '1.8');
  assert.equal(jobs[0].settings.IDENTITY, 'che', 'the identity preset is part of the job settings');
  assert.deepEqual(jobs.map((j) => j.settings.STYLE), ['photoreal', 'hybrid', 'stylized'], 'one job per look');
  assert.equal((await q.jobs()).length, SEED_JOBS.length, 'seeded only once');
});

test('a worker without a GPU is never handed a job', async () => {
  const { q } = setup();
  const out = await q.claim('colab-1', { gpu: 'unavailable: nvidia-smi not found' });
  assert.equal(out.ok, false);
  assert.match(out.detail, /No GPU/);
  assert.equal((await q.jobs())[0].state, 'queued');
  for (const bad of ['', 'unavailable: [Errno 2] No such file or directory: nvidia-smi', 'NVIDIA-SMI has failed']) assert.equal(isGpuName(bad), false, bad);
  for (const good of [GPU, 'NVIDIA L4, 550.54, 23034 MiB', 'NVIDIA A100-SXM4-40GB']) assert.equal(isGpuName(good), true, good);
});

test('claim, progress, previews into the media library, and a GPU receipt complete the job', async () => {
  const { q, storage } = setup();
  const { job } = await q.claim('colab-1', { gpu: GPU, blender: 'Blender 5.0.1' });
  assert.equal(job.state, 'rendering'); assert.equal(job.worker_id, 'colab-1');
  assert.equal((await q.progress('colab-1', { job_id: job.id, views_done: [0], current_view: 45, message: 'rendering three-quarter' })).ok, true);
  assert.equal((await q.jobs())[0].progress.pct, 33);
  for (const v of [0, 45, 90]) assert.equal((await q.preview({}, 'colab-1', job.id, v, PNG)).ok, true);
  const media = await listMedia(storage);
  assert.equal(media.length, 3);
  assert.ok(media.every((m) => m.source === 'colab_gpu' && m.mode === 'gpu_render' && /Colab T4 GPU/.test(m.title)));
  const done = await q.complete('colab-1', { job_id: job.id, status: 'complete', receipt: receipt([0, 45, 90]), drive_path: 'My Drive/CHE_GPU/jobs/face-abc' });
  assert.equal(done.job.state, 'completed');
  assert.equal(done.job.progress.pct, 100);
  assert.equal(done.job.drive_path, 'My Drive/CHE_GPU/jobs/face-abc');
  assert.match(done.job.history.at(-1).note, /Tesla T4/);
});

test('"complete" is refused without a GPU device in every view or without the uploaded pictures', async () => {
  const { q } = setup();
  const { job } = await q.claim('colab-1', { gpu: GPU });
  await q.preview({}, 'colab-1', job.id, 0, PNG); await q.preview({}, 'colab-1', job.id, 45, PNG);
  const cpu = receipt([0, 45, 90]); cpu.views[90].device = "DEVICE CPU ['CPU'] 384x480";
  const out = await q.complete('colab-1', { job_id: job.id, status: 'complete', receipt: cpu });
  assert.equal(out.job.state, 'queued');
  assert.match(out.job.history.at(-1).note, /Not accepted as complete: view 90/);
  const again = await q.claim('colab-1', { gpu: GPU });
  const second = await q.complete('colab-1', { job_id: again.job.id, status: 'complete', receipt: receipt([0, 45, 90]) });
  assert.equal(second.job.state, 'failed', 'view 90 still has no uploaded picture');
  assert.equal(second.job.failures, MAX_FAILURES);
});

test('a Colab disconnect pauses the job; the next session resumes it before queued work', async () => {
  const { q, clock } = setup();
  await q.enqueue({ title: 'second', views: [0], settings: { IRIS: '2' } });
  const first = await q.claim('colab-a', { gpu: GPU });
  await q.progress('colab-a', { job_id: first.job.id, views_done: [0] });
  clock.advance(LEASE_MS - 1000);
  assert.equal((await q.heartbeat('colab-a', { job_id: first.job.id })).stop, false);   // heartbeat extends the lease
  clock.advance(LEASE_MS - 1000);
  assert.equal((await q.jobs())[0].state, 'rendering');
  clock.advance(LEASE_MS + 1);                                                          // the session died
  const paused = (await q.jobs())[0];
  assert.equal(paused.state, 'paused');
  assert.match(paused.history.at(-1).note, /resumes in your next Colab session/);
  assert.deepEqual(paused.progress.views_done, [0], 'finished views are kept');
  const next = await q.claim('colab-b', { gpu: GPU });
  assert.equal(next.job.id, first.job.id); assert.equal(next.resumed, true);
  assert.equal(next.job.sessions, 2);
  assert.equal((await q.heartbeat('colab-a', { job_id: first.job.id })).stop, true, 'the old worker lost the job');
});

test('the owner cancels a rendering job; the worker is told to stop and cannot complete it', async () => {
  const { q } = setup();
  const { job } = await q.claim('colab-1', { gpu: GPU });
  assert.equal((await q.control('cancel', job.id)).ok, true);
  const hb = await q.heartbeat('colab-1', { job_id: job.id });
  assert.equal(hb.stop, true); assert.match(hb.reason, /cancelled/);
  assert.equal((await q.complete('colab-1', { job_id: job.id, status: 'complete', receipt: receipt([0, 45, 90]) })).ok, false);
  assert.equal((await q.control('retry', job.id)).job.state, 'queued');
});

test('no GPU in the session puts the job back in the queue instead of failing it; a failed face check fails it', async () => {
  const { q } = setup();
  let { job } = await q.claim('colab-1', { gpu: GPU });
  assert.equal((await q.complete('colab-1', { job_id: job.id, status: 'gpu_unavailable' })).job.state, 'queued');
  ({ job } = await q.claim('colab-1', { gpu: GPU }));
  const out = await q.complete('colab-1', { job_id: job.id, status: 'checks_failed', error: 'lip mask on the lips only' });
  assert.equal(out.job.state, 'failed'); assert.match(out.job.history.at(-1).note, /face check failed/);
});

test('the same request is not queued twice while it waits', async () => {
  const { q } = setup();
  // The seed jobs' settings now come from CHE's identity preset (avatar_identity.js), so the duplicate is the same
  // preset settings, not the older hand-written v7 subset.
  const a = await q.enqueue({ views: '0,45,90', settings: { ...SEED_JOBS[0].settings } });
  assert.equal(a.duplicate, true);
  assert.equal((await q.enqueue({ views: [0], settings: { BAD_key: 'x', IRIS: 3 } })).job.settings.IRIS, '3');
  assert.equal((await q.jobs()).length, SEED_JOBS.length + 1);
});

test('worker routes open only with the paired token; owner routes create it, list jobs and speak a summary', async () => {
  const { storage, clock } = setup();
  const ctx = { storage, env: {}, now: clock.now };
  const req = (path, body, token, method = 'POST') => new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CHE-GPU-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await gpuWorkerRoute(ctx, '/api/gpu/worker/claim', req('/api/gpu/worker/claim', { worker_id: 'colab-1', gpu: GPU }))).status, 404);
  const tokenRes = await gpuOwnerRoute(ctx, '/api/gpu/worker-token', req('/api/gpu/worker-token', {}), {});
  const { token } = await tokenRes.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(![...storage.m.values()].some((v) => JSON.stringify(v ?? '').includes(token)), 'the token is stored only as a hash');
  const claim = await (await gpuWorkerRoute(ctx, '/api/gpu/worker/claim', req('/api/gpu/worker/claim', { worker_id: 'colab-1', gpu: GPU }, token))).json();
  assert.equal(claim.job.state, 'rendering');
  const put = new Request(`https://che.example/api/gpu/worker/preview?worker=colab-1&job=${claim.job.id}&view=0`, { method: 'PUT', headers: { 'X-CHE-GPU-Token': token }, body: PNG });
  assert.equal((await gpuWorkerRoute(ctx, '/api/gpu/worker/preview', put)).status, 200);
  const view = await (await gpuOwnerRoute(ctx, '/api/gpu', req('/api/gpu', undefined, null, 'GET'), {})).json();
  assert.equal(view.counts.rendering, 1); assert.equal(view.worker_paired, true);
  assert.equal(view.workers[0].online, true); assert.equal(view.workers[0].gpu, GPU);
  assert.match(view.spoken, /1 rendering/); assert.match(view.spoken, /online on Tesla T4/); assert.match(view.spoken, /costs nothing/);
  assert.ok(view.jobs.find((j) => j.id === claim.job.id).previews['0']);
  await gpuOwnerRoute(ctx, '/api/gpu/worker-token/revoke', req('/api/gpu/worker-token/revoke', {}), {});
  assert.equal((await gpuWorkerRoute(ctx, '/api/gpu/worker/heartbeat', req('/api/gpu/worker/heartbeat', { worker_id: 'colab-1' }, token))).status, 404);
});

test('a non-PNG or oversized preview is refused', async () => {
  const { q } = setup();
  const { job } = await q.claim('colab-1', { gpu: GPU });
  assert.equal((await q.preview({}, 'colab-1', job.id, 0, new Uint8Array([1, 2, 3]))).ok, false);
  assert.equal((await q.preview({}, 'colab-1', job.id, 7, PNG)).ok, false);
});

test('the spoken summary never claims a session is open when none is', async () => {
  const { q } = setup();
  const v = await q.view();
  assert.match(speakGpuSummary(v), /No Colab GPU session is open right now/);
  assert.match(speakGpuSummary(v), /not paired yet/);
});

test('spoken GPU questions reach the catalog command; other cloud phrases keep their commands', async () => {
  const { cloudIntent } = await import('./cloud_computer.js');
  for (const said of ['CHE, what are my GPU jobs?', 'show me my Colab queue', 'Is my Colab worker online?', "what's the GPU queue doing"]) {
    assert.equal(cloudIntent(said)?.command, 'cloud-gpu', said);
  }
  assert.equal(cloudIntent('Open your cloud computer')?.command, 'cloud-open');
  assert.equal(cloudIntent('render my latest YouTube video')?.command, 'cloud-render');
  assert.equal(cloudIntent('What is a GPU?'), null);
});
