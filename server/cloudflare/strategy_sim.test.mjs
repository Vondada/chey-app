import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { SIM_STRATEGIES, MINUTE_FEEDS, NOT_SIMULATED, minuteFeedFor, strategySimTick, nextStrategySimTickAt, readSimState, storeTrades, readStoredTrades, summarize, profitLabel, leaderboard, setStrategySimPaused, setStrategySimCeiling, chargeSpend, assertSpend, closedBars, sessionOf, strategySimView, strategySimIntent, speakStrategySim, TICK_MS, MIN_SAMPLE, TRADE_CAP, OOS_SHARE, HEARTBEAT_MS, STATE_KEY } from './strategy_sim.js';
import { loadCandles, prepareSession, OPENING_MINUTES, SKILL_IDS, strategyById, readBook } from './trading_lab.js';
import { ENVIRONMENTS } from './trading_environments.js';
import { wilsonInterval } from './trading_evidence.js';

// Offline, like the other worker tests: any fetch that is not stubbed by a test fails.
globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

// The worker imports the Cloudflare runtime; a local copy with a stand-in class loads it under Node, as command_center.test.mjs does.
const generated = new URL('./.strategy_sim.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// ─── Fixtures: synthetic minute bars only, no network ────────────────────

const T_START = Date.UTC(2026, 9, 19, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const minuteAt = (i, start = T_START) => iso(start + i * TICK_MS);

// A flat run at 100 (high 100.2, low 99.8), then the scripted bars given in `after` (index from 60).
function flatThen(after, n = 60) {
  const bars = Array.from({ length: n }, (_, i) => ({ t: minuteAt(i), o: 100, h: 100.2, l: 99.8, c: 100, v: 1 }));
  after.forEach((b, k) => bars.push({ t: minuteAt(n + k), v: 1, ...b }));
  return bars;
}

// Deterministic wandering minute series with real breakouts and pullbacks.
function walk(n, { start = T_START, p0 = 60000, seed = 1 } = {}) {
  const out = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    const noise = (Math.sin((i + seed) * 12.9898) * 43758.5453) % 1;
    const drift = Math.sin(i / 23) * 25 + noise * 40;
    const o = p;
    const c = Math.max(1, p + drift);
    out.push({ t: iso(start + i * TICK_MS), o, h: Math.max(o, c) + Math.abs(noise) * 15, l: Math.min(o, c) - Math.abs(noise) * 15, c, v: 10 + Math.abs(noise) * 5 });
    p = c;
  }
  return out;
}

function memStorage(saved = new Map(), alarms = []) {
  return {
    saved,
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    // Durable Object storage: put(key, value) or put(entries), and the entries form is one atomic write.
    put: async (key, value) => {
      if (key !== null && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    setAlarm: async (t) => { alarms.push(t); },
    getAlarm: async () => alarms.at(-1) ?? null,
  };
}

// Every symbol has an explicit loader, so no test reads the shared 60-second cache of trading_lab.js.
// Only BTC has bars in the hand-built fixtures; the rest report no feed.
const noFeed = async () => ({ error: 'no feed in this test' });
const onlyBtc = (candles) => ({ BTCUSDT: async () => ({ candles, status: 'LIVE', source: 'fixture' }), ETHUSDT: noFeed, MNQ: noFeed, NQ: noFeed });
const noNetwork = async () => { throw new Error('the tests make no network call'); };
const nowAfter = (bars) => Date.parse(bars[bars.length - 1].t) + TICK_MS;

// The trade of one strategy, found by id.
const tradesOf = (trades, id) => trades.filter((t) => t.strategy === id);
const CHANNEL = 'channel-20|any|2';

// Hand-built fixture for CHANNEL: break at bar 60 (close 101 over the 20-bar high 100.2),
// fill at bar 61's open (101.0), exit on bar 62.
const BREAK = { o: 100, h: 101.2, l: 99.9, c: 101, v: 1 };
const FILL = { o: 101.0, h: 101.5, l: 100.8, c: 101.2 };
const TARGET_BAR = { o: 101.3, h: 103.5, l: 101.1, c: 103.2 };
const TAIL = { o: 103.2, h: 103.4, l: 103.0, c: 103.2 };

// ─── Strategies and feeds ─────────────────────────────────────────────────

test('ten strategies, each a trading_lab rule, covering breakout, mean reversion, momentum, VWAP and opening range', () => {
  assert.equal(SIM_STRATEGIES.length, 10);
  assert.equal(new Set(SIM_STRATEGIES.map((s) => s.id)).size, 10, 'ids are unique');
  for (const s of SIM_STRATEGIES) {
    assert.ok(strategyById(s.id), `${s.id} resolves to a rule`);
    assert.equal(s.id, `${s.signal}|${s.trend_filter}|${s.target_r}`, 'the id is the parameter set');
  }
  assert.deepEqual([...new Set(SIM_STRATEGIES.map((s) => s.family))].sort(), ['VWAP', 'breakout', 'mean reversion', 'momentum', 'opening range']);
});

test('the hourly learning set is unchanged: the intraday rules stay out of SKILL_IDS', () => {
  assert.equal(SKILL_IDS.length, 63);
  assert.ok(SKILL_IDS.every((id) => !/^(vwap-reclaim|opening-range)\|/.test(id)));
});

test('minute bars exist only for Binance crypto and the delayed Yahoo futures; ES and MES have none', () => {
  assert.deepEqual(Object.keys(MINUTE_FEEDS).sort(), ['BTCUSDT', 'ETHUSDT', 'MNQ']);
  assert.equal(minuteFeedFor('ES'), null);
  assert.equal(minuteFeedFor('MES'), null);
  assert.equal(minuteFeedFor('BTCUSDT').kind, 'binance');
  assert.equal(minuteFeedFor('MNQ').kind, 'yahoo');
  // NQ is the same front month as MNQ: one feed per underlying, so it is not a second feed.
  assert.equal(minuteFeedFor('NQ'), null);
  assert.match(NOT_SIMULATED.find((x) => x.symbols.includes('ES')).why, /daily only/);
  assert.match(NOT_SIMULATED.find((x) => x.symbols.includes('NQ')).why, /same Nasdaq-100 front month/);
  assert.match(MINUTE_FEEDS.MNQ.feed, /delayed/);
});

test('Stooq is never read as minute bars: an interval of 1m on a Stooq symbol answers an error and fetches nothing', async () => {
  let calls = 0;
  const data = await loadCandles('es.f', { interval: '1m', fetcher: async () => { calls += 1; throw new Error('no'); } });
  assert.match(data.error, /market data key/);
  assert.equal(calls, 0);
});

test('a bar still forming is never used: only bars whose minute has ended are closed', () => {
  const bars = walk(5);
  const now = Date.parse(bars[4].t) + 30_000; // bar 4 is still forming
  assert.equal(closedBars(bars, now).length, 4);
  assert.equal(closedBars(bars, Date.parse(bars[4].t) + TICK_MS).length, 5);
});

test('session VWAP restarts each session and the opening range is the first 15 minutes', () => {
  // October 19 is on New York daylight time (UTC-4): 09:30 New York is 13:30 UTC.
  const bars = [
    { t: '2026-10-19T13:29:00Z', o: 1, h: 1, l: 1, c: 1, v: 9 }, // before the open: no session, no VWAP
    { t: '2026-10-19T13:30:00Z', o: 9.5, h: 10, l: 9, c: 9.5, v: 1 }, // open bar: typical price 9.5
    { t: '2026-10-19T13:31:00Z', o: 11, h: 12, l: 11, c: 11.5, v: 3 }, // typical price 11.5, volume 3
    { t: '2026-10-19T13:44:00Z', o: 12.5, h: 13, l: 12, c: 12.5, v: 1 }, // minute 14: still inside the range
    { t: '2026-10-19T13:45:00Z', o: 12.5, h: 13.5, l: 12.4, c: 13.5, v: 1 }, // minute 15: first close above the range high 13
  ];
  const x = prepareSession(bars, (t) => sessionOf('et', t));
  assert.equal(x.sid[0], null);
  assert.equal(x.vwap[0], null);
  assert.equal(x.vwap[1], 9.5);
  assert.equal(x.vwap[2], (9.5 * 1 + 11.5 * 3) / 4, 'volume-weighted over the session so far');
  assert.equal(OPENING_MINUTES, 15);
  assert.equal(x.orHigh[3], null, 'no breakout level while the range is forming');
  assert.equal(x.orHigh[4], 13, 'range high from the 09:30 to 09:44 bars');
  assert.equal(x.orLow[4], 9, 'range low');
  assert.equal(x.orFirstBreak[3], false);
  assert.equal(x.orFirstBreak[4], true, 'the first close above the range high');
});

// ─── Known trades, checked by hand ────────────────────────────────────────

test('a channel breakout fills at the next open, exits at the target, and records entry, exit, R and reason', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, TARGET_BAR, TAIL, TAIL]);
  const saved = new Map();
  const run = await strategySimTick(memStorage(saved), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  assert.equal(run.ran, true);
  const trades = await readStoredTrades(memStorage(saved), (await readSimState(memStorage(saved))).trades);
  const mine = tradesOf(trades, CHANNEL);
  assert.equal(mine.length, 1, 'exactly one channel trade');
  const [t] = mine;
  assert.equal(t.signal_t, minuteAt(60));
  assert.equal(t.entry_t, minuteAt(61), 'fills at the open of the next minute');
  assert.equal(t.exit_t, minuteAt(62));
  assert.equal(t.exit_reason, 'target');
  assert.deepEqual(t.params, { signal: 'channel-20', trend_filter: 'any', target_r: 2 });
  assert.match(t.why, /20-day|20-bar|high 100\.2/);

  // Independent arithmetic: 0.02% slippage per fill, 0.10% commission per side, risk from the open.
  const entry = 101 + 101 * 0.0002;
  const exitPx = 103.4 - 103.4 * 0.0002;
  const fees = (entry + exitPx) * 0.001;
  const risk = 101 - 99.8;
  assert.ok(Math.abs(t.entry - entry) < 1e-9);
  assert.ok(Math.abs(t.exit - exitPx) < 1e-9);
  assert.ok(Math.abs(t.r_gross - 2) < 1e-9, 'gross R is the target distance over the risk');
  assert.ok(Math.abs(t.r - (exitPx - entry - fees) / risk) < 1e-9, 'net R after costs');
  assert.ok(t.r > 1.79 && t.r < 1.80, `net R ${t.r}`);
  assert.ok(Math.abs(t.cost_r - (t.r_gross - t.r)) < 1e-12);
});

test('a stop-out is recorded at the stop plus costs, so its net R is below -1', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, { o: 100.9, h: 101.4, l: 99.5, c: 100.2, v: 1 }, TAIL]);
  const saved = new Map();
  await strategySimTick(memStorage(saved), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const trades = await readStoredTrades(memStorage(saved), (await readSimState(memStorage(saved))).trades);
  const [t] = tradesOf(trades, CHANNEL);
  assert.equal(t.exit_reason, 'stop');
  assert.ok(Math.abs(t.r_gross - -1) < 1e-9, 'gross R is exactly -1 at the stop');
  const exitPx = 99.8 - 99.8 * 0.0002;
  const entry = 101 + 101 * 0.0002;
  const r = (exitPx - entry - (entry + exitPx) * 0.001) / (101 - 99.8);
  assert.ok(Math.abs(t.r - r) < 1e-9);
  assert.ok(t.r < -1, 'costs make a stop-out worse than -1R');
});

test('a bar that touches both the stop and the target exits at the stop (the worst case)', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, { o: 101.3, h: 103.5, l: 99.5, c: 101.2, v: 1 }, TAIL]);
  const saved = new Map();
  await strategySimTick(memStorage(saved), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const trades = await readStoredTrades(memStorage(saved), (await readSimState(memStorage(saved))).trades);
  const [t] = tradesOf(trades, CHANNEL);
  assert.equal(t.exit_reason, 'stop');
});

test('an order that opens beyond its target does not fill and is counted, not traded', async () => {
  const bars = flatThen([{ ...BREAK }, { o: 103.5, h: 103.6, l: 103.4, c: 103.5, v: 1 }, TAIL]);
  const saved = new Map();
  const storage = memStorage(saved);
  await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const state = await readSimState(storage);
  assert.ok(state.counts.not_filled >= 1, 'the gap through the target is counted');
  const trades = await readStoredTrades(storage, state.trades);
  assert.equal(trades.filter((t) => t.signal_t === minuteAt(60)).length, 0);
});

test('a signal with no next minute bar expires unfilled', async () => {
  // The bar after the signal comes two minutes later, so no minute bar exists in between.
  const bars = flatThen([{ ...BREAK }]);
  bars.push({ t: minuteAt(62), o: 101, h: 101.5, l: 100.8, c: 101.2, v: 1 });
  const saved = new Map();
  const storage = memStorage(saved);
  await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const state = await readSimState(storage);
  // Several strategies signal on the break bar; each of their orders expires, so the count is at least one.
  assert.ok(state.counts.expired >= 1, `expired ${state.counts.expired}`);
  const trades = await readStoredTrades(storage, state.trades);
  assert.equal(trades.filter((t) => t.signal_t === minuteAt(60) && t.strategy === CHANNEL).length, 0, 'the expired channel order is not a trade');
});

test('a tick that reads the same bars twice, or the bars in two runs, gives the same trades as one run', async () => {
  const bars = walk(1200, { seed: 3 });
  const oneSaved = new Map();
  await strategySimTick(memStorage(oneSaved), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const oneStore = memStorage(oneSaved);
  const once = await readStoredTrades(oneStore, (await readSimState(oneStore)).trades);

  const twoSaved = new Map();
  const twoStore = memStorage(twoSaved);
  await strategySimTick(twoStore, { now: Date.parse(bars[599].t) + TICK_MS, fetcher: noNetwork, loaders: onlyBtc(bars.slice(0, 600)) });
  await strategySimTick(twoStore, { force: true, now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  await strategySimTick(twoStore, { force: true, now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const twice = await readStoredTrades(twoStore, (await readSimState(twoStore)).trades);
  assert.ok(once.length > 3, `enough trades to compare (${once.length})`);
  assert.deepEqual(twice.map((t) => t.id), once.map((t) => t.id));
  assert.deepEqual(twice.map((t) => t.r), once.map((t) => t.r));
});

test('no trade is entered before its signal bar has closed, and every trade is a long with stop below entry', async () => {
  const bars = walk(1500, { seed: 7 });
  const saved = new Map();
  await strategySimTick(memStorage(saved), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const store = memStorage(saved);
  const trades = await readStoredTrades(store, (await readSimState(store)).trades);
  assert.ok(trades.length > 5);
  for (const t of trades) {
    assert.equal(Date.parse(t.entry_t) - Date.parse(t.signal_t), TICK_MS, 'filled on the next minute');
    assert.ok(t.stop < t.entry_raw && t.entry_raw < t.target + 1e-9, 'stop below the open, open below target');
    assert.ok(Date.parse(t.exit_t) >= Date.parse(t.entry_t));
  }
});

// ─── Leaderboard and the profitable rule ──────────────────────────────────

test('leaderboard numbers equal an independent recomputation from the stored trades', async () => {
  const bars = walk(3000, { seed: 11 });
  const eth = walk(3000, { seed: 19, p0: 2500 });
  const saved = new Map();
  const storage = memStorage(saved);
  await strategySimTick(storage, {
    now: nowAfter(bars), fetcher: noNetwork,
    loaders: { BTCUSDT: async () => ({ candles: bars, status: 'LIVE' }), ETHUSDT: async () => ({ candles: eth, status: 'LIVE' }) },
  });
  const state = await readSimState(storage);
  const trades = await readStoredTrades(storage, state.trades);
  const board = leaderboard(trades, state.symbols);
  assert.equal(board.length, 10);

  // Independent: wins, losses, win rate, expectancy, drawdown in exit order, Wilson, and the newest-30% window.
  const cuts = Object.fromEntries(Object.entries(state.symbols).map(([s, v]) => {
    const first = Date.parse(v.first_t); const last = Date.parse(v.last_t);
    return [s, first + 0.7 * (last - first)];
  }));
  for (const row of board) {
    const mine = trades.filter((t) => t.strategy === row.id);
    const n = mine.length;
    const wins = mine.filter((t) => t.r > 0).length;
    const sum = mine.reduce((a, t) => a + t.r, 0);
    const ordered = [...mine].sort((a, b) => Date.parse(a.exit_t) - Date.parse(b.exit_t));
    let eq = 0; let peak = 0; let dd = 0;
    for (const t of ordered) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const oos = mine.filter((t) => Date.parse(t.entry_t) >= cuts[t.symbol]);
    assert.equal(row.trades, n, row.id);
    assert.equal(row.wins, wins, row.id);
    assert.equal(row.losses, n - wins, row.id);
    if (n) {
      assert.ok(Math.abs(row.win_rate - wins / n) < 1e-12, row.id);
      assert.ok(Math.abs(row.expectancy_r - sum / n) < 1e-9, row.id);
      assert.ok(Math.abs(row.max_drawdown_r - dd) < 0.01, `${row.id} drawdown ${row.max_drawdown_r} vs ${dd}`);
      const w = wilsonInterval(wins, n);
      assert.ok(Math.abs(row.wilson_95.low - w.low) < 1e-12 && Math.abs(row.wilson_95.high - w.high) < 1e-12, row.id);
    }
    assert.equal(row.sample_size, oos.length, `${row.id} out-of-sample sample`);
    assert.equal(row.label, profitLabel(summarize(oos)).label);
    assert.ok(['profitable', 'not proven yet'].includes(row.label));
    if (row.label === 'profitable') assert.ok(row.sample_size >= MIN_SAMPLE && row.out_of_sample.expectancy_r > 0);
  }
  assert.ok(board.some((row) => row.trades > 0), 'some strategy traded');
});

// Synthetic trades for the label rule: wins at +winR, losses at -1R, in a fixed order.
// Exactly floor(n * winRate) wins, spread evenly through the list.
function trades(n, winRate, winR) {
  return Array.from({ length: n }, (_, i) => {
    const won = Math.floor((i + 1) * winRate) > Math.floor(i * winRate);
    return { id: `t${i}`, symbol: 'BTCUSDT', strategy: 'x', r: won ? winR : -1, entry_t: iso(T_START + i * 60000), exit_t: iso(T_START + i * 60000 + 30000) };
  });
}

test('profitable needs a positive out-of-sample edge on a large sample', () => {
  const v = profitLabel(summarize(trades(100, 0.6, 2)));
  assert.equal(v.label, 'profitable', v.reasons.join('; '));
  assert.deepEqual(v.reasons, []);
});

test('a small sample is "not proven yet", even with a strong edge', () => {
  const v = profitLabel(summarize(trades(20, 0.6, 2)));
  assert.equal(v.label, 'not proven yet');
  assert.ok(v.reasons.some((x) => /sample 20 out-of-sample trades, need 30/.test(x)));
});

test('a Wilson lower bound below break-even is "not proven yet", with the reason', () => {
  // 20 wins of +1R and 16 losses of -1R: expectancy is positive, but break-even is 50%.
  const fixture = [...Array.from({ length: 20 }, () => 1), ...Array.from({ length: 16 }, () => -1)].map((r, i) => ({ id: `w${i}`, symbol: 'BTCUSDT', strategy: 'x', r, entry_t: iso(T_START + i * 60000), exit_t: iso(T_START + i * 60000 + 30000) }));
  const oos = summarize(fixture);
  assert.ok(oos.expectancy_r > 0);
  assert.ok(oos.wilson_low < oos.break_even_win_rate);
  const v = profitLabel(oos);
  assert.equal(v.label, 'not proven yet');
  assert.ok(v.reasons.some((x) => /Wilson 95% lower bound .* not above break-even/.test(x)));
});

test('negative expectancy on a large sample is "not proven yet"', () => {
  const v = profitLabel(summarize(trades(100, 0.35, 1.5)));
  assert.equal(v.label, 'not proven yet');
  assert.ok(v.reasons.some((x) => /expectancy after costs is -0\.125 R/.test(x)));
});

test('break-even win rate is the average loss over the average win plus loss, after costs', () => {
  const s = summarize(trades(100, 0.6, 2));
  assert.ok(Math.abs(s.break_even_win_rate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.expectancy_r - 0.8) < 1e-9);
});

test('the out-of-sample flag starts at the frozen cut: 70% of the first window is in sample', () => {
  const symbols = { BTCUSDT: { first_t: iso(T_START), last_t: iso(T_START + 1000 * 60000), oos_from: iso(T_START + 700 * 60000), bars: 1000 } };
  const cut = T_START + (1 - OOS_SHARE) * 1000 * 60000; // minute 700
  const mk = (id, minute) => ({ id, symbol: 'BTCUSDT', strategy: 'channel-20|any|2', r: 1, entry_t: iso(T_START + minute * 60000), exit_t: iso(T_START + (minute + 1) * 60000) });
  const list = [mk('a', 600), mk('b', 699), mk('c', 700), mk('d', 800), mk('e', 900)];
  assert.equal(cut, T_START + 700 * 60000);
  const row = leaderboard(list, symbols).find((r) => r.id === 'channel-20|any|2');
  assert.equal(row.trades, 5);
  assert.equal(row.sample_size, 3, 'minute 700 and later are out of sample');
});

// ─── Caps, storage and spend ───────────────────────────────────────────────

test('the trade cap drops the oldest chunk and counts every dropped trade', async () => {
  const saved = new Map();
  const storage = memStorage(saved);
  const meta = { first: 0, last: -1, tail: 0, stored: 0, dropped: 0 };
  const made = Array.from({ length: 350 }, (_, i) => ({ id: `t${i}`, r: 0 }));
  await storeTrades(storage, meta, made, { cap: 250, chunk: 100 });
  assert.equal(meta.stored, 250);
  assert.equal(meta.dropped, 100);
  assert.equal(meta.stored + meta.dropped, 350, 'every trade is kept or counted');
  const kept = await readStoredTrades(storage, meta);
  assert.equal(kept[0].id, 't100', 'the oldest chunk went');
  assert.equal(kept.at(-1).id, 't349', 'the newest trade is kept');
  assert.equal(saved.has('strategy_sim_trades:0'), false, 'the dropped chunk is deleted');
});

test('the default cap is 5,000 stored trades', () => {
  assert.equal(TRADE_CAP, 5000);
});

test('kill switch: a paused tick does nothing and records a marker; resume runs again', async () => {
  const bars = walk(200, { seed: 5 });
  const saved = new Map();
  const storage = memStorage(saved);
  let reads = 0;
  const loaders = { BTCUSDT: async () => { reads += 1; return { candles: bars, status: 'LIVE' }; } };
  await setStrategySimPaused(storage, true, nowAfter(bars));
  const paused = await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders });
  assert.equal(paused.paused, true);
  assert.equal(reads, 0, 'no bars read while paused');
  const state = await readSimState(storage);
  assert.match(state.last_paused_marker.note, /Paused by the owner/);
  assert.equal(await nextStrategySimTickAt(storage, nowAfter(bars)), null, 'nothing is scheduled while paused');
  assert.equal((await strategySimView(storage)).status, 'paused');

  await setStrategySimPaused(storage, false, nowAfter(bars));
  const resumed = await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders });
  assert.equal(resumed.ran, true);
  assert.ok(reads >= 1);
  assert.notEqual(await nextStrategySimTickAt(storage, nowAfter(bars)), null);
});

test('daily spend ceiling is read and enforced at every tick, and it resets each UTC day', async () => {
  const bars = walk(120, { seed: 2 });
  const now = nowAfter(bars);
  const saved = new Map();
  const storage = memStorage(saved);
  const loaders = { BTCUSDT: async () => ({ candles: bars, status: 'LIVE' }) };
  let reads = 0;
  const counting = { BTCUSDT: async (s) => { reads += 1; return loaders.BTCUSDT(s); } };
  saved.set('strategy_sim_state', { spend: { ceiling_usd: 0.25, day: new Date(now).toISOString().slice(0, 10), spent_usd: 0.5 } });
  const blocked = await strategySimTick(storage, { now, fetcher: noNetwork, loaders: counting });
  assert.match(blocked.blocked, /daily spend ceiling/);
  assert.equal(reads, 0);

  // Yesterday's spend does not count today.
  // A new handle reads the saved state, as after a restart.
  saved.set('strategy_sim_state', { spend: { ceiling_usd: 0.25, day: '2026-10-18', spent_usd: 0.5 } });
  const nextDay = await strategySimTick(memStorage(saved), { now, fetcher: noNetwork, loaders: counting });
  assert.equal(nextDay.ran, true);

  assert.equal(assertSpend({ ceiling_usd: 0, spent_usd: 0 }, 0).allowed, true, 'the default: no spend, no block');
  assert.equal(assertSpend({ ceiling_usd: 0, spent_usd: 0 }, 0.01).allowed, false, 'a planned cost above the ceiling is refused');
});

test('the owner ceiling input is validated', async () => {
  const storage = memStorage();
  assert.equal((await setStrategySimCeiling(storage, -1)).ok, false);
  assert.equal((await setStrategySimCeiling(storage, 'lots')).ok, false);
  const ok = await setStrategySimCeiling(storage, 2.5);
  assert.equal(ok.ok, true);
  assert.equal((await readSimState(storage)).spend.ceiling_usd, 2.5);
});

// ─── Paper only: zero broker and zero model calls ────────────────────────

test('a tick makes zero broker and zero model calls and only reads Binance and Yahoo', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return new Response('not found', { status: 404 });
  };
  const saved = new Map();
  await strategySimTick(memStorage(saved), { now: Date.now(), fetcher });
  const hosts = [...new Set(calls.map((u) => new URL(u).hostname))];
  assert.ok(calls.length >= 4, `the tick did read its feeds (${calls.length} requests)`);
  assert.ok(hosts.includes('api.binance.com') && hosts.includes('query1.finance.yahoo.com'), 'Binance and Yahoo were the feeds');
  for (const host of hosts) assert.ok(['api.binance.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com'].includes(host), `unexpected host ${host}`);
  assert.ok(!calls.some((u) => /anthropic|openai|workers\.ai|alpaca|tradovate|ninjatrader|rithmic|stripe|twilio/i.test(u)));
  assert.equal(ENVIRONMENTS.paper.submitsOrders, false);
  assert.equal(ENVIRONMENTS.paper.moneyAtRisk, false);
});

test('the simulation module imports no broker or model code and holds no URL of its own', () => {
  const source = readFileSync(new URL('./strategy_sim.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./market_feed.js', './trading_environments.js', './trading_evidence.js', './trading_lab.js']);
  assert.doesNotMatch(source, /https?:\/\//, 'URLs live in the existing market paths only');
});

test('before its first pass the simulation arms no alarm, so existing alarm times do not move', async () => {
  const storage = memStorage();
  assert.equal(await nextStrategySimTickAt(storage, T_START), null);
  await strategySimTick(storage, { now: T_START + 1000 * TICK_MS, fetcher: noNetwork, loaders: onlyBtc([]) });
  assert.equal(await nextStrategySimTickAt(storage, T_START), T_START + 1001 * TICK_MS, 'after the first pass, the next minute');
  await setStrategySimPaused(storage, true, T_START);
  assert.equal(await nextStrategySimTickAt(storage, T_START), null, 'paused: nothing armed');
});

// ─── Alarm: one slot, the minute tick and the hourly learning tick both kept ───

// The world the alarm test reads: a minute series that ends at "now", daily history, and futures.
// T0 is the next whole minute, so the 1,000 bars all close by T0 and the alarm sees T0 as "now".
const T0 = (Math.floor(Date.now() / TICK_MS) + 1) * TICK_MS;
const worldBars = walk(1000, { start: T0 - 1000 * TICK_MS, seed: 4 });
function worldFetch(url) {
  const u = String(url);
  const bodyJson = (rows) => new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.binance.com') && u.includes('interval=1m')) {
    return bodyJson(worldBars.map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]));
  }
  if (u.includes('api.binance.com') && u.includes('interval=1d')) {
    return bodyJson(Array.from({ length: 300 }, (_, i) => [Date.UTC(2025, 0, 1) + i * 86400000, 100 + i * 0.3, 102 + i * 0.3, 98 + i * 0.3, 100 + i * 0.3 + Math.sin(i) * 2, 1]));
  }
  if (u.includes('stooq.com')) {
    const rows = Array.from({ length: 300 }, (_, i) => `${new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10)},${100 + i * 0.3},${102 + i * 0.3},${98 + i * 0.3},${100 + i * 0.3 + Math.sin(i) * 2},1`);
    return new Response(`date,open,high,low,close,volume\n${rows.join('\n')}`, { status: 200 });
  }
  if (u.includes('finance.yahoo.com')) {
    const last = Date.parse(worldBars[worldBars.length - 1].t);
    return bodyJson({
      chart: { error: null, result: [{
        meta: { symbol: 'MNQ=F', exchangeName: 'CME', exchangeDataDelayedBy: 10, regularMarketTime: (last + TICK_MS) / 1000 },
        timestamp: worldBars.map((b) => Date.parse(b.t) / 1000),
        indicators: { quote: [{ open: worldBars.map((b) => b.o), high: worldBars.map((b) => b.h), low: worldBars.map((b) => b.l), close: worldBars.map((b) => b.c), volume: worldBars.map((b) => b.v) }] },
      }] },
    });
  }
  return new Response('not found', { status: 404 });
}

test('alarm: the minute tick and the hourly learning tick both run, and both stay scheduled after a run', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => worldFetch(url);
  try {
    const alarms = [];
    const saved = new Map();
    const storage = memStorage(saved, alarms);
    const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'unused' }) } };
    const state = new CheState({ storage, waitUntil: () => {} }, env);

    await state.tradingTick({ now: T0 });
    assert.equal((await readSimState(storage)).last_tick, iso(T0), 'the minute tick ran');
    assert.equal((await readBook(storage)).last_tick, iso(T0), 'the hourly tick ran');
    assert.ok(Object.keys((await readBook(storage)).lab).length > 0, 'the hourly learning step ran');
    await state.scheduleWork();
    assert.equal(alarms.at(-1), T0 + TICK_MS, 'the alarm waits for the next minute');
    // Both real feed paths produced minute bars offline: Binance live, Yahoo futures delayed.
    const sim = await readSimState(storage);
    assert.equal(sim.symbols.BTCUSDT.feed.status, 'LIVE');
    assert.equal(sim.symbols.MNQ.feed.status, 'DELAYED');
    assert.ok(sim.symbols.BTCUSDT.bars > 500 && sim.symbols.MNQ.bars > 500, `minute bars processed: BTC ${sim.symbols.BTCUSDT.bars}, MNQ ${sim.symbols.MNQ.bars}`);

    // One minute later: the minute tick runs again; the hourly tick is not due yet.
    await state.tradingTick({ now: T0 + TICK_MS });
    assert.equal((await readSimState(storage)).last_tick, iso(T0 + TICK_MS));
    assert.equal((await readBook(storage)).last_tick, iso(T0));
    await state.scheduleWork();
    assert.equal(alarms.at(-1), T0 + 2 * TICK_MS);

    // An hour on: both are due. After the run, the next minute and the next hour are both scheduled.
    await state.tradingTick({ now: T0 + 61 * TICK_MS });
    assert.equal((await readBook(storage)).last_tick, iso(T0 + 61 * TICK_MS), 'the hourly tick ran on time');
    await state.scheduleWork();
    assert.equal(alarms.at(-1), T0 + 62 * TICK_MS, 'the earliest of the two is the next minute');
    assert.equal(await nextStrategySimTickAt(storage, T0 + 61 * TICK_MS), T0 + 62 * TICK_MS);
    const hourly = Date.parse((await readBook(storage)).last_tick) + 60 * 60_000;
    assert.equal(hourly, T0 + 121 * TICK_MS, 'the next hourly tick is still an hour later');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── Storage writes, restarts, and GitHub on the minute-only wake-up ─────────

// Quiet flat bars that end before `now`: no signal, so no trade on any strategy. The range (99.5 to 100.5)
// is exact in binary, so the session VWAP is exactly 100 and does not wobble on rounding.
function flatBars(now, n = 200) {
  return Array.from({ length: n }, (_, i) => ({ t: iso(now - (n - i) * TICK_MS), o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }));
}

// A storage handle that records every key it writes.
function countingStorage(saved, log) {
  const base = memStorage(saved);
  return {
    ...base,
    put: async (key, value) => {
      if (key !== null && typeof key === 'object') for (const k of Object.keys(key)) log.push(k);
      else log.push(key);
      return base.put(key, value);
    },
    delete: async (key) => { log.push(`delete:${key}`); return base.delete(key); },
  };
}

test('a simulated day with no trades writes the state at most every 15 minutes, well under 300 writes', async () => {
  const saved = new Map();
  const writes = [];
  const storage = countingStorage(saved, writes);
  const start = T_START;
  for (let k = 0; k < 1440; k++) {
    const now = start + (k + 1) * TICK_MS;
    const quiet = flatBars(now);
    const run = await strategySimTick(storage, { now, fetcher: noNetwork, loaders: onlyBtc(quiet) });
    assert.equal(run.ran, true, `minute ${k}`);
    assert.equal(run.opened + run.closed, 0, `minute ${k}: no trade`);
  }
  const stateWrites = writes.filter((key) => key === STATE_KEY).length;
  const otherWrites = writes.filter((key) => key !== STATE_KEY).length;
  const state = await readSimState(storage);
  assert.equal(state.ticks, 1440);
  assert.equal(state.trades.stored, 0);
  assert.equal(otherWrites, 0, 'no trade chunk is written when nothing trades');
  assert.ok(stateWrites < 300, `state writes in a day: ${stateWrites}`);
  assert.equal(stateWrites, 1440 / 15, `one heartbeat every ${HEARTBEAT_MS / 60_000} minutes: ${stateWrites}`);
});

test('a restart replays from the last save and gives the same trades as an uninterrupted run', async () => {
  const bars = walk(1500, { seed: 13 });
  const once = new Map();
  await strategySimTick(memStorage(once), { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const whole = await readStoredTrades(memStorage(once), (await readSimState(memStorage(once))).trades);

  // The first half, then a restart: a new handle reads the last save and replays the rest.
  const split = new Map();
  await strategySimTick(memStorage(split), { now: Date.parse(bars[899].t) + TICK_MS, fetcher: noNetwork, loaders: onlyBtc(bars.slice(0, 900)) });
  await strategySimTick(memStorage(split), { force: true, now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const restarted = memStorage(split);
  const after = await readStoredTrades(restarted, (await readSimState(restarted)).trades);
  assert.ok(whole.length > 3, `enough trades to compare (${whole.length})`);
  assert.deepEqual(after.map((t) => t.id), whole.map((t) => t.id), 'no trade repeated or lost');
  assert.deepEqual(after.map((t) => t.r), whole.map((t) => t.r));
});

test('minute-only wake-up: no GitHub or model call; an hourly wake-up still checks the mailbox', async () => {
  const realFetch = globalThis.fetch;
  const github = [];
  const models = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (/api\.github\.com/.test(url)) {
      github.push(`${init?.method || 'GET'} ${url}`);
      return new Response(JSON.stringify({ object: { sha: 'abc123' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return worldFetch(url);
  };
  try {
    const saved = new Map();
    const alarms = [];
    const storage = memStorage(saved, alarms);
    const env = {
      CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'ghp_test_only', CHE_GITHUB_REPO: 'Vondada/chey-app',
      AI: { run: async (...args) => { models.push(args); return { response: 'unused' }; } },
    };
    const state = new CheState({ storage, waitUntil: () => {} }, env);
    // The hourly and minute passes ran a minute ago, so the next wake-up is minute-only.
    const earlier = Date.now() - TICK_MS;
    await state.tradingTick({ now: earlier, force: true });
    assert.equal((await readBook(storage)).last_tick, iso(earlier));

    github.length = 0;
    await state.alarm();
    assert.deepEqual(github, [], 'a minute-only wake-up makes no GitHub request');
    assert.deepEqual(models, [], 'and no model call');
    assert.ok(Date.parse((await readSimState(storage)).last_tick) > earlier, 'the minute pass still ran');
    assert.equal((await readBook(storage)).last_tick, iso(earlier), 'the hourly pass did not run');

    // An hourly wake-up: the hourly pass is due, so the full alarm runs, including the mailbox check.
    await state.tradingTick({ now: Date.now() - 61 * 60_000, force: true });
    github.length = 0;
    await state.alarm();
    assert.ok(github.length >= 1, 'the hourly wake-up made its requests');
    assert.ok(github.some((line) => /\/git\/ref\/heads\//.test(line)), `mailbox head checked: ${github.join(', ')}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── Review blockers: pause during a load, one feed per underlying, one atomic write, spend, the frozen cut, intent ───

test('a pause that lands during a feed load stops the pass: no trade opens after the pause', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, TARGET_BAR, TAIL, TAIL]);
  const saved = new Map();
  const storage = memStorage(saved);
  const loaders = {
    BTCUSDT: async () => {
      await setStrategySimPaused(storage, true, nowAfter(bars));
      return { candles: bars, status: 'LIVE' };
    },
    ETHUSDT: noFeed,
    MNQ: noFeed,
  };
  const run = await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders });
  assert.equal(run.paused, true);
  assert.equal(run.opened, 0, 'nothing opened after the pause');
  const state = await readSimState(storage);
  assert.deepEqual(state.open, {}, 'no open position');
  assert.deepEqual(state.pending, {}, 'no pending order');
  assert.equal(state.trades.stored, 0);
  assert.equal(state.symbols.BTCUSDT.bars, 0, 'the paused feed was not used');
  assert.match(state.last_paused_marker.note, /during a pass/);
});

test('a pause between two feeds keeps what finished before it and reads nothing after it', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, TARGET_BAR, TAIL, TAIL]);
  const saved = new Map();
  const storage = memStorage(saved);
  let mnqReads = 0;
  const loaders = {
    BTCUSDT: async () => ({ candles: bars, status: 'LIVE' }),
    ETHUSDT: async () => {
      await setStrategySimPaused(storage, true, nowAfter(bars));
      return { candles: walk(200, { seed: 5 }), status: 'LIVE' };
    },
    MNQ: async () => { mnqReads += 1; return { candles: walk(200, { seed: 6 }), status: 'DELAYED' }; },
  };
  const run = await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders });
  assert.equal(run.paused, true);
  assert.equal(mnqReads, 0, 'no feed is read after the pause');
  const state = await readSimState(storage);
  assert.ok(state.trades.stored >= 1, 'the BTC trade that closed before the pause is kept');
  assert.equal(state.symbols.ETHUSDT.bars, 0);
});

test('MNQ and NQ are one front month: NQ is never read, and identical bars are never counted twice', async () => {
  const bars = walk(1200, { seed: 17 });
  const feedMNQ = async () => ({ candles: bars, status: 'DELAYED', source: 'fixture' });
  const solo = new Map();
  await strategySimTick(memStorage(solo), { now: nowAfter(bars), fetcher: noNetwork, loaders: { BTCUSDT: noFeed, ETHUSDT: noFeed, MNQ: feedMNQ } });
  const soloStore = memStorage(solo);
  const soloTrades = await readStoredTrades(soloStore, (await readSimState(soloStore)).trades);
  let nqReads = 0;
  const both = new Map();
  await strategySimTick(memStorage(both), { now: nowAfter(bars), fetcher: noNetwork, loaders: { BTCUSDT: noFeed, ETHUSDT: noFeed, MNQ: feedMNQ, NQ: async () => { nqReads += 1; return feedMNQ(); } } });
  const bothStore = memStorage(both);
  const bothTrades = await readStoredTrades(bothStore, (await readSimState(bothStore)).trades);
  assert.ok(soloTrades.length > 0, 'the fixture trades');
  assert.equal(nqReads, 0, 'NQ is never read');
  assert.equal(bothTrades.length, soloTrades.length, 'the same trades, counted once');
  assert.ok(bothTrades.every((t) => t.symbol === 'MNQ'));
});

test('identical MNQ and NQ trades count once: 15 real trades stay "not proven yet" at sample 15', () => {
  const t0 = T_START;
  const mk = (symbol, i) => ({ id: `${symbol}-${i}`, symbol, strategy: 'channel-20|any|2', r: 2, entry_t: iso(t0 + (1000 + i) * 60000), exit_t: iso(t0 + (1001 + i) * 60000) });
  const real = Array.from({ length: 15 }, (_, i) => mk('MNQ', i));
  const copies = Array.from({ length: 15 }, (_, i) => mk('NQ', i));
  const window = { first_t: iso(t0), last_t: iso(t0 + 2000 * 60000), oos_from: iso(t0 + 700 * 60000), bars: 1900 };
  const row = leaderboard([...real, ...copies], { MNQ: window, NQ: window }).find((r) => r.id === 'channel-20|any|2');
  assert.equal(row.trades, 15, 'the NQ copies add nothing');
  assert.equal(row.sample_size, 15);
  assert.equal(row.label, 'not proven yet');
  assert.ok(row.reasons.some((x) => /sample 15 out-of-sample trades, need 30/.test(x)));
});

test('the out-of-sample cut is frozen: watching more time does not move a trade between in and out of sample', () => {
  const t0 = T_START;
  const mk = (minute) => ({ id: `t${minute}`, symbol: 'MNQ', strategy: 'channel-20|any|2', r: 1, entry_t: iso(t0 + minute * 60000), exit_t: iso(t0 + (minute + 1) * 60000) });
  const list = [mk(100), mk(600), mk(700), mk(900), mk(1500)];
  const watched = (last) => ({ MNQ: { first_t: iso(t0), last_t: iso(t0 + last * 60000), oos_from: iso(t0 + 700 * 60000), bars: last } });
  const counts = [1000, 2000, 5000].map((last) => leaderboard(list, watched(last)).find((r) => r.id === 'channel-20|any|2').sample_size);
  assert.deepEqual(counts, [3, 3, 3], 'minutes 700, 900 and 1500 are out of sample at every horizon');
});

test('a closed trade and the state that records it are one storage write, so a restart cannot repeat the close', async () => {
  const bars = flatThen([{ ...BREAK }, FILL, TARGET_BAR, TAIL, TAIL]);
  const saved = new Map();
  const base = memStorage(saved);
  const calls = [];
  const storage = { ...base, put: async (key, value) => { calls.push(key !== null && typeof key === 'object' ? Object.keys(key) : [key]); return base.put(key, value); } };
  await strategySimTick(storage, { now: nowAfter(bars), fetcher: noNetwork, loaders: onlyBtc(bars) });
  const atomic = calls.find((keys) => keys.includes(STATE_KEY) && keys.some((k) => k.startsWith('strategy_sim_trades:')));
  assert.ok(atomic, `one write holds the chunk and the state: ${JSON.stringify(calls)}`);
});

test('spend is charged to the day ledger, and a tick is blocked once the day passes the ceiling', async () => {
  const bars = walk(120, { seed: 2 });
  const now = nowAfter(bars);
  const storage = memStorage(new Map());
  await setStrategySimCeiling(storage, 0.25, now);
  assert.equal((await chargeSpend(storage, 0.1, now)).within_ceiling, true);
  const big = await chargeSpend(storage, 0.5, now);
  assert.equal(big.spent_usd, 0.6);
  assert.equal(big.within_ceiling, false);
  let reads = 0;
  const blocked = await strategySimTick(storage, { now, fetcher: noNetwork, loaders: { BTCUSDT: async () => { reads += 1; return { candles: bars, status: 'LIVE' }; }, ETHUSDT: noFeed, MNQ: noFeed } });
  assert.match(blocked.blocked, /daily spend ceiling/);
  assert.equal(reads, 0, 'no bars read over the ceiling');
  assert.equal((await chargeSpend(storage, -1, now)).ok, false);
  assert.equal((await chargeSpend(storage, '1', now)).ok, false);
});

test('the ceiling accepts only a number: strings, null, booleans and missing values are refused', async () => {
  const storage = memStorage();
  for (const bad of ['5', null, true, undefined, NaN, [5]]) assert.equal((await setStrategySimCeiling(storage, bad)).ok, false, `refused ${String(bad)}`);
  assert.equal((await setStrategySimCeiling(storage, 5)).ok, true);
});

test('typed and spoken requests: pause and resume need the command or an imperative; a question is a status read', async () => {
  assert.deepEqual(strategySimIntent('Strategy simulation pause'), { kind: 'pause' });
  assert.deepEqual(strategySimIntent('strategy simulation resume'), { kind: 'resume' });
  assert.deepEqual(strategySimIntent("Strategy simulation Joe's Barbershop in Phoenix"), { kind: 'status' });
  assert.deepEqual(strategySimIntent('Pause the strategy simulation, please'), { kind: 'pause' });
  assert.deepEqual(strategySimIntent('Resume the strategy simulation'), { kind: 'resume' });
  assert.deepEqual(strategySimIntent('Is the strategy simulation paused?'), { kind: 'status' });
  assert.equal(strategySimIntent('backtest bitcoin'), null);
  const text = speakStrategySim(await strategySimView(memStorage()));
  assert.match(text, /The strategy simulation is running/);
  assert.match(text, /profitable: 0 of 10/);
});

// ─── Owner routes: read and the kill switch are owner-only ───────────────

test('owner routes: a guest is refused, the owner reads, pauses, resumes and sets the ceiling', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => worldFetch(url);
  try {
    const saved = new Map();
    const alarms = [];
    const storage = memStorage(saved, alarms);
    let aiCalls = 0;
    const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'unused' }; } } };
    const state = new CheState({ storage, waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;

    // Without a paired owner device the worker refuses (401 unpaired, 403 for a non-owner profile).
    const refused = [401, 403];
    assert.ok(refused.includes((await send('/api/trading/sim', {}, '', 'GET')).status), 'a guest cannot read');
    assert.ok(refused.includes((await send('/api/trading/sim', { action: 'pause' }, '')).status), 'a guest cannot pause');
    assert.equal((await readSimState(storage)).paused, false, 'the refused pause changed nothing');

    const view = await (await send('/api/trading/sim', {}, token, 'GET')).json();
    assert.equal(view.paper_only, true);
    assert.equal(view.model_calls, 0);
    assert.equal(view.leaderboard.length, 10);

    const paused = await (await send('/api/trading/sim', { action: 'pause' }, token)).json();
    assert.equal(paused.state.paused, true);
    assert.equal(paused.view.status, 'paused');
    const resumed = await (await send('/api/trading/sim', { action: 'resume' }, token)).json();
    assert.equal(resumed.view.status, 'running');

    const ceiling = await (await send('/api/trading/sim', { action: 'ceiling', usd: 0.5 }, token)).json();
    assert.equal(ceiling.ok, true);
    assert.equal((await send('/api/trading/sim', { action: 'ceiling', usd: -2 }, token)).status, 400);
    assert.equal((await send('/api/trading/sim', { action: 'buy' }, token)).status, 400, 'no other action exists');

    const ticked = await (await send('/api/trading/sim', { action: 'tick' }, token)).json();
    assert.equal(ticked.run.ran, true);
    assert.equal(aiCalls, 0, 'no model call in any simulation route');
    assert.ok(alarms.length >= 1, 'resume re-armed the alarm');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the simulation view says what each minute bar is, and what it is not', async () => {
  const view = await strategySimView(memStorage());
  assert.match(view.basis, /1-minute bars/);
  assert.equal(view.leaderboard[0].bars, '1-minute bars');
  const byName = Object.fromEntries(view.minute_bars.map((b) => [b.symbol, b]));
  assert.match(byName.BTCUSDT.source, /Binance/);
  assert.match(byName.MNQ.source, /Yahoo/);
  assert.equal(byName.BTCUSDT.bars, '1-minute bars');
  assert.ok(!view.minute_bars.some((b) => /ES|MES/.test(b.symbol)), 'no ES or MES minute row');
  assert.match(view.not_simulated.find((x) => x.symbols.includes('ES')).why, /daily only/);
  assert.ok(view.notes.some((n) => /Paper only/.test(n)));
});
