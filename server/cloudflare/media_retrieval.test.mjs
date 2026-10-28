// CHE's media retrieval (owner, 2026-10-21): the saved media store is listed from its real records, each file is read
// back before it is called retrievable, and "show me the last picture" returns the picture itself. Through /api/chat,
// with no model call for the store, and across a restart of the Durable Object.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { mediaHoldIntent, mediaOpenIntent, mediaShowLatestIntent } from './media_library.js';

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const generated = new URL('./.media_retrieval.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// One running CHE over a storage map that survives "restarts": a new CheState on the same map is a restarted Worker.
async function app(saved = new Map()) {
  const calls = { n: 0 };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls.n += 1; return { response: 'Understood, sir.' }; } },
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
  const send = (method, path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const token = (await (await send('POST', '/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = calls.n;
    const raw = await (await send('POST', '/api/chat', { message, history: [], ...extra }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, modelCalls: calls.n - before };
  };
  const get = (path, withToken = token) => send('GET', path, undefined, withToken);
  return { say, get, token, saved, calls, send };
}

const OWNER_REQUEST = 'CHE, list every saved media item by its actual ID, filename, type, and creation date. Tell me which are uploads and which were generated. Verify that my latest PNG is still stored.';

// Seeds the store the way the Worker writes it: an owner upload and a generated picture, each with its bytes.
function seedStore(saved, { uploadBytes = PNG, generatedBytes = PNG, uploadAt = '2026-10-21T12:00:00.000Z' } = {}) {
  const upload = { id: 'a1b2c3d4-0000-4000-8000-000000000001', kind: 'upload', mime_type: 'image/png', title: 'cat.png', created_at: uploadAt, source: 'owner', blob: 'do' };
  const made = { id: 'f9e8d7c6-0000-4000-8000-000000000002', root_id: 'f9e8d7c6-0000-4000-8000-000000000002', mode: 'new', title: 'a lighthouse at dusk', prompt: 'a lighthouse at dusk', engine: 'CHE image engine', mime_type: 'image/png', version: 1, created_at: '2026-10-20T09:00:00.000Z', blob: 'do' };
  saved.set('media_index', [upload, made]);
  if (uploadBytes) saved.set(`media:${upload.id}`, uploadBytes);
  if (generatedBytes) saved.set(`media:${made.id}`, generatedBytes);
  return { upload, made };
}

test('the owner\'s exact request lists every saved record with its ID, filename, type, date and category, and verifies the latest PNG', async () => {
  const che = await app();
  const { upload, made } = seedStore(che.saved);
  const out = await che.say(OWNER_REQUEST);
  assert.equal(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0, 'the store answers; the model is never asked');
  assert.match(out.reply, /^I hold 2 saved media records, sir: 1 owner upload and 1 generated\. 2 of 2 can be retrieved/);
  assert.match(out.reply, new RegExp(`"cat\\.png" · ID ${upload.id} · image/png · created 2026-10-21 · upload · stored, bytes verified`));
  assert.match(out.reply, new RegExp(`"a lighthouse at dusk" · ID ${made.id} · image/png · created 2026-10-20 · generated · stored, bytes verified`));
  assert.match(out.reply, new RegExp(`Your latest PNG is "cat\\.png", sir: ID ${upload.id}, image/png, created 2026-10-21, upload\\. Its stored bytes are present and verified\\.`));
  assert.doesNotMatch(out.reply, /media:|blob_key|R2|CHE_DATA_BUCKET|storage key/i, 'no storage keys or credentials in the answer');
});

test('the same request with a generated picture missing its bytes says so, and does not call it retrievable', async () => {
  const che = await app();
  seedStore(che.saved, { generatedBytes: null });
  const out = await che.say(OWNER_REQUEST);
  assert.match(out.reply, /^I hold 2 saved media records, sir: 1 owner upload and 1 generated\. 1 of 2 can be retrieved/);
  assert.match(out.reply, /not retrievable: its file is not in my storage/);
});

test('"show me the last picture" returns the real image: the bytes are read back, served at its URL, and identical to the stored PNG', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved);
  const out = await che.say('show me the last picture');
  assert.equal(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.meta.media_id, upload.id);
  assert.equal(out.meta.media_type, 'image');
  assert.equal(out.meta.media_url, `https://che.example/api/media/${upload.id}/image`);
  const image = await che.get(`/api/media/${upload.id}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG, 'base64'));
});

test('a picture whose bytes are missing is not shown: no image URL is given and the reply names the failure', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved, { uploadBytes: null });
  const out = await che.say('show me the last picture');
  assert.equal(out.meta.media_url, undefined, 'no image is attached for a picture that cannot be read back');
  assert.equal(out.meta.ok, false);
  assert.match(out.reply, new RegExp(`I could not show your latest picture, sir: "cat\\.png" \\(ID ${upload.id}\\) is not retrievable: its file is not in my storage\\.`));
});

test('the image URL refuses a request without the owner\'s device token', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved);
  const res = await che.get(`/api/media/${upload.id}/image`, '');
  assert.equal(res.status, 401);
});

test('the Creation Room list carries the uploads and the generated pictures, with their real kinds', async () => {
  const che = await app();
  const { upload, made } = seedStore(che.saved);
  const res = await che.get('/api/media');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items.map((item) => [item.id, item.kind ?? 'generated']), [[upload.id, 'upload'], [made.id, 'generated']]);
});

test('save → retrieve → restart → retrieve: the same stored record is found and its image is served after a restart', async () => {
  const first = await app();
  const saved = await first.say('Save this picture', { attachment: { name: 'cat.png', media_type: 'image/png', base64: PNG } });
  assert.match(saved.reply, /^Saved "cat\.png" to my media store, sir\./);
  const [record] = first.saved.get('media_index');
  assert.equal(record.kind, 'upload');

  const before = await first.say(OWNER_REQUEST);
  assert.match(before.reply, new RegExp(`ID ${record.id} · image/png · created .* · upload · stored, bytes verified`));

  const restarted = await app(first.saved);
  const after = await restarted.say(OWNER_REQUEST);
  assert.match(after.reply, new RegExp(`ID ${record.id} · image/png`));
  assert.match(after.reply, /Your latest PNG is "cat\.png"/);
  const shown = await restarted.say('show me the last picture');
  assert.equal(shown.meta.media_id, record.id);
  const image = await restarted.get(`/api/media/${record.id}/image`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG, 'base64'));
});

test('intents: natural media-library wording reaches the store; questions about a picture or PDF do not', () => {
  for (const message of [
    OWNER_REQUEST,
    'Show me every saved picture and whether it is still stored.',
    'Which files do you have stored for me?',
    'Do you still have my latest PNG?',
    'Where do you keep my photos?',
    'Verify my latest picture is still there.',
    'How many pictures do you hold?',
  ]) assert.equal(mediaHoldIntent(message), true, message);
  for (const message of [
    'How many videos are playable?',
    'Show me my latest video.',
    'What is in this picture?',
    'Can you store my PDF notes in a folder for me?',
    'Save this picture',
    'Make a picture of a lighthouse.',
  ]) assert.equal(mediaHoldIntent(message), false, message);
  assert.equal(mediaShowLatestIntent('show me the last picture'), true);
  assert.equal(mediaShowLatestIntent('show me my latest PNG'), true);
  assert.equal(mediaShowLatestIntent('show me my latest video'), false, 'video goes to the video library');
  assert.equal(mediaShowLatestIntent('What is the latest picture about?'), false, 'a question is not a request to show it');
});

// Owner, 2026-10-22: "open this same picture in my Creation Room" after a saved picture was shown. The picture is the one
// the message names, else the one the chat showed last (last_media_id from the phone), else the newest saved picture.
test('"open this same picture in my Creation Room" opens the picture the chat showed last, with no model call', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved);
  const out = await che.say('open this same picture in my Creation Room', { last_media_id: upload.id });
  assert.equal(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0, 'the store opens the picture; the model is never asked');
  assert.equal(out.meta.open_creation, true);
  assert.equal(out.meta.media_id, upload.id);
  assert.equal(out.meta.media_type, 'image');
  assert.equal(out.meta.media_url, `https://che.example/api/media/${upload.id}/image`);
  assert.equal((await che.get(`/api/media/${upload.id}/image`)).status, 200, 'the file the phone opens is served');
});

test('a named media ID opens that exact saved picture, in any wording that names the Creation Room', async () => {
  const che = await app();
  const { made } = seedStore(che.saved);
  const out = await che.say(`open media ${made.id} in my Creation Room`);
  assert.equal(out.meta.open_creation, true);
  assert.equal(out.meta.media_id, made.id);
  assert.match(out.reply, new RegExp(`Opening "a lighthouse at dusk" \\(ID ${made.id}\\) in your Creation Room, sir\\.`));
});

test('"open my latest picture in my Creation Room" opens the newest saved picture, not an older one', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved);
  const out = await che.say('open my latest picture in my Creation Room');
  assert.equal(out.meta.open_creation, true);
  assert.equal(out.meta.media_id, upload.id, 'the upload is newer than the generated picture');
});

test('an ID with no saved record is not opened, and the reply says so', async () => {
  const che = await app();
  seedStore(che.saved);
  const missing = '00000000-0000-4000-8000-00000000dead';
  const out = await che.say(`open ${missing} in my Creation Room`);
  assert.equal(out.meta.open_creation, undefined);
  assert.equal(out.meta.ok, false);
  assert.equal(out.reply, `I hold no saved picture or video with ID ${missing}, sir, so there is nothing to open in your Creation Room.`);
});

test('a saved picture whose bytes are missing is not opened in the Creation Room', async () => {
  const che = await app();
  const { upload } = seedStore(che.saved, { uploadBytes: null });
  const out = await che.say('open this same picture in my Creation Room', { last_media_id: upload.id });
  assert.equal(out.meta.open_creation, undefined);
  assert.equal(out.meta.ok, false);
  assert.match(out.reply, /I could not open ID .* in your Creation Room, sir/);
});

test('intents: opening a picture in the Creation Room is recognised; the bare room name and other questions are not', () => {
  assert.deepEqual(mediaOpenIntent('open this same picture in my Creation Room'), { id: '', latest: false });
  assert.deepEqual(mediaOpenIntent('CHE, open f9e8d7c6-0000-4000-8000-000000000002 in Creation Room'), { id: 'f9e8d7c6-0000-4000-8000-000000000002', latest: false });
  assert.deepEqual(mediaOpenIntent('open my latest picture in my Creation Room'), { id: '', latest: true });
  assert.equal(mediaOpenIntent('open the Creation Room'), null, 'the room itself is navigation, not a picture');
  assert.equal(mediaOpenIntent('what is in my Creation Room?'), null);
  assert.equal(mediaOpenIntent('open this same picture'), null, 'no room named: the existing routes answer');
});
