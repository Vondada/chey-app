// CHE trading research (owner, 2026-10-22): which strategy works best on which market, timeframe, session and
// regime, with what risk and how much evidence. A layer over the existing engine, never a second one:
//   execution, fills, costs, stats, walk-forward  trading_evidence.js (stepPortfolio, summarize, evaluateWalkForward)
//   strategies                                    trading_evidence.js INTRADAY_CANDIDATES and CANDIDATES (written rules)
//   daily datasets with provenance                historical_intelligence.js (MNQ=F, NQ=F, ^NDX labelled proxy)
//   upward resampling                             backtest_matrix.js resample / calendarBars
//   forward paper (PAPER)                         trading_live.js on the Worker alarm, with trading_controls.js gates
//   delayed training (FORWARD_SIM)                trading_delayed_training.js
// What is new here: one canonical timeframe engine (15s … 1M, upward only), dataset acquisition with full provenance,
// roll handling, evidence buckets per strategy × market × timeframe × session × regime × mode, regime and session
// classifiers, walk-forward train/OOS separation, cost profiles, Monte Carlo and parameter sensitivity, the selector
// with champion/challenger and NO TRADE, readiness, resumable research jobs with an evidence cache, and migration of
// the existing journals. Everything per bar is deterministic code: no model is called anywhere in this file.
// Nothing here can place an order: research portfolios are 'backtest' or 'paper' sources, which newPortfolio
// refuses to change, and no broker module is imported. No readiness level authorizes live trading.
import {
  CANDIDATES, CONTRACTS, COSTS, INTRADAY_CANDIDATES, INTRADAY_COMMON_RULES, MIN_TRADES, causalContext, candleProblems,
  etParts, evaluateWalkForward, intradayContext, newPortfolio, readTrades, stepPortfolio, strategyVersion, summarize,
  tradeDayOf, tradeMins,
} from './trading_evidence.js';
import { calendarBars, resample } from './backtest_matrix.js';
import { canonicalBars, leakageAudit, sha256Hex } from './historical_intelligence.js';
import { parseYahooChart } from './market_feed.js';

export const RESEARCH_VERSION = 'research-1';
export const MIN_CLOSED_TRADES = 30;          // per evidence bucket (strategy × market × timeframe × mode), never in total
export const MARKETS = Object.freeze(['MNQ', 'NQ']);
export const MODES = Object.freeze(['BACKTEST', 'FORWARD_SIM', 'PAPER']);
const STATE_KEY = 'trd_state';
const DS_PREFIX = 'trd_ds:';
const EV_PREFIX = 'trd_ev:';
const RECEIPTS_KEY = 'trd_receipts';
const BRAIN_KEY = 'trd_brain';
const CHUNK_BARS = 1200;                      // ≈ 90 KB a key: a Durable Object value is limited to 128 KB
const KEEP_TRADES = 400;                      // compact trades kept per bucket for recomputation
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const iso = (ms) => new Date(ms).toISOString();

// ─── Timeframes: one canonical engine, upward aggregation only ───────────────

export const TIMEFRAMES = Object.freeze([
  { id: '15s', ms: 15_000, label: '15 seconds' },
  { id: '30s', ms: 30_000, label: '30 seconds' },
  { id: '1m', ms: MIN, label: '1 minute' },
  { id: '2m', ms: 2 * MIN, label: '2 minutes' },
  { id: '5m', ms: 5 * MIN, label: '5 minutes' },
  { id: '15m', ms: 15 * MIN, label: '15 minutes' },
  { id: '30m', ms: 30 * MIN, label: '30 minutes' },
  { id: '1h', ms: HOUR, label: '1 hour' },
  { id: '4h', ms: 4 * HOUR, label: '4 hours' },
  { id: '1D', ms: DAY, label: 'daily', calendar: 'day' },
  { id: '1W', ms: 7 * DAY, label: 'weekly', calendar: 'week' },
  { id: '1M', ms: 30 * DAY, label: 'monthly', calendar: 'month' },
]);
export const TF_IDS = Object.freeze(TIMEFRAMES.map((t) => t.id));
export const tfOf = (id) => TIMEFRAMES.find((t) => t.id === id) || null;
const rank = (id) => TF_IDS.indexOf(id);
export const isIntraday = (id) => rank(id) >= 0 && rank(id) < rank('1D');

/** Can `to` bars be built from `from` bars? Only upward, and only when the bucket is a whole number of base bars. */
export function canAggregate(from, to) {
  const a = tfOf(from); const b = tfOf(to);
  if (!a || !b || rank(to) < rank(from)) return false;
  if (from === to) return true;
  if (b.calendar === 'week' || b.calendar === 'month') return from === '1D';
  if (b.calendar === 'day') return isIntraday(from);
  return b.ms % a.ms === 0;
}

// CME equity-index holidays (New York calendar days the exchange is closed, or closes early at 13:00 New York).
// Computed, so DST and moving holidays are right every year; a day not listed trades normally.
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
const nthWeekday = (y, m, wd, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); };
const lastWeekday = (y, m, wd) => { const last = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7)); };
const observed = (ms) => { const wd = new Date(ms).getUTCDay(); return wd === 6 ? ms - DAY : wd === 0 ? ms + DAY : ms; };
const ymd = (ms) => iso(ms).slice(0, 10);
export function cmeCalendar(year) {
  const closed = new Set([ymd(observed(Date.UTC(year, 0, 1))), ymd(easter(year) - 2 * DAY), ymd(observed(Date.UTC(year, 11, 25)))]);
  const early = new Set([
    ymd(nthWeekday(year, 0, 1, 3)), ymd(nthWeekday(year, 1, 1, 3)), ymd(lastWeekday(year, 4, 1)), ymd(observed(Date.UTC(year, 5, 19))),
    ymd(observed(Date.UTC(year, 6, 4))), ymd(nthWeekday(year, 8, 1, 1)), ymd(nthWeekday(year, 10, 4, 4) + DAY),
  ]);
  return { closed, early };
}
/** Is the CME equity-index market open at this instant (weekly hours, daily break, holidays)? */
export function cmeOpen(time) {
  const ms = typeof time === 'number' ? time : Date.parse(time);
  const { day, mins } = etFast(ms);
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (wd === 6) return false;
  if (wd === 0) return mins >= 18 * 60;
  if (wd === 5 && mins >= 17 * 60) return false;
  if (mins >= 17 * 60 && mins < 18 * 60) return false;
  const cal = cmeCalendar(Number(day.slice(0, 4)));
  if (cal.closed.has(day) && mins < 18 * 60) return false;
  if (cal.early.has(day) && mins >= 13 * 60 && mins < 18 * 60) return false;
  return true;
}

// New York day and minute of an instant, cached per UTC hour (US offsets are whole hours, so the minutes inside an
// hour follow directly). Exact across DST: each hour is converted by the time-zone database once.
const ET_HOURS = new Map();
function etFast(ms) {
  const hk = Math.floor(ms / HOUR);
  let base = ET_HOURS.get(hk);
  if (!base) { base = etParts(hk * HOUR); if (ET_HOURS.size > 50_000) ET_HOURS.clear(); ET_HOURS.set(hk, base); }
  return { day: base.day, mins: base.mins + Math.floor((ms - hk * HOUR) / MIN) };
}
function tradeDayFast(ms) {
  const { day, mins } = etFast(ms);
  if (mins < 1080) return day;
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds `to` bars from `from` bars. Refuses a downward request: a shorter bar can never be made from longer bars.
 * Intraday buckets up to an hour are clock-aligned and complete only when every base bar the market was open for was
 * received; 4-hour buckets are anchored to the CME day (18:00 New York); daily bars are CME trading days; weekly and
 * monthly come from daily bars and leave out the period still forming.
 */
export function aggregateBars(bars, from, to, { now = Date.now() } = {}) {
  if (!tfOf(from) || !tfOf(to)) throw new RangeError(`unknown timeframe ${from} or ${to}`);
  if (rank(to) < rank(from)) throw new RangeError(`refused: ${to} bars cannot be built from ${from} bars (no downward resampling; that would invent prices)`);
  if (!canAggregate(from, to)) throw new RangeError(`refused: ${to} is not a whole number of ${from} bars`);
  if (from === to) return bars.slice();
  const target = tfOf(to); const base = tfOf(from);
  if (target.calendar === 'week' || target.calendar === 'month') {
    // The last period counts only if the data reaches its end: a month the series stops inside is not a monthly bar.
    const out = calendarBars(bars, target.calendar, now);
    const lastBar = bars.at(-1);
    const end = (b) => { const d = new Date(b.t); return target.calendar === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : Date.parse(b.t) + 7 * DAY; };
    if (out.length && lastBar && Date.parse(lastBar.t) + 4 * DAY < end(out.at(-1))) out.pop();
    return out;
  }
  if (target.calendar === 'day' || to === '4h') {
    const key = (b) => { const ms = Date.parse(b.t); return to === '4h' ? `${tradeDayFast(ms)}#${Math.floor(tradeMins(etFast(ms).mins) / 240)}` : tradeDayFast(ms); };
    const groups = new Map();
    for (const b of bars) {
      const k = key(b);
      const g = groups.get(k);
      if (!g) groups.set(k, { k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: Number(b.v) || 0, n: 1, first: Date.parse(b.t), last: Date.parse(b.t) });
      else { g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += Number(b.v) || 0; g.n += 1; g.last = Date.parse(b.t); }
    }
    const out = [];
    for (const g of groups.values()) {
      // Complete only when the base bars cover every slot the market was open in the bucket (holidays, the daily
      // break and weekends are not slots), and only once the bucket has ended: a forming bar is never used.
      const span = to === '4h' ? 4 * HOUR : DAY;
      const start = to === '4h' ? g.first - (tradeMins(etFast(g.first).mins) % 240) * MIN : null;
      const bucketStart = to === '4h' ? start : g.first;
      const from = to === '4h' ? start : g.first - (tradeMins(etFast(g.first).mins) * MIN);
      // Open slots, checked once a minute (market hours change on whole minutes) and scaled to the base bar.
      const step = Math.max(base.ms, MIN);
      let open = 0;
      for (let t = from; t < from + span; t += step) open += cmeOpen(t) ? 1 : 0;
      const expected = open * (step / base.ms);
      const complete = expected > 0 && (to === '4h' ? g.n >= expected : g.n >= 0.9 * expected);
      if (!complete || from + span > now) continue;
      out.push({ t: iso(bucketStart), o: g.o, h: g.h, l: g.l, c: g.c, v: g.v });
    }
    return out.sort((a, b) => a.t.localeCompare(b.t));
  }
  return resample(bars, base.ms, target.ms).filter((b) => Date.parse(b.t) + target.ms <= now);
}

/** Missing base bars inside open market hours (holidays, the daily break and weekends are not missing). */
export function missingBars(bars, tf) {
  const t = tfOf(tf);
  if (!t || !isIntraday(tf) || bars.length < 2) return 0;
  let missing = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = Date.parse(bars[i - 1].t); const b = Date.parse(bars[i].t);
    if (b - a <= t.ms) continue;
    // Count only the open slots in the gap; cap so a long closure costs no CPU.
    const steps = Math.min((b - a) / t.ms - 1, 20_000);
    for (let k = 1; k <= steps; k++) if (cmeOpen(a + k * t.ms)) missing++;
  }
  return missing;
}

// ─── Futures rolls ────────────────────────────────────────────────────────────

/** Quarterly equity-index expiries (third Friday of Mar/Jun/Sep/Dec) and the usual roll, 8 days earlier (Thursday). */
export function rollSchedule(fromYear, toYear) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const m of [2, 5, 8, 11]) {
      const expiry = nthWeekday(y, m, 5, 3);
      out.push({ contract: `${'HMUZ'[[2, 5, 8, 11].indexOf(m)]}${String(y).slice(-2)}`, expiry: ymd(expiry), roll: ymd(expiry - 8 * DAY) });
    }
  }
  return out;
}

/** Back-adjusted continuous series from individual contracts (additive, "Panama"): older contracts are shifted by
 * the price difference on each roll day, so no artificial jump remains. The adjustment is recorded per roll. */
export function backAdjust(contracts) {
  const segs = contracts.filter((c) => c.bars?.length).sort((a, b) => a.bars[0].t.localeCompare(b.bars[0].t));
  const adjustments = [];
  let offset = 0;
  const out = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const next = segs[i + 1];
    const until = next ? next.roll_at || next.bars[0].t : null;
    if (next) {
      const overlapOld = seg.bars.filter((b) => b.t <= until).at(-1);
      const overlapNew = next.bars.find((b) => b.t >= until);
      if (overlapOld && overlapNew) { const diff = overlapNew.c - overlapOld.c; offset += diff; adjustments.unshift({ from: seg.contract, to: next.contract, at: until, points: r4(diff) }); }
    }
    const keep = seg.bars.filter((b) => !until || b.t < until).map((b) => ({ ...b, o: r4(b.o + offset), h: r4(b.h + offset), l: r4(b.l + offset), c: r4(b.c + offset) }));
    out.unshift(...keep);
  }
  return { bars: out, method: 'back-adjusted (additive) at each roll', adjustments };
}

/** Unadjusted front-month series keep the roll jump. Trades open across a roll, or whose signal used bars from
 * before the roll (inside the indicator warm-up after it), are excluded and counted: a roll gap is not a signal. */
export function rollGuard(trades, bars, { rolls = [], warmupBars = 50 } = {}) {
  if (!rolls.length) return { kept: trades, excluded: 0 };
  const rollTimes = rolls.map((r) => `${r.roll}T22:00:00.000Z`).sort();
  const firstAfter = new Map();
  for (const rt of rollTimes) {
    const idx = bars.findIndex((b) => b.t >= rt);
    if (idx >= 0) firstAfter.set(rt, bars[Math.min(bars.length - 1, idx + warmupBars)].t);
  }
  const kept = [];
  let excluded = 0;
  for (const t of trades) {
    const across = rollTimes.some((rt) => t.signal.time < rt && t.exit.time >= rt);
    const warm = rollTimes.some((rt) => t.signal.time >= rt && t.signal.time < (firstAfter.get(rt) || rt));
    if (across || warm) excluded++; else kept.push(t);
  }
  return { kept, excluded };
}

// ─── Sessions and regimes (deterministic, causal) ─────────────────────────────

export const SESSIONS = Object.freeze([
  { id: 'globex_overnight', label: 'Globex overnight (Asia)', from: 18 * 60, to: 3 * 60 },
  { id: 'london', label: 'London / pre-New-York', from: 3 * 60, to: 8 * 60 + 30 },
  { id: 'pre_ny', label: 'New York pre-open', from: 8 * 60 + 30, to: 9 * 60 + 30 },
  { id: 'ny_open', label: 'New York open', from: 9 * 60 + 30, to: 10 * 60 },
  { id: 'ny_morning', label: 'New York morning', from: 10 * 60, to: 12 * 60 },
  { id: 'ny_lunch', label: 'New York lunch', from: 12 * 60, to: 13 * 60 + 30 },
  { id: 'ny_afternoon', label: 'New York afternoon', from: 13 * 60 + 30, to: 15 * 60 },
  { id: 'ny_close', label: 'New York close', from: 15 * 60, to: 16 * 60 },
  { id: 'after_hours', label: 'After hours', from: 16 * 60, to: 17 * 60 },
]);
/** Session of an instant, in New York time (DST from the time-zone database). Daily or longer bars have no session. */
export function sessionAt(time, tf = '5m') {
  if (!isIntraday(tf)) return 'daily';
  const { mins } = etParts(time);
  if (mins >= 17 * 60 && mins < 18 * 60) return 'cme_break';
  for (const s of SESSIONS) if (s.from < s.to ? mins >= s.from && mins < s.to : mins >= s.from || mins < s.to) return s.id;
  return 'unknown';
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Regime of every bar from that bar and earlier bars only. Structure: trend_up / trend_down (EMA 20 over 50, the 50
 * rising or falling, efficiency ratio ≥ 0.3), breakout (close beyond the prior 20-bar range), range (efficiency ≤ 0.2),
 * otherwise mixed. Volatility: ATR(14)/close against its own last 200 values (low, normal, high).
 */
export function classifyRegimes(bars) {
  const n = bars.length;
  const out = new Array(n);
  const k20 = 2 / 21; const k50 = 2 / 51;
  let e20 = null; let e50 = null; const e50s = [];
  let atr = null; const atrPct = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    e20 = e20 == null ? b.c : b.c * k20 + e20 * (1 - k20);
    e50 = e50 == null ? b.c : b.c * k50 + e50 * (1 - k50);
    e50s.push(e50);
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l;
    atr = atr == null ? tr : (atr * 13 + tr) / 14;
    const ap = atr / b.c;
    atrPct.push(ap);
    if (i < 50) { out[i] = { structure: 'unknown', volatility: 'unknown', direction: 'unknown', er: null }; continue; }
    let path = 0;
    for (let j = i - 19; j <= i; j++) path += Math.abs(bars[j].c - bars[j - 1].c);
    const er = path ? Math.abs(b.c - bars[i - 20].c) / path : 0;
    const slope = e50 - e50s[i - 10];
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - 20; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    const direction = e20 > e50 && slope > 0 ? 'bullish' : e20 < e50 && slope < 0 ? 'bearish' : 'neutral';
    let structure = 'mixed';
    if ((b.c > hi || b.c < lo) && er >= 0.3) structure = 'breakout';
    else if (er >= 0.3 && direction !== 'neutral') structure = direction === 'bullish' ? 'trend_up' : 'trend_down';
    else if (er <= 0.2) structure = 'range';
    const win = atrPct.slice(Math.max(0, i - 199), i + 1);
    const pr = win.filter((x) => x < ap).length / win.length;
    const volatility = win.length < 60 ? 'unknown' : pr < 1 / 3 ? 'low' : pr > 2 / 3 ? 'high' : 'normal';
    out[i] = { structure, volatility, direction, er: r2(er) };
  }
  return out;
}
export const regimeLabel = (g) => (!g || g.structure === 'unknown' ? 'Not enough bars yet'
  : `${{ trend_up: 'Trending bullish', trend_down: 'Trending bearish', breakout: 'Breakout', range: 'Range / mean-reverting', mixed: 'Mixed' }[g.structure]} · ${g.volatility} volatility`);

// ─── Strategy definitions (only written rules are tested) ─────────────────────

const INTRADAY_TFS = ['15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h'];
const MAX_TF = { 'p2p86-style-5m': '15m', 'orb-15m': '5m', 'silver-bullet-5m': '15m', 'vwap-revert-5m': '30m', 'pdhl-sweep-5m': '1h' };
const DAILY_TFS = ['1D', '1W', '1M'];
export const UNDEFINED_STRATEGIES = Object.freeze([
  { strategy_id: 'dirty-trez', name: 'Dirty Trez', why: 'No written entry, stop, target or timeframe rules exist in CHE. It is never backtested until the rules are written down.' },
  { strategy_id: 'ict-ote', name: 'ICT optimal trade entry (OTE)', why: 'No written rule set (which swing, which Fibonacci zone, which confirmation) exists in CHE. Not tested until defined.' },
]);
/** Every testable strategy as an explicit contract: the same rules the engine executes, nothing discretionary. */
export function strategyDefinitions() {
  const defs = [];
  for (const [id, c] of Object.entries(INTRADAY_CANDIDATES)) {
    const max = MAX_TF[id];
    defs.push({
      strategy_id: id, name: c.name, family: c.family || '', version: strategyVersion(id, 'any', { target_r: 2 }), defined: true, markets: [...MARKETS],
      direction: 'long and short', entry_rule: c.rules, exit_rule: 'stop, target or time: flat by 16:55 New York (ORB 15:55), before the CME break',
      stop_rule: 'as written in the entry rule (1 tick beyond the setup extreme)', target_rule: c.flat ? 'the R multiple of the portfolio (2R default)' : (id === 'vwap-revert-5m' ? 'session VWAP' : id === 'p2p86-style-5m' ? 'the overnight high or low (at least 1R away)' : 'the R multiple of the portfolio (2R default)'),
      time_filter: id === 'silver-bullet-5m' ? '10:00–11:00 and 14:00–15:00 New York' : id === 'p2p86-style-5m' ? 'entries 9:35–11:00 New York; overnight range 18:00–9:30' : id === 'orb-15m' ? '9:45–11:30 New York' : 'none beyond the flat time',
      session_filter: 'none (sessions are measured, not filtered)', regime_filter: 'none (regimes are measured, not filtered)',
      position_sizing: '1 contract', max_holding: 'same CME trading day', risk_bounds: '6 to 60 index points of risk, otherwise skipped',
      data_requirements: 'intraday bars with real timestamps', context_timeframes: [], common_rules: INTRADAY_COMMON_RULES,
      cost_assumptions: { ...COSTS }, timeframes: max ? INTRADAY_TFS.slice(0, INTRADAY_TFS.indexOf(max) + 1) : INTRADAY_TFS, engine: 'trading_evidence.stepPortfolio',
    });
  }
  for (const [id, c] of Object.entries(CANDIDATES)) {
    defs.push({
      strategy_id: id, name: `${c.name} (daily)`, family: 'Daily', version: strategyVersion(id, 'any', { target_r: 2 }), defined: true, markets: [...MARKETS],
      direction: 'long', entry_rule: c.name, exit_rule: 'stop or target', stop_rule: 'below the setup bar', target_rule: '2R',
      time_filter: 'none', session_filter: 'n/a (daily)', regime_filter: 'none', position_sizing: '1 contract', max_holding: 'until stop or target',
      data_requirements: 'daily or longer bars', context_timeframes: [], cost_assumptions: { ...COSTS }, timeframes: ['4h', ...DAILY_TFS], engine: 'trading_evidence.stepPortfolio',
    });
  }
  return defs;
}
export const definitionOf = (id) => strategyDefinitions().find((d) => d.strategy_id === id) || null;

// ─── Costs ───────────────────────────────────────────────────────────────────

export const COST_PROFILES = Object.freeze({
  OPTIMISTIC: { spreadTicks: 1, slippageTicks: 0, commissionPerSide: 0.5, feePerSide: 0.35 },
  NORMAL: { ...COSTS },
  STRESS: { spreadTicks: 2, slippageTicks: 2, commissionPerSide: 2.5, feePerSide: 0.75 },
});

// ─── Data acquisition (cache → connected feeds → free sources) ────────────────

/**
 * Where each resolution can legitimately come from, in priority order. `max_depth` is the provider's documented
 * limit; `verified` becomes true only when CHE actually fetched and checked the bars. Rithmic in CHE is the phone's
 * ticker plant (live last trade and best bid/offer); it has no history plant, so it supplies no historical bars.
 */
export const DATA_SOURCES = Object.freeze([
  { id: 'tradovate', tier: 1, provider: 'Tradovate market data (owner account)', resolutions: [], note: 'connected streaming quotes only in CHE; historical chart requests are not implemented, so not used' },
  { id: 'rithmic', tier: 2, provider: 'Rithmic ticker plant (owner login, on the iPhone)', resolutions: [], note: 'live last trade and best bid/offer only; no history plant in CHE, so no historical bars' },
  { id: 'yahoo', tier: 4, provider: 'Yahoo Finance chart (public, free, delayed)', resolutions: ['1m', '2m', '5m', '15m', '30m', '1h', '1D'],
    interval: { '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1D': '1d' },
    max_depth_days: { '1m': 7, '2m': 59, '5m': 59, '15m': 59, '30m': 59, '1h': 729, '1D': 40 * 365 } },
  { id: 'stooq', tier: 4, provider: 'Stooq daily (public, free)', resolutions: ['1D'], symbol: { NQ: 'nq.f' } },
]);
const SYMBOLS = { MNQ: 'MNQ=F', NQ: 'NQ=F', NDX: '^NDX' };
const NDX_PROXY = 'PROXY: the Nasdaq-100 cash index (^NDX) is not a tradable futures contract; it stands in for NQ history before futures data, priced with NQ costs. Never reported as MNQ or NQ.';
export const LAUNCH = Object.freeze({ MNQ: '2019-05-06', NQ: '1999-06-21' });

async function yahooBars(market, tf, { fetcher, now }) {
  const src = DATA_SOURCES.find((s) => s.id === 'yahoo');
  const interval = src.interval[tf];
  const days = src.max_depth_days[tf];
  const url = tf === '1D'
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOLS[market])}?interval=1d&period1=0&period2=${Math.floor(now / 1000)}`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOLS[market])}?interval=${interval}&range=${days}d&includePrePost=true`;
  const res = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo answered ${res.status}`);
  const parsed = parseYahooChart(await res.json(), now, tfOf(tf).ms);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.candles;
}

/** A dataset manifest: everything needed to reproduce and judge the bars. */
export async function manifestFor(market, tf, bars, { provider, symbol, contract, derived_from = null, proxy = null, rolls = [], adjustment, now = Date.now() }) {
  const first = bars[0]?.t || null; const last = bars.at(-1)?.t || null;
  return {
    market, timeframe: tf, provider, symbol, contract: contract || market, continuous_method: 'continuous front month (provider series)',
    resolution: tf, first, last, bars: bars.length, timezone: 'UTC timestamps; sessions in America/New_York', missing: missingBars(bars, tf),
    roll_method: rolls.length ? 'unadjusted front month; trades across a roll or inside the warm-up after it are excluded' : 'none in range', rolls: rolls.length,
    adjustment: adjustment || 'none: unadjusted front-month prices', derived_from, proxy,
    years: first && last ? r2((Date.parse(last) - Date.parse(first)) / (365.25 * DAY)) : 0,
    confidence: proxy ? 'proxy' : provider.includes('delayed') || provider.includes('Yahoo') ? 'public delayed data' : 'licensed',
    sha256: await sha256Hex(canonicalBars(bars)), fetched_at: iso(now), engine: RESEARCH_VERSION,
  };
}

async function saveDataset(storage, market, tf, bars, manifest) {
  const chunks = Math.ceil(bars.length / CHUNK_BARS);
  const puts = { [`${DS_PREFIX}${market}:${tf}`]: { ...manifest, chunks } };
  for (let i = 0; i < chunks; i++) puts[`${DS_PREFIX}${market}:${tf}:${i}`] = bars.slice(i * CHUNK_BARS, (i + 1) * CHUNK_BARS);
  const entries = Object.entries(puts);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
}
/** The stored dataset manifests for one market, by timeframe (no bars are read). */
export async function datasetManifests(storage, market) {
  const keys = TF_IDS.map((tf) => `${DS_PREFIX}${market}:${tf}`);
  const got = await storage.get(keys);
  return Object.fromEntries(TF_IDS.filter((tf, i) => got.get(keys[i])).map((tf, i) => [tf, got.get(`${DS_PREFIX}${market}:${tf}`)]));
}
export async function loadDataset(storage, market, tf) {
  const manifest = await storage.get(`${DS_PREFIX}${market}:${tf}`);
  if (!manifest) return null;
  const keys = Array.from({ length: manifest.chunks || 0 }, (_, i) => `${DS_PREFIX}${market}:${tf}:${i}`);
  const bars = [];
  for (let i = 0; i < keys.length; i += 100) {
    const got = await storage.get(keys.slice(i, i + 100));
    for (const k of keys.slice(i, i + 100)) bars.push(...(got.get(k) || []));
  }
  return { manifest, bars };
}

/**
 * TRADING DATA ACQUISITION LOOP. Returns verified bars with provenance, or the honest reason they do not exist:
 * cache → connected feeds (none provide history in CHE today) → free sources → derived upward from a finer
 * verified series. Never a downward resample, never a proxy unless `allowProxy`, never invented bars.
 */
export async function acquireDataset(storage, { market, tf, maxAgeMs = 6 * HOUR }, { fetcher = fetch, now = Date.now(), allowProxy = false } = {}) {
  if (!MARKETS.includes(market) && !(allowProxy && market === 'NDX')) return { ok: false, reason: `unknown market ${market}` };
  if (!tfOf(tf)) return { ok: false, reason: `unknown timeframe ${tf}` };
  const cached = await loadDataset(storage, market, tf);
  if (cached && now - Date.parse(cached.manifest.fetched_at) < maxAgeMs) return { ok: true, cached: true, ...cached };
  if (tf === '15s' || tf === '30s') {
    return { ok: false, reason: `No ${tf} history is reachable: the free sources start at 1-minute bars, Rithmic in CHE is live-only (no history plant) and Tradovate history requests are not implemented.`,
      options: ['a licensed tick/second-bar vendor export (CSV) imported into CHE', 'a Rithmic history-plant connection (needs Rithmic API licensing)', 'recording live ticks from now on (forward only, never backfilled)'] };
  }
  const errors = [];
  const src = DATA_SOURCES.find((s) => s.id === 'yahoo');
  if (src.resolutions.includes(tf)) {
    try {
      const raw = await yahooBars(market, tf, { fetcher, now });
      const bars = tf === '1D' && market === 'MNQ' ? raw.filter((b) => b.t >= LAUNCH.MNQ) : raw;
      const problems = candleProblems(bars);
      if (problems.length) throw new Error(`bars refused: ${problems.join('; ')}`);
      const years = bars.length ? [new Date(bars[0].t).getUTCFullYear(), new Date(bars.at(-1).t).getUTCFullYear()] : [0, 0];
      const rolls = bars.length ? rollSchedule(years[0], years[1]).filter((r) => r.roll >= bars[0].t.slice(0, 10) && r.roll <= bars.at(-1).t.slice(0, 10)) : [];
      const manifest = await manifestFor(market, tf, bars, { provider: src.provider, symbol: SYMBOLS[market], rolls: market === 'NDX' ? [] : rolls, proxy: market === 'NDX' ? NDX_PROXY : null, adjustment: market === 'NDX' ? 'price index: no futures basis, no rolls' : undefined, now });
      await saveDataset(storage, market, tf, bars, { ...manifest, roll_dates: rolls.map((r) => r.roll) });
      return { ok: true, cached: false, manifest: { ...manifest, roll_dates: rolls.map((r) => r.roll) }, bars };
    } catch (e) { errors.push(`Yahoo: ${String(e?.message || e).slice(0, 160)}`); }
  }
  // Derived upward from the finest verified series below it.
  for (const from of TF_IDS.slice(0, rank(tf)).reverse()) {
    if (!canAggregate(from, tf)) continue;
    const base = await loadDataset(storage, market, from);
    if (!base?.bars?.length) continue;
    const bars = aggregateBars(base.bars, from, tf, { now });
    if (!bars.length) continue;
    const manifest = await manifestFor(market, tf, bars, { provider: base.manifest.provider, symbol: base.manifest.symbol, derived_from: `${from} (${base.manifest.sha256.slice(0, 12)})`, rolls: [], now });
    await saveDataset(storage, market, tf, bars, { ...manifest, roll_dates: base.manifest.roll_dates || [] });
    return { ok: true, cached: false, manifest: { ...manifest, roll_dates: base.manifest.roll_dates || [] }, bars };
  }
  if (cached) return { ok: true, cached: true, stale: true, errors, ...cached };
  return { ok: false, reason: errors.length ? `No ${tf} ${market} data could be fetched: ${errors.join('; ')}` : `No source provides ${tf} ${market} bars.`, errors };
}

/** Research windows that the data actually covers. A window older than the data is reported as not available. */
export function periodsFor(manifest, trades, now = Date.now()) {
  if (!manifest?.first) return [];
  const last = Date.parse(manifest.last); const first = Date.parse(manifest.first);
  const years = (last - first) / (365.25 * DAY);
  const ytd = Date.UTC(new Date(last).getUTCFullYear(), 0, 1);
  const windows = [['max', first], ['10y', last - 10 * 365.25 * DAY], ['5y', last - 5 * 365.25 * DAY], ['1y', last - 365.25 * DAY], ['ytd', ytd], ['90d', last - 90 * DAY], ['30d', last - 30 * DAY]];
  return windows.map(([window, from]) => {
    const available = window === 'max' || from >= first;
    const list = available ? trades.filter((t) => Date.parse(t.t) >= from) : [];
    const s = list.length ? stats(list) : null;
    return { window, available, years_available: r2(years), trades: list.length, expectancy_r: s ? s.expectancy_r : null };
  });
}

// ─── Running one evidence unit: strategy × market × timeframe ─────────────────

function stats(compact) {
  const rs = compact.map((t) => t.r);
  const n = rs.length;
  if (!n) return { trades: 0, expectancy_r: null, win_rate: null, pf: null, max_dd_r: 0, median_r: null };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const wins = rs.filter((r) => r > 0); const losses = rs.filter((r) => r < 0);
  const gw = wins.reduce((a, b) => a + b, 0); const gl = -losses.reduce((a, b) => a + b, 0);
  let eq = 0; let peak = 0; let dd = 0; let streak = 0; let worst = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); streak = r < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : 0;
  const down = rs.filter((r) => r < 0);
  const dsd = down.length > 1 ? Math.sqrt(down.reduce((a, r) => a + r ** 2, 0) / down.length) : 0;
  const sorted = [...rs].sort((a, b) => a - b);
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
  return {
    trades: n, expectancy_r: r4(mean), median_r: r4(sorted[Math.floor(n / 2)]), win_rate: r4(wins.length / n),
    avg_win_r: wins.length ? r4(gw / wins.length) : null, avg_loss_r: losses.length ? r4(-gl / losses.length) : null,
    pf: gl ? r2(gw / gl) : null, max_dd_r: r2(dd), worst_loss_streak: worst, sharpe_like: sd ? r2(mean / sd) : null,
    sortino_like: dsd ? r2(mean / dsd) : null, expectancy_ci: { low: r4(mean - half), high: r4(mean + half) },
    tail_loss_r: r4(sorted[Math.max(0, Math.floor(n * 0.05) - 1)] ?? sorted[0]),
  };
}

/** Seeded resampling of the trade order: drawdown and losing-streak ranges, not one historical ordering. */
export function monteCarlo(rs, { runs = 300, seed = 7 } = {}) {
  if (rs.length < MIN_CLOSED_TRADES) return null;
  let s = seed >>> 0;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const dds = []; const streaks = []; const totals = [];
  for (let k = 0; k < runs; k++) {
    let eq = 0; let peak = 0; let dd = 0; let st = 0; let worst = 0;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[Math.floor(rand() * rs.length)];
      eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); st = r < 0 ? st + 1 : 0; worst = Math.max(worst, st);
    }
    dds.push(dd); streaks.push(worst); totals.push(eq);
  }
  const pct = (a, p) => { const x = [...a].sort((m, n) => m - n); return r2(x[Math.min(x.length - 1, Math.floor(p * x.length))]); };
  return { runs, drawdown_r: { p50: pct(dds, 0.5), p95: pct(dds, 0.95) }, loss_streak: { p50: pct(streaks, 0.5), p95: pct(streaks, 0.95) }, total_r: { p5: pct(totals, 0.05), p50: pct(totals, 0.5), p95: pct(totals, 0.95) } };
}

/** Imports bars the owner supplies (a licensed vendor export, or a recorded feed) with their provenance. They are
 * validated like any other source, never extended, and labelled with where they came from. */
export async function importDataset(storage, { market, tf, bars, provider, symbol = null, contract = null, adjustment = null, fixture = false }, { now = Date.now() } = {}) {
  if (!MARKETS.includes(market) || !tfOf(tf)) return { ok: false, reason: 'unknown market or timeframe' };
  if (!provider) return { ok: false, reason: 'a dataset needs its provider' };
  const problems = candleProblems(bars);
  if (problems.length) return { ok: false, reason: `bars refused: ${problems.join('; ')}` };
  const years = [new Date(bars[0].t).getUTCFullYear(), new Date(bars.at(-1).t).getUTCFullYear()];
  const rolls = rollSchedule(years[0], years[1]).filter((r) => r.roll >= bars[0].t.slice(0, 10) && r.roll <= bars.at(-1).t.slice(0, 10));
  const manifest = { ...(await manifestFor(market, tf, bars, { provider: fixture ? `TEST FIXTURE (not market data): ${provider}` : provider, symbol: symbol || SYMBOLS[market], contract, rolls, adjustment, now })), roll_dates: rolls.map((r) => r.roll), fixture };
  if (fixture) manifest.confidence = 'test fixture';
  await saveDataset(storage, market, tf, bars, manifest);
  return { ok: true, manifest };
}

export function runEngine(strategyId, bars, tf, { costs = COSTS, target_r = 2, market = 'MNQ' } = {}) {
  const intraday = isIntraday(tf);
  const ctx = intraday ? intradayContext(bars) : causalContext(bars);
  const pf = newPortfolio(strategyId, 'any', { contract: market, qty: 1, source: 'backtest', resolution: intraday ? tf : 'daily', priceSeries: tf, costs, params: { target_r } });
  return stepPortfolio(pf, bars, ctx);
}

const compact = (t, tf, regimeAt) => {
  const g = regimeAt(t.signal.time);
  return { t: t.entry.time, x: t.exit.time, r: r4(t.r_net), side: t.side, s: sessionAt(t.entry.time, tf), g: g?.structure || 'unknown', v: g?.volatility || 'unknown',
    h: isIntraday(tf) ? Number(etParts(t.entry.time).mins / 60 | 0) : null, w: WEEKDAYS[new Date(`${etParts(t.entry.time).day}T12:00:00Z`).getUTCDay()], reason: t.exit.reason };
};
function breakdownBy(list, key) {
  const groups = {};
  for (const t of list) (groups[t[key]] ||= []).push(t);
  return Object.entries(groups).map(([k, l]) => ({ key: k, ...stats(l) })).sort((a, b) => b.trades - a.trades);
}

/**
 * One evidence unit, BACKTEST mode: the strategy on verified bars of one timeframe with the chosen cost profile.
 * Train and out-of-sample (anchored walk-forward folds) are kept apart; the leakage audit, roll guard, Monte Carlo,
 * stress costs and target sensitivity are recorded with it.
 */
export function evaluateUnit({ strategyId, market, tf, bars, manifest, profile = 'NORMAL', deep = false }) {
  const def = definitionOf(strategyId);
  if (!def) return { ok: false, reason: 'unknown strategy' };
  if (!def.timeframes.includes(tf)) return { ok: false, applicable: false, reason: `${def.name} is not defined for ${tf} bars (its rules need ${def.timeframes.join(', ')}).` };
  const costs = COST_PROFILES[profile] || COSTS;
  const regimes = classifyRegimes(bars);
  const index = new Map(bars.map((b, i) => [b.t, i]));
  const regimeAt = (time) => regimes[index.get(time)] || null;
  const rolls = (manifest?.roll_dates || []).map((roll) => ({ roll }));
  const raw = runEngine(strategyId, bars, tf, { costs, market });
  const guarded = rollGuard(raw, bars, { rolls });
  const trades = guarded.kept;
  const wf = evaluateWalkForward(trades, { barTimes: bars.map((b) => b.t), folds: 4, minTrain: 0.4 });
  const oosSet = new Set(wf.oos.map((t) => t.entry.time));
  const all = trades.map((t) => ({ ...compact(t, tf, regimeAt), oos: oosSet.has(t.entry.time) }));
  const train = all.filter((t) => !t.oos); const oos = all.filter((t) => t.oos);
  const recentFrom = all.length ? Date.parse(all[Math.floor(all.length * 0.75)].t) : 0;
  const recent = all.filter((t) => Date.parse(t.t) >= recentFrom);
  // Rolling walk-forward: fixed-length windows; each window's out-of-sample result on its own.
  const rolling = [];
  const span = bars.length;
  for (let w = 0; w < 4; w++) {
    const testFrom = bars[Math.floor(span * (0.4 + w * 0.15))]?.t; const testTo = bars[Math.min(span - 1, Math.floor(span * (0.55 + w * 0.15)))]?.t;
    if (!testFrom || !testTo) continue;
    const part = all.filter((t) => t.t >= testFrom && t.x < testTo);
    rolling.push({ window: w + 1, from: testFrom, to: testTo, ...stats(part) });
  }
  const stress = profile === 'STRESS' ? null : stats(rollGuard(runEngine(strategyId, bars, tf, { costs: COST_PROFILES.STRESS, market }), bars, { rolls }).kept.map((t) => ({ r: t.r_net })));
  let sensitivity = null;
  if (deep) {
    sensitivity = [1.5, 2, 3].map((target_r) => {
      const s = stats(rollGuard(runEngine(strategyId, bars, tf, { costs, target_r, market }), bars, { rolls }).kept.map((t) => ({ r: t.r_net })));
      return { target_r, trades: s.trades, expectancy_r: s.expectancy_r };
    });
  }
  // The audit reruns the rules three times; on long series it uses the newest 6,000 bars, which is where any
  // look-ahead would show just the same.
  const auditBars = bars.length > 6000 ? bars.slice(-6000) : bars;
  const audit = leakageAudit(auditBars, (candles) => runEngine(strategyId, candles, tf, { costs, market }));
  const s = stats(all); const so = stats(oos);
  return {
    ok: true, strategy_id: strategyId, market, timeframe: tf, mode: 'BACKTEST', profile, engine: RESEARCH_VERSION, strategy_version: def.version,
    dataset: { sha256: manifest?.sha256 || null, provider: manifest?.provider || null, first: manifest?.first || null, last: manifest?.last || null, bars: bars.length, derived_from: manifest?.derived_from || null, proxy: manifest?.proxy || null },
    all: s, train: stats(train), oos: so, recent: stats(recent),
    folds: wf.folds, folds_positive: wf.folds_positive, folds_total: wf.folds_total, rolling,
    sessions: breakdownBy(all, 's'), regimes: breakdownBy(all, 'g'), volatility: breakdownBy(all, 'v'),
    hours: isIntraday(tf) ? breakdownBy(all, 'h') : [], weekdays: breakdownBy(all, 'w'),
    session_regime: breakdownBy(all.map((t) => ({ ...t, sr: `${t.s}|${t.g}` })), 'sr'),
    periods: periodsFor(manifest, all), monte_carlo: monteCarlo(all.map((t) => t.r)), stress: stress ? { expectancy_r: stress.expectancy_r, trades: stress.trades } : null,
    sensitivity, roll_excluded: guarded.excluded, look_ahead: audit.ok ? 'passed' : audit.reason === 'too few bars to audit' ? 'not enough bars' : 'FAILED',
    trades: all.slice(-KEEP_TRADES),
  };
}

// ─── Evidence states, readiness, decay ────────────────────────────────────────

export function evidenceState(unit) {
  if (!unit || unit.ok === false) return unit?.applicable === false ? 'N/A' : 'NO DATA';
  if (unit.all.trades < MIN_CLOSED_TRADES) return 'NOT READY';
  const oosOk = unit.oos.trades >= 15 && unit.oos.expectancy_r > 0;
  return oosOk && unit.look_ahead !== 'FAILED' ? 'QUALIFIED' : 'MONITOR';
}
// The rating uses only out-of-sample (unseen) trades. Fewer than this many unseen trades is too few to rate.
export const MIN_OOS_TRADES = 15;
export function matrixState(unit) {
  const st = evidenceState(unit);
  if (st === 'NO DATA' || st === 'N/A') return 'No data';
  if (st === 'NOT READY') return 'Learning';
  if (st === 'QUALIFIED') return unit.oos.expectancy_r >= 0.3 && (unit.oos.pf ?? 0) >= 1.3 ? 'Strong' : 'Good';
  // MONITOR covers three different things; only a real negative unseen result is Weak.
  if ((unit.oos?.trades || 0) < MIN_OOS_TRADES) return 'Not enough unseen data';
  if (unit.look_ahead === 'FAILED') return 'Audit failed';
  return unit.oos.expectancy_r > -0.05 ? 'Fair' : 'Weak';
}
export function decayOf(unit) {
  if (!unit?.recent || unit.recent.trades < 15 || unit.all.trades < MIN_CLOSED_TRADES) return 'INSUFFICIENT DATA';
  const d = unit.recent.expectancy_r - unit.all.expectancy_r;
  return d > 0.1 ? 'IMPROVING' : d < -0.1 ? 'WEAKENING' : 'STABLE';
}
/** LEARNING → 30+ SAMPLE → OOS VERIFIED → PAPER VERIFIED → READY FOR OWNER REVIEW. None authorizes live trading. */
export function readinessOf(units, paper) {
  const sampled = units.filter((u) => u?.ok && u.all.trades >= MIN_CLOSED_TRADES);
  if (!sampled.length) return 'LEARNING';
  const oosVerified = sampled.some((u) => u.oos.trades >= MIN_CLOSED_TRADES && u.oos.expectancy_r > 0 && u.folds_total && u.folds_positive / u.folds_total >= 0.6 && u.look_ahead === 'passed');
  if (!oosVerified) return '30+ SAMPLE';
  const paperVerified = paper && paper.trades >= MIN_CLOSED_TRADES && paper.expectancy_r > 0;
  if (!paperVerified) return 'OOS VERIFIED';
  const weakening = sampled.some((u) => decayOf(u) === 'WEAKENING');
  return weakening ? 'PAPER VERIFIED' : 'READY FOR OWNER REVIEW';
}
export function statusOf(units, owner = {}) {
  if (owner.retired) return 'RETIRED';
  const sampled = units.filter((u) => u?.ok && u.all.trades >= MIN_CLOSED_TRADES);
  if (sampled.some((u) => evidenceState(u) === 'QUALIFIED')) return 'ACTIVE';
  const strongLosers = sampled.filter((u) => u.all.trades >= 60 && u.oos.trades >= 15 && u.oos.expectancy_r < 0);
  if (strongLosers.length >= 3 && strongLosers.length === sampled.length) return 'DEPRIORITIZED';
  return 'MONITOR';
}

// ─── Selector, champion / challenger ─────────────────────────────────────────

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/**
 * Composite evidence score, 0–100, from out-of-sample results first. No single metric decides: win rate is not in it,
 * so a high win rate with poor expectancy cannot win. Session and regime mismatches cost points; a negative OOS
 * expectancy, a failed look-ahead audit or fewer than 30 trades disqualify.
 */
export function evidenceScore(unit, ctx = {}, paper = null) {
  if (!unit?.ok) return { score: 0, qualified: false, why: ['no evidence'] };
  const why = [];
  if (unit.all.trades < MIN_CLOSED_TRADES) return { score: 0, qualified: false, why: [`${unit.all.trades}/${MIN_CLOSED_TRADES} trades: learning`] };
  if (unit.look_ahead === 'FAILED') return { score: 0, qualified: false, why: ['failed the look-ahead audit'] };
  const oos = unit.oos;
  if (!(oos.trades >= 15) || !(oos.expectancy_r > 0)) return { score: 0, qualified: false, why: [`out-of-sample expectancy ${oos.expectancy_r ?? 'n/a'}R on ${oos.trades} trades`] };
  let score = 0;
  score += 30 * clamp(oos.expectancy_r / 0.5, 0, 1);
  score += 10 * clamp(((oos.pf ?? 1) - 1) / 1, 0, 1);
  score -= 10 * clamp((unit.all.max_dd_r || 0) / 20, 0, 1);
  score += 10 * clamp(Math.log10(unit.all.trades / 30) / 1, 0, 1);
  score += 10 * (unit.folds_total ? unit.folds_positive / unit.folds_total : 0);
  score += unit.recent?.trades >= 15 ? 10 * clamp(unit.recent.expectancy_r / 0.5, -1, 1) : 0;
  if (decayOf(unit) === 'WEAKENING') { score -= 10; why.push('recent results weaker than its history'); }
  if (unit.all.expectancy_ci?.low > 0) score += 5;
  if (unit.stress) score += unit.stress.expectancy_r > 0 ? 5 : -5;
  const fit = (rows, key, label) => {
    const row = (rows || []).find((r) => r.key === key);
    if (!key || !row || row.trades < 10) return 0;
    if (row.expectancy_r > 0) { why.push(`${label} fits (${row.expectancy_r}R on ${row.trades})`); return 10; }
    why.push(`${label} mismatch (${row.expectancy_r}R on ${row.trades})`); return -15;
  };
  score += fit(unit.sessions, ctx.session, 'session');
  score += fit(unit.regimes, ctx.regime, 'regime');
  if (paper?.trades >= 10) score += paper.expectancy_r > 0 ? 5 : -5;
  score = Math.round(clamp(score, 0, 100));
  return { score, qualified: score >= (ctx.threshold ?? 50), why };
}

/**
 * BEST STRATEGY SELECTOR. Stale data, no qualified evidence or a score under the owner's threshold → NO TRADE,
 * which is a valid answer. Every result names its evidence window and sample.
 */
export function selectStrategies(units, ctx = {}, paperBy = {}) {
  if (ctx.stale) return { decision: 'NO TRADE', reason: `The market data is stale${ctx.staleWhy ? ` (${ctx.staleWhy})` : ''}, so no strategy is selected.`, ranked: [] };
  const ranked = units
    .filter((u) => u?.ok && (!ctx.market || u.market === ctx.market) && (!ctx.timeframe || u.timeframe === ctx.timeframe))
    .map((u) => {
      const paper = paperBy[`${u.strategy_id}|${u.timeframe}`] || null;
      const e = evidenceScore(u, ctx, paper);
      const conf = e.score >= 75 && u.all.trades >= 100 && paper?.trades >= MIN_CLOSED_TRADES && paper.expectancy_r > 0 ? 'high' : e.score >= 60 ? 'moderate' : 'low';
      return { strategy_id: u.strategy_id, name: definitionOf(u.strategy_id)?.name || u.strategy_id, market: u.market, timeframe: u.timeframe, session: ctx.session || null, regime: ctx.regime || null,
        evidence_score: e.score, qualified: e.qualified, expectancy_r: u.oos.expectancy_r, historical_expectancy_r: u.all.expectancy_r, recent_expectancy_r: u.recent?.expectancy_r ?? null,
        paper_expectancy_r: paper?.expectancy_r ?? null, sample: u.all.trades, oos_sample: u.oos.trades, window: { from: u.dataset.first, to: u.dataset.last }, confidence: conf, why: e.why };
    })
    .sort((a, b) => b.evidence_score - a.evidence_score || b.sample - a.sample);
  const qualified = ranked.filter((r) => r.qualified);
  if (!qualified.length) return { decision: 'NO TRADE', reason: 'No strategy currently meets your threshold.', ranked };
  return { decision: 'CANDIDATES', ranked: qualified, all: ranked };
}

/** Champion and challengers per market / timeframe / session / regime. The champion only changes on evidence. */
export function updateChampions(champions, units, ctx) {
  const key = `${ctx.market}|${ctx.timeframe}|${ctx.session}|${ctx.regime}`;
  const sel = selectStrategies(units, ctx);
  const prev = champions[key] || null;
  const top = sel.decision === 'CANDIDATES' ? sel.ranked[0] : null;
  const next = {
    key, champion: top ? top.strategy_id : null, champion_score: top?.evidence_score ?? null,
    challengers: (sel.all || sel.ranked || []).filter((r) => r.strategy_id !== top?.strategy_id).slice(0, 3).map((r) => ({ strategy_id: r.strategy_id, score: r.evidence_score })),
    since: prev && prev.champion === (top?.strategy_id || null) ? prev.since : ctx.now || iso(Date.now()),
    history: prev && prev.champion !== (top?.strategy_id || null) ? [{ at: ctx.now || iso(Date.now()), from: prev.champion, to: top?.strategy_id || null }, ...(prev.history || [])].slice(0, 10) : prev?.history || [],
  };
  champions[key] = next;
  return next;
}

// ─── Multi-timeframe context and portfolio limits ─────────────────────────────

/** The newest higher-timeframe bar that had closed by `time`: an unfinished candle is never used. */
export function closedHigherBar(htfBars, htf, time) {
  const ms = tfOf(htf).ms; const at = Date.parse(time);
  let found = null;
  for (const b of htfBars) { if (Date.parse(b.t) + ms <= at) found = b; else break; }
  return found;
}

/** Portfolio-level replay: concurrent positions, total open risk and a daily loss limit, in R. */
export function portfolioSim(trades, { maxConcurrent = 2, maxOpenRiskR = 2, dailyLossR = 3 } = {}) {
  const sorted = [...trades].sort((a, b) => a.t.localeCompare(b.t));
  const open = []; const taken = []; const skipped = [];
  const dayLoss = {};
  for (const t of sorted) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].x <= t.t) open.splice(i, 1);
    const day = tradeDayOf(t.t);
    const reason = open.length >= maxConcurrent ? 'max concurrent positions' : open.length + 1 > maxOpenRiskR ? 'max open risk' : (dayLoss[day] || 0) <= -dailyLossR ? 'daily loss limit' : null;
    if (reason) { skipped.push({ ...t, reason }); continue; }
    open.push(t); taken.push(t); dayLoss[day] = (dayLoss[day] || 0) + t.r;
  }
  return { taken: taken.length, skipped: skipped.length, reasons: breakdownBy(skipped, 'reason').map((r) => ({ reason: r.key, trades: r.trades })), result: stats(taken) };
}

// ─── Trade candidate loop ────────────────────────────────────────────────────

/** Is the newest closed bar fresh enough to act on? Two bars plus 90 seconds; delayed feeds are stale by design. */
export function freshness(bars, tf, now = Date.now()) {
  const last = bars?.at(-1);
  if (!last) return { fresh: false, why: 'no bars' };
  const age = now - (Date.parse(last.t) + tfOf(tf).ms);
  const limit = 2 * tfOf(tf).ms + 90_000;
  return { fresh: age <= limit, age_ms: age, why: age <= limit ? null : `the newest closed ${tf} bar is ${Math.round(age / 60000)} minutes old` };
}

/** TRADE CANDIDATE LOOP: fresh data → session → regime → qualified strategies → current signal → risk check. */
export function tradeCandidate({ bars, tf, market, units, now = Date.now(), threshold = 50, riskOk = () => null }) {
  const fresh = freshness(bars, tf, now);
  if (!fresh.fresh) return { decision: 'NO TRADE', reason: `Stale data: ${fresh.why}. No signal is taken on old prices.` };
  const last = bars.at(-1);
  const regimes = classifyRegimes(bars);
  const ctx = { market, timeframe: tf, session: sessionAt(last.t, tf), regime: regimes.at(-1)?.structure, threshold, now: iso(now) };
  const sel = selectStrategies(units, ctx);
  if (sel.decision !== 'CANDIDATES') return { decision: 'NO TRADE', reason: sel.reason, context: ctx };
  const x = isIntraday(tf) ? intradayContext(bars) : causalContext(bars);
  for (const r of sel.ranked) {
    const cand = INTRADAY_CANDIDATES[r.strategy_id] || CANDIDATES[r.strategy_id];
    const sig = cand?.entry(bars, bars.length - 1, x);
    if (!sig) continue;
    const blocked = riskOk(r, sig);
    if (blocked) return { decision: 'NO TRADE', reason: `Risk check: ${blocked}`, context: ctx, strategy: r };
    return { decision: 'TRADE CANDIDATE', context: ctx, strategy: r, signal: { side: sig.side || 'long', ref: sig.ref, stop: sig.stop, why: sig.why }, note: 'Paper only; live orders keep every existing approval gate.' };
  }
  return { decision: 'NO TRADE', reason: 'Qualified strategies have no signal on the newest closed bar.', context: ctx };
}

// ─── Storage: state, buckets, receipts, brain ─────────────────────────────────

const evKey = (u) => `${EV_PREFIX}${u.market}:${u.timeframe}:${u.strategy_id}:${u.mode || 'BACKTEST'}`;
export async function readState(storage) {
  return { profile: 'NORMAL', threshold: 50, jobs: [], champions: {}, cache: {}, owner: {}, ...((await storage.get(STATE_KEY)) || {}) };
}
const saveState = (storage, s) => storage.put(STATE_KEY, s);
export async function saveUnit(storage, unit) { await storage.put(evKey(unit), unit); }
export async function readUnits(storage, filter = () => true) {
  const map = await storage.list({ prefix: EV_PREFIX });
  return [...map.values()].filter(filter);
}
export const cacheKey = ({ strategyId, market, tf, sha256, profile, deep }) => `${strategyId}|${market}|${tf}|${sha256}|${COST_PROFILES[profile] ? profile : 'NORMAL'}|${deep ? 'deep' : 'std'}|${RESEARCH_VERSION}|${definitionOf(strategyId)?.version || ''}`;

async function addReceipt(storage, unit) {
  const list = (await storage.get(RECEIPTS_KEY)) || [];
  const receipt = { id: `rcpt-${unit.strategy_id}-${unit.market}-${unit.timeframe}-${(unit.dataset.sha256 || '').slice(0, 8)}`, strategy: unit.strategy_id, version: unit.strategy_version, market: unit.market,
    symbol: SYMBOLS[unit.market] || unit.market, timeframe: unit.timeframe, range: [unit.dataset.first, unit.dataset.last], trades: unit.all.trades, provider: unit.dataset.provider,
    data_hash: unit.dataset.sha256, cost_model: unit.profile, session: 'all (measured per session)', regime_filters: 'none', engine_version: `${RESEARCH_VERSION} / evidence engine`, look_ahead: unit.look_ahead, at: unit.at };
  await storage.put(RECEIPTS_KEY, [receipt, ...list.filter((r) => r.id !== receipt.id)].slice(0, 200));
}

/** Verified research becomes Trading Brain knowledge: best/worst conditions with their samples, never raw guesses. */
async function populateBrain(storage, unit) {
  if (evidenceState(unit) === 'NOT READY' || !unit.ok) return;
  const best = (rows) => rows.filter((r) => r.trades >= 10).sort((a, b) => b.expectancy_r - a.expectancy_r);
  const sessions = best(unit.sessions); const regimes = best(unit.regimes);
  const entry = {
    id: `${unit.strategy_id}|${unit.market}|${unit.timeframe}`, strategy: unit.strategy_id, market: unit.market, timeframe: unit.timeframe, state: evidenceState(unit),
    historical: { trades: unit.all.trades, expectancy_r: unit.all.expectancy_r }, oos: { trades: unit.oos.trades, expectancy_r: unit.oos.expectancy_r }, recent: { trades: unit.recent.trades, expectancy_r: unit.recent.expectancy_r },
    best_conditions: [sessions[0] && `session ${sessions[0].key} (${sessions[0].expectancy_r}R, ${sessions[0].trades})`, regimes[0] && `regime ${regimes[0].key} (${regimes[0].expectancy_r}R, ${regimes[0].trades})`].filter(Boolean),
    bad_conditions: [sessions.at(-1) && sessions.at(-1).expectancy_r < 0 && `session ${sessions.at(-1).key} (${sessions.at(-1).expectancy_r}R, ${sessions.at(-1).trades})`, regimes.at(-1) && regimes.at(-1).expectancy_r < 0 && `regime ${regimes.at(-1).key} (${regimes.at(-1).expectancy_r}R, ${regimes.at(-1).trades})`].filter(Boolean),
    decay: decayOf(unit), dataset: unit.dataset.sha256, verified_at: unit.at, source: 'BACKTEST (historical, delayed public data)',
  };
  const brain = (await storage.get(BRAIN_KEY)) || [];
  await storage.put(BRAIN_KEY, [entry, ...brain.filter((b) => b.id !== entry.id)].slice(0, 300));
}
export async function readBrain(storage) { return (await storage.get(BRAIN_KEY)) || []; }

// ─── HISTORICAL RESEARCH LOOP: jobs, cache, checkpoints ───────────────────────

const PROFILE_BUDGET = { LIGHT: 0, NORMAL: 8_000, DEEP: 20_000 };
/** A research job: every applicable strategy × timeframe unit for a market, under-tested buckets first. */
export async function queueJob(storage, { market = 'MNQ', timeframes = TF_IDS, strategies = null, name = null } = {}, now = Date.now()) {
  const state = await readState(storage);
  const defs = strategyDefinitions().filter((d) => !strategies || strategies.includes(d.strategy_id));
  const existing = await readUnits(storage, (u) => u.market === market);
  const trades = (s, tf) => existing.find((u) => u.strategy_id === s && u.timeframe === tf)?.all?.trades ?? -1;
  const units = [];
  for (const tf of timeframes) for (const d of defs) if (d.timeframes.includes(tf)) units.push(`${d.strategy_id}|${tf}`);
  units.sort((a, b) => trades(...a.split('|')) - trades(...b.split('|')));
  const job = { id: `job-${now.toString(36)}`, name: name || `${market} historical research`, market, status: 'queued', created_at: iso(now), completed: [], cached: [], remaining: units, errors: [], progress: 0 };
  state.jobs = [job, ...state.jobs.filter((j) => j.status === 'running' || j.status === 'queued' || Date.parse(j.created_at) > now - 7 * DAY)].slice(0, 10);
  await saveState(storage, state);
  return job;
}
export async function cancelJob(storage, id) {
  const state = await readState(storage);
  const job = state.jobs.find((j) => j.id === id);
  if (!job || !['queued', 'running'].includes(job.status)) return { ok: false };
  job.status = 'cancelled';
  await saveState(storage, state);
  return { ok: true, job };
}

/**
 * One research step inside a CPU budget: the oldest queued or running job advances unit by unit, checkpointing after
 * each, so a restart resumes where it stopped. An unchanged dataset + strategy version + cost model + range is never
 * re-run (evidence cache). LIGHT runs no historical batches.
 */
export async function researchStep(storage, { fetcher = fetch, now = Date.now(), budgetMs = null, clock = Date.now } = {}) {
  const state = await readState(storage);
  const budget = budgetMs ?? PROFILE_BUDGET[state.profile] ?? PROFILE_BUDGET.NORMAL;
  const job = state.jobs.find((j) => j.status === 'running') || state.jobs.find((j) => j.status === 'queued');
  if (!job || !budget) return { ran: 0, job: job?.id || null };
  job.status = 'running';
  const start = clock();
  let ran = 0;
  const datasets = {};
  // At least one unit per step, so a slow unit can never stall a job; then as many as the budget allows.
  while (job.remaining.length && (ran === 0 && !job.__stepped || clock() - start < budget)) {
    job.__stepped = true;
    const unitId = job.remaining[0];
    const [strategyId, tf] = unitId.split('|');
    try {
      datasets[tf] ||= await acquireDataset(storage, { market: job.market, tf }, { fetcher, now });
      const ds = datasets[tf];
      if (!ds.ok) {
        await saveUnit(storage, { ok: false, strategy_id: strategyId, market: job.market, timeframe: tf, mode: 'BACKTEST', reason: ds.reason, options: ds.options || [], at: iso(now) });
        job.completed.push(unitId);
      } else {
        const key = cacheKey({ strategyId, market: job.market, tf, sha256: ds.manifest.sha256, profile: 'NORMAL', deep: state.profile === 'DEEP' });
        if (state.cache[`${strategyId}|${job.market}|${tf}`] === key) job.cached.push(unitId);
        else {
          const unit = { ...evaluateUnit({ strategyId, market: job.market, tf, bars: ds.bars, manifest: ds.manifest, deep: state.profile === 'DEEP' }), at: iso(now) };
          await saveUnit(storage, unit);
          if (unit.ok) { await addReceipt(storage, unit); await populateBrain(storage, unit); }
          state.cache[`${strategyId}|${job.market}|${tf}`] = key;
          job.completed.push(unitId);
          ran++;
        }
      }
    } catch (e) {
      job.errors = [...job.errors, `${unitId}: ${String(e?.message || e).slice(0, 160)}`].slice(-20);
      job.completed.push(unitId);
    }
    job.remaining.shift();
    const total = job.completed.length + job.cached.length + job.remaining.length;
    job.progress = total ? r2((job.completed.length + job.cached.length) / total) : 1;
    await saveState(storage, state);   // checkpoint after every unit
  }
  delete job.__stepped;
  if (!job.remaining.length) job.status = 'done', job.finished_at = iso(now);
  await saveState(storage, state);
  return { ran, job: job.id, remaining: job.remaining.length, ms: clock() - start };
}

/** Queues the daily refresh (NORMAL/DEEP): only units whose data or rules changed run again (cache). */
export async function autoQueue(storage, now = Date.now()) {
  const state = await readState(storage);
  if (state.profile === 'LIGHT') return null;
  if (state.last_auto && now - Date.parse(state.last_auto) < DAY) return null;
  if (state.jobs.some((j) => j.status === 'queued' || j.status === 'running')) return null;
  const job = await queueJob(storage, { market: 'MNQ', name: 'Daily MNQ research refresh' }, now);
  const s2 = await readState(storage);
  s2.last_auto = iso(now);
  await saveState(storage, s2);
  return job;
}

export async function setProfile(storage, profile) {
  if (!['LIGHT', 'NORMAL', 'DEEP'].includes(profile)) return { ok: false };
  const state = await readState(storage);
  state.profile = profile;
  await saveState(storage, state);
  return { ok: true, profile };
}

// ─── Forward evidence: PAPER and FORWARD_SIM, never mixed with BACKTEST ───────

/**
 * Regroups the forward journals into their own buckets. PAPER: trading_live.js forward paper (the evidence engine on
 * real-time-gated bars). Legacy backtest records in the same journal keep their own mode and a LEGACY flag. A field the
 * old record never had (timeframe, regime) is marked LEGACY / PARTIAL METADATA, never invented; session and weekday are
 * derived from the trade's real timestamp.
 */
export async function forwardEvidence(storage) {
  const trades = await readTrades(storage);
  const groups = {};
  for (const t of trades) {
    const mode = t.environment === 'paper' ? 'PAPER' : 'BACKTEST_LEGACY';
    const res = t.data?.resolution;
    const tf = TF_IDS.includes(res) ? res : res === 'daily' ? '1D' : res === '5m' ? '5m' : 'LEGACY';
    const partial = tf === 'LEGACY' || !t.condition;
    const item = { t: t.entry.time, x: t.exit.time, r: r4(t.r_net), s: sessionAt(t.entry.time, tf === 'LEGACY' ? '5m' : tf), g: t.condition?.trend ? `legacy:${t.condition.trend}` : 'LEGACY / PARTIAL METADATA', w: WEEKDAYS[new Date(`${etParts(t.entry.time).day}T12:00:00Z`).getUTCDay()], partial };
    const key = `${t.strategy}|${tf}|${mode}`;
    (groups[key] ||= { strategy_id: t.strategy, timeframe: tf, mode, market: t.contract || 'MNQ', items: [] }).items.push(item);
  }
  return Object.values(groups).map(({ items, ...g }) => ({ ...g, ...stats(items), partial_metadata: items.some((t) => t.partial), sessions: breakdownBy(items, 's') }));
}

// ─── Views for the API ───────────────────────────────────────────────────────

function strategyCard(def, units, paper, owner, forwardByTf = {}) {
  if (!def.defined) return { strategy_id: def.strategy_id, name: def.name, defined: false, best_timeframe: null, qualified_buckets: 0, expectancy_r: null, win_rate: null, status: 'UNDEFINED', readiness: 'NOT TESTABLE', why: def.why, sample_trades: 0, paper_trades: 0 };
  const mine = units.filter((u) => u.strategy_id === def.strategy_id && u.ok);
  const qualified = mine.filter((u) => evidenceState(u) === 'QUALIFIED');
  const best = [...qualified].sort((a, b) => b.oos.expectancy_r - a.oos.expectancy_r)[0] || [...mine].sort((a, b) => b.all.trades - a.all.trades)[0];
  return { strategy_id: def.strategy_id, name: def.name, family: def.family, defined: true, best_timeframe: best?.timeframe || null, qualified_buckets: qualified.length,
    expectancy_r: best ? (qualified.length ? best.oos.expectancy_r : best.all.expectancy_r) : null, win_rate: best?.all.win_rate ?? null,
    status: statusOf(mine, owner), readiness: readinessOf(mine, paper),
    // Sample sizes behind those numbers, so a setup's evidence badge can show them (Signal Mode).
    sample_trades: best?.all.trades ?? 0, paper_trades: paper?.trades ?? 0,
    // Every timeframe's evidence bucket (#109), not only the best one: historical trades per timeframe from the same
    // units, and forward paper trades per timeframe. Paper runs on 5-minute bars only, so other timeframes show zero there.
    timeframes: TF_IDS.map((tf) => {
      const u = mine.find((x) => x.timeframe === tf);
      return { tf, historical_trades: u?.all.trades ?? 0, evidence: u ? evidenceState(u) : 'NOT RESEARCHED', forward_trades: forwardByTf[tf] ?? 0, min_required: MIN_CLOSED_TRADES };
    }) };
}

export async function researchView(storage, { now = Date.now() } = {}) {
  const [state, units, forward, liveFeed, liveState] = await Promise.all([readState(storage), readUnits(storage), forwardEvidence(storage), storage.get('live_paper_feed'), storage.get('live_paper_state')]);
  const defs = [...strategyDefinitions(), ...UNDEFINED_STRATEGIES.map((u) => ({ ...u, defined: false }))];
  const paperBy = Object.fromEntries(forward.filter((f) => f.mode === 'PAPER').map((f) => [`${f.strategy_id}|${f.timeframe}`, f]));
  const paperByTf = (id) => forward.filter((f) => f.mode === 'PAPER' && f.strategy_id === id).reduce((a, f) => ({ ...a, [f.timeframe]: (a[f.timeframe] ?? 0) + f.trades }), {});
  const paperOf = (id) => forward.filter((f) => f.mode === 'PAPER' && f.strategy_id === id).reduce((a, f) => ({ trades: a.trades + f.trades, expectancy_r: f.trades ? f.expectancy_r : a.expectancy_r }), { trades: 0, expectancy_r: null });
  const bars = liveFeed?.bars || [];
  const last = bars.at(-1);
  const fresh = freshness(bars, '5m', now);
  const regime = bars.length > 60 ? classifyRegimes(bars).at(-1) : null;
  const ctx = { market: 'MNQ', session: last ? sessionAt(last.t, '5m') : null, regime: regime?.structure || null, threshold: state.threshold, stale: !fresh.fresh, staleWhy: fresh.why };
  const sel = selectStrategies(units.filter((u) => u.market === 'MNQ'), ctx, paperBy);
  const today = tradeDayOf(now);
  const paperToday = (await readTrades(storage, (t) => t.environment === 'paper' && tradeDayOf(t.exit.time) === today));
  const coverage = [];
  for (const m of MARKETS) for (const tf of TF_IDS) {
    const man = await storage.get(`${DS_PREFIX}${m}:${tf}`);
    if (man) coverage.push({ market: m, resolution: tf, first: man.first, last: man.last, years: man.years, provider: man.provider, proxy: Boolean(man.proxy), bars: man.bars, missing: man.missing, derived_from: man.derived_from });
  }
  return {
    markets: [...MARKETS],
    live: { symbol: 'MNQ', price: last?.c ?? null, as_of: last ? iso(Date.parse(last.t) + 5 * MIN) : null, stale: !fresh.fresh, stale_reason: fresh.why, mode: liveState?.enabled ? 'PAPER' : 'RESEARCH',
      data_source: liveFeed?.source || liveFeed?.provider || (bars.length ? 'Yahoo MNQ=F (delayed)' : 'no feed yet'), pnl_today: r2(paperToday.reduce((a, t) => a + (t.net_pnl || 0), 0)),
      win_rate: paperToday.length ? r2(paperToday.filter((t) => t.net_pnl > 0).length / paperToday.length) : null, open_positions: null,
      regime: { label: regimeLabel(regime), features: regime || {} } },
    best_now: sel.decision === 'CANDIDATES' ? sel.ranked.slice(0, 3) : [],
    best_now_reason: sel.decision === 'CANDIDATES' ? null : sel.reason,
    strategies: defs.map((d) => strategyCard(d, units, paperOf(d.strategy_id), state.owner[d.strategy_id] || {}, paperByTf(d.strategy_id))),
    dashboard: {
      strategies_tested: new Set(units.filter((u) => u.ok).map((u) => u.strategy_id)).size,
      buckets_qualified: units.filter((u) => evidenceState(u) === 'QUALIFIED').length,
      backtest_trades: units.filter((u) => u.ok).reduce((a, u) => a + u.all.trades, 0),
      forward_paper_trades: forward.filter((f) => f.mode === 'PAPER').reduce((a, f) => a + f.trades, 0),
      coverage, min_closed_trades_per_bucket: MIN_CLOSED_TRADES,
    },
    jobs: state.jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, progress: j.progress, completed: j.completed, cached: j.cached, remaining: j.remaining, errors: j.errors })),
    profile: state.profile,
    paper_learning: { enabled: Boolean(liveState?.enabled), since: liveState?.started_at || null },
    champions: Object.values(state.champions || {}),
    live_trading: 'Research and paper only. No readiness level authorizes live orders; live trading keeps every existing approval gate.',
  };
}

export async function strategyView(storage, id, market = 'MNQ') {
  const def = definitionOf(id) || UNDEFINED_STRATEGIES.find((u) => u.strategy_id === id);
  if (!def) return null;
  const units = await readUnits(storage, (u) => u.strategy_id === id && u.market === market);
  const forward = (await forwardEvidence(storage)).filter((f) => f.strategy_id === id);
  const paper = forward.filter((f) => f.mode === 'PAPER').reduce((a, f) => ({ trades: a.trades + f.trades, expectancy_r: f.expectancy_r }), { trades: 0, expectancy_r: null });
  const byTf = Object.fromEntries(units.map((u) => [u.timeframe, u]));
  const ok = units.filter((u) => u.ok);
  const best = [...ok].filter((u) => evidenceState(u) === 'QUALIFIED').sort((a, b) => b.oos.expectancy_r - a.oos.expectancy_r)[0] || [...ok].sort((a, b) => b.all.trades - a.all.trades)[0] || null;
  const top = (rows) => [...(rows || [])].filter((r) => r.trades >= 10).sort((a, b) => b.expectancy_r - a.expectancy_r)[0]?.key || null;
  const receipts = ((await storage.get(RECEIPTS_KEY)) || []).filter((r) => r.strategy === id && r.market === market);
  return {
    strategy: def.defined === false || !def.engine ? { ...def, defined: false } : { ...def, look_ahead_audit: best?.look_ahead || 'not run yet' },
    overview: { best_timeframe: best?.timeframe || null, best_session: top(best?.sessions), best_regime: top(best?.regimes), historical_expectancy_r: best?.all.expectancy_r ?? null, recent_expectancy_r: best?.recent?.expectancy_r ?? null, paper },
    timeframes: TF_IDS.map((tf) => {
      const u = byTf[tf];
      const applicable = def.timeframes?.includes(tf);
      if (!applicable) return { tf, trades: 0, min_required: MIN_CLOSED_TRADES, win_rate: null, avg_r: null, pf: null, max_dd_r: null, evidence: 'N/A', status: 'not defined for this timeframe', available: false, why: `Rules need ${def.timeframes?.join(', ') || 'written rules'}.` };
      if (!u) return { tf, trades: 0, min_required: MIN_CLOSED_TRADES, win_rate: null, avg_r: null, pf: null, max_dd_r: null, evidence: 'NOT READY', status: 'not run yet', available: null, why: 'Not researched yet.' };
      if (!u.ok) return { tf, trades: 0, min_required: MIN_CLOSED_TRADES, win_rate: null, avg_r: null, pf: null, max_dd_r: null, evidence: 'NO DATA', status: 'no data', available: false, why: u.reason };
      return { tf, trades: u.all.trades, min_required: MIN_CLOSED_TRADES, win_rate: u.all.win_rate, avg_r: u.all.expectancy_r, oos_trades: u.oos.trades, oos_expectancy_r: u.oos.expectancy_r, pf: u.all.pf,
        max_dd_r: u.all.max_dd_r, evidence: evidenceState(u), status: decayOf(u), available: true, why: null, range: [u.dataset.first, u.dataset.last], provider: u.dataset.provider, look_ahead: u.look_ahead };
    }),
    sessions: (best?.sessions || []).map((r) => ({ session: r.key, trades: r.trades, expectancy_r: r.expectancy_r })),
    regimes: (best?.regimes || []).map((r) => ({ regime: r.key, trades: r.trades, expectancy_r: r.expectancy_r })),
    hours: (best?.hours || []).map((r) => ({ hour: Number(r.key), trades: r.trades, expectancy_r: r.expectancy_r })),
    weekdays: (best?.weekdays || []).map((r) => ({ weekday: r.key, trades: r.trades, expectancy_r: r.expectancy_r })),
    periods: best?.periods || [],
    decay: best ? decayOf(best) : 'INSUFFICIENT DATA',
    monte_carlo: best?.monte_carlo || null, sensitivity: best?.sensitivity || null, stress: best?.stress || null,
    forward: forward.map(({ strategy_id, ...f }) => f),
    receipts,
  };
}

export async function matrixView(storage, market = 'MNQ') {
  const units = await readUnits(storage, (u) => u.market === market);
  const defs = strategyDefinitions();
  return {
    market, timeframes: [...TF_IDS], min_closed_trades: MIN_CLOSED_TRADES,
    rows: defs.map((d) => ({ strategy_id: d.strategy_id, name: d.name, cells: Object.fromEntries(TF_IDS.map((tf) => {
      if (!d.timeframes.includes(tf)) return [tf, { state: 'No data', trades: 0, expectancy_r: null, applicable: false }];
      const u = units.find((x) => x.strategy_id === d.strategy_id && x.timeframe === tf);
      return [tf, { state: u ? matrixState(u) : 'No data', trades: u?.ok ? u.all.trades : 0, expectancy_r: u?.ok ? (u.oos.trades ? u.oos.expectancy_r : u.all.expectancy_r) : null }];
    })) })),
  };
}

// ─── Spoken answers (deterministic, no model) ─────────────────────────────────

const TF_WORDS = { '15 second': '15s', '15-second': '15s', '30 second': '30s', '1 minute': '1m', 'one minute': '1m', '2 minute': '2m', 'two minute': '2m', '5 minute': '5m', 'five minute': '5m', '15 minute': '15m', 'fifteen minute': '15m', '30 minute': '30m', 'thirty minute': '30m', '1 hour': '1h', 'one hour': '1h', 'hourly': '1h', '4 hour': '4h', 'four hour': '4h', 'daily': '1D', 'weekly': '1W', 'monthly': '1M' };
/**
 * The research question in [message]. A follow-up ("and on the 15 minute?", "the same for the VWAP one") carries the
 * owner's new words alone in `followup` and the earlier question in `referent` (speech_intent.js): the new timeframe or
 * strategy comes from the new words and the rest from the earlier question. A new subject this route cannot combine
 * with the earlier question asks one short question (kind 'clarify'); nothing new named leaves the turn alone (null).
 */
export function researchIntent(message, { followup = '', referent = '' } = {}) {
  if (followup) {
    const own = researchIntent(followup);
    if (own) return own;
    const base = researchIntent(referent);
    if (!base) return null;
    const words = String(followup).toLowerCase();
    const tf = tfFromWords(words);
    const sid = strategyFromWords(words);
    if (!tf && !sid) return null;
    if (base.kind === 'strategy' || sid) return { kind: 'strategy', strategy_id: sid || base.strategy_id, timeframe: tf || (base.kind === 'strategy' ? base.timeframe : null) };
    return { kind: 'clarify', question: `Best-now ranks every timeframe together, sir. For one timeframe, name the strategy: "how is the EMA pullback doing on ${tfOf(tf)?.label || tf}".` };
  }
  const t = String(message || '').toLowerCase().replace(/[’]/g, "'").replace(/^(?:hey |ok |okay )?(?:che|chey|chay)[,:]?\s*/, '').trim();
  if (/\b(?:which|what) strateg(?:y|ies) (?:is|are|looks?) (?:the )?best (?:right )?now\b|\bbest strategy (?:right )?now\b/.test(t)) return { kind: 'best_now' };
  if (/\bwhat strateg(?:y|ies) (?:look|looks|are|is) (?:the )?strongest (?:today|now)\b/.test(t)) return { kind: 'best_now', today: true };
  let m;
  if ((m = /\bwhat (?:historical )?(?:history|data) (?:do you have|have you got) (?:for|on) (mnq|nq)\b/.exec(t))) return { kind: 'history', market: m[1].toUpperCase() };
  if (/\b(?:start|turn on|enable|resume) (?:the )?paper learning\b/.test(t)) return { kind: 'paper', enabled: true };
  if (/\b(?:stop|turn off|disable|pause) (?:the )?paper learning\b/.test(t)) return { kind: 'paper', enabled: false };
  if ((m = /\brun (?:a )?(deep|historical|normal) research (?:on|for) (mnq|nq)\b/.exec(t))) return { kind: 'run', market: m[2].toUpperCase(), deep: m[1] === 'deep' };
  if ((m = /\bhow (?:is|are|has) (?:the )?(.{3,40}?) (?:doing|performing|done)(?: on (?:the )?(.{1,20}?)(?: chart| bars?| timeframe)?)?$/.exec(t))) {
    const sid = strategyFromWords(m[1]);
    if (sid) return { kind: 'strategy', strategy_id: sid, timeframe: m[2] ? tfFromWords(m[2]) : null };
  }
  return null;
}
export function tfFromWords(words) {
  const w = String(words || '').toLowerCase().replace(/s\b/, '').trim();
  if (TF_IDS.includes(words)) return words;
  // Whole words only: "15 minute" contains "5 minute" and was read as 5m before (subject-loss audit, 2026-10-24).
  for (const [k, v] of Object.entries(TF_WORDS)) if (new RegExp(`(?:^|[^0-9a-z])${k}(?![0-9a-z])`).test(w)) return v;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(w.replace(/\s+/g, ''));
  return m ? ({ s: `${m[1]}s`, m: `${m[1]}m`, h: `${m[1]}h`, d: '1D' }[m[2]]) : null;
}
const STRATEGY_WORDS = [[/\b86\b|p2p|overnight range/, 'p2p86-style-5m'], [/ema|pullback/, 'ema-pullback-5m'], [/vwap/, 'vwap-revert-5m'], [/rsi/, 'rsi-revert-5m'], [/opening range|\borb\b/, 'orb-15m'], [/silver bullet/, 'silver-bullet-5m'],
  [/order block/, 'order-block-5m'], [/fair value|\bfvg\b/, 'fvg-retest-5m'], [/structure shift|\bmss\b/, 'sweep-mss-5m'], [/previous day|pdh|pdl/, 'pdhl-sweep-5m'], [/sweep|reclaim|liquidity/, 'sweep-reclaim-5m']];
export function strategyFromWords(words) { const w = String(words || '').toLowerCase(); return STRATEGY_WORDS.find(([re]) => re.test(w))?.[1] || null; }

export function speakBestNow(view) {
  if (!view.best_now.length) return `${view.best_now_reason || 'No strategy currently meets your threshold.'} ${view.dashboard.buckets_qualified} strategy-timeframe buckets have qualified so far, each with at least ${MIN_CLOSED_TRADES} closed trades.`;
  const b = view.best_now[0];
  const tfl = tfOf(b.timeframe)?.label || b.timeframe;
  return `MNQ, ${tfl}, ${b.session || 'all sessions'}: ${b.name} ranks highest, evidence ${b.evidence_score} of 100. Historical ${b.historical_expectancy_r}R a trade, out-of-sample ${b.expectancy_r}R${b.paper_expectancy_r != null ? `, forward paper ${b.paper_expectancy_r}R` : ', no forward paper sample yet'}, on ${b.sample} backtest trades from ${String(b.window.from).slice(0, 10)} to ${String(b.window.to).slice(0, 10)}. Confidence ${b.confidence}. This is evidence, not a guarantee, and it authorizes paper only.`;
}
export function speakStrategy(sv, tf = null) {
  const name = sv.strategy.name;
  if (sv.strategy.defined === false) return `${name} cannot be tested: ${sv.strategy.why}`;
  const rows = sv.timeframes.filter((r) => (tf ? r.tf === tf : r.available));
  if (!rows.length) return `${name} has no research results yet. Say "run historical research on MNQ" to start.`;
  return `${name}: ${rows.map((r) => (r.evidence === 'NO DATA' ? `${r.tf}, no data (${r.why})` : r.evidence === 'N/A' ? `${r.tf}, not defined` : r.trades < MIN_CLOSED_TRADES ? `${r.tf}, ${r.trades} of ${MIN_CLOSED_TRADES} trades, not ready` : `${r.tf}, ${r.trades} trades, ${Math.round((r.win_rate || 0) * 100)}% wins, ${r.avg_r}R average, out-of-sample ${r.oos_expectancy_r}R, ${r.evidence.toLowerCase()}`)).join('; ')}. Overall ${sv.decay.toLowerCase()}.`;
}
export function speakHistory(view, market) {
  const rows = view.dashboard.coverage.filter((c) => c.market === market);
  if (!rows.length) return `I have not fetched any ${market} history yet. Say "run historical research on ${market}" to fetch and verify it.`;
  const s = rows.map((c) => `${c.resolution}: ${String(c.first).slice(0, 10)} to ${String(c.last).slice(0, 10)}, ${c.years} years, ${c.bars} bars from ${c.provider}${c.derived_from ? `, built from ${c.derived_from.split(' ')[0]}` : ''}`).join('; ');
  return `${market} history I have verified: ${s}. 15- and 30-second history is not available from any source CHE can reach.${market === 'MNQ' ? ' MNQ only exists since May 2019; longer studies use NQ.' : ''}`;
}

/** The alarm wakes every minute while a research job is queued or running, and not at all otherwise (no polling). */
export async function nextResearchAt(storage, now = Date.now()) {
  const state = await readState(storage);
  return state.profile !== 'LIGHT' && state.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? now + 60_000 : null;
}
