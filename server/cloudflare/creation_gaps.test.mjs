// Creation Engine gaps (creation-gaps lane, 2026-10-25): the worker named in every notice (never "?"), Create Object
// from a description (creation_freeform.js on the existing queue), CC0 texture and suit receipts carried into the job's
// notes, and Stop: cancelling a running build tells its worker, and the worker's next heartbeat is recorded as the
// confirmation. GitHub traffic goes to a fake fetcher; nothing here touches the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { creationRoute } from './creation_studio.js';
import { GpuQueue, gpuWorkerRoute, publicJob, texturesLine, trimTextures, workerName } from './gpu_queue.js';
import { composeFreeform, customErrors, RECIPE_NAMES } from './creation_freeform.js';
import { parseObjectEdit, specErrors } from './creation_objects.js';
import { resetOidcCache } from './gpu_oidc.js';
import { oidcSigner } from './oidc_test_signer.mjs';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CPU = (run = '777') => ({ worker_id: `gha-${run}-1`, gpu: 'CPU (4 cores)', blender: 'Blender 5.0.1', class: 'github_cpu', device: 'cpu', cores: 4, ram_gb: 16 });
function glb() {
  const text = JSON.stringify({ asset: { version: '2.0' } }); const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const b = new Uint8Array(20 + padded.length); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, b.length, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}

async function setup() {
  resetOidcCache();
  let t = Date.parse('2026-10-25T01:00:00Z');
  const storage = memStorage(); const now = () => t; const signer = await oidcSigner();
  const fetcher = async (url) => {
    const u = String(url);
    if (u.startsWith('https://token.actions.githubusercontent.com/')) return new Response(JSON.stringify({ keys: [signer.jwk] }));
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return new Response(JSON.stringify({ private: false }));
    if (u.endsWith('/dispatches')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  const ctx = { storage, env: { CHE_GITHUB_TOKEN: 'ghp_fixture', CHE_GITHUB_REPO: 'Vondada/chey-app' }, now, fetcher };
  const call = async (path, method = 'GET', body) => {
    const res = await creationRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
    return { status: res.status, body: await res.json() };
  };
  const worker = async (route, body, { run = '777', query = '', bytes = null } = {}) => {
    const res = await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
      method: bytes ? 'PUT' : 'POST', headers: { Authorization: `Bearer ${await signer.sign({ run_id: run }, Math.floor(t / 1000))}` }, body: bytes || JSON.stringify(body) }));
    return { status: res.status, body: res.headers.get('Content-Type') === 'application/json' ? await res.json() : null };
  };
  return { storage, ctx, call, worker, advance: (ms) => { t += ms; } };
}

test('worker names: a lease, a finished job and an unknown worker are each said in words, never "?"', () => {
  assert.equal(workerName({}), 'unknown worker');
  assert.equal(workerName({ state: 'completed', rendered_on: null }), 'unknown worker');
  assert.equal(workerName({ lease: { worker_id: 'gha-40143945084-1', class: 'github_cpu' } }), 'free GitHub cloud CPU runner gha-40143945084-1 (GitHub Actions run 40143945084)');
  assert.equal(workerName({ rendered_on: { class: 'colab', device: 'Tesla T4, 550.54, 15360 MiB', worker_id: 'colab-ab12cd34ef' } }), 'Colab GPU worker colab-ab12cd34ef (Tesla T4)');
  assert.equal(workerName({ rendered_on: { class: 'github_cpu', device: 'CPU', worker_id: null } }), 'free GitHub cloud CPU runner (id not recorded)');
  const view = publicJob({ id: 'gpu_000000000000', state: 'completed', views: [0], history: [], rendered_on: { class: 'github_cpu', device: 'CPU', worker_id: 'gha-9-2' } });
  assert.equal(view.worker_id, 'gha-9-2'); assert.equal(view.worker_class, 'github_cpu');
  assert.match(view.status_line, /on the free GitHub cloud CPU runner gha-9-2 \(GitHub Actions run 9\)/);
  assert.doesNotMatch(JSON.stringify(view), /"\?"/);
});

test('free-form objects: recipes and shape phrases compose real parts; anything else is refused plainly', () => {
  const snow = composeFreeform('a snowman');
  assert.equal(snow.ok, true); assert.equal(snow.spec.family, 'custom'); assert.equal(snow.spec.parts.length, 8);
  assert.deepEqual(customErrors(snow.spec), []); assert.deepEqual(specErrors('object', snow.spec), []);
  assert.ok(Math.min(...snow.spec.parts.map((p) => p.c[1] - p.s[1] / 2)) >= -1e-9, 'it stands on y = 0');
  const stack = composeFreeform('a red ball on top of a blue box');
  assert.deepEqual(stack.spec.parts.map((p) => [p.shape, p.color]), [['box', '#3a6ec8'], ['sphere', '#b0302a']], 'the box is at the bottom');
  assert.ok(stack.spec.parts[1].c[1] > stack.spec.parts[0].c[1]);
  const tall = composeFreeform('a rocket 2 metres tall');
  assert.equal(Math.round(Math.max(...tall.spec.parts.map((p) => p.c[1] + p.s[1] / 2)) * 100) / 100, 2);
  assert.match(composeFreeform('a wooden crate').made, /CC0 wood texture fetched when it builds/);
  const no = composeFreeform('a dragon with wings');
  assert.equal(no.ok, false); assert.match(no.detail, /can't build a dragon wings yet/); assert.match(no.detail, /not free-form text-to-3D, so nothing was made/);
  for (const r of RECIPE_NAMES) assert.equal(composeFreeform(`a ${r}`).ok, true, r);
  assert.equal(composeFreeform('').ok, false);
  // Bad parts are refused with reasons, the same limits as creation_params.py.
  assert.match(customErrors({ ...snow.spec, parts: [{ ...snow.spec.parts[0], shape: 'blob' }] }).join(), /shape must be one of/);
  assert.match(customErrors({ ...snow.spec, parts: [{ ...snow.spec.parts[0], texture: 'gold' }] }).join(), /texture must be one of/);
});

test('Create Object from a description: a project on the same studio and queue, edits, a family word, and a plain refusal', async () => {
  const s = await setup();
  const made = await s.call('/api/creations', 'POST', { kind: 'object', description: 'a snowman' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const p = made.body.project;
  assert.equal(p.params.family, 'custom'); assert.equal(p.title, 'Snowman (new object)');
  assert.match(made.body.spoken, /a snowman composed of 8 parts \(sphere, cone, cylinder\), 0\.5 x 1\.23 x 0\.5 m/);
  assert.match(made.body.spoken, /say generate to build it/);
  const gen = await s.call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 202); assert.equal(gen.body.job.kind, 'object_model');
  const spec = JSON.parse(gen.body.job.settings.SPEC);
  assert.equal(spec.parts.length, 8, 'the whole composed spec rides on the existing queue');
  const red = await s.call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it red and bigger' });
  assert.equal(red.body.changed, true); assert.equal(red.body.project.params.color, '#b0302a'); assert.ok(red.body.project.params.size > 1);
  const style = await s.call(`/api/creations/${p.id}/edit`, 'POST', { text: 'industrial style' });
  assert.equal(style.body.changed, false); assert.match(style.body.spoken, /has no industrial style/);
  const rocket = await s.call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it a rocket' });
  assert.equal(rocket.body.changed, true); assert.match(rocket.body.spoken, /Changed to a rocket composed of 7 parts/);
  const dragon = await s.call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it a dragon' });
  assert.equal(dragon.body.changed, false); assert.match(dragon.body.spoken, /can't build a dragon/);
  // A family word starts that family, with the description's colour applied.
  const chair = await s.call('/api/creations', 'POST', { kind: 'object', description: 'a red chair' });
  assert.equal(chair.body.project.params.family, 'chair'); assert.equal(chair.body.project.params.color, '#b0302a');
  const refused = await s.call('/api/creations', 'POST', { kind: 'object', description: 'a dragon' });
  assert.equal(refused.status, 422); assert.match(refused.body.detail, /I can't build a dragon yet/);
  // The edit parser alone: "make it a pyramid" on a lamp composes it.
  const lamp = parseObjectEdit('make it a pyramid', { family: 'lamp', size: 1, color: '#1f6f78', roughness: 0.35, metallic: 0, style: 'modern', form: 'desk' });
  assert.equal(lamp.spec.family, 'custom'); assert.equal(lamp.spec.parts[0].sides, 4);
});

test('textures and suit receipts become the job\'s own notes; a missing texture is said with its reason', () => {
  const t = trimTextures({ wood: { status: 'ok', source: 'Poly Haven', license: 'CC0 1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    asset_id: 'oak_floor_1', asset_page: 'https://polyhaven.com/a/oak_floor_1', cached: true, maps: { diffuse: { sha256: 'a'.repeat(64), bytes: 1234, url: 'https://dl.polyhaven.org/x.jpg', path: '/tmp/x' } } },
  brick: { status: 'unavailable', reason: 'URLError: network is unreachable' }, 'BAD KEY': { status: 'ok' } });
  assert.deepEqual(Object.keys(t), ['wood', 'brick']);
  assert.equal(t.wood.maps.diffuse.path, undefined, 'no local path leaves the runner');
  assert.equal(texturesLine(t), 'Textures: wood from Poly Haven oak_floor_1 (CC0 1.0). No brick texture: URLError: network is unreachable; plain colour used.');
  assert.equal(texturesLine({}), '');
});

test('a room built with a CC0 floor texture: the completion notes name the source, license and worker', async () => {
  const s = await setup();
  const real = JSON.parse(readFileSync(new URL('./fixtures/room_model_receipt.json', import.meta.url), 'utf8'));
  const p = (await s.call('/api/creations', 'POST', { kind: 'room', base: real.spec.type })).body.project;
  const id = (await s.call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.id;
  assert.equal((await s.worker('claim', CPU())).body.job.id, id);
  const wid = CPU().worker_id;
  assert.equal((await s.worker('model', null, { query: `?worker=${wid}&job=${id}`, bytes: glb() })).status, 200);
  for (const v of [0, 45, 90]) await s.worker('preview', null, { query: `?worker=${wid}&job=${id}&view=${v}`, bytes: PNG });
  const sha = (await s.call(`/api/creations/${p.id}`)).body.project.job.model.sha256;
  const textures = { wood: { status: 'ok', source: 'Poly Haven', license: 'CC0 1.0', asset_id: 'oak_floor_1', maps: { diffuse: { sha256: 'c'.repeat(64), bytes: 900 } } } };
  const receipt = { ...real, textures, model: { ...real.model, sha256: sha, verify: { ...real.model.verify, sha256: sha } } };
  const done = await s.worker('complete', { worker_id: wid, job_id: id, status: 'complete', receipt });
  assert.equal(done.body.job.state, 'completed', JSON.stringify(done.body.job.history.at(-1)));
  assert.equal(done.body.job.receipt.textures.wood.asset_id, 'oak_floor_1');
  assert.ok(done.body.job.history.some((h) => h.note === 'Textures: wood from Poly Haven oak_floor_1 (CC0 1.0).'), JSON.stringify(done.body.job.history.map((h) => h.note)));
  assert.match(done.body.job.history.at(-1).note, /worker: free GitHub cloud CPU runner gha-777-1 \(GitHub Actions run 777\)/);
  assert.equal(done.body.job.worker_name, 'free GitHub cloud CPU runner gha-777-1 (GitHub Actions run 777)');
});

test('Stop: cancelling a running build names its worker, the worker is told at its heartbeat, and that is recorded once', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { kind: 'object', description: 'a trophy' })).body.project;
  const id = (await s.call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.id;
  assert.equal((await s.worker('claim', CPU())).body.job.id, id);
  const q = new GpuQueue(s.storage, s.ctx.now);
  const out = await q.control('cancel', id);
  assert.equal(out.ok, true); assert.equal(out.job.state, 'cancelled');
  assert.equal(out.job.history.at(-1).note, 'Cancelled by the owner while the free GitHub cloud CPU runner gha-777-1 (GitHub Actions run 777) was building it; that worker is told to stop at its next heartbeat.');
  s.advance(30_000);
  const hb = await s.worker('heartbeat', { worker_id: CPU().worker_id, job_id: id });
  assert.equal(hb.body.stop, true); assert.equal(hb.body.reason, 'cancelled by the owner');
  const after = (await q.jobs()).find((j) => j.id === id);
  assert.equal(after.stop_confirmed_at, '2026-10-25T01:00:30.000Z');
  assert.match(after.history.at(-1).note, /^Worker gha-777-1 received the stop/);
  await s.worker('heartbeat', { worker_id: CPU().worker_id, job_id: id });
  assert.equal((await q.jobs()).find((j) => j.id === id).history.filter((h) => /received the stop/.test(h.note)).length, 1, 'recorded once');
  assert.equal((await q.control('cancel', id)).detail, 'That job is already cancelled.');
  // A job no worker held is cancelled plainly.
  const p2 = (await s.call('/api/creations', 'POST', { kind: 'object', description: 'a planet' })).body.project;
  const id2 = (await s.call(`/api/creations/${p2.id}/generate`, 'POST', {})).body.job.id;
  assert.equal((await q.control('cancel', id2)).job.history.at(-1).note, 'Cancelled by the owner.');
});

test('the suit measurement in a person receipt is kept and noted with its numbers', async () => {
  const s = await setup();
  const p = (await s.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const id = (await s.call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.id;
  assert.equal((await s.worker('claim', CPU())).body.job.id, id);
  const wid = CPU().worker_id;
  const model = glb();
  assert.equal((await s.worker('model', null, { query: `?worker=${wid}&job=${id}`, bytes: model })).status, 200);
  for (const v of [0, 45, 90]) await s.worker('preview', null, { query: `?worker=${wid}&job=${id}&view=${v}`, bytes: PNG });
  const sha = (await s.call(`/api/creations/${p.id}`)).body.project.job.model.sha256;
  const rig = JSON.parse(readFileSync(new URL('./fixtures/full_body_rig_receipt.json', import.meta.url), 'utf8'));
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: "DEVICE CPU ['AMD EPYC 7763'] 384x480", render_seconds: 30, sha256: 'b'.repeat(64) }]));
  const suit = { garment_vertices_before: 3682, garment_vertices_after: 14599, garment_faces_before: 3616, garment_faces_after: 14464, method: 'each garment face split in four, then 4 Taubin passes (0.5 / -0.53) on inner vertices' };
  const done = await s.worker('complete', { worker_id: wid, job_id: id, status: 'complete',
    receipt: { status: 'complete', device: 'CPU', cores: 4, blender_version: 'Blender 5.0.1', views, model: { status: 'ok', sha256: sha, bytes: model.length, mode: 'full_body', rig, suit } } });
  assert.equal(done.body.job.state, 'completed', JSON.stringify(done.body.job.history.at(-1)));
  assert.equal(done.body.job.receipt.model.suit.garment_vertices_after, 14599);
  assert.ok(done.body.job.history.some((h) => h.note.startsWith('Suit smoothed: 3682 to 14599 garment vertices')), JSON.stringify(done.body.job.history.map((h) => h.note)));
});
