// The character acceptance run (creation_probe.js accept/*), driven on the live Worker by tools/creation_accept.mjs:
// three described characters, a synthetic fictional reference and its no-reference twin, chained edits as versions with
// their own jobs, status that never counts a queued job as generated, and a fresh reopen of each saved project.
// Synthetic bytes only; workers are simulated through the queue's own worker methods.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ACCEPT_PEOPLE, acceptTitle, creationProbeRoute } from './creation_probe.js';
import { creationRoute } from './creation_studio.js';
import { GpuQueue } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
function glb(tag = 0) {
  const text = JSON.stringify({ asset: { version: '2.0' }, tag }); const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const b = new Uint8Array(20 + padded.length); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, b.length, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A free cloud CPU worker builds one job: model, three previews, a complete receipt with a verified rig. */
export async function finishJob(q, wid, id, tag) {
  const c = await q.claim(wid, { cores: 4 }, { class: 'github_cpu', run_id: wid.split('-')[1] });
  assert.equal(c.job?.id, id, `the worker took ${id}`);
  const model = glb(tag);
  assert.equal((await q.model({}, wid, id, model)).ok, true);
  for (const v of [0, 45, 90]) assert.equal((await q.preview({}, wid, id, v, PNG)).ok, true);
  const sha = createHash('sha256').update(model).digest('hex');
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: 'DEVICE CPU 4 threads' }]));
  const rig = { ok: true, bones: 53, clips: [{ name: 'idle', seconds: 4 }], morphs: ['jaw_open'] };
  const done = await q.complete(wid, { job_id: id, status: 'complete', receipt: { status: 'complete', views, process_seconds: 600, threads: 4,
    device_summary: { kind: 'CPU', name: 'GitHub runner CPU', threads: 4, limits: [] },
    model: { status: 'ok', sha256: sha, bytes: model.length, mode: 'full_body', rig } } });
  assert.equal(done.job.state, 'completed', JSON.stringify(done.job.history?.at(-1)));
  return sha;
}

test('acceptance run: three described looks, a fictional reference and its twin, chained edits, status and a fresh reopen', async () => {
  let t = Date.parse('2026-10-25T20:00:00Z');
  const storage = memStorage(); const now = () => t;
  const ctx = { storage, env: {}, now };
  const call = async (path, body) => creationProbeRoute(ctx, path.split('?')[0], new Request(`https://che.example${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }));
  const j = async (path, body) => (await call(path, body)).json();
  const start = await j('/api/creations/probe/accept/start', { reference_b64: Buffer.from(PNG).toString('base64') });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.deepEqual(start.items.map((i) => i.key), ['photoreal', 'photoreal_noref', 'hybrid', 'stylized']);
  assert.equal(new Set(start.items.map((i) => i.job_id)).size, 4, 'four separate jobs');
  assert.ok('automatic' in start.engine);
  const q = new GpuQueue(storage, now);
  const jobs = await q.jobs();
  const job = (key) => jobs.find((x) => x.id === start.items.find((i) => i.key === key).job_id);
  assert.deepEqual(['photoreal', 'hybrid', 'stylized'].map((k) => job(k).settings.STYLE), ['photoreal', 'hybrid', 'stylized']);
  assert.equal(JSON.parse(job('photoreal').settings.REFERENCE).consent, 'fictional');
  assert.equal(job('photoreal_noref').settings.REFERENCE, undefined);
  const { REFERENCE: _ref, ...withoutRef } = job('photoreal').settings;
  assert.deepEqual(withoutRef, job('photoreal_noref').settings, 'the twin differs only by the reference');
  assert.deepEqual(['photoreal', 'hybrid', 'stylized'].map((k) => job(k).settings.HAIR_STYLE), ['long_wavy', 'curly_short', 'afro']);
  assert.ok(Number(job('photoreal').settings.BODY_HEIGHT) > 0.5, 'tall');
  const list = await (await creationRoute(ctx, '/api/creations', new Request('https://che.example/api/creations'), {})).json();
  assert.deepEqual(list.projects.map((p) => p.title).sort(), ['photoreal', 'photoreal_noref', 'hybrid', 'stylized'].map(acceptTitle).sort());

  // Chained edits on one project, back to back, each a new version with its own job.
  const run = start.run_id; const edits = [];
  for (const [key, text] of [['photoreal_hair', 'give her short curly hair'], ['photoreal_clothing', 'put her in a hoodie'],
    ['photoreal_height', 'make her shorter'], ['photoreal_build', 'give her a heavier, broader build']]) {
    const e = await j('/api/creations/probe/accept/edit', { run_id: run, key, base_key: 'photoreal', text });
    assert.equal(e.ok, true, `${key}: ${JSON.stringify(e)}`);
    assert.ok(e.item.applied.length, key); edits.push(e.item);
  }
  assert.deepEqual(edits.map((e) => e.version), [3, 4, 5, 6], 'v1 described, v2 the reference, then one version per edit');
  assert.equal(new Set(edits.map((e) => e.job_id)).size, 4);
  const all = await q.jobs();
  const s = (key) => all.find((x) => x.id === edits.find((e) => e.key === key).job_id).settings;
  assert.equal(s('photoreal_hair').HAIR_STYLE, 'curly_short');
  assert.equal(s('photoreal_clothing').OUTFIT_TOP, 'hoodie');
  assert.ok(Number(s('photoreal_height').BODY_HEIGHT) < Number(s('photoreal_clothing').BODY_HEIGHT));
  assert.ok(Number(s('photoreal_build').BODY_WEIGHT) > Number(s('photoreal_height').BODY_WEIGHT || 0.5));
  assert.equal(JSON.parse(s('photoreal_build').REFERENCE).consent, 'fictional', 'edits keep the reference');
  assert.equal((await j('/api/creations/probe/accept/edit', { run_id: run, key: 'photoreal_hair', base_key: 'photoreal', text: 'bigger eyes' })).ok, false, 'keys are unique');
  assert.equal((await j('/api/creations/probe/accept/edit', { run_id: 'acc_nope', key: 'x', base_key: 'photoreal', text: 'taller' })).ok, false);

  // Before any worker: nothing counts as generated.
  let st = await j(`/api/creations/probe/accept/status?run=${run}`);
  assert.equal(st.items.length, 8); assert.ok(st.items.every((i) => i.generated === false && i.state === 'queued'));
  const queued = (await q.jobs()).filter((x) => x.state === 'queued' && x.kind === 'person_model');
  const shas = {}; let n = 1;
  for (const x of queued) { t += 1000; shas[x.id] = await finishJob(q, `gha-${700 + n}-1`, x.id, n); n += 1; }
  st = await j(`/api/creations/probe/accept/status?run=${run}`);
  assert.ok(st.items.every((i) => i.state === 'completed' && i.generated === true), JSON.stringify(st.items.map((i) => [i.key, i.state])));
  const hair = st.items.find((i) => i.key === 'photoreal_hair');
  assert.equal(hair.model.sha256, shas[hair.job_id]); assert.equal(hair.receipt.device_summary.kind, 'CPU');
  assert.deepEqual(hair.previews, ['front', 'three-quarter', 'side']);
  assert.match(hair.worker_name, /GitHub cloud CPU runner gha-/);
  assert.match(hair.device_line, /a CPU, not a GPU/);
  assert.equal((await call(`/api/creations/probe/model.glb?job=${hair.job_id}`)).status, 200);
  const pic = await call(`/api/creations/probe/preview.png?job=${hair.job_id}&name=front`);
  assert.equal(pic.status, 200); assert.deepEqual(new Uint8Array(await pic.arrayBuffer()), PNG);
  assert.equal((await call('/api/creations/probe/preview.png?job=gpu_000000000000&name=front')).status, 404);

  // Reopen: a fresh read of each saved project gives its newest saved version and that version's GLB.
  const re = await j(`/api/creations/probe/accept/reopen?run=${run}`);
  assert.equal(re.items.length, 4, 'one entry per project');
  const pr = re.items.find((i) => i.project_id === start.items[0].project_id);
  assert.equal(pr.saved_version, 6); assert.equal(pr.glb_version, 6); assert.equal(pr.model_sha256, shas[edits[3].job_id]);
  assert.ok(pr.saved_at); assert.equal(pr.reference.consent, 'fictional');
  for (const x of re.items) assert.ok(Object.values(shas).includes(x.model_sha256), x.key);

  // A second run reuses the projects (a new described version each); nothing new is added to My Creations.
  t += 60_000;
  const again = await j('/api/creations/probe/accept/start', {});
  assert.deepEqual(again.items.map((i) => i.key), ['photoreal', 'hybrid', 'stylized']);
  const list2 = await (await creationRoute(ctx, '/api/creations', new Request('https://che.example/api/creations'), {})).json();
  assert.equal(list2.projects.length, 4);
  const pj = (await q.jobs()).find((x) => x.id === again.items[0].job_id);
  assert.equal(pj.settings.REFERENCE, undefined, 'no reference this time');
  assert.equal(pj.settings.HAIR_STYLE, 'long_wavy', 'started from the description again');
  assert.match(ACCEPT_PEOPLE.photoreal, /woman/);
  // The old single-job check is unchanged.
  const old = await j('/api/creations/probe/start', {});
  assert.equal(old.ok, true); assert.match(old.job_id, /^gpu_/);
});
