// CHE's media store (owner, 2026-10-21): a picture, video or file the owner sends is kept, and "how many" is counted
// from the store. Tested directly, then through /api/chat with no model call for the store.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { listMedia, saveOwnerFile } from './media.js';
import { mediaHoldIntent, mediaSaveIntent } from './media_library.js';

const PNG = 'iVBORw0KGgo=';

function memoryStorage(saved = new Map()) {
  return {
    saved,
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
  };
}

test('a picture the owner sends is kept in the store and listed', async () => {
  const storage = memoryStorage();
  const saved = await saveOwnerFile({}, storage, { name: 'cat.png', media_type: 'image/png', base64: PNG });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(saved.item.kind, 'upload');
  assert.equal(saved.item.blob, 'do', 'no R2 bucket is bound, so the bytes sit in the Durable Object');
  assert.equal(storage.saved.get(`media:${saved.item.id}`), PNG);
  const listed = await listMedia(storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'cat.png');
  assert.equal(saved.total, 1);
});

test('a file over 1.4 MB needs the R2 bucket: refused with that reason, and nothing is stored', async () => {
  const storage = memoryStorage();
  const saved = await saveOwnerFile({}, storage, { name: 'big.mp4', media_type: 'video/mp4', base64: 'A'.repeat(1_400_004) });
  assert.equal(saved.ok, false);
  assert.match(saved.reason, /R2 bucket/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('with the R2 bucket bound, a large file is written to R2 instead', async () => {
  const writes = [];
  const env = { CHE_DATA_BUCKET: { put: async (key, bytes) => writes.push({ key, size: bytes.length }) } };
  const storage = memoryStorage();
  const saved = await saveOwnerFile(env, storage, { name: 'big.mp4', media_type: 'video/mp4', base64: 'A'.repeat(1_400_004) });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(saved.item.blob, 'r2');
  assert.equal(writes.length, 1);
  assert.match(writes[0].key, /^media\/.+\.mp4$/);
});

test('a file type CHE does not keep is refused and nothing is stored', async () => {
  const storage = memoryStorage();
  const saved = await saveOwnerFile({}, storage, { name: 'setup.exe', media_type: 'application/x-msdownload', base64: PNG });
  assert.equal(saved.ok, false);
  assert.match(saved.reason, /not one of those/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('intents: saving needs a file and a save word; "how many" counts the store and leaves video questions alone', () => {
  assert.equal(mediaSaveIntent('Save this picture', true), true);
  assert.equal(mediaSaveIntent('Save this picture', false), false, 'no file, nothing to save');
  assert.equal(mediaSaveIntent('What is in this picture?', true), false, 'a question about the picture is not a save');
  assert.equal(mediaHoldIntent('How many pictures do you hold?'), true);
  assert.equal(mediaHoldIntent('Where do you keep my photos?'), true);
  assert.equal(mediaHoldIntent('How many videos are playable?'), false, 'video questions stay with the video library');
});

// ── Through /api/chat ────────────────────────────────────────────────────────
const generated = new URL('./.media_store.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function owner({ model = () => 'Understood, sir.' } = {}) {
  const saved = new Map();
  const calls = { n: 0 };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => { calls.n += 1; return { response: model(input) }; } },
  };
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
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history: [], ...extra }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, modelCalls: calls.n - before };
  };
  return { say, saved };
}

test('chat: "Save this picture" with the file is kept by the store, with no model call and an honest reply', async () => {
  const che = await owner({ model: () => "I don't have anywhere to store pictures, sir." });
  const out = await che.say('Save this picture', { attachment: { name: 'cat.png', media_type: 'image/png', base64: PNG } });
  assert.equal(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /^Saved "cat\.png" to my media store, sir\./);
  assert.equal((che.saved.get('media_index') || []).length, 1, 'the picture is in the store index');
});

test('chat: "How many pictures do you hold?" is counted from the store, not invented', async () => {
  const che = await owner({ model: () => "I don't have anywhere to store pictures, sir." });
  await che.say('Save this picture', { attachment: { name: 'cat.png', media_type: 'image/png', base64: PNG } });
  const out = await che.say('How many pictures do you hold?');
  assert.equal(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /^I hold 1 saved file, sir\./);
  assert.match(out.reply, /- cat\.png/);
});

test('chat: an ability CHE lacks is queued for herself as a self-development job, not refused', async () => {
  const che = await owner({ model: () => "I don't have anywhere to store PDF notes in a folder, sir." });
  const out = await che.say('Can you store my PDF notes in a folder for me?');
  assert.match(out.reply, /^I am adding that ability to myself now, sir\. Job .+ is queued/);
  assert.doesNotMatch(out.reply, /don't have/);
  const jobs = (che.saved.get('che') || {}).jobs || [];
  const job = jobs.find((j) => j.kind === 'self_development' && /Add ability: Can you store my PDF notes/.test(j.title));
  assert.ok(job, 'a self-development job was queued for the ability');
  assert.equal(job.idempotency_key, 'capability:can you store my pdf notes in a folder for me');
  assert.match(out.reply, new RegExp(`Job ${job.id} is queued`));
});
