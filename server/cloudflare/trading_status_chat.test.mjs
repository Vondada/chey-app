// Owner acceptance test (PR #414, 2026-10-21): "CHE, why are there no new MNQ paper trades appearing?" went to a speculative
// Office analysis by "Partner 12" instead of the stored paper-trading records. These tests run the real /api/chat route,
// reproduce the question, and require a genuine journal and scheduler answer: five facts, no model call, no Office text.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { LIVE_FEED, LIVE_RUNS, LIVE_STATE } from './trading_live.js';
import { RECORD_PREFIX } from './trading_evidence.js';

const generated = new URL('./.trading_status_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function openChe(saved = new Map(), { model = () => 'Partner 12 suggests a speculative plan for the MNQ paper trades, sir.' } = {}) {
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
  const pending = [];
  const state = new CheState({ storage, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => null)) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = calls.n;
    const response = await send('/api/chat', { message, history: [] }, token);
    const raw = await response.text();
    await Promise.allSettled(pending.splice(0));
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, modelCalls: calls.n - before, status: response.status };
  };
  return { say, saved };
}

// Paper trading is on, the scheduler last ran cleanly, and the journal holds one closed MNQ paper trade.
function seededTrading() {
  const saved = new Map();
  saved.set(LIVE_STATE, { enabled: true });
  saved.set(LIVE_RUNS, [{ at: '2026-10-21T15:00:00.000Z', session: 'open', ok: true, bars: 40, closed: 0, entries_allowed: false,
    entry_blocker: 'New forward-paper entries require fresh authenticated and subscribed real-time CME delivery.',
    feed: { status: 'DELAYED', authenticated: false, subscription_verified: false, latency_s: 900 } }]);
  saved.set(LIVE_FEED, { status: 'DELAYED', authenticated: false, subscription_verified: false, latency_s: 900, checked_at: '2026-10-21T15:00:00.000Z', bars: [] });
  saved.set(`${RECORD_PREFIX}mnq-1`, {
    id: 'mnq-1', strategy: 'ema-pullback-5m', filter: 'any', side: 'long', environment: 'paper', net_pnl: 40, r_net: 2,
    costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 }, entry: { time: '2026-10-21T14:05:00Z', price: 21000 },
    exit: { time: '2026-10-21T14:30:00Z', reason: 'target' }, params: { target_r: 2 },
    data: { resolution: '5m', entry_feed: { status: 'DELAYED', authenticated: false, subscription_verified: false } },
  });
  return saved;
}

const EXACT = 'CHE, why are there no new MNQ paper trades appearing?';

test('the owner\'s exact question is answered from the stored journal and scheduler, in five facts, with no model call', async () => {
  const che = await openChe(seededTrading());
  const out = await che.say(EXACT);
  assert.equal(out.status, 200);
  assert.equal(out.meta.source, 'che_trading_status', 'the stored records answer, not the Office');
  assert.equal(out.modelCalls, 0, 'no model writes the answer');
  assert.match(out.reply, /^Why no new trades, sir\. From the stored paper records only/);
  for (const n of [1, 2, 3, 4, 5]) assert.match(out.reply, new RegExp(`\\b${n}\\. `), `fact ${n} is present`);
  assert.match(out.reply, /Trades: 1 distinct market entries/);
  assert.match(out.reply, /Blocked because: /);
});

test('no Office partner, plan or speculative analysis appears in the reply', async () => {
  const che = await openChe(seededTrading());
  const out = await che.say(EXACT);
  assert.doesNotMatch(out.reply, /Partner|speculative|Market Intelligence|Office|agent/i);
});

test('the same question with other wording and a wake word reaches the same answer', async () => {
  const che = await openChe(seededTrading());
  for (const message of [
    'Chay, why aren\'t any MNQ paper trades showing up?',
    'Hey CHE, why no new NQ trades today?',
    'Shay, why is paper trading not placing any trades?',
    'why haven\'t you taken any new paper trades?',
  ]) {
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_trading_status', message);
    assert.equal(out.modelCalls, 0, message);
  }
});

test('with paper trading off the answer says so and invents no trade', async () => {
  const saved = seededTrading();
  saved.set(LIVE_STATE, { enabled: false });
  const che = await openChe(saved);
  const out = await che.say(EXACT);
  assert.equal(out.meta.source, 'che_trading_status');
  assert.match(out.reply, /Paper trading is off/);
});

test('an unrelated question about trading is not taken by this route', async () => {
  const che = await openChe(seededTrading(), { model: () => 'Here is a general answer, sir.' });
  const out = await che.say('Why did the Nasdaq fall today?');
  assert.notEqual(out.meta.source, 'che_trading_status');
});
