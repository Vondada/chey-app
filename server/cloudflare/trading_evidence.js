// Trading evidence: deterministic execution, statistics and isolated forward-paper
// portfolios for CHE's NQ/MNQ strategy research. Pure functions over candles, so
// every number can be recomputed from the recorded trades. No model is called per
// trade. Every record states its data quality: daily bars are approximate, and ideas
// that need intraday sessions are reported as untestable until intraday data exists.

export const CONTRACTS = Object.freeze({
  MNQ: { name: 'MNQ', tick: 0.25, pointValue: 2 },
  NQ: { name: 'NQ', tick: 0.25, pointValue: 20 },
});

// Assumed costs: round planning numbers, not a broker's schedule. Each portfolio and
// trade record stores the values it used. A change of costs is a new strategy version,
// so experiments with different costs never share a result.
export const COSTS = Object.freeze({
  spreadTicks: 1,          // full spread; half is paid on each side
  slippageTicks: 1,        // per side on market orders (entries and stop exits)
  commissionPerSide: 1.5,  // dollars per contract per side
  feePerSide: 0.5,         // exchange and regulatory fees per contract per side
});

export const MIN_TRADES = 30;   // below this a result is anecdote, not evidence
export const TARGET_R = 2;      // every candidate targets two times its risk

const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;
const finite = (x) => Number.isFinite(x);

// ─── Data quality ─────────────────────────────────────────────────────────

// Returns the problems in a candle series. An empty list means it may be used.
export function candleProblems(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return ['no candles'];
  const problems = [];
  candles.forEach((b, i) => {
    if (!b || !b.t || ![b.o, b.h, b.l, b.c].every(finite)) {
      problems.push(`bar ${i} is missing a time or a numeric price`);
      return;
    }
    if (b.l > b.h || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) problems.push(`bar ${i} has an impossible range`);
    if (i > 0 && !(b.t > candles[i - 1].t)) problems.push(`bar ${i} is not after the bar before it`);
  });
  return problems.slice(0, 10);
}

// ─── Execution ────────────────────────────────────────────────────────────

// Market buy at the next bar's open: half the spread and slippage are paid.
export function fillEntry(bar, contract, costs = COSTS) {
  const half = (costs.spreadTicks * contract.tick) / 2;
  const slip = costs.slippageTicks * contract.tick;
  return { raw: bar.o, price: r4(bar.o + half + slip), spread: half, slippage: slip };
}

// A stop is a market sell: half the spread and slippage. A target is a resting limit
// sell: half the spread only, because it cannot fill worse than its price.
export function fillExit(price, reason, contract, costs = COSTS) {
  const half = (costs.spreadTicks * contract.tick) / 2;
  const slip = reason === 'stop' ? costs.slippageTicks * contract.tick : 0;
  return { raw: price, price: r4(price - half - slip), spread: half, slippage: slip };
}

// Decides whether a bar closes a long trade. Stops are market orders and fill at the
// open when the market gapped through them. Targets are limits and fill at the open
// when it gapped above them. If one bar touches both, the stop is assumed first
// (conservative) and the record says so.
export function exitOn(pos, bar, contract, costs = COSTS) {
  const stopHit = bar.l <= pos.stop;
  const targetHit = bar.h >= pos.target;
  if (stopHit) return { reason: 'stop', exit: fillExit(Math.min(bar.o, pos.stop), 'stop', contract, costs), same_bar_both: targetHit };
  if (targetHit) return { reason: 'target', exit: fillExit(Math.max(bar.o, pos.target), 'target', contract, costs), same_bar_both: false };
  return null;
}

// Long-only trade. Costs are in dollars for `qty` contracts.
export function settleTrade(position, exit, qty, contract, costs = COSTS) {
  const pv = contract.pointValue * qty;
  const gross = (exit.raw - position.entry.raw) * pv;
  const spread = (position.entry.spread + exit.spread) * pv;
  const slippage = (position.entry.slippage + exit.slippage) * pv;
  const commissions = 2 * qty * costs.commissionPerSide;
  const fees = 2 * qty * costs.feePerSide;
  const net = gross - spread - slippage - commissions - fees;
  const riskDollars = (position.entry.raw - position.stop) * pv;
  return {
    gross_before_costs: r2(gross),
    costs: { spread: r2(spread), slippage: r2(slippage), commissions: r2(commissions), fees: r2(fees) },
    net_pnl: r2(net),
    r_gross: riskDollars > 0 ? r4(gross / riskDollars) : 0,
    r_net: riskDollars > 0 ? r4(net / riskDollars) : 0,
    risk_dollars: r2(riskDollars),
  };
}

// ─── Sessions ─────────────────────────────────────────────────────────────

// New York session of an intraday bar. Daily bars are simply 'daily'.
export function sessionOf(time, resolution = 'daily') {
  if (resolution === 'daily' || !/T\d/.test(String(time))) return 'daily';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(time)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (mins === 510) return 'econ-0830';          // the 8:30 AM release bar
  if (mins < 570) return 'pre-open';             // before 9:30 AM
  if (mins < 600) return 'opening-30m';
  if (mins < 780) return 'mid-morning';
  if (mins < 960) return 'afternoon';
  return 'close-and-overnight';
}

// ─── Causal indicators: each value uses only bars up to and including its own bar ─

// A swing low at bar j needs swingN bars after it, so it is known only once bar j + swingN closes.
function isSwingLow(c, j, n) {
  for (let m = j - n; m <= j + n; m++) if (m !== j && c[m].l <= c[j].l) return false;
  return true;
}

export function causalContext(candles, { swingN = 3, atrN = 14, smaN = 50 } = {}) {
  const n = candles.length;
  const atr14 = new Array(n).fill(null);
  const sma50 = new Array(n).fill(null);
  const lastLow = new Array(n).fill(null);
  const tr = candles.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - candles[i - 1].c), Math.abs(b.l - candles[i - 1].c))));
  let trSum = 0;
  let closeSum = 0;
  let confirmedLow = null;
  for (let i = 0; i < n; i++) {
    trSum += tr[i];
    if (i >= atrN) trSum -= tr[i - atrN];
    if (i >= atrN - 1) atr14[i] = trSum / atrN;
    closeSum += candles[i].c;
    if (i >= smaN) closeSum -= candles[i - smaN].c;
    if (i >= smaN - 1) sma50[i] = closeSum / smaN;
    const j = i - swingN;
    if (j - swingN >= 0 && isSwingLow(candles, j, swingN)) confirmedLow = candles[j].l;
    lastLow[i] = confirmedLow;
  }
  return { atr14, sma50, lastLow };
}

// ─── Candidate strategies (long-only, closed bars only) ───────────────────

export const CANDIDATES = Object.freeze({
  'pdh-break': {
    name: 'previous-day high break',
    entry(c, i) {
      if (i < 2 || !(c[i].c > c[i - 1].h && c[i - 1].c <= c[i - 2].h)) return null;
      return { ref: c[i].c, stop: c[i].l - 0.25, why: `closed above the previous high ${r2(c[i - 1].h)}` };
    },
  },
  'sweep-reclaim': {
    name: 'liquidity sweep and reclaim',
    entry(c, i, x) {
      const level = x.lastLow[i - 1];
      if (level == null || !(c[i].l < level && c[i].c > level && c[i].c > c[i].o)) return null;
      return { ref: c[i].c, stop: c[i].l - 0.25, why: `swept the swing low ${r2(level)} and closed back above it` };
    },
  },
  'fvg-retest': {
    name: 'fair value gap retest',
    entry(c, i) {
      if (i < 4 || !(c[i].c > c[i].o)) return null;
      for (let j = i - 2; j >= Math.max(0, i - 10); j--) {
        if (!(c[j].h < c[j + 2].l)) continue;            // bullish gap between bars j and j+2
        const top = c[j + 2].l;
        const bottom = c[j].h;
        if (c[i].l <= top && c[i].c >= bottom) {
          if (c.slice(j + 3, i).some((k) => k.l <= bottom)) return null;   // only an unfilled gap's first retest counts
          return { ref: c[i].c, stop: bottom - 0.25, why: `retested the bullish gap ${r2(bottom)} to ${r2(top)}` };
        }
      }
      return null;
    },
  },
  'displacement-continuation': {
    name: 'displacement continuation',
    entry(c, i, x) {
      if (i < 2) return null;
      const d = c[i - 1];
      const atr = x.atr14[i - 1];
      if (atr == null || !(d.c > d.o && d.c - d.o >= 1.5 * atr && c[i].c > d.h)) return null;
      return { ref: c[i].c, stop: d.l, why: `broke above a displacement bar of ${r2(d.c - d.o)} points` };
    },
  },
  'order-block-retest': {
    name: 'order block retest',
    entry(c, i, x) {
      if (i < 3) return null;
      const d = c[i - 1];
      const atr = x.atr14[i - 1];
      if (atr == null || !(d.c > d.o && d.c - d.o >= 1.5 * atr)) return null;
      let block = null;
      for (let b = i - 2; b >= Math.max(0, i - 6); b--) if (c[b].c < c[b].o) { block = c[b]; break; }
      if (!block || !(c[i].l <= block.h && c[i].c >= block.l && c[i].c > c[i].o)) return null;
      return { ref: c[i].c, stop: block.l - 0.25, why: `retested the last down candle before a displacement, ${r2(block.l)} to ${r2(block.h)}` };
    },
  },
});

// Ideas that cannot be tested on daily bars. They are reported as untestable, never estimated.
export const NEEDS_INTRADAY = Object.freeze({
  'opening-range-breakout': 'needs 9:30 AM New York intraday bars',
  'vwap-deviation': 'needs an intraday session VWAP',
  'session-levels': 'needs intraday session highs and lows',
});

export const FILTERS = Object.freeze({
  any: { name: 'any trend', ok: () => true },
  above50: { name: 'above the 50-day average', ok: (c, i, x) => x.sma50[i] != null && c[i].c > x.sma50[i] },
});

function conditionOf(c, k, x) {
  const trend = x.sma50[k] == null ? 'no-trend-data' : c[k].c > x.sma50[k] ? 'above-50d' : 'below-50d';
  const recent = x.atr14.slice(Math.max(0, k - 50), k).filter((v) => v != null);
  const avg = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : null;
  const volatility = x.atr14[k] == null || avg == null ? 'unknown' : x.atr14[k] > 1.5 * avg ? 'high-vol' : 'normal-vol';
  return { trend, volatility };
}

// A deterministic version: the same candidate, filter, parameters and costs always give the same version.
export function strategyVersion(candidateId, filterId, params = {}) {
  const text = JSON.stringify({ candidateId, filterId, params });
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `v-${h.toString(16).padStart(8, '0')}`;
}

// ─── Portfolios: one isolated state per strategy version and source ───────

export function newPortfolio(candidateId, filterId, {
  contract = 'MNQ', qty = 1, source = 'paper', resolution = 'daily', priceSeries = 'unknown', costs = {}, params = {},
} = {}) {
  if (!CANDIDATES[candidateId]) throw new Error(`unknown candidate ${candidateId}`);
  if (!FILTERS[filterId]) throw new Error(`unknown filter ${filterId}`);
  if (!CONTRACTS[contract]) throw new Error(`unknown contract ${contract}`);
  if (!['backtest', 'paper'].includes(source)) throw new Error(`source ${source} is not a research environment`);
  if (!(qty > 0)) throw new Error('quantity must be positive');
  const fullCosts = { ...COSTS, ...costs };
  const fullParams = { target_r: TARGET_R, ...params };
  const version = strategyVersion(candidateId, filterId, { ...fullParams, contract, qty, costs: fullCosts });
  return {
    key: `${candidateId}|${filterId}@${version}`,
    candidate: candidateId, filter: filterId, strategy_version: version,
    contract, qty, source, resolution, price_series: priceSeries, costs: fullCosts, params: fullParams,
    open: null, pending: null, last_bar_time: null,
    counts: { bars: 0, signals: 0, filled: 0, gap_skipped: 0, closed: 0 },
  };
}

// Processes each new bar in time order. A signal is read from the closed bar; the
// trade fills at the next bar's open. Returns the trades that closed in this step.
// Portfolio state persists, so a later step continues where this one stopped.
export function stepPortfolio(pf, candles, ctx = causalContext(candles)) {
  const problems = candleProblems(candles);
  if (problems.length) throw new Error(`candles refused: ${problems.join('; ')}`);
  const cand = CANDIDATES[pf.candidate];
  const filter = FILTERS[pf.filter];
  const contract = CONTRACTS[pf.contract];
  const closed = [];
  const start = pf.last_bar_time == null ? 0 : candles.findIndex((b) => b.t > pf.last_bar_time);
  if (start < 0) return closed;
  for (let k = start; k < candles.length; k++) {
    const bar = candles[k];
    if (pf.pending && !pf.open) {
      const sig = pf.pending;
      pf.pending = null;
      // The open may already have passed the planned stop or target. Then the plan is void: skip, never invent a fill.
      if (bar.o > sig.stop && bar.o < sig.target) {
        pf.open = {
          signal_time: sig.signal_time, signal_why: sig.why, signal_ref: sig.ref, condition: sig.condition,
          entry_time: bar.t, entry: fillEntry(bar, contract, pf.costs), stop: sig.stop, target: sig.target,
          max_high: bar.o, min_low: bar.o, session: sessionOf(bar.t, pf.resolution),
        };
        pf.counts.filled += 1;
      } else {
        pf.counts.gap_skipped += 1;
      }
    }
    if (pf.open) {
      pf.open.max_high = Math.max(pf.open.max_high, bar.h);
      pf.open.min_low = Math.min(pf.open.min_low, bar.l);
      const hit = exitOn(pf.open, bar, contract, pf.costs);
      if (hit) closed.push(closeAt(pf, bar, hit));
    }
    if (!pf.open && !pf.pending && cand && filter.ok(candles, k, ctx)) {
      const sig = cand.entry(candles, k, ctx);
      if (sig && finite(sig.ref) && finite(sig.stop) && sig.ref - sig.stop >= 0.25) {
        pf.pending = {
          signal_time: bar.t, why: sig.why, ref: sig.ref, stop: sig.stop,
          target: r4(sig.ref + TARGET_R * (sig.ref - sig.stop)), condition: conditionOf(candles, k, ctx),
        };
        pf.counts.signals += 1;
      }
    }
    pf.last_bar_time = bar.t;
    pf.counts.bars += 1;
  }
  return closed;
}

function closeAt(pf, bar, hit) {
  const pos = pf.open;
  const contract = CONTRACTS[pf.contract];
  const settled = settleTrade(pos, hit.exit, pf.qty, contract, pf.costs);
  const riskPts = pos.entry.raw - pos.stop;
  const up = pos.max_high - pos.entry.raw;
  const down = pos.entry.raw - pos.min_low;
  const trade = {
    source: pf.source,
    environment: pf.source === 'paper' ? 'paper' : 'backtest',
    portfolio: pf.key,
    symbol: pf.contract,
    contract: pf.contract,
    qty: pf.qty,
    strategy: pf.candidate,
    filter: pf.filter,
    strategy_version: pf.strategy_version,
    params: pf.params,
    side: 'long',
    session: pos.session,
    signal: { time: pos.signal_time, why: pos.signal_why, ref: pos.signal_ref },
    condition: pos.condition,
    entry: { time: pos.entry_time, raw: pos.entry.raw, fill: pos.entry.price, spread: pos.entry.spread, slippage: pos.entry.slippage, basis: 'next_bar_open' },
    stop: pos.stop,
    target: pos.target,
    risk_points: r4(riskPts),
    exit: { time: bar.t, raw: hit.exit.raw, fill: hit.exit.price, reason: hit.reason },
    same_bar_both_touched: hit.same_bar_both,
    ...settled,
    mfe_points: r2(up),
    mae_points: r2(down),
    mfe_r: riskPts > 0 ? r2(up / riskPts) : 0,
    mae_r: riskPts > 0 ? r2(down / riskPts) : 0,
    data: {
      resolution: pf.resolution,
      price_series: pf.price_series,
      label: pf.resolution === 'daily' ? 'approximate: daily bars, fills at the next open' : 'intraday bars',
    },
    cost_assumptions: { ...pf.costs },
    result: settled.net_pnl > 0 ? 'win' : settled.net_pnl < 0 ? 'loss' : 'flat',
  };
  pf.open = null;
  pf.counts.closed += 1;
  return trade;
}

// ─── Record validation ────────────────────────────────────────────────────

const REQUIRED = [
  'source', 'environment', 'portfolio', 'symbol', 'contract', 'strategy', 'strategy_version', 'side', 'session',
  'signal', 'entry', 'exit', 'stop', 'target', 'qty', 'costs', 'net_pnl', 'r_net',
  'mfe_points', 'mae_points', 'data', 'cost_assumptions', 'params',
];

// Returns the problems in a trade record. An empty list means it may be journalled.
export function validateTradeRecord(t) {
  const problems = [];
  for (const key of REQUIRED) if (t?.[key] === undefined || t?.[key] === null) problems.push(`missing ${key}`);
  if (problems.length) return problems;
  if (t.environment !== (t.source === 'paper' ? 'paper' : 'backtest')) problems.push('source and environment disagree');
  if (!['backtest', 'paper'].includes(t.environment)) problems.push('only backtest and paper records are journalled here');
  if (!CANDIDATES[t.strategy]) problems.push('unknown strategy');
  if (!(t.stop < t.entry.raw && t.target > t.entry.fill)) problems.push('stop and target are on the wrong side of the entry');
  if (!['stop', 'target'].includes(t.exit.reason)) problems.push('exit reason must be stop or target');
  // Equal times are valid: a bar can open the trade and stop it out on the same bar.
  if (!(t.entry.time <= t.exit.time)) problems.push('exit must not come before entry');
  for (const v of [t.entry.fill, t.exit.fill, t.net_pnl, t.r_net, t.qty]) if (!finite(v)) problems.push('a price or amount is not a number');
  if (!(t.qty > 0)) problems.push('quantity must be positive');
  if (!t.data?.label) problems.push('data quality label missing');
  return problems;
}

// ─── Statistics (never a win rate alone) ──────────────────────────────────

// Wilson 95% interval for a proportion: the honest range, especially at small n.
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { low: 0, high: 0 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function sampleStatus(n) {
  if (n < MIN_TRADES) return 'insufficient';
  if (n < 100) return 'low';
  return 'adequate';
}

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net_pnl > 0);
  const losses = trades.filter((t) => t.net_pnl < 0);
  const rs = trades.map((t) => t.r_net);
  const mean = n ? rs.reduce((s, v) => s + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
  const grossWin = wins.reduce((s, t) => s + t.net_pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net_pnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.net_pnl, 0);
  let equity = 0; let peak = 0; let dd = 0; let eqR = 0; let peakR = 0; let ddR = 0;
  for (const t of trades) {
    equity += t.net_pnl; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
    eqR += t.r_net; peakR = Math.max(peakR, eqR); ddR = Math.max(ddR, peakR - eqR);
  }
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const ci = wilsonInterval(wins.length, n);
  return {
    trades: n,
    sample: sampleStatus(n),
    wins: wins.length,
    losses: losses.length,
    flat: n - wins.length - losses.length,
    win_rate: n ? r2((100 * wins.length) / n) : null,
    win_rate_95ci: n ? { low: r2(100 * ci.low), high: r2(100 * ci.high) } : null,
    avg_winner: r2(avgWin),
    avg_loser: r2(-avgLoss),
    risk_reward: avgLoss ? r2(avgWin / avgLoss) : null,
    expectancy_r: r4(mean),
    expectancy_r_95ci: { low: r4(mean - half), high: r4(mean + half) },
    expectancy_dollars: n ? r2(netPnl / n) : null,
    net_pnl: r2(netPnl),
    profit_factor: grossLoss ? r2(grossWin / grossLoss) : null,   // null: no losing trades, or none at all
    max_drawdown: r2(dd),
    max_drawdown_r: r4(ddR),
    costs_paid: r2(trades.reduce((s, t) => s + t.costs.spread + t.costs.slippage + t.costs.commissions + t.costs.fees, 0)),
    long: trades.filter((t) => t.side === 'long').length,
    short: trades.filter((t) => t.side === 'short').length,
  };
}

// Breakdowns for the dashboard, for example by session, condition or strategy version.
export function breakdown(trades, keyOf) {
  const groups = {};
  for (const t of trades) (groups[keyOf(t)] ||= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, summarize(list)]));
}

// Anchored walk-forward. The first `minTrain` share is the training period; the rest is
// cut into equal, consecutive test folds. The rules are frozen before the test, so the
// training period is used only to compare, never to tune.
export function walkForwardFolds(n, { folds = 4, minTrain = 0.4 } = {}) {
  const start = Math.floor(n * minTrain);
  const size = Math.floor((n - start) / folds);
  if (size < 1) return [];
  const out = [];
  for (let f = 0; f < folds; f++) {
    const testStart = start + f * size;
    const testEnd = f === folds - 1 ? n : testStart + size;
    out.push({ fold: f + 1, trainEnd: testStart, testStart, testEnd });
  }
  return out;
}

const byEntry = (a, b) => String(a.entry.time).localeCompare(String(b.entry.time));

// Evaluates trades in time order, fold by fold. Returns the out-of-sample trades too.
export function evaluateWalkForward(trades, opts = {}) {
  const sorted = [...trades].sort(byEntry);
  const folds = walkForwardFolds(sorted.length, opts);
  const rows = folds.map((f) => {
    const part = sorted.slice(f.testStart, f.testEnd);
    const s = summarize(part);
    return {
      fold: f.fold,
      test_from: part[0]?.entry.time ?? null,
      test_to: part[part.length - 1]?.entry.time ?? null,
      trades: s.trades, net_pnl: s.net_pnl, expectancy_r: s.expectancy_r, profit_factor: s.profit_factor,
    };
  });
  return {
    folds: rows,
    folds_total: rows.length,
    folds_positive: rows.filter((r) => r.trades > 0 && r.net_pnl > 0).length,
    oos: folds.length ? sorted.slice(folds[0].testStart) : [],
  };
}

// Promotion needs statistically meaningful, out-of-sample evidence on intraday data.
// Daily results can rank an idea, but they can never promote it.
export function promotionVerdict(oosTrades, { resolution = 'daily', foldsPositive = 0, folds = 0 } = {}) {
  const s = summarize(oosTrades);
  const reasons = [];
  if (resolution !== 'intraday') reasons.push('evidence is approximate (daily bars): it can rank an idea, not promote it');
  if (s.trades < MIN_TRADES) reasons.push(`only ${s.trades} out-of-sample trades; ${MIN_TRADES} are needed`);
  if (!(s.expectancy_r_95ci.low > 0)) reasons.push('the 95% range of expectancy in R includes zero or less');
  const pfOk = s.profit_factor === null ? s.wins > 0 : s.profit_factor > 1.2;
  if (!pfOk) reasons.push('profit factor after costs is not above 1.2');
  if (!folds) reasons.push('no walk-forward folds were tested');
  else if (foldsPositive / folds < 0.6) reasons.push('fewer than 60% of walk-forward folds were profitable');
  return { promote: reasons.length === 0, reasons, summary: s };
}

// ─── Evidence journal: append-only; losing trades and failed experiments are kept ─

export const RECORD_PREFIX = 'evr:';
const CHUNK = 100;   // Durable Object storage accepts up to 128 keys per call

// One trade is one key: a portfolio holds at most one open trade, so its entry bar identifies it.
export function recordKey(t) {
  return `${RECORD_PREFIX}${t.environment}:${t.portfolio}:${t.entry.time}`;
}

const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// All-or-nothing on validation: if any record is refused, nothing is written.
// An identical repeat is a duplicate and is skipped. A different outcome for an existing
// trade is a conflict: it is reported, and the stored record is kept as it was.
export async function appendTrades(storage, trades) {
  const refused = [];
  trades.forEach((t, i) => {
    const problems = validateTradeRecord(t);
    if (problems.length) refused.push({ index: i, problems });
  });
  if (refused.length) throw new Error(`trade records refused: ${JSON.stringify(refused)}`);
  const keys = trades.map(recordKey);
  const stored = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const found = await storage.get(keys.slice(i, i + CHUNK));
    for (const k of keys.slice(i, i + CHUNK)) if (found.get(k) !== undefined) stored.set(k, found.get(k));
  }
  const toWrite = {};
  const result = { written: 0, duplicates: 0, conflicts: [] };
  trades.forEach((t, i) => {
    const k = keys[i];
    if (stored.has(k)) {
      if (sameRecord(stored.get(k), t)) result.duplicates += 1;
      else result.conflicts.push(k);
      return;
    }
    if (k in toWrite) {
      if (sameRecord(toWrite[k], t)) result.duplicates += 1;
      else result.conflicts.push(k);
      return;
    }
    toWrite[k] = t;
    result.written += 1;
  });
  const entries = Object.entries(toWrite);
  for (let i = 0; i < entries.length; i += CHUNK) await storage.put(Object.fromEntries(entries.slice(i, i + CHUNK)));
  return result;
}

export async function readTrades(storage, filter = () => true) {
  const map = await storage.list({ prefix: RECORD_PREFIX });
  return [...map.values()].filter(filter).sort(byEntry);
}
