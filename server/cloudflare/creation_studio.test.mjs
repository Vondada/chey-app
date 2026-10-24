// Live Creation Studio (creation_studio.js): create a person, queue the model on the GPU queue, a worker streams the
// GLB and previews, the project shows the real stages; deterministic edits make versions with undo, redo and save;
// edits the renderer would refuse are refused; the model routes accept only real GLB files and serve them back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, NOTEBOOK_URL, creationRoute, parseEdit } from './creation_studio.js';
import { BUILT_IN, validate } from './avatar_identity.js';
import { gpuOwnerRoute, gpuWorkerRoute, isGlb } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return {
    m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const DEV = "DEVICE OPTIX ['Tesla T4'] 384x480";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A minimal valid GLB v2: 12-byte header, one JSON chunk. */
function glb(extra = 0) {
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, pad: 'x'.repeat(extra) });
  const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const total = 12 + 8 + padded.length;
  const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true);
  b.set(new TextEncoder().encode(padded), 20);
  return b;
}

function setup() {
  let t = Date.parse('2026-10-24T12:00:00Z');
  const storage = memStorage();
  const now = () => t;
  const ctx = { storage, env: {}, now };
  const call = async (path, method = 'GET', body) => {
    const req = new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await creationRoute(ctx, path.split('?')[0], req, body || {});
    return { status: res.status, body: await res.json() };
  };
  const worker = async (route, body, token, query = '', bytes = null) => {
    const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
      method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token, 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' },
      body: bytes || JSON.stringify(body),
    });
    const res = await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, req);
    return { status: res.status, body: await res.json() };
  };
  const owner = async (path, method = 'GET', body) => gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
  return { storage, ctx, call, worker, owner, advance: (ms) => { t += ms; } };
}

test('the studio lists real capabilities and an offline, unpaired Creation Engine with the Colab notebook link', async () => {
  const { call } = setup();
  const { status, body } = await call('/api/creations');
  assert.equal(status, 200);
  assert.deepEqual(body.projects, []);
  assert.equal(body.engine.online, false); assert.equal(body.engine.status, 'not_paired');
  assert.equal(body.engine.label, 'Creation Engine not connected');
  assert.equal(body.engine.notebook_url, NOTEBOOK_URL);
  assert.ok(!('jobs' in body.engine));
  assert.deepEqual(body.capabilities.map((c) => [c.id, c.status]), [['person', 'available'], ['object', 'available'], ['room', 'available'], ['animation', 'partial']]);
  assert.equal(CAPABILITIES.length, 4);
  // Objects and rooms say plainly what they are: a fixed family list, not free-form text-to-3D.
  for (const id of ['object', 'room']) {
    const c = body.capabilities.find((x) => x.id === id);
    assert.match(c.detail, /Procedural parametric objects and rooms from a fixed family list; not free-form text-to-3D\./);
  }
  assert.deepEqual(body.capabilities.find((x) => x.id === 'object').choices, ['lamp', 'chair', 'table', 'mug', 'vase', 'shelf']);
  assert.deepEqual(body.capabilities.find((x) => x.id === 'room').choices, ['living_room', 'bedroom', 'office', 'studio']);
  const dragon = await call('/api/creations', 'POST', { kind: 'object', base: 'dragon' });
  assert.equal(dragon.status, 422); assert.match(dragon.body.detail, /only these objects: lamp, chair, table, mug, vase, shelf, desk\. .*not free-form text-to-3D/);
  const kitchen = await call('/api/creations', 'POST', { kind: 'room', base: 'kitchen' });
  assert.equal(kitchen.status, 422); assert.match(kitchen.body.detail, /only these rooms: living room, bedroom, office, studio/);
  const anim = await call('/api/creations', 'POST', { kind: 'animation' });
  assert.equal(anim.status, 422); assert.match(anim.body.detail, /a preview only/);
});

test('Create Person -> generate -> the worker streams the GLB then previews -> real stages -> completed with the model', async () => {
  const { call, worker, owner, advance } = setup();
  const made = await call('/api/creations', 'POST', { kind: 'person', base: 'nova' });
  assert.equal(made.status, 201);
  const p = made.body.project;
  assert.match(p.id, /^cr_[a-f0-9]{12}$/);
  assert.equal(p.base_id, 'nova'); assert.equal(p.version, 1); assert.equal(p.versions_count, 1); assert.equal(p.job, null);
  assert.deepEqual(p.stages, []); assert.equal(p.model_url, null);

  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 202);
  assert.equal(gen.body.job.kind, 'person_model');
  assert.equal(gen.body.job.settings.IDENTITY, 'nova');
  assert.match(gen.body.spoken, /Queued\. It builds when the Creation Engine is running; it is not connected yet/);
  const again = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(again.body.duplicate, true, 'the same version is not queued twice');

  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  // The seeded CHE face jobs are older, so the worker would take them first; cancel them for this test.
  const view = await (await owner('/api/gpu')).json();
  for (const j of view.jobs.filter((x) => x.kind === 'face_preview')) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  advance(1000);
  const claim = await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  assert.equal(claim.body.job.id, gen.body.job.id);
  assert.equal(claim.body.job.kind, 'person_model', 'the worker is told to export the model');
  const online = await call('/api/creations');
  assert.equal(online.body.engine.label, 'Creation Engine Online'); assert.equal(online.body.engine.gpu, GPU);

  advance(5000);
  const model = glb(100);
  const up = await worker('model', null, token, `?worker=colab-1&job=${claim.body.job.id}`, model);
  assert.equal(up.status, 200); assert.equal(up.body.bytes, model.length);
  let d = (await call(`/api/creations/${p.id}`)).body.project;
  assert.equal(d.model_url, `/api/gpu/jobs/${claim.body.job.id}/model.glb`);
  assert.match(d.job.progress.message, /^Geometry ready: the 3D model arrived/);
  assert.equal(d.job.state, 'rendering', 'geometry first; the job is still rendering');
  const served = await owner(d.model_url);
  assert.equal(served.status, 200); assert.equal(served.headers.get('Content-Type'), 'model/gltf-binary');
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), model);

  for (const v of [0, 45, 90]) { advance(9000); assert.equal((await worker('preview', null, token, `?worker=colab-1&job=${claim.body.job.id}&view=${v}`, PNG)).status, 200); }
  d = (await call(`/api/creations/${p.id}`)).body.project;
  assert.deepEqual(Object.keys(d.previews).sort(), ['0', '45', '90']);
  assert.deepEqual(d.stages.map((s) => s.label), ['Queued', 'Started on the GPU', 'Geometry ready', 'Preview front arrived', 'Preview three-quarter arrived', 'Preview side arrived']);
  assert.ok(d.stages.every((s, i, a) => !i || s.at >= a[i - 1].at), 'timestamps in order');

  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: DEV, render_seconds: 9, sha256: 'a'.repeat(64) }]));
  // A receipt without the model (or with another model's hash) is not accepted as complete.
  const noModel = await worker('complete', { worker_id: 'colab-1', job_id: claim.body.job.id, status: 'complete', receipt: { status: 'complete', views } }, token);
  assert.equal(noModel.body.job.state, 'queued');
  assert.match(noModel.body.job.history.at(-1).note, /3D model was not uploaded or does not match/);
  const claim2 = await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  assert.equal(claim2.body.resumed, false);
  const sha = d.job.model.sha256;
  assert.equal(gen.body.job.settings.MODEL_MODE, 'full_body', 'Create Person builds the full body by default');
  // A full-body model without a verified skeleton is not accepted (attempt 2 of 3), with the reason.
  const noRig = await worker('complete', { worker_id: 'colab-1', job_id: claim.body.job.id, status: 'complete',
    receipt: { status: 'complete', views, model: { status: 'ok', file: 'model.glb', sha256: sha, bytes: model.length, vertices: 1234, mode: 'full_body' } } }, token);
  assert.equal(noRig.body.job.state, 'queued'); assert.match(noRig.body.job.history.at(-1).note, /no verified skeleton/);
  await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  const rig = { ok: true, bones: 53, weighted_vertices: 9000, clips: [{ name: 'idle', seconds: 4 }, { name: 'walk', seconds: 1.2 }, { name: 'wave', seconds: 2 }, { name: 'talk', seconds: 3 }], morphs: ['blink_L', 'blink_R', 'jaw_open'] };
  const done = await worker('complete', { worker_id: 'colab-1', job_id: claim.body.job.id, status: 'complete',
    receipt: { status: 'complete', views, model: { status: 'ok', file: 'model.glb', sha256: sha, bytes: model.length, vertices: 1234, mode: 'full_body', rig } } }, token);
  assert.equal(done.body.job.state, 'completed');
  assert.equal(done.body.job.rig.ok, true); assert.equal(done.body.job.rig.bones, 53);
  assert.equal(done.body.job.display_state, 'Completed');
  assert.equal(done.body.job.receipt.model.vertices, 1234);
  const fin = (await call(`/api/creations/${p.id}`)).body;
  assert.equal(fin.project.stages.at(-1).label, 'Completed');
  assert.match(fin.spoken, /3D model and previews for this version are ready/);
});

test('edits make versions; undo, redo and save move through them; view commands never make a version', async () => {
  const { call } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'vale', title: 'Vale test' })).body.project;
  assert.equal(p.params.hair.style, 'wavy_medium');
  const longer = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'CHE, make the hair longer.' });
  assert.equal(longer.body.changed, true);
  assert.deepEqual(longer.body.applied, ['Hair changed to long wavy.']);
  assert.equal(longer.body.project.params.hair.style, 'long_wavy');
  assert.equal(longer.body.project.version, 2);
  assert.match(longer.body.spoken, /Saved as version 2\. Say generate to build it\./);

  const outfit = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'Change the outfit' });
  assert.equal(outfit.body.changed, true);
  assert.match(outfit.body.applied[0], /^Outfit colour changed to .*do not show clothes yet/);
  assert.notEqual(outfit.body.project.params.outfit.color, p.params.outfit.color);

  const photo = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it stylized' });
  assert.equal(photo.body.project.style, 'stylized');
  const rot = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'Rotate the model' });
  assert.equal(rot.body.changed, false); assert.deepEqual(rot.body.viewport, { action: 'rotate', deg: 45 });
  assert.equal(rot.body.project.version, 4, 'no version for a view command');
  const anim = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'Animate the character' });
  assert.deepEqual(anim.body.viewport, { action: 'animate' }); assert.match(anim.body.applied[0], /once their skeleton is verified/);
  const office = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'Put this in my Office' });
  assert.equal(office.body.changed, false); assert.match(office.body.unsupported[0], /not built yet/);
  const nonsense = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it smell like roses' });
  assert.equal(nonsense.body.changed, false); assert.match(nonsense.body.unsupported[0], /can't change that yet/);

  const u1 = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(u1.body.project.version, 3); assert.equal(u1.body.project.can_redo, true);
  const u2 = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(u2.body.project.params.outfit.color, p.params.outfit.color, 'back before the outfit change');
  const r1 = await call(`/api/creations/${p.id}/redo`, 'POST', {});
  assert.equal(r1.body.project.version, 3);
  // A new edit after an undo drops the redo branch.
  const fork = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'bigger eyes' });
  assert.equal(fork.body.project.versions_count, 4);
  assert.equal(fork.body.project.can_redo, false);
  assert.deepEqual(fork.body.project.versions.map((v) => v.n), [1, 2, 3, 4]);
  const saved = await call(`/api/creations/${p.id}/save`, 'POST', {});
  assert.ok(saved.body.project.saved_at); assert.match(saved.body.spoken, /^Saved Vale test, version 4\./);
  const list = await call('/api/creations');
  assert.equal(list.body.projects.length, 1); assert.equal(list.body.projects[0].versions, 4);
  const first = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  for (let i = 0; i < 3; i++) await call(`/api/creations/${p.id}/undo`, 'POST', {});
  const none = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(none.status, 409); assert.match(none.body.detail, /Nothing to undo/);
  assert.equal(first.body.ok, true);
});

test('the edit vocabulary maps plain sentences to valid preset changes, and refuses what the renderer would refuse', () => {
  const che = BUILT_IN.find((p) => p.id === 'che');
  const cases = [
    ['make the hair shorter', (p) => p.hair.style === 'wavy_medium'],
    ['make her hair blonde', (p) => p.hair.color === '#d8b46a'],
    ['give her green eyes', (p) => p.eyes.iris === '#4f7a4a'],
    ['fuller lips', (p) => p.face.lip_upper === 0.5 && p.face.lip_lower === 0.7],
    ['a narrower nose', (p) => p.face.nose_width === -0.4],
    ['make her older', (p) => p.body.age === 0.2],
    ['higher cheekbones', (p) => p.face.cheekbones === 0.2],
    ['make the jacket navy', (p) => p.outfit.color === '#1d2b4a'],
    ['darker skin', (p) => p.skin.tone !== che.skin.tone],
  ];
  for (const [text, ok] of cases) {
    const r = parseEdit(text, che, 'photoreal');
    assert.ok(ok(r.params), `${text}: ${JSON.stringify(r.applied)}`);
    assert.deepEqual(validate(r.params), [], text);
  }
  assert.equal(parseEdit('make it photorealistic', che, 'stylized').style, 'photoreal');
  assert.equal(parseEdit('cartoon look please', che, 'photoreal').style, 'stylized');
  assert.equal(parseEdit('make it hybrid', che, 'photoreal').style, 'hybrid');
  assert.deepEqual(parseEdit('rotate left 90 degrees', che, 'photoreal').viewport, { action: 'rotate', deg: -90 });
  assert.deepEqual(parseEdit('zoom in', che, 'photoreal').viewport, { action: 'zoom', factor: 0.8 });
  assert.deepEqual(parseEdit('side view', che, 'photoreal').viewport, { action: 'view', deg: 90 });
  // CHE's hair is already the longest style.
  assert.match(parseEdit('make the hair longer', che, 'photoreal').unsupported[0], /already as long/);
  // A not-built style says so honestly.
  assert.match(parseEdit('make the hair shorter', che, 'photoreal').applied[0], /not built yet, so the model and previews show it close-cropped/);
  // Lighter skin until the renderer's albedo limit: refused, never saved invalid.
  let p = BUILT_IN.find((x) => x.id === 'iris');
  let refused = false;
  for (let i = 0; i < 8 && !refused; i++) {
    const r = parseEdit('lighter skin', p, 'photoreal');
    if (r.unsupported.length) refused = true; else { assert.deepEqual(validate(r.params), []); p = r.params; }
  }
  assert.ok(refused, 'the lightest valid tone is a limit, not a broken preset');
  // Eyes larger caps at 1.
  let q = che;
  for (let i = 0; i < 8; i++) q = parseEdit('bigger eyes', q, 'photoreal').params;
  assert.equal(q.face.eye_size, 1);
});

test('the model routes accept only a held job\'s real GLB up to 16 MB and 404 when there is none', async () => {
  const { call, worker, owner } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  const gen = (await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job;
  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  assert.equal((await owner(`/api/gpu/jobs/${gen.id}/model.glb`)).status, 404);
  for (const j of (await (await owner('/api/gpu')).json()).jobs.filter((x) => x.kind === 'face_preview')) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  const claim = (await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token)).body;
  assert.equal(claim.job.id, gen.id);
  const q = `?worker=colab-1&job=${gen.id}`;
  assert.equal((await worker('model', null, token, q, PNG)).status, 409, 'a PNG is not a model');
  const lying = glb(); new DataView(lying.buffer).setUint32(8, lying.length + 4, true);
  assert.equal(isGlb(lying), false, 'the header length must match the bytes');
  assert.equal((await worker('model', null, token, q, lying)).status, 409);
  assert.equal((await worker('model', null, 'wrong', q, glb())).status, 404, 'only the paired token opens the route');
  assert.equal((await worker('model', null, token, `?worker=colab-2&job=${gen.id}`, glb())).status, 409, 'only the worker holding the job');
  const big = await worker('model', null, token, q, glb(16 * 1024 * 1024));
  assert.equal(big.status, 409); assert.match(big.body.detail, /larger than 16 MB/);
  assert.equal((await worker('model', null, token, q, glb(10))).status, 200);
  assert.equal((await owner(`/api/gpu/jobs/${gen.id}/model.glb`)).status, 200);
  assert.equal((await call('/api/creations/cr_000000000000')).status, 404);
});

test('at the project limit a new creation is refused and no saved creation is removed (review of #520)', async () => {
  const { call } = setup();
  const first = await call('/api/creations', 'POST', { kind: 'person', base: 'che' });
  assert.equal(first.status, 201);
  await call(`/api/creations/${first.body.project.id}/save`, 'POST', {});
  for (let i = 1; i < 100; i++) assert.equal((await call('/api/creations', 'POST', { kind: 'person', base: 'nova' })).status, 201);
  const over = await call('/api/creations', 'POST', { kind: 'person', base: 'nova' });
  assert.equal(over.status, 422);
  assert.equal(over.body.full, true);
  assert.match(over.body.detail, /Nothing was removed/);
  const kept = await call(`/api/creations/${first.body.project.id}`);
  assert.equal(kept.status, 200, 'the first, saved creation is still there');
  assert.equal((await call('/api/creations')).body.projects.length, 100);
});

test('render settings: full body by default; bust, detail, lighting and low-poly edits make versions; movement words only move the viewport; critique is honest', async () => {
  const { call } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  assert.deepEqual([p.render.mode, p.render.quality, p.render.lighting], ['full_body', 'standard', 'studio']);
  assert.match(p.resources, /estimates, not measured yet/);
  const bust = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'head and shoulders only' });
  assert.equal(bust.body.changed, true); assert.equal(bust.body.project.render.mode, 'bust');
  const hi = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'high detail with cinematic lighting' });
  assert.equal(hi.body.project.render.quality, 'high'); assert.equal(hi.body.project.render.lighting, 'cinematic');
  assert.match(hi.body.spoken, /on the free cloud CPU: more than 30 minutes/);
  const lp = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it low-poly' });
  assert.equal(lp.body.project.render.quality, 'draft'); assert.match(lp.body.unsupported[0], /low-poly look is not built/);
  const n = lp.body.project.version;
  for (const [text, vp] of [['show the skeleton', { action: 'skeleton', on: true }], ['hide the skeleton', { action: 'skeleton', on: false }],
    ['animate walking', { action: 'animate', clip: 'walk' }], ['pause', { action: 'pause' }], ['replay', { action: 'replay' }],
    ['skip ahead 10 seconds', { action: 'seek', delta: 10 }], ['go back 10 seconds', { action: 'seek', delta: -10 }], ['slower', { action: 'speed', mul: 0.67 }]]) {
    const r = await call(`/api/creations/${p.id}/edit`, 'POST', { text });
    assert.deepEqual(r.body.viewport, vp, text); assert.equal(r.body.changed, false, text); assert.equal(r.body.project.version, n, text);
  }
  const crit = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'critique this design' });
  assert.equal(crit.body.changed, false); assert.match(crit.body.spoken, /needs a finished render/);
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.deepEqual([gen.body.job.settings.MODEL_MODE, gen.body.job.settings.QUALITY, gen.body.job.settings.LIGHTING], ['bust', 'draft', 'cinematic']);
  assert.equal(gen.body.job.samples, 16); assert.equal(gen.body.job.res, 360);
});

test('planning routes: a pre-job estimate and the scale scenarios, read-only, with assumptions and R2 status', async () => {
  const { call } = setup();
  const est = await call('/api/creations/estimate?minutes=30&profile=hybrid&gpus=20');
  assert.equal(est.status, 200);
  assert.equal(est.body.estimate.segments, 180);
  assert.match(est.body.spoken, /On free capacity it costs nothing; paid capacity would be about \$\d/);
  const cap = await call('/api/creations/capacity');
  assert.equal(cap.status, 200);
  assert.ok(cap.body.scenarios.users_1m && cap.body.scenarios.videos_1m_30min.hybrid);
  assert.ok(cap.body.assumptions.gpu_h100_hour.source);
  assert.equal(cap.body.storage.ok, false); assert.match(cap.body.storage.reason, /not enabled/);
  assert.equal((await call('/api/creations/capacity', 'POST', {})).status, 405);
});

// ── Create Object and Create Room (creation_objects.js) ─────────────────────────────────────────────────────────────

test('Create Object: a chair from the fixed families, edited by words into versions, queued as object_model on the same queue (any worker, CPU included)', async () => {
  const { call } = setup();
  const made = await call('/api/creations', 'POST', { kind: 'object', base: 'chair' });
  assert.equal(made.status, 201);
  const p = made.body.project;
  assert.equal(p.kind, 'object'); assert.equal(p.title, 'Chair (new object)'); assert.equal(p.base_id, 'chair');
  assert.deepEqual(p.params, { family: 'chair', size: 1, color: '#8a5a36', roughness: 0.5, metallic: 0, style: 'modern' });
  assert.match(made.body.spoken, /^Chair \(new object\) started: a modern chair/);
  assert.match(p.resources, /an estimate, not measured on that runner/);
  const say = async (text) => (await call(`/api/creations/${p.id}/edit`, 'POST', { text })).body;
  let r = await say('CHE, make it red.');
  assert.equal(r.changed, true); assert.deepEqual(r.applied, ['Colour changed to red.']); assert.equal(r.project.params.color, '#b0302a');
  assert.match(r.spoken, /Saved as version 2\. Say generate to build it\./);
  r = await say('bigger'); assert.equal(r.project.params.size, 1.2); assert.match(r.applied[0], /Size up to 1\.2 times the real chair size/);
  r = await say('make it shinier and metallic'); assert.equal(r.project.params.roughness, 0.25); assert.equal(r.project.params.metallic, 1);
  r = await say('classic style'); assert.equal(r.project.params.style, 'classic'); assert.equal(r.project.style, 'classic');
  r = await say('turn it into a desk'); assert.equal(r.project.params.family, 'table'); assert.equal(r.project.params.form, 'desk');
  assert.equal(r.viewport, null, '"turn it into" is an edit, not a rotation');
  assert.equal(r.project.params.color, '#b0302a', 'colour, finish, style and size are kept');
  const n = r.project.version;
  r = await say('make it a dragon');
  assert.equal(r.changed, false); assert.match(r.unsupported[0], /only these object families: lamp, chair, table, mug, vase, shelf\. A dragon is not one of them, and free-form text-to-3D is not built/);
  r = await say('rotate the model left');
  assert.equal(r.changed, false); assert.deepEqual(r.viewport, { action: 'rotate', deg: -45 }); assert.equal(r.project.version, n);
  r = await say('size 3'); assert.equal(r.changed, true); assert.equal(r.project.params.size, 2, 'clamped to the largest size built');
  r = await say('make it smell nice'); assert.equal(r.changed, false); assert.match(r.unsupported[0], /can't change that on a table yet/);
  const undo = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(undo.body.project.params.size, 1.2);

  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 202);
  const j = gen.body.job;
  assert.equal(j.kind, 'object_model'); assert.deepEqual(j.requires, { gpu: 'none' }); assert.equal(j.priority, 'high');
  assert.deepEqual(JSON.parse(j.settings.SPEC), undo.body.project.params, 'the job carries the exact spec, nothing else');
  assert.deepEqual(Object.keys(j.settings), ['SPEC']);
  assert.deepEqual([j.samples, j.res], [32, 480]); assert.deepEqual(j.views, [0, 45, 90]);
  assert.match(j.title, /^Chair \(new object\) v\d+: 3D model and previews$/);
  assert.equal((await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.duplicate, true);
  const hi = await say('high detail');
  assert.equal(hi.project.render.quality, 'high'); assert.match(hi.spoken, /High Detail: 64 samples, 720 pixels/);
  const g2 = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.deepEqual([g2.body.job.samples, g2.body.job.res], [64, 720]);
  const got = await call(`/api/creations/${p.id}`);
  assert.match(got.body.spoken, /^Chair \(new object\), version \d+ of \d+: a classic desk, red, metallic with roughness 0\.25, at 1\.2 times real size\./);
});

test('Create Room: an office edited by words (furniture, size, walls, floor, light), refusals with reasons, queued as room_model', async () => {
  const { call } = setup();
  const made = await call('/api/creations', 'POST', { kind: 'room', base: 'office' });
  assert.equal(made.status, 201);
  const p = made.body.project;
  assert.equal(p.kind, 'room'); assert.equal(p.title, 'Office (new room)');
  assert.deepEqual(p.params.furniture, ['desk', 'chair', 'lamp', 'shelf', 'plant', 'mug']);
  const say = async (text) => (await call(`/api/creations/${p.id}/edit`, 'POST', { text })).body;
  let r = await say('add a rug and a sofa');
  assert.deepEqual(r.project.params.furniture.slice(-2), ['rug', 'sofa']); assert.equal(r.applied.length, 2);
  r = await say('add a desk'); assert.equal(r.changed, false); assert.match(r.unsupported[0], /already has a desk/);
  r = await say('remove the sofa'); assert.ok(!r.project.params.furniture.includes('sofa')); assert.match(r.applied[0], /undo brings it back/);
  r = await say('warmer light'); assert.equal(r.project.params.lighting, 'neutral', 'one step warmer from cool');
  r = await say('warm lighting'); assert.equal(r.project.params.lighting, 'warm');
  r = await say('5 metres wide'); assert.equal(r.project.params.width, 5);
  r = await say('higher ceiling'); assert.equal(r.project.params.height, 3);
  r = await say('paint the walls green'); assert.equal(r.project.params.wall_color, '#3c7a4a');
  r = await say('tile floor'); assert.equal(r.project.params.floor, 'tile');
  r = await say('make it bigger'); assert.deepEqual([r.project.params.width, r.project.params.depth], [6, 4.2]);
  r = await say('20 metres wide'); assert.equal(r.project.params.width, 8); assert.match(r.applied[0], /8 metres, the most CHE builds/);
  const n = r.project.version;
  r = await say('a red sofa'); assert.equal(r.changed, false); assert.match(r.unsupported[0], /Only the wall colour is a room setting/);
  r = await say('add a piano'); assert.equal(r.changed, false); assert.match(r.unsupported[0], /A piano is not built yet/);
  r = await say('make it a kitchen'); assert.equal(r.changed, false); assert.match(r.unsupported[0], /only these rooms: living room, bedroom, office, studio/);
  r = await say('zoom in'); assert.deepEqual(r.viewport, { action: 'zoom', factor: 0.8 }); assert.equal(r.project.version, n);
  r = await say('make it a bedroom');
  assert.equal(r.project.params.type, 'bedroom'); assert.deepEqual(r.project.params.furniture, ['bed', 'lamp', 'shelf', 'rug', 'plant']);
  assert.equal(r.project.params.width, 8, 'size, walls, floor and light stay');
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.body.job.kind, 'room_model'); assert.deepEqual(gen.body.job.requires, { gpu: 'none' });
  const spec = JSON.parse(gen.body.job.settings.SPEC);
  assert.deepEqual(spec, r.project.params); assert.ok(gen.body.job.settings.SPEC.length <= 400, 'within the queue setting limit');
});

test('an object job completes only with its model uploaded and measured by the runner (verify_glb.py --static) for that very file', async () => {
  const { call, worker, owner } = setup();
  const p = (await call('/api/creations', 'POST', { kind: 'object', base: 'vase' })).body.project;
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  for (const j of (await (await owner('/api/gpu')).json()).jobs.filter((x) => x.kind === 'face_preview')) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  const id = gen.body.job.id;
  const claim = await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  assert.equal(claim.body.job.id, id); assert.equal(claim.body.job.kind, 'object_model');
  const model = glb(40);
  await worker('model', null, token, `?worker=colab-1&job=${id}`, model);
  for (const v of [0, 45, 90]) await worker('preview', null, token, `?worker=colab-1&job=${id}&view=${v}`, PNG);
  const sha = (await call(`/api/creations/${p.id}`)).body.project.job.model.sha256;
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: DEV, render_seconds: 3, sha256: 'a'.repeat(64) }]));
  const base = { status: 'ok', file: 'model.glb', sha256: sha, bytes: model.length, vertices: 100, mode: 'object' };
  const verify = { ok: true, failures: [], meshes: 1, primitives: 1, vertices: 640, triangles: 1408, materials: ['Vase glaze (classic)'],
    bbox_m: { min: [-0.09, 0, -0.09], max: [0.09, 0.32, 0.09], size: [0.18, 0.32, 0.18] }, expected_bbox_m: [0.17, 0.32, 0.17], tolerance: 0.25, sha256: sha, bytes: model.length };
  const unmeasured = await worker('complete', { worker_id: 'colab-1', job_id: id, status: 'complete', receipt: { status: 'complete', views, model: base } }, token);
  assert.equal(unmeasured.body.job.state, 'queued'); assert.match(unmeasured.body.job.history.at(-1).note, /not re-read and measured/);
  await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  const other = await worker('complete', { worker_id: 'colab-1', job_id: id, status: 'complete',
    receipt: { status: 'complete', views, model: { ...base, verify: { ...verify, sha256: 'f'.repeat(64) } } } }, token);
  assert.equal(other.body.job.state, 'queued', 'a measurement of another file does not count');
  await worker('claim', { worker_id: 'colab-1', gpu: GPU }, token);
  const done = await worker('complete', { worker_id: 'colab-1', job_id: id, status: 'complete', receipt: { status: 'complete', views, model: { ...base, verify } } }, token);
  assert.equal(done.body.job.state, 'completed', JSON.stringify(done.body.job.history.at(-1)));
  assert.equal(done.body.job.measured.ok, true);
  assert.equal(done.body.job.measured.line, '1 mesh, 1,408 triangles, 1 material, 0.18 x 0.32 x 0.18 m');
  const fin = await call(`/api/creations/${p.id}`);
  assert.ok(fin.body.project.stages.some((s) => s.label === 'Model verified: 1 mesh, 1,408 triangles, 1 material, 0.18 x 0.32 x 0.18 m'));
  assert.match(fin.body.spoken, /The 3D model and previews for this version are ready\. Measured: 1 mesh, 1,408 triangles/);
});
