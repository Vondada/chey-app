// Forward paper trading on intraday NQ/MNQ bars (owner, 2026-10-18).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { aggregate, cmeSession, frontMonth, parseYahooChart } from './market_feed.js';
import { CONTRACTS, COSTS, fillEntry, exitOn, newPortfolio, readTrades, settleTrade, stepPortfolio, intradayContext } from './trading_evidence.js';
import { LIVE_PORTFOLIOS, liveDashboard, liveTick, setLivePaper } from './trading_live.js';
import { liveIntent } from './trading_live_chat.js';
import { evidenceReport } from './trading_evidence_runner.js';

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
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// Five 1-minute bars that add up to one 5-minute bar {o, h, l, c}.
function minutesOf(t0, { o, h, l, c }) {
  const at = (k) => new Date(Date.parse(t0) + k * 60_000).toISOString();
  return [
    { t: at(0), o, h: o, l, c: l, v: 10 },
    { t: at(1), o: l, h, l, c: h, v: 10 },
    { t: at(2), o: h, h, l: c, c, v: 10 },
    { t: at(3), o: c, h: c, l: c, c, v: 10 },
    { t: at(4), o: c, h: c, l: c, c, v: 10 },
  ];
}
const five = (start, k) => new Date(Date.parse(start) + k * 300_000).toISOString();
// CME day 1 (opens 18:00 New York = 22:00 UTC): quiet bars with a low of 19990.
const DAY1 = Array.from({ length: 12 }, (_, k) => ({ t: five('2026-10-19T22:00:00Z', k), o: 20000, h: 20004, l: k === 5 ? 19990 : 19996, c: 20000 }));
// CME day 2: the first bar sweeps the previous day low and closes back above it; the next rallies.
const DAY2 = [
  { t: five('2026-10-20T22:00:00Z', 0), o: 20000, h: 20002, l: 19980, c: 19995 },
  { t: five('2026-10-20T22:00:00Z', 1), o: 19996, h: 20030, l: 19992, c: 20028 },
  { t: five('2026-10-20T22:00:00Z', 2), o: 20028, h: 20031, l: 20020, c: 20025 },
];
const oneMinute = (bars) => bars.flatMap((b) => minutesOf(b.t, b));
const feedOf = (bars) => async () => ({ status: 'DELAYED', provider: 'test feed', provider_symbol: 'MNQ=F', contract: 'MNQZ6', candles: oneMinute(bars), latency_s: 600, last_bar_time: bars.at(-1).t, checked_at: new Date().toISOString() });
const after = (bars) => Date.parse(bars.at(-1).t) + 6 * 60_000;

test('Yahoo bars: the forming bar and empty bars are never used; 5-minute bars are only complete ones', () => {
  const t0 = Date.parse('2026-10-19T14:00:00Z') / 1000;
  const json = { chart: { result: [{ meta: { regularMarketTime: t0 + 150, exchangeDataDelayedBy: 10, symbol: 'MNQ=F' }, timestamp: [t0, t0 + 60, t0 + 120],
    indicators: { quote: [{ open: [1, null, 3], high: [2, null, 4], low: [0.5, null, 2], close: [1.5, null, 3.5], volume: [5, 0, 7] }] } }] } };
  const parsed = parseYahooChart(json, (t0 + 200) * 1000);
  assert.deepEqual(parsed.candles.map((c) => c.o), [1], 'the empty bar and the bar still forming are left out');
  assert.equal(parsed.delayed_by_min, 10);
  const bars = oneMinute(DAY1.slice(0, 2));
  assert.equal(aggregate(bars, 5, Date.parse(DAY1[2].t)).length, 2);
  assert.equal(aggregate(bars.slice(0, 7), 5, Date.parse(DAY1[2].t)).length, 1, 'a 5-minute bar still forming is not used');
});

test('the front month follows the CME roll, and the Globex calendar has its break and weekend', () => {
  assert.equal(frontMonth('MNQ', Date.parse('2026-10-18T22:00:00Z')).code, 'MNQZ6');
  assert.equal(frontMonth('NQ', Date.parse('2026-12-11T00:00:00Z')).code, 'NQH7');
  assert.equal(cmeSession(Date.parse('2026-10-18T21:59:00Z')).open, false, 'Sunday before 6 PM New York');
  assert.equal(cmeSession(Date.parse('2026-10-18T22:00:00Z')).open, true, 'Sunday 6 PM New York reopen');
  assert.equal(cmeSession(Date.parse('2026-10-19T21:30:00Z')).state, 'daily break');
  assert.equal(cmeSession(Date.parse('2026-10-23T21:30:00Z')).state, 'weekend');
});

test('a short trade earns when price falls, after the same costs', () => {
  const c = CONTRACTS.MNQ;
  const entry = fillEntry({ o: 20000 }, c, COSTS, 'short');
  assert.equal(entry.price, 19999.625, 'a short sells below the open by half the spread and the slippage');
  const pos = { side: 'short', entry, stop: 20010, target: 19980 };
  const hit = exitOn(pos, { o: 19990, h: 19992, l: 19978, c: 19979 }, c);
  assert.equal(hit.reason, 'target');
  const s = settleTrade(pos, hit.exit, 1, c);
  assert.equal(s.gross_before_costs, 40, '20 points × $2');
  assert.ok(s.net_pnl < 40 && s.net_pnl > 30);
  assert.equal(exitOn(pos, { o: 20005, h: 20012, l: 20001, c: 20011 }, c).reason, 'stop');
});

test('forward only: history is never journalled; a new signal enters, exits and is recorded with its review', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  const first = await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  assert.equal(first.ok, true);
  assert.equal(first.closed, 0, 'bars before the start are not traded');
  const second = await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(second.ok, true);
  const trades = await readTrades(storage, (t) => t.data?.resolution === '5m');
  const sweep = trades.find((t) => t.strategy === 'pdhl-sweep-5m' && t.filter === 'any');
  assert.ok(sweep, `the previous-day low sweep traded: ${trades.map((t) => t.strategy).join(', ')}`);
  assert.equal(sweep.environment, 'paper');
  assert.equal(sweep.side, 'long');
  assert.equal(sweep.signal.time, DAY2[0].t, 'the signal is the sweep bar, after the start');
  assert.equal(sweep.entry.time, DAY2[1].t, 'filled at the next bar open');
  assert.equal(sweep.exit.reason, 'target');
  assert.equal(sweep.data.feed.status, 'DELAYED');
  assert.ok(sweep.review.facts.length >= 3);
  assert.ok(sweep.net_pnl > 0);
});

test('the dashboard totals are the journal recounted, and a restart resumes the same state', async () => {
  const saved = new Map();
  const storage = memoryStorage(saved);
  await setLivePaper(storage, true);
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  const restarted = memoryStorage(saved); // a new Worker instance over the same Durable Object storage
  const d = await liveDashboard(restarted, { now: after(DAY2) });
  const trades = await readTrades(restarted, (t) => t.data?.resolution === '5m');
  const net = Math.round(trades.reduce((s, t) => s + t.net_pnl, 0) * 100) / 100;
  assert.equal(d.totals.trades, trades.length);
  assert.equal(d.totals.net_pnl, net, 'recomputed independently from the stored records');
  assert.equal(d.totals.wins + d.totals.losses + d.totals.flat, trades.length);
  assert.equal(d.account, 'PAPER');
  const again = await liveTick(restarted, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) + 60_000 });
  assert.equal(again.closed, 0, 'the same bars are not traded twice after a restart');
  assert.equal(again.journal.written, 0);
  assert.ok(Object.keys(saved.get(LIVE_PORTFOLIOS)).length >= 18);
});

test('paper trading cannot reach a broker: no broker host is called and live sources are refused', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  const hosts = [];
  const fetcher = async (url) => { hosts.push(new URL(String(url)).host); throw new Error('offline'); };
  const run = await liveTick(storage, { force: true, fetcher, now: Date.parse('2026-10-20T15:00:00Z') });
  assert.equal(run.ok, false);
  assert.match(run.feed.status, /UNAVAILABLE/);
  assert.deepEqual([...new Set(hosts)], ['query1.finance.yahoo.com'], 'only the market data source is asked');
  assert.throws(() => newPortfolio('fvg-retest-5m', 'any', { source: 'live' }), /not a research environment/);
  assert.throws(() => newPortfolio('fvg-retest-5m', 'any', { source: 'sim' }), /not a research environment/);
});

test('the daily evidence report does not count intraday paper trades', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  storage.saved.set('evidence_runs', [{ at: new Date().toISOString(), ok: true }]);
  assert.match(await evidenceReport(storage), /Recorded in total: 0 /);
});

test('no lookahead: every intraday value at a bar is the same with or without later bars', () => {
  const bars = [...DAY1, ...DAY2];
  const full = intradayContext(bars);
  const cut = intradayContext(bars.slice(0, 13));
  for (const key of ['ema20', 'vwap', 'pdl', 'pdh', 'rsi14', 'lastLow', 'lastHigh']) assert.equal(full[key][12], cut[key][12], key);
});

test('the owner\'s Trading Room commands are recognised; other trading talk keeps its routes', () => {
  const expected = {
    'CHE, open your Trading Room.': 'open', 'Show me live MNQ trades.': 'trades', 'Start paper trading NQ and MNQ.': 'start',
    'What strategies are you testing?': 'strategies', 'Show me every trade you made tonight.': 'trades', 'How many trades have you won and lost?': 'winloss',
    'Explain why that trade lost.': 'why', 'Show the chart where you entered.': 'chart', 'Which ICT strategy is performing best?': 'best',
    'Compare your strategies.': 'compare', 'Show me your current positions.': 'positions', 'Read me your trading performance.': 'performance',
    'Stop paper trading.': 'stop', 'Show me the trading evidence.': 'evidence',
  };
  for (const [q, kind] of Object.entries(expected)) assert.equal(liveIntent(q)?.kind, kind, q);
  for (const q of ['switch to paper', 'take the trade', 'what is the price of NQ', 'connect NinjaTrader']) assert.equal(liveIntent(q), null, q);
});

// Through the real chat route.
const generated = new URL('./.trading_live.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

test('route: start, ask and stop by voice, with no model call and no trade claimed before a record exists', async () => {
  const saved = new Map();
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls += 1; return { response: 'I made five winning trades.' }; } } };
  const state = new CheState({ storage: memoryStorage(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes('yahoo')) throw new Error('offline in tests'); return realFetch(url); };
  try {
    const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
    const ask = async (message) => {
      const lines = (await (await send('/api/chat', { message }, token)).text()).trim().split('\n').map((l) => JSON.parse(l));
      return { text: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') };
    };
    const start = await ask('Start paper trading NQ and MNQ.');
    assert.equal(start.done.source, 'che_trading_live');
    assert.match(start.text, /Paper trading is on/);
    assert.match(start.text, /UNAVAILABLE|No market data/, 'an unreachable feed is said, not hidden');
    assert.equal(saved.get('live_paper_state').enabled, true);
    const won = await ask('How many trades have you won and lost?');
    assert.match(won.text, /No paper trade has closed yet/);
    assert.doesNotMatch(won.text, /five winning/);
    const stop = await ask('Stop paper trading.');
    assert.match(stop.text, /Paper trading is off/);
    assert.equal(saved.get('live_paper_state').enabled, false);
    assert.equal(modelCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
