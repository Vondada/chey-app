#!/usr/bin/env node
// Headless check of Live Studio lip sync (assets/characters/app/studio.html) in real Chromium with WebGL.
//
//   node tools/studio_lipsync_check.mjs
//
// No bundled model has face shape keys (the crew GLBs have none), so this check builds a tiny test GLB by hand:
// one triangle with the morph targets mouth_open, smile, blink_l and blink_r, named the way the MPFB2 full-body export
// names them. It proves the page drives those morph targets; it does NOT test the real full-body character.
// It reads the influences three.js really set on the mesh (window.CHE.face()) and checks that:
//   - the page reports the mouth shape key it found;
//   - mouth cues move mouth_open over time (wide cue open, closed cue shut) and stop_speaking returns it to 0;
//   - an amplitude envelope moves it, and it returns to 0 by itself when the envelope ends;
//   - automatic blinking moves blink_l and blink_r;
//   - a model without a mouth shape key is refused with ok:false and a plain note, including the bundled crew che.glb.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page_url = pathToFileURL(path.join(root, 'assets/characters/app/studio.html')).href;

/** A one-triangle GLB; `targets` names its morph targets (each moves the triangle's vertices). */
export function tinyGlb(targets) {
  const base = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const arrays = [base, ...targets.map((_, k) => [0, 0, 0.1 * (k + 1), 0, 0.1, 0, 0.1, 0, 0])];
  const bin = Buffer.alloc(arrays.length * 36);
  arrays.forEach((a, k) => a.forEach((v, j) => bin.writeFloatLE(v, k * 36 + j * 4)));
  const range = (a) => ({ min: [0, 1, 2].map((i) => Math.min(a[i], a[i + 3], a[i + 6])), max: [0, 1, 2].map((i) => Math.max(a[i], a[i + 3], a[i + 6])) });
  const json = {
    asset: { version: '2.0', generator: 'CHE studio_lipsync_check (test fixture)' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'face' }],
    meshes: [{
      name: 'face',
      primitives: [{ attributes: { POSITION: 0 }, ...(targets.length ? { targets: targets.map((_, k) => ({ POSITION: k + 1 })) } : {}) }],
      ...(targets.length ? { weights: targets.map(() => 0), extras: { targetNames: targets } } : {}),
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: arrays.map((_, k) => ({ buffer: 0, byteOffset: k * 36, byteLength: 36 })),
    accessors: arrays.map((a, k) => ({ bufferView: k, componentType: 5126, count: 3, type: 'VEC3', ...range(a) })),
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4);
  return Buffer.concat([head, jh, js, bh, bin]);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.__msgs = [];
    window.CheBridge = { postMessage: (s) => window.__msgs.push(JSON.parse(s)) };
  });
  await page.goto(page_url);
  const waitMsg = async (pred, ms = 5000) => {
    const h = await page.waitForFunction((src) => window.__msgs.find(new Function('m', `return (${src})(m)`)), pred.toString(), { timeout: ms });
    return h.jsonValue();
  };
  const ready = await waitMsg((m) => m.type === 'page_ready');
  check('page ready with WebGL', ready.webgl === true);

  const command = async (cmd) => {
    await page.evaluate(() => { window.__msgs = []; });
    await page.evaluate((c) => window.CHE.view(c), cmd);
    return waitMsg((m) => m.type === 'done');
  };
  const load = async (glb) => {
    await page.evaluate(() => { window.__msgs = []; });
    await page.evaluate(([b64]) => window.CHE.loadModel(b64, { label: 'test triangle' }), [glb.toString('base64')]);
    return waitMsg((m) => m.type === 'model' || m.type === 'error');
  };
  const face = () => page.evaluate(() => window.CHE.face());
  const sample = async (ms, every = 40) => {
    const out = []; const t0 = Date.now();
    while (Date.now() - t0 < ms) { out.push({ t: Date.now() - t0, ...(await face()) }); await page.waitForTimeout(every); }
    return out;
  };

  // 1. A model with face shape keys.
  const m1 = await load(tinyGlb(['mouth_open', 'smile', 'blink_l', 'blink_r']));
  check('model reports its shape keys', m1.type === 'model' && m1.mouth_morph === 'mouth_open' && m1.blink === true, JSON.stringify({ morphs: m1.morphs, mouth_morph: m1.mouth_morph, blink: m1.blink }));
  await command({ action: 'blink', on: false }); // keep the mouth samples free of blink frames

  // 2. Mouth cues: wide open, closed, open, then stop_speaking part-way.
  const cues = [
    { start: 0, end: 0.4, value: 'D' }, { start: 0.4, end: 0.8, value: 'A' }, { start: 0.8, end: 1.2, value: 'C' },
    { start: 1.2, end: 1.6, value: 'X' }, { start: 1.6, end: 6, value: 'D' },
  ];
  const d1 = await command({ action: 'lipsync', cues });
  check('lipsync cues accepted, note names the real shape key', d1.ok === true && /mouth_open/.test(d1.note) && d1.mouth_morph === 'mouth_open', d1.note);
  const s1 = await sample(2200);
  const at = (a, b) => s1.filter((s) => s.t >= a && s.t < b).map((s) => s.mouth);
  const peak1 = Math.max(...at(150, 380)), shut = Math.min(...at(550, 780)), peak2 = Math.max(...at(950, 1180));
  const distinct = new Set(s1.map((s) => s.mouth.toFixed(3))).size;
  check('mouth_open opens on a wide cue', peak1 > 0.6, `peak ${peak1.toFixed(3)} (D target 0.85)`);
  check('mouth_open closes on a closed cue', shut < 0.05, `min ${shut.toFixed(3)}`);
  check('mouth_open reopens and changes over time', peak2 > 0.35 && distinct >= 8, `peak ${peak2.toFixed(3)}, ${distinct} distinct values`);
  check('smile moves lightly on wide shapes', Math.max(...s1.map((s) => s.smile)) > 0.05 && Math.max(...s1.map((s) => s.smile)) < 0.3, `max smile ${Math.max(...s1.map((s) => s.smile)).toFixed(3)}`);
  const stopDone = await command({ action: 'stop_speaking' });
  await page.waitForTimeout(600);
  const rest = await face();
  check('stop_speaking returns the mouth to rest', stopDone.ok === true && rest.mouth === 0 && rest.smile === 0 && rest.speaking === false, `${stopDone.note} mouth ${rest.mouth}, smile ${rest.smile}`);

  // 3. Amplitude envelope that ends on its own.
  const values = Array.from({ length: 30 }, (_, i) => Math.abs(Math.sin(i / 3)));
  const d2 = await command({ action: 'lipsync', envelope: { rate_hz: 30, values } });
  check('amplitude envelope accepted', d2.ok === true && /amplitude/.test(d2.note), d2.note);
  const s2 = await sample(1000);
  const e = s2.map((s) => s.mouth);
  check('envelope moves mouth_open', Math.max(...e) > 0.4 && new Set(e.map((v) => v.toFixed(3))).size >= 6, `max ${Math.max(...e).toFixed(3)}`);
  await page.waitForTimeout(800);
  const rest2 = await face();
  check('mouth returns to 0 when the envelope ends', rest2.mouth === 0 && rest2.speaking === false, `mouth ${rest2.mouth}`);

  // 4. Automatic blinking (2 to 6 seconds apart).
  await command({ action: 'blink', on: true });
  const s3 = await sample(7500, 15);
  const blinkPeak = Math.max(...s3.map((s) => Math.max(s.blink_l, s.blink_r)));
  check('auto-blink moves blink_l and blink_r', blinkPeak > 0.5, `peak ${blinkPeak.toFixed(3)}`);

  // 5. Bad input and a model with no mouth shape key are refused.
  const bad = await command({ action: 'lipsync', cues: [{ start: 1, end: 0.5, value: 'Q' }] });
  check('malformed cues refused', bad.ok === false, bad.note);
  const m2 = await load(tinyGlb([]));
  check('model without shape keys loads', m2.type === 'model' && m2.mouth_morph === null && m2.blink === false);
  const d3 = await command({ action: 'lipsync', cues });
  check('no mouth shape key: refused with a plain note', d3.ok === false && /no mouth_open shape key/.test(d3.note), d3.note);
  const d4 = await command({ action: 'blink', on: true });
  check('no blink shape keys: refused', d4.ok === false, d4.note);

  // 6. The bundled crew model CHE really ships (assets/characters/crew/che.glb) has no face shape keys: refused honestly.
  const { readFileSync } = await import('node:fs');
  const m3 = await load(readFileSync(path.join(root, 'assets/characters/crew/che.glb')));
  const d5 = m3.type === 'model' ? await command({ action: 'lipsync', cues }) : { ok: null, note: m3.message };
  check('bundled crew che.glb: no mouth shape key, refused', m3.type === 'model' && m3.mouth_morph === null && d5.ok === false, `${(m3.morphs || []).length} shape keys; ${d5.note}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed. Tested on a hand-built one-triangle GLB, not the real full-body character.`);
process.exit(failed ? 1 : 0);
