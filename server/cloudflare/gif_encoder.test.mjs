// The Worker's own GIF encoder (gif_encoder.js) and the chat tool that uses it (owner_tools.js gifTurn). Certification
// run 24 (41491194768), ivg-35: an animated GIF request got an invented imgur link. The encoder is checked by an
// independent LZW decoder written here from the GIF89a spec, frame by frame, and the chat turn by fetching the stored
// file back from the media route.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { animationSpec, encodeGif, inspectGif, makeAnimation } from './gif_encoder.js';

// A plain GIF decoder: returns each frame's palette indices.
function decodeFrames(b) {
  let p = 13;
  const gct = b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0;
  p += gct;
  const frames = [];
  while (b[p] !== 0x3b) {
    if (b[p] === 0x21) { p += 2; while (b[p] !== 0) p += b[p] + 1; p += 1; continue; }
    const w = b[p + 5] | (b[p + 6] << 8); const h = b[p + 7] | (b[p + 8] << 8);
    p += 10;
    const min = b[p]; p += 1;
    const data = [];
    while (b[p] !== 0) { data.push(...b.slice(p + 1, p + 1 + b[p])); p += b[p] + 1; }
    p += 1;
    const clear = 1 << min; const end = clear + 1;
    let size = min + 1; let dict = []; let prev = null; const out = [];
    const reset = () => { dict = []; for (let i = 0; i < clear; i += 1) dict[i] = [i]; dict[clear] = []; dict[end] = []; size = min + 1; prev = null; };
    reset();
    let bit = 0;
    const read = () => { let v = 0; for (let i = 0; i < size; i += 1) { v |= ((data[(bit + i) >> 3] >> ((bit + i) & 7)) & 1) << i; } bit += size; return v; };
    for (;;) {
      const code = read();
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else throw new Error('bad code');
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === (1 << size) && size < 12) size += 1;
    }
    frames.push({ w, h, px: out.slice(0, w * h) });
  }
  return frames;
}

test('the encoder writes frames an independent decoder reads back pixel for pixel', () => {
  const width = 40; const height = 30;
  const frames = [0, 1, 2].map((k) => Uint8Array.from({ length: width * height }, (_, i) => ((i * 7 + k * 13) % 5)));
  const gif = encodeGif({ width, height, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]], frames, delayCs: 10 });
  assert.equal(String.fromCharCode(...gif.slice(0, 6)), 'GIF89a');
  const back = decodeFrames(gif);
  assert.equal(back.length, 3);
  back.forEach((f, k) => { assert.equal(f.w, width); assert.deepEqual(f.px, [...frames[k]]); });
  assert.deepEqual(inspectGif(gif), { ok: true, width, height, frames: 3, loops: true, bytes: gif.length });
  // A large frame (LZW passes 4096 codes and resets) still decodes exactly.
  const big = Uint8Array.from({ length: 200 * 200 }, (_, i) => (i * 31 + (i >> 7)) % 7);
  const gif2 = encodeGif({ width: 200, height: 200, palette: Array.from({ length: 7 }, (_, i) => [i * 30, 0, 0]), frames: [big] });
  assert.deepEqual(decodeFrames(gif2)[0].px, [...big]);
});

test('a bouncing ball rises from the floor and comes back down', () => {
  const made = makeAnimation({ shape: 'ball', motion: 'bounce', colour: 'red' });
  const frames = decodeFrames(made.bytes);
  assert.equal(frames.length, 16);
  const top = (f) => { for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) if (f.px[y * f.w + x] === 1) return y; return -1; };
  const tops = frames.map(top);
  assert.ok(tops[8] < tops[0] - 30, `the ball is highest mid-bounce: ${tops.join(',')}`);
  assert.ok(Math.abs(tops[15] - tops[1]) <= 1, 'it comes back down symmetrically');
  assert.deepEqual(animationSpec('Produce a short animated GIF of a bouncing ball and attach it.'), { shape: 'ball', motion: 'bounce', colour: 'red' });
  assert.equal(animationSpec('Make a GIF of a dancing robot'), null, 'shapes and motions it cannot draw are not claimed');
});

// Through the real /api/chat: the GIF is stored, attached and served back from the media route.
const generated = new URL('./.gif_encoder.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  };
}

test('/api/chat: a GIF request returns a stored, verified GIF that the media route serves back', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const state = new CheState({ storage: storageMap(), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, { method = 'POST', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await call('/api/pair', { body: { code: '123456' } })).json()).device_token;
  const frames = (await (await call('/api/chat', { body: { message: 'Produce a short animated GIF of a bouncing ball and attach it.', history: [] }, token })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = frames.find((f) => f.type === 'done');
  assert.equal(done.source, 'che_gif');
  assert.equal(done.media_type, 'image');
  assert.equal(done.media_retrieval, 'verified');
  assert.equal(done.execution_receipt.status, 'success');
  assert.equal(done.execution_receipt.media_id, done.media_id);
  const served = await call(`/api/media/${done.media_id}/image`, { method: 'GET', token });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/gif');
  const bytes = new Uint8Array(await served.arrayBuffer());
  assert.equal(decodeFrames(bytes).length, 16);
});
