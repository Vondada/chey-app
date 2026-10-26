// CHE brings saved media up IN THE CHAT (owner, 2026-10-26): a retrieval answer carries the media fields the phone shows
// and taps: the media URL, a video's thumbnail, the target room and the item ID. Each query below runs through the real
// /api/chat against records in the real media store, and each returned URL is fetched through the Worker's own media
// route. A query counts as correct only when the right item is in the payload AND its bytes come back from that route.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// The first 32 bytes of an MP4 ("ftyp" box, brand isom), enough for the Worker's type check and its MP4 route.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]).toString('base64');

const generated = new URL('./.chat_media_retrieval.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function app(saved = new Map()) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => ({ response: 'Understood, sir.' }) },
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
  // The done line of a reply, with its media fields. Text is the streamed deltas or the done message.
  const say = async (message) => {
    const raw = await (await send('POST', '/api/chat', { message, history: [] }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done };
  };
  return { say, send, token, saved, storage };
}

// Seeds the store as the Worker writes it. Two videos (one with a saved thumbnail, one without), two pictures.
function seedStore(saved) {
  const videoWithThumb = { id: '11111111-0000-4000-8000-000000000001', root_id: '11111111-0000-4000-8000-000000000001', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'Harbour at dawn', created_at: '2026-10-23T10:00:00.000Z', blob: 'do', thumbnail_media_id: '11111111-0000-4000-8000-0000000000aa', verified: true };
  const thumb = { id: '11111111-0000-4000-8000-0000000000aa', root_id: '11111111-0000-4000-8000-0000000000aa', parent_id: videoWithThumb.id, kind: 'image', mode: 'thumbnail', mime_type: 'image/png', title: 'Thumbnail for Harbour at dawn', created_at: '2026-10-23T10:00:00.000Z', blob: 'do' };
  const videoNoThumb = { id: '22222222-0000-4000-8000-000000000002', root_id: '22222222-0000-4000-8000-000000000002', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'Night market', created_at: '2026-10-22T10:00:00.000Z', blob: 'do', verified: true };
  const upload = { id: 'a1b2c3d4-0000-4000-8000-000000000003', kind: 'upload', mime_type: 'image/png', title: 'cat.png', created_at: '2026-10-21T12:00:00.000Z', source: 'owner', blob: 'do' };
  const made = { id: 'f9e8d7c6-0000-4000-8000-000000000004', root_id: 'f9e8d7c6-0000-4000-8000-000000000004', mode: 'new', title: 'a lighthouse at dusk', prompt: 'a lighthouse at dusk', engine: 'CHE image engine', mime_type: 'image/png', version: 1, created_at: '2026-10-20T09:00:00.000Z', blob: 'do' };
  saved.set('media_index', [videoWithThumb, thumb, videoNoThumb, upload, made]);
  saved.set(`media:${videoWithThumb.id}`, MP4);
  saved.set(`media:${videoNoThumb.id}`, MP4);
  saved.set(`media:${thumb.id}`, PNG);
  saved.set(`media:${upload.id}`, PNG);
  saved.set(`media:${made.id}`, PNG);
  return { videoWithThumb, thumb, videoNoThumb, upload, made };
}

// The media a reply carries, as the phone reads it: the single media fields plus the library list, by ID.
function mediaOf(meta) {
  const out = new Map();
  if (meta.media_id) out.set(meta.media_id, { id: meta.media_id, type: meta.media_type, url: meta.media_url, thumbnail_url: meta.thumbnail_url || null, room: meta.target_room || null });
  for (const m of meta.media || []) out.set(m.media_id, { id: m.media_id, type: m.media_type, url: m.media_url, thumbnail_url: m.thumbnail_url || null, room: m.target_room || null });
  return out;
}

// A payload is visible only when its URL really returns the stored bytes from the Worker's own media route.
async function fetchesVisible(che, url, type) {
  if (!url) return false;
  const res = await che.send('GET', new URL(url).pathname, undefined, che.token);
  if (res.status !== 200) return false;
  const contentType = res.headers.get('Content-Type') || '';
  return type === 'video' ? contentType === 'video/mp4' : contentType === 'image/png';
}

// Each query: the owner's words, the items that must come back (with a visible payload), and what else to check.
const QUERIES = [
  { q: 'show my saved videos', want: ['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002'], thumbs: ['11111111-0000-4000-8000-000000000001'] },
  { q: 'list my videos', want: ['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002'], thumbs: ['11111111-0000-4000-8000-000000000001'] },
  { q: 'CHE, show me my latest video', want: ['11111111-0000-4000-8000-000000000001'], thumbs: ['11111111-0000-4000-8000-000000000001'] },
  { q: 'open my video library', want: ['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002'], thumbs: ['11111111-0000-4000-8000-000000000001'] },
  { q: 'open video 22222222-0000-4000-8000-000000000002 in my Creation Room', want: ['22222222-0000-4000-8000-000000000002'], room: 'creation' },
  { q: 'open video 11111111-0000-4000-8000-000000000001 in my Creation Room', want: ['11111111-0000-4000-8000-000000000001'], thumbs: ['11111111-0000-4000-8000-000000000001'], room: 'creation' },
  // The newest stored picture is the video's own thumbnail (a stored picture record), so that is what "last picture" returns.
  { q: 'show me the last picture', want: ['11111111-0000-4000-8000-0000000000aa'] },
  // The newest picture is a picture even though a newer-dated video exists (the open route must not return the video).
  { q: 'open my latest picture in my Creation Room', want: ['11111111-0000-4000-8000-0000000000aa'], room: 'creation' },
  { q: 'open my latest video in my Creation Room', want: ['11111111-0000-4000-8000-000000000001'], thumbs: ['11111111-0000-4000-8000-000000000001'], room: 'creation' },
  { q: 'open picture f9e8d7c6-0000-4000-8000-000000000004 in my Creation Room', want: ['f9e8d7c6-0000-4000-8000-000000000004'], room: 'creation' },
];

test('a saved video or picture is brought up in the chat with a visible payload, for each media query', async () => {
  const che = await app();
  seedStore(che.saved);
  let correct = 0;
  const misses = [];
  for (const query of QUERIES) {
    const { meta } = await che.say(query.q);
    const carried = mediaOf(meta);
    let ok = query.want.every((id) => carried.has(id));
    for (const id of query.want) {
      const item = carried.get(id);
      if (!item || !(await fetchesVisible(che, item.url, item.type))) ok = false;
      if (query.room && item?.room !== query.room) ok = false;
    }
    for (const id of query.thumbs || []) {
      const thumb = carried.get(id)?.thumbnail_url;
      if (!(await fetchesVisible(che, thumb, 'image'))) ok = false;
    }
    if (ok) correct += 1; else misses.push(`${query.q} -> ${[...carried.keys()].join(',') || 'no media'}`);
  }
  console.log(`[media-retrieval] ${correct}/${QUERIES.length} media queries returned the right item with a visible payload`);
  for (const miss of misses) console.log(`[media-retrieval] miss: ${miss}`);
  assert.deepEqual(misses, [], 'every media query returns the right item with its bytes readable through the media route');
});

test('a video in the chat carries its thumbnail URL, its video URL and the Create room as the target', async () => {
  const che = await app();
  seedStore(che.saved);
  const { meta } = await che.say('open video 11111111-0000-4000-8000-000000000001 in my Creation Room');
  assert.equal(meta.media_id, '11111111-0000-4000-8000-000000000001');
  assert.equal(meta.media_type, 'video');
  assert.equal(meta.media_url, 'https://che.example/api/media/11111111-0000-4000-8000-000000000001/video');
  assert.equal(meta.thumbnail_media_id, '11111111-0000-4000-8000-0000000000aa');
  assert.equal(meta.thumbnail_url, 'https://che.example/api/media/11111111-0000-4000-8000-0000000000aa/image');
  assert.equal(meta.target_room, 'creation');
  assert.equal(meta.open_creation, true);
  assert.equal(meta.media_title, 'Harbour at dawn');
  assert.equal(await fetchesVisible(che, meta.thumbnail_url, 'image'), true, 'the thumbnail bytes come back from the media route');
});

test('a video with no saved thumbnail is still carried and tappable, with no thumbnail URL invented', async () => {
  const che = await app();
  seedStore(che.saved);
  const { meta } = await che.say('CHE, show my saved videos');
  const night = (meta.media || []).find((m) => m.media_id === '22222222-0000-4000-8000-000000000002');
  assert.ok(night, 'the video without a thumbnail is in the library payload');
  assert.equal(night.media_type, 'video');
  assert.equal(night.media_url, 'https://che.example/api/media/22222222-0000-4000-8000-000000000002/video');
  assert.equal(night.thumbnail_url, undefined, 'no thumbnail is named when none is saved');
});

test('the library list carries only playable videos, never a picture or a record with no file', async () => {
  const che = await app();
  const { videoWithThumb, thumb, videoNoThumb } = seedStore(che.saved);
  // A video record with no stored file is listed in the answer text but is not a payload item.
  che.saved.set('media_index', [...che.saved.get('media_index'), { id: '33333333-0000-4000-8000-000000000005', kind: 'video', mime_type: 'video/mp4', title: 'Lost file', created_at: '2026-10-19T10:00:00.000Z', blob: 'do' }]);
  const { meta, reply } = await che.say('show my saved videos');
  const ids = (meta.media || []).map((m) => m.media_id);
  assert.deepEqual(ids.sort(), [videoWithThumb.id, videoNoThumb.id].sort());
  assert.ok(!ids.includes(thumb.id), 'a thumbnail picture is never a library video');
  assert.match(reply, /Lost file/, 'the answer text still names the record with no file');
});

test('a memory question returns the remembered text; a memory answer carries no media payload', async () => {
  const che = await app();
  seedStore(che.saved);
  // An owner chat turn written through the real Brain store (as chat_retrieval.test.mjs does).
  const turn = { id: 'conv:food1', kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-19', title: 'my favorite food is pizza', body: 'You said: my favorite food is pizza\nCHE answered: Noted, sir.', verification: 'owner_attested', source: { kind: 'owner_chat', full_text: true }, links: [], created_at: '2026-10-19T09:00:00.000Z' };
  new CheBrainStore(che.storage).apply({ op_id: 'fx-chat-food', type: 'put', record: turn }, { origin: 'owner' });
  const { meta, reply } = await che.say('What is my favorite food?');
  assert.match(reply, /pizza/, 'the remembered fact is in the answer');
  assert.equal(mediaOf(meta).size, 0, 'a memory answer carries no media payload');
});
