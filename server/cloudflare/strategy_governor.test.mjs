// Strategy governor (owner, 2026-10-23): losing strategies are paused from forward paper on statistical evidence,
// keep running in simulation, return only after out-of-sample + walk-forward revalidation, and every decision is
// logged with its evidence. No look-ahead, no duplicate or fabricated records counted, no live trading.
import assert from 'node:assert/strict';
import test from 'node:test';
import { COSTS, readTrades } from './trading_evidence.js';
import { liveTick, readLivePortfolios, setLivePaper } from './trading_live.js';
import { matrixState } from './trading_research.js';
import {
  GOV_STATE, cleanSettings, fillProblems, governedGate, governorAction, independentTrades, lossCauses, performance, readDecisions,
  queueAllocationFollowUp, recurringLosses, repeatedMistakes, runGovernor, simulationAllocation, speakGovernor, streakProbability, tradeDecisions, verdict,
} from './strategy_governor.js';

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

const T0 = Date.parse('2026-09-01T14:00:00Z');
const at = (i, mins = 0) => new Date(T0 + i * 3_600_000 + mins * 60_000).toISOString();

// A valid forward-paper MNQ record (long, entry 100, stop 90, target 120): r is the net R wanted.
function trade(i, r, { strategy = 'ema-pullback-5m', filter = 'any', target_r = 2, mfe_r = r > 0 ? 2 : 0.1, session = 'mid-morning', condition = { trend: 'above-50d', volatility: 'normal-vol' }, side = 'long', portfolio = null } = {}) {
  const risk = 20; // 10 points × $2
  const net = Math.round(r * risk * 100) / 100;
  const win = r > 0;
  return {
    source: 'paper', environment: 'paper', portfolio: portfolio || `${strategy}|${filter}|${target_r}`, symbol: 'MNQ', contract: 'MNQ', qty: 1,
    strategy, filter, strategy_version: 'v1', params: { target_r }, side, session, condition,
    signal: { time: at(i), why: 'test setup' },
    entry: { time: at(i, 5), raw: 100, fill: 100.375, spread: 0.125, slippage: 0.25, basis: 'next_bar_open' },
    stop: 90, target: 120, risk_points: 10,
    exit: { time: at(i, 30), raw: win ? 120 : 90, fill: win ? 119.875 : 89.625, reason: win ? 'target' : 'stop' },
    same_bar_both_touched: false,
    gross_before_costs: net + 5.5, costs: { spread: 0.5, slippage: 1, commissions: 3, fees: 1 }, net_pnl: net, r_gross: r + 0.275, r_net: r, risk_dollars: risk,
    mfe_points: mfe_r * 10, mae_points: 5, mfe_r, mae_r: 0.5,
    data: { resolution: '5m', price_series: 'test', label: 'intraday 5m bars, fills at the next open' }, cost_assumptions: { ...COSTS },
    result: net > 0 ? 'win' : 'loss',
  };
}
// n trades with the given win/loss pattern: `wins` of every `of` win +2R, the rest lose −1.275R.
const series = (n, { wins = 1, of = 4, ...o } = {}) => Array.from({ length: n }, (_, i) => trade(i, i % of < wins ? 2 : -1.275, o));
const goodUnit = { ok: true, strategy_id: 'ema-pullback-5m', market: 'MNQ', timeframe: '5m', all: { trades: 200, expectancy_r: 0.2 }, oos: { trades: 60, expectancy_r: 0.15, pf: 1.3 }, folds_total: 4, folds_positive: 3, look_ahead: 'passed' };
const badUnit = { ...goodUnit, oos: { trades: 60, expectancy_r: -0.2, pf: 0.8 }, folds_positive: 1 };

test('statistics: expectancy with a one-sided bound, profit factor, drawdown, fees and losing streaks', () => {
  const p = performance(series(40));
  assert.equal(p.trades, 40);
  assert.equal(p.wins, 10);
  assert.equal(p.win_rate, 25);
  assert.ok(Math.abs(p.expectancy_r - (10 * 2 - 30 * 1.275) / 40) < 1e-3);
  assert.ok(p.expectancy_r_upper < 0, 'the 95% upper bound is below zero');
  assert.equal(p.max_consecutive_losses, 3);
  assert.equal(p.fees_usd, 40 * 5.5);
  assert.ok(p.profit_factor < 1);
  assert.equal(streakProbability(1, 1, 0.5), 0.5);
  assert.ok(Math.abs(streakProbability(2, 2, 0.5) - 0.25) < 1e-12);
  assert.equal(streakProbability(5, 3, 0.9), 0);
});

test('a verdict needs 30 independent trades, uses the confidence bound (not win rate) and a pause holds until revalidation', () => {
  assert.equal(verdict(performance(series(20))).status, 'gathering');
  const losing = verdict(performance(series(40)));
  assert.equal(losing.status, 'paused');
  assert.match(losing.reason, /optimistic 95% bound/);
  // A 25% win rate with a 4R target is profitable: win rate alone never pauses.
  const big = Array.from({ length: 40 }, (_, i) => trade(i, i % 4 === 0 ? 4 : -1));
  assert.equal(verdict(performance(big)).status, 'active');
  // Once paused, good forward luck does not lift it; research revalidation does.
  const prior = { status: 'paused', reason: 'old evidence' };
  assert.equal(verdict(performance(big), { prior, research: { met: false } }).status, 'paused');
  assert.equal(verdict(performance(big), { prior, research: { met: true } }).status, 'active');
});

test('one setup traded by four portfolio variants counts once; duplicate records count once', () => {
  const variants = [['any', 2], ['trend', 2], ['any', 1.5], ['any', 3]].map(([filter, target_r]) => trade(1, -1, { filter, target_r }));
  const dup = trade(2, 1);
  const ind = independentTrades([...variants, dup, structuredClone(dup)]);
  assert.equal(ind.trades.length, 2);
  assert.equal(ind.duplicates, 1);
  assert.equal(ind.trades[0].filter, 'any');
  assert.equal(ind.trades[0].params.target_r, 2);
});

test('fabricated or impossible fills are excluded and listed', () => {
  assert.deepEqual(fillProblems(trade(1, 2)), []);
  const far = trade(1, -1); far.entry.fill = 103;
  assert.match(fillProblems(far).join(), /further from the bar open/);
  const early = trade(1, 2); early.exit.raw = 115;
  assert.match(fillProblems(early).join(), /before the target was reached/);
  const missing = trade(1, 2); delete missing.data.label;
  assert.match(fillProblems(missing).join(), /data quality label missing/);
});

test('the run pauses a losing strategy once, logs it with evidence, and never uses trades that closed later (no look-ahead)', async () => {
  const storage = memoryStorage();
  const trades = series(40);
  const cutoff = Date.parse(trades[19].exit.time);
  const early = await runGovernor(storage, { now: cutoff, trades, units: [badUnit] });
  assert.equal(early.strategies[0].stats.trades, 20, 'only trades closed by then count');
  assert.equal(early.strategies[0].status, 'gathering');
  const view = await runGovernor(storage, { now: Date.parse(trades[39].exit.time), trades, units: [badUnit] });
  const s = view.strategies[0];
  assert.equal(s.status, 'paused');
  assert.equal(s.forward_paper_allowed, false);
  assert.equal(s.revalidation.met, false);
  const again = await runGovernor(storage, { now: Date.parse(trades[39].exit.time) + 1000, trades, units: [badUnit] });
  assert.equal(again.changes.length, 0, 'an unchanged status is not logged twice');
  const log = await readDecisions(storage);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'pause');
  assert.equal(log[0].by, 'governor');
  assert.equal(log[0].evidence.stats.trades, 40);
  // Research revalidates it: the resume is logged with that evidence.
  const back = await runGovernor(storage, { now: Date.parse(trades[39].exit.time) + 2000, trades, units: [goodUnit] });
  assert.equal(back.strategies[0].status, 'active');
  const log2 = await readDecisions(storage);
  assert.equal(log2[0].action, 'resume');
  assert.equal(log2[0].evidence.revalidation.met, true);
  assert.match(speakGovernor(view), /paused from forward paper: trend pullback to the 20 EMA.*Live trading stays off/);
});

test('loss causes, recurring losing setups and repeated mistakes come from the records', () => {
  const t = [
    ...Array.from({ length: 12 }, (_, i) => trade(i, -1.2, { strategy: 'vwap-revert-5m', condition: { trend: 'below-50d', volatility: 'high-vol' }, mfe_r: 1.2 })),
    ...Array.from({ length: 8 }, (_, i) => trade(20 + i, -1.1, { strategy: 'vwap-revert-5m', mfe_r: 0.1 })),
  ];
  const causes = lossCauses(t);
  assert.equal(causes.losers, 20);
  assert.equal(causes.losers_after_1r_in_favour, 12);
  assert.equal(causes.losers_immediately_against, 8);
  assert.ok(causes.cost_drag_r > 0);
  const rec = recurringLosses(t);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].pattern, 'long against the 50-bar trend');
  assert.equal(rec[0].trades, 12);
  const mistakes = repeatedMistakes(t);
  assert.equal(mistakes[0].kind, 'reversed after 1R in favour (exit or target choice)');
  assert.equal(mistakes[0].count, 12);
});

test('simulation allocation keeps a floor for every strategy and leans to better out-of-sample evidence', () => {
  const alloc = simulationAllocation([goodUnit, { ...badUnit, strategy_id: 'vwap-revert-5m' }]);
  const total = alloc.reduce((a, r) => a + r.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-3);
  assert.equal(alloc[0].strategy, 'ema-pullback-5m');
  assert.ok(alloc.every((r) => r.share >= 0.5 / 12 - 1e-9), 'every strategy keeps simulating');
});

test('the gate refuses only new forward-paper signals of a paused strategy; owner overrides and settings are logged and bounded', async () => {
  const paused = new Map([['ema-pullback-5m|MNQ|5m', 'losing']]);
  const gate = governedGate(() => null, paused);
  assert.match(gate({ candidate: 'ema-pullback-5m', contract: 'MNQ', resolution: '5m' }, { stage: 'signal' }), /strategy governor paused it/);
  assert.equal(gate({ candidate: 'ema-pullback-5m', contract: 'MNQ', resolution: '5m' }, { stage: 'fill' }), null, 'an order already placed is not cancelled by it');
  assert.equal(gate({ candidate: 'orb-15m', contract: 'MNQ', resolution: '5m' }, { stage: 'signal' }), null);
  const storage = memoryStorage();
  assert.equal((await governorAction(storage, { action: 'pause', strategy: 'nope' })).ok, false);
  const p = await governorAction(storage, { action: 'pause', strategy: 'orb-15m', reason: 'I want it off' });
  assert.equal(p.ok, true);
  assert.equal(storage.saved.get(GOV_STATE)['orb-15m|MNQ|5m'].status, 'paused');
  const s = await governorAction(storage, { action: 'settings', settings: { z_pause: 99, min_trades: 2, enabled: false } });
  assert.equal(s.settings.z_pause, 4);
  assert.equal(s.settings.min_trades, 15);
  assert.deepEqual(cleanSettings({ z_pause: 'x' }), {});
  const log = await readDecisions(storage);
  assert.deepEqual(log.map((d) => [d.action, d.by]).sort(), [['modify', 'owner'], ['pause', 'owner']]);
});

// The same bars as trading_controls.test.mjs: CME day 2 sweeps day 1's low (pdhl-sweep-5m) on a verified feed.
function minutesOf(t0, { o, h, l, c }) {
  const m = (k) => new Date(Date.parse(t0) + k * 60_000).toISOString();
  return [{ t: m(0), o, h: o, l, c: l, v: 10 }, { t: m(1), o: l, h, l, c: h, v: 10 }, { t: m(2), o: h, h, l: c, c, v: 10 }, { t: m(3), o: c, h: c, l: c, c, v: 10 }, { t: m(4), o: c, h: c, l: c, c, v: 10 }];
}
const five = (start, k) => new Date(Date.parse(start) + k * 300_000).toISOString();
const DAY1 = Array.from({ length: 12 }, (_, k) => ({ t: five('2026-10-19T22:00:00Z', k), o: 20000, h: 20004, l: k === 5 ? 19990 : 19996, c: 20000 }));
const DAY2 = [
  { t: five('2026-10-20T22:00:00Z', 0), o: 20000, h: 20002, l: 19980, c: 19995 },
  { t: five('2026-10-20T22:00:00Z', 1), o: 19996, h: 20030, l: 19992, c: 20028 },
  { t: five('2026-10-20T22:00:00Z', 2), o: 20028, h: 20031, l: 20020, c: 20025 },
];
const feedOf = (bars) => async () => ({ status: 'LIVE', authenticated: true, subscription_verified: true, provider: 'test feed', provider_symbol: 'MNQ=F', contract: 'MNQZ6', candles: bars.flatMap((b) => minutesOf(b.t, b)), latency_s: 0, last_bar_time: bars.at(-1).t, checked_at: new Date().toISOString() });
const after = (bars) => Date.parse(bars.at(-1).t) + 6 * 60_000;

test('in the real forward-paper tick a paused strategy is not traded and its setup is journalled as skipped with the reason', async () => {
  const sweep = async (storage) => (await readTrades(storage, (t) => t.strategy === 'pdhl-sweep-5m'));
  const control = memoryStorage();
  await setLivePaper(control, true, Date.parse('2026-10-19T21:59:00Z'));
  await liveTick(control, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(control, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.ok((await sweep(control)).length >= 1, 'without the governor the sweep is traded');

  const storage = memoryStorage();
  await governorAction(storage, { action: 'pause', strategy: 'pdhl-sweep-5m', reason: 'test pause' });
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal((await sweep(storage)).length, 0, 'the paused strategy did not trade forward paper');
  const items = tradeDecisions(await readLivePortfolios(storage), { strategy: 'pdhl-sweep-5m' });
  assert.ok(items.some((x) => x.decision === 'skipped' && /strategy governor paused it from forward paper: test pause/.test(x.why)));
});

test('matrix: fewer than 15 unseen trades is "Not enough unseen data", not Weak', () => {
  const unit = { ok: true, all: { trades: 40, expectancy_r: -0.3 }, oos: { trades: 8, expectancy_r: null }, look_ahead: 'passed' };
  assert.equal(matrixState(unit), 'Not enough unseen data');
  assert.equal(matrixState({ ...unit, oos: { trades: 20, expectancy_r: -0.3 } }), 'Weak');
});

test('better-supported strategies get an extra daily research job (NQ and 15m); once a day; none without evidence', async () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(await queueAllocationFollowUp(storage, now), null, 'no out-of-sample evidence: nothing extra');
  const s2 = memoryStorage();
  await s2.put('trd_ev:MNQ:5m:ema-pullback-5m:BACKTEST', goodUnit);
  const job = await queueAllocationFollowUp(s2, now);
  assert.ok(job, JSON.stringify([...s2.saved.keys()]));
  assert.equal(job.market, 'NQ');
  assert.ok(job.remaining.every((u) => u.startsWith('ema-pullback-5m|')));
  assert.equal(await queueAllocationFollowUp(s2, now + 3600_000), null, 'once a day');
});
