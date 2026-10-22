// Invention Studio through /api/chat (owner, 2026-10-22): a design is planned as a project, follow-ups reopen it,
// refusals never create one, and an unrelated cost question keeps its ordinary route. The studio never calls the model.
import assert from 'node:assert/strict';

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';


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


test('"Design me an Iron Man-style suit" plans a project through chat, with no model call, and the project is saved', async () => {
  const che = await app();
  const out = await che.say('Design me an Iron Man-style suit');
  assert.equal(out.meta.source, 'che_invention_studio');
  // The concept picture goes through the existing media engine; the test engine returns no picture, so it says so.
  assert.ok(out.modelCalls <= 1, 'at most the one image-engine call; no chat model answers');
  assert.ok(out.meta.invention_id, 'the reply names the project');
  assert.match(out.reply, /Powered suit concept/);
  assert.match(out.reply, /Supplier lookup is not connected/);
  const list = await (await che.get('/api/inventions')).json();
  assert.equal(list.items[0].id, out.meta.invention_id);
  const project = await (await che.get(`/api/inventions/${out.meta.invention_id}`)).json();
  assert.equal(project.template, 'powered_suit');
  assert.equal(project.sourcing.verified_sources, 0);
  assert.equal(project.concept.status, 'not_generated', 'no picture was produced, and the record says so');
  assert.ok(project.concept.reason, 'with the reason');
});

test('the follow-up "piece by piece what it costs" reopens the same project and gives planning bands', async () => {
  const che = await app();
  const made = await che.say('Design me an Iron Man-style suit');
  const out = await che.say('Tell me piece by piece what it costs');
  assert.equal(out.meta.source, 'che_invention_studio');
  assert.equal(out.meta.invention_id, made.meta.invention_id);
  assert.match(out.reply, /Planning bands for the parts/);
  assert.equal(out.modelCalls, 0);
});

test('a weapon request is refused, and no project is created', async () => {
  const che = await app();
  const out = await che.say('Design me a suit with a missile launcher');
  assert.equal(out.meta.source, 'che_invention_studio');
  assert.match(out.reply, /I will not design weapons/);
  assert.equal((await (await che.get('/api/inventions')).json()).items.length, 0);
});

test('a cost question with no invention project is not taken by the studio', async () => {
  const che = await app();
  const out = await che.say('how much does a Netflix subscription cost');
  assert.notEqual(out.meta.source, 'che_invention_studio');
});

test('a project that does not exist is answered 404, and the list is empty before any design', async () => {
  const che = await app();
  assert.equal((await che.get('/api/inventions')).status, 200);
  assert.equal((await che.get('/api/inventions/inv-missing')).status, 404);
});

test('the Invention Studio endpoints refuse a request without the owner\'s device token', async () => {
  const che = await app();
  await che.say('Design me an Iron Man-style suit');
  const res = await che.get('/api/inventions', '');
  assert.equal(res.status, 401);
});
