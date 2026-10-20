// The Trading Room chart (owner, 2026-10-20, Build 1): one view for Alpaca PAPER stocks and MNQ
// futures paper, read by the Flutter chart. Everything shown comes from a record:
// - bars and feed health from the provider CHE already reads (Alpaca's data host, or the forward
//   paper engine's stored MNQ bars);
// - markers by source, kept apart and never merged: CHE forward paper (journal trades and open
//   positions), CHE strategy simulation (minute-bar research), Alpaca PAPER orders and Alpaca
//   PAPER fills. Identical records are shown once.
// New entries from the chart are blocked when the feed is delayed or unavailable, and futures
// orders are refused because no futures paper broker is connected. Live orders stay disabled.
import { alpacaPaperDashboard } from './broker_alpaca.js';
import { aggregate } from './market_feed.js';
import { readSimState, readStoredTrades } from './strategy_sim.js';
import { readTrades } from './trading_evidence.js';
import { LIVE_FEED, readLivePortfolios } from './trading_live.js';

export const ACCOUNTS = Object.freeze({
  alpaca_paper: { label: 'Alpaca PAPER', asset: 'stocks', mode: 'PAPER' },
  futures_paper: { label: 'MNQ futures PAPER (CHE research)', asset: 'futures', mode: 'PAPER' },
});
// Alpaca timeframes and how far back each reads; futures are built from the stored 5-minute bars.
export const TIMEFRAMES = Object.freeze({
  '1m': { alpaca: '1Min', days: 1, minutes: 1 },
  '5m': { alpaca: '5Min', days: 5, minutes: 5 },
  '15m': { alpaca: '15Min', days: 10, minutes: 15 },
  '1h': { alpaca: '1Hour', days: 30, minutes: 60 },
  '1d': { alpaca: '1Day', days: 365, minutes: 1440 },
});
export const MARKER_SOURCES = Object.freeze({
  che_forward: 'CHE forward paper',
  che_sim: 'CHE strategy simulation',
  alpaca_order: 'Alpaca PAPER order',
  alpaca_fill: 'Alpaca PAPER fill',
});
// A feed older than this is not current enough for new entries from the chart.
const FRESH_SECONDS = { '1m': 180, '5m': 600, '15m': 1800, '1h': 5400, '1d': 3 * 86400 };

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** One list of markers, each with its source, deduplicated by source and id, oldest first. */
export function chartMarkers({ journal = [], portfolios = [], simTrades = [], orders = [], fills = [], symbol = '' } = {}) {
  const out = new Map();
  const add = (m) => {
    const key = `${m.source}|${m.id}|${m.kind}`;
    if (!out.has(key) && m.time && m.price != null) out.set(key, m);
  };
  const sym = String(symbol || '').toUpperCase();
  for (const t of journal) {
    if (sym && String(t.symbol || '').toUpperCase() !== sym) continue;
    const id = `${t.portfolio}|${t.entry?.time}`;
    const base = { source: 'che_forward', id, symbol: t.symbol, strategy: t.strategy, variant: t.filter, side: t.side || 'long', stop: t.stop, target: t.target };
    add({ ...base, kind: 'entry', time: t.entry?.time, price: num(t.entry?.raw), status: 'closed' });
    add({ ...base, kind: 'exit', time: t.exit?.time, price: num(t.exit?.raw), status: 'closed', reason: t.exit?.reason, net_pnl: num(t.net_pnl), r: num(t.r_net) });
  }
  for (const pf of portfolios) {
    if (!pf.open || (sym && String(pf.contract || '').toUpperCase() !== sym)) continue;
    add({ source: 'che_forward', id: `${pf.key}|${pf.open.entry_time}`, kind: 'open', symbol: pf.contract, strategy: pf.candidate, variant: pf.filter,
      side: pf.open.side || 'long', time: pf.open.entry_time, price: num(pf.open.entry?.raw), stop: pf.open.stop, target: pf.open.target, status: 'open' });
  }
  for (const t of simTrades) {
    if (sym && String(t.symbol || '').toUpperCase() !== sym) continue;
    const base = { source: 'che_sim', id: t.id, symbol: t.symbol, strategy: t.strategy, side: 'long', stop: t.stop, target: t.target };
    add({ ...base, kind: 'entry', time: t.entry_t, price: num(t.entry_raw), status: t.exit_t ? 'closed' : 'open' });
    if (t.exit_t) add({ ...base, kind: 'exit', time: t.exit_t, price: num(t.exit_raw), status: 'closed', reason: t.exit_reason, r: num(t.r) });
  }
  for (const o of orders) {
    if (sym && o.symbol !== sym) continue;
    const price = num(o.limit_price) ?? num(o.stop_price);
    // An unfilled market order has no price to draw; its receipt is still in the order list.
    if (price == null || o.status_group === 'filled') continue;
    add({ source: 'alpaca_order', id: o.id, kind: 'order', symbol: o.symbol, side: o.side, time: o.submitted_at, price, qty: o.qty, status: o.status, status_group: o.status_group, order_id: o.id, order_type: o.type });
  }
  for (const f of fills) {
    if (sym && f.symbol !== sym) continue;
    add({ source: 'alpaca_fill', id: f.id || `${f.order_id}|${f.time}|${f.qty}`, kind: 'fill', symbol: f.symbol, side: f.side, time: f.time, price: num(f.price), qty: f.qty, status: 'filled', order_id: f.order_id });
  }
  return [...out.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function feedHealth({ provider, status, lastBarTime, now, tf }) {
  const age = lastBarTime ? Math.round((now - Date.parse(lastBarTime)) / 1000) : null;
  const stale = age == null || age > (FRESH_SECONDS[tf] || 600) + 300;
  const delayed = status === 'DELAYED';
  return { provider, status: status || 'UNAVAILABLE', last_bar_time: lastBarTime || null, age_s: age, stale, delayed };
}

/** The chart for one account, symbol and timeframe: bars, feed health, the entry gate and markers. */
export async function chartView(storage, env, { account = 'alpaca_paper', symbol = '', tf = '5m', now = Date.now(), fetcher = fetch } = {}) {
  if (!ACCOUNTS[account]) return { ok: false, error: `Choose an account: ${Object.keys(ACCOUNTS).join(' or ')}.` };
  const frame = TIMEFRAMES[tf] ? tf : '5m';
  const base = { ok: true, account, account_label: ACCOUNTS[account].label, mode: 'PAPER', timeframe: frame, timeframes: Object.keys(TIMEFRAMES), live_orders: 'disabled', sources: MARKER_SOURCES };
  if (account === 'alpaca_paper') {
    const d = await alpacaPaperDashboard(env, { symbol, fetcher, now, timeframe: frame });
    if (d.state !== 'verified') {
      return { ...base, symbol: String(symbol || '').toUpperCase() || null, state: d.state, error: d.error || null, bars: [], markers: [],
        feed: feedHealth({ provider: 'Alpaca', status: 'UNAVAILABLE', now, tf: frame }), entries_allowed: false,
        entries_blocked_reason: d.state === 'not_configured' ? 'Alpaca PAPER is not connected.' : `Alpaca could not be read: ${d.error || d.state}.` };
    }
    const bars = d.chart.bars || [];
    const feed = feedHealth({ provider: `Alpaca ${String(d.chart.feed || 'iex').toUpperCase()}`, status: d.chart.error ? 'UNAVAILABLE' : 'REALTIME', lastBarTime: bars.at(-1)?.t, now, tf: frame });
    const markers = chartMarkers({ orders: d.orders, fills: d.fills, symbol: d.chart.symbol });
    // The stock market is shut outside its hours: an old bar then means "closed", and a limit order can still be queued.
    const blocked = d.chart.error ? `No price data: ${d.chart.error}.` : feed.stale ? 'The last bar is old (market closed or the feed stopped); market orders are blocked, limit orders queue for the next session.' : '';
    return { ...base, state: 'verified', symbol: d.chart.symbol, bars, feed, markers, entries_allowed: !d.chart.error, market_orders_allowed: !blocked, entries_blocked_reason: blocked,
      positions: d.positions, open_orders: d.open_orders, account_summary: d.account };
  }
  // Futures: CHE's forward paper engine's stored MNQ bars (Yahoo, DELAYED) and its own records.
  const sym = 'MNQ';
  const stored = (await storage.get(LIVE_FEED)) || {};
  const five = Array.isArray(stored.bars) ? stored.bars : [];
  const minutes = TIMEFRAMES[frame].minutes;
  const bars = minutes <= 5 ? five : aggregate(five.map((b) => ({ ...b, t: b.t })), minutes, now);
  const journal = await readTrades(storage, (t) => t.environment === 'paper' && t.data?.resolution === '5m');
  const portfolios = await readLivePortfolios(storage);
  const sim = await readSimState(storage).catch(() => null);
  const simTrades = sim ? (await readStoredTrades(storage, sim.trades).catch(() => [])).filter((t) => t.symbol === sym) : [];
  const feed = feedHealth({ provider: stored.provider || 'Yahoo MNQ=F', status: stored.status, lastBarTime: stored.last_bar_time || five.at(-1)?.t, now, tf: frame });
  return {
    ...base, state: five.length ? 'verified' : 'no_data', symbol: sym, bars: bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), feed,
    markers: chartMarkers({ journal, portfolios, simTrades, symbol: sym }),
    entries_allowed: false, market_orders_allowed: false,
    entries_blocked_reason: 'No futures paper broker is connected (Tradovate is not signed in), so CHE takes no manual futures orders. CHE\'s MNQ trades here are research on DELAYED data.',
  };
}

// ─── Drawings: the owner's lines, levels, boxes and notes, kept per account and symbol ───────────
const DRAWINGS = 'trading_chart_drawings';
const DRAWING_KINDS = new Set(['line', 'hline', 'box', 'text']);
const MAX_DRAWINGS = 200;

export function drawingProblems(list) {
  if (!Array.isArray(list)) return ['drawings must be a list'];
  if (list.length > MAX_DRAWINGS) return [`at most ${MAX_DRAWINGS} drawings per chart`];
  const problems = [];
  for (const [i, d] of list.entries()) {
    if (!d || !DRAWING_KINDS.has(d.kind)) { problems.push(`drawing ${i + 1}: kind must be line, hline, box or text`); continue; }
    const pts = Array.isArray(d.points) ? d.points : [];
    const need = d.kind === 'hline' || d.kind === 'text' ? 1 : 2;
    if (pts.length !== need || pts.some((p) => !Number.isFinite(Number(p?.price)) || (d.kind !== 'hline' && !Number.isFinite(Date.parse(p?.time))))) problems.push(`drawing ${i + 1}: needs ${need} point${need > 1 ? 's' : ''} with a price${d.kind === 'hline' ? '' : ' and a time'}`);
    if (d.kind === 'text' && !String(d.text || '').trim()) problems.push(`drawing ${i + 1}: a note needs its text`);
  }
  return problems;
}

const drawingKey = (account, symbol) => `${account}:${String(symbol || '').toUpperCase()}`;

export async function readDrawings(storage, account, symbol) {
  const all = (await storage.get(DRAWINGS)) || {};
  return all[drawingKey(account, symbol)] || [];
}

export async function saveDrawings(storage, account, symbol, list, now = Date.now()) {
  if (!ACCOUNTS[account] || !String(symbol || '').trim()) return { ok: false, error: 'Say which account and symbol the drawings belong to.' };
  const problems = drawingProblems(list);
  if (problems.length) return { ok: false, error: problems.join('; ') };
  const clean = list.map((d) => ({
    id: String(d.id || `${d.kind}-${now}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 40), kind: d.kind,
    points: d.points.map((p) => ({ price: Number(p.price), ...(p.time ? { time: new Date(Date.parse(p.time)).toISOString() } : {}) })),
    ...(d.text ? { text: String(d.text).slice(0, 140) } : {}), ...(d.color ? { color: String(d.color).slice(0, 12) } : {}),
  }));
  const all = (await storage.get(DRAWINGS)) || {};
  all[drawingKey(account, symbol)] = clean;
  await storage.put(DRAWINGS, all);
  return { ok: true, drawings: clean };
}

/** "Draw a line at 21,450" / "draw a level at 21450 on MNQ": one horizontal level. Null otherwise. */
export function drawIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'");
  const m = /\b(?:draw|add|put|mark)\b[\s\S]{0,25}\b(?:line|level|horizontal line)\b[\s\S]{0,15}\bat\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\b/.exec(t);
  if (!m) return null;
  const price = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return null;
  const sym = /\b(mnq|nq)\b/.exec(t)?.[1]?.toUpperCase() || /\bon\s+([a-z]{1,5})\b/.exec(t)?.[1]?.toUpperCase() || '';
  return { kind: 'draw', drawing: { kind: 'hline', points: [{ price }] }, symbol: sym };
}

/**
 * "Open Alpaca chart", "show the MNQ chart", "CHE, show EMA trades", "show strategy progress":
 * the chart (or the Strategies section) with the account, symbol and filter named. Null otherwise.
 */
export function chartIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,\s]+/, '');
  if (/^(?:show|open|bring up|pull up|go to)\b[\s\S]{0,25}\bstrateg(?:y|ies)\s+(?:progress|section|page)\b/.test(t)) return { kind: 'chart_open', section: 'strategies' };
  const strat = /\b(ema|vwap|rsi|orb|opening range|silver bullet|order block|fvg|ict)\b[\s\S]{0,15}\btrades?\b/.exec(t);
  if (/^(?:show|open|bring up|pull up|go to|see)\b/.test(t) && strat) {
    return { kind: 'chart_open', section: 'chart', account: 'futures_paper', filter: { strategy: strat[1] } };
  }
  const m = /^(?:show|open|bring up|pull up|go to|see)\b[\s\S]{0,40}\bchart\b(?:\s+(?:for|of)\s+([a-z]{1,5}))?\s*[.!?]*$/.exec(t);
  if (!m) return null;
  const account = /\b(?:alpaca|stocks?)\b/.test(t) ? 'alpaca_paper' : /\b(?:mnq|nq|futures|tradovate)\b/.test(t) ? 'futures_paper' : '';
  const symbol = (m[1] || '').toUpperCase();
  return { kind: 'chart_open', section: 'chart', account, symbol };
}

/** "Buy 1 MNQ at 21,400": a manual futures paper order, which CHE cannot place (no futures paper broker). */
export function futuresOrderIntent(message) {
  const t = String(message || '').toLowerCase();
  if (!/^\s*(?:(?:hey\s+)?(?:che|chey|chay)[,\s]+)?(?:please\s+)?(?:buy|sell|short|go long|go short)\b/.test(t) || !/\b(?:mnq|nq|micro nasdaq|nasdaq futures|es|mes)\b/.test(t)) return null;
  return {
    kind: 'futures_order',
    reply: 'I cannot place that, sir: no futures paper broker is connected. Tradovate demo orders stay blocked until Tradovate approves API access and you sign in, and CHE\'s MNQ paper engine trades only its own written strategies for research. Nothing was sent. On the chart you can draw the level, or place a paper stock order on Alpaca.',
  };
}
