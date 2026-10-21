// Forward paper trading on intraday NQ/MNQ bars (owner, 2026-10-18).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { aggregate, cmeSession, frontMonth, parseYahooChart } from './market_feed.js';
import { CONTRACTS, COSTS, INTRADAY_CANDIDATES, fillEntry, exitOn, newPortfolio, readTrades, settleTrade, stepPortfolio, intradayContext } from './trading_evidence.js';
import { LIVE_EXCLUDED, LIVE_PORTFOLIOS, liveDashboard, liveTick, setLivePaper } from './trading_live.js';
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
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
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
const feedOf = (bars) => async () => ({ status: 'LIVE', authenticated: true, subscription_verified: true, provider: 'test feed', provider_symbol: 'MNQ=F', contract: 'MNQZ6', candles: oneMinute(bars), latency_s: 0, last_bar_time: bars.at(-1).t, checked_at: new Date().toISOString() });
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
  assert.equal(sweep.data.feed.status, 'LIVE');
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

test('delayed data older than the maximum age is refused before any portfolio steps; fresh delayed data is used', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, after(DAY1));
  const delayedOf = (bars) => async () => ({ ...(await feedOf(bars)()), status: 'DELAYED', authenticated: false, subscription_verified: false, latency_s: 900, delayed_by_min: 15 });
  const old = await liveTick(storage, { force: true, load: delayedOf(DAY1), now: after(DAY1) + 2 * 24 * 60 * 60_000 });
  assert.equal(old.ok, false, 'two-day-old delayed bars are not used');
  assert.match(old.error, /^data refused: the newest delayed bar closed \d+ min ago; the maximum is 45 min$/);
  assert.equal(old.closed, undefined, 'no portfolio was stepped on the stale bars');
  assert.equal(old.journal, undefined, 'nothing was journalled from the stale bars');
  const fresh = await liveTick(storage, { force: true, load: delayedOf(DAY1), now: after(DAY1) });
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.error, undefined);
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

test('review of #339: the bar that creates a fair value gap is not its retest', () => {
  const bars = [
    { t: '2026-10-20T13:50:00Z', o: 19998, h: 20001, l: 19994, c: 19999 },
    { t: '2026-10-20T13:55:00Z', o: 19999, h: 20001, l: 19995, c: 20000 },
    { t: '2026-10-20T14:00:00Z', o: 20000, h: 20002, l: 19995, c: 20001 },
    { t: '2026-10-20T14:05:00Z', o: 20001, h: 20020, l: 20000, c: 20018 },
    { t: '2026-10-20T14:10:00Z', o: 20010, h: 20025, l: 20010, c: 20019 }, // completes the gap 20002–20010 and closes up
  ];
  const ctx = intradayContext(bars);
  assert.equal(INTRADAY_CANDIDATES['fvg-retest-5m'].entry(bars, 4, ctx), null);
  const retest = [...bars, { t: '2026-10-20T14:15:00Z', o: 20012, h: 20020, l: 20008, c: 20017 }];
  const sig = INTRADAY_CANDIDATES['fvg-retest-5m'].entry(retest, 5, intradayContext(retest));
  assert.equal(sig?.side, 'long', 'a later bar that trades into the gap and closes up is the retest');
});

test('review of #339: a plan whose fill after costs reaches the target is voided, never journalled as a loss', () => {
  const pf = newPortfolio('pdhl-sweep-5m', 'any', { resolution: '5m', priceSeries: 'test' });
  const bars = [...DAY1, ...DAY2.slice(0, 1), { t: DAY2[1].t, o: 20025.4, h: 20030, l: 20020, c: 20028 }];
  const trades = stepPortfolio(pf, bars, intradayContext(bars));
  assert.equal(trades.length, 0);
  assert.equal(pf.counts.gap_skipped, 1);
  assert.equal(pf.open, null);
});

test('review of #339: stopping voids an open position with its reason; starting again never trades the stopped period', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2.slice(0, 2)]), now: after(DAY2.slice(0, 2)) });
  await setLivePaper(storage, false);
  const excluded = storage.saved.get(LIVE_EXCLUDED) || [];
  assert.ok(Object.values(storage.saved.get(LIVE_PORTFOLIOS)).every((pf) => !pf.open), 'no position stays open after a stop');
  assert.ok(excluded.every((e) => e.kind === 'voided' && /stopped/.test(e.reason)));
  await setLivePaper(storage, true);
  const before = (await readTrades(storage, (t) => t.data?.resolution === '5m')).length;
  const run = await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(run.closed, 0, 'bars from while it was stopped are not traded');
  assert.equal((await readTrades(storage, (t) => t.data?.resolution === '5m')).length, before);
});

test('review of #339: questions and negations never switch paper trading; other topics keep their routes', () => {
  for (const q of ["Don't stop paper trading.", 'Why did you stop paper trading?', 'When did you start paper trading?', 'Which teams won and lost last night?',
    'Are there any open positions at Apple?', 'Read me the news about trade tariffs today.', 'Which marketing strategy works best for my YouTube channel?']) {
    assert.equal(liveIntent(q), null, q);
  }
  for (const q of ['Explain the last losing trade.', 'Show me where you entered on the chart.', 'How did your paper trades do today?']) assert.ok(liveIntent(q), q);
});

// Owner issue #350: a long compound read question is answered in full; start and stop stay commands.
const voiceOf = (text) => text.replace(/[.,?!;]/g, '').replace(/\bDon't\b/gi, 'dont').replace(/\s+/g, ' ').toLowerCase();
const COMPOUND = "How many paper trades have you won and lost so far, which strategy is performing best, and is paper trading still on? Don't start or stop anything.";
const LONG_COMPOUND = "CHE, how many paper trades have you won and lost so far today, which of your strategies is performing best right now, and is paper trading still on? Please don't start or stop anything, just read me the answers.";

test('issue #350: a long compound read question names every read it asks; prohibitions, orders and other topics change nothing', () => {
  assert.ok(LONG_COMPOUND.length > 160);
  for (const q of [COMPOUND, voiceOf(COMPOUND), LONG_COMPOUND, voiceOf(LONG_COMPOUND)]) {
    assert.deepEqual(liveIntent(q), { kind: 'winloss', kinds: ['winloss', 'best', 'state'] }, q);
  }
  const reads = {
    "Don't stop paper trading, just tell me how many trades have you won and lost so far.": ['winloss'],
    'Read me your trading performance since this morning, which of your strategies is performing best, and show me your open positions. Do not stop paper trading and do not place any orders.': ['performance', 'best', 'positions'],
    'Is paper trading still on?': ['state'],
    'are you still paper trading': ['state'],
  };
  for (const [q, kinds] of Object.entries(reads)) {
    for (const said of [q, voiceOf(q)]) assert.deepEqual(liveIntent(said)?.kinds || [liveIntent(said)?.kind], kinds, said);
  }
  // Start and stop are commands only when the turn opens with them; a long one is still the command.
  const stop = 'Stop paper trading now, and once it is off tell me how many paper trades have you won and lost so far today and which of your strategies is performing best overall.';
  assert.ok(stop.length > 160);
  assert.equal(liveIntent(stop).kind, 'stop');
  assert.equal(liveIntent(voiceOf(stop)).kind, 'stop');
  // Orders belong to the desk and other topics keep their own routes, however long the turn.
  for (const q of [
    'How many paper trades have you won and lost so far, which strategy is performing best, and then buy two MNQ contracts at market if the best one is long right now.',
    'Fix the Trading Room screen code so that when I ask how many paper trades have you won and lost so far, you read the totals and which strategy is performing best, then open a pull request.',
    'Send Claude a message in the mailbox asking how many paper trades have you won and lost so far and which of your strategies is performing best, and tell me when it replies.',
    'Which strategy works best for my YouTube channel?', 'Is paper trading on NQ profitable for beginners in general?', 'Never stop paper trading.', 'Do not stop paper trading.',
  ]) {
    for (const said of [q, voiceOf(q)]) assert.equal(liveIntent(said), null, said);
  }
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

test('issue #350 route: the compound question is answered in full from the journal, nothing starts or stops, and MNQ reads keep their routes', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url?.url || url)); throw new TypeError('fetch failed (offline test)'); };
  try {
    for (const enabled of [true, false]) {
      const saved = new Map();
      let modelCalls = 0;
      const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls += 1; return { response: 'I won five trades and stopped paper trading.' }; } } };
      const storage = memoryStorage(saved);
      const state = new CheState({ storage }, env);
      env.CHE_STATE = { getByName: () => state };
      if (enabled) await setLivePaper(storage, true);
      const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
      const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
      const ask = async (message) => {
        const lines = (await (await send('/api/chat', { message }, token)).text()).trim().split('\n').map((l) => JSON.parse(l));
        return { text: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') };
      };
      for (const q of [COMPOUND, voiceOf(COMPOUND), LONG_COMPOUND, voiceOf(LONG_COMPOUND)]) {
        const out = await ask(q);
        assert.equal(out.done.source, 'che_trading_live', q);
        assert.match(out.text, /^No paper trade has closed yet, sir\./, 'won and lost, from the journal');
        assert.match(out.text, /No forward paper trade has closed yet, so no strategy is ranked, sir\./, 'the best strategy, from the journal');
        assert.match(out.text, enabled ? /Paper trading is on, sir, since [^.]+ Central\. I did not change it\.$/ : /Paper trading is off, sir\. I did not change it; say start paper trading to turn it on\.$/);
        assert.equal(out.text.match(/No market data has been read yet/g).length, 1, 'the feed is said once');
        assert.doesNotMatch(out.text, /five|stopped paper trading/);
        assert.equal(Boolean(saved.get('live_paper_state')?.enabled), enabled, `${q}: nothing was started or stopped`);
      }
      assert.equal(modelCalls, 0);
      if (!enabled) continue;
      // Task 1: MNQ by name is the chart analyzer's, on NQ prices; the feed-and-journal read stays here.
      requests.length = 0;
      for (const q of ['Analyze MNQ.', "what's mnq doing", 'MNQ structure']) {
        const out = await ask(q);
        assert.equal(out.done.source, 'che_trading', q);
        assert.ok(requests.some((u) => /stooq\.com\/.*[?&]s=nq\.f\b/.test(u)), `${q} read NQ prices`);
        assert.ok(!requests.some((u) => /binance/.test(u)), `${q} never fell back to bitcoin`);
      }
      const feed = await ask('Analyze MNQ using your latest available market data, tell me the data source and whether any paper trades occurred.');
      assert.equal(feed.done.source, 'che_trading_live');
      const order = await ask('Analyze MNQ and buy one contract if it looks bullish.');
      assert.ok(!['che_trading', 'che_trading_live'].includes(order.done?.source), `an order is not a read: ${order.done?.source}`);
      assert.doesNotMatch(order.text, /placed (?:an|the|your) order|order (?:is |was )?placed/i);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('comprehension audit: the owner\'s own words for paper results read the journal', () => {
  for (const q of ['How did my paper trades do today?', "What's my paper trading balance?", 'how are my paper trades doing', 'what is my paper p&l']) {
    assert.equal(liveIntent(q)?.kind, 'performance', q);
  }
});

// Owner strategy learning dashboard: evidence is unique entries, not portfolio copies.
test('learning cards deduplicate identical any/trend entries and keep every source separate', async () => {
  const { strategyLearning } = await import('./trading_live.js');
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  const records = await readTrades(storage, (t) => t.environment === 'paper');
  const sweep = records.filter((t) => t.strategy === 'pdhl-sweep-5m');
  assert.ok(sweep.length >= 1);
  const { appendTrades } = await import('./trading_evidence.js');
  const trend = newPortfolio('pdhl-sweep-5m', 'trend', { contract: 'MNQ', resolution: '5m' });
  await appendTrades(storage, [{ ...sweep[0], portfolio: trend.key, filter: 'trend', strategy_version: trend.strategy_version }]);
  const result = await strategyLearning(storage, { now: after(DAY2) });
  const row = result.strategies.find((r) => r.id === 'pdhl-sweep-5m');
  assert.equal(row.forward.trades, 1, 'one entry seen by any and trend is one sample');
  assert.equal(row.raw_records, sweep.length + 1);
  assert.equal(row.duplicates, sweep.length);
  assert.equal(row.progress.target, 30);
  assert.equal(row.live_ready, false);
  assert.equal(row.milestones.find((m) => m.id === 'owner').status, 'blocked');
  assert.equal(row.historical, null);
  assert.equal(row.broker_paper.status, 'not_attributed');
  assert.equal(row.live_execution.status, 'disabled');
  assert.equal(result.strategies[0].id, 'ema-pullback-5m');
  assert.equal(result.strategies[1].id, 'vwap-revert-5m');
});

test('research archives reproducible 5-minute experiments and never turns replays into paper trades', async () => {
  const { LIVE_RESEARCH_PREFIX, strategyLearning, liveBacktest } = await import('./trading_live.js');
  const storage = memoryStorage();
  const bars = [...DAY1, ...DAY2];
  const load = async () => ({ status: 'DELAYED', interval: '5m', provider: 'licensed test fixture', provider_symbol: 'MNQ=F', candles: bars });
  const first = await liveBacktest(storage, { load, now: after(bars) });
  assert.equal(first.ok, true);
  assert.match(first.dataset_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.resolution, '5m');
  assert.equal(first.target_per_strategy, 30);
  assert.ok(first.rows.every((r) => r.strategy_version && r.params && r.walk_forward));
  assert.equal((await readTrades(storage, (t) => t.environment === 'paper')).length, 0);
  const again = await liveBacktest(storage, { load, now: after(bars) + 1000 });
  assert.equal(again.id, first.id, 'repeating identical data/config is the same experiment, not new samples');
  const archives = await storage.list({ prefix: LIVE_RESEARCH_PREFIX });
  assert.equal(archives.size, 1);
  const result = await strategyLearning(storage, { now: after(bars) });
  assert.equal(result.strategies.find((r) => r.id === 'pdhl-sweep-5m').historical.trades, 1);
  assert.equal(result.strategies.find((r) => r.id === 'pdhl-sweep-5m').forward.trades, 0);
  assert.equal(result.research.quota_met, false, 'no fabricated outcomes to fill a quota');
});

test('incomplete minute buckets are not valid 5-minute evidence', () => {
  const bars = oneMinute(DAY1.slice(0, 2));
  assert.equal(aggregate(bars.filter((_, i) => i !== 2), 5, Date.parse(DAY1[2].t)).length, 1);
});

test('30 unique forward samples still cannot enable live execution or imply owner approval', async () => {
  const { strategyLearning } = await import('./trading_live.js');
  const { appendTrades } = await import('./trading_evidence.js');
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  const seed = (await readTrades(storage, (t) => t.strategy === 'pdhl-sweep-5m' && t.filter === 'any'))[0];
  const entries = Array.from({ length: 35 }, (_, i) => {
    const at = new Date(Date.parse(seed.entry.time) + (i + 1) * 300000).toISOString();
    return { ...seed, entry: { ...seed.entry, time: at }, exit: { ...seed.exit, time: at } };
  });
  await appendTrades(storage, entries);
  const row = (await strategyLearning(storage, { now: after(DAY2) })).strategies.find((r) => r.id === seed.strategy);
  assert.equal(row.forward.trades, 36);
  assert.equal(row.progress.fraction, 1);
  assert.equal(row.live_ready, false);
  assert.equal(row.milestones.filter((m) => ['owner', 'risk', 'broker', 'feed'].includes(m.id) && m.status === 'blocked').length, 4);
});

test('research failure preserves history and never changes a timeframe to meet its target', async () => {
  const { liveBacktest, LIVE_BACKTEST, LIVE_RESEARCH_PREFIX } = await import('./trading_live.js');
  const storage = memoryStorage();
  storage.saved.set(LIVE_BACKTEST, { ok: true, at: '2026-10-19T23:00:00Z', rows: [], data: 'legacy history' });
  const result = await liveBacktest(storage, { now: after(DAY2), load: async () => ({ status: 'REPLAY', interval: '1m', candles: oneMinute(DAY1) }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /no timeframe substitution/);
  assert.ok([...(await storage.list({ prefix: LIVE_RESEARCH_PREFIX })).values()].some((r) => r.data === 'legacy history'));
});

test('walk-forward purges trades that carry training or earlier fold exposure into a held-out window', async () => {
  const { evaluateWalkForward } = await import('./trading_evidence.js');
  const times = Array.from({ length: 20 }, (_, i) => new Date(Date.parse(DAY1[0].t) + i * 300000).toISOString());
  const t = { net_pnl: 1, r_net: 1, costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 }, side: 'long' };
  const result = evaluateWalkForward([
    { ...t, entry: { time: times[5] }, exit: { time: times[9] } },
    { ...t, entry: { time: times[9] }, exit: { time: times[12] } },
    { ...t, entry: { time: times[12] }, exit: { time: times[13] } },
  ], { barTimes: times, folds: 4, minTrain: 0.4 });
  assert.equal(result.oos.length, 1);
  assert.equal(result.oos[0].entry.time, times[12]);
});

test('learning and daily progress questions read records and never dispatch research or orders', () => {
  for (const message of ['Read my strategy learning progress and live readiness.', 'Show my daily strategy report.']) assert.equal(liveIntent(message).kind, 'learning');
});

test('daily research reuse records a current attempt and does not download unchanged history hourly', async () => {
  const { liveBacktest, researchDue } = await import('./trading_live.js');
  const storage = memoryStorage();
  await setLivePaper(storage, true);
  const bars = [...DAY1, ...DAY2];
  let loads = 0;
  const load = async () => { loads++; return { status: 'REPLAY', interval: '5m', provider: 'fixture', provider_symbol: 'MNQ', candles: bars }; };
  const first = await liveBacktest(storage, { load, now: after(bars) });
  const later = after(bars) + 86400000;
  const reused = await researchDue(storage, { load, now: later });
  assert.equal(reused.id, first.id);
  assert.equal(reused.reused, true);
  const skipped = await researchDue(storage, { load, now: later + 3600000 });
  assert.match(skipped.skipped, /already recorded/);
  assert.equal(loads, 2);
  for (const message of ['Replay available history', 'Backtest strategy history', 'Please replay five-minute history.']) assert.equal(liveIntent(message).kind, 'research');
  for (const message of ["Don't replay available history.", 'Why did you replay available history?', 'Can replaying historical data make money?']) assert.notEqual(liveIntent(message)?.kind, 'research');
});

test('actual /api/chat reads learning without a model and reports failed replay honestly with a trusted receipt', async () => {
  const storage = memoryStorage(); let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls++; return { response: 'I ran 30 winning trades.' }; } } };
  const state = new CheState({ storage }, env); env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const ask = async (message) => (await (await send('/api/chat', { message }, token)).text()).trim().split('\n').map(JSON.parse);
    const read = await ask('Show my strategy learning progress and live readiness.');
    assert.equal(read.at(-1).source, 'che_trading_live');
    assert.equal(read.at(-1).open_screen, 'trading_room');
    assert.equal(storage.saved.get('live_paper_backtest'), undefined);
    const replay = await ask('Replay available history');
    assert.equal(replay.at(-1).source, 'che_trading_live');
    assert.equal(replay.at(-1).ok, false);
    assert.equal(replay.at(-1).execution_receipts[0].status, 'failure');
    assert.match(replay.filter((r) => r.type === 'delta').map((r) => r.delta).join(''), /could not be verified/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('overlapping research windows share immutable candle/outcome chunks and diagnostics use the real attempt time', async () => {
  const { liveBacktest, strategyLearning } = await import('./trading_live.js');
  const storage = memoryStorage(); const bars = [...DAY1, ...DAY2];
  const feed = async () => ({ status: 'REPLAY', interval: '5m', provider: 'fixture', provider_symbol: 'MNQ', candles: bars });
  await liveBacktest(storage, { load: feed, now: after(bars) });
  const first = await storage.list({ prefix: 'live_research_data:' });
  const later = after(bars) + 86400000;
  await liveBacktest(storage, { load: feed, now: later });
  const learning = await strategyLearning(storage, { now: later });
  assert.equal(learning.research.last_attempt, new Date(later).toISOString());
  assert.equal(learning.research.reused, true);
  assert.equal((await storage.list({ prefix: 'live_research_data:' })).size, first.size);
});

test('incremental replay matches a full replay exactly and never double-counts carried outcomes', async () => {
  const { liveBacktest } = await import('./trading_live.js');
  const storage = memoryStorage();
  const firstBars = [...DAY1, ...DAY2.slice(0, 1)];
  const bars = [...DAY1, ...DAY2];
  const load = (rows) => async () => ({ status: 'REPLAY', interval: '5m', provider: 'fixture', provider_symbol: 'MNQ', candles: rows });
  await liveBacktest(storage, { load: load(firstBars), now: after(firstBars) });
  const incremental = await liveBacktest(storage, { load: load(bars), now: after(bars) });
  const full = await liveBacktest(memoryStorage(), { load: load(bars), now: after(bars) });
  assert.equal(incremental.ok, true);
  assert.equal(incremental.incremental, true);
  assert.deepEqual(incremental.rows.map((r) => [r.strategy_version, r.stats]), full.rows.map((r) => [r.strategy_version, r.stats]));
  assert.deepEqual(incremental.dataset_refs, full.dataset_refs);
});

test('research retention keeps every experiment record but only the newest datasets, and bounds logs', async () => {
  const { liveBacktest, pruneResearch, strategyLearning } = await import('./trading_live.js');
  const storage = memoryStorage();
  const load = (rows) => async () => ({ status: 'REPLAY', interval: '5m', provider: 'fixture', provider_symbol: 'MNQ', candles: rows });
  const firstBars = [...DAY1, ...DAY2.slice(0, 1)];
  const bars = [...DAY1, ...DAY2];
  const now = after(bars);
  const first = await liveBacktest(storage, { load: load(firstBars), now: after(firstBars) });
  const second = await liveBacktest(storage, { load: load(bars), now });
  for (let i = 0; i < 55; i++) storage.saved.set(`live_research_run:failed:2026-10-${String(1 + (i % 9)).padStart(2, '0')}T00:${String(i).padStart(2, '0')}:00.000Z`, { ok: false, error: 'offline' });
  storage.saved.set('live_research_seen:v-old:abc', { first_seen: new Date(now - 100 * 86400000).toISOString(), dataset_hash: 'x' });
  storage.saved.set('live_research_seen:v-new:def', { first_seen: new Date(now - 86400000).toISOString(), dataset_hash: 'y' });
  storage.saved.set('live_research_budget:2026-09-01', ['old']);
  const report = await pruneResearch(storage, { now, keep: 1 });
  assert.equal(report.pruned_experiments, 1);
  // The older experiment's metadata and results survive; only its bulk data is released.
  const archived = storage.saved.get(`live_research_run:${first.id}`);
  assert.equal(archived.id, first.id);
  assert.equal(archived.dataset_hash, first.dataset_hash);
  assert.equal(archived.dataset_retained, false);
  assert.deepEqual(archived.dataset_refs, []);
  assert.deepEqual(archived.rows.map((r) => [r.strategy_version, r.stats]), first.rows.map((r) => [r.strategy_version, r.stats]));
  assert.ok(archived.rows.every((r) => r.checkpoint_ref === null && r.outcome_index_ref === null));
  // The newest experiment is fully intact and nothing unreferenced is left behind.
  const kept = storage.saved.get(`live_research_run:${second.id}`);
  assert.deepEqual(kept.dataset_refs, second.dataset_refs);
  for (const ref of kept.dataset_refs) assert.ok(storage.saved.has(ref));
  for (const r of kept.rows) { assert.ok(storage.saved.has(r.checkpoint_ref)); for (const ref of storage.saved.get(r.outcome_index_ref)) assert.ok(storage.saved.has(ref)); }
  assert.deepEqual([...(await storage.list({ prefix: 'live_research_data:' })).keys()].sort(), [...new Set(second.dataset_refs)].sort());
  assert.ok([...(await storage.list({ prefix: 'live_research_checkpoint:' })).keys()].every((k) => k.startsWith(`live_research_checkpoint:${second.id}:`)));
  assert.equal((await storage.list({ prefix: 'live_research_run:failed:' })).size, 50);
  assert.equal(storage.saved.has('live_research_seen:v-old:abc'), false);
  assert.equal(storage.saved.has('live_research_seen:v-new:def'), true);
  assert.equal(storage.saved.has('live_research_budget:2026-09-01'), false);
  // Results and diagnostics still read from the retained records.
  const learning = await strategyLearning(storage, { now });
  assert.equal(learning.research.id, second.id);
  // Reusing the pruned dataset again restores its metadata without re-downloading or re-running.
  const again = await liveBacktest(storage, { load: load(firstBars), now: now + 86400000 });
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
});

test('the deploy probe follows the daily research attempt, not the archived experiment time', async () => {
  const storage = memoryStorage();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' };
  const state = new CheState({ storage }, env);
  await setLivePaper(storage, true);
  // Today's replay reused a three-day-old archive: the attempt is current, the archive is not.
  storage.saved.set('live_paper_backtest', { id: 'archived', ok: true, at: new Date(Date.now() - 3 * 86400000).toISOString(), rows: [] });
  storage.saved.set('live_research_attempt', { at: new Date().toISOString(), status: 'complete', experiment_id: 'archived', reused: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const probe = await state.tradingProbe();
    assert.match(probe.research.skipped, /already recorded/);
    assert.equal(storage.saved.get('live_research_lock'), undefined, 'no historical replay was dispatched');
    assert.equal(storage.saved.get('live_paper_backtest').id, 'archived');
  } finally { globalThis.fetch = realFetch; }
});

test('unverified live, stale and unavailable feeds cannot create new forward-paper entries', async () => {
  for (const override of [{ status: 'LIVE', authenticated: false }, { status: 'LIVE', subscription_verified: false }, { status: 'LIVE', latency_s: 100 }, { status: 'STALE' }, { status: 'UNAVAILABLE' }]) {
    const storage = memoryStorage(); await setLivePaper(storage, true);
    const load = (bars) => async () => ({ ...await feedOf(bars)(), ...override });
    await liveTick(storage, { force: true, load: load(DAY1), now: after(DAY1) });
    const run = await liveTick(storage, { force: true, load: load([...DAY1, ...DAY2]), now: after(DAY2) });
    assert.notEqual(run.entries_allowed, true);
    assert.equal((await readTrades(storage)).length, 0);
  }
});

test('delayed CME bars open paper entries, journalled as delayed and never counted as verified live evidence', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  const delayed = (bars) => async () => ({ ...(await feedOf(bars)()), status: 'DELAYED', authenticated: false, subscription_verified: false, latency_s: null });
  await liveTick(storage, { force: true, load: delayed(DAY1), now: after(DAY1) });
  const run = await liveTick(storage, { force: true, load: delayed([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(run.entries_allowed, true);
  assert.equal(run.entry_quality, 'delayed');
  const trades = await readTrades(storage);
  const sweep = trades.find((t) => t.strategy === 'pdhl-sweep-5m' && t.filter === 'any');
  assert.ok(sweep, 'the delayed sweep setup is a paper trade');
  assert.equal(sweep.environment, 'paper', 'still paper only');
  assert.equal(sweep.data.entry_feed.status, 'DELAYED');
  const dash = await liveDashboard(storage);
  assert.equal(dash.verified_live_forward?.trades ?? 0, 0, 'delayed trades are not verified live evidence');
});

test('a valid setup seen while the feed is not verified is journalled as skipped with its time and reason, never traded', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  const unverified = (bars) => async () => ({ ...(await feedOf(bars)()), authenticated: false });
  await liveTick(storage, { force: true, load: unverified(DAY1), now: after(DAY1) });
  const run = await liveTick(storage, { force: true, load: unverified([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(run.entries_allowed, false);
  assert.equal((await readTrades(storage)).length, 0, 'no trade is opened');
  const portfolio = Object.values((await storage.get(LIVE_PORTFOLIOS)) || {}).find((pf) => pf.candidate === 'pdhl-sweep-5m' && pf.filter === 'any');
  assert.ok(portfolio, 'the portfolio exists');
  const skip = (portfolio.skips || []).find((s) => s.time === DAY2[0].t);
  assert.ok(skip, `the sweep setup is journalled as skipped: ${JSON.stringify(portfolio.skips)}`);
  assert.match(skip.reason, /real-time CME data was not verified/);
});
