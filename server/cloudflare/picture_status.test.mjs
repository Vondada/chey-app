// "Did the blue cube picture finish?" is answered from the job and Gallery records, never by a model or a new job.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pictureStatusIntent, pictureStatusReply } from './picture_status.js';

const JOBS = [
  { call_id: 'fc-old', title: 'a red apple', state: 'saved', created_at: '2026-10-29T10:00:00Z', item: { id: 'aaa' } },
  { call_id: 'fc-cube', title: 'Render a 256 by 256 image of a blue cube on a white background', state: 'saved', created_at: '2026-10-30T12:00:00Z', item: { id: '6f04f2f8' } },
  { call_id: 'fc-dog', title: 'a dog on a skateboard', state: 'started', created_at: '2026-10-31T16:00:00Z' },
  { call_id: 'fc-car', title: 'a racing car', state: 'failed', created_at: '2026-10-31T15:00:00Z', error: 'Modal GPU limit reached' },
];

test('picture-status questions are recognized, with the words that name the picture', () => {
  assert.deepEqual(pictureStatusIntent('Did the blue glowing cube picture finish?').words, ['blue', 'glowing', 'cube']);
  assert.deepEqual(pictureStatusIntent('Check the previous picture of the blue cube').words, ['blue', 'cube']);
  assert.deepEqual(pictureStatusIntent("How's the dog picture coming?").words, ['dog']);
  assert.ok(pictureStatusIntent('Is my image done yet?'));
  for (const not of ['Make a picture of a blue cube', 'Show me my latest picture', 'What is a render farm?', 'Did you finish the report?'])
    assert.equal(pictureStatusIntent(not), null, not);
});

const CUBE = { id: '6f04f2f8', kind: 'image', mime_type: 'image/png', title: 'blue cube', created_at: '2026-10-30T12:01:00Z' };

test('each job state is answered from its record; nothing is started', () => {
  assert.match(pictureStatusReply({ words: ['blue', 'cube'] }, { jobs: JOBS, items: [CUBE] }).text, /^Yes, sir: the "blue cube" picture finished \(job fc-cube\)\. It is saved in the Gallery as ID 6f04f2f8/);
  assert.match(pictureStatusReply({ words: ['dog'] }, { jobs: JOBS }).text, /^Not yet, sir: .*job fc-dog.*nothing new was started/);
  assert.match(pictureStatusReply({ words: ['racing', 'car'] }, { jobs: JOBS }).text, /^No, sir: .*failed \(job fc-car\): Modal GPU limit reached\. Nothing was saved/);
});

test('a saved Gallery item answers when no job matches; an unknown picture is never called finished', () => {
  const items = [{ id: 'b1', kind: 'image', mime_type: 'image/png', title: 'sunset over water', created_at: '2026-10-30T08:00:00Z' }];
  assert.match(pictureStatusReply({ words: ['sunset'] }, { jobs: JOBS, items }).text, /^Yes, sir: a "sunset" picture is saved in the Gallery as ID b1/);
  const none = pictureStatusReply({ words: ['green', 'dragon'] }, { jobs: JOBS, items });
  assert.equal(none.state, 'none');
  assert.match(none.text, /no picture job or saved picture matching "green dragon".*Nothing new was started/);
  assert.doesNotMatch(none.text, /^Yes/);
});

// Codex review on PR #806: three ways the first version reported the wrong picture.
test('only pictures count, the newest record wins, and a deleted picture is not called saved', () => {
  // A saved video or an uploaded file is not a picture.
  const video = { id: 'v1', kind: 'video', mime_type: 'video/mp4', title: 'a sunset', created_at: '2026-10-31T09:00:00Z' };
  const pdf = { id: 'u1', kind: 'upload', mime_type: 'application/pdf', title: 'sunset notes', created_at: '2026-10-31T09:00:00Z' };
  const onlyOthers = pictureStatusReply({ words: ['sunset'] }, { jobs: [], items: [video, pdf] });
  assert.equal(onlyOthers.state, 'none');
  assert.equal(onlyOthers.media_id, undefined);
  assert.equal(pictureStatusReply({ words: [] }, { jobs: [], items: [video] }).state, 'none');

  // An old failed Modal job, then a newer picture saved by another engine: the newer picture answers.
  const oldFail = { call_id: 'fc-1', title: 'a lighthouse', state: 'failed', created_at: '2026-10-30T10:00:00Z', error: 'timeout' };
  const newer = { id: 'w1', kind: 'image', mime_type: 'image/png', title: 'a lighthouse', engine: 'workers-ai', created_at: '2026-10-31T10:00:00Z' };
  const latest = pictureStatusReply({ words: [] }, { jobs: [oldFail], items: [newer] });
  assert.equal(latest.state, 'saved');
  assert.equal(latest.media_id, 'w1');
  // The other way round, the newer failed job answers.
  assert.equal(pictureStatusReply({ words: ['lighthouse'] }, { jobs: [{ ...oldFail, created_at: '2026-10-31T11:00:00Z' }], items: [newer] }).state, 'failed');

  // A finished job whose picture was deleted from the Gallery.
  const gone = pictureStatusReply({ words: ['blue', 'cube'] }, { jobs: JOBS, items: [] });
  assert.equal(gone.state, 'removed');
  assert.match(gone.text, /finished \(job fc-cube\).*no longer in the Gallery \(ID 6f04f2f8 was removed\)/);
  assert.equal(gone.media_id, undefined);
});

test('through the real /api/chat: the question reaches che_picture_status with no model call', async () => {
  const { readFileSync, unlinkSync, writeFileSync } = await import('node:fs');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  const gen = new URL('./.picture_status.test.generated.mjs', import.meta.url);
  writeFileSync(gen, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'));
  let mod;
  try { mod = await import(gen.href); } finally { try { unlinkSync(gen); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const saved = new Map([['che:modal_images', [{ call_id: 'fc-cube', title: 'a blue glowing cube', state: 'saved', created_at: '2026-10-30T12:00:00Z', item: { id: '6f04f2f8' } }]], ['media_index', [{ id: '6f04f2f8', kind: 'image', mime_type: 'image/png', title: 'a blue glowing cube', created_at: '2026-10-30T12:01:00Z' }]]]);
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : structuredClone(saved.get(k))),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k), list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([x]) => x.startsWith(prefix))),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  };
  let models = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { models += 1; return { response: 'It finished.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (p, b, t = '') => worker.fetch(new Request(`https://che.example${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }), env);
  try {
    const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
    for (const [message, expected] of [['Did the blue glowing cube picture finish?', /^Yes, sir: .*saved in the Gallery as ID 6f04f2f8/], ['Is my image of a dragon done yet?', /no picture job or saved picture matching "dragon"/]]) {
      const frames = (await (await post('/api/chat', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(frames.find((f) => f.type === 'done').source, 'che_picture_status', message);
      assert.match(frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), expected);
    }
    assert.equal(models, 0);
  } finally { globalThis.fetch = original; }
});
