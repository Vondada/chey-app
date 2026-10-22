// CHE's internal renderer (owner, 2026-10-22: "knowledge must become capability"). The 13 required rendering tests:
// real pictures made by CHE's own code, re-opened and checked, saved, reused, varied and honestly limited.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  Canvas, PROVENANCE, apngFacts, beachAnimation, beachFrames, beachLoop, beachRecipe, beachScene, decodePng, encodePng, evaluateBeach, renderScene, verticalGradient, disc, text, hex, zlibDeflate,
} from './internal_renderer.js';
import { RENDER_CAPABILITIES, selfTest, ensureRendererCapabilities, internalSceneIntent } from './internal_studio.js';
import { PROMOTION_CHECKS, emptyRegistry, loadRegistry, promote, recordCheck, register, rollback, serving, executionAllowed } from './capability_registry.js';
import { replyFromNdjson } from './brain_memory.js';

let networkCalls = 0;
globalThis.fetch = async (input) => { networkCalls++; throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

test('1. a basic procedural image: gradient, glow and text, encoded and re-opened as a real PNG', async () => {
  const c = new Canvas(96, 64);
  verticalGradient(c, 0, 64, [[0, hex('#103060')], [1, hex('#f0a040')]]);
  disc(c, 48, 30, 10, hex('#ffffff'), { glow: 2 });
  text(c, 'CHE 1', 4, 50, 1, [0, 0, 0]);
  const png = await encodePng(c);
  const img = await decodePng(png);
  assert.equal(img.ok, true, img.reason);
  assert.deepEqual([img.width, img.height], [96, 64]);
  assert.equal(img.text.Software, PROVENANCE, 'the file itself says how it was made');
  const top = img.rgb.slice(0, 3), centre = img.rgb.slice((30 * 96 + 48) * 3, (30 * 96 + 48) * 3 + 3);
  assert.ok(top[2] > top[0], 'top of the gradient is blue');
  assert.deepEqual([...centre], [255, 255, 255], 'the disc is drawn');
  // The stored-deflate fallback (no CompressionStream) still makes a valid PNG.
  const stored = await decodePng(await encodePng(c, { forceStored: true }));
  assert.deepEqual(stored.rgb, img.rgb);
});

test('2. a basic beach scene: sky, ocean, sand and horizon, each checked in the pixels', async () => {
  const run = await beachLoop(beachRecipe('create a beach scene'));
  assert.equal(run.ok, true, run.reason);
  assert.deepEqual([run.verification.width, run.verification.height], [640, 360]);
  for (const [k, v] of Object.entries(run.verification.checks)) assert.equal(v, true, k);
  assert.deepEqual(run.steps.map((s) => s.step), ['scene constructed', 'preview rendered', 'final rendered', 'exported and verified']);
});

test('3 + 4. rendering uses no paid API, no external app and no network at all', async () => {
  networkCalls = 0;
  const run = await beachLoop(beachRecipe('a sunset beach'), { size: { w: 320, h: 180 } });
  assert.equal(run.ok, true);
  assert.equal(networkCalls, 0);
  const src = readFileSync(new URL('./internal_renderer.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\(|\bimport\s/.test(src), 'the renderer imports nothing and fetches nothing');
});

test('5. verification rejects a blank or wrong picture; a broken file never passes as an image', async () => {
  const scene = beachScene(beachRecipe('a beach'));
  const blank = new Canvas(160, 90);
  const img = await decodePng(await encodePng(blank));
  const e = evaluateBeach(img, scene);
  assert.equal(e.ok, false);
  assert.equal(e.checks.not_blank, false);
  const png = await encodePng(renderScene(scene, { w: 160, h: 90 }).canvas);
  const corrupt = png.slice(); corrupt[60] ^= 0xff;
  assert.match((await decodePng(corrupt)).reason, /CRC mismatch|could not be decoded/);
  assert.equal((await decodePng(new TextEncoder().encode('not a png at all, but long enough to be read'))).ok, false);
});

test('6 + 7 + 8. the recipe is saved, reused later and varied with the same skill', async () => {
  const day = beachRecipe('a beach with three palm trees and calm water');
  assert.deepEqual([day.look, day.palms, day.waves], ['day', 3, 0.2]);
  const stormy = beachRecipe('make it stormy', day);
  assert.deepEqual([stormy.look, stormy.palms, stormy.waves], ['stormy', 3, 0.2], 'the variation keeps the rest of the recipe');
  for (const look of ['sunset', 'night', 'stormy']) {
    const run = await beachLoop({ ...day, look }, { size: { w: 320, h: 180 } });
    assert.equal(run.ok, true, `${look}: ${run.reason}`);
  }
});

test('9. CHE reports which internal components made the picture', async () => {
  const run = await beachLoop(beachRecipe('a night beach with one palm tree'), { size: { w: 320, h: 180 } });
  assert.deepEqual(run.components, ['sky', 'stars', 'sun', 'ocean', 'atmosphere', 'sand', 'shoreline', 'palm', 'grade']);
});

test('10. limitations are said honestly; unknown subjects are not claimed', () => {
  const beach = RENDER_CAPABILITIES.find((c) => c.id === 'scene.beach');
  assert.ok(beach.known_limitations.some((l) => /not photographic/.test(l)));
  assert.equal(beachRecipe('a photo of my dog'), null);
  assert.equal(internalSceneIntent('make me a picture of a dog'), null, 'a dog is not something the internal renderer claims');
  assert.equal(internalSceneIntent('tell me about the beach'), null, 'talking about a beach is not a render request');
  assert.equal(internalSceneIntent('create a beach scene')?.kind, 'create');
  assert.throws(() => new Canvas(4000, 4000), /outside/);
});

test('11 + 12. a candidate renderer is tested like v1; a failing candidate is rejected, v1 keeps serving, rollback works', async () => {
  const registry = emptyRegistry();
  const v1 = await selfTest();
  assert.equal(v1.ok, true, JSON.stringify(v1.results));
  register(registry, { id: 'scene.beach', name: 'Create beach scenes' });
  for (const c of PROMOTION_CHECKS) recordCheck(registry, 'scene.beach', c, v1.results[c]);
  assert.equal(promote(registry, 'scene.beach').ok, true);
  // v2 candidate: a renderer with a bug (draws nothing) goes through the same self-test.
  const broken = async (recipe, opts) => beachLoop(recipe, { ...opts, exportPng: async (canvas) => encodePng(new Canvas(canvas.w, canvas.h)) });
  const v2 = await selfTest({ loop: broken });
  assert.equal(v2.results.functional.ok, false);
  register(registry, { id: 'scene.beach', name: 'Create beach scenes' });
  for (const c of PROMOTION_CHECKS) recordCheck(registry, 'scene.beach', c, v2.results[c]);
  const out = promote(registry, 'scene.beach');
  assert.equal(out.ok, false);
  assert.ok(out.failed.includes('functional'));
  assert.equal(serving(registry, 'scene.beach').version, 1, 'the verified v1 keeps serving');
  assert.equal(rollback(registry, 'scene.beach').cap.version, 1);
});

test('13. internal-only mode: the renderer is allowed, an external image engine is not', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); } };
  const registry = await ensureRendererCapabilities(storage);
  for (const id of ['render.procedural_image', 'scene.beach']) {
    const cap = serving(registry, id);
    assert.ok(cap, `${id} is verified`);
    for (const c of PROMOTION_CHECKS) assert.equal(cap.checks[c].ok, true, `${id} ${c}: ${cap.checks[c].evidence}`);
    assert.equal(executionAllowed(cap, { internal_only: true }).ok, true);
  }
  assert.equal((await loadRegistry(storage)).capabilities['scene.beach'].renderer_version, 1);
});

test('video frames: the same skill animates the waves; frames differ and each is a valid PNG', async () => {
  const frames = await beachFrames(beachRecipe('a beach'), { frames: 4, size: { w: 160, h: 90 } });
  assert.equal(frames.length, 4);
  const decoded = await Promise.all(frames.map(decodePng));
  assert.ok(decoded.every((d) => d.ok && d.width === 160));
  let diff = 0; for (let i = 0; i < decoded[0].rgb.length; i++) diff += Math.abs(decoded[0].rgb[i] - decoded[2].rgb[i]);
  assert.ok(diff / decoded[0].rgb.length > 0.5, 'the waves move between frames');
  assert.ok((await zlibDeflate(new Uint8Array(10))).length > 0);
});

test('video: the animation is one APNG with every frame, its size and frame rate; a damaged file is caught', async () => {
  const a = await beachAnimation(beachRecipe('a day beach'), { seconds: 1, fps: 6, size: { w: 160, h: 90 } });
  assert.deepEqual([a.facts.ok, a.facts.frames, a.facts.width, a.facts.height, a.facts.fps, a.facts.seconds], [true, 6, 160, 90, 6, 1]);
  const first = await decodePng(a.bytes);
  assert.equal(first.ok, true, 'the first frame opens as an ordinary PNG too');
  const bad = a.bytes.slice(); bad[bad.length - 30] ^= 0xff;
  assert.equal(apngFacts(bad).ok, false);
});

// ─── Through the Worker ─────────────────────────────────────────────────────

const generated = new URL('./.internal_renderer.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const saved = new Map();
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { saved.set(key, structuredClone(value)); }, delete: async (key) => saved.delete(key),
    list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls++; return { response: 'model' }; } } };
  const state = new mod.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    saved, token, send, calls: () => modelCalls,
    say: async (message) => { const before = modelCalls; const raw = await (await send('/api/chat', { message, history: [] }, token)).text(); const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; return { reply: replyFromNdjson(raw), done, model_calls: modelCalls - before }; },
  };
}

test('Worker: "create a beach scene" renders, verifies and saves to Create; variation and "how did you make that" reuse the skill', async () => {
  const che = await owner();
  const made = await che.say('Create a beach scene');
  assert.equal(made.done.source, 'che_internal_renderer');
  assert.equal(made.model_calls, 0);
  assert.match(made.reply, /my own renderer inside CHE, no external app, API or key/);
  assert.match(made.reply, /Verified: a 640 by 360 PNG/);
  const item = che.saved.get('media_index')[0];
  assert.deepEqual([item.kind, item.mime_type, item.provenance, item.source], ['image', 'image/png', 'procedural (CHE internal renderer)', 'che_internal_renderer']);
  assert.ok(!/AI-generated/i.test(JSON.stringify(item)));
  const file = await che.send(`/api/media/${item.id}/image`, null, che.token, 'GET');
  assert.equal(file.status, 200);
  assert.equal((await decodePng(new Uint8Array(await file.arrayBuffer()))).width, 640, 'the saved picture opens');
  const vary = await che.say('render that again as a sunset');
  assert.match(vary.reply, /Made the variation, sir: a sunset beach/);
  assert.equal(che.saved.get('media_index')[0].parent_id, item.id);
  assert.equal(che.saved.get('che:render_recipes').length, 2, 'both recipes kept as reusable knowledge');
  const caps = await che.say('what can your renderer do');
  assert.match(caps.reply, /I can render procedural pictures with my own code; verified .*I can create beach scenes with my own code.*not internal capabilities yet/);
  const run = che.saved.get('che:workflow_engine')?.runs?.[0];
  if (run) assert.equal(run.wf, 'media_create', 'the Workflow Engine records it under Create media');
  const how = await che.say('how did you make that');
  assert.match(how.reply, /my own renderer inside CHE, renderer version 1.*sunset beach.*Built from sky, sun, ocean/);
  assert.equal(how.model_calls, 0);
});

test('Worker: internal-only mode never sends an unknown subject to an image engine', async () => {
  const che = await owner();
  const data = che.saved.get('che') || {};
  data.capability_policy = { internal_only: true };
  che.saved.set('che', data);
  const r = await che.say('make me a picture of a dog');
  assert.equal(r.done.blocked_external, true);
  assert.match(r.reply, /Internal-only mode is on.*beach scenes/);
  assert.equal(r.model_calls, 0);
});
