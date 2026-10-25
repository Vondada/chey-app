// Connect GPU (lib/create/che_gpu_connect.dart) polls GET /api/gpu and queues its test job through
// /api/gpu/identities/preview. These tests pin what the app relies on: a heartbeat counts as fresh only for
// ONLINE_MS (90 s); the test job is a real GPU-only job that goes first and never runs on a CPU; and a disconnect keeps
// the job and its checkpoints for the next worker, which is what the app's "GPU disconnected" banner says.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuQueue, LEASE_MS, ONLINE_MS, gpuOwnerRoute, speakGpuConnect } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return {
    m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
function setup() {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const storage = memStorage();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const ctx = { storage, env: {}, now: clock.now };
  const get = async () => (await gpuOwnerRoute(ctx, '/api/gpu', new Request('https://che.example/api/gpu'), {})).json();
  const post = async (path, body) => {
    const res = await gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method: 'POST', body: JSON.stringify(body) }), body);
    return { status: res.status, body: await res.json() };
  };
  return { storage, clock, q: new GpuQueue(storage, clock.now), get, post };
}
const TEST_JOB = { preset_id: 'che', styles: ['stylized'], views: [0], samples: 16, res: 160, priority: 'high' };

test('the status route the app polls: a GPU heartbeat is online for 90 s, then it is stale and never "connected"', async () => {
  const { q, clock, get } = setup();
  assert.equal(ONLINE_MS, 90_000);
  let view = await get();
  assert.equal(view.workers.length, 0);
  assert.match(speakGpuConnect(view), /^GPU not connected yet: no Colab GPU worker has checked in during the last 90 seconds/);
  await q.touchWorker('colab-1', { class: 'colab', gpu: GPU, state: 'idle' });
  view = await get();
  assert.equal(view.workers[0].online, true); assert.equal(view.workers[0].gpu, GPU); assert.ok(view.workers[0].last_seen);
  assert.match(speakGpuConnect(view), /^GPU connected: CHE's worker has a fresh heartbeat from Tesla T4/);
  assert.match(speakGpuConnect(view), /Colab can end the runtime at any time; jobs then resume from their checkpoints/);
  clock.advance(ONLINE_MS - 1);
  assert.equal((await get()).workers[0].online, true, 'still fresh just under 90 s');
  clock.advance(2);
  view = await get();
  assert.equal(view.workers[0].online, false, 'stale after 90 s');
  assert.match(speakGpuConnect(view), /^GPU not connected yet/);
  // A CPU worker's heartbeat is never a connected GPU.
  await q.touchWorker('gh-1', { class: 'github_cpu', state: 'idle' });
  assert.match(speakGpuConnect(await get()), /^GPU not connected yet/);
});

test('the Connect GPU test job is one small face preview, queued first, and only a GPU worker can take it', async () => {
  const { q, post, get } = setup();
  await q.jobs();   // the seeded jobs are already waiting at normal priority
  const queued = await post('/api/gpu/identities/preview', TEST_JOB);
  assert.equal(queued.status, 202);
  const job = queued.body.jobs[0].job;
  assert.equal(job.kind, 'face_preview'); assert.deepEqual(job.views, [0]); assert.equal(job.res, 160); assert.equal(job.samples, 16);
  assert.equal(job.priority, 'high'); assert.equal(job.requires.gpu, 'required');
  // A CPU worker is handed nothing: face previews are GPU-only.
  const cpu = await q.claim('gh-1', { cores: 4 }, { class: 'github_cpu' });
  assert.equal(cpu.job, null);
  const gpu = await q.claim('colab-1', { gpu: GPU });
  assert.equal(gpu.job.id, job.id, 'the test job goes before the seeded jobs');
  assert.equal((await get()).jobs.find((j) => j.id === job.id).state, 'rendering');
  // Asking again while it waits does not queue a second copy.
  const again = await post('/api/gpu/identities/preview', TEST_JOB);
  assert.equal(again.body.jobs[0].duplicate, true);
  assert.equal(again.body.jobs[0].job.id, job.id);
  // An unknown priority is not trusted.
  const odd = await post('/api/gpu/identities/preview', { ...TEST_JOB, res: 170, priority: 'urgent' });
  assert.equal(odd.body.jobs[0].job.priority, 'normal');
});

test('a disconnect keeps the job and its checkpoints, and the next worker resumes it (the app\'s disconnected banner)', async () => {
  const { q, clock, get } = setup();
  const { job } = await q.enqueue({ title: 'person', kind: 'person_model', views: [0], settings: { IDENTITY: 'che' }, priority: 'high' });
  const first = await q.claim('colab-a', { gpu: GPU });
  assert.equal(first.job.id, job.id);
  await q.progress('colab-a', { job_id: job.id, stage: 'rig', checkpoint: { stage: 'model', sha256: 'b'.repeat(64), bytes: 1234 } });
  clock.advance(ONLINE_MS + 1);
  let view = await get();
  assert.equal(view.workers.find((w) => w.id === 'colab-a').online, false, 'the app sees a stale heartbeat first');
  assert.equal(view.jobs.find((j) => j.id === job.id).state, 'rendering', 'the job is not lost while the lease runs');
  clock.advance(LEASE_MS);
  view = await get();
  const paused = view.jobs.find((j) => j.id === job.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.checkpoints.model.sha256, 'b'.repeat(64), 'the checkpoint is kept');
  assert.match(paused.history.at(-1).note, /next compatible worker resumes it; finished views and checkpoints are kept/);
  const next = await q.claim('colab-b', { gpu: GPU });
  assert.equal(next.job.id, job.id); assert.equal(next.resumed, true);
  assert.equal(next.job.checkpoints.model.sha256, 'b'.repeat(64), 'the next worker gets the checkpoint to resume from');
});
