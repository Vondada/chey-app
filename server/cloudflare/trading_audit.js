// Deep trading audit (owner, 2026-10-24: "Audit the existing trading system before adding features"). It extends the
// record checks in trading_visual.auditTrades (duplicates, look-ahead, fills, labels, P&L sums), shown together in the
// same audit view (GET /api/trading/visual?view=audit, "audit the trades"). It reads the record sets CHE already keeps, each checked on its own and never added to another:
//   • the strategy simulation (strategy_sim.js: 1-minute paper strategies, results in R),
//   • the journal (trading_evidence.js evr: records): forward paper and backtest, futures and crypto apart,
//   • the research engine's backtest units (trading_research.js trd_ev:), the source of the "backtest trades" count.
// Every number is recomputed from the stored fields: timestamps, duplicates, P&L, R and the risk behind it, open
// positions, evidence and the look-ahead audit. Nothing is written, ordered or sent to a model. Corrections are shown
// next to the stored value; the stored history is never rewritten.
import { MINUTE_FEEDS, MAX_COST_R, RETIRED_FEEDS, readSimState, readStoredTrades, roundTripCost, summarize as simSummary } from './strategy_sim.js';
import { RECORD_PREFIX, contractOf, isCryptoRecord, tradeDayOf, validateTradeRecord } from './trading_evidence.js';

export const AUDIT_SOURCE = 'che_trading_audit';
const RESEARCH_PREFIX = 'trd_ev:';
const TICK = 60_000;
const STALE_OPEN_MS = 24 * 3600_000;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const ms = (t) => Date.parse(t);
const nyDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms(t)));
const sample = (list, n = 5) => list.slice(0, n);

// ─── Strategy simulation ─────────────────────────────────────────────────

/** Recomputes every simulation trade from its own fields. Bars are not stored, so fills inside the bar are not checkable. */
export function auditSimTrades(trades, { now = Date.now() } = {}) {
  const ids = new Map();
  const problems = { future: [], exit_before_entry: [], fill_not_next_minute: [], r_gross_mismatch: [], stop_not_below_entry: [], duplicate_ids: [] };
  let costsOverRisk = 0; let rFromCostly = 0; let rGross = 0; let rNet = 0; let costR = 0;
  const bySymbol = {};
  for (const t of trades) {
    ids.set(t.id, (ids.get(t.id) || 0) + 1);
    if (ms(t.exit_t) > now || ms(t.entry_t) > now) problems.future.push(t.id);
    if (!(ms(t.entry_t) <= ms(t.exit_t))) problems.exit_before_entry.push(t.id);
    if (ms(t.entry_t) - ms(t.signal_t) !== TICK) problems.fill_not_next_minute.push(t.id);
    const risk = t.entry_raw - t.stop;
    if (!(risk > 0)) problems.stop_not_below_entry.push(t.id);
    else if (Math.abs((t.exit_raw - t.entry_raw) / risk - t.r_gross) > 1e-6) problems.r_gross_mismatch.push(t.id);
    rGross += t.r_gross || 0; rNet += t.r || 0; costR += t.cost_r || 0;
    // A trade whose costs alone were more than its whole risk could not win in R terms on a normal move.
    if ((t.cost_r || 0) > 1) { costsOverRisk += 1; rFromCostly += t.r || 0; }
    const s = (bySymbol[t.symbol] ||= { trades: 0, total_r: 0, gross_r: 0, cost_r: 0, median_risk_pct: null, risks: [] });
    s.trades += 1; s.total_r += t.r || 0; s.gross_r += t.r_gross || 0; s.cost_r += t.cost_r || 0;
    if (risk > 0) s.risks.push(risk / t.entry_raw);
  }
  problems.duplicate_ids = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
  for (const [symbol, s] of Object.entries(bySymbol)) {
    const sorted = s.risks.sort((a, b) => a - b);
    s.median_risk_pct = sorted.length ? r4(100 * sorted[Math.floor(sorted.length / 2)]) : null;
    const feed = MINUTE_FEEDS[symbol];
    s.round_trip_cost_pct = feed?.fee?.rate ? r4(100 * (2 * feed.fee.rate + 2 * feed.slip.rate)) : null;
    delete s.risks;
    for (const k of ['total_r', 'gross_r', 'cost_r']) s[k] = r2(s[k]);
  }
  return {
    closed: trades.length,
    total_r: r2(rNet), gross_r_before_costs: r2(rGross), costs_r: r2(costR),
    trades_with_costs_over_risk: costsOverRisk, r_from_those_trades: r2(rFromCostly), r_from_the_rest: r2(rNet - rFromCostly),
    by_symbol: bySymbol,
    problems: Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, { count: v.length, examples: sample(v) }])),
    not_checkable: 'Fills inside each bar\'s high and low: the simulation stores trades, not the minute bars, so this needs the bars again.',
  };
}

export async function auditSimulation(storage, { now = Date.now() } = {}) {
  const state = await readSimState(storage);
  const trades = await readStoredTrades(storage, state.trades);
  const open = Object.values(state.open || {});
  const report = auditSimTrades(trades, { now });
  report.stored = state.trades.stored; report.dropped_by_cap = state.trades.dropped;
  report.open = {
    count: open.length,
    // A retired feed (Binance BTCUSDT/ETHUSDT) is no longer read, so its open positions can never close by themselves.
    on_retired_feeds: open.filter((p) => RETIRED_FEEDS.has(p.symbol) || !MINUTE_FEEDS[p.symbol]).map((p) => `${p.strategy}|${p.symbol}|${p.entry_t}`),
    older_than_24h: open.filter((p) => now - ms(p.entry_t) > STALE_OPEN_MS).map((p) => `${p.strategy}|${p.symbol}|${p.entry_t}`),
  };
  report.status = state.paused ? 'paused' : 'running';
  report.cost_gate = { max_cost_r: MAX_COST_R, skipped_since_gate: state.counts?.too_costly || 0,
    round_trip_cost: Object.fromEntries(Object.entries(MINUTE_FEEDS).map(([s, f]) => [s, f.fee.rate ? `${r4(100 * roundTripCost(f, 1))}% of price` : `${roundTripCost(f, 0)} points`])) };
  report.oos_summary = simSummary(trades);
  return report;
}

// ─── Journal (forward paper and backtest records) ────────────────────────

/** Recomputes a journal record's P&L and R from its own prices, quantity and costs. Null when the contract is unknown. */
export function recompute(t) {
  const c = contractOf(t.contract);
  if (!c) return null;
  const pv = c.pointValue * t.qty;
  const dir = t.side === 'short' ? -1 : 1;
  const gross = dir * (t.exit.raw - t.entry.raw) * pv;
  const costs = (t.costs?.spread || 0) + (t.costs?.slippage || 0) + (t.costs?.commissions || 0) + (t.costs?.fees || 0);
  const net = gross - costs;
  const risk = dir * (t.entry.raw - t.stop) * pv;
  return { gross: r2(gross), net: r2(net), risk_dollars: r2(risk), r_net: risk > 0 ? r4(net / risk) : null, costs: r2(costs) };
}

// Only what trading_visual.auditTrades does not already check: schema validation, timestamps in the future, gross P&L
// recomputed from the prices (auditTrades checks gross minus costs against net), R recomputed from the stop, and costs
// larger than the whole risk.
export function auditJournal(records, { now = Date.now(), day = '2026-09-22' } = {}) {
  const groups = {};
  for (const t of records) {
    const key = `${t.environment || 'unknown'}:${isCryptoRecord(t) ? 'crypto' : 'futures'}`;
    (groups[key] ||= []).push(t);
  }
  const out = {};
  for (const [key, list] of Object.entries(groups)) {
    const problems = { invalid: [], future: [], pnl_from_prices_mismatch: [], r_mismatch: [], costs_over_risk: [] };
    let net = 0;
    for (const t of list) {
      const id = `${t.portfolio}|${t.entry?.time}`;
      if (validateTradeRecord(t).length) problems.invalid.push(id);
      if (ms(t.exit?.time) > now || ms(t.entry?.time) > now) problems.future.push(id);
      const x = recompute(t);
      if (x) {
        if (Math.abs(x.net - t.net_pnl) > 0.05) problems.pnl_from_prices_mismatch.push(`${id} stored ${t.net_pnl} recomputed ${x.net}`);
        if (x.r_net !== null && Math.abs(x.r_net - t.r_net) > 0.002) problems.r_mismatch.push(`${id} stored ${t.r_net} recomputed ${x.r_net}`);
        if (x.risk_dollars > 0 && x.costs > x.risk_dollars) problems.costs_over_risk.push(id);
      }
      net += t.net_pnl || 0;
    }
    out[key] = { records: list.length, net_pnl: r2(net), problems: Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, { count: v.length, examples: sample(v) }])) };
  }
  return { groups: out, day: dayAudit(records, day) };
}

/**
 * One day's P&L three ways, because the same rows give different totals: the UTC date of the exit, the New York calendar
 * date, and the CME trade day (which starts at 18:00 New York the evening before). Each list names its records.
 */
export function dayAudit(records, day) {
  const paper = records.filter((t) => t.environment === 'paper');
  const ways = {
    utc_date: (t) => String(t.exit.time).slice(0, 10) === day,
    new_york_date: (t) => nyDay(t.exit.time) === day,
    cme_trade_day: (t) => tradeDayOf(t.exit.time) === day,
  };
  const out = { day, basis: 'forward paper records only, by exit time; backtest records are never in a day\'s P&L' };
  for (const [way, inDay] of Object.entries(ways)) {
    const rows = paper.filter(inDay);
    out[way] = { records: rows.length, net_pnl: r2(rows.reduce((a, t) => a + (t.net_pnl || 0), 0)),
      by_market: Object.fromEntries(['futures', 'crypto'].map((m) => [m, r2(rows.filter((t) => (isCryptoRecord(t) ? 'crypto' : 'futures') === m).reduce((a, t) => a + (t.net_pnl || 0), 0))])),
      rows: rows.slice(0, 40).map((t) => ({ portfolio: t.portfolio, strategy: t.strategy, contract: t.contract, entry: t.entry.time, exit: t.exit.time, net_pnl: t.net_pnl })) };
  }
  return out;
}

// ─── Research backtest units ─────────────────────────────────────────────

export function auditResearchUnits(units) {
  const ok = units.filter((u) => u.ok !== false);
  const fixture = ok.filter((u) => /TEST FIXTURE/i.test(u.dataset?.provider || ''));
  const noHash = ok.filter((u) => !u.dataset?.sha256);
  const proxy = ok.filter((u) => u.dataset?.proxy);
  const la = (v) => ok.filter((u) => u.look_ahead === v);
  const trades = (list) => list.reduce((a, u) => a + (u.all?.trades || 0), 0);
  const name = (u) => `${u.strategy_id} ${u.market} ${u.timeframe} ${u.mode || 'BACKTEST'}`;
  return {
    units: ok.length, backtest_trades: trades(ok.filter((u) => (u.mode || 'BACKTEST') === 'BACKTEST')),
    with_dataset_hash: ok.length - noHash.length, without_dataset_hash: { count: noHash.length, examples: sample(noHash.map(name)) },
    from_test_fixtures: { count: fixture.length, trades: trades(fixture), examples: sample(fixture.map(name)) },
    proxy_data: { count: proxy.length, trades: trades(proxy) },
    look_ahead: { passed: la('passed').length, failed: { count: la('FAILED').length, examples: sample(la('FAILED').map(name)) }, not_enough_bars: la('not enough bars').length, not_run: ok.filter((u) => !u.look_ahead).length },
    providers: [...new Set(ok.map((u) => u.dataset?.provider || 'unknown'))],
  };
}

// ─── The whole report ────────────────────────────────────────────────────

export async function deepTradeAudit(storage, { now = Date.now(), day = '2026-09-22' } = {}) {
  const [simulation, journalMap, unitMap] = await Promise.all([
    auditSimulation(storage, { now }).catch((e) => ({ error: String(e?.message || e) })),
    storage.list({ prefix: RECORD_PREFIX }),
    storage.list({ prefix: RESEARCH_PREFIX }),
  ]);
  const journal = auditJournal([...journalMap.values()], { now, day });
  const research = auditResearchUnits([...unitMap.values()]);
  return {
    source: AUDIT_SOURCE, at: new Date(now).toISOString(), read_only: true, model_calls: 0, broker_calls: 0,
    simulation, journal, research,
    separation: 'Simulation results are in R; journal results are in dollars by environment and market; backtest units are research. None is added to another.',
  };
}

/** Counts only: the line the deploy prints. No prices, no record contents. */
export function auditSummaryLine(a) {
  const s = a.simulation || {};
  const sp = s.problems || {};
  const count = (p) => Object.values(p || {}).reduce((x, v) => x + (v.count || 0), 0);
  const jg = a.journal?.groups || {};
  const journal = Object.entries(jg).map(([k, g]) => `${k} ${g.records} records, ${count(g.problems)} problems`).join('; ') || 'no journal records';
  return [
    s.error ? `simulation unreadable (${s.error})` : `simulation ${s.closed} closed, ${s.open?.count} open (${s.open?.on_retired_feeds?.length} on retired feeds), total ${s.total_r} R = gross ${s.gross_r_before_costs} R minus costs ${s.costs_r} R; ${s.trades_with_costs_over_risk} trades had costs over their risk (${s.r_from_those_trades} R); ${count(sp)} record problems`,
    `journal: ${journal}`,
    `research: ${a.research.units} units, ${a.research.backtest_trades} backtest trades, ${a.research.from_test_fixtures.count} fixture units, ${a.research.look_ahead.failed.count} failed look-ahead, ${a.research.without_dataset_hash.count} without data hash`,
    `day ${a.journal.day.day}: UTC ${a.journal.day.utc_date.net_pnl}, New York ${a.journal.day.new_york_date.net_pnl}, CME day ${a.journal.day.cme_trade_day.net_pnl}`,
  ].join(' | ');
}

/** Spoken and shown as large text: the headline findings only. */
export function speakDeepAudit(a) {
  const s = a.simulation || {};
  const lines = ['Deeper checks, read only, from the stored records.'];
  if (!s.error) {
    lines.push(`Strategy simulation: ${s.closed} closed trades and ${s.open.count} open. Total ${s.total_r} R: ${s.gross_r_before_costs} R from price moves and ${-s.costs_r} R in costs.`);
    if (s.trades_with_costs_over_risk) lines.push(`${s.trades_with_costs_over_risk} trades had costs larger than their whole risk; they account for ${s.r_from_those_trades} R. New signals like that are now skipped.`);
    if (s.open.on_retired_feeds.length) lines.push(`${s.open.on_retired_feeds.length} open positions are on retired Binance feeds and cannot close by themselves.`);
  }
  for (const [k, g] of Object.entries(a.journal.groups)) lines.push(`Journal ${k.replace(':', ' ')}: ${g.records} records, net $${g.net_pnl}.`);
  lines.push(`Research: ${a.research.backtest_trades} backtest trades in ${a.research.units} units; ${a.research.look_ahead.failed.count} failed the look-ahead audit; ${a.research.from_test_fixtures.count} came from test fixtures.`);
  const d = a.journal.day;
  lines.push(`${d.day} paper P&L: $${d.new_york_date.net_pnl} by New York date, $${d.utc_date.net_pnl} by UTC date, $${d.cme_trade_day.net_pnl} by CME trade day.`);
  return lines.join('\n');
}
