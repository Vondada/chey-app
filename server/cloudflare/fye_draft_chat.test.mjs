// FundYourEdge trade drafts through /api/chat and GET /api/trading/fye/draft (owner, 2026-10-22). A draft is stored as a
// record only: no order is sent, the reply says so, and placing an order stays refused.
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



test('"prepare a FundYourEdge MNQ long" stores a read-only draft, says nothing was sent, and invents no price', async () => {
  const che = await app();
  const out = await che.say('Prepare a FundYourEdge MNQ long 2 entry 21450 stop 21420 target 21510');
  assert.equal(out.meta.source, 'che_fye_draft');
  assert.equal(out.meta.order_sent, false);
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /NOT SUBMITTED — NO BROKER CONNECTION\./);
  assert.match(out.reply, /Account balance and buying power are unknown, and nothing was sent/);
  const res = await (await che.get('/api/trading/fye/draft')).json();
  assert.equal(res.order_sent, false);
  assert.equal(res.draft.status, 'NOT SUBMITTED — NO BROKER CONNECTION.');
  assert.equal(res.draft.rows.find((r) => r.label === 'Estimated dollar risk').value, '$120');
  assert.equal(res.draft.rows.find((r) => r.label === 'Account balance and buying power').value, 'unknown');
});

test('a place or submit request is still refused, and it stores no draft', async () => {
  const che = await app();
  const out = await che.say('Place a FundYourEdge MNQ long 1 entry 21450');
  assert.equal(out.meta.source, 'che_brokerage');
  assert.match(out.reply, /Nothing was placed/);
  const res = await (await che.get('/api/trading/fye/draft')).json();
  assert.equal(res.draft, null);
  assert.equal(res.order_sent, false);
});

test('the draft endpoint is owner-only and reads nothing before a draft exists', async () => {
  const che = await app();
  assert.equal((await (await che.get('/api/trading/fye/draft')).json()).draft, null);
  assert.equal((await che.get('/api/trading/fye/draft', '')).status, 401);
});

test('paper trading still goes to the paper journal, not a FundYourEdge draft', async () => {
  const che = await app();
  const out = await che.say('Place a paper trade for 1 MNQ long.');
  assert.notEqual(out.meta.source, 'che_fye_draft');
  assert.notEqual(out.meta.source, 'che_brokerage');
});

test('a FundYourEdge order is refused before the money hold: no yes is asked for and nothing is stored', async () => {
  const che = await app();
  const out = await che.say('Place an MNQ order on FundYourEdge');
  assert.equal(out.meta.source, 'che_brokerage');
  assert.doesNotMatch(out.reply, /Before I spend or buy anything/);
  assert.match(out.reply, /cannot place or submit an order for FundYourEdge/);
  assert.equal(che.saved.has('che:pending_owner_action'), false);
});
