// Owner (iPhone, 2026-10-21): "Save this picture in your media library" with a real picture attached was refused,
// because the app labels every file "image" and saveOwnerFile accepted only exact MIME types. These tests post the exact
// payload the iPhone app sends through the real /api/chat route. The type is read from the bytes, the file is retrievable
// by its id, it survives a restart, malformed bytes are refused with nothing saved, and only the owner can read it.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.media_save.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n').toString('base64');
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]).toString('base64');
const TEXT = Buffer.from('Shopping list: oat milk, eggs, bread.\n').toString('base64');
const GARBAGE = Buffer.from('not a picture at all, just words in a file named photo.png').toString('base64');

async function openChe(saved = new Map()) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Noted.' }) } };
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const pending = [];
  const state = new CheState({ storage, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => null)) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const get = (path, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  // The exact payload the iPhone app sends with an attachment: { name, media_type, base64 }.
  const say = async (message, attachment) => {
    const body = { message, history: [], ...(attachment ? { attachment } : {}) };
    const raw = await (await send('/api/chat', body, token)).text();
    await Promise.allSettled(pending.splice(0));
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    return { reply: done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join(''), done };
  };
  const list = async () => (await (await get('/api/media', token)).json()).items;
  return { say, list, get, token, saved, send };
}

const SAVE = 'Save this picture in your media library.';

test('the exact iPhone payload (media_type "image") saves a real PNG and returns a retrievable media id', async () => {
  const che = await openChe();
  const out = await che.say(SAVE, { name: 'IMG_0001.png', media_type: 'image', base64: PNG });
  assert.match(out.reply, /^Saved "IMG_0001\.png" to my media store, sir\. I now hold 1 item there\./);
  const items = await che.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'upload');
  assert.equal(items[0].mime_type, 'image/png', 'the type comes from the bytes, not the "image" label');
  const res = await che.get(`/api/media/${items[0].id}/image`, che.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), PNG);
});

test('a saved picture is still listed and retrievable after a restart, from the same stored data', async () => {
  const saved = new Map();
  const first = await openChe(saved);
  await first.say(SAVE, { name: 'kitchen.png', media_type: 'image', base64: PNG });
  const again = await openChe(saved);
  const items = await again.list();
  assert.equal(items.length, 1);
  const res = await again.get(`/api/media/${items[0].id}/image`, again.token);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), PNG);
});

test('the file count is kept: a second save makes two, and "how many" answers from the store', async () => {
  const che = await openChe();
  await che.say(SAVE, { name: 'a.png', media_type: 'image', base64: PNG });
  const second = await che.say(SAVE, { name: 'b.jpg', media_type: 'image', base64: JPEG });
  assert.match(second.reply, /I now hold 2 items there\./);
  const count = await che.say('How many pictures do you have saved?');
  assert.match(count.reply, /^I hold 2 saved files, sir\./);
});

test('bytes that are not a picture are refused with the reason; nothing is saved and nothing is claimed', async () => {
  const che = await openChe();
  const out = await che.say(SAVE, { name: 'photo.png', media_type: 'image', base64: GARBAGE });
  assert.match(out.reply, /^I could not keep that file, sir: the file is not a picture, video, PDF or text file I can read \(sent as image\), so nothing was saved\. Nothing was saved\./);
  assert.doesNotMatch(out.reply, /Saved "/);
  assert.equal((await che.list()).length, 0);
});

test('PDFs, MP4 videos, JPEGs and text files are typed from their bytes whatever label arrives', async () => {
  const che = await openChe();
  await che.say(SAVE, { name: 'lease.pdf', media_type: 'document', base64: PDF });
  await che.say(SAVE, { name: 'clip.mov', media_type: 'video', base64: MP4 });
  await che.say(SAVE, { name: 'shot.heic', media_type: 'image/png', base64: JPEG });
  await che.say(SAVE, { name: 'list.txt', media_type: 'document', base64: TEXT });
  const types = (await che.list()).map((item) => item.mime_type).sort();
  assert.deepEqual(types, ['application/pdf', 'image/jpeg', 'text/plain', 'video/mp4']);
});

test('a picture label on text bytes is refused: the label is checked against the bytes', async () => {
  const che = await openChe();
  const out = await che.say(SAVE, { name: 'notes.png', media_type: 'image', base64: TEXT });
  assert.match(out.reply, /I could not keep that file, sir/);
  assert.equal((await che.list()).length, 0);
});

test('saved files are owner-only: no token, no read', async () => {
  const che = await openChe();
  await che.say(SAVE, { name: 'private.png', media_type: 'image', base64: PNG });
  const [item] = await che.list();
  assert.equal((await che.get(`/api/media/${item.id}/image`)).status, 401);
});

test('an attached picture in an ordinary question is not saved (vision and screen attachments keep working)', async () => {
  const che = await openChe();
  const out = await che.say('What colour is the car in this picture?', { name: 'car.png', media_type: 'image', base64: PNG });
  assert.doesNotMatch(out.reply, /Saved "/);
  assert.equal((await che.list()).length, 0);
});
