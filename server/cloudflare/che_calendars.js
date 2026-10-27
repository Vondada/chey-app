// CHE's two calendars (owner, 2026-10-24): "show me what we accomplished, what remains pending, and whether her
// trading is genuinely improving". Both are read-only views over records CHE already keeps; neither adds an
// engine, a ledger or a write path, and neither shows sample data.
//
// Trading P&L calendar: the trade records trading_visual.readVisualTrades already normalizes and gives stable
// IDs (one ID per natural key, duplicates reported and never counted twice), plus the crypto forward paper
// journal (evr:* with market 'crypto'). Three sources are kept apart and never summed together:
//   sim    — the 1-minute strategy simulation (strategy_sim.js), measured in R only (no dollars are recorded);
//   paper  — CHE's forward paper journal (evr:paper:*, 5-minute DELAYED bars, futures and crypto), in dollars;
//   broker — the Alpaca PAPER account: its fills as Alpaca returned them (broker_alpaca.storeAlpacaFills keeps them on
//            every read), realized first in first out by the day each closing fill happened, plus the orders CHE
//            placed. Days before fills were kept show orders only; no P&L is made up for them.
// A trade belongs to the day it closed, in the owner's time zone (office_board.ownerTimeZone: CHE_OWNER_TIMEZONE,
// else America/Chicago). `basis=cme` buckets by the CME trading day instead (trading_evidence.tradeDayOf, the
// day the existing daily P&L card uses), so a figure seen there can be reconciled row by row.
//
// Office calendar: per day, the jobs and tasks CHE recorded (cloud_computer.cloudJobs: coding, cloud tasks,
// REA, renders, film, app builds and Creation Engine jobs; the Office's team tasks and coordinated jobs; the
// objective graph; owner approvals; and the reliability ledger's counts).
import { tradeDayOf } from './trading_evidence.js';
import { dayFromWords, metricsOf, readSkips, readVisualTrades } from './trading_visual.js';
import { leaderboard, readSimState, readStoredTrades } from './strategy_sim.js';
import { cloudJobs } from './cloud_computer.js';
import { ownerDayKey, ownerTimeZone } from './office_board.js';
import { readCryptoPaperTrades } from './trade_evidence.js';
import { readAlpacaFills, realizedClosesFromFills } from './broker_alpaca.js';

export const CALENDAR_SOURCE = 'che_calendars';
export const TRADING_SOURCES = Object.freeze({
  sim: { label: 'Strategy simulation', unit: 'R', types: ['simulation'], note: 'Paper strategies on 1-minute bars, measured in R only; no dollar amounts are recorded.' },
  paper: { label: 'Forward paper', unit: 'USD', types: ['forward_paper'], note: 'Simulated fills on DELAYED 5-minute bars as they arrived; no broker order.' },
  broker: { label: 'Paper broker (Alpaca)', unit: 'USD', types: [], note: 'Alpaca PAPER account: realized P&L from the fills Alpaca returned, first in first out, on the day each closing fill happened. Paper account; no money at risk. Fills before CHE began keeping them are not included.' },
});
// Near break-even: a day whose net is inside this band is yellow, not green or red.
export const BREAK_EVEN = Object.freeze({ USD: 25, R: 0.1 });
export const WINDOWS = Object.freeze([7, 30, 90]);
const MIN_EVIDENCE = 30;
const BROKER_ORDERS = 'alpaca_paper_orders';

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09" → its days, Monday-first weeks (each week lists its in-month days only). */
export function monthGrid(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = []; let week = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    week.push(date.toISOString().slice(0, 10));
    if (date.getUTCDay() === 0 || d === days) { out.push(week); week = []; }
  }
  return out;
}

export function monthOf(now = Date.now(), tz = 'America/Chicago') { return ownerDayKey(new Date(now), tz).slice(0, 7); }
export function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** green, red or yellow for one day's net in its unit; null when nothing closed. */
export function dayColor(net, unit, trades) {
  if (!trades || !Number.isFinite(net)) return null;
  if (Math.abs(net) <= BREAK_EVEN[unit]) return 'yellow';
  return net > 0 ? 'green' : 'red';
}

/** The day a closed trade counts on: its exit, in the owner's zone (or the CME trading day). */
export function calendarDay(trade, { tz = 'America/Chicago', basis = 'owner' } = {}) {
  if (!trade.exit_time) return null;
  return basis === 'cme' ? tradeDayOf(trade.exit_time) : ownerDayKey(trade.exit_time, tz);
}

const valueOf = (t, unit) => (unit === 'R' ? t.r : t.net);

/** Day totals for one unit; a trade whose value is missing is counted and named, never treated as 0. */
function dayTotals(list, unit) {
  const usable = list.filter((t) => Number.isFinite(valueOf(t, unit)));
  const wins = list.filter((t) => t.result === 'win').length;
  const losses = list.filter((t) => t.result === 'loss').length;
  const net = usable.length ? r2(usable.reduce((s, t) => s + valueOf(t, unit), 0)) : null;
  return { net, trades: list.length, wins, losses, flat: list.length - wins - losses, win_rate: list.length ? r2((100 * wins) / list.length) : null, missing_values: list.length - usable.length };
}

/** Every closed trade of one source, normalized, one per stable ID. */
export async function sourceTrades(storage, source) {
  const visual = await readVisualTrades(storage);
  const spec = TRADING_SOURCES[source];
  let trades = visual.trades.filter((t) => spec.types.includes(t.execution_type) && t.exit_time);
  let duplicates = visual.duplicates.filter((d) => spec.types.includes(d.execution_type));
  const read = visual.sources.filter((s) => spec.types.includes(s.execution_type));
  if (source === 'paper') {
    // The crypto forward paper journal lives beside the futures one (market 'crypto'); readVisualTrades reads futures only.
    // Replay finds these by the same ID (trade_evidence.readCryptoPaperTrades) and draws their exchange candles.
    const ids = await readCryptoPaperTrades(storage);
    trades = [...trades.map((t) => ({ ...t, replay: true })), ...ids.trades.filter((t) => t.exit_time).map((t) => ({ ...t, replay: true }))];
    duplicates = [...duplicates, ...ids.duplicates];
    read.push({ execution_type: 'forward_paper', label: 'Forward paper (crypto)', read: true, trades: ids.trades.length });
  } else {
    trades = trades.map((t) => ({ ...t, replay: true }));
  }
  return { trades, duplicates, read };
}

async function brokerOrders(storage) {
  const list = (await storage.get(BROKER_ORDERS).catch(() => null)) || [];
  return Array.isArray(list) ? list : [];
}

const tradeRow = (t, unit, day) => ({
  id: t.id, strategy: t.strategy, symbol: t.symbol, market: t.market || 'futures', timeframe: t.timeframe, side: t.side,
  entry_time: t.entry_time, exit_time: t.exit_time, entry_price: t.entry_price, exit_price: t.exit_price, stop: t.stop, target: t.target,
  exit_reason: t.exit_reason, result: t.result, net: unit === 'USD' ? t.net : null, r: t.r, unit, day, cme_trade_day: t.exit_time ? tradeDayOf(t.exit_time) : null,
  evidence_label: t.evidence_label, replay: t.replay !== false,
  replay_note: t.replay === false ? 'This trade has no replay.' : '',
});

/**
 * GET /api/trading/calendar?month=YYYY-MM&source=sim|paper|broker[&basis=owner|cme]
 * GET /api/trading/calendar?day=YYYY-MM-DD&source=… — that day's trades, journal skips and per-strategy results.
 */
export async function tradingCalendar(storage, { month = '', day = '', source = 'paper', basis = 'owner', env = {}, now = Date.now() } = {}) {
  if (!TRADING_SOURCES[source]) return { ok: false, status: 400, detail: 'Choose a source: sim, paper or broker. They are never added together.' };
  const tz = ownerTimeZone(env);
  if (basis !== 'cme') basis = 'owner';
  const spec = TRADING_SOURCES[source];
  const base = { ok: true, source, source_label: spec.label, unit: spec.unit, note: spec.note, time_zone: tz, basis,
    basis_label: basis === 'cme' ? 'CME trading day (6 PM New York rollover)' : `Calendar day in ${tz}, by exit time`,
    break_even: { unit: spec.unit, within: BREAK_EVEN[spec.unit] }, paper_only: true, live_orders: 'disabled', sources: Object.keys(TRADING_SOURCES) };

  if (source === 'broker') {
    const orders = await brokerOrders(storage);
    const at = (o) => o.submitted_at || o.created_at || o.recorded_at || null;
    const keyed = orders.map((o) => ({ ...o, day: at(o) ? ownerDayKey(at(o), tz) : null })).filter((o) => o.day);
    const fills = await readAlpacaFills(storage);
    // One row per closing match, keyed by the closing fill (and lot) so a re-read never counts it twice.
    const closes = realizedClosesFromFills(fills).map((c, i) => ({
      id: `${c.fill_id}#${i}`, strategy: 'Alpaca paper', symbol: c.symbol, market: 'stocks', timeframe: null, side: c.side,
      entry_time: c.entry_time, exit_time: c.exit_time, entry_price: c.entry_price, exit_price: c.exit_price, qty: c.qty, net: c.pnl, r: null,
      result: c.pnl > 0 ? 'win' : c.pnl < 0 ? 'loss' : 'flat', evidence_label: 'BROKER-CONFIRMED (PAPER)', replay: false, fill_id: c.fill_id, order_id: c.order_id,
    })).map((t) => ({ t, day: calendarDay(t, { tz, basis }) })).filter((x) => x.day);
    const kept = { fills: fills.length, since: fills[0]?.time || null };
    if (DAY.test(day)) {
      const list = closes.filter((x) => x.day === day).map((x) => x.t);
      const totals = dayTotals(list, 'USD');
      return { ...base, day, fills_kept: kept, totals, color: dayColor(totals.net, 'USD', list.length),
        trades: list.map((t) => ({ ...tradeRow(t, 'USD', day), replay: false, replay_note: 'Alpaca paper fills; open the Alpaca chart for its bars.', fill_id: t.fill_id, order_id: t.order_id, qty: t.qty })),
        orders: keyed.filter((o) => o.day === day).map((o) => ({ id: o.id || o.client_order_id || '', symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, status: o.status, at: at(o) })),
        net: totals.net };
    }
    if (!MONTH.test(month)) month = monthOf(now, tz);
    const counts = {};
    for (const o of keyed) if (o.day.startsWith(month)) counts[o.day] = (counts[o.day] || 0) + 1;
    const byDay = {};
    for (const x of closes) if (x.day.startsWith(month)) (byDay[x.day] ||= []).push(x.t);
    const cell = (d) => { const list = byDay[d] || []; const tt = dayTotals(list, 'USD'); return { date: d, net: list.length ? tt.net : null, trades: list.length, wins: tt.wins, losses: tt.losses, orders: counts[d] || 0, color: dayColor(tt.net, 'USD', list.length) }; };
    const weeks = monthGrid(month).map((w) => { const days = w.map(cell); const list = w.flatMap((d) => byDay[d] || []); return { days, net: list.length ? dayTotals(list, 'USD').net : null, trades: list.length }; });
    const all = Object.values(byDay).flat();
    const tt = dayTotals(all, 'USD');
    return { ...base, month, prev: shiftMonth(month, -1), next: shiftMonth(month, 1), fills_kept: kept, weeks,
      totals: { net: all.length ? tt.net : null, trades: all.length, wins: tt.wins, losses: tt.losses, win_rate: tt.win_rate, orders: Object.values(counts).reduce((s, n) => s + n, 0) },
      empty: !all.length && !Object.keys(counts).length };
  }

  const { trades, duplicates, read } = await sourceTrades(storage, source);
  const withDay = trades.map((t) => ({ t, day: calendarDay(t, { tz, basis }) })).filter((x) => x.day);

  if (DAY.test(day)) {
    const list = withDay.filter((x) => x.day === day).map((x) => x.t).sort((a, b) => String(a.exit_time).localeCompare(String(b.exit_time)));
    const strategies = {};
    for (const t of list) (strategies[t.strategy] ||= []).push(t);
    const dupIds = new Set(list.map((t) => t.id));
    const skips = source === 'paper' ? (await readSkips(storage).catch(() => [])).filter((s) => s.time && (basis === 'cme' ? s.trade_day : ownerDayKey(s.time, tz)) === day) : [];
    // The same day by the other basis, so a P&L seen elsewhere can be reconciled against its rows.
    const other = basis === 'cme' ? 'owner' : 'cme';
    const otherList = trades.filter((t) => calendarDay(t, { tz, basis: other }) === day);
    return {
      ...base, day, totals: dayTotals(list, spec.unit), color: dayColor(dayTotals(list, spec.unit).net, spec.unit, list.length),
      trades: list.map((t) => tradeRow(t, spec.unit, day)),
      strategies: Object.entries(strategies).map(([strategy, rows]) => ({ strategy, ...dayTotals(rows, spec.unit) })).sort((a, b) => (b.net ?? 0) - (a.net ?? 0)),
      journal: skips.map((s) => ({ kind: 'skipped', strategy: s.strategy, time: s.time, reason: s.reason, side: s.side })),
      audit: {
        rows: list.length, sum: dayTotals(list, spec.unit).net,
        duplicates_not_counted: duplicates.filter((d) => d.entry_time && dupIds.has(d.id)).length,
        other_basis: { basis: other, rows: otherList.length, sum: dayTotals(otherList, spec.unit).net },
      },
      read,
    };
  }

  if (!MONTH.test(month)) month = monthOf(now, tz);
  const byDay = {};
  for (const x of withDay) if (x.day.startsWith(month)) (byDay[x.day] ||= []).push(x.t);
  const weeks = monthGrid(month).map((w) => {
    const days = w.map((d) => { const tot = dayTotals(byDay[d] || [], spec.unit); return { date: d, ...tot, color: dayColor(tot.net, spec.unit, tot.trades) }; });
    const all = w.flatMap((d) => byDay[d] || []);
    return { days, ...dayTotals(all, spec.unit) };
  });
  const monthList = Object.values(byDay).flat();
  const totals = dayTotals(monthList, spec.unit);
  return {
    ...base, month, prev: shiftMonth(month, -1), next: shiftMonth(month, 1), weeks,
    totals: { ...totals, green_days: weeks.flatMap((w) => w.days).filter((d) => d.color === 'green').length, red_days: weeks.flatMap((w) => w.days).filter((d) => d.color === 'red').length, yellow_days: weeks.flatMap((w) => w.days).filter((d) => d.color === 'yellow').length },
    color: dayColor(totals.net, spec.unit, totals.trades), duplicates_not_counted: duplicates.length, empty: monthList.length === 0, read,
  };
}

// ─── Learning dashboard: is CHE improving? ────────────────────────────────

const inWindow = (t, from, to) => { const x = Date.parse(t.exit_time); return x > from && x <= to; };

/** One strategy over one window and the window before it, so "new" is compared with "old" on equal lengths. */
function windowRow(list, days, now) {
  const span = days * 86_400_000;
  const recent = list.filter((t) => inWindow(t, now - span, now));
  const before = list.filter((t) => inWindow(t, now - 2 * span, now - span));
  const pick = (rows) => {
    const x = metricsOf(rows);
    // metricsOf reports dollars only when every row has them; an R-only set sums its R instead.
    const net = x.unit === 'USD' ? x.net : (rows.length ? r2(rows.reduce((s, t) => s + (Number.isFinite(t.r) ? t.r : 0), 0)) : null);
    return { trades: x.trades, net, unit: rows.length ? x.unit : null, win_rate: x.win_rate, profit_factor: x.profit_factor, avg_r: x.expectancy_r, max_drawdown: x.max_drawdown, sample: x.sample, _r: x.expectancy_r };
  };
  const now_ = pick(recent); const old = pick(before);
  const m = { expectancy_r: now_._r }; const p = { expectancy_r: old._r };
  delete now_._r; delete old._r;
  let verdict = 'insufficient evidence';
  if (recent.length >= MIN_EVIDENCE && before.length >= MIN_EVIDENCE && Number.isFinite(m.expectancy_r) && Number.isFinite(p.expectancy_r)) {
    verdict = m.expectancy_r > p.expectancy_r ? 'improving' : m.expectancy_r < p.expectancy_r ? 'worse' : 'unchanged';
  }
  return { days, now: now_, before: old, verdict, needs: Math.max(0, MIN_EVIDENCE - recent.length) };
}

/** GET /api/trading/learning: 7/30/90-day results per strategy and source, old vs new, with out-of-sample. */
export async function learningWindows(storage, { now = Date.now() } = {}) {
  const out = [];
  let simOos = {};
  try {
    const state = await readSimState(storage);
    const stored = await readStoredTrades(storage, state.trades);
    simOos = Object.fromEntries(leaderboard(stored, state.symbols).map((r) => [r.id, { label: r.label, sample_size: r.sample_size, ...r.out_of_sample }]));
  } catch (_) { simOos = {}; }
  for (const source of ['sim', 'paper']) {
    const { trades, read } = await sourceTrades(storage, source);
    const groups = {};
    for (const t of trades) (groups[t.strategy] ||= []).push(t);
    for (const [strategy, list] of Object.entries(groups)) {
      const windows = WINDOWS.map((d) => windowRow(list, d, now));
      out.push({
        source, source_label: TRADING_SOURCES[source].label, unit: TRADING_SOURCES[source].unit, strategy, total_trades: list.length, windows,
        out_of_sample: source === 'sim'
          ? (simOos[strategy] ? { basis: 'trades after the frozen 70/30 cut', ...simOos[strategy] } : { basis: 'no out-of-sample record for this strategy yet' })
          : { basis: 'forward paper trades happen after the rules were fixed, so every one is out of sample', trades: list.length },
        failures: windows.filter((w) => w.now.trades && (w.now.net ?? 0) < 0).map((w) => `${w.days}-day net is negative`),
      });
    }
    if (read.some((r) => r.read === false)) out.push({ source, source_label: TRADING_SOURCES[source].label, error: read.filter((r) => r.read === false).map((r) => r.error || r.label).join('; ') });
  }
  out.sort((a, b) => (a.source.localeCompare(b.source)) || ((b.total_trades || 0) - (a.total_trades || 0)));
  return { ok: true, windows: WINDOWS, min_evidence: MIN_EVIDENCE, rule: `A change is called improving or worse only when both periods have at least ${MIN_EVIDENCE} trades; otherwise it says insufficient evidence.`, rows: out, paper_only: true, at: new Date(now).toISOString() };
}

// ─── Office calendar ──────────────────────────────────────────────────────

const OK = new Set(['complete', 'completed', 'done', 'verified', 'shipped', 'approved', 'succeeded']);
const BAD = new Set(['failed', 'blocked', 'rejected', 'dead_letter', 'error', 'cancelled', 'not_shipped']);
const WAIT = new Set(['awaiting_approval', 'pending', 'needs_review', 'review_pending', 'planned', 'unverified']);
export function officeState(status) {
  const s = String(status || '').toLowerCase();
  if (OK.has(s)) return 'done';
  if (BAD.has(s)) return 'failed';
  if (WAIT.has(s)) return 'pending';
  return 'active';
}

/** Every recorded piece of Office work as one dated item; `link` names where the app opens it. */
export async function officeItems(storage, data = {}, env = {}) {
  const items = [];
  const seen = new Set();
  const push = (it) => { if (!it.at || seen.has(`${it.kind}:${it.id}`)) return; seen.add(`${it.kind}:${it.id}`); items.push(it); };
  let jobs = [];
  try { jobs = await cloudJobs(storage, env); } catch (_) { jobs = []; }
  for (const j of jobs) {
    push({ id: j.id, kind: 'job', type: j.kind, title: j.title || j.kind, agent: j.agent, status: j.status, state: officeState(j.status),
      at: j.finished_at || j.started_at || j.created_at, receipt: j.evidence, error: j.error || '', outputs: j.outputs || [], source: j.source, link: { screen: 'cloud_job', id: j.id } });
  }
  for (const t of Array.isArray(data.team_tasks) ? data.team_tasks : []) {
    push({ id: t.id, kind: 'task', type: 'office_task', title: String(t.task || 'Office task').slice(0, 120), agent: t.partner_name || 'Office', status: t.status, state: officeState(t.status),
      at: t.updated_at || t.created_at, receipt: t.result ? String(t.result).slice(0, 240) : '', error: t.error || '', source: 'team_tasks', link: { screen: 'office_task', id: t.id } });
  }
  for (const g of Array.isArray(data.office_goals) ? data.office_goals : []) {
    push({ id: g.id, kind: 'office_job', type: 'coordinated_job', title: String(g.goal || g.request || 'Office job').slice(0, 120), agent: g.accountable || g.coordinator || 'Office', status: g.status,
      state: officeState(g.verification?.status === 'verified' ? 'verified' : g.status), at: g.updated_at || g.created_at, receipt: g.verification?.basis || '', milestone: officeState(g.status) === 'done', source: 'office_goals', link: { screen: 'office_job', id: g.id } });
  }
  for (const o of Array.isArray(data.objectives) ? data.objectives : []) {
    const failedSteps = (o.nodes || []).filter((n) => n.status === 'failed').length;
    push({ id: o.id, kind: 'objective', type: 'objective', title: String(o.objective || 'Objective').slice(0, 120), agent: 'CHE', status: o.status, state: failedSteps ? 'failed' : officeState(o.status),
      at: o.updated_at || o.created_at, receipt: `${(o.nodes || []).filter((n) => n.status === 'complete').length} of ${(o.nodes || []).length} steps complete${failedSteps ? `, ${failedSteps} failed` : ''}`, milestone: true, source: 'objectives', link: { screen: 'objective', id: o.id } });
  }
  for (const a of Array.isArray(data.action_approvals) ? data.action_approvals : []) {
    push({ id: a.id, kind: 'approval', type: a.capability || a.tool || 'approval', title: `Approval: ${a.tool || a.capability || 'action'}`, agent: 'Owner', status: a.status, state: a.status === 'pending' ? 'pending' : officeState(a.status),
      at: a.created_at, receipt: a.result ? String(a.result).slice(0, 240) : '', source: 'action_approvals', link: { screen: 'approvals', id: a.id } });
  }
  return items;
}

// ─── Durable daily rollup ──────────────────────────────────────────────────
// cloudJobs keeps only its newest 120 rows, so finished and failed work is copied, once and compactly, into one
// record per UTC day the first time it is seen finished (on every Office calendar read and every Worker alarm).
// Older months then still show what really happened. Nothing is backfilled: a day before the first rollup reads
// "no record kept".
export const OFFICE_DAY_PREFIX = 'office_day:';
export const OFFICE_ROLLUP_SINCE = 'office_rollup_since';
export const MAX_ROLLUP_PER_DAY = 300;
const compact = (it) => ({ id: it.id, kind: it.kind, type: it.type, title: String(it.title || '').slice(0, 120), agent: it.agent, status: it.status, state: it.state, at: it.at,
  receipt: String(it.receipt || '').slice(0, 240), error: String(it.error || '').slice(0, 160), milestone: Boolean(it.milestone), source: it.source, link: it.link, rolled_up: true });

/** Copy finished and failed Office work into its day's record (each item once). Returns how many were added. */
export async function rollupOfficeDays(storage, items, { now = Date.now() } = {}) {
  const done = items.filter((it) => (it.state === 'done' || it.state === 'failed') && it.at && Number.isFinite(Date.parse(it.at)));
  const since = await storage.get(OFFICE_ROLLUP_SINCE).catch(() => null);
  if (!since) await storage.put(OFFICE_ROLLUP_SINCE, new Date(now).toISOString());
  const byDay = {};
  for (const it of done) (byDay[new Date(it.at).toISOString().slice(0, 10)] ||= []).push(it);
  let added = 0;
  for (const [d, list] of Object.entries(byDay)) {
    const key = `${OFFICE_DAY_PREFIX}${d}`;
    const rec = (await storage.get(key).catch(() => null)) || { day: d, items: [] };
    const have = new Set(rec.items.map((x) => `${x.kind}:${x.id}`));
    const fresh = list.filter((it) => !have.has(`${it.kind}:${it.id}`) && rec.items.length < MAX_ROLLUP_PER_DAY).map(compact);
    if (!fresh.length) continue;
    rec.items = [...rec.items, ...fresh].slice(0, MAX_ROLLUP_PER_DAY);
    await storage.put(key, rec);
    added += fresh.length;
  }
  return { added, since: since || new Date(now).toISOString() };
}

/** The rolled-up items for UTC days [from, to] (YYYY-MM-DD), oldest day first. */
async function rolledUp(storage, from, to) {
  if (typeof storage.list !== 'function') return [];
  const map = await storage.list({ prefix: OFFICE_DAY_PREFIX }).catch(() => new Map());
  const out = [];
  for (const [k, v] of map) { const d = k.slice(OFFICE_DAY_PREFIX.length); if (d >= from && d <= to) out.push(...(v?.items || [])); }
  return out;
}

const dayColorOffice = (c) => (!c.total ? null : c.failed ? 'red' : (c.pending || c.active) ? 'yellow' : 'green');

function officeCounts(list) {
  const c = { total: list.length, done: 0, active: 0, pending: 0, failed: 0, approvals: 0, milestones: 0 };
  for (const it of list) { c[it.state] += 1; if (it.kind === 'approval') c.approvals += 1; if (it.milestone && it.state === 'done') c.milestones += 1; }
  return c;
}

function summaryOf(list, c) {
  if (!c.total) return 'Nothing was recorded.';
  const agents = {};
  for (const it of list) if (it.state === 'done') agents[it.agent] = (agents[it.agent] || 0) + 1;
  const top = Object.entries(agents).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} ${n}`).join(', ');
  return `${c.done} done, ${c.active} active, ${c.pending} pending, ${c.failed} failed${top ? `; finished by ${top}` : ''}.`;
}

/** GET /api/office/calendar?month=YYYY-MM, or ?day=YYYY-MM-DD for that day's items with their receipts. */
export async function officeCalendar(storage, data = {}, { month = '', day = '', env = {}, now = Date.now() } = {}) {
  const tz = ownerTimeZone(env);
  const live = await officeItems(storage, data, env);
  const roll = await rollupOfficeDays(storage, live, { now }).catch(() => ({ since: null }));
  // The span asked for, one UTC day wider each side so an owner-zone day near midnight finds its rolled-up items.
  const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const spanMonth = MONTH.test(month) ? month : monthOf(now, tz);
  const [y, m] = spanMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const span = DAY.test(day) ? [addDays(day, -1), addDays(day, 1)] : [addDays(`${spanMonth}-01`, -1), addDays(lastDay, 1)];
  const liveKeys = new Set(live.map((it) => `${it.kind}:${it.id}`));
  const older = (await rolledUp(storage, span[0], span[1])).filter((it) => !liveKeys.has(`${it.kind}:${it.id}`));
  const items = [...live, ...older].map((it) => ({ ...it, day: ownerDayKey(it.at, tz) })).filter((it) => it.day);
  const sinceDay = roll.since ? ownerDayKey(roll.since, tz) : null;
  const kept = (d) => (sinceDay && d < sinceDay ? 'no record kept' : null);
  let ledger = { rows: [] };
  try { ledger = (await storage.get('che_reliability_ledger')) || { rows: [] }; } catch (_) { /* unreadable: counts stay absent */ }
  const reliability = (d) => {
    const rows = (Array.isArray(ledger.rows) ? ledger.rows : []).filter((r) => r.kind === 'job' && r.at && ownerDayKey(r.at, tz) === d);
    return rows.length ? { completed: rows.filter((r) => r.outcome === 'completed' || r.outcome === 'recovered').length, failed: rows.filter((r) => r.outcome === 'failed').length } : null;
  };
  const base = { ok: true, time_zone: tz, colors: { green: 'everything recorded succeeded', yellow: 'pending or mixed', red: 'something failed or is blocked' },
    sources: ['cloud jobs (coding, cloud tasks, REA, renders, film, app builds, Creation Engine)', 'Office team tasks', 'coordinated Office jobs', 'objectives', 'owner approvals', 'reliability ledger (counts only)'] };
  if (DAY.test(day)) {
    const list = items.filter((it) => it.day === day).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const c = officeCounts(list);
    const agents = {};
    for (const it of list) if (it.state === 'done') (agents[it.agent] ||= []).push(it.title);
    return { ...base, day, record: kept(day) && !list.length ? kept(day) : null, rollup_since: roll.since || null, counts: c, color: dayColorOffice(c), summary: summaryOf(list, c), items: list, accomplishments: Object.entries(agents).map(([agent, titles]) => ({ agent, done: titles.length, titles: titles.slice(0, 10) })), reliability: reliability(day) };
  }
  if (!MONTH.test(month)) month = monthOf(now, tz);
  const byDay = {};
  for (const it of items) if (it.day.startsWith(month)) (byDay[it.day] ||= []).push(it);
  const weeks = monthGrid(month).map((w) => {
    const days = w.map((d) => { const c = officeCounts(byDay[d] || []); return { date: d, ...c, color: dayColorOffice(c), reliability: reliability(d), record: !c.total ? kept(d) : null }; });
    const all = w.flatMap((d) => byDay[d] || []);
    const c = officeCounts(all);
    return { days, ...c, summary: summaryOf(all, c) };
  });
  const all = Object.values(byDay).flat();
  const c = officeCounts(all);
  return { ...base, month, prev: shiftMonth(month, -1), next: shiftMonth(month, 1), weeks, totals: c, summary: summaryOf(all, c), empty: all.length === 0, rollup_since: roll.since || null };
}

// ─── Speech ───────────────────────────────────────────────────────────────

const money = (v) => (v == null ? 'not recorded' : `${v < 0 ? 'minus ' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const amount = (v, unit) => (unit === 'R' ? (v == null ? 'not recorded' : `${v} R`) : money(v));

export function speakTradingCalendar(v) {
  if (!v.ok) return v.detail;
  if (v.source === 'broker') {
    // Realized P&L from the stored Alpaca paper fills, plus the orders recorded; a day view has no month and no order total.
    const orders = v.day ? (v.orders || []).length : v.totals?.orders || 0;
    const when = v.day ? `on ${v.day}` : `in ${v.month}`;
    const pnl = v.totals?.trades
      ? `${v.totals.trades} closed trades ${when}, ${v.totals.wins} wins, ${v.totals.losses} losses, realized net ${amount(v.totals.net, v.unit)}.`
      : `No closing fill ${when}.`;
    return `${v.source_label}: ${pnl} ${orders} ${orders === 1 ? 'order' : 'orders'} recorded. ${v.note}`;
  }
  if (v.day) return v.totals.trades ? `${v.source_label} on ${v.day}: ${v.totals.trades} closed trades, ${v.totals.wins} wins, ${v.totals.losses} losses, net ${amount(v.totals.net, v.unit)}.` : `${v.source_label}: no trade closed on ${v.day}.`;
  if (v.empty) return `${v.source_label}: no trade closed in ${v.month}. Nothing is shown as a sample.`;
  return `${v.source_label}, ${v.month}: ${v.totals.trades} closed trades, ${v.totals.wins} wins and ${v.totals.losses} losses, win rate ${v.totals.win_rate} percent, net ${amount(v.totals.net, v.unit)}. ${v.totals.green_days} green days, ${v.totals.red_days} red, ${v.totals.yellow_days} near break-even.`;
}

export function speakOfficeCalendar(v) {
  if (v.day) return `On ${v.day}: ${v.summary}`;
  if (v.empty) return `No Office work is recorded in ${v.month}.`;
  return `Office, ${v.month}: ${v.summary}`;
}

/** "open my trading calendar", "show the office calendar for September", "what did we do yesterday". Null otherwise. */
export function calendarIntent(message, { now = Date.now(), tz = 'America/Chicago' } = {}) {
  const t = String(message || '').toLowerCase();
  const monthName = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const today = ownerDayKey(new Date(now), tz);
  let month = '';
  if (monthName) {
    const m = months.indexOf(monthName[1]) + 1; const y = Number(today.slice(0, 4));
    month = `${m > Number(today.slice(5, 7)) ? y - 1 : y}-${String(m).padStart(2, '0')}`;
  }
  if (/\b(?:p\s*&\s*l|pnl|trading|profit)\s+calendar\b|\bcalendar\b[^.?!]{0,30}\b(?:p\s*&\s*l|pnl|trad(?:e|es|ing))\b/.test(t)) {
    const source = /\bsim(?:ulation)?\b/.test(t) ? 'sim' : /\bbroker\b|\balpaca\b/.test(t) ? 'broker' : 'paper';
    // "Trading calendar for September 22 by CME day": that one day's page, counted on the CME trading day when asked.
    const day = dayFromWords(t, now);
    const cme = /\bcme\b|\btrad(?:e|ing)\s+day\b|\bexchange\s+day\b/.test(t) ? { basis: 'cme' } : {};
    return day ? { kind: 'trading', day, source, ...cme } : { kind: 'trading', month, source, ...cme };
  }
  if (/\boffice\s+calendar\b|\bwork\s+calendar\b|\bcalendar\b[^.?!]{0,30}\boffice\b/.test(t)) return { kind: 'office', month };
  const y = new Date(`${today}T12:00:00Z`); y.setUTCDate(y.getUTCDate() - 1);
  if (/\bwhat\s+did\s+(?:we|you|che|the\s+office)\s+(?:do|get\s+done|finish|accomplish)\s+yesterday\b/.test(t)) return { kind: 'office', day: y.toISOString().slice(0, 10) };
  if (/\bwhat\s+did\s+(?:we|you|che|the\s+office)\s+(?:do|get\s+done|finish|accomplish)\s+today\b/.test(t)) return { kind: 'office', day: today };
  return null;
}
