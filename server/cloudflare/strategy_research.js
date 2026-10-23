// CHE strategy comparison (owner, 2026-10-23: "stop limiting CHE to the same 10 familiar strategies"). The strategy
// library (strategy_library.js, library_seeds/research.js) is the one registry and computes every lifecycle stage; this
// file adds what the library does not do, over the existing research engine, never a second one:
//   - a same-dataset comparison of stored backtests: in-sample and out-of-sample side by side, intervals after costs,
//     overfit warnings, and condition breakdowns that answer "insufficient evidence" rather than guess;
//   - event-day breakdowns when a calendar (tagsByDay) is supplied by the market-context lane;
//   - how many Rithmic order-flow sessions are recorded, and the free or paid history sources CHE could use.
// Rules, fills and costs: trading_evidence.js. Backtests and walk-forward: trading_research.js. Assumptions shown with
// every result: trading_market_spec.js. Nothing here places an order or enables paper trading.
import { etParts } from './trading_evidence.js';
import { MIN_CLOSED_TRADES, definitionOf, evaluateUnit, loadDataset, missingBars, readUnits, strategyDefinitions } from './trading_research.js';
import { marketSpec } from './trading_market_spec.js';

const ORDER_FLOW_MIN_SESSIONS = 20; // CHE's floor before a first order-flow backtest (one trading month); not sufficiency

/** Recorded order-flow sessions: MNQ 1-minute bars from Rithmic that carry an aggressor `delta`. */
export async function orderFlowReadiness(storage) {
  const ds = await loadDataset(storage, 'MNQ', '1m').catch(() => null);
  const bars = ds?.bars || [];
  const rithmic = /rithmic/i.test(String(ds?.manifest?.provider || ''));
  const days = new Set();
  if (rithmic) for (const b of bars) if (Number.isFinite(b.delta)) days.add(etParts(b.t).day);
  const sorted = [...days].sort();
  return {
    sessions: sorted.length, first_session: sorted[0] || null, last_session: sorted.at(-1) || null, required: ORDER_FLOW_MIN_SESSIONS,
    ready: sorted.length >= ORDER_FLOW_MIN_SESSIONS,
    status: sorted.length ? `Rithmic order-flow data recorded since ${sorted[0]}: ${sorted.length} of ${ORDER_FLOW_MIN_SESSIONS} sessions needed before a first backtest.`
      : 'No recorded Rithmic order-flow session is stored yet. Recording starts when the phone streams real Rithmic trades; a backtest needs at least 20 sessions.',
  };
}

/** Where CHE could get NQ/MNQ history, as researched on 2026-10-23. Nothing paid or signed up for without the owner. */
export const DATA_SOURCE_FINDINGS = Object.freeze([
  { source: 'Yahoo Finance chart API (in use)', cost: 'free', depth: '1-minute 7 days, 2–30-minute 59 days, hourly 729 days, daily decades', terms: 'public, delayed; CHE labels it DELAYED and never live', status: 'in use' },
  { source: 'Rithmic ticker plant (owner\'s login, on the iPhone)', cost: 'included with the owner\'s account', depth: 'forward only: no history plant in CHE', terms: 'owner\'s Rithmic and prop-firm agreements', status: 'forward recording (real trades and per-minute delta)' },
  { source: 'Databento historical (CME Globex)', cost: '$125 of free credits for a new account, then usage-priced', depth: 'years of CME history', terms: 'separate personal/commercial terms; CME external redistribution needs vendor registration', url: 'https://databento.com/pricing', status: 'not used: needs the owner to open an account and accept its terms' },
  { source: 'FirstRate Data NQ', cost: 'free sample; full set about $300–$400', depth: '2008 onward, 1-minute', terms: 'licence terms not read', url: 'https://firstratedata.com/i/futures/NQ', status: 'not used: paid' },
  { source: 'MarketParquet', cost: 'free tier: last 30 days intraday, 5 downloads a day', depth: '30 days free', terms: 'licence terms not read', url: 'https://marketparquet.com/data/futures', status: 'not used: terms unread' },
  { source: 'Barchart', cost: 'paid membership', depth: '1-minute 10 years', terms: 'membership terms', url: 'https://www.barchart.com/futures/quotes/NQ*0/price-history/download', status: 'not used: paid' },
]);

// ─── Comparison on the same dataset ─────────────────────────────────────────────

const pick = (s) => (s ? { trades: s.trades, expectancy_r: s.expectancy_r, win_rate: s.win_rate, pf: s.pf, max_dd_r: s.max_dd_r, ci: s.expectancy_ci || null } : null);

/** What the sample can and cannot say, after costs. */
export function verdictOf(s, min = MIN_CLOSED_TRADES) {
  if (!s || !s.trades) return 'no trades';
  if (s.trades < min) return `insufficient evidence (${s.trades} trades; ${min} needed)`;
  if (s.expectancy_ci?.low > 0) return 'positive after costs (95% interval above zero)';
  if (s.expectancy_ci?.high < 0) return 'negative after costs (95% interval below zero)';
  return 'not distinguishable from zero after costs';
}

function overfitWarning(u) {
  const tr = u.train; const oo = u.oos;
  if (!oo?.trades) return 'no out-of-sample trades: the result is in-sample only';
  if (oo.trades < 15) return `only ${oo.trades} out-of-sample trades: too few to confirm the in-sample result`;
  if (tr?.expectancy_r > 0 && oo.expectancy_r <= 0) return 'in-sample positive but out-of-sample not: likely overfit or decayed';
  if (tr?.expectancy_r > 0 && oo.expectancy_r < tr.expectancy_r / 2) return 'out-of-sample result is under half of in-sample';
  return null;
}

/** Trades of a unit by event tag of their New York trade date. `tagsByDay` maps 'YYYY-MM-DD' to tags. */
function eventBuckets(trades, tagsByDay) {
  const groups = {};
  for (const t of trades) {
    const tags = tagsByDay[etParts(t.t).day];
    for (const tag of tags?.length ? tags : ['no listed event']) (groups[tag] ||= []).push(t.r);
  }
  return Object.entries(groups).map(([key, rs]) => {
    const n = rs.length; const mean = rs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : 0;
    const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
    return { key, trades: n, expectancy_r: Math.round(mean * 1e4) / 1e4, expectancy_ci: { low: Math.round((mean - half) * 1e4) / 1e4, high: Math.round((mean + half) * 1e4) / 1e4 } };
  }).sort((a, b) => b.trades - a.trades);
}

/**
 * Same-period comparison of stored or fresh evidence units. Only units on the same dataset (sha256) are compared; the
 * rest are listed as excluded with the reason. Conditions name a best strategy only when it has enough trades in that
 * condition and its interval is above zero after costs.
 */
export function compareUnits(units, { tagsByDay = null, minBucket = MIN_CLOSED_TRADES } = {}) {
  const ok = units.filter((u) => u?.ok);
  if (!ok.length) return { ok: false, reason: 'No backtest results to compare yet.' };
  const bySha = {};
  for (const u of ok) (bySha[u.dataset?.sha256 || 'unknown'] ||= []).push(u);
  const [sha, same] = Object.entries(bySha).sort((a, b) => b[1].length - a[1].length)[0];
  const excluded = ok.filter((u) => (u.dataset?.sha256 || 'unknown') !== sha).map((u) => ({ strategy_id: u.strategy_id, timeframe: u.timeframe, reason: 'a different dataset or period' }));
  const rows = same.map((u) => ({
    strategy_id: u.strategy_id, name: definitionOf(u.strategy_id)?.name || u.strategy_id, research: Boolean(definitionOf(u.strategy_id)?.research), timeframe: u.timeframe, market: u.market,
    all: pick(u.all), in_sample: pick(u.train), out_of_sample: pick(u.oos), folds_positive: u.folds_positive, folds_total: u.folds_total,
    stress_expectancy_r: u.stress?.expectancy_r ?? null, look_ahead: u.look_ahead, verdict: verdictOf(u.all), oos_verdict: verdictOf(u.oos, 15), overfit_warning: overfitWarning(u),
    trades_kept: u.trades?.length || 0,
  })).sort((a, b) => (b.out_of_sample?.expectancy_r ?? -9) - (a.out_of_sample?.expectancy_r ?? -9));
  const dims = { sessions: 'session', regimes: 'market structure', volatility: 'volatility regime' };
  const conditions = [];
  for (const [field, label] of Object.entries(dims)) {
    const keys = new Set(same.flatMap((u) => (u[field] || []).map((b) => b.key)));
    for (const key of keys) {
      const cands = same.map((u) => ({ u, b: (u[field] || []).find((x) => x.key === key) })).filter((x) => x.b);
      const enough = cands.filter((x) => x.b.trades >= minBucket);
      const positive = enough.filter((x) => x.b.expectancy_ci?.low > 0).sort((a, b) => b.b.expectancy_r - a.b.expectancy_r);
      conditions.push({ dimension: label, condition: key, strategies_with_enough_trades: enough.length,
        best: positive[0] ? { strategy_id: positive[0].u.strategy_id, trades: positive[0].b.trades, expectancy_r: positive[0].b.expectancy_r, ci: positive[0].b.expectancy_ci } : null,
        answer: positive[0] ? `${definitionOf(positive[0].u.strategy_id)?.name || positive[0].u.strategy_id}: ${positive[0].b.trades} trades, ${positive[0].b.expectancy_r} R per trade after costs`
          : enough.length ? 'no strategy is positive after costs here' : `insufficient evidence (no strategy has ${minBucket} trades here)` });
    }
  }
  let events = { available: false, reason: 'No event calendar is connected to the comparison yet (the market-context lane adds it).' };
  if (tagsByDay) {
    events = { available: true, by_strategy: same.map((u) => ({ strategy_id: u.strategy_id, based_on: `${u.trades?.length || 0} of ${u.all.trades} trades (the newest kept)`, buckets: eventBuckets(u.trades || [], tagsByDay).map((b) => ({ ...b, verdict: verdictOf(b, minBucket) })) })) };
  }
  const d = same[0].dataset || {};
  return {
    ok: true, same_period: { sha256: sha, provider: d.provider, first: d.first, last: d.last, bars: d.bars, proxy: d.proxy || null }, rows, excluded, conditions, events,
    multiple_comparisons: `${rows.length} strategies are compared on one period: the best in-sample result is partly luck. Judge them by out-of-sample results and intervals, not the top rank.`,
    assumptions: marketSpec(), live_trading: 'disabled',
  };
}

/** Fresh comparison from bars (tests, and the local research script). Every eligible strategy runs on the same bars. */
export function compareStrategies({ market = 'MNQ', tf, bars, manifest, strategyIds = null, profile = 'NORMAL', tagsByDay = null }) {
  const defs = strategyDefinitions().filter((d) => d.timeframes.includes(tf) && (!strategyIds || strategyIds.includes(d.strategy_id)));
  const units = defs.map((d) => evaluateUnit({ strategyId: d.strategy_id, market, tf, bars, manifest, profile, keepTrades: Infinity }));
  const gaps = missingBars(bars, tf);
  const out = compareUnits(units, { tagsByDay });
  return { ...out, data_limitations: { provider: manifest?.provider || null, bars: bars.length, missing: gaps, delayed: /yahoo/i.test(String(manifest?.provider || '')) ? 'Yahoo bars are delayed and limited in depth (5-minute: about 59 days).' : null } };
}

/** API view: the stored research results for one market and timeframe, compared on their shared dataset. */
export async function comparisonView(storage, { market = 'MNQ', tf = '5m', ids = null } = {}) {
  const units = await readUnits(storage, (u) => (u.mode || 'BACKTEST') === 'BACKTEST' && u.market === market && u.timeframe === tf && (!ids || ids.includes(u.strategy_id)));
  const out = compareUnits(units);
  // "Nothing to compare yet" is an answer, not an error: the phone shows the reason.
  return out.ok ? { market, timeframe: tf, available: true, ...out } : { market, timeframe: tf, available: false, reason: out.reason, live_trading: 'disabled' };
}
