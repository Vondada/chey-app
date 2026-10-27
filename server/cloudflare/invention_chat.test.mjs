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
  // The image model answered with no picture (the test AI returns text), so CHE drew its procedural concept sheet of
  // the project's own parts, attached it, and says which engine made it (owner, 2026-10-24: inv-8a637dad was text only).
  assert.equal(project.concept.status, 'generated');
  assert.equal(project.concept.engine, 'che_internal_renderer');
  assert.match(out.meta.media_url, new RegExp(`/api/media/${project.concept.media_id}/image$`));
  assert.match(out.reply, /Concept picture attached: a procedural concept sheet/);
  const png = new Uint8Array(await (await che.get(`/api/media/${project.concept.media_id}/image`)).arrayBuffer());
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the attached picture is a real PNG');
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

// ChatGPT live iPhone report (2026-10-22): a trading / 20-year backtest question was answered from an unrelated saved
// Invention Studio project. A follow-up reopens the invention only when it names it or continues the previous turn.
test('a saved invention never answers a 20-year Nasdaq futures backtest; an explicit reopen still resumes it', async () => {
  const che = await app();
  const made = await che.say('Design me an Iron Man-style suit');
  const history = [
    { role: 'user', content: 'Design me an Iron Man-style suit' }, { role: 'assistant', content: made.reply },
    { role: 'user', content: 'What is the weather like today?' }, { role: 'assistant', content: 'Sunny.' },
  ];
  for (const ask of [
    'Can you backtest Nasdaq futures over 20 years step by step?',
    'Break it down: how did the ORB strategy do over 20 years of Nasdaq futures?',
    'Is it realistic to backtest 20 years of MNQ data?',
    'Give me the breakdown of the 20 year backtest results',
  ]) {
    const out = await che.say(ask, { history });
    assert.notEqual(out.meta.source, 'che_invention_studio', ask);
    assert.equal(out.meta.invention_id, undefined, ask);
    assert.doesNotMatch(out.reply, /Powered suit|Planning bands|suit concept|exoskeleton/i, `${ask}: zero invention content`);
  }
  // Even straight after the invention turn, trading words win.
  const right = await che.say('Can you backtest Nasdaq futures over 20 years step by step?', { history: history.slice(0, 2) });
  assert.notEqual(right.meta.source, 'che_invention_studio');
  // A generic follow-up that is not the next turn stays out of the invention too.
  const generic = await che.say('Explain it step by step', { history });
  assert.notEqual(generic.meta.source, 'che_invention_studio');
  // An explicit reopen resumes the saved invention, and its immediate follow-up continues it.
  const reopen = await che.say('Reopen my invention and show me how it assembles', { history });
  assert.equal(reopen.meta.source, 'che_invention_studio');
  assert.equal(reopen.meta.invention_id, made.meta.invention_id);
  const next = await che.say('Where can I get the parts?', { history: [...history, { role: 'user', content: 'Reopen my invention and show me how it assembles' }, { role: 'assistant', content: reopen.reply }] });
  assert.equal(next.meta.source, 'che_invention_studio', 'the immediate follow-up continues the reopened invention');
});
