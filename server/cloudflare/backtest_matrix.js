// NQ backtest matrix (owner, 2026-10-22): every CHE strategy on every timeframe CHE has
// real history for, at least 30 trades a cell before a cell counts, broken down by the
// New York hour of entry, so CHE can say which strategy works best on which timeframe and
// at what time of day.
//
// Data, as deep as each free source goes (all delayed CME data, research only):
//   1m          Yahoo NQ=F 1-minute bars, about the last 7 days
//   5m          Yahoo NQ=F 5-minute bars, about the last 60 days; 15m and 30m are built from them
//   1h          Yahoo NQ=F 1-hour bars, about the last 730 days; 4h is built from them
//   1d          Stooq nq.f daily history, back to the start of Stooq's series
//   1w, 1M      built from the daily bars
//   15s         no source: CHE has no sub-minute NQ history, so it is reported, never estimated
// A deeper intraday history needs a paid data vendor or the owner's broker data feed.
//
// The rules are trading_lab.js strategies (the ten in strategy_sim.js SIM_STRATEGIES): long only,
// one trade at a time, entry at the signal bar's close, stop checked before target inside a
// bar (worst case). Costs are trading_evidence.js COSTS for one MNQ contract, taken off every
// trade in R. The first 70% of each history is where results are learned; the last 30% is
// unseen and reported as it is. No model is called and nothing is fitted.

import { loadCandles, prepare, prepareSession, strategyById } from './trading_lab.js';
import { parseYahooChart } from './market_feed.js';
import { SIM_STRATEGIES, sessionOf } from './strategy_sim.js';
import { COSTS, CONTRACTS, MIN_TRADES, wilsonInterval } from './trading_evidence.js';

export const MATRIX_KEY = 'backtest_matrix';
export const SPLIT = 0.7;
const WARMUP = 60;
const MIN = 60_000;
const HOUR = 60 * MIN;

/// Timeframes from the owner's ask (15 seconds to 1 month). `from` names the bars a
/// timeframe is built from; `source` is where its own bars come from.
export const TIMEFRAMES = Object.freeze([
  { id: '15s', label: '15 seconds', unavailable: 'CHE has no sub-minute NQ history. A tick or second-bar data feed is needed.' },
  { id: '1m', label: '1 minute', source: { interval: '1m', range: '7d', barMs: MIN }, depth: 'about 7 days' },
  { id: '5m', label: '5 minutes', source: { interval: '5m', range: '60d', barMs: 5 * MIN }, depth: 'about 60 days' },
  { id: '15m', label: '15 minutes', from: '5m', ms: 15 * MIN, depth: 'about 60 days' },
  { id: '30m', label: '30 minutes', from: '5m', ms: 30 * MIN, depth: 'about 60 days' },
  { id: '1h', label: '1 hour', source: { interval: '1h', range: '730d', barMs: HOUR }, depth: 'about 2 years' },
  { id: '4h', label: '4 hours', from: '1h', ms: 4 * HOUR, depth: 'about 2 years' },
  { id: '1d', label: '1 day', source: { stooq: 'nq.f' }, depth: 'Stooq daily history' },
  { id: '1w', label: '1 week', from: '1d', calendar: 'week', depth: 'Stooq daily history' },
  { id: '1M', label: '1 month', from: '1d', calendar: 'month', depth: 'Stooq daily history' },
]);

// New York session rules and the longest bar each can be tested on. The opening range is the first
// 15 minutes, so a longer bar would put later prices inside the range.
const SESSION_SIGNALS = new Map([['vwap-reclaim', 30 * MIN], ['opening-range', 15 * MIN]]);
const SESSION_MAX_MS = 30 * MIN;

/// Round-trip cost of one MNQ trade in index points: half the spread on each side, one tick of
/// slippage on the market entry and on a stop exit, commission and fees on both sides.
export function costPoints(exitByStop, contract = CONTRACTS.MNQ, costs = COSTS) {
  const tick = contract.tick;
  const slips = 1 + (exitByStop ? 1 : 0);
  const dollars = 2 * (costs.commissionPerSide + costs.feePerSide);
  return costs.spreadTicks * tick + slips * costs.slippageTicks * tick + dollars / contract.pointValue;
}

/// Bars of a fixed length built from shorter bars. A bucket counts only when every base bar in
/// it was received, so a gap (the daily break, a weekend, a missing bar) never makes a bar.
export function resample(bars, baseMs, targetMs) {
  const need = Math.round(targetMs / baseMs);
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.n === need) out.push({ t: new Date(cur.start).toISOString(), o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v }); };
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / targetMs) * targetMs;
    if (!cur || cur.start !== start) {
      flush();
      cur = { start, o: b.o, h: b.h, l: b.l, c: b.c, v: Number(b.v) || 0, n: 1, last: t };
    } else if (t === cur.last + baseMs) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += Number(b.v) || 0; cur.n += 1; cur.last = t;
    } else {
      cur.n = -Infinity; // a gap inside the bucket: never complete
    }
  }
  flush();
  return out;
}

/// Weekly (Monday-start, UTC) or monthly bars from daily bars. The newest period is left out
/// while it may still be forming.
export function calendarBars(daily, period, now = Date.now()) {
  const key = (ms) => {
    const d = new Date(ms);
    if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const day = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  };
  const groups = new Map();
  for (const b of daily) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t)) continue;
    const k = key(t);
    const g = groups.get(k);
    if (!g) groups.set(k, { t: new Date(k).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: Number(b.v) || 0 });
    else { g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += Number(b.v) || 0; }
  }
  const current = key(now);
  return [...groups.entries()].filter(([k]) => k !== current).sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
export function nyHour(iso) { return Number(NY_HOUR.format(new Date(iso))); }

/// Every trade of one strategy on bars [from, to), net of costs. A trade is entered at the signal
/// bar's close, so `in` is that bar's close time (open time + barMs); without a bar length it is the
/// bar's own time. A trade still open at `to` is dropped, so no result uses a price at or after `to`.
export function runStrategy(bars, strategyId, ctx, { from = 0, to = bars.length, barMs = 0 } = {}) {
  const strat = strategyById(strategyId);
  if (!strat) return [];
  const trades = [];
  let open = null;
  for (let i = Math.max(from, WARMUP, 51); i < Math.min(to, bars.length); i++) {
    const k = bars[i];
    if (open) {
      const risk = open.entry - open.stop;
      if (k.l <= open.stop) { trades.push(close(open, open.stop, -1, true, k.t, i)); open = null; }
      else if (k.h >= open.target) { trades.push(close(open, open.target, (open.target - open.entry) / risk, false, k.t, i)); open = null; }
      continue;
    }
    const e = strat.entry(bars, i, ctx);
    if (e && e.stop < e.entry && e.target > e.entry) open = { ...e, in: barMs ? new Date(Date.parse(k.t) + barMs).toISOString() : k.t, at: i };
  }
  return trades;
}

function close(open, exit, rGross, byStop, out, i) {
  const risk = open.entry - open.stop;
  const r = rGross - costPoints(byStop) / risk;
  return { in: open.in, out, at: open.at, closed_at: i, entry: open.entry, stop: open.stop, target: open.target, exit, r_gross: round(rGross), r: round(r) };
}

/// Plain statistics over net R. Win rate comes with its 95% Wilson interval.
export function summarize(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, win_rate: null, win_low: null, win_high: null, expectancy_r: null, total_r: 0, profit_factor: null, max_drawdown_r: 0 };
  let eq = 0, peak = 0, dd = 0, wins = 0, gross = 0, loss = 0;
  for (const t of trades) {
    eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    if (t.r > 0) { wins += 1; gross += t.r; } else loss -= t.r;
  }
  const w = wilsonInterval(wins, n);
  return {
    trades: n,
    win_rate: round(wins / n, 3), win_low: round(w.low, 3), win_high: round(w.high, 3),
    expectancy_r: round(eq / n), total_r: round(eq),
    profit_factor: loss ? round(gross / loss) : null,
    max_drawdown_r: round(dd),
  };
}

/// One cell: a strategy on a timeframe. `enough` is true only with at least MIN_TRADES trades.
export function contextFor(bars, tf) {
  return { ...prepare(bars), ...(tf.barMs && tf.barMs <= SESSION_MAX_MS ? prepareSession(bars, (t) => sessionOf('et', t)) : {}) };
}

export function evaluateCell(bars, strategy, tf, ctx = null) {
  const signal = strategy.signal || String(strategy.id).split('|')[0];
  if (SESSION_SIGNALS.has(signal) && !(tf.barMs && tf.barMs <= SESSION_SIGNALS.get(signal))) {
    return { strategy: strategy.id, name: strategy.name, timeframe: tf.id, applicable: false, why: `A New York session rule; it needs bars of ${SESSION_SIGNALS.get(signal) / MIN} minutes or less.` };
  }
  ctx ??= contextFor(bars, tf);
  // The two parts are run separately: a learning trade must close before the cut, and the unseen part
  // starts flat at the cut, so neither part's result uses the other's prices.
  const cut = Math.floor(bars.length * SPLIT);
  const barMs = tf.barMs && tf.barMs < 24 * HOUR ? tf.barMs : 0;
  const learn = runStrategy(bars, strategy.id, ctx, { to: cut, barMs });
  const unseen = runStrategy(bars, strategy.id, ctx, { from: cut, barMs });
  const trades = [...learn, ...unseen];
  const intraday = Boolean(tf.barMs && tf.barMs < 24 * HOUR);
  const hours = intraday ? byHour(trades) : null;
  return {
    strategy: strategy.id, name: strategy.name, timeframe: tf.id, applicable: true,
    bars: bars.length, first_bar: bars[0]?.t || null, last_bar: bars.at(-1)?.t || null,
    all: summarize(trades), learn: summarize(learn), unseen: summarize(unseen),
    enough: trades.length >= MIN_TRADES,
    hours,
  };
}

/// Results by the New York hour of entry. Only hours with MIN_TRADES trades are ranked.
export function byHour(trades) {
  const groups = new Map();
  for (const t of trades) {
    const h = nyHour(t.in);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(t);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([hour, list]) => ({ hour, ...summarize(list), enough: list.length >= MIN_TRADES }));
}

/// The whole matrix from bars already loaded: { '1m': [...], '5m': [...], '1h': [...], '1d': [...] }.
/// Built timeframes are derived here, so the loader stays small and the tests need no network.
export function buildMatrix(sourceBars, { now = Date.now(), strategies = SIM_STRATEGIES } = {}) {
  const series = {};
  const timeframes = [];
  for (const tf0 of TIMEFRAMES) {
    const tf = { ...tf0, barMs: tf0.source?.barMs || tf0.ms || (tf0.id === '1d' ? 24 * HOUR : null) };
    if (tf.unavailable) { timeframes.push({ id: tf.id, label: tf.label, available: false, why: tf.unavailable }); continue; }
    let bars = sourceBars[tf.id];
    if (!bars && tf.from) {
      const base = series[tf.from] || [];
      const baseTf = TIMEFRAMES.find((x) => x.id === tf.from);
      bars = tf.calendar ? calendarBars(base, tf.calendar, now) : resample(base, baseTf.source?.barMs || baseTf.ms, tf.ms);
    }
    bars = Array.isArray(bars) ? bars : [];
    series[tf.id] = bars;
    const usable = bars.length > WARMUP + 1;
    timeframes.push({
      id: tf.id, label: tf.label, available: usable, depth: tf.depth, bars: bars.length,
      first_bar: bars[0]?.t || null, last_bar: bars.at(-1)?.t || null,
      ...(usable ? {} : { why: bars.length ? `Only ${bars.length} bars: too few to test.` : 'No bars were received.' }),
      cells: usable ? (() => { const ctx = contextFor(bars, tf); return strategies.map((s) => evaluateCell(bars, s, tf, ctx)); })() : [],
    });
  }
  return { built_at: new Date(now).toISOString(), min_trades: MIN_TRADES, split: SPLIT, costs: costNote(), timeframes, ranking: rank(timeframes) };
}

/// Cells with at least MIN_TRADES trades and at least ten unseen trades, best unseen
/// expectancy first. A cell that lost on the unseen part is still listed, with its loss.
export function rank(timeframes) {
  const cells = timeframes.flatMap((tf) => (tf.cells || []).filter((c) => c.applicable && c.enough && c.unseen.trades >= 10));
  return cells
    .map((c) => {
      const bestHour = (c.hours || []).filter((h) => h.enough).sort((a, b) => b.expectancy_r - a.expectancy_r)[0] || null;
      return { strategy: c.strategy, name: c.name, timeframe: c.timeframe, trades: c.all.trades, learn_expectancy_r: c.learn.expectancy_r, unseen_expectancy_r: c.unseen.expectancy_r, unseen_trades: c.unseen.trades, win_rate: c.all.win_rate, best_hour: bestHour ? { hour: bestHour.hour, trades: bestHour.trades, expectancy_r: bestHour.expectancy_r } : null, holds_up: c.learn.expectancy_r > 0 && c.unseen.expectancy_r > 0 };
    })
    .sort((a, b) => b.unseen_expectancy_r - a.unseen_expectancy_r);
}

function costNote() {
  return `One MNQ contract: ${COSTS.spreadTicks} tick spread, ${COSTS.slippageTicks} tick slippage on the entry and on stop exits, $${COSTS.commissionPerSide.toFixed(2)} commission and $${COSTS.feePerSide.toFixed(2)} fees per side (assumed). Results are in R, net of these costs.`;
}

/// Loads every source series. A source that fails is reported in `errors`; the rest still run.
export async function loadMatrixBars({ fetcher = fetch, now = Date.now() } = {}) {
  const out = {};
  const errors = {};
  for (const tf of TIMEFRAMES) {
    if (!tf.source) continue;
    try {
      if (tf.source.stooq) {
        const d = await loadCandles(tf.source.stooq, { fetcher });
        if (d.error) throw new Error(d.error);
        out[tf.id] = d.candles;
      } else {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=${tf.source.interval}&range=${tf.source.range}&includePrePost=true`;
        const res = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`Yahoo answered ${res.status}`);
        const parsed = parseYahooChart(await res.json(), now, tf.source.barMs);
        if (parsed.error) throw new Error(parsed.error);
        out[tf.id] = parsed.candles;
      }
    } catch (err) {
      errors[tf.id] = String(err?.message || err).slice(0, 200);
    }
  }
  return { bars: out, errors };
}

/// Spoken summary: the few best cells that hold up, and what could not be tested. No advice.
export function speakMatrix(m) {
  if (!m?.timeframes) return 'The backtest matrix has not been run yet.';
  const tested = m.timeframes.filter((t) => t.available);
  const missing = m.timeframes.filter((t) => !t.available).map((t) => t.label);
  const good = (m.ranking || []).filter((r) => r.holds_up).slice(0, 3);
  const parts = [`I tested ${SIM_STRATEGIES.length} strategies on ${tested.length} timeframes of NQ history, net of costs, counting a result only with at least ${m.min_trades} trades.`];
  if (!good.length) parts.push('No strategy and timeframe made money on both the learning part and the unseen part.');
  for (const r of good) {
    const hour = r.best_hour ? ` Its best hour was ${r.best_hour.hour}:00 New York time, ${r.best_hour.expectancy_r} R a trade over ${r.best_hour.trades} trades.` : '';
    parts.push(`${r.name} on the ${label(r.timeframe)} chart: ${r.unseen_expectancy_r} R a trade on ${r.unseen_trades} unseen trades.${hour}`);
  }
  if (missing.length) parts.push(`Not tested: ${missing.join(', ')}.`);
  parts.push('This is delayed history and paper results, not a promise about tonight.');
  return parts.join(' ');
}

/// Saved one timeframe per key: a Durable Object value is limited to 128 KB.
export async function saveMatrix(storage, m) {
  for (const tf of m.timeframes) await storage.put(`${MATRIX_KEY}:${tf.id}`, tf);
  await storage.put(MATRIX_KEY, { built_at: m.built_at, min_trades: m.min_trades, split: m.split, costs: m.costs, errors: m.errors || {}, ranking: m.ranking, timeframes: m.timeframes.map((t) => t.id) });
}

export async function readMatrix(storage) {
  const head = await storage.get(MATRIX_KEY);
  if (!head) return null;
  const timeframes = [];
  for (const id of head.timeframes || []) {
    const tf = await storage.get(`${MATRIX_KEY}:${id}`);
    if (tf) timeframes.push(tf);
  }
  return { ...head, timeframes };
}

/// Loads, tests and saves the whole matrix. Free public data only; no order is placed.
export async function runMatrix(storage, { fetcher = fetch, now = Date.now() } = {}) {
  const { bars, errors } = await loadMatrixBars({ fetcher, now });
  const m = { ...buildMatrix(bars, { now }), errors };
  for (const tf of m.timeframes) if (!tf.available && errors[tf.id]) tf.why = `The data source did not answer: ${errors[tf.id]}`;
  await saveMatrix(storage, m);
  return m;
}

/// "Which strategy is best on which timeframe", "best time of day to trade NQ", "/trade-matrix run".
/// Decades-of-history questions stay with historical_intelligence.js.
export function matrixIntent(message) {
  const text = String(message || '');
  const frames = /\b(?:time ?frames?|every chart|all charts|time of (?:the )?day|best (?:hour|time)|which hours?|what hours?|matrix)\b/i;
  const trading = /\b(?:strateg\w*|backtest\w*|nq|mnq|nasdaq|trad\w*)\b/i;
  if (!frames.test(text) || !trading.test(text)) return null;
  // This matrix is NQ only. A question about another market is not answered with NQ results.
  const nq = /\b(?:nq|mnq|nasdaq)\b/i.test(text);
  const other = /\b(?:es|mes|s\s*&\s*p|spx|spy|qqq|dow|ym|mym|russell|rty|m2k|gold|gc|silver|oil|cl|bitcoin|btc|ether(?:eum)?|eth|crypto|forex|eur\s*\/?\s*usd|stocks?|aapl|tsla|nvda)\b/i.test(text);
  if (other && !nq) return null;
  if (/\b(?:run|start|begin|refresh|update|redo|re-?run|test|backtest)\b[\s\S]{0,60}\b(?:strateg\w*|time ?frames?|matrix|backtest)\b/i.test(text)) return { kind: 'run' };
  return { kind: 'summary' };
}

const label = (id) => TIMEFRAMES.find((t) => t.id === id)?.label || id;
function round(x, d = 2) { const p = 10 ** d; return Math.round(x * p) / p; }
