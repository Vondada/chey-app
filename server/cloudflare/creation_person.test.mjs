// Create Person, full character (owner, 2026-10-25): describe a person in words and build at once, body shape edits
// sent as BODY_* settings (omitted at today's look), hair style phrases, the outfit colour reaching the body, character
// voices from CHE's existing on-device catalog, deterministic variations that keep earlier versions reopenable, and a
// job that finishes while the app is closed. Deterministic, no model calls; synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { BODY_KEYS, CHARACTER_VOICES, SKIN_TONES, ageMacro, cleanShape, creationRoute, describePerson, hairStyleIn, parseEdit, shapeErrors, shapeSettings, styleIn } from './creation_studio.js';
import { BUILT_IN, skinOk } from './avatar_identity.js';
import { gpuOwnerRoute, gpuWorkerRoute } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
function glb() {
  const text = JSON.stringify({ asset: { version: '2.0' } }); const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const b = new Uint8Array(20 + padded.length); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, b.length, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}
function setup() {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const storage = memStorage(); const now = () => t; const ctx = { storage, env: {}, now };
  const call = async (path, method = 'GET', body) => {
    const res = await creationRoute(ctx, path.split('?')[0], new Request(`https://che.example${path}`, { method, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) }), body || {});
    return { status: res.status, body: await res.json() };
  };
  const owner = async (path, method = 'GET', body) => gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
  const worker = async (route, body, token, query = '', bytes = null) => {
    const res = await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
      method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token }, body: bytes || JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  return { storage, ctx, call, owner, worker, advance: (ms) => { t += ms; } };
}
const CHE = BUILT_IN.find((p) => p.id === 'che');

test('describe a person: identity, body, outfit and look from plain words; what it cannot make is said plainly', () => {
  const d = describePerson('a tall athletic man in his 30s, short curly black hair, brown skin, green eyes, black hoodie, game style');
  assert.equal(d.ok, true);
  assert.equal(d.params.body.sex, 1); assert.equal(d.style, 'hybrid');
  assert.equal(d.params.hair.style, 'curly_short'); assert.equal(d.params.hair.color, '#16110e');
  assert.equal(d.params.eyes.iris, '#4f7a4a'); assert.equal(d.params.skin.tone, SKIN_TONES.brown);
  assert.deepEqual(d.params.outfit, { top: 'hoodie', color: '#16110e' });
  assert.equal(d.shape.height, 0.7); assert.equal(d.shape.muscle, 0.7); assert.equal(d.shape.age, ageMacro(35));
  assert.deepEqual(d.unused, []); assert.deepEqual(d.unsupported, []);
  const w = describePerson('a hyperrealistic woman with wings, a sword and glasses, petite, afro');
  assert.equal(w.style, 'photoreal'); assert.equal(w.params.body.sex, 0); assert.equal(w.params.hair.style, 'afro'); assert.equal(w.shape.height, 0.3);
  assert.deepEqual(w.unsupported, ["I can't make wings yet.", "I can't make weapons yet.", "I can't make glasses yet."]);
  assert.deepEqual(describePerson('a cartoon person with a zorblax').unused, ['zorblax']);
  assert.equal(describePerson('a slim young adult, afro, hoodie, stylized cartoon look').style, 'stylized');
  for (const minor of ['a teenage boy', 'a child with red hair', 'a 15-year-old girl', 'a kid']) {
    const r = describePerson(minor);
    assert.equal(r.ok, false, minor); assert.equal(r.refused, true); assert.match(r.detail, /adult characters only, 18 or older/);
  }
  assert.equal(describePerson('').ok, false);
  for (const tone of Object.values(SKIN_TONES)) assert.ok(skinOk(tone), tone);
  assert.equal(styleIn('make it game-like'), 'hybrid'); assert.equal(styleIn('animated'), 'stylized'); assert.equal(styleIn('photo'), 'photoreal');
  assert.equal(hairStyleIn('buzz cut'), 'close_crop'); assert.equal(hairStyleIn('a low bun'), 'bun_low'); assert.equal(hairStyleIn('curly hair'), 'curly_short');
  assert.equal(hairStyleIn('short hair'), 'close_crop'); assert.equal(hairStyleIn('a bun'), 'bun_high');
});

test('one Create button: a description becomes a project and is queued at once, with BODY_*, OUTFIT and the look in the job', async () => {
  const { call } = setup();
  const r = await call('/api/creations', 'POST', { kind: 'person', description: 'a tall athletic man in his 30s, short curly black hair, brown skin, green eyes, black hoodie, game style' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.generated, true);
  const s = r.body.job.settings;
  assert.equal(s.STYLE, 'hybrid'); assert.equal(s.HAIR_STYLE, 'curly_short'); assert.equal(s.OUTFIT_TOP, 'hoodie'); assert.equal(s.OUTFIT_SRGB, '22,17,14');
  assert.equal(s.BODY_HEIGHT, '0.7'); assert.equal(s.BODY_MUSCLE, '0.7'); assert.equal(s.BODY_WEIGHT, '0.45'); assert.equal(s.BODY_AGE, String(ageMacro(35)));
  assert.equal(s.BODY_PROPORTIONS, undefined, 'a default is omitted');
  assert.match(r.body.spoken, /^Tall athletic man in his 30s started\. A man of about 35\. .*Look: hybrid game\. Queued\./);
  assert.equal(r.body.project.description.startsWith('a tall athletic man'), true);
  const wings = await call('/api/creations', 'POST', { kind: 'person', description: 'a woman with wings', generate: false });
  assert.equal(wings.status, 201); assert.match(wings.body.spoken, /I can't make wings yet\..*Say generate to build it\./); assert.equal(wings.body.job, undefined);
  const kid = await call('/api/creations', 'POST', { kind: 'person', description: 'a little kid' });
  assert.equal(kid.status, 422); assert.equal(kid.body.refused, true);
  assert.equal((await call('/api/creations')).body.projects.length, 2, 'the refused one made no project');
});

test('body edits: taller, shorter, heavier, slimmer, more muscular, masculine; ranges validated; defaults omitted so old jobs stay the same', async () => {
  const p0 = parseEdit('make her taller and more muscular', CHE, 'photoreal');
  assert.deepEqual(p0.shape, { height: 0.65, muscle: 0.7 }); assert.deepEqual(p0.applied, ['Body: taller.', 'Body: more muscular.']);
  const p1 = parseEdit('make her shorter, heavier build', CHE, 'photoreal', undefined, p0.shape);
  assert.deepEqual(p1.shape, { muscle: 0.7, weight: 0.65 }, 'height back at its default is omitted');
  assert.deepEqual(parseEdit('slimmer', CHE, 'photoreal').shape, { weight: 0.35 });
  assert.deepEqual(parseEdit('thinner lips', CHE, 'photoreal').shape, {}, 'a face edit is not a body edit');
  assert.deepEqual(parseEdit('thinner lips', CHE, 'photoreal').applied, ['Face: lips thinner.']);
  const m = parseEdit('more masculine', CHE, 'photoreal');
  assert.equal(m.shape.gender, 0.25); assert.equal(m.params.body.sex, 0.25);
  // "shorter" next to hair is the hair, not the height.
  const hair = parseEdit('make the hair shorter', CHE, 'photoreal');
  assert.deepEqual(hair.shape, {}); assert.match(hair.applied[0], /^Hair changed to/);
  let tall = {}; for (let i = 0; i < 6; i++) tall = parseEdit('taller', CHE, 'photoreal', undefined, tall).shape;
  assert.equal(tall.height, 1, 'clamped at 1');
  assert.deepEqual(shapeErrors({ height: 1.2 }), ['body height must be 0..1']);
  assert.deepEqual(shapeErrors({ age: 0.1 }), ['body age must be an adult (18 or older)']);
  assert.deepEqual(shapeErrors({ wings: 1 }), ['unknown body setting wings']);
  assert.deepEqual(cleanShape({ height: 0.5, weight: 0.7, proportions: 0.5 }), { weight: 0.7 });
  assert.deepEqual(shapeSettings({ height: 0.65, gender: 0.25 }), { BODY_HEIGHT: '0.65', BODY_GENDER: '0.25' });
  assert.deepEqual(Object.values(BODY_KEYS), ['BODY_GENDER', 'BODY_AGE', 'BODY_HEIGHT', 'BODY_WEIGHT', 'BODY_MUSCLE', 'BODY_PROPORTIONS']);

  const { call } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  const before = (await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.settings;
  assert.ok(!Object.keys(before).some((k) => k.startsWith('BODY_')), 'an unedited project sends no BODY_* settings');
  const e = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'taller, heavier and more muscular' });
  assert.equal(e.body.changed, true); assert.deepEqual(e.body.project.shape, { height: 0.65, weight: 0.65, muscle: 0.7 });
  const after = (await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.settings;
  assert.equal(after.BODY_HEIGHT, '0.65'); assert.equal(after.BODY_WEIGHT, '0.65'); assert.equal(after.BODY_MUSCLE, '0.7');
  const undo = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.deepEqual(undo.body.project.shape, {}, 'undo restores the body');
});

test('hair phrases and outfit: buzz cut, afro, bun, curly; a black hoodie sets the top and its colour, which reaches the body', async () => {
  const che = structuredClone(CHE);
  assert.equal(parseEdit('give her a buzz cut', che, 'photoreal').params.hair.style, 'close_crop');
  assert.equal(parseEdit('an afro', che, 'photoreal').params.hair.style, 'afro');
  assert.equal(parseEdit('put her hair in a bun', che, 'photoreal').params.hair.style, 'bun_high');
  assert.equal(parseEdit('curly hair', che, 'photoreal').params.hair.style, 'curly_short');
  const multi = parseEdit('short curly black hair, a red hoodie and green eyes', che, 'photoreal');
  assert.equal(multi.params.hair.style, 'curly_short'); assert.equal(multi.params.hair.color, '#16110e');
  assert.equal(multi.params.outfit.top, 'hoodie'); assert.equal(multi.params.outfit.color, '#8a2a16');
  assert.equal(multi.params.eyes.iris, '#4f7a4a');
  const { call } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'a red hoodie' });
  const s = (await call(`/api/creations/${p.id}/generate`, 'POST', {})).body.job.settings;
  assert.equal(s.OUTFIT_SRGB, '138,42,22'); assert.equal(s.OUTFIT_TOP, 'hoodie');
});

test('character voices: the catalog is CHE\'s on-device voices; numbered list, choose by number (undoable), play only on request', async () => {
  assert.equal(CHARACTER_VOICES.length, 11);
  assert.deepEqual(CHARACTER_VOICES.map((v) => v.id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const { call } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  const list = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'what voices are there' });
  assert.match(list.body.spoken, /^Character voices: 1\. Chaze .* 2\. American Feminine — Bella .* 11\. British Masculine — Lewis Say choose voice and a number\./);
  assert.equal(list.body.changed, false);
  const noVoice = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'play the voice' });
  assert.equal(noVoice.status, 409); assert.equal(noVoice.body.play_voice, undefined);
  const pick = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'choose voice 2' });
  assert.equal(pick.body.changed, true); assert.match(pick.body.spoken, /^Voice set to 2, American Feminine — Bella\. Saved as version 2\./);
  assert.deepEqual(pick.body.project.voice, { id: 1, name: 'American Feminine — Bella', speaker: 'af_bella' });
  const play = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'play the voice' });
  assert.equal(play.body.play_voice.speaker, 'af_bella'); assert.equal(play.body.play_voice.id, 1); assert.match(play.body.play_voice.text, /This is my voice/);
  const deeper = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'give her a deeper voice' });
  assert.match(deeper.body.spoken, /no pitch control, so I can't make one deeper/); assert.equal(deeper.body.changed, false);
  assert.equal((await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'voice 40' })).status, 409);
  // The voice is carried by later edits and undone with the version.
  const e = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'bigger eyes' });
  assert.equal(e.body.project.voice.id, 1);
  await call(`/api/creations/${p.id}/undo`, 'POST', {});
  const u = await call(`/api/creations/${p.id}/undo`, 'POST', {});
  assert.equal(u.body.project.voice, null);
});

test('"make another one" queues a deterministic variation; the previous version and its model stay reopenable', async () => {
  const { call, owner, worker, advance } = setup();
  const p = (await call('/api/creations', 'POST', { base: 'che' })).body.project;
  const g1 = await call(`/api/creations/${p.id}/generate`, 'POST', {});
  const v2 = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'make another one' });
  assert.equal(v2.status, 200, JSON.stringify(v2.body)); assert.equal(v2.body.project.version, 2); assert.equal(v2.body.project.variation, 1);
  assert.match(v2.body.spoken, /^Made variation 1 as version 2: the face settings moved a little from version 1\. .* Say undo to go back to version 1\./);
  assert.equal(v2.body.job.settings.VARIATION, '1');
  assert.notEqual(v2.body.job.settings.FACE, g1.body.job.settings.FACE, 'the face really moved');
  assert.notEqual(v2.body.job.id, g1.body.job.id);
  const v3 = await call(`/api/creations/${p.id}/edit`, 'POST', { text: 'regenerate' });
  assert.equal(v3.body.job.settings.VARIATION, '2');
  // The same seed gives the same face (deterministic).
  const q = setup();
  const p2 = (await q.call('/api/creations', 'POST', { base: 'che' })).body.project;
  const again = await q.call(`/api/creations/${p2.id}/edit`, 'POST', { text: 'make another one' });
  assert.equal(again.body.job.settings.FACE, v2.body.job.settings.FACE);

  // Version 1's model is built; after undo to version 1, reopening shows it (last_model), and from version 3 too.
  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  const view = await (await owner('/api/gpu')).json();
  for (const j of view.jobs.filter((x) => x.kind === 'face_preview' || x.id !== g1.body.job.id)) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  advance(1000);
  const claim = await worker('claim', { worker_id: 'colab-1', gpu: 'Tesla T4, 550, 15360 MiB' }, token);
  assert.equal(claim.body.job.id, g1.body.job.id);
  const model = glb();
  await worker('model', null, token, `?worker=colab-1&job=${g1.body.job.id}`, model);
  const d3 = (await call(`/api/creations/${p.id}`)).body.project;
  assert.equal(d3.version, 3); assert.equal(d3.last_model.version, 1); assert.equal(d3.last_model.current, false);
  assert.equal(d3.last_model.url, `/api/gpu/jobs/${g1.body.job.id}/model.glb`);
});

test('the app closes after Generate; the worker finishes through its token routes; a fresh read of My Creations shows the result', async () => {
  const { ctx, owner, worker, advance } = setup();
  // The phone: create and generate, then it is gone (no more calls from it).
  const phone = async (path, method = 'GET', body) => (await creationRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {})).json();
  const made = await phone('/api/creations', 'POST', { kind: 'person', description: 'a woman in her 40s, long wavy red hair, a green sweater, realistic' });
  assert.equal(made.generated, true);
  const jobId = made.job.id; const projectId = made.project.id;
  await phone(`/api/creations/${projectId}/save`, 'POST', {});
  // The worker (paired token) does the whole job with no app request in between.
  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  const v = await (await owner('/api/gpu')).json();
  for (const j of v.jobs.filter((x) => x.kind === 'face_preview')) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  advance(60_000);
  const claim = await worker('claim', { worker_id: 'colab-9', gpu: 'Tesla T4, 550, 15360 MiB' }, token);
  assert.equal(claim.body.job.id, jobId);
  const model = glb(); const sha = createHash('sha256').update(model).digest('hex');
  assert.equal((await worker('model', null, token, `?worker=colab-9&job=${jobId}`, model)).status, 200);
  for (const deg of [0, 45, 90]) assert.equal((await worker('preview', null, token, `?worker=colab-9&job=${jobId}&view=${deg}`, PNG)).status, 200);
  const views = Object.fromEntries([0, 45, 90].map((x) => [x, { status: 'ok', device: "DEVICE OPTIX ['Tesla T4']" }]));
  const done = await worker('complete', { worker_id: 'colab-9', job_id: jobId, status: 'complete', receipt: { status: 'complete', views, process_seconds: 240,
    nvidia_smi: 'Tesla T4, 550, 15360 MiB', device_summary: { kind: 'GPU', name: 'Tesla T4', threads: 0, limits: [] },
    model: { status: 'ok', sha256: sha, bytes: model.length, mode: 'full_body', rig: { ok: true, bones: 53, clips: [{ name: 'walk', seconds: 1.2 }], morphs: [] } } } }, token);
  assert.equal(done.body.job.state, 'completed');
  advance(3_600_000);
  // The app opens again, fresh: My Creations and the project show the finished build.
  const list = await phone('/api/creations');
  const card = list.projects.find((x) => x.id === projectId);
  assert.equal(card.job.state, 'completed'); assert.equal(card.model_url, `/api/gpu/jobs/${jobId}/model.glb`); assert.ok(card.saved_at);
  assert.equal(card.last_model.sha256, sha); assert.equal(card.last_model.current, true);
  const opened = await phone(`/api/creations/${projectId}`);
  assert.equal(opened.project.job.model.sha256, sha);
  assert.equal(opened.project.device_line, 'Built on the GPU Tesla T4, Standard quality: 64 samples, measured 4 min.');
  assert.match(opened.spoken, /3D model and previews for this version are ready/);
  const served = await owner(opened.project.model_url);
  assert.equal(served.status, 200); assert.deepEqual(new Uint8Array(await served.arrayBuffer()), model);
});
