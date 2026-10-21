// Chronological DELAYED-data strategy research. Not real-time forward execution or a broker account.
// Reuses the existing deterministic strategy and risk engines without relaxing the LIVE CME entry gate.
// All fills are hypothetical, observed only after the provider's delayed bar arrived. The separate
// ledger and ranking can NEVER qualify an account for live orders or be counted as verified forward trades.
import { INTRADAY_CANDIDATES, MIN_TRADES, intradayContext, newPortfolio, stepPortfolio, summarize, tradeDayOf, validateTradeRecord } from './trading_evidence.js';
import { makeEntryGate } from './trading_controls.js';

export const DELAYED_PORTFOLIOS = 'delayed_training_portfolios_v1';
export const DELAYED_INDEX = 'delayed_training_index_v1';
export const DELAYED_AUDIT = 'delayed_training_audit_v1';
export const DELAYED_RECORD_PREFIX = 'delayed_training_trade:';
const INDEX_CAP = 1500;
const AUDIT_CAP = 250;
const r2 = (n) => Math.round(n * 100) / 100;
const specsOf = (specs) => specs.filter((s) => s && INTRADAY_CANDIDATES[s.c] && ['any', 'trend'].includes(s.f));
const slim = (t) => ({ key: t.portfolio, strategy: t.strategy, filter: t.filter, version: t.strategy_version,
  time: t.entry.time, signal_time: t.signal.time, exit_time: t.exit.time, net_pnl: t.net_pnl, r_net: t.r_net,
  result: t.result, feed: t.data?.entry_feed?.status || t.data?.feed?.status || 'UNKNOWN' });
const hash100 = (text) => {
  let n = 2166136261;
  for (const ch of String(text)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
  return n % 100;
};

export function rankDelayedTraining(index = [], portfolios = []) {
  const rows = portfolios.map((pf) => {
    // Only this frozen strategy version; no pooling 'any' with 'trend' or changed parameters.
    const trades = index.filter((t) => t.key === pf.key && t.version === pf.strategy_version && t.feed === 'DELAYED')
      .map((t) => ({ net_pnl: t.net_pnl, r_net: t.r_net, side: 'long', costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } }));
    const stats = summarize(trades);
    const qualified = stats.trades >= MIN_TRADES && stats.expectancy_r_95ci.low > 0
      && (stats.profit_factor == null ? stats.wins > 0 && stats.losses === 0 : stats.profit_factor > 1.2);
    return { portfolio: pf.key, strategy: pf.candidate, name: INTRADAY_CANDIDATES[pf.candidate]?.name || pf.candidate,
      filter: pf.filter, strategy_version: pf.strategy_version, qualified, trades: stats.trades,
      wins: stats.wins, losses: stats.losses, net_pnl: stats.net_pnl, expectancy_r: stats.expectancy_r,
      confidence_low_r: stats.expectancy_r_95ci.low, profit_factor: stats.profit_factor,
      stage: stats.trades < MIN_TRADES ? 'collecting' : qualified ? 'eligible_for_research_focus' : 'unproven_or_losing' };
  });
  // A winner is not declared before at least 30 observations AND a positive confidence bound.
  const eligible = rows.filter((r) => r.qualified).sort((a, b) => b.confidence_low_r - a.confidence_low_r);
  const leader = eligible[0]?.portfolio || null;
  // The suggested 75/25 paper-research priority applies ONLY to future signals, never to a broker.
  for (const row of rows) row.focus_share = leader
    ? (row.portfolio === leader ? 0.75 : 0.25 / Math.max(1, rows.length - 1)) : 1 / Math.max(1, rows.length);
  return { rows: rows.sort((a, b) => b.confidence_low_r - a.confidence_low_r), leader,
    policy: leader ? 'research-only 75% leader focus, 25% diversified exploration; shadow-test all variants; correlated MNQ signals are not independent evidence'
      : 'balanced exploratory research; no strategy has independently qualified for extra focus; correlated variants must not be double-counted',
    execution_allowed: false };
}

function portfolio(spec) {
  const pf = newPortfolio(spec.c, spec.f, { source: 'paper', resolution: '5m',
    priceSeries: 'Yahoo MNQ=F delayed chronological research, hypothetical next-bar fills',
    params: { target_r: spec.target_r } });
  pf.signals = []; pf.skips = [];
  return pf;
}

export async function readDelayedTraining(storage, { enabled = false } = {}) {
  const [saved, index, audit] = await Promise.all([
    storage.get(DELAYED_PORTFOLIOS), storage.get(DELAYED_INDEX), storage.get(DELAYED_AUDIT),
  ]);
  const portfolios = Object.values(saved || {});
  const ranking = rankDelayedTraining(index || [], portfolios);
  return {
    kind: 'delayed_chronological_research', active: Boolean(enabled), feed: 'DELAYED',
    note: 'Hypothetical fills on delayed bars, never actual timely fills, broker orders, or verified LIVE forward evidence. Do not pool with the live-forward journal.',
    observed_trades: (index || []).length, last_record: (index || []).at(-1) || null,
    focused: ranking.leader, allocation: ranking.policy, ranking: ranking.rows,
    recent_decisions: (audit || []).slice(-12).reverse(), verified_forward_trades: 0,
  };
}

export async function resetDelayedTraining(storage, { now = Date.now() } = {}) {
  const saved = await storage.get(DELAYED_PORTFOLIOS);
  if (!saved) return;
  const audit = (await storage.get(DELAYED_AUDIT)) || [];
  const next = { ...saved };
  for (const pf of Object.values(next)) {
    if (pf.open || pf.pending) audit.push({ at: new Date(now).toISOString(), event: 'voided_on_stop_or_restart',
      portfolio: pf.key, reason: 'no retroactive delayed-research outcome after owner stops or restarts' });
    pf.open = null; pf.pending = null; pf.last_bar_time = null;
  }
  await storage.put(DELAYED_PORTFOLIOS, next);
  await storage.put(DELAYED_AUDIT, audit.slice(-AUDIT_CAP));
}

/**
 * One bounded read of the same closed bars the current LIVE monitor already fetched.
 * Entry gate for verified LIVE data remains unchanged. This track never reaches a broker.
 * On the first tick/restart, anchor to the newest known bar, not past history.
 */
export async function runDelayedTraining(storage, { feed, bars, specs, controls, now = Date.now() } = {}) {
  if (feed?.status !== 'DELAYED') return { skipped: 'not delayed research data' };
  const last = bars?.at(-1);
  if (!last || bars.length < 55) return { skipped: 'insufficient closed bars' };
  const age = now - Date.parse(last.t) - 300000;
  if (!(age >= 0 && age <= 45 * 60000)) return { skipped: 'delayed research feed too old or inconsistent' };
  const existing = (await storage.get(DELAYED_PORTFOLIOS)) || {};
  const index = (await storage.get(DELAYED_INDEX)) || [];
  const audit = (await storage.get(DELAYED_AUDIT)) || [];
  const chosen = specsOf(specs || []);
  const pfs = chosen.map((spec) => {
    const fresh = portfolio(spec);
    return existing[fresh.key] ? { ...fresh, ...existing[fresh.key] } : { ...fresh, last_bar_time: last.t };
  });
  if (!pfs.length) return { skipped: 'no configured research strategies' };
  const prior = rankDelayedTraining(index, pfs);
  const context = intradayContext(bars);
  const day = tradeDayOf(new Date(now).toISOString());
  const realized = index.filter((t) => tradeDayOf(t.exit_time) === day)
    .reduce((sum, t) => sum + (Number(t.net_pnl) || 0), 0);
  const riskGate = makeEntryGate(controls, { realized_today: realized, open_positions: pfs.filter((p) => p.open || p.pending).length });
  const added = []; const decisions = [];
  for (const pf of pfs) {
    pf.feed = { status: 'DELAYED', authenticated: false, subscription_verified: false,
      provider: feed.provider, provider_symbol: feed.provider_symbol, contract: feed.contract, latency_s: feed.latency_s };
    const previousBar = pf.last_bar_time;
    const completed = stepPortfolio(pf, bars, context, riskGate, { allowEntries: true });
    for (const trade of completed) {
      const validated = validateTradeRecord(trade);
      if (validated.length) { decisions.push({ event: 'record_refused', portfolio: pf.key, errors: validated }); continue; }
      const recorded = { ...trade, research_track: 'delayed_chronological', hypothetical: true,
        feed_observed_at: new Date(now).toISOString(),
        warning: 'DELAYED bars; hypothetical historical-time fills observed later, not executable market prices' };
      const key = `${DELAYED_RECORD_PREFIX}${trade.portfolio}:${trade.entry.time}`;
      if (!(await storage.get(key))) {
        await storage.put(key, recorded);
        added.push(slim(recorded));
      }
    }
    const from = prior.leader === pf.key ? 'research_priority' : prior.leader ? 'shadow_exploration' : 'balanced_exploration';
    for (const signal of (pf.signals || []).filter((v) => v.time > previousBar)) {
      decisions.push({ at: new Date(now).toISOString(), event: 'hypothetical_signal',
        portfolio: pf.key, bar: signal.time, side: signal.side, reason: signal.why,
        focus: from, priority: prior.rows.find((r) => r.portfolio === pf.key)?.focus_share || 0,
        no_broker_order: true });
    }
    for (const skip of (pf.skips || []).filter((v) => v.time > previousBar)) {
      decisions.push({ at: new Date(now).toISOString(), event: 'signal_skipped',
        portfolio: pf.key, bar: skip.time, reason: skip.reason,
        focus: from, no_broker_order: true });
    }
  }
  await storage.put(DELAYED_PORTFOLIOS, Object.fromEntries(pfs.map((p) => [p.key, p])));
  if (added.length) await storage.put(DELAYED_INDEX, [...index, ...added].slice(-INDEX_CAP));
  if (decisions.length) await storage.put(DELAYED_AUDIT, [...audit, ...decisions].slice(-AUDIT_CAP));
  const after = rankDelayedTraining([...index, ...added].slice(-INDEX_CAP), pfs);
  if (after.leader !== prior.leader) {
    const event = { at: new Date(now).toISOString(), event: 'paper_research_focus_changed', from: prior.leader, to: after.leader,
      reason: after.policy, no_live_orders: true };
    await storage.put(DELAYED_AUDIT, [...(await storage.get(DELAYED_AUDIT) || []), event].slice(-AUDIT_CAP));
  }
  return { ok: true, mode: 'DELAYED RESEARCH ONLY', observed_new_closed_trades: added.length,
    focus: after.leader, focus_policy: after.policy, source_last_bar: last.t,
    broker_orders: 0, verified_live_forward_entries: 0 };
}
