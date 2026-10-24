// Orion's crypto desk (owner master mission, 2026-10-23, Test A): "Have Orion research BTC and ETH, compare strategies,
// and continue paper trading during the weekend." Feeds, schedule, budget, journal separation, costs and the chat route.
// Exchange answers here are generated test bars served by a fake fetcher (this container cannot reach the exchanges);
// production reads the real Coinbase Exchange and Kraken endpoints, and the deploy check prints that live pass.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  COINS, CRYPTO_BUDGET, CRYPTO_COSTS, CRYPTO_RUNS, DAILY_REQUEST_LIMIT, TIMEFRAMES, backtestSeries, cryptoIntent, cryptoTick, cryptoView,
  feedStatus, fetchCoinbaseCandles, fetchKrakenCandles, marketStudy, nextCryptoTickAt, setCryptoPaper, speakCrypto,
} from './crypto_markets.js';
import { COSTS, CRYPTO_CONTRACTS, RECORD_PREFIX, newPortfolio, readTrades, settleTrade } from './trading_evidence.js';

function memoryStorage(saved = new Map()) {
  return {
    saved,
    get: async (key) => {
      if (Array.isArray(key)) return new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]));
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    put: async (key, value) => {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
  };
}

// A deterministic random walk: the same bucket always has the same bar, so overlapping requests agree.
function barAt(coin, g, startSec) {
  const base = coin === 'BTC' ? 100000 : 4000;
  let x = Math.sin(startSec / 977 + (coin === 'BTC' ? 0 : 3)) * 0.02 + Math.sin(startSec / 13331) * 0.05;
  const seed = Math.abs(Math.sin(startSec * 12.9898 + g) * 43758.5453) % 1;
  const o = base * (1 + x);
  const c = o * (1 + (seed - 0.5) * 0.004 * Math.sqrt(g / 300));
  const h = Math.max(o, c) * (1 + seed * 0.0015);
  const l = Math.min(o, c) * (1 - (1 - seed) * 0.0015);
  return [startSec, l, h, o, c, 5 + seed * 20];
}
function exchange({ now, failCoinbase = false, failKraken = false, lagBuckets = 0, calls = [] }) {
  return async (url) => {
    const u = new URL(String(url));
    calls.push(u.host);
    if (u.host === 'api.exchange.coinbase.com') {
      if (failCoinbase) return new Response('{"message":"unavailable"}', { status: 503 });
      const g = Number(u.searchParams.get('granularity'));
      const coin = u.pathname.includes('BTC') ? 'BTC' : 'ETH';
      const end = u.searchParams.get('end') ? Date.parse(u.searchParams.get('end')) : now();
      // Newest first, including the bucket still forming (the client must drop it).
      const top = Math.floor(end / 1000 / g) * g - lagBuckets * g;
      const rows = [];
      for (let i = 0; i < 300; i++) rows.push(barAt(coin, g, top - i * g));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (u.host === 'api.kraken.com') {
      if (failKraken) return new Response('{"error":["EService:Unavailable"]}', { status: 200 });
      const g = Number(u.searchParams.get('interval')) * 60;
      const coin = u.searchParams.get('pair') === 'XBTUSD' ? 'BTC' : 'ETH';
      const top = Math.floor(now() / 1000 / g) * g;
      const rows = [];
      for (let i = 30; i >= 0; i--) { const b = barAt(coin, g, top - i * g); rows.push([b[0], String(b[3]), String(b[2]), String(b[1]), String(b[4] * 1.0005), '0', String(b[5]), 10]); }
      return new Response(JSON.stringify({ error: [], result: { [COINS[coin].krakenKey]: rows, last: top } }), { status: 200 });
    }
    throw new TypeError(`offline (${u.host})`);
  };
}

const SAT = Date.parse('2026-10-24T15:00:25Z'); // a Saturday: CME is closed, crypto is not

test('Coinbase candles: newest-first rows become closed bars, oldest first; the forming bucket is dropped', async () => {
  const now = SAT;
  const bars = await fetchCoinbaseCandles('BTC', '5m', { fetcher: exchange({ now: () => now }), now });
  assert.equal(bars.length, 299, 'the bucket still forming is not a bar');
  assert.ok(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t));
  assert.ok(Date.parse(bars.at(-1).t) + 300_000 <= now);
  const k = await fetchKrakenCandles('ETH', '5m', { fetcher: exchange({ now: () => now }), now });
  assert.ok(k.length > 0 && Date.parse(k.at(-1).t) + 300_000 <= now);
  await assert.rejects(fetchCoinbaseCandles('BTC', '5m', { fetcher: exchange({ now: () => now, failCoinbase: true }), now }), /HTTP 503/);
});

test('feed status: LIVE only when the newest published bucket is present; otherwise DELAYED or DISCONNECTED', () => {
  const now = SAT;
  const mk = (startMs) => [{ t: new Date(startMs).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const newest = Math.floor((now - 20_000) / 300_000) * 300_000 - 300_000;
  assert.equal(feedStatus(mk(newest), '5m', now).status, 'LIVE');
  assert.equal(feedStatus(mk(newest - 600_000), '5m', now).status, 'DELAYED');
  assert.equal(feedStatus(mk(newest - 3_600_000), '5m', now).status, 'DISCONNECTED');
  assert.equal(feedStatus([], '5m', now).status, 'DISCONNECTED');
});

test('crypto fees: a share of the traded value, taker on the entry and maker only on a resting target', () => {
  const c = CRYPTO_CONTRACTS.BTC;
  const costs = CRYPTO_COSTS.BTC;
  const pos = { side: 'long', entry: { raw: 100000, spread: 0.5, slippage: 2 }, stop: 99500 };
  const target = settleTrade(pos, { raw: 101000, spread: 0.5, slippage: 0 }, 0.01, c, costs, 'target');
  assert.equal(target.costs.fees, Math.round((100000 * 0.006 + 101000 * 0.004) * 0.01 * 100) / 100);
  const stop = settleTrade(pos, { raw: 99500, spread: 0.5, slippage: 2 }, 0.01, c, costs, 'stop');
  assert.equal(stop.costs.fees, Math.round((100000 * 0.006 + 99500 * 0.006) * 0.01 * 100) / 100);
  // Futures settlement is unchanged: no percentage fee unless the costs carry one.
  const mnq = settleTrade({ side: 'long', entry: { raw: 20000, spread: 0.125, slippage: 0.25 }, stop: 19990 }, { raw: 20020, spread: 0.125, slippage: 0 }, 1, { tick: 0.25, pointValue: 2 }, COSTS, 'target');
  assert.equal(mnq.costs.fees, 1);
  assert.equal('takerPct' in COSTS, false, 'futures strategy versions keep their hash');
});

test('MNQ portfolios keep their exact strategy versions (crypto costs never touch the futures hash)', () => {
  const pf = newPortfolio('fvg-retest-5m', 'any', { contract: 'MNQ', resolution: '5m', params: { target_r: 2 } });
  assert.equal(pf.costs.takerPct, undefined);
  const btc = newPortfolio('fvg-retest-5m', 'any', { contract: 'BTC', qty: 0.01, resolution: '5m', costs: CRYPTO_COSTS.BTC, params: { target_r: 2 } });
  assert.notEqual(btc.strategy_version, pf.strategy_version);
});

test('a Saturday pass: real schedule, budget counted, forward-only start, nothing invented', async () => {
  const storage = memoryStorage();
  const calls = [];
  // Nothing runs until the owner starts it.
  assert.equal((await cryptoTick(storage, { fetcher: exchange({ now: () => SAT, calls }), now: SAT })).skipped, 'Orion crypto research is paused');
  assert.equal(await nextCryptoTickAt(storage, SAT), null);
  assert.equal(calls.length, 0);
  await setCryptoPaper(storage, true, SAT - 1000);
  const run = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT, calls }), now: SAT });
  assert.equal(run.ok, true);
  assert.ok(run.requests <= 6 && run.requests >= 1, `requests per pass are capped (${run.requests})`);
  assert.equal(run.closed, 0, 'history is never journalled as paper');
  assert.ok(run.series.some((s) => s.coin === 'BTC' && s.tf === '5m' && s.status === 'LIVE'));
  const budget = (await storage.get(CRYPTO_BUDGET));
  assert.equal(budget.requests, run.requests);
  assert.equal((await storage.get(CRYPTO_RUNS)).length, 1);
  const next = await nextCryptoTickAt(storage, SAT);
  assert.ok(next > SAT && next - SAT <= 300_000 + 20_000, 'the next pass is the next 5-minute close');
  // The same bucket again: a series already read is not fetched twice; only those the request cap deferred are read now.
  const read = new Set(run.series.filter((s) => s.status).map((s) => `${s.coin}:${s.tf}`));
  const again = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT + 5000, calls }), now: SAT + 5000 });
  assert.ok(again.series.every((s) => !read.has(`${s.coin}:${s.tf}`)), 'no series is fetched twice for one bucket');
  let last = again;
  for (let i = 2; i < 6 && !last.skipped; i++) last = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT + i * 1000, calls }), now: SAT + i * 1000 });
  assert.equal(last.skipped, 'no new bar has closed yet');
});

test('an unreachable exchange is DISCONNECTED: no entries, no throw, the reason is stored', async () => {
  const storage = memoryStorage();
  const run = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT, failCoinbase: true }), now: SAT, force: true });
  assert.equal(run.ok, false);
  assert.ok(run.series.filter((s) => s.status).every((s) => s.status === 'DISCONNECTED' && /HTTP 503/.test(s.reason)));
  const v = await cryptoView(storage, SAT);
  assert.equal(v.feeds.find((f) => f.coin === 'BTC' && f.tf === '5m').status, 'DISCONNECTED');
  assert.equal(v.simulated.closed_trades, 0);
});

test('the daily request budget stops fetching instead of overspending', async () => {
  const storage = memoryStorage();
  await setCryptoPaper(storage, true, SAT - 1000);
  await storage.put(CRYPTO_BUDGET, { day: new Date(SAT).toISOString().slice(0, 10), requests: DAILY_REQUEST_LIMIT, limit: DAILY_REQUEST_LIMIT });
  const calls = [];
  const run = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT, calls }), now: SAT });
  assert.equal(calls.length, 0);
  assert.equal(run.budget_exhausted, true);
});

test('a weekend of passes: crypto trades reach the shared journal labelled crypto, and futures readers never see them', async () => {
  const storage = memoryStorage();
  let now = SAT - 3 * 86_400_000; // start Wednesday so stored history covers the weekend
  const fetcher = exchange({ now: () => now });
  await setCryptoPaper(storage, true, now);
  for (let i = 0; i < 700; i++) { await cryptoTick(storage, { fetcher, now }); now += 300_000; }
  const crypto = await readTrades(storage, () => true, { market: 'crypto' });
  const futures = await readTrades(storage);
  assert.ok(crypto.length > 0, 'the generated market produced at least one closed simulated trade');
  assert.equal(futures.length, 0, 'futures views (the default) exclude crypto records');
  assert.equal((await readTrades(storage, () => true, { market: 'all' })).length, crypto.length);
  for (const t of crypto) {
    assert.equal(t.market, 'crypto');
    assert.equal(t.environment, 'paper');
    assert.match(t.symbol, /^(BTC|ETH)-USD$/);
    assert.ok(Object.keys(TIMEFRAMES).includes(t.data.resolution));
    assert.ok(t.costs.fees > 0, 'percentage fees are charged');
    assert.match(t.data.price_series, /Coinbase Exchange/);
    assert.ok(t.review.facts.length > 0 && !t.review.facts.some((f) => /CME daily break/.test(f)));
  }
  assert.ok([...storage.saved.keys()].some((k) => k.startsWith(RECORD_PREFIX)));
  const v = await cryptoView(storage, now);
  assert.equal(v.simulated.closed_trades, crypto.length);
  assert.ok(v.research.some((r) => r.ok), 'research ran on stored bars');
  const text = speakCrypto(v, { now });
  assert.match(text, /Paper only/);
  assert.match(text, new RegExp(`Simulated trades closed: ${crypto.length}`));
  if (crypto.length < 30) assert.match(text, /not enough data/);
});

test('research: volatility regime, liquidity screen, sessions and an out-of-sample split from stored bars', () => {
  const bars = [];
  const start = Math.floor(SAT / 1000 / 300) * 300 - 2000 * 300;
  for (let i = 0; i < 2000; i++) { const r = barAt('BTC', 300, start + i * 300); bars.push({ t: new Date(r[0] * 1000).toISOString(), o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] }); }
  const study = marketStudy(bars, '5m');
  assert.ok(['high volatility', 'normal volatility', 'low volatility'].includes(study.volatility.regime));
  assert.ok(study.liquidity.dollar_volume_24h > 0);
  assert.ok(study.by_session['US (13–21 UTC)'] && study.weekend_vs_weekday.weekend);
  const rows = backtestSeries('BTC', '5m', bars);
  assert.equal(rows.length, 12);
  for (const r of rows) assert.equal(r.enough_data, r.trades >= 30);
  // Every strategy passes the same look-ahead audit as the futures research, and costs are paid on every trade.
  for (const r of rows) assert.ok(['passed', 'not enough bars'].includes(r.look_ahead), `${r.strategy}: ${r.look_ahead}`);
  for (const r of rows.filter((x) => x.trades)) assert.ok(r.costs_paid > 0, `${r.strategy} paid its fees and slippage`);
  const firstWeak = rows.findIndex((r) => !(r.look_ahead !== 'FAILED' && r.oos_trades >= 30));
  if (firstWeak >= 0) assert.ok(rows.slice(firstWeak).every((r) => !(r.look_ahead !== 'FAILED' && r.oos_trades >= 30)), 'audited strategies with enough out-of-sample trades rank first');
});

test('pause keeps records and stops the schedule; resume starts again from the newest bar', async () => {
  const storage = memoryStorage();
  await setCryptoPaper(storage, true, SAT - 1000);
  await cryptoTick(storage, { fetcher: exchange({ now: () => SAT }), now: SAT });
  await setCryptoPaper(storage, false, SAT + 1000);
  assert.equal(await nextCryptoTickAt(storage, SAT + 2000), null);
  assert.equal((await cryptoTick(storage, { fetcher: exchange({ now: () => SAT + 600_000 }), now: SAT + 600_000 })).skipped, 'Orion crypto research is paused');
  assert.equal((await storage.get(CRYPTO_RUNS)).length, 1, 'records are kept');
  // The deploy check's forced pass reads the feed while paused but steps no portfolio.
  const forced = await cryptoTick(storage, { fetcher: exchange({ now: () => SAT + 650_000 }), now: SAT + 650_000, force: true });
  assert.ok(forced.series.some((x) => x.status === 'LIVE'));
  assert.equal(forced.signals, 0);
  assert.equal(storage.saved.has('crypto_pf:BTC:5m') ? Object.values(storage.saved.get('crypto_pf:BTC:5m')).some((pf) => pf.open || pf.pending) : false, false);
  await setCryptoPaper(storage, true, SAT + 700_000);
  assert.ok(await nextCryptoTickAt(storage, SAT + 700_000));
});

test('intent: the owner\'s words reach the crypto desk; plain price questions and unrelated sentences do not', () => {
  assert.deepEqual(cryptoIntent('Have Orion research BTC and ETH, compare strategies, and continue paper trading during the weekend.'), { kind: 'resume' });
  assert.deepEqual(cryptoIntent('Pause Orion crypto research'), { kind: 'pause' });
  assert.deepEqual(cryptoIntent('Resume Orion crypto research'), { kind: 'resume' });
  assert.deepEqual(cryptoIntent('How is the crypto paper trading going?'), { kind: 'status' });
  assert.deepEqual(cryptoIntent('Show me the bitcoin paper trades'), { kind: 'status' });
  assert.deepEqual(cryptoIntent('Did any bitcoin paper trades hit their stop?'), { kind: 'status' }, 'a stop-loss question never pauses the desk');
  assert.deepEqual(cryptoIntent('Stop the crypto paper trading'), { kind: 'pause' });
  for (const no of ["What's the price of bitcoin?", 'Should I buy ethereum?', 'Pause the strategy simulation', 'How is MNQ paper trading going?', 'Tell me about Orion the constellation', 'Research the history of cryptography']) {
    assert.equal(cryptoIntent(no), null, no);
  }
});

// ─── Through the real /api/chat route ─────────────────────────────────────

const generated = new URL('./.crypto_markets.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

async function openChe() {
  const calls = { n: 0 };
  const saved = new Map();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls.n += 1; return { response: 'A model guess about crypto, sir.' }; } } };
  const storage = { ...memoryStorage(saved), deleteAll: async () => saved.clear(), setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {}, sql };
  const pending = [];
  const state = new CheState({ storage, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => null)) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, as = token) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history: [] }, as)).text();
    await Promise.allSettled(pending.splice(0));
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    return { reply: done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join(''), meta: done, modelCalls: calls.n - before };
  };
  return { say, send, token, saved };
}

test('Test A through /api/chat: the real schedule state and records, no model, no invented trades', async () => {
  globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };
  const che = await openChe();
  const a = await che.say('Have Orion research BTC and ETH, compare strategies, and continue paper trading during the weekend.');
  assert.equal(a.meta.source, 'che_crypto');
  assert.equal(a.modelCalls, 0);
  assert.match(a.reply, /around the clock including the weekend/);
  assert.match(a.reply, /Simulated trades closed: 0; open positions: 0/);
  assert.match(a.reply, /Paper only: no exchange account, no key and no order path exist/);
  const p = await che.say('Pause Orion crypto research');
  assert.equal(p.meta.source, 'che_crypto');
  assert.match(p.reply, /paused/);
  const view = await (await che.send('/api/trading/crypto', null, che.token, 'GET')).json();
  assert.equal(view.enabled, false);
  assert.equal(view.live_trading, 'disabled: no exchange account, key or order path exists');
  assert.equal(view.funding.status, 'MISSING');
  const r = await che.say('Resume Orion crypto research');
  assert.match(r.reply, /are on: BTC and ETH/);
});

test('guests cannot run or read the crypto desk', async () => {
  const che = await openChe();
  const g = await che.say('How is the crypto paper trading going?', '');
  assert.notEqual(g.meta.source === 'che_crypto' && /Simulated trades closed/.test(g.reply), true);
});
