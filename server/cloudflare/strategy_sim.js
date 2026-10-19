// CHE strategy simulation: step (a) of the Strategy Simulation Room (owner brief, 2026-10-19).
//
// CHE runs ten rule-based strategies on paper trades, continuously. Each tick is deterministic
// code: no model call, no broker call, no order, no money. The Durable Object alarm runs a tick
// when it is due (worker.js tradingTick), next to the hourly learning tick (trading_lab.js).
//
// Minute bars, per symbol (MINUTE_FEEDS). Only these have real minute bars:
//   BTCUSDT, ETHUSDT  Binance public 1-minute candles (trading_lab.js loadCandles, interval 1m). Live.
//   MNQ               Yahoo Finance 1-minute bars of the continuous front month (market_feed.js
//                     loadIntraday, MNQ=F). Delayed CME data: research and paper evidence only.
//                     NQ is the same front month, so it is not simulated again: one feed per underlying.
//   ES, MES           No minute bars. Stooq (trading_lab.js) is daily only, so they are not simulated.
// A bar is used only once it has closed and was actually received. Nothing is filled in or invented.
//
// Paper fills: a signal on minute bar i becomes an order that fills at the open of bar i+1, but only
// when bar i+1 is the very next minute (otherwise it expires). Every fill pays one slippage unit
// against us, and each side pays a commission. An order that opens beyond its stop or target does
// not fill. Inside one bar a stop is checked before a target (the worst case).
//
// The rules are trading_lab.js rules (entry, prepare, the skill builder, stats) with fixed
// parameters, listed in SIM_STRATEGIES. Nothing is fitted here. The out-of-sample window is the
// newest share of the time watched, cut once per symbol at its first pass and never moved after.
import { loadCandles, prepare, prepareSession, stats, strategyById } from './trading_lab.js';
import { loadIntraday } from './market_feed.js';
import { wilsonInterval } from './trading_evidence.js';
import { ENVIRONMENTS } from './trading_environments.js';

export const SIM_ENVIRONMENT = 'paper';
export const STATE_KEY = 'strategy_sim_state';
export const TICK_MS = 60_000;
export const TRADE_CHUNK = 100;
export const TRADE_CAP = 5_000;
export const MIN_SAMPLE = 30;
// The newest 30% of the watched time is the out-of-sample window.
export const OOS_SHARE = 0.3;
// The first bars only warm up the indicators (the same 60 bars as trading_lab.js backtest).
const WARMUP_BARS = 60;
const NY_OPEN_MINUTE = 9 * 60 + 30;
const DUE_SLACK_MS = 5_000;
// Storage writes: a pass saves when a trade opens or closes, and otherwise at most once per heartbeat.
// Progress between saves is kept in memory and replayed deterministically after a restart (see readSimState).
export const HEARTBEAT_MS = 15 * 60_000;

// Costs are assumptions, stated here and in every output. Change them in code, not in a model.
// One feed per underlying: MNQ stands for the Nasdaq-100 front month. NQ (the same front month) is not a
// second feed, so the same bars can never count twice.
export const MINUTE_FEEDS = Object.freeze({
  BTCUSDT: {
    label: 'BTC/USD', kind: 'binance', session: 'utc', feed: 'Binance public 1-minute candles (live)',
    fee: { rate: 0.001 }, slip: { rate: 0.0002 },
  },
  ETHUSDT: {
    label: 'ETH/USD', kind: 'binance', session: 'utc', feed: 'Binance public 1-minute candles (live)',
    fee: { rate: 0.001 }, slip: { rate: 0.0002 },
  },
  MNQ: {
    label: 'Micro E-mini Nasdaq-100 (MNQ)', kind: 'yahoo', root: 'MNQ', session: 'et', tick: 0.25, pointValue: 2,
    feed: 'Yahoo Finance 1-minute bars, MNQ=F, delayed CME data (research only)',
    fee: { perSideUsd: 1 }, slip: { ticks: 1 },
  },
});

export const NOT_SIMULATED = Object.freeze([
  { symbols: ['NQ'], why: 'NQ is the same Nasdaq-100 front month as MNQ (Yahoo NQ=F and MNQ=F). It is simulated once, as MNQ, so identical bars never count twice.' },
  { symbols: ['ES', 'MES'], why: 'No minute bars in CHE. The stock and futures path (Stooq) is daily only, so these are not simulated.' },
]);

// Ten strategies. Each id is a trading_lab rule: "signal|trend filter|target in R". The rule
// functions are the same ones trading_lab.js uses; VWAP and the opening range are the two
// intraday signals added for minute bars.
export const SIM_STRATEGIES = Object.freeze([
  { id: 'channel-20|any|2', family: 'breakout', name: 'Breakout over the 20-bar high', signal: 'channel-20', trend_filter: 'any', target_r: 2 },
  { id: 'channel-55|above50|2', family: 'breakout', name: 'Breakout over the 55-bar high, above the 50-bar average', signal: 'channel-55', trend_filter: 'above50', target_r: 2 },
  { id: 'swing-breakout|above50|2', family: 'breakout', name: 'Breakout over the last swing high, above the 50-bar average', signal: 'swing-breakout', trend_filter: 'above50', target_r: 2 },
  { id: 'inside-bar-break|any|1.5', family: 'breakout', name: 'Breakout of an inside bar', signal: 'inside-bar-break', trend_filter: 'any', target_r: 1.5 },
  { id: 'rsi2-dip|any|1.5', family: 'mean reversion', name: 'Oversold dip (2-bar RSI under 10)', signal: 'rsi2-dip', trend_filter: 'any', target_r: 1.5 },
  { id: 'pullback-reversal|above50|2', family: 'mean reversion', name: 'Bullish reversal at the swing low, above the 50-bar average', signal: 'pullback-reversal', trend_filter: 'above50', target_r: 2 },
  { id: 'trend-cross|any|3', family: 'momentum', name: '20-bar average crosses above the 50-bar average', signal: 'trend-cross', trend_filter: 'any', target_r: 3 },
  { id: 'channel-20|rising20|1.5', family: 'momentum', name: 'Breakout over the 20-bar high while the 20-bar average rises', signal: 'channel-20', trend_filter: 'rising20', target_r: 1.5 },
  { id: 'vwap-reclaim|any|2', family: 'VWAP', name: 'Close back above the session VWAP', signal: 'vwap-reclaim', trend_filter: 'any', target_r: 2 },
  { id: 'opening-range|any|2', family: 'opening range', name: 'First close above the 15-minute opening range', signal: 'opening-range', trend_filter: 'any', target_r: 2 },
]);

const RULES = SIM_STRATEGIES.map((s) => {
  const rule = strategyById(s.id);
  if (!rule) throw new Error(`strategy ${s.id} is not a trading_lab rule`);
  return rule;
});

const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const pct = (x) => `${Math.round(x * 10000) / 100}%`;
const isFeed = (symbol) => Object.prototype.hasOwnProperty.call(MINUTE_FEEDS, symbol);

export function minuteFeedFor(symbol) {
  return isFeed(symbol) ? { symbol, ...MINUTE_FEEDS[symbol] } : null;
}

export function costText(feed) {
  if (feed.kind === 'binance') return `${pct(feed.fee.rate)} commission per side and ${pct(feed.slip.rate)} slippage per fill (assumed)`;
  return `$${feed.fee.perSideUsd.toFixed(2)} commission per side and one tick (${feed.slip.ticks * feed.tick} point) slippage per fill (assumed)`;
}

// Session of a bar time: UTC day for crypto, the New York day from 09:30 for index futures.
const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function sessionOf(kind, time) {
  const ms = Date.parse(time);
  if (!Number.isFinite(ms)) return null;
  if (kind === 'utc') {
    const d = new Date(ms);
    return { id: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute);
  if (mins < NY_OPEN_MINUTE) return null;
  return { id: `${p.year}-${p.month}-${p.day}`, minute: mins - NY_OPEN_MINUTE };
}

// Fills and costs, in price units. A percentage fee or slippage scales with the price.
const slipPrice = (feed, price) => (feed.slip.rate ? price * feed.slip.rate : feed.slip.ticks * feed.tick);
const feePoints = (feed, price) => (feed.fee.rate ? price * feed.fee.rate : feed.fee.perSideUsd / feed.pointValue);

// Only closed bars count. A bar is closed once its minute has ended (open time + 1 minute <= now).
export function closedBars(candles, now) {
  const byTime = new Map();
  for (const b of Array.isArray(candles) ? candles : []) {
    const t = Date.parse(b?.t);
    if (!Number.isFinite(t) || t + TICK_MS > now) continue;
    if (![b.o, b.h, b.l, b.c].every(Number.isFinite)) continue;
    byTime.set(t, { t: iso(t), o: b.o, h: b.h, l: b.l, c: b.c, v: Number(b.v) || 0 });
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}

// Reads one feed through the existing public market paths. Failure is reported, never filled in.
async function loadMinuteBars(symbol, { fetcher, now }) {
  const feed = MINUTE_FEEDS[symbol];
  if (feed.kind === 'binance') {
    const data = await loadCandles(symbol, { interval: '1m', fetcher });
    if (data.error) return { error: data.error };
    return { candles: data.candles, status: 'LIVE', source: feed.feed };
  }
  const data = await loadIntraday(feed.root, { fetcher, now, range: '1d', interval: '1m' });
  if (data.status === 'UNAVAILABLE' || !Array.isArray(data.candles)) return { error: data.error || 'feed unavailable' };
  return { candles: data.candles, status: data.status, source: feed.feed, delayed_by_min: data.delayed_by_min };
}

// ─── Orders and exits (one open position per strategy and symbol) ─────────

// A pending signal fills at the open of the next minute bar, or it expires.
function fillOrder(pend, bar, feed) {
  if (Date.parse(bar.t) - Date.parse(pend.signal_t) !== TICK_MS) return { expired: true, trade: null };
  const entryRaw = bar.o;
  const entry = entryRaw + slipPrice(feed, entryRaw);
  const risk = entryRaw - pend.stop;
  // Opened beyond the stop or the target: no fill, so no trade.
  if (!(risk > 0) || !(entry < pend.target)) return { expired: false, trade: null };
  return {
    expired: false,
    trade: {
      id: `${pend.strategy}|${pend.symbol}|${bar.t}`, strategy: pend.strategy, symbol: pend.symbol, label: feed.label,
      params: pend.params, why: pend.why, signal_t: pend.signal_t, signal_price: pend.signal_price,
      entry_t: bar.t, entry_raw: entryRaw, entry, stop: pend.stop, target: pend.target, feed: pend.feed,
    },
  };
}

// The stop is checked before the target inside a bar. A bar that opens beyond a level fills at the open.
function exitOn(pos, bar) {
  if (bar.l <= pos.stop) return { raw: Math.min(pos.stop, bar.o), reason: 'stop' };
  if (bar.h >= pos.target) return { raw: Math.max(pos.target, bar.o), reason: 'target' };
  return null;
}

function closeTrade(pos, exit, bar, feed) {
  const exitPx = exit.raw - slipPrice(feed, exit.raw);
  const risk = pos.entry_raw - pos.stop;
  const fees = feePoints(feed, pos.entry) + feePoints(feed, exitPx);
  const rGross = (exit.raw - pos.entry_raw) / risk;
  const r = (exitPx - pos.entry - fees) / risk;
  return { ...pos, exit_t: bar.t, exit_raw: exit.raw, exit: exitPx, exit_reason: exit.reason, r_gross: rGross, r, cost_r: rGross - r };
}

// The out-of-sample cut, frozen at the symbol's first pass: 70% of that first window is in sample.
function frozenCut(bars) {
  const a = Date.parse(bars[WARMUP_BARS].t);
  const b = Date.parse(bars[bars.length - 1].t);
  return iso(a + (1 - OOS_SHARE) * (b - a));
}

// Runs every strategy over the bars not yet processed for one symbol. Returns the closed trades.
// isPaused is checked before each bar and before every open, so a pause stops new trades at once.
function runBars(state, symbol, bars, ctx, feed, status, isPaused = () => false) {
  const closed = [];
  let opened = 0;
  const sym = state.symbols[symbol];
  const lastT = sym.last_t ? Date.parse(sym.last_t) : -Infinity;
  for (let j = 0; j < bars.length; j++) {
    if (isPaused()) break;
    const bar = bars[j];
    if (Date.parse(bar.t) <= lastT) continue;
    if (j < WARMUP_BARS) { sym.last_t = bar.t; continue; }
    if (!sym.first_t) sym.first_t = bar.t;
    if (!sym.oos_from) sym.oos_from = frozenCut(bars);
    sym.bars += 1;
    state.counts.bars += 1;
    SIM_STRATEGIES.forEach((s, k) => {
      if (isPaused()) return;
      const key = `${s.id}|${symbol}`;
      let pos = state.open[key];
      const pend = state.pending[key];
      if (pend && !pos) {
        delete state.pending[key];
        const fill = fillOrder(pend, bar, feed);
        if (fill.expired) state.counts.expired += 1;
        else if (!fill.trade) state.counts.not_filled += 1;
        else { pos = fill.trade; state.open[key] = pos; opened += 1; }
      }
      if (pos) {
        const exit = exitOn(pos, bar);
        if (exit) {
          closed.push(closeTrade(pos, exit, bar, feed));
          delete state.open[key];
          return; // as in trading_lab backtest: no new signal on the bar that closed a trade
        }
      }
      if (state.open[key] || state.pending[key]) return;
      const setup = RULES[k].entry(bars, j, ctx);
      if (setup && setup.stop < setup.entry) {
        state.pending[key] = {
          strategy: s.id, symbol, signal_t: bar.t, signal_price: setup.entry, stop: setup.stop, target: setup.target,
          why: setup.why, params: { signal: s.signal, trend_filter: s.trend_filter, target_r: s.target_r }, feed: status,
        };
      }
    });
    sym.last_t = bar.t;
  }
  return { closed, opened };
}

// ─── State and storage (trades are kept in chunks, each well under the storage value limit) ───

const chunkKey = (n) => `strategy_sim_trades:${n}`;

function freshState() {
  return {
    version: 1, paused: false, paused_at: null, resumed_at: null, last_tick: null, saved_at: null, ticks: 0, last_paused_marker: null,
    symbols: {}, open: {}, pending: {},
    counts: { bars: 0, not_filled: 0, expired: 0, errors: 0 },
    trades: { first: 0, last: -1, tail: 0, stored: 0, dropped: 0 },
    spend: { ceiling_usd: 0, day: null, spent_usd: 0 },
  };
}

// The live state of each storage object. Between saves the newest progress lives here. A restart reloads the
// last save and replays the bars after it: the same trades, because a pass writes its closed trades and the
// state that records them in one storage write, so a restart never sees a close without its state (no repeat).
const live = new WeakMap();

export async function readSimState(storage) {
  if (live.has(storage)) return live.get(storage);
  const base = freshState();
  const saved = await storage.get(STATE_KEY);
  const s = saved && typeof saved === 'object' ? saved : {};
  const state = {
    ...base, ...s,
    symbols: s.symbols || {}, open: s.open || {}, pending: s.pending || {},
    counts: { ...base.counts, ...(s.counts || {}) },
    trades: { ...base.trades, ...(s.trades || {}) },
    spend: { ...base.spend, ...(s.spend || {}) },
  };
  live.set(storage, state);
  return state;
}

// The one place the state is saved on its own. A pass saves through commitSim, which writes the trades with it.
async function saveSimState(storage, state, now = Date.now()) {
  state.saved_at = iso(now);
  await storage.put(STATE_KEY, state);
}

// The trade chunk writes for one pass, computed but not yet written: the newest chunk is appended to, a full chunk
// starts the next one, and the oldest chunk is dropped when the cap is passed (its trades are counted).
async function tradeWrites(storage, meta, trades, { cap = TRADE_CAP, chunk = TRADE_CHUNK } = {}) {
  const puts = {};
  const deletes = [];
  let current = null;
  for (const t of trades) {
    if (meta.last < meta.first || meta.tail >= chunk) {
      if (current) puts[chunkKey(meta.last)] = current;
      meta.last += 1;
      meta.tail = 0;
      current = [];
    }
    if (!current) current = (await storage.get(chunkKey(meta.last))) || [];
    current.push(t);
    meta.tail += 1;
    meta.stored += 1;
  }
  if (current) puts[chunkKey(meta.last)] = current;
  while (meta.stored > cap && meta.last >= meta.first) {
    // The oldest chunk may still be a pending write of this pass: count what it holds, then never write it.
    const key = chunkKey(meta.first);
    const old = puts[key] || (await storage.get(key)) || [];
    delete puts[key];
    deletes.push(key);
    meta.first += 1;
    meta.stored -= old.length;
    meta.dropped += old.length;
  }
  return { puts, deletes };
}

// One storage write for a pass: the closed trades' chunks and the state, together and atomically. Chunks that
// the cap drops are deleted after that write. Without force, a pass with nothing to save writes nothing.
async function commitSim(storage, state, closed, now, { cap = TRADE_CAP, chunk = TRADE_CHUNK, force = false } = {}) {
  const { puts, deletes } = await tradeWrites(storage, state.trades, closed, { cap, chunk });
  if (!force) return false;
  state.saved_at = iso(now);
  await storage.put({ ...puts, [STATE_KEY]: state });
  for (const key of deletes) await storage.delete(key);
  return true;
}

// Appends closed trades under the cap, as one write. Kept for callers that only need the trade store.
export async function storeTrades(storage, meta, trades, opts = {}) {
  const { puts, deletes } = await tradeWrites(storage, meta, trades, opts);
  if (Object.keys(puts).length) await storage.put(puts);
  for (const key of deletes) await storage.delete(key);
  return meta;
}

export async function readStoredTrades(storage, meta) {
  const out = [];
  for (let c = meta.first; c <= meta.last; c++) out.push(...((await storage.get(chunkKey(c))) || []));
  return out;
}

// ─── Spend ceiling: read and enforced at every tick, even though no model is called ───

export function spendToday(state, now = Date.now()) {
  const day = dayOf(now);
  return state.spend.day === day ? state.spend : { ...state.spend, day, spent_usd: 0 };
}

// planned: dollars a step expects to spend. Refused when the day's spend would pass the ceiling.
export function assertSpend(spend, plannedUsd = 0) {
  if (!(spend.spent_usd + plannedUsd <= spend.ceiling_usd)) {
    return { allowed: false, reason: `daily spend ceiling of $${spend.ceiling_usd} would be passed ($${spend.spent_usd} spent today)` };
  }
  return { allowed: true, reason: 'within the daily spend ceiling' };
}

/** Adds spend to today's ledger and saves it. Nothing calls this yet: no model call exists in this step. */
export async function chargeSpend(storage, usd, now = Date.now()) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return { ok: false, detail: 'A spend charge must be a non-negative dollar amount.' };
  const state = await readSimState(storage);
  state.spend = { ...spendToday(state, now) };
  state.spend.spent_usd += usd;
  await saveSimState(storage, state, now);
  return { ok: true, spent_usd: state.spend.spent_usd, ceiling_usd: state.spend.ceiling_usd, day: state.spend.day, within_ceiling: assertSpend(state.spend, 0).allowed };
}

// ─── The tick ─────────────────────────────────────────────────────────────

// Paper only: this simulation has no path to an order. Refuses if the environment ever changes.
function assertPaperOnly() {
  const env = ENVIRONMENTS[SIM_ENVIRONMENT];
  if (!env || env.submitsOrders || env.moneyAtRisk) throw new Error('strategy simulation must run in the paper environment');
}

/** One minute pass, from the alarm. Does nothing when not due, paused, or over the spend ceiling. */
export async function strategySimTick(storage, { fetcher = fetch, now = Date.now(), force = false, loaders = {}, cap = TRADE_CAP, chunk = TRADE_CHUNK } = {}) {
  const state = await readSimState(storage);
  if (!force && state.last_tick && now - Date.parse(state.last_tick) < TICK_MS - DUE_SLACK_MS) {
    return { ran: false, skipped: 'not due', next_at: iso(Date.parse(state.last_tick) + TICK_MS) };
  }
  // Kill switch: checked here, and again after every await below. A paused tick does nothing and records a marker.
  if (state.paused) {
    if (!state.last_paused_marker) {
      state.last_paused_marker = { at: iso(now), note: 'Paused by the owner: no bars read, no trades, no spend.' };
      await saveSimState(storage, state, now);
    }
    return { ran: false, paused: true, at: iso(now) };
  }
  state.spend = spendToday(state, now);
  const spendCheck = assertSpend(state.spend, 0);
  if (!spendCheck.allowed) {
    if (!state.last_paused_marker) {
      state.last_paused_marker = { at: iso(now), note: spendCheck.reason };
      await saveSimState(storage, state, now);
    }
    return { ran: false, blocked: spendCheck.reason, at: iso(now) };
  }
  assertPaperOnly();
  state.last_tick = iso(now);
  state.ticks += 1;
  const halted = () => state.paused;
  const report = {};
  const closed = [];
  let opened = 0;
  for (const symbol of Object.keys(MINUTE_FEEDS)) {
    if (halted()) break;
    const feed = MINUTE_FEEDS[symbol];
    const load = loaders[symbol] || ((sym) => loadMinuteBars(sym, { fetcher, now }));
    state.symbols[symbol] ||= { first_t: null, last_t: null, bars: 0, feed: null, error: null };
    const sym = state.symbols[symbol];
    let data;
    try { data = await load(symbol); } catch (_) { data = { error: 'the feed did not answer' }; }
    // The owner may pause while a feed loads: nothing from that feed is used after the pause.
    if (halted()) break;
    if (data.error) {
      sym.error = String(data.error).slice(0, 160);
      sym.feed = { status: 'UNAVAILABLE', source: feed.feed, last_bar_t: null, delayed_by_min: null };
      state.counts.errors += 1;
      report[symbol] = { error: sym.error };
      continue;
    }
    sym.error = null;
    const bars = closedBars(data.candles, now);
    sym.feed = { status: data.status, source: data.source || feed.feed, last_bar_t: bars.length ? bars[bars.length - 1].t : null, delayed_by_min: data.delayed_by_min ?? null };
    if (!bars.length) { report[symbol] = { new_bars: 0, status: data.status }; continue; }
    const ctx = { ...prepare(bars), ...prepareSession(bars, (t) => sessionOf(feed.session, t)) };
    const before = sym.bars;
    const { closed: made, opened: filled } = runBars(state, symbol, bars, ctx, feed, data.status, halted);
    closed.push(...made);
    opened += filled;
    report[symbol] = { new_bars: sym.bars - before, status: data.status, closed: made.length, opened: filled };
  }
  if (halted()) {
    // Paused during this pass: what finished before the pause is saved, and nothing was opened after it.
    state.last_paused_marker = { at: iso(now), note: 'Paused by the owner during a pass: no bars used and no trade opened after the pause.' };
    await commitSim(storage, state, closed, now, { cap, chunk, force: true });
    return { ran: false, paused: true, halted: true, closed: closed.length, opened, at: iso(now) };
  }
  state.last_paused_marker = null;
  // A trade that opened or closed is saved with the state that records it. Anything else waits for the heartbeat.
  const heartbeat = !state.saved_at || now - Date.parse(state.saved_at) >= HEARTBEAT_MS;
  const written = opened > 0 || closed.length > 0 || heartbeat;
  await commitSim(storage, state, closed, now, { cap, chunk, force: written });
  return { ran: true, at: iso(now), closed: closed.length, opened, saved: written, symbols: report, stored: state.trades.stored, dropped: state.trades.dropped };
}

/** Read only: whether the minute pass is due now, for the alarm's minute-only path. */
export async function strategySimWake(storage, now = Date.now()) {
  const state = await readSimState(storage);
  if (state.paused || !state.last_tick) return { due: false, at: null };
  const at = Date.parse(state.last_tick) + TICK_MS;
  return { due: at <= now + DUE_SLACK_MS, at };
}

/**
 * When the next minute tick is due (ms), or null while paused or before the first pass. The alarm takes
 * the earliest of this and the other trading ticks. Before the first pass nothing is armed here: the
 * first pass runs on the next alarm the hourly tick already keeps, so existing alarm times do not move.
 */
export async function nextStrategySimTickAt(storage, now = Date.now()) {
  const state = await readSimState(storage);
  if (state.paused || !state.last_tick) return null;
  const last = Date.parse(state.last_tick);
  return Number.isFinite(last) ? Math.max(now + 250, last + TICK_MS) : null;
}

// ─── Owner controls ───────────────────────────────────────────────────────

export async function setStrategySimPaused(storage, paused, now = Date.now()) {
  const state = await readSimState(storage);
  state.paused = Boolean(paused);
  if (paused) state.paused_at = iso(now);
  else state.resumed_at = iso(now);
  state.last_paused_marker = null;
  await saveSimState(storage, state, now);
  return { paused: state.paused, paused_at: state.paused_at, resumed_at: state.resumed_at };
}

export async function setStrategySimCeiling(storage, usd, now = Date.now()) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > 1000) return { ok: false, detail: 'The daily spend ceiling must be a dollar amount from 0 to 1000.' };
  const state = await readSimState(storage);
  state.spend = { ...spendToday(state, now), ceiling_usd: usd };
  await saveSimState(storage, state, now);
  return { ok: true, ceiling_usd: usd, spent_usd: state.spend.spent_usd, day: state.spend.day };
}

// ─── Leaderboard: every number is computed from the stored trades ──────────

/** Out-of-sample cut per symbol, frozen at the symbol's first pass. Bars watched later never move it. */
export function oosCuts(symbols) {
  const cuts = {};
  for (const [symbol, sym] of Object.entries(symbols || {})) {
    const first = Date.parse(sym.first_t || '');
    const cut = Date.parse(sym.oos_from || '');
    const last = Date.parse(sym.last_t || '');
    if (Number.isFinite(first) && Number.isFinite(cut) && Number.isFinite(last)) cuts[symbol] = { from: first, to: last, cut };
  }
  return cuts;
}

const isOos = (t, cuts) => Boolean(cuts[t.symbol]) && Date.parse(t.entry_t) >= cuts[t.symbol].cut;

/** Trades, wins, losses, Wilson 95%, expectancy after costs, drawdown, and the break-even win rate. */
export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0);
  const losses = n - wins.length;
  const sumR = trades.reduce((sum, t) => sum + t.r, 0);
  const winR = wins.reduce((sum, t) => sum + t.r, 0);
  const lossR = trades.filter((t) => !(t.r > 0)).reduce((sum, t) => sum - t.r, 0);
  const avgWin = wins.length ? winR / wins.length : 0;
  const avgLoss = losses ? lossR / losses : 0;
  // Win rate at which the average win and loss, after costs, give zero expectancy.
  const breakEven = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 1;
  const w = wilsonInterval(wins.length, n);
  const ordered = [...trades].sort((a, b) => (Date.parse(a.exit_t) - Date.parse(b.exit_t)) || a.id.localeCompare(b.id));
  const drawdown = stats(ordered.map((t) => ({ r: t.r }))).max_drawdown_r;
  return {
    n, wins: wins.length, losses,
    win_rate: n ? wins.length / n : 0,
    wilson_low: w.low, wilson_high: w.high,
    expectancy_r: n ? sumR / n : 0,
    total_r: sumR, max_drawdown_r: drawdown,
    avg_win_r: avgWin, avg_loss_r: avgLoss, break_even_win_rate: breakEven,
  };
}

/**
 * The only rule for the word "profitable". Out-of-sample expectancy after costs must be above zero,
 * the 95% Wilson lower bound of the win rate must be above break-even, and the sample at least 30.
 * Anything else is "not proven yet", with the reasons.
 */
export function profitLabel(oos) {
  const reasons = [];
  if (!(oos.n >= MIN_SAMPLE)) reasons.push(`sample ${oos.n} out-of-sample trades, need ${MIN_SAMPLE}`);
  if (!(oos.expectancy_r > 0)) reasons.push(`out-of-sample expectancy after costs is ${oos.expectancy_r.toFixed(3)} R, not above 0`);
  if (!(oos.wilson_low > oos.break_even_win_rate)) reasons.push(`Wilson 95% lower bound ${pct(oos.wilson_low)} is not above break-even ${pct(oos.break_even_win_rate)}`);
  return { label: reasons.length ? 'not proven yet' : 'profitable', reasons };
}

export function leaderboard(trades, symbols) {
  const cuts = oosCuts(symbols);
  // One feed per underlying: a trade on a symbol that is not a minute feed (NQ, the same front month as MNQ) never adds a sample.
  const counted = trades.filter((t) => isFeed(t.symbol));
  const rows = SIM_STRATEGIES.map((s) => {
    const mine = counted.filter((t) => t.strategy === s.id);
    const oosTrades = mine.filter((t) => isOos(t, cuts));
    const all = summarize(mine);
    const oos = summarize(oosTrades);
    const verdict = profitLabel(oos);
    return {
      id: s.id, name: s.name, family: s.family, bars: '1-minute bars', params: { signal: s.signal, trend_filter: s.trend_filter, target_r: s.target_r },
      trades: all.n, wins: all.wins, losses: all.losses, win_rate: all.win_rate,
      wilson_95: { low: all.wilson_low, high: all.wilson_high },
      expectancy_r: all.expectancy_r, max_drawdown_r: all.max_drawdown_r,
      sample_size: oos.n, out_of_sample: { flag: 'after the frozen cut (70% of the first window is in sample)', wins: oos.wins, losses: oos.losses, win_rate: oos.win_rate, wilson_95: { low: oos.wilson_low, high: oos.wilson_high }, expectancy_r: oos.expectancy_r, break_even_win_rate: oos.break_even_win_rate },
      label: verdict.label, reasons: verdict.reasons,
    };
  });
  return rows.sort((a, b) => (a.label === b.label ? b.out_of_sample.expectancy_r - a.out_of_sample.expectancy_r : a.label === 'profitable' ? -1 : 1));
}

/** The owner view: status, minute bars per symbol, the leaderboard and the newest trades. Read only. */
export async function strategySimView(storage, { now = Date.now() } = {}) {
  const state = await readSimState(storage);
  const trades = await readStoredTrades(storage, state.trades);
  const cuts = oosCuts(state.symbols);
  return {
    basis: 'Paper trades on 1-minute bars (see minute_bars for each source). Costs as listed.',
    paper_only: true, environment: SIM_ENVIRONMENT, model_calls: 0, broker_calls: 0,
    status: state.paused ? 'paused' : 'running', paused_at: state.paused_at, resumed_at: state.resumed_at,
    last_tick: state.last_tick, ticks: state.ticks, last_paused_marker: state.last_paused_marker,
    minute_bars: Object.entries(MINUTE_FEEDS).map(([symbol, feed]) => {
      const sym = state.symbols[symbol] || {};
      return {
        symbol, label: feed.label, bars: '1-minute bars', source: feed.feed, status: sym.feed?.status || 'waiting for the first tick',
        last_bar: sym.feed?.last_bar_t || null, bars_processed: sym.bars || 0, error: sym.error || null, costs: costText(feed),
      };
    }),
    not_simulated: NOT_SIMULATED,
    oos_windows: Object.fromEntries(Object.entries(cuts).map(([symbol, c]) => [symbol, { from: iso(c.from), out_of_sample_from: iso(c.cut), to: iso(c.to) }])),
    leaderboard: leaderboard(trades, state.symbols),
    trades: { stored: state.trades.stored, dropped: state.trades.dropped, cap: TRADE_CAP, bars: '1-minute bars', newest: trades.slice(-20).reverse() },
    counts: state.counts,
    spend: spendToday(state, now),
    notes: [
      'Paper only. No order, broker or model call. Real money needs your separate approval.',
      'Minute bars only where listed. Stooq daily data is never shown as minute data.',
      'Fills: the open of the next minute plus one slippage unit against us; commissions as listed. A signal with no next minute bar expires unfilled.',
      'The out-of-sample window starts at a frozen cut: 70% of the first window is in sample and every later trade is out of sample. Parameters are fixed, not fitted, in this step.',
      'Profitable needs 30 out-of-sample trades, positive expectancy after costs, and a 95% Wilson lower bound above break-even. Otherwise: not proven yet.',
    ],
  };
}

// ─── Typed and spoken requests (the /trade-sim command sends "Strategy simulation <action>") ───

// Deterministic. Pause and resume need the command form or an imperative; a question about the simulation is a status read.
export function strategySimIntent(message) {
  const text = String(message || '').replace(/[’']/g, "'").trim();
  if (!/\bstrateg(?:y|ies)\s+simulation\b/i.test(text)) return null;
  const command = /\bstrateg(?:y|ies)\s+simulation\s+(pause|resume|status)\s*$/i.exec(text);
  if (command) return { kind: command[1].toLowerCase() };
  const imperative = /^\s*(?:please\s+)?(pause|stop|halt|freeze|resume|restart|unpause|start)\s+(?:the\s+)?strateg(?:y|ies)\s+simulation\b/i.exec(text);
  if (imperative) return { kind: /^(?:pause|stop|halt|freeze)$/i.test(imperative[1]) ? 'pause' : 'resume' };
  return { kind: 'status' };
}

/** Said aloud and shown as large text: status, minute-bar sources, the leaderboard count and the spend. */
export function speakStrategySim(view) {
  const profitable = view.leaderboard.filter((r) => r.label === 'profitable').length;
  const dropped = view.trades.dropped ? `, ${view.trades.dropped} oldest dropped by the cap` : '';
  return [
    `The strategy simulation is ${view.status}. Paper only: no money and no model call.`,
    `Minute bars: ${view.minute_bars.map((b) => `${b.symbol} ${b.status}`).join(', ')}. ES and MES have no minute bars and are not simulated.`,
    `${view.trades.stored} trades stored${dropped}. Strategies profitable: ${profitable} of ${view.leaderboard.length}; the rest are not proven yet.`,
    `Daily spend ceiling $${view.spend.ceiling_usd}; spent today $${view.spend.spent_usd}.`,
  ].join('\n');
}
