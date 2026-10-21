// Owner integration failure (2026-10-21): "Open my video library. Show only actual saved MP4 files…" and
// "CHE, open Creator Studio and show my latest video." both went to the general model, which has no tool to
// read the library, and it answered that it had no tool. Replayed here through /api/chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mediaLibraryIntent, mediaLibraryReply, mediaLibraryReport, wantsLatestVideo } from './media_library.js';

const generated = new URL('./.media_library.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

export const OWNER_LIBRARY = 'Open my video library. Show only actual saved MP4 files. Tell me how many videos exist and whether any are playable.';
export const OWNER_LATEST = 'CHE, open Creator Studio and show my latest video.';

const MEDIA = [
  { id: 'vid-aaaaaaaa1', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'Launch teaser', created_at: '2026-10-21T04:00:00Z', blob: 'r2', blob_key: 'media/vid-aaaaaaaa1.mp4' },
  { id: 'vid-bbbbbbbb2', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'Lamp explainer', created_at: '2026-10-20T10:00:00Z', blob: 'do' },
  { id: 'vid-cccccccc3', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'Lost render', created_at: '2026-10-19T10:00:00Z', blob: 'r2', blob_key: 'media/vid-cccccccc3.mp4' },
  { id: 'img-dddddddd4', kind: 'image', mode: 'image', mime_type: 'image/png', title: 'Cover art', created_at: '2026-10-21T05:00:00Z', blob: 'do' },
];

async function owner(storedMedia) {
  const saved = new Map([['media_index', storedMedia], ['media:vid-bbbbbbbb2', 'AAAA']]);
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const modelCalls = [];
  const bucket = { head: async (key) => (key === 'media/vid-aaaaaaaa1.mp4' ? { size: 4096 } : null) };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_DATA_BUCKET: bucket, AI: { run: async () => { modelCalls.push(1); return { response: 'I have no tool connected to inspect saved files.' }; } } };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (p, b, tok = '') => worker.default.fetch(new Request('https://che.example' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(b) }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    modelCalls,
    say: async (message) => {
      const res = await post('/api/chat', { message, agent_mode: 'full' }, token);
      const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: res.status, reply: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') || {} };
    },
  };
}

test('owner command: "Open my video library" lists only real saved MP4 files, with counts, and never asks the model', async () => {
  const che = await owner(MEDIA);
  const { status, reply, done } = await che.say(OWNER_LIBRARY);
  console.log('LIBRARY>>>', reply);
  assert.equal(status, 200);
  assert.equal(done.source, 'che_media_library');
  assert.equal(done.media_total, 3, 'the image is not a video');
  assert.equal(done.media_playable, 2, 'the R2 video and the stored blob are playable');
  assert.match(reply, /3 saved videos/);
  assert.match(reply, /2 are playable/);
  assert.match(reply, /Lost render.*missing file/s);
  assert.doesNotMatch(reply, /no tool|cannot inspect/i);
  assert.equal(che.modelCalls.length, 0, 'the library is answered from storage, never by the model');
});

test('owner command: "show my latest video" names the newest video and whether it is playable', async () => {
  const che = await owner(MEDIA);
  const { reply, done } = await che.say(OWNER_LATEST);
  console.log('LATEST>>>', reply);
  assert.equal(done.source, 'che_media_library');
  assert.match(reply, /Launch teaser/);
  assert.doesNotMatch(reply, /Lamp explainer|Lost render/, 'only the latest is named');
  assert.equal(che.modelCalls.length, 0);
});

test('an empty library is reported as zero playable, not invented', async () => {
  const che = await owner([]);
  const { reply } = await che.say(OWNER_LIBRARY);
  assert.match(reply, /no saved videos/i);
  assert.match(reply, /None is playable/);
});

test('a generation request and a render-status question are not library requests', () => {
  assert.equal(mediaLibraryIntent('Make a 15-second faceless video about AI.'), false);
  assert.equal(mediaLibraryIntent('How is my video render going? Is it still rendering?'), false);
  assert.equal(mediaLibraryIntent(OWNER_LIBRARY), true);
  assert.equal(mediaLibraryIntent(OWNER_LATEST), true);
  assert.equal(wantsLatestVideo(OWNER_LATEST), true);
});

test('an unverifiable GitHub artifact is "not checked", never playable', async () => {
  const report = await mediaLibraryReport({}, { get: async () => null }, [
    { id: 'vid-eeeeeeee5', kind: 'video', mime_type: 'video/mp4', title: 'Archived', created_at: '2026-10-18T10:00:00Z', blob: 'github-artifact', github_artifact_id: 42, github_filename: 'video.mp4' },
  ]);
  assert.equal(report.playable, 0);
  assert.equal(report.unverified, 1);
  assert.match(mediaLibraryReply(report), /could not be checked right now/);
});
