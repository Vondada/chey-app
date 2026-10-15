import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACTS, COSTS, MIN_TRADES, candleProblems, causalContext, evaluateWalkForward, fillEntry, fillExit,
  newPortfolio, promotionVerdict, appendTrades, readTrades, recordKey, sessionOf, settleTrade, stepPortfolio,
  summarize, validateTradeRecord, walkForwardFolds, wilsonInterval, exitOn,
} from './trading_evidence.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const bars = (rows) => rows.map(([o, h, l, c], i) => ({ t: day(i), o, h, l, c }));
const intraday = (rows, startIso) => rows.map(([o, h, l, c], i) => ({
  t: new Date(Date.parse(startIso) + i * 5 * 60000).toISOString(), o, h, l, c,
}));

// Hand-checked setup: bar 2 closes above bar 1's high (pdh-break signal, stop 99.75, target 105).
// The trade fills at bar 3's open (101.6), not at the signal close (101.5).
const SETUP = [
  [100, 101, 99, 100],
  [100, 100.5, 99.5, 100.2],
  [100.2, 102, 100, 101.5],
  [101.6, 102, 101, 101.8],
];
const LEAD = [100, 100.5, 99.5, 100];   // one earlier bar: shifts the same setup a day later
const WIN_BAR = [101.8, 105.5, 101.7, 105.2];
const STOP_BAR = [101.8, 102, 98.5, 99];

function runPortfolio(rows, opts = {}, candidate = 'pdh-break', filter = 'any') {
  const candles = bars(rows);
  const pf = newPortfolio(candidate, filter, { contract: 'MNQ', qty: 1, source: 'paper', ...opts });
  const trades = stepPortfolio(pf, candles);
  return { pf, trades, candles };
}

function memStore() {
  const m = new Map();
  return {
    m,
    async get(keys) {
      if (!Array.isArray(keys)) return m.get(keys);
      const out = new Map();
      for (const k of keys) if (m.has(k)) out.set(k, structuredClone(m.get(k)));
      return out;
    },
    async put(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async list({ prefix }) {
      const out = new Map();
      for (const k of [...m.keys()].filter((x) => x.startsWith(prefix)).sort()) out.set(k, structuredClone(m.get(k)));
      return out;
    },
  };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (x) => Math.round(x * 100) / 100;

function walk(n, seed) {
  const r = rng(seed);
  let p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = r2(p);
    const c = r2(Math.max(50, p + (r() - 0.48) * 6));
    const h = r2(Math.max(o, c) + r() * 2 + 0.01);
    const l = r2(Math.min(o, c) - r() * 2 - 0.01);
    out.push({ t: day(i), o, h, l, c });
    p = c;
  }
  return out;
}

// ─── Execution ────────────────────────────────────────────────────────────

test('entry fills at the next bar open, with half spread and one tick of slippage', () => {
  const fill = fillEntry({ o: 101.6 }, CONTRACTS.MNQ, COSTS);
  assert.equal(fill.raw, 101.6);
  assert.equal(fill.price, 101.975);
  assert.equal(fill.spread, 0.125);
  assert.equal(fill.slippage, 0.25);
});

test('a winning trade fills at the next open and pays every cost', () => {
  const { trades } = runPortfolio([...SETUP, WIN_BAR]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.entry.raw, 101.6, 'filled at the next open, not the 101.5 signal close');
  assert.equal(t.entry.time, day(3));
  assert.equal(t.signal.time, day(2));
  assert.equal(t.exit.reason, 'target');
  assert.equal(t.exit.raw, 105);
  assert.equal(t.exit.fill, 104.875, 'a limit exit pays half the spread only');
  assert.ok(Math.abs(t.gross_before_costs - 6.8) < 0.01);
  assert.ok(Math.abs(t.costs.spread - 0.5) < 0.01);
  assert.ok(Math.abs(t.costs.slippage - 0.5) < 0.01);
  assert.ok(Math.abs(t.net_pnl - 1.8) < 0.01, `net ${t.net_pnl}`);
  assert.equal(t.result, 'win');
});

test('a stopped trade pays slippage on the stop and loses in R', () => {
  const { trades } = runPortfolio([...SETUP, STOP_BAR]);
  const t = trades[0];
  assert.equal(t.exit.reason, 'stop');
  assert.equal(t.exit.raw, 99.75);
  assert.ok(Math.abs(t.net_pnl - -9.2) < 0.01, `net ${t.net_pnl}`);
  assert.ok(t.r_net < -2.4 && t.r_net > -2.6, `r ${t.r_net}`);
  assert.equal(t.result, 'loss');
});

test('a gap through the stop fills at the open, which is worse than the stop', () => {
  const { trades } = runPortfolio([...SETUP, [99, 99.5, 98, 98.5]]);
  assert.equal(trades[0].exit.raw, 99);
  assert.ok(Math.abs(trades[0].net_pnl - -10.7) < 0.01);
});

test('a gap above the target fills at the open, which is better than the target', () => {
  const { trades } = runPortfolio([...SETUP, [106, 107, 105.5, 106.5]]);
  assert.equal(trades[0].exit.raw, 106);
  assert.equal(trades[0].exit.reason, 'target');
});

test('a bar that touches both stop and target counts the stop first and says so', () => {
  const { trades } = runPortfolio([...SETUP, [101.8, 106, 99, 104]]);
  assert.equal(trades[0].exit.reason, 'stop');
  assert.equal(trades[0].same_bar_both_touched, true);
});

test('a signal whose next open has already passed the plan is skipped, never filled', () => {
  const pf = newPortfolio('pdh-break', 'any');
  // The signal is on bar 2; bar 3 opens at 105.5, above the 105 target, so the plan is void.
  const closed = stepPortfolio(pf, bars([...SETUP.slice(0, 3), [105.5, 106, 105.2, 105.8]]));
  assert.equal(closed.length, 0);
  assert.equal(pf.open, null);
  assert.equal(pf.counts.gap_skipped, 1);
  assert.equal(pf.counts.filled, 0);
});

test('settleTrade charges spread, slippage, commission and fees in dollars', () => {
  const pos = { entry: fillEntry({ o: 100 }, CONTRACTS.MNQ), stop: 99 };
  const s = settleTrade(pos, fillExit(104, 'target', CONTRACTS.MNQ), 1, CONTRACTS.MNQ);
  // gross 4 pts x $2 = $8; spread $0.50; slippage $0.25 x2 = $0.50; commission $3; fees $1 => $3
  assert.ok(Math.abs(s.net_pnl - 3) < 0.01, `net ${s.net_pnl}`);
  assert.ok(Math.abs(s.costs.commissions - 3) < 0.01);
});

test('exitOn never exits before the bar that reaches the level', () => {
  const pos = { entry: { raw: 100 }, stop: 99, target: 102 };
  assert.equal(exitOn(pos, { o: 100, h: 101.9, l: 99.5, c: 101 }, CONTRACTS.MNQ), null);
});

// ─── Look-ahead ───────────────────────────────────────────────────────────

test('causal indicators and decisions before a cut do not depend on bars after it', () => {
  const candles = walk(260, 7);
  const m = 150;
  const mutated = candles.map((b, i) => (i < m ? b : { ...b, o: b.o + 5, h: b.h + 5, l: b.l + 5, c: b.c + 5 }));
  const a = causalContext(candles);
  const b = causalContext(mutated);
  for (let i = 0; i < m; i++) {
    assert.equal(a.atr14[i], b.atr14[i], `atr ${i}`);
    assert.equal(a.sma50[i], b.sma50[i], `sma ${i}`);
    assert.equal(a.lastLow[i], b.lastLow[i], `lastLow ${i}`);
  }
  const cut = candles[m].t;
  const pa = newPortfolio('sweep-reclaim', 'any');
  const pb = newPortfolio('sweep-reclaim', 'any');
  const before = stepPortfolio(pa, candles).filter((t) => t.exit.time < cut);
  const after = stepPortfolio(pb, mutated).filter((t) => t.exit.time < cut);
  assert.ok(before.length > 0, 'the fixture must produce trades before the cut');
  assert.equal(JSON.stringify(before), JSON.stringify(after));
});

test('a swing low is known only after its confirming bars close', () => {
  const rows = [[10, 10.2, 9.8, 10], [9.9, 10, 9, 9.2], [9.2, 9.5, 8.5, 9.4], [9.4, 10, 9.3, 9.8], [9.8, 10.1, 9.6, 10], [10, 10.1, 9.9, 10]];
  const x = causalContext(bars(rows), { swingN: 2 });
  assert.equal(x.lastLow[2], null, 'bar 2 is the low, but two bars must close after it');
  assert.equal(x.lastLow[3], null, 'still unconfirmed one bar later');
  assert.equal(x.lastLow[4], 8.5, 'known once two bars after it have closed');
});

// ─── Data quality ─────────────────────────────────────────────────────────

test('candle data quality is checked before any decision is made', () => {
  assert.deepEqual(candleProblems(bars(SETUP)), []);
  assert.deepEqual(candleProblems([]), ['no candles']);
  assert.ok(candleProblems([{ t: day(0), o: 1, h: 0.5, l: 0.2, c: 0.9 }])[0].includes('impossible range'));
  assert.ok(candleProblems([{ t: day(1), o: 1, h: 2, l: 0.5, c: 1.5 }, { t: day(0), o: 1, h: 2, l: 0.5, c: 1.5 }])[0].includes('not after'));
  assert.ok(candleProblems([{ t: day(0), o: NaN, h: 2, l: 0.5, c: 1.5 }])[0].includes('numeric'));
  assert.throws(() => stepPortfolio(newPortfolio('pdh-break', 'any'), bars([[1, 0.5, 0.2, 0.9]])), /candles refused/);
});

test('daily trades are labelled approximate; intraday trades carry their session', () => {
  const daily = runPortfolio([...SETUP, WIN_BAR]).trades[0];
  assert.match(daily.data.label, /approximate/);
  assert.equal(daily.session, 'daily');
  const candles = intraday([...SETUP, WIN_BAR], '2026-10-15T13:20:00Z');
  const pf = newPortfolio('pdh-break', 'any', { resolution: 'intraday', priceSeries: 'test' });
  const t = stepPortfolio(pf, candles)[0];
  assert.equal(t.data.label, 'intraday bars');
  assert.equal(t.session, sessionOf(t.entry.time, 'intraday'));
});

// ─── Sessions ─────────────────────────────────────────────────────────────

test('sessions follow New York time, including daylight saving', () => {
  assert.equal(sessionOf('2026-10-15T12:30:00Z', 'intraday'), 'econ-0830');
  assert.equal(sessionOf('2026-10-15T13:45:00Z', 'intraday'), 'opening-30m');
  assert.equal(sessionOf('2026-10-15T15:00:00Z', 'intraday'), 'mid-morning');
  assert.equal(sessionOf('2026-10-15T19:30:00Z', 'intraday'), 'afternoon');
  assert.equal(sessionOf('2026-10-15T22:30:00Z', 'intraday'), 'close-and-overnight');
  assert.equal(sessionOf('2026-10-15T11:00:00Z', 'intraday'), 'pre-open');
  assert.equal(sessionOf('2026-01-15T14:30:00Z', 'intraday'), 'opening-30m', 'winter: 9:30 New York');
  assert.equal(sessionOf('2026-10-15'), 'daily');
});

// ─── Statistics ───────────────────────────────────────────────────────────

test('Wilson interval matches the known value for 15 of 30', () => {
  const ci = wilsonInterval(15, 30);
  assert.ok(Math.abs(ci.low - 0.3315) < 0.002, `${ci.low}`);
  assert.ok(Math.abs(ci.high - 0.6685) < 0.002, `${ci.high}`);
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
});

test('summary: win rate with interval, profit factor, drawdown and sample status', () => {
  const trades = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 3; j++) trades.push({ net_pnl: 100, r_net: 2, side: 'long', costs: { spread: 1, slippage: 1, commissions: 1, fees: 1 } });
    trades.push({ net_pnl: -50, r_net: -1, side: 'long', costs: { spread: 1, slippage: 1, commissions: 1, fees: 1 } });
  }
  const s = summarize(trades);
  assert.equal(s.trades, 32);
  assert.equal(s.sample, 'low');
  assert.equal(s.win_rate, 75);
  assert.ok(s.win_rate_95ci.low < 75 && s.win_rate_95ci.high > 75, 'interval contains the observed rate');
  assert.equal(s.profit_factor, 6);
  assert.equal(s.net_pnl, 2000);
  assert.equal(s.max_drawdown, 50);
  assert.equal(s.long, 32);
  assert.equal(summarize(trades.slice(0, 5)).sample, 'insufficient');
});

test('no losing trades gives profit factor null, not an invented number', () => {
  const s = summarize([{ net_pnl: 10, r_net: 1, side: 'long', costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } }]);
  assert.equal(s.profit_factor, null);
  assert.equal(s.win_rate, 100);
});

test('walk-forward folds are consecutive, cover the rest, and each test follows its training period', () => {
  const folds = walkForwardFolds(100, { folds: 4, minTrain: 0.4 });
  assert.deepEqual(folds.map((f) => [f.testStart, f.testEnd]), [[40, 55], [55, 70], [70, 85], [85, 100]]);
  for (const f of folds) assert.equal(f.trainEnd, f.testStart);
  assert.deepEqual(walkForwardFolds(5), []);
});

// ─── Promotion gate ───────────────────────────────────────────────────────

// 60 out-of-sample trades: 40 winners of +2R and 20 losers of -1R.
const strong = [...Array(40)].map(() => ({ net_pnl: 200, r_net: 2, side: 'long', costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } }))
  .concat([...Array(20)].map(() => ({ net_pnl: -100, r_net: -1, side: 'long', costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } })));

test('daily evidence can rank an idea but never promote it, however strong', () => {
  const v = promotionVerdict(strong, { resolution: 'daily', foldsPositive: 4, folds: 4 });
  assert.equal(v.promote, false);
  assert.ok(v.reasons.some((r) => r.includes('approximate')));
});

test('intraday, enough trades, a positive range and stable folds can promote', () => {
  const v = promotionVerdict(strong, { resolution: 'intraday', foldsPositive: 3, folds: 4 });
  assert.equal(v.promote, true, v.reasons.join(' | '));
  assert.ok(v.summary.expectancy_r_95ci.low > 0);
});

test('promotion refuses a small sample, a range that includes zero, and unstable folds', () => {
  const small = promotionVerdict(strong.slice(0, 20), { resolution: 'intraday', foldsPositive: 4, folds: 4 });
  assert.equal(small.promote, false);
  assert.ok(small.reasons.some((r) => r.includes(`${MIN_TRADES} are needed`)));
  const flat = [...Array(40)].map((_, i) => ({ net_pnl: i % 2 ? 100 : -100, r_net: i % 2 ? 1 : -1, side: 'long', costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } }));
  assert.equal(promotionVerdict(flat, { resolution: 'intraday', foldsPositive: 4, folds: 4 }).promote, false);
  assert.equal(promotionVerdict(strong, { resolution: 'intraday', foldsPositive: 1, folds: 4 }).promote, false);
  assert.equal(promotionVerdict(strong, { resolution: 'intraday' }).promote, false, 'no folds tested');
});

test('walk-forward evaluation tests only the out-of-sample period', () => {
  const trades = strong.map((t, i) => ({ ...t, entry: { time: day(i) }, exit: { time: day(i + 1) } }));
  const wf = evaluateWalkForward(trades, { folds: 4, minTrain: 0.4 });
  assert.equal(wf.folds_total, 4);
  assert.equal(wf.oos.length, 60 - 24);
  assert.equal(wf.oos[0].entry.time, day(24));
});

// ─── Isolation ────────────────────────────────────────────────────────────

test('portfolios are isolated: each trade names its own portfolio and stepping one leaves the other unchanged', () => {
  const candles = walk(200, 11);
  const a = newPortfolio('pdh-break', 'any');
  const b = newPortfolio('displacement-continuation', 'any');
  const beforeB = JSON.stringify(b.counts);
  const ta = stepPortfolio(a, candles);
  assert.equal(JSON.stringify(b.counts), beforeB, 'stepping A does not touch B');
  const tb = stepPortfolio(b, candles);
  assert.ok(ta.every((t) => t.portfolio === a.key));
  assert.ok(tb.every((t) => t.portfolio === b.key));
  assert.notEqual(a.key, b.key);
  assert.equal(stepPortfolio(a, candles).length, 0, 'stepping again on the same bars creates nothing');
});

test('an incremental run gives exactly the trades of a single run, even mid-signal', () => {
  const candles = bars([...SETUP, WIN_BAR]);
  const once = newPortfolio('pdh-break', 'any');
  const all = stepPortfolio(once, candles);
  const twice = newPortfolio('pdh-break', 'any');
  const part = stepPortfolio(twice, candles.slice(0, 3));
  assert.equal(twice.pending !== null, true, 'the cut falls between signal and fill');
  const rest = stepPortfolio(twice, candles);
  assert.equal(JSON.stringify([...part, ...rest]), JSON.stringify(all));
});

test('strategy version changes with any cost assumption, so experiments never share results', () => {
  const base = newPortfolio('pdh-break', 'any');
  assert.equal(newPortfolio('pdh-break', 'any').strategy_version, base.strategy_version);
  assert.notEqual(newPortfolio('pdh-break', 'any', { costs: { commissionPerSide: 2 } }).strategy_version, base.strategy_version);
  assert.notEqual(newPortfolio('pdh-break', 'above50').strategy_version, base.strategy_version);
});

test('unknown candidates, contracts and non-research sources are refused', () => {
  assert.throws(() => newPortfolio('moon-break', 'any'), /unknown candidate/);
  assert.throws(() => newPortfolio('pdh-break', 'any', { contract: 'ES' }), /unknown contract/);
  assert.throws(() => newPortfolio('pdh-break', 'any', { source: 'funded' }), /not a research environment/);
  assert.throws(() => newPortfolio('pdh-break', 'any', { source: 'broker_sim' }), /not a research environment/);
});

// ─── Record validation and journal ────────────────────────────────────────

const winTrade = () => runPortfolio([...SETUP, WIN_BAR]).trades[0];
const lossTrade = () => runPortfolio([...SETUP, STOP_BAR]).trades[0];

test('a bar that opens a trade and stops it out on the same bar is a valid record', () => {
  // Bar 3 opens at 101.6 (the entry) and its low, 99, is through the 99.75 stop.
  const { trades } = runPortfolio([...SETUP.slice(0, 3), [101.6, 102, 99, 100]]);
  const t = trades[0];
  assert.equal(t.entry.time, t.exit.time, 'the same daily bar');
  assert.equal(t.exit.reason, 'stop');
  assert.deepEqual(validateTradeRecord(t), []);
});

test('a real trade record passes validation and carries its cost assumptions', () => {
  const t = winTrade();
  assert.deepEqual(validateTradeRecord(t), []);
  assert.deepEqual(t.cost_assumptions, { ...COSTS });
  assert.equal(t.environment, 'paper');
});

test('invalid records are refused with the reason', () => {
  const t = winTrade();
  assert.ok(validateTradeRecord({ ...t, portfolio: undefined }).includes('missing portfolio'));
  assert.ok(validateTradeRecord({ ...t, environment: 'backtest' }).some((p) => p.includes('disagree')));
  assert.ok(validateTradeRecord({ ...t, environment: 'funded', source: 'paper' }).length > 0, 'funded records are never journalled here');
  assert.ok(validateTradeRecord({ ...t, exit: { ...t.exit, time: day(0) } }).includes('exit must not come before entry'));
  assert.ok(validateTradeRecord({ ...t, net_pnl: NaN }).some((p) => p.includes('not a number')));
  assert.ok(validateTradeRecord({ ...t, stop: 103 }).some((p) => p.includes('wrong side')));
});

test('the journal keeps losing trades, skips identical repeats, and reports conflicts without overwriting', async () => {
  const store = memStore();
  const win = winTrade();
  const loss = runPortfolio([LEAD, ...SETUP, STOP_BAR]).trades[0];   // same rules, a later entry
  assert.equal(loss.entry.time, day(4));
  assert.deepEqual(await appendTrades(store, [win, loss]), { written: 2, duplicates: 0, conflicts: [] });
  assert.deepEqual(await appendTrades(store, [win]), { written: 0, duplicates: 1, conflicts: [] });
  const changed = { ...win, net_pnl: 999, result: 'win' };
  const conflict = await appendTrades(store, [changed]);
  assert.equal(conflict.written, 0);
  assert.equal(conflict.conflicts.length, 1, 'a different outcome for an existing trade is a conflict');
  const rows = await readTrades(store);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.result === 'loss'), 'the losing trade is kept');
  assert.ok(rows.every((r) => r.net_pnl !== 999), 'the original is never overwritten');
});

test('a batch with one invalid record writes nothing', async () => {
  const store = memStore();
  const bad = { ...winTrade(), exit: { ...winTrade().exit, reason: 'nope' } };
  await assert.rejects(appendTrades(store, [winTrade(), bad]), /refused/);
  assert.equal(store.m.size, 0);
});

test('backtest and paper records of the same rules are kept apart', async () => {
  const store = memStore();
  const paper = winTrade();
  const backtest = runPortfolio([...SETUP, WIN_BAR], { source: 'backtest' }).trades[0];
  assert.equal(paper.strategy_version, backtest.strategy_version);
  assert.notEqual(recordKey(paper), recordKey(backtest));
  assert.equal((await appendTrades(store, [paper, backtest])).written, 2);
  const rows = await readTrades(store);
  assert.deepEqual(rows.map((r) => r.environment).sort(), ['backtest', 'paper']);
});
