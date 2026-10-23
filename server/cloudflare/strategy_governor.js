// CHE strategy governor (owner, 2026-10-23: "stop repeating losing trading strategies").
//
// Reads CHE's own journals and decides which strategies may keep trading FORWARD PAPER. Every strategy keeps running
// in simulation (backtest, research, delayed training), so a paused idea can prove itself again. Decisions use
// confidence bounds on expectancy in R over independent closed trades, never a win rate alone, and a pause is lifted
// only by out-of-sample + walk-forward research (the existing OOS VERIFIED rules). Every pause, resume, watch, modify
// or reject is appended to a log with its evidence. Nothing here can reach a broker. See docs/CHE_STRATEGY_GOVERNOR.md.
import { CONTRACTS, COSTS, INTRADAY_CANDIDATES, contractOf, readTrades, validateTradeRecord } from './trading_evidence.js';
import { MIN_CLOSED_TRADES, queueJob, readUnits } from './trading_research.js';
import { queueRoomEvent } from './room_events.js';

export const GOV_SETTINGS = 'gov_settings';
export const GOV_STATE = 'gov_state';
export const GOV_DECISION_PREFIX = 'gd:';
export const DEFAULT_GOV_SETTINGS = Object.freeze({ enabled: true, min_trades: MIN_CLOSED_TRADES, z_pause: 1.645, z_watch: 1.0, streak_p: 0.01 });
export const REVALIDATION_RULE = '30+ out-of-sample trades with expectancy > 0, ≥60% profitable walk-forward folds, look-ahead audit passed';
const EVEN_SIM_SHARE = 0.5; // half the research budget is spread evenly, so no strategy stops being simulated

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const finite = (x) => Number.isFinite(x);
const fmtR = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}R`;
const nameOf = (id) => INTRADAY_CANDIDATES[id]?.name || id;
export const unitKey = (u) => `${u.strategy}|${u.market}|${u.timeframe}`;

export async function readGovSettings(storage) {
  return { ...DEFAULT_GOV_SETTINGS, ...((await storage.get(GOV_SETTINGS)) || {}) };
}

/** Owner settings, bounded so a typo cannot switch the statistics off. */
export function cleanSettings(input = {}) {
  const out = {};
  const num = (k, lo, hi) => { const v = Number(input[k]); if (input[k] !== undefined && finite(v)) out[k] = Math.min(hi, Math.max(lo, v)); };
  num('min_trades', 15, 500); num('z_pause', 0.5, 4); num('z_watch', 0, 4); num('streak_p', 0.0001, 0.2);
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  return out;
}

// ─── Evidence integrity ─────────────────────────────────────────────────────

/**
 * Problems that make a record unfit to count: the journal's own validation, plus fills a real market could not have
 * given (an entry further from the bar open than spread + slippage, a target exit better than the target).
 */
export function fillProblems(t) {
  const problems = [...validateTradeRecord(t)];
  if (problems.length) return problems;
  const c = contractOf(t.contract) || CONTRACTS.MNQ;
  const costs = t.cost_assumptions || COSTS;
  const maxEntry = ((costs.spreadTicks ?? 1) / 2 + (costs.slippageTicks ?? 1)) * c.tick + 1e-6;
  if (Math.abs(t.entry.fill - t.entry.raw) > maxEntry) problems.push('entry fill further from the bar open than costs allow');
  // A target is a resting limit: it fills at the target or better (a gap through it fills at the open), never worse.
  if (t.exit.reason === 'target' && (t.side === 'short' ? t.exit.raw > t.target + 1e-6 : t.exit.raw < t.target - 1e-6)) problems.push('target exit recorded before the target was reached');
  if (Date.parse(t.exit.time) < Date.parse(t.entry.time)) problems.push('exit before entry');
  return problems;
}

/**
 * One trade per setup. Forward paper runs each strategy in several portfolios (trend filter on/off, two target sizes),
 * so one signal can close as up to four records. Statistics count it once: the `any` filter and the 2R target first.
 * Records with the same portfolio and entry time are duplicates and count once.
 */
export function independentTrades(trades) {
  const seen = new Set();
  const groups = new Map();
  let duplicates = 0;
  for (const t of trades) {
    const rec = `${t.portfolio}|${t.entry.time}`;
    if (seen.has(rec)) { duplicates += 1; continue; }
    seen.add(rec);
    const key = `${t.strategy}|${t.contract}|${t.data?.resolution}|${t.signal?.time}|${t.side}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
  }
  const rank = (t) => (t.filter === 'any' ? 0 : 2) + ((t.params?.target_r ?? 2) === 2 ? 0 : 1);
  const kept = [...groups.values()].map((list) => [...list].sort((a, b) => rank(a) - rank(b))[0]);
  kept.sort((a, b) => String(a.entry.time).localeCompare(String(b.entry.time)));
  return { trades: kept, raw: trades.length - duplicates, duplicates };
}

// ─── Statistics ─────────────────────────────────────────────────────────────

const costOf = (t) => (t.costs ? t.costs.spread + t.costs.slippage + t.costs.commissions + t.costs.fees : 0);

/** Performance of a list of closed trades, in R after costs. */
export function performance(trades, { z = DEFAULT_GOV_SETTINGS.z_pause } = {}) {
  const n = trades.length;
  const rs = trades.map((t) => t.r_net);
  const mean = n ? rs.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : null;
  const wins = trades.filter((t) => t.net_pnl > 0).length;
  const losses = trades.filter((t) => t.net_pnl < 0).length;
  const gw = trades.filter((t) => t.net_pnl > 0).reduce((a, t) => a + t.net_pnl, 0);
  const gl = -trades.filter((t) => t.net_pnl < 0).reduce((a, t) => a + t.net_pnl, 0);
  let eq = 0; let peak = 0; let dd = 0; let streak = 0; let maxStreak = 0;
  for (const t of trades) {
    eq += t.r_net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = t.net_pnl < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
  }
  return {
    trades: n, wins, losses,
    win_rate: n ? r2((100 * wins) / n) : null,
    avg_r: n ? r4(mean) : null,
    expectancy_r: n ? r4(mean) : null,
    expectancy_r_upper: se == null ? null : r4(mean + z * se),
    expectancy_r_lower: se == null ? null : r4(mean - z * se),
    profit_factor: gl ? r2(gw / gl) : null,
    max_drawdown_r: r4(dd),
    // Costs kept apart: slippage (execution) is not a fee, and a strategy can lose to either.
    fees_usd: r2(trades.reduce((a, t) => a + (t.costs ? t.costs.commissions + t.costs.fees : 0), 0)),
    slippage_usd: r2(trades.reduce((a, t) => a + (t.costs?.slippage || 0), 0)),
    spread_usd: r2(trades.reduce((a, t) => a + (t.costs?.spread || 0), 0)),
    costs_usd: r2(trades.reduce((a, t) => a + costOf(t), 0)),
    max_consecutive_losses: maxStreak,
    current_consecutive_losses: streak,
    net_pnl: r2(trades.reduce((a, t) => a + t.net_pnl, 0)),
  };
}

/** Where the losses come from: costs, exits that gave back a winner, entries that were wrong at once, time exits. */
export function lossCauses(trades) {
  const losers = trades.filter((t) => t.net_pnl < 0);
  const n = trades.length;
  const gross = n ? trades.reduce((a, t) => a + (t.r_gross ?? t.r_net), 0) / n : null;
  const net = n ? trades.reduce((a, t) => a + t.r_net, 0) / n : null;
  return {
    gross_expectancy_r: gross == null ? null : r4(gross),
    net_expectancy_r: net == null ? null : r4(net),
    cost_drag_r: gross == null ? null : r4(gross - net),
    losers: losers.length,
    losers_after_1r_in_favour: losers.filter((t) => (t.mfe_r ?? 0) >= 1).length,
    losers_immediately_against: losers.filter((t) => (t.mfe_r ?? 0) < 0.3).length,
    same_bar_stop_and_target: trades.filter((t) => t.same_bar_both_touched).length,
    time_exits: trades.filter((t) => t.exit?.reason === 'time').length,
    stop_exits: trades.filter((t) => t.exit?.reason === 'stop').length,
    target_exits: trades.filter((t) => t.exit?.reason === 'target').length,
  };
}

/** The chance of a losing run at least `k` long somewhere in `n` trades at loss rate `q` (exact, by recursion). */
export function streakProbability(k, n, q) {
  if (k <= 0) return 1;
  if (k > n || q <= 0) return 0;
  if (q >= 1) return 1;
  // P(no run of k) by a run-length state machine.
  let state = new Array(k).fill(0); state[0] = 1;
  for (let i = 0; i < n; i++) {
    const next = new Array(k).fill(0);
    for (let j = 0; j < k; j++) {
      next[0] += state[j] * (1 - q);
      if (j + 1 < k) next[j + 1] += state[j] * q;
    }
    state = next;
  }
  return 1 - state.reduce((a, v) => a + v, 0);
}

const conditionKey = (t) => `${t.condition?.trend || 'unknown'}|${t.condition?.volatility || 'unknown'}`;
function groupBy(trades, keyOf, opts) {
  const groups = {};
  for (const t of trades) (groups[keyOf(t)] ||= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => {
    const p = performance(list, opts);
    return [k, { trades: p.trades, win_rate: p.win_rate, expectancy_r: p.expectancy_r, profit_factor: p.profit_factor, max_consecutive_losses: p.max_consecutive_losses }];
  }));
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/** The research evidence a paused strategy needs before it may trade forward paper again (OOS VERIFIED). */
export function revalidation(units = []) {
  const ok = units.filter((u) => u?.ok);
  const best = [...ok].sort((a, b) => (b.oos?.trades || 0) - (a.oos?.trades || 0))[0] || null;
  const met = ok.some((u) => u.oos?.trades >= MIN_CLOSED_TRADES && u.oos.expectancy_r > 0 && u.folds_total && u.folds_positive / u.folds_total >= 0.6 && u.look_ahead === 'passed');
  return {
    required: REVALIDATION_RULE, met,
    research: best ? { oos_trades: best.oos?.trades ?? 0, oos_expectancy_r: best.oos?.expectancy_r ?? null, folds_positive: best.folds_positive ?? 0, folds_total: best.folds_total ?? 0, look_ahead: best.look_ahead || 'unknown' } : null,
  };
}

/**
 * One unit's verdict. `prior` is the stored status, so a pause holds until revalidation, not until a lucky week.
 * Statuses: gathering (too few trades), active, watch (shown, not restricted), paused (no forward paper).
 */
export function verdict(stats, { prior = null, settings = DEFAULT_GOV_SETTINGS, research = { met: false } } = {}) {
  const s = { ...DEFAULT_GOV_SETTINGS, ...settings };
  const n = stats.trades;
  if (prior?.status === 'paused') {
    if (research.met) return { status: 'active', reason: `Revalidated in research: ${REVALIDATION_RULE}.` };
    return { status: 'paused', reason: prior.reason || 'Paused until it is revalidated in research.' };
  }
  if (n < s.min_trades) return { status: 'gathering', reason: `${n} of ${s.min_trades} independent closed trades: not enough to judge yet.` };
  const upper = stats.expectancy_r_upper;
  if (upper != null && upper < 0) {
    return { status: 'paused', reason: `Expectancy ${fmtR(stats.expectancy_r)} per trade on ${n} independent trades; even the optimistic ${Math.round(100 * zConfidence(s.z_pause))}% bound (${fmtR(upper)}) is below zero.` };
  }
  const sd = n > 1 && stats.expectancy_r_upper != null ? (stats.expectancy_r_upper - stats.expectancy_r) / s.z_pause : 0;
  const watchUpper = stats.expectancy_r + s.z_watch * sd;
  if (watchUpper < 0) return { status: 'watch', reason: `Expectancy ${fmtR(stats.expectancy_r)} on ${n} trades; losing, but not yet beyond chance at ${Math.round(100 * zConfidence(s.z_pause))}% confidence.` };
  const q = stats.trades ? stats.losses / stats.trades : 0;
  const p = streakProbability(stats.current_consecutive_losses, n, q);
  if (stats.current_consecutive_losses >= 3 && p < s.streak_p) return { status: 'watch', reason: `${stats.current_consecutive_losses} losses in a row; with its own ${r2(100 * q)}% loss rate that happens in about ${r2(100 * p)}% of ${n}-trade runs.` };
  return { status: 'active', reason: `Expectancy ${fmtR(stats.expectancy_r)} on ${n} independent trades; no statistical reason to restrict it.` };
}

// One-sided confidence for a z value (normal CDF), for the sentence only.
function zConfidence(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

// ─── Patterns ───────────────────────────────────────────────────────────────

/** Strategy × session × condition × side groups that keep losing (n ≥ 10 and the upper bound below zero). */
export function recurringLosses(trades, { z = DEFAULT_GOV_SETTINGS.z_pause, min = 10 } = {}) {
  const groups = {};
  for (const t of trades) (groups[`${t.strategy}|${t.session}|${conditionKey(t)}|${t.side}`] ||= []).push(t);
  const out = [];
  for (const [key, list] of Object.entries(groups)) {
    if (list.length < min) continue;
    const p = performance(list, { z });
    if (p.expectancy_r_upper == null || p.expectancy_r_upper >= 0) continue;
    const [strategy, session, trend, volatility, side] = key.split('|');
    const against = (side === 'long' && /below/.test(trend)) || (side === 'short' && /above/.test(trend));
    out.push({ strategy, name: nameOf(strategy), session, condition: `${trend}|${volatility}`, side, trades: p.trades, expectancy_r: p.expectancy_r, expectancy_r_upper: p.expectancy_r_upper,
      pattern: against ? `${side} against the 50-bar trend` : volatility === 'high-vol' ? `${side} in high volatility` : `${side} in ${session}` });
  }
  return out.sort((a, b) => a.expectancy_r - b.expectancy_r);
}

/** Mistakes that repeat across all strategies, counted from the trade records (the same facts as postTradeReview). */
export function repeatedMistakes(trades) {
  const losers = trades.filter((t) => t.net_pnl < 0);
  if (!losers.length) return [];
  const share = (k) => r2(k / losers.length);
  const rows = [
    { kind: 'reversed after 1R in favour (exit or target choice)', count: losers.filter((t) => (t.mfe_r ?? 0) >= 1).length },
    { kind: 'went against the entry at once (entry timing or direction)', count: losers.filter((t) => (t.mfe_r ?? 0) < 0.3).length },
    { kind: 'costs were half or more of the gross move', count: losers.filter((t) => Math.abs(t.gross_before_costs || 0) > 0 && costOf(t) >= Math.abs(t.gross_before_costs) * 0.5).length },
    { kind: 'entered in high volatility', count: losers.filter((t) => t.condition?.volatility === 'high-vol').length },
    { kind: 'one bar touched stop and target (stop assumed first)', count: losers.filter((t) => t.same_bar_both_touched).length },
  ];
  return rows.filter((r) => r.count > 0).map((r) => ({ ...r, share_of_losses: share(r.count) })).sort((a, b) => b.count - a.count);
}

/**
 * Research share per strategy: half the budget is spread evenly over every defined strategy; the rest follows the lower bound of its
 * out-of-sample expectancy. A research budget, not a forecast.
 */
export function simulationAllocation(units = []) {
  const ids = Object.keys(INTRADAY_CANDIDATES);
  const floor = EVEN_SIM_SHARE / ids.length;
  const score = {};
  for (const id of ids) {
    const mine = units.filter((u) => u?.ok && u.strategy_id === id && u.oos?.trades >= 15);
    const best = Math.max(-1, ...mine.map((u) => (u.oos.expectancy_r ?? -1) - (u.oos.trades ? 1 / Math.sqrt(u.oos.trades) : 1)));
    score[id] = Math.max(0, best + 0.5);
  }
  const total = Object.values(score).reduce((a, v) => a + v, 0);
  const rest = 1 - floor * ids.length;
  return ids.map((id) => ({ strategy: id, name: nameOf(id), share: r4(floor + (total ? (rest * score[id]) / total : rest / ids.length)), basis: 'lower bound of out-of-sample expectancy (every strategy keeps a minimum share)' }))
    .sort((a, b) => b.share - a.share);
}

/**
 * More simulated testing for better-supported strategies: once a day, the strategies the allocation favours (those with
 * out-of-sample evidence) are also researched on NQ and on 15-minute bars. Cached units do not run again.
 */
export async function queueAllocationFollowUp(storage, now = Date.now(), { top = 3 } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await storage.get('gov_followup_day')) === day) return null;
  const units = await readUnits(storage);
  const favoured = simulationAllocation(units).filter((a) => units.some((u) => u?.ok && u.strategy_id === a.strategy && u.oos?.trades >= 15)).slice(0, top).map((a) => a.strategy);
  await storage.put('gov_followup_day', day);
  if (!favoured.length) return null;
  return queueJob(storage, { market: 'NQ', timeframes: ['5m', '15m'], strategies: favoured, name: `Governor follow-up: ${favoured.join(', ')}` }, now);
}

// ─── The run ────────────────────────────────────────────────────────────────

const ACTION_WORDS = { pause: 'paused from forward paper', resume: 'resumed in forward paper', watch: 'put on watch', 'clear-watch': 'taken off watch', modify: 'settings changed', reject: 'rejected' };

/** A governor decision as a Brain event (Trading room, kind governor): what, why, and the log entry that proves it. */
export function governorEvent(d) {
  const who = d.strategy === '*' ? 'Strategy governor' : `${nameOf(d.strategy)} (${d.market} ${d.timeframe})`;
  const st = d.evidence?.stats;
  return {
    room: 'trading', kind: 'governor', key: `governor:${d.id}`,
    title: `${who}: ${ACTION_WORDS[d.action] || d.action}${d.by === 'owner' ? ' by the owner' : ''}`.slice(0, 200),
    body: `${d.reason}${st ? ` Evidence: ${st.trades} independent forward-paper trades, expectancy ${st.expectancy_r}R, win rate ${st.win_rate}%, profit factor ${st.profit_factor ?? 'n/a'}, fees $${st.fees_usd}, slippage $${st.slippage_usd}.` : ''} Paper only; live trading stays off; no result promises future profit.`,
    status: 'verified', evidence: [`governor decision ${d.id}`], refs: { decision: d.id, route: '/api/trading/governor/decisions', strategy: d.strategy }, at: d.at,
  };
}

async function appendDecision(storage, d) {
  let id = `${GOV_DECISION_PREFIX}${d.at}:${unitKey(d)}`;
  for (let i = 1; (await storage.get(id)) !== undefined; i++) id = `${GOV_DECISION_PREFIX}${d.at}:${unitKey(d)}:${i}`;
  await storage.put(id, { id, ...d });
  // The Brain shows every decision with its provenance; the log above stays the record of truth.
  await queueRoomEvent(storage, governorEvent({ id, ...d })).catch(() => false);
  return id;
}

/**
 * New enter and skip decisions from one forward-paper pass as one Brain event (bounded: one per pass, at most 12 lines),
 * so the Brain can open them without flooding its queue. The full list stays at /api/trading/governor/trades.
 */
export function decisionsEvent(items, at) {
  if (!items.length) return null;
  const entered = items.filter((x) => x.decision === 'taken');
  const skipped = items.filter((x) => x.decision === 'skipped');
  const lines = items.slice(0, 12).map((x) => `${x.time} ${nameOf(x.strategy)} ${x.side}: ${x.decision === 'taken' ? 'entered' : 'skipped'} (${String(x.why).slice(0, 140)})`);
  return {
    room: 'trading', kind: 'trade_decision', key: `decisions:${at}`,
    title: `Forward paper: ${entered.length} setup${entered.length === 1 ? '' : 's'} entered, ${skipped.length} skipped`,
    body: `${lines.join('\n')}${items.length > 12 ? `\n…and ${items.length - 12} more.` : ''}\nPaper only; no broker order.`,
    status: 'verified', evidence: [`forward paper run ${at}`], refs: { route: '/api/trading/governor/trades', run: at }, at,
  };
}

export async function readDecisions(storage, { limit = 100 } = {}) {
  const map = await storage.list({ prefix: GOV_DECISION_PREFIX });
  return [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id))).slice(0, Math.max(1, Math.min(1000, limit)));
}

const isForward = (t) => t.environment === 'paper';
const timeframeOf = (t) => (t.data?.resolution === 'daily' ? '1D' : t.data?.resolution || '5m');

/**
 * Evaluates every forward-paper unit as of `now`, using only trades closed by then, records each status change, and
 * returns the view. `trades` and `units` may be passed in (tests, the live tick); otherwise they are read.
 */
export async function runGovernor(storage, { now = Date.now(), trades = null, units = null, record = true } = {}) {
  const settings = await readGovSettings(storage);
  const asOf = new Date(now).toISOString();
  // Every market's forward paper (MNQ and Orion's crypto): units are per strategy, market and timeframe, so they never mix.
  const journal = (trades || (await readTrades(storage, isForward, { market: 'all' }))).filter((t) => Date.parse(t.exit?.time) <= now);
  const excluded = [];
  const clean = [];
  for (const t of journal) {
    const p = fillProblems(t);
    if (p.length) excluded.push({ portfolio: t.portfolio, entry: t.entry?.time, problems: p });
    else clean.push(t);
  }
  const research = units || (await readUnits(storage));
  const state = (await storage.get(GOV_STATE)) || {};
  const byUnit = {};
  for (const t of clean) (byUnit[`${t.strategy}|${t.contract}|${timeframeOf(t)}`] ||= []).push(t);
  const strategies = [];
  const changes = [];
  for (const [key, list] of Object.entries(byUnit)) {
    const [strategy, market, timeframe] = key.split('|');
    const ind = independentTrades(list);
    const stats = performance(ind.trades, { z: settings.z_pause });
    const reval = revalidation(research.filter((u) => u.strategy_id === strategy && u.market === market && u.timeframe === timeframe));
    const prior = state[key] || null;
    const v = settings.enabled ? verdict(stats, { prior, settings, research: reval }) : { status: 'active', reason: 'The governor is switched off by the owner.' };
    strategies.push({
      strategy, name: nameOf(strategy), market, timeframe, status: v.status, forward_paper_allowed: v.status !== 'paused', reason: v.reason,
      stats: { ...stats, raw_trades: ind.raw }, loss_causes: lossCauses(ind.trades),
      // Regime = the market condition recorded when the signal formed (50-bar trend × volatility), never inferred later.
      by_session: groupBy(ind.trades, (t) => t.session || 'unknown', { z: settings.z_pause }), by_regime: groupBy(ind.trades, conditionKey, { z: settings.z_pause }),
      revalidation: reval, since: prior?.status === v.status ? prior.since : asOf,
    });
    const priorStatus = prior?.status || 'gathering';
    if (priorStatus !== v.status) {
      const action = v.status === 'paused' ? 'pause' : priorStatus === 'paused' ? 'resume' : v.status === 'watch' ? 'watch' : priorStatus === 'watch' ? 'clear-watch' : null;
      state[key] = { status: v.status, since: asOf, reason: v.reason, by: 'governor' };
      if (action) changes.push({ at: asOf, strategy, market, timeframe, action, by: 'governor', reason: v.reason, evidence: { stats, revalidation: reval } });
    }
  }
  if (record) {
    for (const d of changes) await appendDecision(storage, d);
    await storage.put(GOV_STATE, state);
  }
  strategies.sort((a, b) => ({ paused: 0, watch: 1, active: 2, gathering: 3 }[a.status] - { paused: 0, watch: 1, active: 2, gathering: 3 }[b.status]) || (a.stats.expectancy_r ?? 0) - (b.stats.expectancy_r ?? 0));
  const independent = independentTrades(clean).trades;
  return {
    as_of: asOf, settings, strategies,
    recurring_losses: recurringLosses(independent, { z: settings.z_pause }),
    repeated_mistakes: repeatedMistakes(independent),
    allocation: simulationAllocation(research),
    excluded,
    comparison: comparison(research, strategies),
    changes,
    live_trading: 'disabled: the governor never enables broker orders',
  };
}

/** Research (backtest, OOS) next to forward paper for every intraday strategy on the same view. */
export function comparison(units, strategies, market = 'MNQ', timeframe = '5m') {
  return Object.keys(INTRADAY_CANDIDATES).map((id) => {
    const u = units.find((x) => x?.ok && x.strategy_id === id && x.market === market && x.timeframe === timeframe);
    const f = strategies.find((s) => s.strategy === id && s.market === market && s.timeframe === timeframe);
    return { strategy: id, name: nameOf(id),
      research: u ? { trades: u.all.trades, expectancy_r: u.all.expectancy_r, oos_trades: u.oos.trades, oos_expectancy_r: u.oos.expectancy_r, look_ahead: u.look_ahead } : null,
      forward: f ? { trades: f.stats.trades, expectancy_r: f.stats.expectancy_r, status: f.status } : null };
  }).sort((a, b) => (b.research?.oos_expectancy_r ?? -9) - (a.research?.oos_expectancy_r ?? -9));
}

/** The set of `strategy|market|timeframe` keys that may not trade forward paper, with the reason. */
export async function pausedUnits(storage) {
  const settings = await readGovSettings(storage);
  if (!settings.enabled) return new Map();
  const state = (await storage.get(GOV_STATE)) || {};
  return new Map(Object.entries(state).filter(([, s]) => s.status === 'paused').map(([k, s]) => [k, s.reason]));
}

/** Wraps the owner's entry gate for forward paper only: a paused strategy's signals are refused and journalled as skipped. */
export function governedGate(gate, paused, { market = 'MNQ', timeframe = '5m' } = {}) {
  return (pf, info) => {
    const reason = paused.get(`${pf.candidate}|${pf.contract || market}|${pf.resolution || timeframe}`);
    if (reason && info.stage === 'signal') return `the strategy governor paused it from forward paper: ${reason}`;
    return gate ? gate(pf, info) : null;
  };
}

/** Owner actions: settings, a manual pause or resume (always logged as the owner's). */
export async function governorAction(storage, body = {}, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  if (body.action === 'settings') {
    const next = { ...(await readGovSettings(storage)), ...cleanSettings(body.settings || {}) };
    await storage.put(GOV_SETTINGS, next);
    await appendDecision(storage, { at, strategy: '*', market: '*', timeframe: '*', action: 'modify', by: 'owner', reason: 'governor settings changed', evidence: { settings: next } });
    return { ok: true, settings: next };
  }
  if (body.action === 'pause' || body.action === 'resume') {
    const strategy = String(body.strategy || '');
    if (!INTRADAY_CANDIDATES[strategy]) return { ok: false, error: 'unknown strategy' };
    const market = body.market === 'NQ' ? 'NQ' : 'MNQ';
    const timeframe = String(body.timeframe || '5m');
    const key = `${strategy}|${market}|${timeframe}`;
    const state = (await storage.get(GOV_STATE)) || {};
    const reason = String(body.reason || (body.action === 'pause' ? 'paused by the owner' : 'resumed by the owner')).slice(0, 300);
    // An owner resume is honoured now; the governor checks again on its next run and logs any new pause.
    state[key] = { status: body.action === 'pause' ? 'paused' : 'active', since: at, reason, by: 'owner' };
    await storage.put(GOV_STATE, state);
    const id = await appendDecision(storage, { at, strategy, market, timeframe, action: body.action, by: 'owner', reason, evidence: {} });
    return { ok: true, id, state: state[key] };
  }
  return { ok: false, error: 'action must be settings, pause or resume' };
}

/** Why each candidate was taken or skipped, from the portfolios' own records, newest first. */
export function tradeDecisions(portfolios = [], { strategy = null, limit = 50 } = {}) {
  const items = [];
  for (const pf of portfolios) {
    if (strategy && pf.candidate !== strategy) continue;
    for (const s of pf.signals || []) items.push({ time: s.time, strategy: pf.candidate, portfolio: pf.key, side: s.side, decision: 'taken', why: s.why });
    for (const s of pf.skips || []) items.push({ time: s.time, strategy: pf.candidate, portfolio: pf.key, side: s.side, decision: 'skipped', why: s.reason, setup: s.why });
  }
  return items.sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, Math.max(1, Math.min(500, limit)));
}

export function speakGovernor(view) {
  const paused = view.strategies.filter((s) => s.status === 'paused');
  const watch = view.strategies.filter((s) => s.status === 'watch');
  if (!view.strategies.length) return 'The strategy governor has no forward paper trades to judge yet.';
  const parts = [];
  parts.push(paused.length ? `${paused.length} ${paused.length === 1 ? 'strategy is' : 'strategies are'} paused from forward paper: ${paused.map((s) => s.name).join(', ')}.` : 'No strategy is paused from forward paper.');
  if (watch.length) parts.push(`On watch: ${watch.map((s) => s.name).join(', ')}.`);
  parts.push('Paused strategies keep running in simulation; they return only after out-of-sample and walk-forward checks pass. Live trading stays off.');
  return parts.join(' ');
}
