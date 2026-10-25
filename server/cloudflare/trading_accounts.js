// Trading Room v3 (owner, 2026-10-25: "fix, simplify and verify"): the record sets behind the dashboard stats and the
// unified P&L calendar, read from the same normalized trades the calendar already uses (che_calendars.sourceTrades).
// Nothing is computed into a headline number here: the phone computes realized P&L, win rate, W/L, open positions and
// drawdown with one tested function (lib/trading/che_account_stats.dart) from these records, so every figure on the
// screen traces back to rows the owner can open.
//
// Kept apart, never summed: CHE forward paper futures (USD, delayed 5-minute bars), CHE forward paper crypto (USD,
// Coinbase public candles) and the strategy simulation (R only). Backtest records are never read here.
//
// One time zone on screen: America/New_York. A futures trade belongs to its CME trading date (the session that opens
// at 6:00 PM New York the evening before; trading_evidence.tradeDayOf). A crypto trade belongs to the calendar date of
// its exit in New York. Both rules handle daylight saving through Intl.
import { BREAK_EVEN, dayColor, monthGrid, shiftMonth, sourceTrades } from './che_calendars.js';
import { tradeDayOf } from './trading_evidence.js';
import { ownerDayKey } from './office_board.js';
import { readSkips } from './trading_visual.js';
import { readSimState } from './strategy_sim.js';
import { readLivePortfolios } from './trading_live.js';
import { cryptoView } from './crypto_markets.js';

export const CALENDAR_TZ = 'America/New_York';
export const KINDS = Object.freeze({
  forward_paper: { label: 'CHE forward paper', unit: 'USD' },
  simulation: { label: 'Strategy simulation', unit: 'R' },
});
const MAX_ROWS = 5000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CRYPTO = /^(?:BTC|XBT|ETH)\b/;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** The instrument a record traded, in the owner's words (BTC, ETH, MNQ, NQ, ES…), and its market. */
export function instrumentOf(t) {
  const raw = String(t.symbol || t.contract || '').toUpperCase().replace(/^(?:COINBASE|KRAKEN|FUTURES):/, '');
  if (t.market === 'crypto' || CRYPTO.test(raw)) return { instrument: raw.startsWith('ETH') ? 'ETH' : 'BTC', market: 'crypto' };
  if (t.market === 'stocks') return { instrument: raw, market: 'stocks' };
  const root = raw.replace(/=F$/, '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '');
  return { instrument: root || raw || 'UNKNOWN', market: 'futures' };
}

/** The date a closed trade counts on: the CME trading date for futures, the New York calendar date for crypto. */
export function tradeDateOf(t, market = instrumentOf(t).market) {
  if (!t.exit_time || !Number.isFinite(Date.parse(t.exit_time))) return null;
  return market === 'futures' ? tradeDayOf(t.exit_time) : ownerDayKey(t.exit_time, CALENDAR_TZ);
}

const row = (t, kind) => {
  const { instrument, market } = instrumentOf(t);
  return {
    id: t.id, kind, kind_label: KINDS[kind].label, unit: KINDS[kind].unit, symbol: instrument, market, strategy: t.strategy || 'unnamed', side: t.side,
    timeframe: t.timeframe || null, entry_time: t.entry_time || null, exit_time: t.exit_time || null, entry_price: t.entry_price ?? null, exit_price: t.exit_price ?? null,
    net: kind === 'simulation' ? null : (Number.isFinite(t.net) ? t.net : null), r: Number.isFinite(t.r) ? t.r : null, result: t.result || null,
    exit_reason: t.exit_reason || null, date: tradeDateOf(t, market), date_basis: market === 'futures' ? 'CME trading date' : 'New York calendar date', replay: t.replay !== false,
  };
};

/** Every closed paper and simulation record, normalized, with any read failure named. */
async function readAll(storage) {
  const out = []; const errors = [];
  for (const [source, kind] of [['paper', 'forward_paper'], ['sim', 'simulation']]) {
    try {
      const { trades, read } = await sourceTrades(storage, source);
      for (const t of trades) if (t.exit_time) out.push(row(t, kind));
      for (const r of read) if (r.read === false) errors.push({ kind, error: r.error || `${r.label} could not be read` });
    } catch (e) {
      errors.push({ kind, error: String(e?.message || e).slice(0, 160) });
    }
  }
  out.sort((a, b) => String(a.exit_time).localeCompare(String(b.exit_time)));
  return { trades: out, errors };
}

const safe = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: String(e?.message || e).slice(0, 160) }; } };

/** GET /api/trading/calendar?view=accounts: each account's closed records, open positions and journal, kept apart. */
export async function accountsView(storage, { now = Date.now() } = {}) {
  const { trades, errors } = await readAll(storage);
  const openFutures = await safe(async () => (await readLivePortfolios(storage)).filter((pf) => pf.open).length);
  const openCrypto = await safe(async () => (await cryptoView(storage, now)).simulated.open_positions.length);
  const openSim = await safe(async () => Object.keys((await readSimState(storage)).open || {}).length);
  const skips = await safe(async () => (await readSkips(storage)).slice(-5).reverse().map((s) => ({ time: s.time, strategy: s.strategy, reason: s.reason, side: s.side })));
  const errorOf = (kind) => errors.filter((e) => e.kind === kind).map((e) => e.error).join('; ') || null;
  const account = (id, label, kind, list, open, journal = []) => {
    const rows = list.slice(-MAX_ROWS);
    const newest = rows.at(-1)?.exit_time || null;
    return { id, label, kind, unit: KINDS[kind].unit, trades: rows, truncated: list.length > rows.length, open_positions: open.error ? null : open.value,
      open_error: open.error || null, updated_at: newest, read: !errorOf(kind), error: errorOf(kind), journal };
  };
  const paper = trades.filter((t) => t.kind === 'forward_paper');
  return {
    ok: true, view: 'accounts', time_zone: CALENDAR_TZ, checked_at: new Date(now).toISOString(), excluded: ['historical_backtest'],
    note: 'Each account is its own record set; none is added to another, and backtests are never included.',
    accounts: [
      account('forward_paper_futures', 'CHE forward paper · futures', 'forward_paper', paper.filter((t) => t.market === 'futures'), openFutures, skips.value || []),
      account('forward_paper_crypto', 'CHE forward paper · crypto', 'forward_paper', paper.filter((t) => t.market === 'crypto'), openCrypto),
      account('simulation', 'Strategy simulation (R)', 'simulation', trades.filter((t) => t.kind === 'simulation'), openSim),
    ],
    paper_only: true, live_orders: 'disabled',
  };
}

function totalsOf(list) {
  const kinds = {};
  for (const kind of Object.keys(KINDS)) {
    const rows = list.filter((t) => t.kind === kind);
    if (!rows.length) continue;
    const unit = KINDS[kind].unit;
    const vals = rows.map((t) => (unit === 'R' ? t.r : t.net)).filter(Number.isFinite);
    kinds[kind] = { label: KINDS[kind].label, unit, trades: rows.length, wins: rows.filter((t) => t.result === 'win').length, losses: rows.filter((t) => t.result === 'loss').length,
      net: vals.length ? r2(vals.reduce((s, v) => s + v, 0)) : null, missing_values: rows.length - vals.length };
  }
  return {
    trades: list.length, wins: list.filter((t) => t.result === 'win').length, losses: list.filter((t) => t.result === 'loss').length,
    instruments: [...new Set(list.map((t) => t.symbol))].sort(), strategies: [...new Set(list.map((t) => t.strategy))].sort(), kinds,
  };
}

const colorOf = (tot) => {
  const k = tot.kinds.forward_paper || tot.kinds.simulation;
  return k ? dayColor(k.net, k.unit, k.trades) : null;
};

/**
 * GET /api/trading/calendar?view=unified&market=all|futures|crypto[&month=YYYY-MM|&day=YYYY-MM-DD]
 * One calendar over the same dates for every market; each day keeps its kinds apart (dollars and R never added).
 */
export async function unifiedCalendar(storage, { month = '', day = '', market = 'all', now = Date.now() } = {}) {
  if (!['all', 'futures', 'crypto'].includes(market)) market = 'all';
  const { trades, errors } = await readAll(storage);
  const shown = trades.filter((t) => t.date && t.market !== 'stocks' && (market === 'all' || t.market === market));
  const base = { ok: true, view: 'unified', market, markets: ['all', 'futures', 'crypto'], time_zone: CALENDAR_TZ,
    basis_label: 'New York time. Futures count on their CME trading date (the session opens 6:00 PM New York the evening before); crypto on its New York calendar date.',
    break_even: BREAK_EVEN, kinds: KINDS, errors, paper_only: true, live_orders: 'disabled' };
  if (DAY.test(day)) {
    const list = shown.filter((t) => t.date === day);
    return { ...base, day, totals: totalsOf(list), color: colorOf(totalsOf(list)), trades: list };
  }
  if (!MONTH.test(month)) month = ownerDayKey(new Date(now), CALENDAR_TZ).slice(0, 7);
  const byDay = {};
  for (const t of shown) if (t.date.startsWith(month)) (byDay[t.date] ||= []).push(t);
  const weeks = monthGrid(month).map((w) => ({
    days: w.map((d) => { const tot = totalsOf(byDay[d] || []); return { date: d, ...tot, color: colorOf(tot) }; }),
  }));
  const all = Object.values(byDay).flat();
  return { ...base, month, prev: shiftMonth(month, -1), next: shiftMonth(month, 1), weeks, totals: totalsOf(all), empty: all.length === 0 };
}

/** Spoken summary of a unified month or day: each kind on its own, never added together. */
export function speakUnified(v) {
  const kinds = Object.values(v.totals.kinds).map((k) => `${k.label}: ${k.trades} trades, ${k.wins} wins, ${k.losses} losses, net ${k.net == null ? 'not recorded' : k.unit === 'R' ? `${k.net} R` : `${k.net < 0 ? 'minus ' : ''}$${Math.abs(k.net).toFixed(2)}`}`);
  const where = v.market === 'all' ? 'all markets' : v.market;
  const when = v.day || v.month;
  if (!v.totals.trades) return `No trade closed in ${when} for ${where}. Nothing is shown as a sample.`;
  return `${when}, ${where}, New York time: ${kinds.join('. ')}. Instruments: ${v.totals.instruments.join(', ')}.`;
}
