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


// The showroom through /api/chat and /api/showroom: CHE answers from the same states the cards show, examples only
// when a capability matches, and a real saved invention turns its card from a concept example into the real output.
test('"what can you create?" is answered from the showroom, with no model call and the real counts', async () => {
  const che = await app();
  const out = await che.say('CHE, what can you create?');
  assert.equal(out.meta.source, 'che_showroom');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /^I can do \d+ things across 6 groups/);
  assert.match(out.reply, /Ready now: \d+\. Partial: \d+\. Needs setup: \d+\. Unavailable: \d+\. Planned: \d+\./);
});

test('"show me an example of an animated video" answers with the matching capability and its real state', async () => {
  const che = await app();
  const out = await che.say('Show me an example of an animated video.');
  assert.equal(out.meta.source, 'che_showroom');
  assert.match(out.reply, /(Ready|Partial|Needs setup|Unavailable|Planned) \(|Concept example/);
  assert.match(out.reply, /Concept example|Real saved output|Rendered MP4/);
});

test('an unrelated "example" question is not taken by the showroom', async () => {
  const che = await app();
  const out = await che.say('Show me an example of a Python function that sorts a list.');
  assert.notEqual(out.meta.source, 'che_showroom');
});

test('the showroom endpoint lists six categories; a saved invention turns its card into the real output', async () => {
  const che = await app();
  const before = await (await che.get('/api/showroom')).json();
  assert.equal(before.categories.length, 6);
  const suitBefore = before.categories[0].capabilities.find((i) => i.id === 'suit');
  assert.equal(suitBefore.thumbnail, 'illustration');
  assert.match(suitBefore.thumbnail_note, /^Concept example/);
  await che.say('Design me an Iron Man-style suit');
  const after = await (await che.get('/api/showroom')).json();
  const suitAfter = after.categories[0].capabilities.find((i) => i.id === 'suit');
  assert.equal(suitAfter.thumbnail, 'real');
  assert.ok(suitAfter.recent_project?.id, 'it names the real saved project');
});

test('the showroom endpoint refuses a request without the owner\'s device token', async () => {
  const che = await app();
  assert.equal((await che.get('/api/showroom', '')).status, 401);
});
