// Identity presets (avatar_identity.js): the presets match tools/avatar_face/identities.json, the settings match
// identity.py for CHE, validation, Generate, and the /api/gpu/identities routes as gpuOwnerRoute serves them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { IDENTITIES } from './avatar_identity_presets.js';
import { BUILT_IN, FACE_TARGETS, MAX_CUSTOM, STYLES, generateVariant, num, toSettings, validate } from './avatar_identity.js';
import { gpuOwnerRoute } from './gpu_queue.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k) };
}
const req = (path, body, method = 'POST') => new Request(`https://che.example${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function call(ctx, path, body, method = 'POST') {
  const res = await gpuOwnerRoute(ctx, path, req(path, body, method), body);
  return { status: res.status, data: await res.json() };
}
const ctx = () => ({ storage: memStorage(), now: () => Date.parse('2026-10-24T12:00:00Z') });
const che = () => structuredClone(BUILT_IN.find((p) => p.id === 'che'));

test('the Worker presets are exactly tools/avatar_face/identities.json (regenerate with avatar_identity_cli.mjs --write-presets)', () => {
  const file = JSON.parse(readFileSync(new URL('../../tools/avatar_face/identities.json', import.meta.url), 'utf8'));
  assert.deepEqual(IDENTITIES, file);
});

test('CHE photoreal settings are exactly what identity.py gives', () => {
  assert.deepEqual(toSettings(che(), 'photoreal'), {
    BROW_N: '1000', BROW_W: '1.8',
    FACE: 'lr:eyes/eye-corner2-up=0.2,lr:eyes/eye-eyefold-down=0.4,nose/nose-point-width-incr=0.3,nose/nose-scale-horiz-decr=0.2,mouth/mouth-upperlip-volume-incr=0.3,mouth/mouth-lowerlip-volume-incr=0.5,mouth/mouth-cupidsbow-incr=0.5,lr:cheek/cheek-volume-incr=0.3,chin/chin-width-decr=0.2',
    FIT_W: '1', HAIR_SRGB: '28,18,16', HAIR_STYLE: 'long_wavy', IDENTITY: 'che', IRIS: '2.5', IRIS_SRGB: '94,62,40', LASH_LEN: '0.55',
    MATURE: '0.1', PORES: '0.22', RACE: 'african=0.7,caucasian=0.3', SEX: '0', STRANDS: '90', STYLE: 'photoreal', TARGET_SRGB: '80,46,32',
  });
  assert.deepEqual(Object.keys(toSettings(che())), Object.keys(toSettings(che())).sort(), 'keys sorted');
});

test('every built-in preset is valid in every look; unbuilt hair renders without strands; numbers print like Python', () => {
  for (const p of BUILT_IN) {
    assert.deepEqual(validate(p), [], p.id);
    for (const s of STYLES) {
      const st = toSettings(p, s);
      assert.equal(st.STYLE, s);
      assert.equal(st.NOHAIR === '1', p.hair.style !== 'long_wavy', `${p.id} NOHAIR`);
      assert.equal('FIT_W' in st, Boolean(p.body.fit), `${p.id} FIT_W only with body.fit`);
    }
  }
  assert.deepEqual([num(0.3), num(1), num(0), num(0.125), num(0.1 + 0.2), num(-0.25)], ['0.3', '1', '0', '0.125', '0.3', '-0.25']);
});

test('validation explains each problem in words', () => {
  const p = che();
  p.id = 'Bad Id'; p.body.sex = 2; p.body.fit = 3; p.body.race = { martian: 1 }; p.face.nope = 0.2; p.face.eye_size = 4; p.face.face_round = -0.5;
  p.skin.tone = 'brown'; p.hair.style = 'mohawk';
  const out = validate(p).join(' | ');
  for (const want of ['id must be', 'body.sex must be 0..1', 'body.fit must be 0..1', 'body.race', 'unknown face slider nope', 'face.eye_size must be -1..1', 'face.face_round is 0..1', 'skin.tone must be #rrggbb', 'hair.style must be one of']) {
    assert.match(out, new RegExp(want.replace(/[.]/g, '\\.')), want);
  }
  assert.throws(() => toSettings(p), /id must be/);
  assert.throws(() => toSettings(che(), 'anime'), /style must be/);
});

test('Generate is deterministic, stays in range, and is labelled a parameter variation', () => {
  const a = generateVariant(che(), { seed: 7 }); const b = generateVariant(che(), { seed: 7 }); const c = generateVariant(che(), { seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.face, c.face);
  assert.equal(a.id, 'che_v7'); assert.equal(a.name, 'CHE variant 7'); assert.match(a.references, /never a photo fit/);
  for (const [k, , neg] of FACE_TARGETS) {
    const v = a.face[k] ?? 0;
    assert.ok(v >= (neg === null ? 0 : -1) && v <= 1, k);
    assert.ok(Math.abs(v - (che().face[k] ?? 0)) <= 0.25 + 0.005, `${k} moved at most 0.25`);
  }
  assert.deepEqual(validate(a), []);
});

test('GET lists built-in presets, the active preset per agent, sliders, hair styles and a spoken line', async () => {
  const c = ctx();
  const { status, data } = await call(c, '/api/gpu/identities', undefined, 'GET');
  assert.equal(status, 200);
  assert.deepEqual(data.presets.filter((p) => p.built_in).map((p) => p.id), ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale']);
  assert.equal(data.active.che, 'che');
  assert.deepEqual(data.styles, STYLES);
  assert.equal(data.face_sliders.find((s) => s.id === 'face_round').min, 0);
  assert.deepEqual(data.hair_built, ['long_wavy']);
  assert.match(data.spoken, /10 built-in character presets and 0 saved presets/);
});

test('Save keeps a custom preset, refuses to overwrite a built-in or an invalid one, and caps the count', async () => {
  const c = ctx();
  assert.equal((await call(c, '/api/gpu/identities', { preset: che() })).status, 422, 'built-in id refused');
  const bad = { ...generateVariant(che(), { seed: 3 }), skin: { tone: 'x' } };
  assert.equal((await call(c, '/api/gpu/identities', { preset: bad })).status, 422);
  const v = generateVariant(che(), { seed: 3 });
  const ok = await call(c, '/api/gpu/identities', { preset: v });
  assert.equal(ok.status, 200); assert.match(ok.data.spoken, /Saved the CHE variant 3 preset/);
  const again = await call(c, '/api/gpu/identities', { preset: { ...v, name: 'Renamed' } });
  assert.equal(again.status, 200, 'saving the same custom id replaces it');
  const list = (await call(c, '/api/gpu/identities', undefined, 'GET')).data;
  assert.deepEqual(list.presets.filter((p) => !p.built_in).map((p) => p.name), ['Renamed']);
  for (let i = 0; i < MAX_CUSTOM - 1; i++) await call(c, '/api/gpu/identities', { preset: generateVariant(che(), { seed: 100 + i }) });
  const over = await call(c, '/api/gpu/identities', { preset: generateVariant(che(), { seed: 999 }) });
  assert.equal(over.status, 422); assert.match(over.data.detail, /At most 50/);
});

test('Generate route returns an unsaved variant of a saved or built-in preset', async () => {
  const c = ctx();
  const { status, data } = await call(c, '/api/gpu/identities/generate', { base_id: 'nova', seed: 5 });
  assert.equal(status, 200); assert.equal(data.saved, false); assert.equal(data.preset.id, 'nova_v5');
  assert.match(data.spoken, /not saved yet/);
  assert.equal((await call(c, '/api/gpu/identities/generate', { base_id: 'nobody' })).status, 404);
});

test('Apply sets which preset an agent uses; unknown agents and presets are refused', async () => {
  const c = ctx();
  await call(c, '/api/gpu/identities', { preset: generateVariant(che(), { seed: 9 }) });
  const out = await call(c, '/api/gpu/identities/apply', { agent: 'che', preset_id: 'che_v9' });
  assert.equal(out.status, 200); assert.match(out.data.spoken, /CHE now uses the CHE variant 9 preset/);
  assert.equal((await call(c, '/api/gpu/identities', undefined, 'GET')).data.active.che, 'che_v9');
  assert.equal((await call(c, '/api/gpu/identities/apply', { agent: 'zed', preset_id: 'che' })).status, 422);
  assert.equal((await call(c, '/api/gpu/identities/apply', { agent: 'nova', preset_id: 'missing' })).status, 422);
});

test('Preview queues one GPU job per look with the preset in the settings, says nothing rendered, and dedupes', async () => {
  const c = ctx();
  const { status, data } = await call(c, '/api/gpu/identities/preview', { preset_id: 'atlas' });
  assert.equal(status, 202);
  assert.deepEqual(data.jobs.map((j) => j.style), STYLES);
  const settings = data.jobs.map((j) => JSON.stringify(j.job.settings));
  assert.equal(new Set(settings).size, 3, 'three distinct job settings');
  for (const j of data.jobs) {
    assert.equal(j.job.state, 'queued'); assert.equal(j.job.settings.IDENTITY, 'atlas'); assert.deepEqual(j.job.views, [0, 45, 90]);
    assert.match(j.job.title, /^Atlas, .*: front, three-quarter and side$/);
  }
  assert.match(data.spoken, /Queued 3 preview jobs for Atlas.*Colab T4.*nothing has rendered yet/);
  const again = (await call(c, '/api/gpu/identities/preview', { preset_id: 'atlas', styles: ['hybrid'] })).data;
  assert.equal(again.jobs[0].duplicate, true); assert.match(again.spoken, /Queued 0 preview jobs.*1 already waiting/);
  const unsaved = await call(c, '/api/gpu/identities/preview', { preset: generateVariant(che(), { seed: 4 }), styles: ['stylized'] });
  assert.equal(unsaved.status, 202); assert.equal(unsaved.data.jobs[0].job.settings.IDENTITY, 'che_v4');
  assert.equal((await call(c, '/api/gpu/identities/preview', { preset_id: 'atlas', styles: ['anime'] })).status, 422);
  assert.equal((await call(c, '/api/gpu/identities/preview', { preset_id: 'ghost' })).status, 404);
  assert.equal((await call(c, '/api/gpu/identities/preview', undefined, 'GET')).status, 405);
});
