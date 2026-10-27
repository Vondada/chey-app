// Reference photos for Create Person (character realism, Workstream B; docs/CHE_CHARACTER_REALISM_CHECKLIST.md):
// upload limits and type checks from the bytes, consent (this is me / fictional) with refusals that say why, storage by
// SHA-256 on the project version (undo and redo keep it), REFERENCE in the queued person job's settings, a worker fetch
// that only the worker holding that job can make, and the receipt's reference_fit and device_summary surfaced in the
// job status the app polls. All images here are synthetic bytes; no real person's photo is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { MAX_REFERENCE_BYTES, REFERENCE_RULE, creationRoute, engineDeviceLine, imageTypeOf } from './creation_studio.js';
import { GpuQueue, deviceLine, gpuOwnerRoute, gpuWorkerRoute, referenceKey, referenceLine } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return {
    m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9, 9, 0xff, 0xd9]);
const HEIC = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1heic')]);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function glb() {
  const text = JSON.stringify({ asset: { version: '2.0' } }); const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const total = 20 + padded.length; const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}

function setup() {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const storage = memStorage(); const now = () => t;
  const ctx = { storage, env: {}, now };
  const call = async (path, method = 'GET', body) => {
    const req = new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) });
    const res = await creationRoute(ctx, path.split('?')[0], req, body || {});
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, type, body: type.startsWith('application/json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  const worker = async (route, { token, oidc, query = '', body, method } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-CHE-GPU-Token': token } : {}), ...(oidc ? { Authorization: `Bearer ${oidc}` } : {}) };
    const m = method || (body ? 'POST' : 'GET');
    const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, req);
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, body: type.startsWith('application/json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  const owner = async (path, method = 'GET', body) => gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
  const person = async () => (await call('/api/creations', 'POST', { base: 'che', title: 'Ref test' })).body.project;
  const clearSeeds = async () => {
    const view = await (await owner('/api/gpu')).json();
    for (const j of view.jobs.filter((x) => x.kind === 'face_preview')) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  };
  return { storage, ctx, call, worker, owner, person, clearSeeds, advance: (ms) => { t += ms; } };
}

test('the photo type comes from its bytes: JPEG, PNG, HEIC; anything else is unknown', () => {
  assert.equal(imageTypeOf(JPEG), 'image/jpeg');
  assert.equal(imageTypeOf(PNG), 'image/png');
  assert.equal(imageTypeOf(HEIC), 'image/heic');
  assert.equal(imageTypeOf(new TextEncoder().encode('GIF89a......')), null);
});

test('upload limits: 8 MB, JPEG or PNG only, HEIC refused with the reason, an empty photo refused', async () => {
  const { call, person, storage } = setup();
  const p = await person();
  const big = new Uint8Array(MAX_REFERENCE_BYTES + 1); big.set(JPEG.subarray(0, 3));
  const tooBig = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(big), consent: 'self' });
  assert.equal(tooBig.status, 413); assert.match(tooBig.body.detail, /larger than 8 MB/);
  const heic = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(HEIC), consent: 'self' });
  assert.equal(heic.status, 415); assert.match(heic.body.detail, /HEIC, which CHE's server cannot read\. The CHE app converts photos to JPEG/);
  const gif = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(new TextEncoder().encode('GIF89a......')), consent: 'self' });
  assert.equal(gif.status, 415); assert.match(gif.body.detail, /only JPEG or PNG/);
  const empty = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: '', consent: 'self' });
  assert.equal(empty.status, 400);
  assert.ok(![...storage.m.keys()].some((k) => String(k).includes('creations/references/')), 'nothing refused was stored');
  // Exactly at the limit is accepted.
  const max = new Uint8Array(MAX_REFERENCE_BYTES); max.set(JPEG.subarray(0, 3));
  const ok = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(max), consent: 'fictional' });
  assert.equal(ok.status, 201); assert.equal(ok.body.project.reference.bytes, MAX_REFERENCE_BYTES);
});

test('consent must be "self" or "fictional"; anything else is refused with the reason and nothing is stored', async () => {
  const { call, person, storage } = setup();
  const p = await person();
  for (const consent of ['', 'other', 'someone_else', 'child', 'friend', undefined]) {
    const r = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(JPEG), consent });
    assert.equal(r.status, 422, String(consent)); assert.equal(r.body.refused, true);
    assert.ok(r.body.detail.includes(REFERENCE_RULE));
    assert.match(r.body.detail, /never from photos of other real private people or of children/);
  }
  assert.equal((await call(`/api/creations/${p.id}`)).body.project.versions_count, 1, 'no version was made');
  assert.ok(![...storage.m.keys()].some((k) => String(k).includes('creations/references/')));
  const obj = (await call('/api/creations', 'POST', { kind: 'object', base: 'lamp' })).body.project;
  const onObject = await call(`/api/creations/${obj.id}/reference`, 'POST', { image_base64: b64(JPEG), consent: 'self' });
  assert.equal(onObject.status, 422); assert.match(onObject.body.detail, /Create Person characters only/);
});

test('stored by SHA-256 on the version; undo and redo keep it; an edit carries it; remove is a version undo restores; purge erases it', async () => {
  const { call, person, storage } = setup();
  const p = await person();
  const add = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(PNG), consent: 'self' });
  assert.equal(add.status, 201);
  const ref = add.body.project.reference;
  const sha = (await import('node:crypto')).createHash('sha256').update(PNG).digest('hex');
  assert.equal(ref.sha256, sha); assert.equal(ref.content_type, 'image/png'); assert.equal(ref.consent, 'self'); assert.equal(ref.consent_label, 'this is me');
  assert.equal(ref.url, `/api/creations/${p.id}/reference`);
  assert.match(add.body.spoken, /^Reference photo added: 1 KB PNG, this is me\. Saved as version 2\. .*approximate, not an exact copy/);
  assert.ok(storage.m.has(`blob:meta:${referenceKey(sha)}`) || [...storage.m.keys()].some((k) => String(k).includes(referenceKey(sha))), 'stored by its hash');
  const served = await call(`/api/creations/${p.id}/reference`);
  assert.equal(served.status, 200); assert.equal(served.type, 'image/png'); assert.deepEqual(served.body, PNG);
  const same = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(PNG), consent: 'self' });
  assert.equal(same.body.changed, false, 'the same photo is not a second version');

  const edit = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'bigger eyes' });
  assert.equal(edit.body.project.version, 3); assert.equal(edit.body.project.reference.sha256, sha, 'an edit keeps the photo');
  const undo = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(undo.body.project.reference.sha256, sha);
  const undo2 = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(undo2.body.project.reference, null, 'version 1 had no photo');
  assert.equal((await call(`/api/creations/${p.id}/reference`)).status, 404);
  const redo = await call(`/api/creations/${p.id}/redo`, 'POST', {});
  assert.equal(redo.body.project.reference.sha256, sha, 'redo brings it back');
  await call(`/api/creations/${p.id}/redo`, 'POST', {});

  const removed = await call(`/api/creations/${p.id}/reference`, 'DELETE');
  assert.equal(removed.status, 200); assert.equal(removed.body.project.reference, null);
  assert.match(removed.body.spoken, /^Removed the reference photo from this character, as you asked\. Saved as version 4; say undo to bring it back\./);
  assert.equal((await call(`/api/creations/${p.id}/reference`, 'DELETE')).status, 409, 'nothing left to remove');
  const back = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(back.body.project.reference.sha256, sha, 'undo restores a removed photo');

  const purge = await call(`/api/creations/${p.id}/reference?purge=1`, 'DELETE');
  assert.equal(purge.status, 200); assert.equal(purge.body.erased, 1);
  assert.match(purge.body.spoken, /^Deleted the reference photo from every version of this character and from CHE's storage, as you asked\. Undo cannot bring it back\./);
  assert.ok(![...storage.m.keys()].some((k) => String(k).includes(referenceKey(sha))), 'the bytes are gone');
  const d = (await call(`/api/creations/${p.id}`)).body.project;
  assert.ok(d.versions.every((v) => !v.reference)); assert.equal(d.reference, null);
});

test('Generate puts REFERENCE in the person job; only the worker holding that job fetches the photo, with its worker token', async () => {
  const { call, worker, owner, person, clearSeeds, advance } = setup();
  const p = await person();
  await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(JPEG), consent: 'fictional' });
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 202);
  const sha = (await import('node:crypto')).createHash('sha256').update(JPEG).digest('hex');
  const ref = JSON.parse(gen.body.job.settings.REFERENCE);
  assert.deepEqual(ref, { url: `/api/gpu/worker/reference?sha256=${sha}`, sha256: sha, bytes: JPEG.length, consent: 'fictional' });
  // A second Generate of the same version is the same job (stable settings).
  assert.equal((await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.duplicate, true);

  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  await clearSeeds(); advance(1000);
  // Before any worker holds it, no one can fetch it.
  assert.equal((await worker('reference', { token, query: `?worker=colab-1&job=${gen.body.job.id}` })).status, 404);
  const claim = await worker('claim', { token, body: { worker_id: 'colab-1', gpu: GPU } });
  assert.equal(claim.body.job.id, gen.body.job.id);
  const url = `/api/gpu/worker/reference?worker=colab-1&job=${gen.body.job.id}`;
  assert.equal(claim.body.job.reference_url, url);
  assert.equal(JSON.parse(claim.body.job.settings.REFERENCE).url, url, 'the claimed job names this worker and job');
  assert.equal(JSON.parse(claim.body.job.settings.REFERENCE).sha256, sha);

  const got = await worker('reference', { token, query: url.slice('/api/gpu/worker/reference'.length) });
  assert.equal(got.status, 200); assert.deepEqual(got.body, JPEG);
  // Another worker id (not holding the job), no token, a wrong token, an owner device bearer, a gha- id on the Colab token: refused.
  assert.equal((await worker('reference', { token, query: `?worker=colab-2&job=${gen.body.job.id}` })).status, 404);
  assert.equal((await worker('reference', { query: `?worker=colab-1&job=${gen.body.job.id}` })).status, 404);
  assert.equal((await worker('reference', { token: 'x'.repeat(64), query: `?worker=colab-1&job=${gen.body.job.id}` })).status, 404);
  assert.equal((await worker('reference', { oidc: 'owner-device-token', query: `?worker=colab-1&job=${gen.body.job.id}` })).status, 404);
  assert.equal((await worker('reference', { token, query: `?worker=gha-1-1&job=${gen.body.job.id}` })).status, 403);
  assert.equal((await worker('reference', { token, method: 'PUT', query: `?worker=colab-1&job=${gen.body.job.id}` })).status, 405);

  // A job without a photo: its worker gets nothing for it, and a worker cannot read another job's photo.
  const p2 = await person();
  const gen2 = await call(`/api/creations/${p2.id}/generate`, 'POST', {});
  assert.equal(gen2.body.job.settings.REFERENCE, undefined);
  assert.equal((await worker('reference', { token, query: `?worker=colab-1&job=${gen2.body.job.id}` })).status, 404);
});

test('a version whose photo was deleted from storage is not built as if it had one', async () => {
  const { call, person, storage } = setup();
  const p = await person();
  const add = await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(JPEG), consent: 'self' });
  for (const k of [...storage.m.keys()]) if (String(k).includes(referenceKey(add.body.project.reference.sha256))) storage.m.delete(k);
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  assert.equal(gen.status, 409); assert.match(gen.body.detail, /no longer stored/);
});

test('receipts: reference_fit and device_summary reach the job status; a CPU worker is never called a GPU', async () => {
  const { call, storage, ctx, person, clearSeeds, advance, owner } = setup();
  const p = await person();
  await call(`/api/creations/${p.id}/reference`, 'POST', { image_base64: b64(JPEG), consent: 'self' });
  const sha = (await import('node:crypto')).createHash('sha256').update(JPEG).digest('hex');
  await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make it bust' });
  const gen = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  await clearSeeds(); advance(1000);
  // Before the build, the project says which compute is there now (no GPU connected).
  const before = (await call(`/api/creations/${p.id}`)).body.project;
  assert.match(before.device_line, /^No (?:GPU|worker) is connected/);
  assert.doesNotMatch(before.device_line, /GPU is connected:/);
  const q = new GpuQueue(storage, ctx.now);
  const auth = { class: 'github_cpu', run_id: '77' };
  const c = await q.claim('gha-77-1', { cores: 4 }, auth);
  assert.equal(c.job.id, gen.body.job.id);
  assert.equal(c.job.reference_url, `/api/gpu/worker/reference?worker=gha-77-1&job=${gen.body.job.id}`);
  assert.equal((await q.workerReference({}, 'gha-77-1', gen.body.job.id)).bytes.length, JPEG.length);
  assert.equal(await q.workerReference({}, 'gha-77-2', gen.body.job.id), null);
  const model = glb();
  assert.equal((await q.model({}, 'gha-77-1', gen.body.job.id, model)).ok, true);
  for (const v of [0, 45, 90]) assert.equal((await q.preview({}, 'gha-77-1', gen.body.job.id, v, PNG)).ok, true);
  const msha = (await import('node:crypto')).createHash('sha256').update(model).digest('hex');
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: 'DEVICE CPU 4 threads', render_seconds: 30 }]));
  const done = await q.complete('gha-77-1', { job_id: gen.body.job.id, status: 'complete', receipt: {
    status: 'complete', views, process_seconds: 1404, threads: 4,
    model: { status: 'ok', sha256: msha, bytes: model.length, mode: 'bust' },
    // The runner claims GPU by mistake: the CPU worker's job says CPU anyway.
    device_summary: { kind: 'GPU', name: 'AMD EPYC 7763', threads: 4, limits: 'preview quality on a 4-core runner' },
    reference_fit: { sha256: sha, method: 'mediapipe face landmarker (Apache-2.0)', landmarks: 478, sliders: { eye_size: 0.31, nose_width: -0.12, junk: 'x', 'Bad Key': 1 },
      colors: { skin: '#8D5524', hair: '#1a1a1a', eyes: 'green' }, fit_error: 0.042, limits: ['front-facing photo only', 'approximate likeness'] },
  } });
  assert.equal(done.job.state, 'completed', JSON.stringify(done.job.history.at(-1)));
  assert.equal(done.job.device_summary.kind, 'CPU', 'never GPU for a CPU worker');
  assert.deepEqual(done.job.reference_fit.sliders, { eye_size: 0.31, nose_width: -0.12 });
  assert.deepEqual(done.job.reference_fit.colors, { skin: '#8d5524', hair: '#1a1a1a' });
  assert.equal(done.job.reference_fit.landmarks, 478);
  assert.equal(done.job.device_line, 'Built on the free GitHub cloud CPU worker (AMD EPYC 7763), a CPU, not a GPU, 4 threads, Standard quality: 64 samples, measured 23.4 min. '
    + 'No GPU worker was online when it started (only the CPU worker was connected), so the CPU built it. Limits: preview quality on a 4-core runner.');
  assert.doesNotMatch(done.job.device_line, /\bon the GPU\b/);
  assert.match(done.job.reference_line, /^Reference fit, an approximate likeness, not an exact copy \(mediapipe face landmarker \(Apache-2\.0\)\): 478 landmarks, fit error 0\.042\. Colours from the photo: skin #8d5524, hair #1a1a1a\. Strongest face settings: eye size \+0\.31, nose width -0\.12\. Limits: front-facing photo only; approximate likeness\./);
  // The app polls the project: the same lines and receipts are there.
  const d = (await call(`/api/creations/${p.id}`)).body.project;
  assert.equal(d.device_line, done.job.device_line);
  assert.equal(d.reference_line, done.job.reference_line);
  assert.equal(d.job.device_summary.kind, 'CPU');
  assert.ok((await (await owner('/api/gpu')).json()).jobs.find((j) => j.id === gen.body.job.id).device_line);
});

test('device and fit lines: GPU named from its receipt, a fit for another photo is not used, nothing before completion', () => {
  const base = { state: 'completed', samples: 128, settings: { QUALITY: 'high', REFERENCE: JSON.stringify({ sha256: 'a'.repeat(64), consent: 'self', bytes: 1 }) }, requires: { gpu: 'preferred' }, kind: 'person_model' };
  assert.equal(deviceLine({ ...base, rendered_on: { class: 'colab' }, receipt: { nvidia_smi: GPU, process_seconds: 186, device_summary: { kind: 'GPU', name: 'Tesla T4', threads: 0, limits: [] } } }),
    'Built on the GPU Tesla T4, High quality: 128 samples, measured 3.1 min.');
  assert.equal(deviceLine({ ...base, state: 'rendering', receipt: {} }), '');
  assert.equal(deviceLine({ ...base, rendered_on: { class: 'github_cpu' }, receipt: { stage_seconds: { model: 60, render: 60 } } }),
    'Built on the free GitHub cloud CPU worker, a CPU, not a GPU, High quality: 128 samples, measured 2 min. No GPU worker was online when it started (only the CPU worker was connected), so the CPU built it.');
  assert.match(referenceLine({ ...base, receipt: { reference_fit: { sha256: 'b'.repeat(64), landmarks: 1 } } }), /for a different photo/);
  assert.equal(referenceLine({ ...base, receipt: {} }), '');
  assert.match(engineDeviceLine({ gpu: 'Tesla T4', online: true }), /^A GPU worker is connected: Tesla T4/);
  assert.match(engineDeviceLine({ gpu: 'CPU (GitHub cloud worker)', online: true }), /^No GPU is connected: your Colab GPU notebook is not open, so only the free GitHub cloud CPU worker is available/);
  assert.match(engineDeviceLine({ online: false, automatic: false }), /^No worker is connected/);
});

// ── Owner-only, through the real worker.js (device pairing) ─────────────────────────────────────────────────────
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }

test('the reference routes are owner-only; a paired owner device cannot open the worker fetch route', { skip: DatabaseSync ? false : 'node:sqlite unavailable' }, async () => {
  const generated = new URL('./.creation_reference.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: workerMod, CheState } = mod;
  const saved = new Map(); const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec: (q, ...p) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? s.all(...p) : (s.run(...p), []); } },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => (Array.isArray(k) ? k.filter((x) => saved.delete(x)).length : saved.delete(k)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => workerMod.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  assert.ok(token);
  const made = await (await send('/api/creations', { base: 'che' }, token)).json();
  const id = made.project.id;
  for (const [method, body] of [['POST', { image_base64: b64(JPEG), consent: 'self' }], ['GET'], ['DELETE']]) {
    const res = await send(`/api/creations/${id}/reference`, body, '', method);
    assert.ok([401, 403].includes(res.status), `${method} without a device token: ${res.status}`);
  }
  const added = await send(`/api/creations/${id}/reference`, { image_base64: b64(JPEG), consent: 'self' }, token);
  assert.equal(added.status, 201);
  const gen = await (await send(`/api/creations/${id}/generate`, {}, token)).json();
  const res = await send(`/api/gpu/worker/reference?worker=colab-1&job=${gen.job.id}`, undefined, token, 'GET');
  assert.equal(res.status, 404, 'an owner device token is not a worker credential');
});
