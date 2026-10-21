// Owner report (2026-10-21): "CHE, tell me how my paper trading is going. Talk to me naturally, like my assistant..."
// got invented figures (12.5% returns, 3.5 trades a day, January wins, a 2.1% drawdown) from the model. These tests post
// the owner's exact words through /api/chat with a model that would invent figures. The answer must come from the
// paper journal with no model call, and no invented figure may appear.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.trading_performance_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

const FABRICATED = /12\.5\s*%|3\.5\s+trades|january|2\.1\s*%|drawdowns?\s+above\s+5/i;

async function owner(model) {
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
  const say = async (message) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    if (held && !Array.isArray(held) && held.type === undefined) return { reply: held.reply, done: held, modelCalls: calls.n - before };
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, done, modelCalls: calls.n - before };
  };
  return { say };
}

const EXACT = 'CHE, tell me how my paper trading is going. Talk to me naturally, like my assistant, not a technical report. Don’t leave out the real numbers.';
const INVENTED = 'Your paper trading is up 12.5% with about 3.5 trades a day, strong January wins, a 2.1% daily drawdown and drawdowns above 5%.';

test('the owner\'s exact message is answered from the paper journal: no model call and no invented figure', async () => {
  const che = await owner(() => INVENTED);
  const out = await che.say(EXACT);
  assert.equal(out.modelCalls, 0, 'the journal answers; the model is not asked for performance');
  assert.doesNotMatch(out.reply, FABRICATED, 'no invented figure');
  assert.match(out.reply, /closed/, 'the journal count is stated');
  assert.match(out.reply, /paper/i);
  assert.match(String(out.done.source || ''), /^che_trading/, `routed to the trading route: ${out.done.source}`);
});

test('natural performance wording reaches the journal too', async () => {
  for (const message of ['how are my paper trades doing', 'what are my paper results', 'give me my paper numbers']) {
    const che = await owner(() => INVENTED);
    const out = await che.say(message);
    assert.equal(out.modelCalls, 0, message);
    assert.doesNotMatch(out.reply, FABRICATED, message);
  }
});
