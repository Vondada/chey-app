// CHE smart strategy selection for PAPER trading (Trading Room V3, owner 2026-10-25): docs/CHE_TRADING_STRATEGY_V3.md.
//
// Ranks strategy × market × timeframe rows from the Strategy Matrix research (strategy_matrix.js) by evidence, never by
// raw win rate, turns the ranking into paper-testing priorities, demotes only by the written statistical rules below,
// and gates the existing paper loops (crypto_markets.cryptoTick, trading_live) with conservative exposure caps,
// duplicate prevention and a logged reason for every decision.
//
// PAPER ONLY. This module places no order, imports no broker or order module and makes no network call: it only
// answers "may this paper signal proceed, and why". Live trading stays disabled in every path.
import { tradingClock } from './trading_clock.js';
import { cmeOpen } from './trading_research.js';

export const MIN_SAMPLE = 30;            // out-of-sample trades before a row may be ranked
export const MIN_REGIME_TRADES = 8;      // trades in a regime bucket before it counts toward stability
export const DEMOTE_MAX_DD_R = 15;       // out-of-sample drawdown, in R, that demotes a row
export const DEMOTE_MIN_PAPER = 20;      // forward-paper trades before paper results can demote
export const PAPER_LIMITS = Object.freeze({ per_market: 2, total: 4 });
export const FUTURES = Object.freeze(['MNQ', 'NQ']);
export const CRYPTO = Object.freeze(['BTC', 'ETH']);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => Math.round(x * 100) / 100;
export const rowKey = (strategy, market, tf) => `${strategy}|${market}|${tf}`;

/**
 * The written demotion rules. A row is demoted (no new paper entries) only when one of these holds:
 *   1. the look-ahead audit failed;
 *   2. at least MIN_SAMPLE out-of-sample trades and the upper end of the 95% interval of expectancy (R, after costs)
 *      is below zero: the strategy loses money with statistical confidence;
 *   3. at least MIN_SAMPLE out-of-sample trades and an out-of-sample drawdown deeper than DEMOTE_MAX_DD_R;
 *   4. at least DEMOTE_MIN_PAPER forward-paper trades and the upper end of their 95% expectancy interval is below zero.
 * A small sample never demotes and never promotes.
 */
export function demotion(row, paper = null) {
  const reasons = [];
  if (row?.look_ahead === 'FAILED') reasons.push('the look-ahead audit failed: the rules read future bars');
  const o = row?.oos;
  if (o && o.trades >= MIN_SAMPLE) {
    const hi = o.expectancy_r_95ci?.high;
    if (Number.isFinite(hi) && hi < 0) reasons.push(`out-of-sample expectancy ${o.expectancy_r}R on ${o.trades} trades, 95% upper bound ${hi}R is below zero`);
    if (o.max_drawdown_r > DEMOTE_MAX_DD_R) reasons.push(`out-of-sample drawdown ${o.max_drawdown_r}R is deeper than the ${DEMOTE_MAX_DD_R}R limit`);
  }
  if (paper && paper.trades >= DEMOTE_MIN_PAPER && Number.isFinite(paper.expectancy_r_95ci?.high) && paper.expectancy_r_95ci.high < 0) {
    reasons.push(`forward paper expectancy ${paper.expectancy_r}R on ${paper.trades} trades, 95% upper bound below zero`);
  }
  return { demoted: reasons.length > 0, reasons };
}

/**
 * Evidence score, about -60 to 100. Every part is out-of-sample and after costs:
 *   net expectancy in R (40), profit factor (10), risk-adjusted return as the t-statistic of the mean R (10),
 *   drawdown (-10), win rate measured against the break-even win rate its reward:risk needs (10), sample size (10),
 *   stability across volatility regimes (10), recent out-of-sample result (±5).
 * Win rate alone earns nothing: a 90% win rate with a reward:risk that needs 95% scores below zero on that part.
 */
export function evidenceScore(row) {
  const o = row.oos;
  const why = [];
  let s = 40 * clamp(o.expectancy_r / 0.3, -1, 1);
  why.push(`expectancy ${o.expectancy_r}R after costs`);
  if (o.profit_factor != null) s += 10 * clamp(o.profit_factor - 1, -1, 1);
  const half = o.expectancy_r_95ci ? (o.expectancy_r_95ci.high - o.expectancy_r_95ci.low) / 2 : 0;
  const t = half > 0 ? (1.96 * o.expectancy_r) / half : 0;
  s += 10 * clamp(t / 3, -1, 1);
  s -= 10 * clamp((o.max_drawdown_r || 0) / 20, 0, 1);
  if (o.win_rate != null && o.risk_reward) {
    const need = 100 / (1 + o.risk_reward);
    s += 10 * clamp((o.win_rate - need) / 10, -1, 1);
    why.push(`win rate ${o.win_rate}% against the ${r2(need)}% its ${o.risk_reward} reward:risk needs`);
  }
  s += 10 * clamp(Math.log10(o.trades / MIN_SAMPLE), 0, 1);
  if (row.regime_stability != null) {
    s += 10 * row.regime_stability - (row.regime_stability < 0.5 ? 5 : 0);
    why.push(`positive in ${Math.round(row.regime_stability * 100)}% of volatility regimes`);
  }
  if (row.recent_oos?.trades >= 10) {
    s += row.recent_oos.expectancy_r > 0 ? 5 : -5;
    why.push(`recent out-of-sample ${row.recent_oos.expectancy_r}R on ${row.recent_oos.trades}`);
  }
  return { score: Math.round(s * 10) / 10, why };
}

/**
 * Ranked rows. Tiers: 'ranked' (enough out-of-sample evidence, not demoted), 'insufficient sample' (never ranked,
 * never promoted), 'demoted', 'not applicable'. Ranked rows with positive expectancy always come before ranked rows
 * without it, then by evidence score. Paper priority 1 is the best supported.
 */
export function rankStrategies(rows, paperBy = {}) {
  const out = [];
  for (const row of rows || []) {
    const key = rowKey(row.strategy, row.market, row.tf);
    if (row.status !== 'ok') { out.push({ key, row, tier: 'not applicable', score: null, reasons: [row.reason || 'not tested'] }); continue; }
    const d = demotion(row, paperBy[key] || null);
    if (d.demoted) { out.push({ key, row, tier: 'demoted', score: null, reasons: d.reasons }); continue; }
    if (!(row.oos?.trades >= MIN_SAMPLE)) { out.push({ key, row, tier: 'insufficient sample', score: null, reasons: [`${row.oos?.trades || 0} out-of-sample trades; ${MIN_SAMPLE} are needed before it is ranked`] }); continue; }
    const e = evidenceScore(row);
    out.push({ key, row, tier: 'ranked', score: e.score, reasons: e.why });
  }
  const order = { ranked: 0, 'insufficient sample': 1, demoted: 2, 'not applicable': 3 };
  out.sort((a, b) => order[a.tier] - order[b.tier]
    || (a.tier === 'ranked' ? (Number(b.row.oos.expectancy_r > 0) - Number(a.row.oos.expectancy_r > 0)) || b.score - a.score : 0)
    || (b.row.oos?.trades || 0) - (a.row.oos?.trades || 0));
  let p = 0;
  for (const r of out) r.priority = r.tier === 'ranked' || r.tier === 'insufficient sample' ? ++p : null;
  return out;
}

/**
 * The paper plan: priority, tier and reasons per engine candidate|market|tf (the key the paper loops' portfolios
 * carry), from every research result set given.
 */
export function buildPaperPlan(resultSets, paperBy = {}) {
  const rows = (resultSets || []).filter(Boolean).flatMap((r) => r.rows || []);
  const ranked = rankStrategies(rows, paperBy);
  const entries = {};
  for (const r of ranked) entries[rowKey(r.row.candidate || r.row.strategy, r.row.market, r.row.tf)] = { priority: r.priority, tier: r.tier, score: r.score, reasons: r.reasons, strategy: r.row.strategy };
  return { entries, size: ranked.length };
}

/** Is paper allowed to take a new entry on this market at this instant? Crypto trades 24/7; CME futures follow the clock. */
export function sessionAllows(market, time) {
  if (CRYPTO.includes(market)) return { ok: true };
  const ms = typeof time === 'number' ? time : Date.parse(time);
  if (!tradingClock(ms).futures.open || !cmeOpen(ms)) return { ok: false, reason: 'futures paper pauses outside CME hours (Sunday 6 PM to Friday 5 PM New York, daily 5 to 6 PM break, exchange holidays)' };
  return { ok: true };
}

/** Portfolios in paper-priority order (best supported first); unknown rows keep their order after the known ones. */
export function prioritize(portfolios, plan, tf) {
  const pri = (pf) => plan?.entries?.[rowKey(pf.candidate, pf.contract, tf || pf.resolution)]?.priority ?? Infinity;
  return [...portfolios].sort((a, b) => pri(a) - pri(b));
}

/**
 * Wraps an existing paper gate. On a new signal: session (futures pause outside CME hours), demotion, duplicate (same
 * strategy, market and bar), the per-market cap and the total cap, in that order; every decision is appended to
 * `log` with its reasons. Fills and exits pass through to the wrapped gate. `open` maps market → open or pending
 * paper positions at the start of the pass. The futures forward-paper grid (trading_live.js) passes `limits: null` and
 * `dedupe: false`: its isolated variants (trend filter on/off, target 1.5R/2R/3R) are the owner's experiment grid and
 * its exposure is already bounded by his account limits in trading_controls.js; it keeps the session pause and demotion.
 */
export function selectionGate(base, { plan = null, open = {}, limits = PAPER_LIMITS, dedupe = true, log = [] } = {}) {
  const counts = { ...open };
  const seen = new Set();
  const total = () => Object.values(counts).reduce((a, n) => a + n, 0);
  return (pf, info) => {
    if (info?.stage !== 'signal') return base ? base(pf, info) : null;
    const market = pf.contract;
    const tf = pf.resolution;
    const entry = plan?.entries?.[rowKey(pf.candidate, market, tf)] || null;
    const dup = `${pf.candidate}|${market}|${info.time}`;
    const note = (decision, reason) => { log.push({ at: info.time, strategy: pf.candidate, market, tf, portfolio: pf.key, decision, reason, priority: entry?.priority ?? null, tier: entry?.tier || 'not researched yet' }); return decision === 'allowed' ? null : reason; };
    const session = sessionAllows(market, info.time);
    if (!session.ok) return note('refused', session.reason);
    if (entry?.tier === 'demoted') return note('refused', `demoted by the written rules: ${entry.reasons.join('; ')}`);
    if (dedupe && seen.has(dup)) return note('refused', 'duplicate: this strategy already took a paper signal on this market and bar');
    if (limits && (counts[market] || 0) >= limits.per_market) return note('refused', `exposure cap: ${limits.per_market} paper positions already open on ${market}`);
    if (limits && total() >= limits.total) return note('refused', `exposure cap: ${limits.total} paper positions already open in total`);
    const blocked = base ? base(pf, info) : null;
    if (blocked) return note('refused', blocked);
    seen.add(dup);
    counts[market] = (counts[market] || 0) + 1;
    return note('allowed', entry ? `paper priority ${entry.priority ?? 'last'} (${entry.tier}): ${entry.reasons.slice(0, 2).join('; ')}` : 'not researched yet: paper learning at the lowest priority');
  };
}

export const SELECTION_LOG = 'paper_selection_log';
/** Appends a pass's decisions to the bounded log (newest 300). */
export async function saveSelectionLog(storage, entries) {
  if (!entries?.length) return;
  const prev = (await storage.get(SELECTION_LOG)) || [];
  await storage.put(SELECTION_LOG, [...prev, ...entries].slice(-300));
}
