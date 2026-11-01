// Certification run 41256280478: a backtest ran on fetched candles but sent no execution receipt (thb-11, thb-29), a
// coin backtest was taken for Orion's crypto desk or the Nasdaq study (thb-18), and a generic look-ahead bias question
// read the study's status (thb-25). End to end through the real /api/chat, offline (stubbed market data, fake model).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { cryptoIntent } from './crypto_markets.js';
import { intelligenceIntent } from './historical_intelligence.js';
import { backtestScopeNote } from './trading_lab.js';

const DAY = 86400000;
let marketUp = true;
// Coinbase daily candles, [time s, low, high, open, close, volume], newest first; 800 days of a gentle zigzag.
function coinbaseRows(url) {
  const u = new URL(url);
  const end = Date.parse(u.searchParams.get('end') || new Date().toISOString());
  const start = Date.parse(u.searchParams.get('start') || new Date(end - 300 * DAY).toISOString());
  const floor = Date.now() - 800 * DAY;
  const rows = [];
  for (let t = end; t >= Math.max(start, floor); t -= DAY) {
    const i = Math.floor(t / DAY);
    const c = 100 + 20 * Math.sin(i / 9) + (i % 7);
    rows.push([Math.floor(t / 1000), c - 3, c + 3, c - 1, c, 10]);
  }
  return rows;
}
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (marketUp && /api\.exchange\.coinbase\.com/.test(url)) return new Response(JSON.stringify(coinbaseRows(url)), { status: 200 });
  return new Response('{"error":"offline test"}', { status: 503 });
};

const generated = new URL('./.backtest_receipt.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageMap() {
  const saved = new Map();
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  };
}

async function say(message) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'model answer' }) } };
  const state = new CheState({ storage: storageMap(), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (p, b, t = '') => worker.fetch(new Request(`https://x${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
  const frames = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const done = frames.find((f) => f.type === 'done') || {};
  return { done, reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') };
}

test('a backtest that ran carries a success receipt naming the data and span, and says what it did not run', async () => {
  marketUp = true;
  const { done, reply } = await say('Backtest a 50/200 moving average crossover on BTC from 2020 to 2024 and report the total return.');
  assert.equal(done.source, 'che_trading');
  assert.equal(done.execution_receipts?.length, 1);
  const [r] = done.execution_receipts;
  assert.equal(r.tool, 'trading_lab');
  assert.equal(r.operation, 'backtest');
  assert.equal(r.status, 'success');
  assert.ok(r.verified_response.bars > 100);
  assert.match(r.verified_response.from, /^\d{4}-\d\d-\d\d$/);
  assert.match(reply, /Backtest on BTC/);
  assert.match(reply, /not the one you asked for/);
  assert.match(reply, /You asked for 2020 to 2024; the free data I have runs from /);
  assert.match(reply, /not as a total percentage return/);
});

test('a backtest whose data did not load carries a failed receipt and no result', async () => {
  marketUp = false;
  // A coin no other test loads, so no cached candles answer for the dead source.
  const { done, reply } = await say('Backtest dogecoin');
  marketUp = true;
  assert.equal(done.ok, false);
  assert.equal(done.execution_receipts?.length, 1);
  assert.notEqual(done.execution_receipts[0].status, 'success');
  assert.equal(done.execution_receipts[0].verified_response, null);
  assert.match(reply, /did not answer/);
  assert.doesNotMatch(reply, /Backtest on/);
});

test('a backtest of a rule on a coin reaches the strategy lab, not the crypto desk or the Nasdaq study', async () => {
  const q = 'Run a backtest of buying ETH daily when RSI is below 30, since 2021, and give the trade count.';
  assert.equal(cryptoIntent(q), null);
  assert.equal(intelligenceIntent(q), null);
  const { done, reply } = await say(q);
  assert.equal(done.source, 'che_trading');
  assert.equal(done.execution_receipts?.[0]?.status, 'success');
  assert.match(reply, /Backtest on ETH/);
  assert.match(reply, /not the one you asked for/);
  // The desk and the study keep their own questions.
  assert.ok(cryptoIntent('how is the crypto desk doing'));
  assert.ok(cryptoIntent('backtest results on orion crypto desk'));
  assert.ok(intelligenceIntent('run the historical NQ backtest since 2008'));
});

test('a generic look-ahead bias question is a method question; one about CHE\'s study still reads it', () => {
  assert.equal(intelligenceIntent('How do you avoid look-ahead bias when using earnings data in a backtest?'), null);
  assert.ok(intelligenceIntent('Did you check your strategy tests for look-ahead bias?'));
  assert.ok(intelligenceIntent("Is CHE's backtest free of look-ahead leakage?"));
});

test('the scope note is empty when the request asks only for what the run does', () => {
  const candles = [{ t: '2024-01-01T00:00:00Z' }, { t: '2026-10-31T00:00:00Z' }];
  assert.equal(backtestScopeNote('Backtest bitcoin', candles), '');
  assert.equal(backtestScopeNote('Backtest bitcoin since 2024', candles), '');
  assert.match(backtestScopeNote('Backtest bitcoin over 2008', candles), /You asked for 2008; the free data I have runs from 2024-01-01 to 2026-10-31/);
});

test('an amount is never read as a requested year (Codex review on #823)', () => {
  const candles = [{ t: '2024-01-01T00:00:00Z' }, { t: '2026-10-31T00:00:00Z' }];
  assert.doesNotMatch(backtestScopeNote('Backtest BTC with a $2000 initial account', candles), /You asked for/);
  assert.doesNotMatch(backtestScopeNote('Backtest BTC starting with 2000 dollars', candles), /You asked for/);
  assert.match(backtestScopeNote('Backtest BTC from 2020 to 2024 with a $2050 account', candles), /You asked for 2020 to 2024;/);
  assert.match(backtestScopeNote('Backtest BTC 2020-2024', candles), /You asked for 2020 to 2024;/);
  assert.match(backtestScopeNote('Backtest SPY over 2008.', candles), /You asked for 2008;/);
  assert.match(backtestScopeNote('Backtest BTC from 2020 to 2024, and report the drawdown.', candles), /You asked for 2020 to 2024;/);
  assert.equal(backtestScopeNote('Backtest bitcoin since 2024', candles), '');
});
