// Owner report (2026-10-21): "CHE, tell me how my paper trading is going. Talk to me naturally, like my assistant..."
// got invented figures (12.5% returns, 3.5 trades a day, January wins, a 2.1% drawdown) from the model. These tests post
// the owner's exact words through /api/chat with a model that would invent figures. The answer must come from the
// paper journal with no model call, and no invented figure may appear.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.trading_loss_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// FIXTURE: three losing paper entries from one setup, shaped like the journal's records (labelled test data).
import { RECORD_PREFIX } from './trading_evidence.js';
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
  return { say, saved };
}

const S = 'ema-pullback-5m';
const loss = (id, at) => [`${RECORD_PREFIX}${id}`, {
  id, strategy: S, filter: 'any', side: 'long', environment: 'paper', net_pnl: -10, r_net: -1,
  costs: { spread: 1, slippage: 1, commissions: 1, fees: 0 }, gross_before_costs: -7,
  entry: { time: at, raw: 21000, fill: 21001 }, exit: { time: at, reason: 'stop' },
  data: { resolution: '5m', entry_feed: { status: 'DELAYED' } },
}];

test('the owner\'s "why are you losing" question is answered from the paper journal, with no model call and no invented figure', async () => {
  const che = await owner(() => 'Sir, I think the market is trending and you should buy more.');
  for (const [key, value] of [loss('a', '2026-10-21T14:05:00Z'), loss('b', '2026-10-21T15:05:00Z'), loss('c', '2026-10-21T16:05:00Z')]) che.saved.set(key, value);
  const t = await che.say('CHE, why are you losing so many trades?');
  assert.equal(t.done.source, 'che_trading_losses');
  assert.equal(t.modelCalls, 0, 'a loss answer is read from records, never from the model');
  assert.match(t.reply, /From the futures paper journal, 3 distinct entries, 0 won and 3 lost/);
  assert.match(t.reply, /The clearest pattern is streaks: 1 run of three or more losses in a row from one setup/);
  assert.equal(FABRICATED.test(t.reply), false);
});
