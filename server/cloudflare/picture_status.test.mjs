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

test('each job state is answered from its record; nothing is started', () => {
  assert.match(pictureStatusReply({ words: ['blue', 'cube'] }, { jobs: JOBS }).text, /^Yes, sir: the "blue cube" picture finished \(job fc-cube\)\. It is saved in the Gallery as ID 6f04f2f8/);
  assert.match(pictureStatusReply({ words: ['dog'] }, { jobs: JOBS }).text, /^Not yet, sir: .*job fc-dog.*nothing new was started/);
  assert.match(pictureStatusReply({ words: ['racing', 'car'] }, { jobs: JOBS }).text, /^No, sir: .*failed \(job fc-car\): Modal GPU limit reached\. Nothing was saved/);
});

test('a saved Gallery item answers when no job matches; an unknown picture is never called finished', () => {
  const items = [{ id: 'b1', title: 'sunset over water', created_at: '2026-10-30T08:00:00Z' }];
  assert.match(pictureStatusReply({ words: ['sunset'] }, { jobs: JOBS, items }).text, /^Yes, sir: a "sunset" picture is saved in the Gallery as ID b1/);
  const none = pictureStatusReply({ words: ['green', 'dragon'] }, { jobs: JOBS, items });
  assert.equal(none.state, 'none');
  assert.match(none.text, /no picture job or saved picture matching "green dragon".*Nothing new was started/);
  assert.doesNotMatch(none.text, /^Yes/);
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
  const saved = new Map([['che:modal_images', [{ call_id: 'fc-cube', title: 'a blue glowing cube', state: 'saved', created_at: '2026-10-30T12:00:00Z', item: { id: '6f04f2f8' } }]]]);
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
