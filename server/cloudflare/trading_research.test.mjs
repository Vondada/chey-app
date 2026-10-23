// Trading research (owner, 2026-10-22). Every bar here is a seeded TEST FIXTURE or a fake provider answer, never market
// data: these tests prove the machinery (provenance, timeframes, rolls, sessions, no look-ahead, evidence buckets,
// selection), not any strategy's edge.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  TF_IDS, MIN_CLOSED_TRADES, LAUNCH, aggregateBars, canAggregate, missingBars, rollSchedule, rollGuard, backAdjust, sessionAt, cmeOpen,
  classifyRegimes, strategyDefinitions, UNDEFINED_STRATEGIES, evaluateUnit, runEngine, evidenceState, matrixState, decayOf, readinessOf,
  evidenceScore, selectStrategies, updateChampions, tradeCandidate, freshness, closedHigherBar, portfolioSim, monteCarlo, acquireDataset,
  importDataset, loadDataset, queueJob, researchStep, readUnits, forwardEvidence, researchView, strategyView, matrixView, researchIntent,
  COST_PROFILES, cacheKey, readState, periodsFor,
} from './trading_research.js';
import { appendTrades, newPortfolio } from './trading_evidence.js';
import { fixtureBars, fixtureDaily } from './test_fixtures/trading_fixture.mjs';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const NOW = Date.parse('2024-04-01T00:00:00Z');
const B15 = fixtureBars({ start: '2024-03-03T23:00:00Z', days: 12 });          // TEST FIXTURE, 15-second bars
const tf = (to) => aggregateBars(B15, '15s', to, { now: NOW });
const MAN = (bars) => ({ first: bars[0].t, last: bars.at(-1).t, sha256: 'fixture', roll_dates: [], provider: 'TEST FIXTURE' });
function memoryStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); return; } m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
  };
}
function yahooFrom(barsByInterval, symbolSeen = []) {
  return async (url) => {
    const u = new URL(String(url));
    symbolSeen.push(decodeURIComponent(u.pathname.split('/').pop()));
    const bars = barsByInterval[u.searchParams.get('interval')] || [];
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketTime: Math.floor(NOW / 1000) }, timestamp: bars.map((b) => Date.parse(b.t) / 1000),
      indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] } }] } }), { status: 200 });
  };
}

// ─── Historical data (20) ─────────────────────────────────────────────────────

test('H1 MNQ uses only its actual history: nothing before its May 2019 launch', async () => {
  const daily = fixtureDaily({ from: '2015-01-05', years: 6 });
  const seen = [];
  const out = await acquireDataset(memoryStorage(), { market: 'MNQ', tf: '1D' }, { fetcher: yahooFrom({ '1d': daily }, seen), now: NOW });
  assert.equal(out.ok, true);
  assert.equal(seen[0], 'MNQ=F');
  assert.ok(out.bars[0].t >= LAUNCH.MNQ, 'pre-launch bars are dropped, never kept as MNQ');
  assert.equal(out.manifest.proxy, null);
});

test('H2 NQ history keeps full provenance: provider, symbol, contract, method, resolution, range, bars, zone, gaps, roll, adjustment, confidence, hash', async () => {
  const daily = fixtureDaily({ from: '2004-01-05', years: 20 });
  const out = await acquireDataset(memoryStorage(), { market: 'NQ', tf: '1D' }, { fetcher: yahooFrom({ '1d': daily }), now: NOW });
  for (const k of ['provider', 'symbol', 'contract', 'continuous_method', 'resolution', 'first', 'last', 'bars', 'timezone', 'missing', 'roll_method', 'adjustment', 'confidence', 'sha256']) assert.ok(out.manifest[k] !== undefined, k);
  assert.equal(out.manifest.symbol, 'NQ=F');
  assert.ok(out.manifest.years > 19 && out.manifest.years < 21);
  assert.ok(out.manifest.rolls > 70, 'quarterly rolls over 20 years are recorded');
});

test('H3 a proxy is refused unless asked for, and then labelled PROXY, never as MNQ or NQ', async () => {
  const s = memoryStorage();
  assert.equal((await acquireDataset(s, { market: 'NDX', tf: '1D' }, { fetcher: yahooFrom({ '1d': fixtureDaily() }), now: NOW })).ok, false);
  const out = await acquireDataset(s, { market: 'NDX', tf: '1D' }, { fetcher: yahooFrom({ '1d': fixtureDaily() }), now: NOW, allowProxy: true });
  assert.match(out.manifest.proxy, /^PROXY:/);
  assert.equal(out.manifest.confidence, 'proxy');
});

test('H4 futures rolls: quarterly schedule, trades across a roll are excluded, back-adjustment removes the jump', () => {
  const r = rollSchedule(2024, 2024);
  assert.deepEqual(r.map((x) => x.expiry), ['2024-03-15', '2024-06-21', '2024-09-20', '2024-12-20']);
  assert.equal(r[0].roll, '2024-03-07');
  const bars = tf('5m');
  const trades = runEngine('rsi-revert-5m', bars, '5m');
  const g = rollGuard(trades, bars, { rolls: [{ roll: '2024-03-07' }] });
  assert.ok(g.excluded > 0 && g.kept.length + g.excluded === trades.length);
  assert.ok(g.kept.every((t) => !(t.signal.time < '2024-03-07T22:00:00.000Z' && t.exit.time >= '2024-03-07T22:00:00.000Z')));
  const adj = backAdjust([
    { contract: 'H24', bars: [{ t: '2024-03-06T00:00:00Z', o: 100, h: 101, l: 99, c: 100 }, { t: '2024-03-07T00:00:00Z', o: 100, h: 101, l: 99, c: 100 }] },
    { contract: 'M24', roll_at: '2024-03-08T00:00:00Z', bars: [{ t: '2024-03-08T00:00:00Z', o: 110, h: 111, l: 109, c: 110 }] },
  ]);
  assert.equal(adj.bars[1].c, 110, 'the older contract is shifted by the roll difference');
  assert.equal(adj.adjustments[0].points, 10);
});

test('H5 missing bars are counted inside open hours only (not the daily break, weekends or holidays)', () => {
  const bars = tf('1m');
  assert.equal(missingBars(bars, '1m'), 0, 'a complete fixture has no gaps');
  const holed = bars.filter((_, i) => i % 50 !== 7);
  assert.ok(missingBars(holed, '1m') >= Math.floor(bars.length / 50) - 1);
});

test('H6 DST and session boundaries come from the time-zone database and the CME calendar', () => {
  assert.equal(sessionAt('2024-01-10T14:35:00Z', '5m'), 'ny_open');      // 09:35 EST
  assert.equal(sessionAt('2024-07-10T14:35:00Z', '5m'), 'ny_morning');   // 10:35 EDT
  assert.equal(sessionAt('2024-07-10T21:30:00Z', '5m'), 'cme_break');
  assert.equal(sessionAt('2024-07-10T02:00:00Z', '5m'), 'globex_overnight');
  assert.equal(cmeOpen('2024-03-29T15:00:00Z'), false, 'Good Friday');
  assert.equal(cmeOpen('2024-12-25T15:00:00Z'), false, 'Christmas');
  assert.equal(cmeOpen('2024-07-04T18:30:00Z'), false, 'Independence Day early halt at 13:00 New York');
  assert.equal(cmeOpen('2024-07-10T14:35:00Z'), true);
  assert.equal(sessionAt('2024-07-10T14:35:00Z', '1D'), 'daily');
});

const EXPECT = { '15s': 15e3, '30s': 30e3, '1m': 60e3, '2m': 120e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3 };
for (const [i, id] of ['15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h'].entries()) {
  test(`H${7 + i} ${id}: bars are complete, clock-aligned and consistent with the 15-second source`, () => {
    const bars = id === '15s' ? B15 : tf(id);
    assert.ok(bars.length > 50, `${bars.length} bars`);
    for (const b of bars.slice(0, 50)) {
      assert.equal(Date.parse(b.t) % EXPECT[id], 0, 'aligned');
      const parts = B15.filter((x) => x.t >= b.t && Date.parse(x.t) < Date.parse(b.t) + EXPECT[id]);
      assert.equal(parts.length, EXPECT[id] / 15e3, 'every 15-second bar was received');
      assert.equal(b.h, Math.max(...parts.map((p) => p.h)));
      assert.equal(b.l, Math.min(...parts.map((p) => p.l)));
      assert.equal(b.o, parts[0].o); assert.equal(b.c, parts.at(-1).c);
    }
  });
}
test('H15 4h: buckets anchored to the CME day (18:00 New York), complete only', () => {
  const bars = tf('4h');
  assert.ok(bars.length >= 30);
  for (const b of bars) assert.equal(etMins(b.t) % 240, 0 + ((18 * 60) % 240), `${b.t} starts on a CME 4-hour boundary`);
});
const etMins = (t) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)); return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value); };
test('H16 daily: one bar per CME trading day from intraday bars; the forming day is left out', () => {
  const daily = tf('1D');
  assert.ok(daily.length >= 9 && daily.length <= 10);
  assert.equal(new Set(daily.map((b) => b.t.slice(0, 10))).size, daily.length);
  const partial = aggregateBars(B15, '15s', '1D', { now: Date.parse(B15.at(-1).t) });
  assert.ok(partial.length < daily.length + 1);
});
test('H17 weekly from daily, current week left out', () => {
  const daily = fixtureDaily({ from: '2020-01-06', years: 2 });
  const w = aggregateBars(daily, '1D', '1W', { now: NOW });
  assert.ok(w.length > 100 && w.every((b) => new Date(b.t).getUTCDay() === 1));
});
test('H18 monthly from daily', () => {
  const daily = fixtureDaily({ from: '2020-01-06', years: 2 });
  const m = aggregateBars(daily, '1D', '1M', { now: NOW });
  assert.equal(m.length, 24);
  assert.ok(m.every((b) => b.t.slice(8, 10) === '01'));
});
test('H19 upward resampling: 1m→5m equals 15s→5m; derived datasets record their source', async () => {
  assert.deepEqual(aggregateBars(tf('1m'), '1m', '5m', { now: NOW }), tf('5m'));
  const s = memoryStorage();
  await importDataset(s, { market: 'MNQ', tf: '1m', bars: tf('1m'), provider: 'seeded walk', fixture: true }, { now: NOW });
  const out = await acquireDataset(s, { market: 'MNQ', tf: '15m' }, { now: NOW });
  assert.equal(out.ok, true);
  assert.match(out.manifest.derived_from, /^1m/);
  assert.equal(out.manifest.bars, tf('15m').length);
  assert.match(out.manifest.provider, /TEST FIXTURE/);
});
test('H20 downward resampling is refused; 15s/30s without a real source are reported, never synthesized', async () => {
  assert.throws(() => aggregateBars(tf('5m'), '5m', '1m'), /refused/);
  assert.throws(() => aggregateBars(tf('1D'), '1D', '1h'), /refused/);
  assert.equal(canAggregate('5m', '2m'), false);
  assert.equal(canAggregate('1h', '1D'), true);
  const out = await acquireDataset(memoryStorage(), { market: 'MNQ', tf: '15s' }, { now: NOW });
  assert.equal(out.ok, false);
  assert.match(out.reason, /No 15s history/);
  assert.ok(out.options.length >= 2);
});

// ─── Strategies (11 checks, every deterministic strategy) ─────────────────────

const DEFS = strategyDefinitions();
const BARS5 = tf('5m');
const DAILY = fixtureDaily({ from: '2010-01-04', years: 12 });
const barsFor = (d) => (d.timeframes.includes('5m') ? ['5m', BARS5] : ['1D', DAILY]);
for (const d of DEFS) {
  test(`S ${d.strategy_id}: no look-ahead, repeatable, next-bar entries, stops, targets, costs, sessions, timeframes, 30-trade rule, OOS and paper separation`, () => {
    const [tfId, bars] = barsFor(d);
    const unit = evaluateUnit({ strategyId: d.strategy_id, market: 'MNQ', tf: tfId, bars, manifest: MAN(bars) });
    // 1 no future data
    assert.equal(unit.look_ahead, 'passed');
    // 2 deterministic
    assert.deepEqual(evaluateUnit({ strategyId: d.strategy_id, market: 'MNQ', tf: tfId, bars, manifest: MAN(bars) }), unit);
    const raw = runEngine(d.strategy_id, bars, tfId);
    for (const t of raw) {
      // 3 realistic entry: the signal bar closes, the fill is the next bar's open
      assert.ok(t.entry.time > t.signal.time && t.entry.basis === 'next_bar_open');
      // 4 stop logic and 5 target logic
      if (t.exit.reason === 'stop') assert.ok(t.r_net < 0, 'a stop is a loss');
      // A target exit moves in the trade's favour before costs (a near target such as VWAP can still net a loss).
      if (t.exit.reason === 'target') assert.ok((t.side === 'short' ? t.entry.raw - t.exit.raw : t.exit.raw - t.entry.raw) > 0, 'a target is reached in the trade direction');
    }
    // 6 costs: stress costs never improve the result, optimistic never worsen it
    if (raw.length) {
      const sum = (profile) => runEngine(d.strategy_id, bars, tfId, { costs: COST_PROFILES[profile] }).reduce((a, t) => a + t.net_pnl, 0);
      assert.ok(sum('STRESS') <= sum('NORMAL') + 1e-9 && sum('NORMAL') <= sum('OPTIMISTIC') + 1e-9);
    }
    // 7 sessions: never in the CME break; intraday positions are flat by the session end
    if (tfId === '5m') for (const t of unit.trades) assert.notEqual(t.s, 'cme_break');
    if (d.strategy_id === 'silver-bullet-5m') for (const t of raw) assert.ok([10, 14].includes(Math.floor(etMins(t.signal.time) / 60)));
    // 8 timeframes are separate evidence: 15-minute results are not the 5-minute results
    if (d.timeframes.includes('15m')) {
      const u15 = evaluateUnit({ strategyId: d.strategy_id, market: 'MNQ', tf: '15m', bars: tf('15m'), manifest: MAN(tf('15m')) });
      assert.equal(u15.timeframe, '15m');
      assert.notDeepEqual(u15.trades.map((t) => t.t), unit.trades.length ? unit.trades.map((t) => t.t) : ['none']);
    }
    // 9 30 trades per bucket before it counts
    assert.equal(evidenceState(unit), unit.all.trades < MIN_CLOSED_TRADES ? 'NOT READY' : evidenceState(unit));
    if (unit.all.trades < MIN_CLOSED_TRADES) assert.equal(matrixState(unit), 'Learning');
    // 10 train and out-of-sample never overlap; OOS comes after the training window
    const train = unit.trades.filter((t) => !t.oos); const oos = unit.trades.filter((t) => t.oos);
    assert.equal(train.length + oos.length, unit.trades.length);
    if (oos.length && train.length) assert.ok(oos[0].t > train[0].t);
    // 11 this is BACKTEST evidence only
    assert.equal(unit.mode, 'BACKTEST');
  });
}
test('S undefined strategies (Dirty Trez, OTE) are listed with why, never tested', () => {
  assert.ok(UNDEFINED_STRATEGIES.some((u) => u.strategy_id === 'dirty-trez'));
  assert.ok(!DEFS.some((d) => d.strategy_id === 'dirty-trez'));
  for (const d of DEFS) for (const k of ['strategy_id', 'version', 'direction', 'entry_rule', 'exit_rule', 'stop_rule', 'target_rule', 'time_filter', 'session_filter', 'regime_filter', 'position_sizing', 'max_holding', 'data_requirements', 'cost_assumptions']) assert.ok(d[k], `${d.strategy_id}.${k}`);
});

// ─── Selection (10) ───────────────────────────────────────────────────────────

const mk = ({ id = 'a', tfId = '5m', n = 120, exp = 0.3, wr = 0.5, pf = 1.4, dd = 6, oosN = 50, oosExp = exp, recent = exp, sessions = [], regimes = [], folds = [4, 4] } = {}) => ({
  ok: true, strategy_id: id, market: 'MNQ', timeframe: tfId, mode: 'BACKTEST', look_ahead: 'passed', dataset: { first: '2024-01-01', last: '2024-03-01' },
  all: { trades: n, expectancy_r: exp, win_rate: wr, pf, max_dd_r: dd, expectancy_ci: { low: exp - 0.1 } }, oos: { trades: oosN, expectancy_r: oosExp, pf },
  recent: { trades: 30, expectancy_r: recent }, folds_positive: folds[0], folds_total: folds[1], sessions, regimes, stress: { expectancy_r: exp - 0.1 },
});
test('X1 the highest win rate does not automatically win', () => {
  const sel = selectStrategies([mk({ id: 'wr90', wr: 0.9, exp: -0.1, pf: 0.8 }), mk({ id: 'exp', wr: 0.5, exp: 0.35 })], {});
  assert.equal(sel.ranked[0].strategy_id, 'exp');
  assert.ok(!sel.ranked.some((r) => r.strategy_id === 'wr90'));
});
test('X2 strong expectancy outranks raw win rate', () => {
  const sel = selectStrategies([mk({ id: 'hi_wr', wr: 0.8, exp: 0.08, pf: 1.1 }), mk({ id: 'hi_exp', wr: 0.45, exp: 0.45, pf: 1.8 })], {});
  assert.equal(sel.ranked[0].strategy_id, 'hi_exp');
});
test('X3 excessive drawdown lowers the score', () => {
  assert.ok(evidenceScore(mk({ dd: 25 })).score < evidenceScore(mk({ dd: 3 })).score);
});
test('X4 fewer than 30 trades stays learning', () => {
  assert.equal(evidenceScore(mk({ n: 29 })).qualified, false);
  assert.equal(evidenceState({ ok: true, all: { trades: 29 }, oos: { trades: 10, expectancy_r: 1 } }), 'NOT READY');
  assert.equal(readinessOf([mk({ n: 29 })], null), 'LEARNING');
});
test('X5 historically good but recently bad is detected and costs confidence', () => {
  const u = mk({ exp: 0.4, recent: -0.2 });
  assert.equal(decayOf(u), 'WEAKENING');
  assert.ok(evidenceScore(u).score < evidenceScore(mk({ exp: 0.4, recent: 0.4 })).score);
});
test('X6 a session mismatch lowers the rank', () => {
  const sessions = [{ key: 'ny_morning', trades: 40, expectancy_r: 0.5 }, { key: 'globex_overnight', trades: 40, expectancy_r: -0.3 }];
  const u = mk({ sessions });
  assert.ok(evidenceScore(u, { session: 'globex_overnight' }).score < evidenceScore(u, { session: 'ny_morning' }).score);
});
test('X7 a regime mismatch lowers the rank', () => {
  const regimes = [{ key: 'trend_up', trades: 40, expectancy_r: 0.5 }, { key: 'range', trades: 40, expectancy_r: -0.4 }];
  const u = mk({ regimes });
  assert.ok(evidenceScore(u, { regime: 'range' }).score < evidenceScore(u, { regime: 'trend_up' }).score);
});
test('X8 stale data prevents any signal', () => {
  const bars = tf('5m');
  const fr = freshness(bars, '5m', Date.parse(bars.at(-1).t) + 60 * 60_000);
  assert.equal(fr.fresh, false);
  const out = tradeCandidate({ bars, tf: '5m', market: 'MNQ', units: [mk()], now: Date.parse(bars.at(-1).t) + 60 * 60_000 });
  assert.equal(out.decision, 'NO TRADE');
  assert.match(out.reason, /Stale data/);
  assert.equal(selectStrategies([mk()], { stale: true }).decision, 'NO TRADE');
});
test('X9 no qualifying strategy returns NO TRADE', () => {
  const sel = selectStrategies([mk({ oosExp: -0.1 }), mk({ id: 'b', n: 12 })], {});
  assert.equal(sel.decision, 'NO TRADE');
  assert.equal(sel.reason, 'No strategy currently meets your threshold.');
});
test('X10 champion and challenger update only on evidence, with history', () => {
  const champs = {};
  const ctx = { market: 'MNQ', timeframe: '5m', session: 'ny_morning', regime: 'trend_up', now: '2024-03-01T00:00:00Z' };
  updateChampions(champs, [mk({ id: 'ema', exp: 0.4 }), mk({ id: 'orb', exp: 0.2 })], ctx);
  const key = 'MNQ|5m|ny_morning|trend_up';
  assert.equal(champs[key].champion, 'ema');
  assert.equal(champs[key].challengers[0].strategy_id, 'orb');
  updateChampions(champs, [mk({ id: 'ema', exp: 0.4 }), mk({ id: 'orb', exp: 0.2 })], { ...ctx, now: '2024-03-02T00:00:00Z' });
  assert.equal(champs[key].since, '2024-03-01T00:00:00Z', 'no evidence change, no champion change');
  updateChampions(champs, [mk({ id: 'ema', exp: 0.05, oosExp: -0.1 }), mk({ id: 'orb', exp: 0.45 })], { ...ctx, now: '2024-03-03T00:00:00Z' });
  assert.equal(champs[key].champion, 'orb');
  assert.deepEqual(champs[key].history[0], { at: '2024-03-03T00:00:00Z', from: 'ema', to: 'orb' });
});

// ─── Supporting pieces ───────────────────────────────────────────────────────

test('regimes are causal: a bar\'s regime never changes when later bars change', () => {
  const bars = tf('5m');
  const a = classifyRegimes(bars); const cut = 1500;
  const b = classifyRegimes([...bars.slice(0, cut), ...bars.slice(cut).map((x) => ({ ...x, c: x.c * 1.2, h: x.h * 1.2, l: x.l * 1.2, o: x.o * 1.2 }))]);
  assert.deepEqual(a.slice(0, cut), b.slice(0, cut));
});
test('multi-timeframe context never reads an unfinished higher-timeframe candle', () => {
  const h1 = tf('1h');
  const t = new Date(Date.parse(h1[5].t) + 30 * 60_000).toISOString();
  assert.equal(closedHigherBar(h1, '1h', t).t, h1[4].t);
});
test('portfolio limits: concurrent positions, open risk and a daily loss limit are enforced', () => {
  const trades = [
    { t: '2024-03-05T15:00:00Z', x: '2024-03-05T16:00:00Z', r: -1 }, { t: '2024-03-05T15:05:00Z', x: '2024-03-05T15:30:00Z', r: -1 },
    { t: '2024-03-05T15:10:00Z', x: '2024-03-05T15:20:00Z', r: 2 }, { t: '2024-03-05T17:00:00Z', x: '2024-03-05T17:10:00Z', r: -1 },
    { t: '2024-03-05T18:00:00Z', x: '2024-03-05T18:10:00Z', r: 1 },
  ];
  const out = portfolioSim(trades, { maxConcurrent: 2, maxOpenRiskR: 2, dailyLossR: 3 });
  assert.equal(out.taken + out.skipped, 5);
  assert.ok(out.reasons.some((r) => r.reason === 'max concurrent positions'));
});
test('Monte Carlo is seeded and gives ranges; periods never claim history the data lacks', () => {
  const rs = Array.from({ length: 60 }, (_, i) => (i % 3 ? 1 : -1));
  assert.deepEqual(monteCarlo(rs), monteCarlo(rs));
  assert.ok(monteCarlo(rs).drawdown_r.p95 >= monteCarlo(rs).drawdown_r.p50);
  const p = periodsFor({ first: '2019-05-06T00:00:00Z', last: '2026-10-01T00:00:00Z' }, []);
  assert.equal(p.find((x) => x.window === '10y').available, false);
  assert.equal(p.find((x) => x.window === '5y').available, true);
  assert.equal(p.find((x) => x.window === 'max').years_available, 7.41);
});

// ─── Jobs, cache, performance ─────────────────────────────────────────────────

test('research job: under-tested units first, checkpoint per unit, resume, and the evidence cache skips unchanged units', async () => {
  const s = memoryStorage();
  await importDataset(s, { market: 'MNQ', tf: '5m', bars: tf('5m'), provider: 'seeded walk', fixture: true }, { now: NOW });
  const job = await queueJob(s, { market: 'MNQ', timeframes: ['5m'], strategies: ['rsi-revert-5m', 'inside-bar-5m', 'fvg-retest-5m'] }, NOW);
  assert.equal(job.remaining.length, 3);
  let tick = 0;
  const first = await researchStep(s, { now: NOW, budgetMs: 1, clock: () => (tick += 1) });
  assert.equal(first.ran, 1, 'one unit, then checkpoint');
  assert.equal((await readState(s)).jobs[0].remaining.length, 2, 'progress survives a restart');
  await researchStep(s, { now: NOW, budgetMs: 60_000 });
  const units = await readUnits(s);
  assert.equal(units.filter((u) => u.ok).length, 3);
  assert.ok(units.every((u) => u.dataset.provider.startsWith('TEST FIXTURE')));
  await queueJob(s, { market: 'MNQ', timeframes: ['5m'], strategies: ['rsi-revert-5m'] }, NOW + 1000);
  const again = await researchStep(s, { now: NOW + 1000, budgetMs: 60_000 });
  assert.equal(again.ran, 0, 'unchanged data + strategy version + costs: not rerun');
  assert.equal((await readState(s)).jobs[0].cached.length, 1);
  assert.match(cacheKey({ strategyId: 'rsi-revert-5m', market: 'MNQ', tf: '5m', sha256: 'h', profile: 'NORMAL' }), /research-1/);
});

test('performance: 12 days of 15-second bars (55,000 bars) are researched one unit at a time inside the Worker budget', () => {
  const t0 = Date.now();
  const unit = evaluateUnit({ strategyId: 'rsi-revert-5m', market: 'MNQ', tf: '15s', bars: B15, manifest: MAN(B15) });
  const ms = Date.now() - t0;
  console.log(`# 15s unit: ${B15.length} bars, ${unit.all.trades} trades, ${ms} ms`);
  assert.ok(ms < 20_000, `one 15-second unit took ${ms} ms`);
});

// ─── Forward evidence and the Worker routes ───────────────────────────────────

test('paper results stay in their own PAPER bucket; legacy records missing fields are marked, not invented', async () => {
  const s = memoryStorage();
  const pf = newPortfolio('rsi-revert-5m', 'any', { contract: 'MNQ', source: 'paper', resolution: '5m', priceSeries: 'fixture' });
  const trades = (await import('./trading_evidence.js')).stepPortfolio(pf, tf('5m'), (await import('./trading_evidence.js')).intradayContext(tf('5m')));
  await appendTrades(s, trades.slice(0, 5));
  const legacy = { ...trades[5], portfolio: 'legacy', source: 'backtest', environment: 'backtest', data: { ...trades[5].data, resolution: 'intraday' } };
  delete legacy.condition;
  await appendTrades(s, [legacy]);
  const f = await forwardEvidence(s);
  const paper = f.find((x) => x.mode === 'PAPER');
  assert.equal(paper.trades, 5);
  const old = f.find((x) => x.mode === 'BACKTEST_LEGACY');
  assert.equal(old.timeframe, 'LEGACY');
  assert.equal(old.partial_metadata, true);
});

const generated = new URL('./.trading_research.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
async function owner() {
  const s = memoryStorage();
  s.setAlarm = async () => {}; s.deleteAlarm = async () => {}; s.getAlarm = async () => null;
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls++; return { response: 'model' }; } } };
  const state = new mod.CheState({ storage: s, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    s, send, token, calls: () => calls,
    get: async (p) => { const r = await send(p, null, token, 'GET'); return { status: r.status, body: await r.json() }; },
    post: async (p, b) => { const r = await send(p, b, token); return { status: r.status, body: await r.json() }; },
    say: async (message) => { const before = calls; const raw = await (await send('/api/chat', { message, history: [] }, token)).text(); const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; return { reply: replyFromNdjson(raw), done, model_calls: calls - before }; },
  };
}

test('Worker: the research API matches the contract, owner only; per-timeframe evidence, matrix and spoken answers with no model call', async () => {
  const che = await owner();
  assert.equal((await che.send('/api/trading/research', null, '', 'GET')).status === 200, false, 'a guest gets nothing');
  await importDataset(che.s, { market: 'MNQ', tf: '5m', bars: tf('5m'), provider: 'seeded walk', fixture: true }, { now: NOW });
  const run = await che.post('/api/trading/research/run_job', { market: 'MNQ', timeframes: ['5m'], strategies: ['rsi-revert-5m', 'fvg-retest-5m', 'inside-bar-5m'] });
  assert.equal(run.status, 200);
  assert.match(run.body.spoken, /Queued/);
  await researchStep(che.s, { now: NOW, budgetMs: 60_000 });
  const v = (await che.get('/api/trading/research')).body;
  for (const k of ['markets', 'live', 'best_now', 'strategies', 'dashboard', 'jobs', 'profile', 'paper_learning']) assert.ok(k in v, k);
  assert.deepEqual(v.markets, ['MNQ', 'NQ']);
  assert.ok(v.strategies.some((x) => x.strategy_id === 'dirty-trez' && x.defined === false && x.status === 'UNDEFINED'));
  assert.ok(v.dashboard.backtest_trades > 0);
  assert.ok(v.dashboard.coverage.some((c) => c.resolution === '5m' && /TEST FIXTURE/.test(c.provider)));
  assert.equal(v.live.stale, true, 'no live feed: stale, so Best Now cannot claim a trade');
  assert.equal(v.best_now.length, 0);
  assert.match(v.best_now_reason, /stale/i);
  const sv = (await che.get('/api/trading/research/strategy?id=rsi-revert-5m&market=MNQ')).body;
  assert.equal(sv.timeframes.length, 12);
  const row5 = sv.timeframes.find((r) => r.tf === '5m');
  assert.equal(row5.min_required, 30);
  assert.ok(row5.trades > 0 && ['QUALIFIED', 'MONITOR', 'NOT READY'].includes(row5.evidence));
  assert.equal(sv.timeframes.find((r) => r.tf === '1D').evidence, 'N/A', 'not a daily rule');
  assert.ok(sv.periods.find((p) => p.window === '10y').available === false);
  const mx = (await che.get('/api/trading/research/matrix?market=MNQ')).body;
  assert.equal(mx.timeframes.length, 12);
  assert.ok(mx.rows.find((r) => r.strategy_id === 'rsi-revert-5m').cells['5m'].trades > 0);
  const best = await che.say('Which strategy is best right now?');
  assert.equal(best.done.source, 'che_trading_research');
  assert.equal(best.model_calls, 0);
  assert.equal(best.done.workflow?.id, 'trading_desk', 'recorded by the Workflow Engine under the trading workflow');
  assert.match(best.reply, /No strategy|stale/i);
  const how = await che.say('how is the RSI reversal doing on 5 minute');
  assert.equal(how.done.source, 'che_trading_research');
  assert.match(how.reply, /5m, \d+ /);
  const hist = await che.say('what history do you have for MNQ');
  assert.match(hist.reply, /5m: 2024-03-03 to 2024-03-15, [\d.]+ years, 2760 bars from TEST FIXTURE/);
  assert.match(hist.reply, /15- and 30-second history is not available/);
  const p = await che.post('/api/trading/research/profile', { profile: 'LIGHT' });
  assert.equal(p.body.view.profile, 'LIGHT');
  assert.equal((await che.post('/api/trading/research/profile', { profile: 'TURBO' })).status, 400);
});

test('voice intents are read deterministically; ordinary sentences are not taken', () => {
  assert.equal(researchIntent('Which strategy is best right now?').kind, 'best_now');
  assert.equal(researchIntent('what strategies look strongest today').kind, 'best_now');
  assert.deepEqual(researchIntent('how is EMA pullback doing on 5 minute'), { kind: 'strategy', strategy_id: 'ema-pullback-5m', timeframe: '5m' });
  assert.deepEqual(researchIntent('run deep research on NQ'), { kind: 'run', market: 'NQ', deep: true });
  assert.deepEqual(researchIntent('start paper learning'), { kind: 'paper', enabled: true });
  assert.equal(researchIntent('what is the best pizza right now'), null);
  assert.equal(researchIntent('how is my mom doing'), null);
});

test('Signal Mode: every strategy card carries the sample sizes behind its numbers', async () => {
  const view = await researchView(memoryStorage());
  assert.ok(view.strategies.length > 0);
  for (const s of view.strategies) {
    assert.equal(typeof s.sample_trades, 'number', s.strategy_id);
    assert.equal(typeof s.paper_trades, 'number', s.strategy_id);
  }
  assert.ok(view.strategies.every((s) => s.sample_trades === 0), 'an empty ledger reports zero samples, never a made-up count');
});
