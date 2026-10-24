// Invention visuals (owner, 2026-10-24: invention inv-8a637dad, an Iron Man-style suit, answered with text only).
// A design now attaches a real concept picture; "show me", "open it in 3D", "rotate it" and "change the color" make and
// save real pictures and models on the project; nothing is claimed that was not built and read back.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { decodePng } from './internal_renderer.js';
import { planInvention } from './invention_studio.js';
import { MAX_VISUAL_VERSIONS, buildGlb, conceptSheet, inventionVisualIntent, makeModel, paletteFor, partsFor, readGlb, visualTurn } from './invention_visuals.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k), list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}

test('the owner\'s words: show me, open it in 3D, rotate it, zoom, change the color; ordinary sentences are not visual asks', () => {
  assert.deepEqual(inventionVisualIntent('Show me'), { kind: 'show' });
  assert.deepEqual(inventionVisualIntent('CHE, show me the suit.'), { kind: 'show' });
  assert.deepEqual(inventionVisualIntent('what does it look like?'), { kind: 'show' });
  assert.deepEqual(inventionVisualIntent('Open it in 3D'), { kind: 'model' });
  assert.deepEqual(inventionVisualIntent('view in 3d'), { kind: 'model' });
  assert.deepEqual(inventionVisualIntent('rotate it'), { kind: 'viewport', viewport: { action: 'rotate', deg: 45 } });
  assert.deepEqual(inventionVisualIntent('rotate it left 90 degrees'), { kind: 'viewport', viewport: { action: 'rotate', deg: -90 } });
  assert.deepEqual(inventionVisualIntent('zoom in'), { kind: 'viewport', viewport: { action: 'zoom', factor: 1.4 } });
  assert.deepEqual(inventionVisualIntent('change the color to blue'), { kind: 'colour', colour: 'blue' });
  assert.deepEqual(inventionVisualIntent('Change the colour'), { kind: 'colour', colour: null });
  assert.deepEqual(inventionVisualIntent('make it gold'), { kind: 'colour', colour: 'gold' });
  for (const s of ['show me my emails', 'turn off the lights', 'rotate my API keys', 'what is the color of the sky', 'make it happen', 'show me the ETH chart']) {
    assert.equal(inventionVisualIntent(s), null, s);
  }
});

test('the 3D model is a real GLB of the named parts, read back from its own bytes; the colour changes the primary material', () => {
  const parts = partsFor('powered_suit');
  const glb = buildGlb(parts, paletteFor('powered_suit', 'red'));
  const facts = readGlb(glb);
  assert.equal(facts.meshes, parts.length);
  for (const name of ['helmet', 'chest plate', 'power core', 'left boot', 'right boot', 'right palm emitter']) assert.ok(facts.nodes.includes(name), name);
  assert.deepEqual(facts.materials, ['primary', 'secondary', 'glow', 'joint']);
  const blue = buildGlb(parts, paletteFor('powered_suit', 'blue'));
  assert.notDeepEqual([...glb], [...blue]);
  assert.equal(readGlb(new Uint8Array(40)), null, 'bytes that are not a GLB never count as a model');
  for (const t of ['exoskeleton', 'robot', 'device']) assert.equal(readGlb(buildGlb(partsFor(t), paletteFor(t))).meshes, partsFor(t).length, t);
});

test('the concept sheet is a real PNG of the same parts, labelled procedural in the file itself', async () => {
  const project = planInvention('Design me an Iron Man-style suit', { id: 'inv-8a637dad' });
  const sheet = await conceptSheet(project, 'red');
  const png = await decodePng(sheet.png);
  assert.equal(png.ok, true, png.reason);
  assert.equal(png.width, 800); assert.equal(png.height, 450);
  assert.match(new TextDecoder().decode(sheet.png.subarray(0, 200)), /procedural concept sheet \(CHE internal renderer\), not a photo/);
});

test('visual turns save versions on the project and say exactly what was built', async () => {
  const storage = memStorage(); const env = {};
  const project = planInvention('Design me an Iron Man-style suit', { id: 'inv-8a637dad' });
  const shown = await visualTurn(env, storage, project, { kind: 'show' }, { tryModel: false });
  assert.match(shown.spoken, /procedural concept sheet/); assert.equal(shown.image.v, 1);
  assert.equal(project.concept.media_id, shown.image.media_id);
  const opened = await visualTurn(env, storage, project, { kind: 'model' });
  assert.equal(opened.open3d, true); assert.equal(opened.model.v, 1);
  assert.match(opened.spoken, /Built a procedural 3D concept model .* with 30 parts and saved it as version 1/);
  assert.match(opened.model.sha256, /^[0-9a-f]{64}$/);
  const again = await visualTurn(env, storage, project, { kind: 'viewport', viewport: { action: 'rotate', deg: 45 } });
  assert.match(again.spoken, /^Opening 3D model version 1/); assert.deepEqual(again.viewport, { action: 'rotate', deg: 45 });
  const blue = await visualTurn(env, storage, project, { kind: 'colour', colour: 'blue' });
  assert.equal(blue.model.v, 2); assert.equal(blue.model.colour, 'blue'); assert.equal(blue.image.v, 2);
  assert.equal(project.visuals.colour, 'blue');
  const none = await visualTurn(env, storage, project, { kind: 'colour', colour: null });
  assert.match(none.spoken, /Which colour\? .*Nothing was changed/); assert.equal(project.visuals.models.length, 2);
  // The cap is honest: nothing is removed to make room.
  project.visuals.models = Array.from({ length: MAX_VISUAL_VERSIONS }, (_, i) => ({ v: i + 1 }));
  const full = await makeModel(storage, project);
  assert.equal(full.ok, false); assert.match(full.detail, /Nothing was removed/);
});

// Through the real Worker: the owner's chat words and the app's routes.
const generated = new URL('./.invention_visuals.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function app() {
  const saved = new Map();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Understood, sir.' }) } };
  const storage = { get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined), put: async (k, v) => saved.set(k, structuredClone(v)),
    delete: async (k) => saved.delete(k), deleteAll: async () => saved.clear(), list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, sql };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (method, path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const token = (await (await send('POST', '/api/pair', { code: '123456' })).json()).device_token;
  let history = [];
  const say = async (message) => {
    const raw = await (await send('POST', '/api/chat', { message, history }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
    return { reply, meta: done };
  };
  return { say, send, token, saved };
}

test('chat: design attaches a picture; show me, open it in 3D, rotate it and change the color answer with real files', async () => {
  const che = await app();
  const made = await che.say('Design me an Iron Man-style suit');
  const id = made.meta.invention_id;
  assert.ok(made.meta.media_url, 'the design reply carries a picture, never text only');
  assert.match(made.reply, /Concept picture attached/);

  const shown = await che.say('Show me');
  assert.equal(shown.meta.source, 'che_invention_studio'); assert.equal(shown.meta.invention_id, id);
  assert.ok(shown.meta.media_url); assert.notEqual(shown.meta.media_id, made.meta.media_id, 'a new saved picture');
  assert.match(shown.reply, /Saved as concept picture 2/);

  const opened = await che.say('Open it in 3D');
  assert.equal(opened.meta.open_invention_3d, true); assert.equal(opened.meta.model_version, 1);
  const res = await che.send('GET', `/api/inventions/${id}/model.glb`, undefined, che.token);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Content-Type'), 'model/gltf-binary');
  const glb = new Uint8Array(await res.arrayBuffer());
  assert.equal(readGlb(glb).meshes, 30);

  const turned = await che.say('rotate it');
  assert.deepEqual(turned.meta.viewport, { action: 'rotate', deg: 45 }); assert.equal(turned.meta.model_version, 1);

  const blue = await che.say('change the color to blue');
  assert.equal(blue.meta.model_version, 2); assert.match(blue.reply, /Changed the main colour to blue\. Saved 3D model version 2 and concept sheet 3/);
  const project = await (await che.send('GET', `/api/inventions/${id}`, undefined, che.token)).json();
  assert.deepEqual(project.visuals.models.map((m) => m.colour), ['red', 'blue']);
  assert.equal(project.visuals.images.length, 3);
  assert.ok(project.visuals.models[1].parts.some((p) => p.name === 'power core' && p.subsystem === 'power'), 'the parts are saved with the model');
  const v1 = new Uint8Array(await (await che.send('GET', `/api/inventions/${id}/model.glb?v=1`, undefined, che.token)).arrayBuffer());
  assert.deepEqual([...v1], [...glb], 'earlier versions stay');
});

test('app routes: build and recolour by button; no model yet is a 404 that says so; no token is refused', async () => {
  const che = await app();
  const id = (await che.say('Design me a humanoid robot')).meta.invention_id;
  const none = await che.send('GET', `/api/inventions/${id}/model.glb`, undefined, che.token);
  assert.equal(none.status, 404); assert.match((await none.json()).detail, /no 3D model yet/);
  const built = await (await che.send('POST', `/api/inventions/${id}/visual`, { action: 'model' }, che.token)).json();
  assert.equal(built.ok, true); assert.equal(built.model.v, 1); assert.equal(built.project.template, 'robot');
  const gold = await (await che.send('POST', `/api/inventions/${id}/visual`, { action: 'colour', colour: 'gold' }, che.token)).json();
  assert.equal(gold.model.colour, 'gold');
  assert.equal((await che.send('POST', `/api/inventions/${id}/visual`, { action: 'model' })).status, 401);
  assert.equal((await che.send('POST', '/api/inventions/inv-missing/visual', { action: 'model' }, che.token)).status, 404);
});

test('"show me" with no invention turn before it is not taken by the studio', async () => {
  const che = await app();
  const out = await che.say('show me');
  assert.notEqual(out.meta.source, 'che_invention_studio');
});
