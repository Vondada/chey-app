// Owner (Test 5, 2026-10-21): "create three advertisements with matching pictures" was answered with file names
// (barbershop_classic_01.png …) that were never made. These tests run the real /api/chat route with a fake image
// engine that returns real PNG bytes: the pictures are made, saved and retrievable; a failure names its number and
// reason only; no engine means nothing is claimed; the model is never asked to describe a picture.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { imageMimeFromBase64 } from './media.js';
import { pretendToolCall, requestedImageCount } from './chat_images.js';
import { inferTurnCapabilities } from './cognitive_capabilities.js';

const generated = new URL('./.chat_images.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

async function openChe(saved = new Map(), { imageEngine = true, failImageNumbers = [], imageBytes = PNG, textReply = () => 'Here are three pictures: barbershop_classic_01.png, barbershop_modern_02.png.' } = {}) {
  const calls = { image: 0, text: 0 };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const AI = {
    run: async (model, input) => {
      if (model === IMAGE_MODEL) {
        calls.image += 1;
        if (failImageNumbers.includes(calls.image)) throw new Error('engine overloaded');
        return { image: imageBytes };
      }
      calls.text += 1;
      return { response: textReply(input) };
    },
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...(imageEngine ? { AI } : {}) };
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql,
  };
  const pending = [];
  const state = new CheState({ storage, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => null)) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const get = (path, token) => worker.fetch(new Request(`https://che.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = { ...calls };
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    await Promise.allSettled(pending.splice(0));
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, media: done.media || [], imageCalls: calls.image - before.image, textCalls: calls.text - before.text };
  };
  return { say, saved, get, token, calls, state };
}

const BARBER = 'create three advertisements for my barbershop with matching pictures';
const FILENAME = /\b[\w-]+\.(?:png|jpe?g|webp|gif)\b/i;

test('the picture count is read from the request', () => {
  assert.equal(requestedImageCount('create three advertisements for my barbershop with matching pictures'), 3);
  assert.equal(requestedImageCount('make 2 posters for the shop'), 2);
  assert.equal(requestedImageCount('draw a picture of a barber chair'), 1);
  assert.equal(requestedImageCount('make 9 images'), 4, 'never more than four in one request');
});

test('the picture type comes from the bytes: PNG, JPEG and WebP are recognised; anything else is not a picture', () => {
  assert.equal(imageMimeFromBase64(PNG), 'image/png');
  assert.equal(imageMimeFromBase64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')), 'image/jpeg');
  assert.equal(imageMimeFromBase64(Buffer.from('hello world, not a picture').toString('base64')), null);
});

test('three pictures are made, saved, and returned as real media records; the reply names no file', async () => {
  const che = await openChe();
  const out = await che.say(BARBER);
  assert.equal(out.meta.source, 'che_image_generation');
  assert.equal(out.meta.model_calls, 0);
  assert.equal(out.imageCalls, 3, 'three real generations');
  assert.equal(out.textCalls, 0, 'the model is not asked to describe a picture');
  assert.equal(out.reply, 'I generated all 3 pictures and saved them to your Creation Room.');
  assert.doesNotMatch(out.reply, FILENAME, 'no file name is claimed');
  assert.equal(out.media.length, 3);
  for (const m of out.media) {
    assert.match(m.media_id, /^[0-9a-f-]{36}$/);
    assert.equal(m.mime_type, 'image/png', 'the type is verified from the bytes');
    assert.equal(m.url, `/api/media/${m.media_id}/image`);
  }
});

test('each saved picture returns its genuine bytes from the media endpoint', async () => {
  const che = await openChe();
  const out = await che.say(BARBER);
  const expected = Buffer.from(PNG, 'base64');
  for (const m of out.media) {
    const res = await che.get(m.url, che.token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
  }
});

test('a picture that fails keeps the others: the reply names its number and reason, and no file name', async () => {
  const che = await openChe(new Map(), { failImageNumbers: [2] });
  const out = await che.say(BARBER);
  assert.equal(out.media.length, 2, 'the two that worked are kept');
  assert.match(out.reply, /^I generated 2 of 3 pictures and saved the ones that worked\./);
  assert.match(out.reply, /Picture 2 failed: /);
  assert.doesNotMatch(out.reply, FILENAME);
  for (const m of out.media) assert.equal((await che.get(m.url, che.token)).status, 200);
});

test('no image engine: nothing is claimed, nothing is saved, and the owner is told what to connect', async () => {
  const che = await openChe(new Map(), { imageEngine: false });
  const out = await che.say(BARBER);
  assert.match(out.reply, /^I did not make any pictures, sir, because no image engine is connected\./);
  assert.equal(out.media.length, 0);
  assert.equal(out.imageCalls, 0);
  assert.equal(out.textCalls, 0, 'the model is never asked to invent pictures');
  assert.doesNotMatch(out.reply, FILENAME);
  assert.equal((che.saved.get('media_index') || []).length, 0);
});

test('bytes that are not a picture are refused: nothing is saved and nothing is claimed', async () => {
  const che = await openChe(new Map(), { imageBytes: Buffer.from('not a picture at all').toString('base64') });
  const out = await che.say('create a picture of a barber chair');
  assert.equal(out.media.length, 0);
  assert.match(out.reply, /^I did not generate any pictures, sir\. Nothing was saved\./);
  assert.match(out.reply, /not a PNG, JPEG or WebP picture/);
});

test('a saved picture is still there after a restart, from the same stored data', async () => {
  const saved = new Map();
  const first = await openChe(saved);
  const out = await first.say('create a picture of a barber chair');
  const restarted = await openChe(saved, { imageEngine: false });
  const res = await restarted.get(out.media[0].url, restarted.token);
  assert.equal(res.status, 200, 'the picture is retrieved after the restart, with no engine');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG, 'base64'));
});

// Owner, live iPhone 2026-10-22: "When do me a picture of a dog in this chat right now" reached the model, which printed
// {"action": "dalle.text2im", ...} instead of a picture. Everyday picture requests go to the picture engine, the reply
// carries the absolute media_url the iPhone chat shows inline, and a pretend tool call is never shown as text.
const DALLE = JSON.stringify({ action: 'dalle.text2im', action_input: JSON.stringify({ prompt: 'A friendly dog sitting in a sunny park, realistic style.' }), thought: 'I am generating an image of a dog for you now.' }, null, 2);

test('everyday picture requests are picture requests; ordinary sentences about pictures are not', () => {
  for (const ask of [
    'When do me a picture of a dog in this chat right now',
    'Can you show me a picture of a red sports car?',
    'give me two pictures of a lighthouse',
    'paint me a sunset over the ocean',
    'draw me a robot',
    'Can you send me a photo of a golden retriever puppy?',
    'I want a picture of a cabin in the snow',
  ]) assert.ok(inferTurnCapabilities(ask).includes('image_generation'), ask);
  for (const plain of [
    'take a picture of the whiteboard later',
    'what is in the picture I sent?',
    'give me the big picture on the market',
    'draw a line on the chart at the open',
    'Tell me about dogs',
  ]) assert.ok(!inferTurnCapabilities(plain).includes('image_generation'), plain);
});

test('the owner\'s dog picture is made, saved, and shown inline: media_url is absolute', async () => {
  const che = await openChe(new Map(), { textReply: () => DALLE });
  const r = await che.say('When do me a picture of a dog in this chat right now');
  assert.equal(r.meta.source, 'che_image_generation');
  assert.equal(r.textCalls, 0, 'the model is not asked');
  assert.equal(r.imageCalls, 1);
  assert.match(r.reply, /generated the picture and saved it/);
  assert.equal(r.meta.media_type, 'image');
  assert.match(r.meta.media_url, /^https:\/\/che\.example\/api\/media\/[0-9a-f-]{36}\/image$/);
  assert.equal(r.meta.media_url, `https://che.example${r.media[0].url}`);
  const image = await che.get(new URL(r.meta.media_url).pathname, che.token);
  assert.equal(image.status, 200);
  assert.doesNotMatch(r.reply, /action_input|dalle/);
});

test('a pretend picture-tool call from the model becomes a real picture made from its own prompt', async () => {
  const che = await openChe(new Map(), { textReply: () => DALLE });
  // No giving verb, so the router sends it to the model; the model answers with a pretend tool call.
  const r = await che.say('a picture of a dog please');
  assert.equal(r.meta.source, 'che_image_generation');
  assert.equal(r.imageCalls, 1);
  assert.match(r.reply, /generated the picture and saved it/);
  assert.match(r.meta.media_url, /\/api\/media\/[0-9a-f-]{36}\/image$/);
  assert.doesNotMatch(r.reply, /action_input|dalle|\{/);
});

test('a pretend tool call that is not about a picture is replaced by a plain sentence, and nothing runs', async () => {
  const che = await openChe(new Map(), { textReply: () => DALLE });
  const r = await che.say('Tell me about dogs');
  assert.equal(r.imageCalls, 0);
  assert.doesNotMatch(r.reply, /action_input|dalle|\{/);
  assert.match(r.reply, /nothing was run/);
});

test('pretendToolCall reads only replies that are wholly a tool-call object', () => {
  assert.deepEqual(pretendToolCall(DALLE), { action: 'dalle.text2im', prompt: 'A friendly dog sitting in a sunny park, realistic style.', picture: true });
  assert.equal(pretendToolCall('```json\n' + DALLE + '\n```')?.picture, true);
  assert.equal(pretendToolCall('Sure. Use {"action": "x"} in your config.'), null);
  assert.equal(pretendToolCall('{"price": 21486.25, "change": 0.42}'), null, 'a data object is not a tool call');
  assert.equal(pretendToolCall('Dogs are loyal.'), null);
  assert.equal(pretendToolCall('{"action": "search", "action_input": "weather"}')?.picture, false);
});
