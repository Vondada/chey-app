// Visual trading evidence (owner, 2026-10-23): "I want to SEE the trades, the timeframes, the
// strategies and the daily P&L". One read-only projection over the trade records CHE already keeps;
// it adds no engine, ledger or strategy of its own, and it never writes a trade.
//
// Record sets read (each keeps its own execution type, never merged into another):
// - historical_backtest: the 5-minute research replays (trading_live.liveBacktest outcome chunks) and
//   the daily historical study (evr:backtest:*, historical_intelligence.js);
// - forward_paper: CHE's forward paper journal on DELAYED 5-minute MNQ bars (evr:paper:*, 5m);
// - daily_paper: the daily evidence pass (evr:paper:*, daily bars);
// - simulation: the 1-minute strategy simulation (strategy_sim.js), measured in R only;
// - broker_paper: Alpaca PAPER fills, read live from Alpaca by the chart, never stored here;
// - live: disabled. Zero trades, always.
//
// Every number comes from a stored record. A metric a record set does not carry (dollars for the
// R-only simulation, an account balance for the paper engine) is null with its reason, never estimated.
import { readSimState, readStoredTrades } from './strategy_sim.js';
import { CONTRACTS, MIN_TRADES, readTrades, tradeDayOf, wilsonInterval } from './trading_evidence.js';
import { LIVE_BACKTEST, LIVE_FEED, readLivePortfolios } from './trading_live.js';
import { datasetManifests, loadDataset, tfOf } from './trading_research.js';

export const VISUAL_SOURCE = 'che_trading_visual';
export const DAILY_TARGET = 30;

export const EXECUTION_TYPES = Object.freeze({
  historical_backtest: { label: 'Historical backtest', data_type: 'historical', note: 'Replayed on stored history; no order existed.' },
  forward_paper: { label: 'Forward paper (CHE engine)', data_type: 'live-paper', note: 'Simulated fills on DELAYED bars as they arrived; no broker order.' },
  daily_paper: { label: 'Daily-bar paper research', data_type: 'paper', note: 'Approximate: daily bars, fills at the next open.' },
  simulation: { label: 'Strategy simulation (1-minute)', data_type: 'paper', note: 'Measured in R only; no dollar amounts are recorded.' },
  broker_paper: { label: 'Alpaca PAPER fill', data_type: 'broker', note: 'Read live from Alpaca on the chart; not stored by CHE.' },
  live: { label: 'Live', data_type: 'live', note: 'Live orders are disabled.' },
});

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const finite = (x) => Number.isFinite(x);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ─── One shape for every record set ───────────────────────────────────────

/** An evidence-journal record (trading_evidence closeAt) as the visual layer shows it. */
export function fromEvidence(t, executionType) {
  const tf = t.data?.resolution === 'daily' ? '1D' : t.data?.resolution || '5m';
  const c = t.costs || {};
  return {
    id: `${executionType}|${t.portfolio}|${t.entry?.time}`,
    execution_type: executionType, execution_label: EXECUTION_TYPES[executionType].label, data_type: EXECUTION_TYPES[executionType].data_type,
    strategy: t.strategy, variant: `${t.filter || 'any'}|${t.params?.target_r ?? ''}R`, strategy_version: t.strategy_version || null,
    symbol: t.symbol || t.contract, timeframe: tf, side: t.side || 'long', qty: t.qty ?? null, session: t.session || null,
    signal_time: t.signal?.time || null, signal_why: t.signal?.why || '', signal_ref: num(t.signal?.ref),
    entry_time: t.entry?.time || null, entry_raw: num(t.entry?.raw), entry_price: num(t.entry?.fill), entry_basis: t.entry?.basis || null,
    exit_time: t.exit?.time || null, exit_raw: num(t.exit?.raw), exit_price: num(t.exit?.fill), exit_reason: t.exit?.reason || null,
    stop: num(t.stop), target: num(t.target),
    gross: num(t.gross_before_costs), commissions: r2((c.commissions ?? 0) + (c.fees ?? 0)), slippage: r2((c.slippage ?? 0) + (c.spread ?? 0)),
    net: num(t.net_pnl), r: num(t.r_net), result: t.result || (t.net_pnl > 0 ? 'win' : t.net_pnl < 0 ? 'loss' : 'flat'),
    trade_day: t.exit?.time ? tradeDayOf(t.exit.time) : null,
    data_label: t.data?.label || null, feed_status: t.data?.entry_feed?.status || t.data?.feed?.status || null,
    _raw: t,
  };
}

/** A strategy-simulation trade (R only, 1-minute bars). */
export function fromSim(t) {
  const win = t.r > 0;
  return {
    id: `simulation|${t.id}`, execution_type: 'simulation', execution_label: EXECUTION_TYPES.simulation.label, data_type: 'paper',
    strategy: t.strategy, variant: '', strategy_version: null, symbol: t.symbol, timeframe: '1m', side: 'long', qty: null, session: null,
    signal_time: t.signal_t || null, signal_why: t.why || '', signal_ref: num(t.signal_price),
    entry_time: t.entry_t || null, entry_raw: num(t.entry_raw), entry_price: num(t.entry), entry_basis: 'next_bar_open',
    exit_time: t.exit_t || null, exit_raw: num(t.exit_raw), exit_price: num(t.exit), exit_reason: t.exit_reason || null,
    stop: num(t.stop), target: num(t.target), gross: null, commissions: null, slippage: null, net: null, r: num(t.r),
    result: t.exit_t ? (win ? 'win' : t.r < 0 ? 'loss' : 'flat') : 'open', trade_day: t.exit_t ? tradeDayOf(t.exit_t) : null,
    data_label: t.label || null, feed_status: t.feed?.status || null, _raw: t,
  };
}

const isForward = (t) => t.environment === 'paper' && t.data?.resolution === '5m';
const isDailyPaper = (t) => t.environment === 'paper' && (t.data?.resolution ?? 'daily') === 'daily';
const isBacktest = (t) => t.environment === 'backtest';

/** The newest 5-minute research replay's trades, from its outcome chunks. */
async function researchTrades(storage) {
  const run = await storage.get(LIVE_BACKTEST);
  if (!run?.ok || !Array.isArray(run.rows)) return { trades: [], run: null };
  const out = [];
  for (const row of run.rows) {
    if (!row.outcome_index_ref) continue;
    const refs = (await storage.get(row.outcome_index_ref)) || [];
    for (let i = 0; i < refs.length; i += 100) {
      const got = await storage.get(refs.slice(i, i + 100));
      for (const k of refs.slice(i, i + 100)) for (const t of got.get(k) || []) out.push(t);
    }
  }
  return { trades: out, run: { id: run.id, at: run.at, dataset_hash: run.dataset_hash, provider: run.provider, bars: run.bars, from: run.from, to: run.to, retained: out.length > 0 } };
}

/** Every record set, normalized and labelled. A set that cannot be read says so; nothing is substituted. */
export async function readVisualTrades(storage) {
  const sources = [];
  const trades = [];
  const read = async (id, fn) => {
    try {
      const list = await fn();
      sources.push({ execution_type: id, label: EXECUTION_TYPES[id].label, read: true, trades: list.length });
      trades.push(...list);
    } catch (e) {
      sources.push({ execution_type: id, label: EXECUTION_TYPES[id].label, read: false, trades: null, error: String(e?.message || e).slice(0, 160) });
    }
  };
  const journal = await readTrades(storage).catch(() => null);
  let research = null;
  await read('historical_backtest', async () => {
    if (!journal) throw new Error('the evidence journal could not be read');
    const r = await researchTrades(storage);
    research = r.run;
    return [...r.trades.map((t) => fromEvidence(t, 'historical_backtest')), ...journal.filter(isBacktest).map((t) => fromEvidence(t, 'historical_backtest'))];
  });
  await read('forward_paper', async () => { if (!journal) throw new Error('the evidence journal could not be read'); return journal.filter(isForward).map((t) => fromEvidence(t, 'forward_paper')); });
  await read('daily_paper', async () => { if (!journal) throw new Error('the evidence journal could not be read'); return journal.filter(isDailyPaper).map((t) => fromEvidence(t, 'daily_paper')); });
  await read('simulation', async () => {
    const state = await readSimState(storage);
    return (await readStoredTrades(storage, state.trades)).filter((t) => t.exit_t).map(fromSim);
  });
  sources.push({ execution_type: 'broker_paper', label: EXECUTION_TYPES.broker_paper.label, read: false, trades: null, note: EXECUTION_TYPES.broker_paper.note });
  sources.push({ execution_type: 'live', label: EXECUTION_TYPES.live.label, read: true, trades: 0, note: EXECUTION_TYPES.live.note });
  trades.sort((a, b) => String(a.entry_time).localeCompare(String(b.entry_time)));
  const { trades: unique, duplicates } = assignTradeIds(trades);
  return { trades: unique, records: trades, duplicates, sources, research };
}

// ─── Trade identity and evidence labels (owner mission, 2026-10-23, Priority 5) ───

/** What kind of evidence a trade is, in the owner's four words. Broker-confirmed is only ever an Alpaca PAPER fill read live; live orders stay disabled. */
export const EVIDENCE_LABELS = Object.freeze({
  historical_backtest: 'BACKTEST', simulation: 'SIMULATION', forward_paper: 'FORWARD PAPER', daily_paper: 'FORWARD PAPER', broker_paper: 'BROKER-CONFIRMED', live: 'BROKER-CONFIRMED',
});

/** The fields that make one trade that trade: same record set, same strategy variant, same market, timeframe, side and entry. */
export function naturalKey(t) {
  const raw = t._raw || {};
  const owner = t.execution_type === 'simulation' ? `sim:${raw.id ?? ''}` : (raw.portfolio || `${t.strategy}|${t.variant}`);
  return [t.execution_type, owner, t.symbol, t.timeframe, t.side, t.entry_time].join('|');
}

/** A short ID derived only from the trade's natural key (FNV-1a, 64-bit), so it is the same after every restart and on every device. */
export function tradeIdOf(key) {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(String(key))) h = BigInt.asUintN(64, (h ^ BigInt(ch)) * 0x100000001b3n);
  return `T${h.toString(36).toUpperCase().padStart(13, '0')}`;
}

/**
 * One trade per ID. A second record with the same natural key is never shown as another trade: it is
 * reported as a duplicate (identical) or a conflict (same entry, different outcome), and the first stored
 * record is kept. Nothing is deleted from storage.
 */
export function assignTradeIds(trades) {
  const seen = new Map();
  const unique = []; const duplicates = [];
  for (const t of trades) {
    const key = naturalKey(t);
    const id = tradeIdOf(key);
    const first = seen.get(id);
    if (first) {
      const same = first.exit_time === t.exit_time && first.exit_price === t.exit_price && first.net === t.net && first.r === t.r;
      duplicates.push({ id, kind: same ? 'duplicate' : 'conflict', execution_type: t.execution_type, entry_time: t.entry_time });
      continue;
    }
    const withId = { ...t, id, key, evidence_label: EVIDENCE_LABELS[t.execution_type] || 'SIMULATION' };
    seen.set(id, withId);
    unique.push(withId);
  }
  return { trades: unique, duplicates };
}

/** Skipped and blocked signals the forward engine kept, with their reasons (never traded, never deleted). */
export async function readSkips(storage) {
  const portfolios = await readLivePortfolios(storage).catch(() => []);
  const out = [];
  for (const pf of portfolios) for (const s of pf.skips || []) out.push({ strategy: pf.candidate, variant: `${pf.filter || 'any'}|${pf.params?.target_r ?? ''}R`, timeframe: '5m', time: s.time, reason: s.reason, side: s.side, why: s.why, trade_day: s.time ? tradeDayOf(s.time) : null });
  return out.sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

// ─── Filters and metrics ──────────────────────────────────────────────────

const lc = (s) => String(s || '').toLowerCase();
/** instrument, timeframe, strategy, from/to (trade day), execution_type, side, result. Unknown keys are ignored. */
export function filterTrades(trades, f = {}) {
  return trades.filter((t) => (!f.instrument || lc(t.symbol) === lc(f.instrument))
    && (!f.timeframe || t.timeframe === f.timeframe)
    && (!f.strategy || lc(t.strategy).includes(lc(f.strategy)))
    && (!f.execution_type || t.execution_type === f.execution_type)
    && (!f.side || t.side === f.side)
    && (!f.result || t.result === f.result)
    && (!f.from || (t.trade_day && t.trade_day >= f.from))
    && (!f.to || (t.trade_day && t.trade_day <= f.to)));
}

/** The full metric list for a group of closed trades. Dollar metrics are null when the set records R only. */
export function metricsOf(list) {
  const n = list.length;
  const dollars = n > 0 && list.every((t) => finite(t.net));
  const wins = list.filter((t) => t.result === 'win').length;
  const losses = list.filter((t) => t.result === 'loss').length;
  const sum = (k) => (dollars ? r2(list.reduce((s, t) => s + (t[k] ?? 0), 0)) : null);
  const rs = list.map((t) => t.r).filter(finite);
  const meanR = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((s, v) => s + (v - meanR) ** 2, 0) / (rs.length - 1)) : null;
  const half = sd != null ? (1.96 * sd) / Math.sqrt(rs.length) : null;
  const unit = dollars ? 'net' : 'r';
  const sorted = [...list].sort((a, b) => String(a.exit_time).localeCompare(String(b.exit_time)));
  let eq = 0; let peak = 0; let dd = 0;
  for (const t of sorted) { eq += (unit === 'net' ? t.net : t.r) ?? 0; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const gw = list.reduce((s, t) => s + Math.max(0, (unit === 'net' ? t.net : t.r) ?? 0), 0);
  const gl = -list.reduce((s, t) => s + Math.min(0, (unit === 'net' ? t.net : t.r) ?? 0), 0);
  const ci = wilsonInterval(wins, n);
  return {
    trades: n, wins, losses, flat: n - wins - losses,
    win_rate: n ? r2((100 * wins) / n) : null, win_rate_95ci: n ? { low: r2(100 * ci.low), high: r2(100 * ci.high) } : null,
    gross: sum('gross'), commissions: sum('commissions'), slippage: sum('slippage'), net: sum('net'),
    unit: dollars ? 'USD' : 'R', max_drawdown: n ? (unit === 'net' ? r2(dd) : r4(dd)) : null,
    expectancy_r: r4(meanR), expectancy_r_95ci: half != null ? { low: r4(meanR - half), high: r4(meanR + half) } : null,
    expectancy_dollars: dollars && n ? r2(list.reduce((s, t) => s + t.net, 0) / n) : null,
    profit_factor: gl > 0 ? r2(gw / gl) : null,
    profit_factor_note: n === 0 ? 'no trades' : gl === 0 ? 'no losing trades, so profit factor is undefined' : null,
    sample: n < MIN_TRADES ? 'insufficient' : n < 100 ? 'low' : 'adequate', provisional: n < MIN_TRADES,
  };
}

// ─── Daily evidence: strategy × timeframe × trading day ───────────────────

const qualityOf = (list) => [...new Set(list.map((t) => t.feed_status || t.data_label || 'unlabelled'))];

/**
 * One row per strategy, timeframe, execution type and CME trading day. The 30-trade figure is a daily
 * target, never a quota: a row below it says why from the recorded skips, and nothing is forced.
 */
export function dailyEvidence(trades, { skips = [], today = tradeDayOf(new Date().toISOString()), target = DAILY_TARGET } = {}) {
  const groups = new Map();
  for (const t of trades) {
    if (!t.trade_day) continue;
    const key = [t.strategy, t.timeframe, t.execution_type, t.trade_day].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const skipBy = new Map();
  for (const s of skips) {
    const key = [s.strategy, s.timeframe, s.trade_day].join('|');
    if (!skipBy.has(key)) skipBy.set(key, []);
    skipBy.get(key).push(s);
  }
  const rows = [...groups.entries()].map(([key, list]) => {
    const [strategy, timeframe, executionType, day] = key.split('|');
    const m = metricsOf(list);
    const complete = day < today;
    const daySkips = executionType === 'forward_paper' ? skipBy.get([strategy, timeframe, day].join('|')) || [] : [];
    const reasons = {};
    for (const s of daySkips) { const r = s.reason.replace(/\s*\(.*\)$/, ''); reasons[r] = (reasons[r] || 0) + 1; }
    const why = m.trades >= target ? null
      : !complete ? `The session is still open: ${m.trades} of ${target} so far.`
      : executionType === 'historical_backtest' ? `Only ${m.trades} setups on this day met the written rules in the replay.`
      : daySkips.length ? `${m.trades} trades met the rules; ${daySkips.length} recorded setups were skipped (${Object.entries(reasons).map(([r, c]) => `${c} × ${r}`).join('; ')}).`
      : `Only ${m.trades} setups met the written rules; no trades are forced to reach ${target}.`;
    return {
      strategy, timeframe, execution_type: executionType, execution_label: EXECUTION_TYPES[executionType]?.label || executionType, trade_day: day,
      ...m, status: complete ? 'complete' : 'partial', data_type: EXECUTION_TYPES[executionType]?.data_type || null, data_quality: qualityOf(list),
      target: { trades: target, reached: m.trades >= target, reason: why }, skipped: daySkips.length,
    };
  });
  return rows.sort((a, b) => b.trade_day.localeCompare(a.trade_day) || a.strategy.localeCompare(b.strategy) || a.timeframe.localeCompare(b.timeframe));
}

// ─── Daily P&L (forward paper) ───────────────────────────────────────────

/**
 * Today's paper P&L from the forward journal and open portfolios. Unrealized is marked at the last
 * stored bar close (DELAYED), before exit costs. The paper engine keeps no account balance, so
 * balances are null with that reason; nothing is assumed.
 */
export function dailyPnl({ trades = [], positions = [], lastBar = null, day, now = Date.now() } = {}) {
  const today = day || tradeDayOf(new Date(now).toISOString());
  const closed = trades.filter((t) => t.execution_type === 'forward_paper' && t.trade_day === today).sort((a, b) => String(a.exit_time).localeCompare(String(b.exit_time)));
  const realized = r2(closed.reduce((s, t) => s + (t.net ?? 0), 0)) ?? 0;
  const mark = num(lastBar?.c);
  const open = positions.map((p) => {
    const contract = CONTRACTS[p.contract] || CONTRACTS.MNQ;
    const pts = mark == null || !finite(p.entry_price) ? null : (p.side === 'short' ? p.entry_price - mark : mark - p.entry_price);
    return { ...p, mark, mark_time: lastBar?.t || null, unrealized: pts == null ? null : r2(pts * contract.pointValue * (p.qty || 1)) };
  });
  const unrealized = open.length ? (open.every((p) => p.unrealized != null) ? r2(open.reduce((s, p) => s + p.unrealized, 0)) : null) : 0;
  let eq = 0;
  const curve = closed.map((t) => ({ t: t.exit_time, realized: (eq = r2(eq + (t.net ?? 0))), trade: t.id }));
  if (open.length && unrealized != null && lastBar?.t) curve.push({ t: lastBar.t, realized: eq, with_open: r2(eq + unrealized), mark: true });
  const values = curve.map((p) => p.with_open ?? p.realized);
  const prev = trades.filter((t) => t.execution_type === 'forward_paper' && t.trade_day && t.trade_day < today).map((t) => t.trade_day).sort().at(-1) || null;
  const prevNet = prev ? r2(trades.filter((t) => t.execution_type === 'forward_paper' && t.trade_day === prev).reduce((s, t) => s + (t.net ?? 0), 0)) : null;
  return {
    day: today, account: 'CHE forward paper (MNQ, DELAYED data)', execution_type: 'forward_paper',
    realized, unrealized, net: unrealized == null ? null : r2(realized + unrealized),
    unrealized_note: open.length ? (mark == null ? 'No stored bar to mark the open positions; unrealized is not known.' : `Marked at the last stored DELAYED bar close (${lastBar.t}), before exit costs.`) : 'No open positions.',
    trades_closed: closed.length, open_positions: open.length, positions: open,
    commissions: r2(closed.reduce((s, t) => s + (t.commissions ?? 0), 0)) ?? 0, slippage: r2(closed.reduce((s, t) => s + (t.slippage ?? 0), 0)) ?? 0,
    balance: null, balance_note: 'The CHE paper engine keeps no account balance; Alpaca PAPER balances are on the Account section.',
    high: values.length ? Math.max(0, ...values) : null, low: values.length ? Math.min(0, ...values) : null,
    curve, last_update: closed.at(-1)?.exit_time || lastBar?.t || null,
    compare: { previous_day: prev, previous_net: prevNet },
    live_orders: 'disabled',
  };
}

// ─── Replay without look-ahead ────────────────────────────────────────────

/**
 * The replay at `cursor`: only bars that had closed by then, and each trade only as far as it had
 * happened. A bar opening at t closes at t + timeframe, so a bar still forming is not shown. What the
 * strategy knew (closed bars), decided (signals on closed bars), what was executed (fills at a bar's
 * open) and what happened (exits on closed bars) are kept apart. Nothing after the cursor is returned.
 */
export function replayFrame({ bars = [], trades = [], cursor, timeframe = '5m' } = {}) {
  const at = Date.parse(cursor);
  const ms = tfOf(timeframe)?.ms || 5 * 60_000;
  if (!Number.isFinite(at)) return { ok: false, error: 'The replay needs a cursor time.' };
  const closedBy = (t) => Number.isFinite(Date.parse(t)) && Date.parse(t) + ms <= at;
  const visible = bars.filter((b) => closedBy(b.t));
  const knew = visible.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const decided = []; const executed = []; const happened = [];
  for (const t of trades) {
    if (t.signal_time && closedBy(t.signal_time)) decided.push({ id: t.id, strategy: t.strategy, side: t.side, signal_time: t.signal_time, why: t.signal_why, ref: t.signal_ref, stop: t.stop, target: t.target });
    if (t.entry_time && Date.parse(t.entry_time) <= at) {
      const done = t.exit_time && closedBy(t.exit_time);
      executed.push({ id: t.id, strategy: t.strategy, side: t.side, execution_type: t.execution_type, entry_time: t.entry_time, entry_price: t.entry_price, stop: t.stop, target: t.target, status: done ? 'closed' : 'open' });
      if (done) happened.push({ id: t.id, exit_time: t.exit_time, exit_price: t.exit_price, exit_reason: t.exit_reason, net: t.net, r: t.r, result: t.result });
    }
  }
  return { ok: true, cursor: new Date(at).toISOString(), timeframe, knew: { bars: knew, last_closed: knew.at(-1)?.t || null }, decided, executed, happened,
    rule: 'Only bars closed by the cursor are shown; fills happen at the next bar open; exits appear once their bar has closed.' };
}

// ─── Historical vs today ──────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Years, this year to date, the last 30 days, the latest session, today, weekdays and sessions, each labelled. */
export function compareWindows(trades, { now = Date.now() } = {}) {
  const today = tradeDayOf(new Date(now).toISOString());
  const year = today.slice(0, 4);
  const d30 = new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const days = [...new Set(trades.map((t) => t.trade_day).filter(Boolean))].sort();
  const latest = days.filter((d) => d < today).at(-1) || null;
  const win = (id, label, list) => ({ id, label, ...metricsOf(list), execution_types: [...new Set(list.map((t) => t.execution_type))], data_quality: qualityOf(list) });
  const out = [];
  for (const y of [...new Set(days.map((d) => d.slice(0, 4)))]) out.push(win(`year:${y}`, y, trades.filter((t) => t.trade_day?.startsWith(y))));
  out.push(win('ytd', `${year} year to date`, trades.filter((t) => t.trade_day?.startsWith(year))));
  out.push(win('last_30_days', 'Last 30 days', trades.filter((t) => t.trade_day && t.trade_day > d30)));
  out.push(win('latest_session', latest ? `Latest complete session (${latest})` : 'Latest complete session (none recorded)', latest ? trades.filter((t) => t.trade_day === latest) : []));
  out.push(win('today', `Today (${today}, partial)`, trades.filter((t) => t.trade_day === today)));
  for (const w of [1, 2, 3, 4, 5]) out.push(win(`weekday:${w}`, WEEKDAYS[w], trades.filter((t) => t.trade_day && new Date(`${t.trade_day}T12:00:00Z`).getUTCDay() === w)));
  for (const s of [...new Set(trades.map((t) => t.session).filter(Boolean))].sort()) out.push(win(`session:${s}`, `Session: ${s}`, trades.filter((t) => t.session === s)));
  return out;
}

// ─── Responsible ranking and the current leader ───────────────────────────

/**
 * Ranked by the lower end of the 95% range of expectancy in R (never by win rate), within one
 * execution type. A group below 30 trades is listed as provisional and never ranked above one that has them.
 */
export function rankStrategies(trades, { executionType = 'forward_paper' } = {}) {
  const groups = new Map();
  for (const t of trades.filter((x) => x.execution_type === executionType)) {
    const key = `${t.strategy}|${t.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [strategy, timeframe] = key.split('|');
    const m = metricsOf(list);
    return { strategy, timeframe, execution_type: executionType, ...m, score: m.expectancy_r_95ci?.low ?? null };
  }).sort((a, b) => Number(b.trades >= MIN_TRADES) - Number(a.trades >= MIN_TRADES) || (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

export const LEADER_RULES = Object.freeze([
  `at least ${MIN_TRADES} forward paper trades (one strategy, one timeframe)`,
  'the 95% range of forward expectancy in R is above zero after costs',
  'profit factor after costs above 1.2',
  `the same strategy and timeframe has at least ${MIN_TRADES} historical backtest trades with positive expectancy`,
  'never chosen by win rate alone',
]);

/** The Best Verified Strategy, or "No verified leader yet" with each candidate's missing evidence. */
export function currentLeader(trades) {
  const forward = rankStrategies(trades, { executionType: 'forward_paper' });
  const history = rankStrategies(trades, { executionType: 'historical_backtest' });
  const checks = forward.map((row) => {
    const hist = history.find((h) => h.strategy === row.strategy && h.timeframe === row.timeframe) || null;
    const missing = [];
    if (row.trades < MIN_TRADES) missing.push(`${row.trades} of ${MIN_TRADES} forward paper trades`);
    if (!(row.expectancy_r_95ci?.low > 0)) missing.push('forward expectancy range includes zero or less');
    if (!(row.profit_factor > 1.2)) missing.push(row.profit_factor == null ? 'profit factor undefined' : `profit factor ${row.profit_factor}, not above 1.2`);
    if (!hist || hist.trades < MIN_TRADES || !(hist.expectancy_r > 0)) missing.push(hist ? `historical: ${hist.trades} trades, expectancy ${hist.expectancy_r ?? 'n/a'} R` : 'no historical backtest for this strategy and timeframe');
    return { strategy: row.strategy, timeframe: row.timeframe, forward: row, historical: hist, verified: missing.length === 0, missing };
  });
  const leader = checks.find((c) => c.verified) || null;
  const provisional = checks[0] || null;
  return {
    rules: LEADER_RULES, leader,
    headline: leader ? `Current leader: ${leader.strategy} on ${leader.timeframe} (verified by the rules above).` : 'No verified leader yet.',
    provisional: leader ? null : provisional && { ...provisional, label: 'Provisional: does not meet the rules' },
    candidates: checks.slice(0, 10),
    paper_track: leader ? metricsOf(trades.filter((t) => t.execution_type === 'forward_paper' && t.strategy === leader.strategy && t.timeframe === leader.timeframe)) : null,
  };
}

// ─── Journal ──────────────────────────────────────────────────────────────

const publicTrade = ({ _raw, ...t }) => t;
/** Trades and recorded skips in time order, newest first, filtered and capped. */
export function journalView(trades, skips, f = {}, { limit = 200 } = {}) {
  const list = filterTrades(trades, f).map((t) => ({ kind: 'trade', time: t.exit_time || t.entry_time, ...publicTrade(t) }));
  const skipped = f.include_skips === false || (f.execution_type && f.execution_type !== 'forward_paper') ? []
    : skips.filter((s) => (!f.strategy || lc(s.strategy).includes(lc(f.strategy))) && (!f.timeframe || s.timeframe === f.timeframe)
      && (!f.from || (s.trade_day && s.trade_day >= f.from)) && (!f.to || (s.trade_day && s.trade_day <= f.to))).map((s) => ({ kind: 'skipped', execution_type: 'forward_paper', ...s }));
  const all = [...list, ...skipped].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return { total: all.length, shown: Math.min(all.length, limit), entries: all.slice(0, limit) };
}

// ─── Audit ────────────────────────────────────────────────────────────────

const EPS = 0.011;
/**
 * Checks every stored record and reports real counts: duplicates, look-ahead, fills that disagree with
 * their own cost assumptions, missing labels, and P&L that does not add up. Nothing is changed.
 */
export function auditTrades(trades) {
  const by = {};
  for (const t of trades) by[t.execution_type] = (by[t.execution_type] || 0) + 1;
  const issues = { exact_duplicates: [], correlated_entries: [], look_ahead: [], exit_before_entry: [], fill_mismatch: [], missing_labels: [], pnl_mismatch: [] };
  const exact = new Map(); const entries = new Map();
  for (const t of trades) {
    const raw = t._raw || {};
    const ex = JSON.stringify([t.execution_type, t.strategy, t.variant, t.side, t.entry_time, t.exit_time, t.entry_price, t.exit_price, t.net, t.r]);
    if (exact.has(ex)) issues.exact_duplicates.push(t.id); else exact.set(ex, t.id);
    const en = [t.execution_type, t.symbol, t.timeframe, t.strategy, t.side, t.entry_time].join('|');
    entries.set(en, (entries.get(en) || 0) + 1);
    if (t.signal_time && t.entry_time && !(t.entry_time > t.signal_time)) issues.look_ahead.push(t.id);
    if (t.entry_basis && t.entry_basis !== 'next_bar_open') issues.look_ahead.push(t.id);
    if (t.exit_time && t.entry_time && t.exit_time < t.entry_time) issues.exit_before_entry.push(t.id);
    if (raw.entry && finite(raw.entry.raw) && finite(raw.entry.fill)) {
      const dir = t.side === 'short' ? -1 : 1;
      const expect = raw.entry.raw + dir * ((raw.entry.spread ?? 0) + (raw.entry.slippage ?? 0));
      if (Math.abs(expect - raw.entry.fill) > 1e-6) issues.fill_mismatch.push(t.id);
    }
    if (!t.data_label || !t.execution_type) issues.missing_labels.push(t.id);
    if (finite(t.gross) && finite(t.net) && raw.costs) {
      const c = raw.costs;
      if (Math.abs(t.gross - (c.spread ?? 0) - (c.slippage ?? 0) - (c.commissions ?? 0) - (c.fees ?? 0) - t.net) > EPS) issues.pnl_mismatch.push(t.id);
    }
  }
  for (const [k, n] of entries) if (n > 1) issues.correlated_entries.push(`${k} ×${n}`);
  const report = Object.fromEntries(Object.entries(issues).map(([k, list]) => [k, { count: [...new Set(list)].length, examples: [...new Set(list)].slice(0, 10) }]));
  const forwardUnique = new Set(trades.filter((t) => t.execution_type === 'forward_paper').map((t) => [t.symbol, t.timeframe, t.strategy, t.side, t.entry_time].join('|'))).size;
  return {
    totals: { records: trades.length, by_execution_type: by, forward_paper_unique_entries: forwardUnique },
    checks: report,
    notes: [
      'Correlated entries are the same entry bar traded by several filter or target variants of one strategy: they are kept, but they are not independent evidence.',
      'Look-ahead means a fill at or before its own signal bar, or a fill basis other than the next bar open.',
      'Fill mismatch means the recorded fill differs from its raw price plus the costs the record itself states.',
    ],
    altered: 0,
  };
}

// ─── Chart history: the stored research datasets, with provenance ─────────

/** Provenance a chart header shows for a stored dataset or the forward feed. */
export function provenanceOf({ dataType, source, delay = null, bars = [], manifest = null, tf }) {
  return {
    data_type: dataType, source, delay,
    coverage: { from: bars[0]?.t || manifest?.first || null, to: bars.at(-1)?.t || manifest?.last || null, bars: manifest?.bars ?? bars.length },
    gaps: manifest?.missing ?? null,
    gaps_note: manifest ? `${manifest.missing} expected CME bars are missing in the stored ${tf} series.` : 'Gaps are not measured for this feed.',
    checksum: manifest?.sha256 || null, fetched_at: manifest?.fetched_at || null, confidence: manifest?.confidence || null,
    verification: manifest ? 'stored dataset with checksum; candles are the provider\'s, never invented' : 'stored engine bars as received',
  };
}

export const UNAVAILABLE_TIMEFRAMES = Object.freeze({
  '15s': 'No 15-second history is reachable: the free sources start at 1-minute bars, and Rithmic in CHE is live-only.',
  '30s': 'No 30-second history is reachable: the free sources start at 1-minute bars, and Rithmic in CHE is live-only.',
});

// ─── Voice and typed requests ─────────────────────────────────────────────

const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chey|chay)[,:]?\s+)?/i;
/** "Show today's P&L", "who is the current leader", "audit the trades", "show daily evidence". Null otherwise. */
export function tradingVisualIntent(message) {
  const t = String(message || '').replace(/[’']/g, "'").replace(WAKE, '').trim().toLowerCase();
  if (/\b(?:today'?s?|daily|intraday)\s+(?:paper\s+)?(?:p\s*&\s*l|pnl|profit and loss)\b|\bhow\s+(?:much\s+)?(?:am\s+i|are\s+we|did\s+(?:we|i))\s+(?:up|down|make|made)\s+today\b/.test(t)) return { kind: 'pnl' };
  if (/\b(?:current|verified)\s+(?:strategy\s+)?leader\b|\bbest\s+verified\s+strategy\b|\bwho(?:'s|\s+is)\s+(?:the\s+)?leader\b/.test(t)) return { kind: 'leader' };
  if (/\baudit\b[\s\S]{0,30}\btrades?\b|\btrade\s+audit\b/.test(t)) return { kind: 'audit' };
  if (/\bdaily\s+evidence\b|\bevidence\s+(?:by|per)\s+day\b/.test(t)) return { kind: 'evidence' };
  // Card sizes on the Trading page: "expand the P&L card", "make the chart full screen", "compact view".
  const card = /\b(p\s*&\s*l|pnl|chart|evidence|leader|journal|replay|comparison|compare|audit)\s+(?:card|panel)\b|\b(?:the\s+)?(chart)\s+full[-\s]?screen\b|\bfull[-\s]?screen\s+(chart)\b/.exec(t);
  const size = /\bfull[-\s]?screen\b/.test(t) ? 'fullscreen' : /\b(?:expand|enlarge|maximi[sz]e|bigger|grow)\b/.test(t) ? 'expanded' : /\b(?:shrink|collapse|minimi[sz]e|compact|smaller)\b/.test(t) ? 'compact' : /\b(?:standard|normal|reset)\b/.test(t) ? 'standard' : null;
  if (/\bcompact\s+(?:trading\s+)?(?:dashboard|view|layout)\b/.test(t)) return { kind: 'card', card: 'all', size: 'compact' };
  if (card && size && /^(?:please\s+)?(?:expand|enlarge|maximi[sz]e|make|shrink|collapse|minimi[sz]e|compact|reset|show|open|put|full)\b/.test(t)) {
    const name = (card[1] || card[2] || card[3]).replace(/\s+/g, '').replace('pnl', 'p&l').replace('comparison', 'compare');
    return { kind: 'card', card: name === 'p&l' ? 'pnl' : name, size };
  }
  return null;
}

export const CARD_LABELS = Object.freeze({ pnl: 'P&L', chart: 'chart', evidence: 'daily evidence', leader: 'leader', journal: 'journal', replay: 'replay', compare: 'comparison', audit: 'audit', all: 'Trading' });
export function speakCard(intent) {
  const what = intent.card === 'all' ? 'every Trading card' : `the ${CARD_LABELS[intent.card] || intent.card} card`;
  return intent.size === 'fullscreen' ? `Opening ${intent.card === 'chart' ? 'the chart' : what} full screen.` : `Setting ${what} to ${intent.size}. It stays that way until you change it.`;
}

const money = (x) => (x == null ? 'not known' : `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toFixed(2)}`);
export function speakPnl(p) {
  return `Today's forward paper P&L, ${p.day}, on DELAYED MNQ data: realized ${money(p.realized)} from ${p.trades_closed} closed trade${p.trades_closed === 1 ? '' : 's'}, `
    + `unrealized ${money(p.unrealized)} on ${p.open_positions} open position${p.open_positions === 1 ? '' : 's'}, net ${money(p.net)}. `
    + `Costs: commissions and fees ${money(p.commissions)}, slippage and spread ${money(p.slippage)}. This is paper; live orders are disabled.`;
}
export function speakLeader(l) {
  if (l.leader) return `${l.headline} ${l.leader.forward.trades} forward paper trades, expectancy ${l.leader.forward.expectancy_r} R, profit factor ${l.leader.forward.profit_factor}.`;
  const p = l.provisional;
  return `No verified leader yet. ${p ? `Closest: ${p.strategy} on ${p.timeframe}, provisional, missing ${p.missing.join('; ')}.` : 'No strategy has forward paper trades yet.'} The rules: ${l.rules.join('; ')}.`;
}
export function speakAudit(a) {
  const c = a.checks;
  return `I audited ${a.totals.records} stored trade records (${Object.entries(a.totals.by_execution_type).map(([k, n]) => `${n} ${EXECUTION_TYPES[k]?.label || k}`).join(', ')}). `
    + `${a.totals.forward_paper_unique_entries} unique forward paper entries. Exact duplicates: ${c.exact_duplicates.count}. Correlated entries across variants: ${c.correlated_entries.count}. `
    + `Look-ahead: ${c.look_ahead.count}. Exit before entry: ${c.exit_before_entry.count}. Fill mismatches: ${c.fill_mismatch.count}. Missing labels: ${c.missing_labels.count}. P&L that does not add up: ${c.pnl_mismatch.count}. Nothing was changed.`;
}
export function speakEvidence(rows, today) {
  const todays = rows.filter((r) => r.trade_day === today);
  if (!rows.length) return 'No closed trades are recorded yet, so there is no daily evidence to show.';
  const list = (todays.length ? todays : rows.slice(0, 5)).slice(0, 6).map((r, i) => `${i + 1}. ${r.strategy} ${r.timeframe}, ${r.execution_label}, ${r.trade_day}: ${r.trades} trades, net ${r.unit === 'USD' ? money(r.net) : `${r.expectancy_r} R average`}, ${r.status}.`).join(' ');
  return `${todays.length ? 'Today' : 'Latest days'}: ${list}`;
}

/** Open forward paper positions, from the engine's portfolios. */
export async function openPositions(storage) {
  const portfolios = await readLivePortfolios(storage).catch(() => []);
  return portfolios.filter((pf) => pf.open).map((pf) => ({ portfolio: pf.key, strategy: pf.candidate, variant: `${pf.filter || 'any'}|${pf.params?.target_r ?? ''}R`,
    contract: pf.contract, qty: pf.qty, side: pf.open.side || 'long', entry_time: pf.open.entry_time, entry_price: num(pf.open.entry?.price), stop: num(pf.open.stop), target: num(pf.open.target), why: pf.open.signal_why || '' }));
}

/** The newest stored forward-engine bar (DELAYED), or null. */
export async function lastForwardBar(storage) {
  const feed = (await storage.get(LIVE_FEED)) || {};
  return Array.isArray(feed.bars) && feed.bars.length ? feed.bars.at(-1) : null;
}

const HISTORY_WINDOW = 600;
const MARKER_KIND = { historical_backtest: 'che_backtest', forward_paper: 'che_forward', daily_paper: 'che_forward', simulation: 'che_sim' };
/**
 * NQ or MNQ candles from the stored research datasets at any timeframe CHE has, with provenance, and the
 * stored trades on that market and timeframe as markers. `at` centres the window on a trade's time.
 * No data is fetched here and no candle is made up: a timeframe with no stored dataset says so.
 */
export async function historyChart(storage, { market = 'MNQ', tf = '5m', at = null, trades = null } = {}) {
  const m = ['NQ', 'MNQ'].includes(String(market).toUpperCase()) ? String(market).toUpperCase() : 'MNQ';
  const manifests = await datasetManifests(storage, m);
  const offered = Object.keys(manifests);
  const base = { ok: true, account: 'futures_history', account_label: `${m} history (stored research data)`, mode: 'HISTORICAL', symbol: m, timeframe: tf, timeframes: offered,
    unavailable_timeframes: { ...UNAVAILABLE_TIMEFRAMES }, live_orders: 'disabled', entries_allowed: false, market_orders_allowed: false,
    entries_blocked_reason: 'History is for study only: no order can be placed from it.' };
  if (!manifests[tf]) {
    return { ...base, state: 'no_data', bars: [], markers: [], feed: { provider: 'none', status: 'UNAVAILABLE', stale: true },
      provenance: provenanceOf({ dataType: 'historical', source: null, tf }),
      error: UNAVAILABLE_TIMEFRAMES[tf] || `No stored ${tf} ${m} dataset yet. Research fetches it when a job needs that timeframe; nothing is drawn until then.` };
  }
  const ds = await loadDataset(storage, m, tf);
  const all = ds?.bars || [];
  let end = all.length;
  if (at && Number.isFinite(Date.parse(at))) {
    const i = all.findIndex((b) => b.t >= new Date(Date.parse(at)).toISOString());
    end = i < 0 ? all.length : Math.min(all.length, i + Math.floor(HISTORY_WINDOW / 2));
  }
  const bars = all.slice(Math.max(0, end - HISTORY_WINDOW), end).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const from = bars[0]?.t; const to = bars.at(-1)?.t;
  const list = trades || (await readVisualTrades(storage)).trades;
  const markers = [];
  for (const t of list) {
    if (t.symbol !== m || t.timeframe !== tf || !from || t.entry_time < from || t.entry_time > to) continue;
    const base2 = { source: MARKER_KIND[t.execution_type] || 'che_forward', execution_type: t.execution_type, execution_label: t.execution_label, id: t.id, symbol: t.symbol, strategy: t.strategy, variant: t.variant, side: t.side, stop: t.stop, target: t.target, why: t.signal_why };
    markers.push({ ...base2, kind: 'entry', time: t.entry_time, price: t.entry_price, status: 'closed' });
    if (t.exit_time && t.exit_time <= to) markers.push({ ...base2, kind: 'exit', time: t.exit_time, price: t.exit_price, status: 'closed', reason: t.exit_reason, net_pnl: t.net, r: t.r });
  }
  return { ...base, state: 'verified', bars, markers: markers.sort((a, b) => String(a.time).localeCompare(String(b.time))),
    feed: { provider: ds.manifest.provider, status: 'HISTORICAL', last_bar_time: to || null, stale: false, delayed: true },
    provenance: provenanceOf({ dataType: 'historical', source: `${ds.manifest.provider} (${ds.manifest.symbol})`, delay: 'historical (public delayed source)', bars, manifest: ds.manifest, tf }),
    window: { from: from || null, to: to || null, of_total: all.length } };
}
