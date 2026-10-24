// The Trading Room chart (owner, 2026-10-20, Build 1): one view for Alpaca PAPER stocks and MNQ
// futures paper, read by the Flutter chart. Everything shown comes from a record:
// - bars and feed health from the provider CHE already reads (Alpaca's data host, or the forward
//   paper engine's stored MNQ bars);
// - markers by source, kept apart and never merged: CHE forward paper (journal trades and open
//   positions), CHE strategy simulation (minute-bar research), Alpaca PAPER orders and Alpaca
//   PAPER fills. Identical records are shown once.
// New entries from the chart are blocked when the feed is delayed or unavailable, and futures
// orders are refused because no futures paper broker is connected. Live orders stay disabled.
import { alpacaPaperDashboard, alpacaPaperOrder, openAlpacaPaperOrders, previewAlpacaPaperOrder } from './broker_alpaca.js';
import { readSimState, readStoredTrades } from './strategy_sim.js';
import { readTrades, overnightLevels } from './trading_evidence.js';
import { LIVE_FEED, readLivePortfolios } from './trading_live.js';
import { fromEvidence, fromSim, historyChart, naturalKey, provenanceOf, tradeIdOf } from './trading_visual.js';
import { INTERVALS, describeFeed, marketUniverse, resolveTicker, universeCandles } from './market_universe.js';
import { intervalFromWords, intervalLabel, symbolFromFollowup } from './trading_lab.js';

export const ACCOUNTS = Object.freeze({
  alpaca_paper: { label: 'Alpaca PAPER', asset: 'stocks', mode: 'PAPER' },
  futures_paper: { label: 'MNQ futures PAPER (CHE research)', asset: 'futures', mode: 'PAPER' },
  // NQ or MNQ candles from CHE's stored research datasets (owner, 2026-10-23): study only, no orders.
  futures_history: { label: 'NQ/MNQ history (stored research data)', asset: 'futures', mode: 'HISTORICAL' },
  // Any crypto or futures ticker from the universal selector (owner, 2026-10-24): public exchange data, research only.
  market: { label: 'Market chart (public data, research)', asset: 'any', mode: 'RESEARCH' },
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
// Futures bars are CHE's stored 5-minute bars, so nothing finer than 5 minutes exists for them.
export const FUTURES_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAMES).filter((tf) => TIMEFRAMES[tf].minutes >= 5));
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
    // trade_id is the ledger ID Trade Replay opens (trading_visual.tradeIdOf over the same natural key); id stays the record's own.
    const base = { source: 'che_forward', id, trade_id: tradeIdOf(naturalKey(fromEvidence(t, 'forward_paper'))), symbol: t.symbol, strategy: t.strategy, variant: t.filter, side: t.side || 'long', stop: t.stop, target: t.target };
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
    // Only a closed simulation trade is in the ledger, so only it carries the ID Trade Replay opens.
    const base = { source: 'che_sim', id: t.id, ...(t.exit_t ? { trade_id: tradeIdOf(naturalKey(fromSim(t))) } : {}), symbol: t.symbol, strategy: t.strategy, side: 'long', stop: t.stop, target: t.target };
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

// The stored 5-minute bars rolled into 15-minute, hourly or daily candles for the chart. Unlike
// market_feed's aggregate (1-minute bars into closed 5-minute ones), the newest candle may still be
// forming: a chart shows it, and nothing trades on it.
export function rollUp(bars, minutes) {
  const size = minutes * 60_000;
  const out = [];
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / size) * size;
    const cur = out.at(-1);
    if (cur && cur.start === start) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v = (cur.v || 0) + (b.v || 0);
    } else out.push({ start, t: new Date(start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
  }
  return out.map(({ start, ...bar }) => bar);
}

function feedHealth({ provider, status, lastBarTime, now, tf }) {
  const age = lastBarTime ? Math.round((now - Date.parse(lastBarTime)) / 1000) : null;
  const stale = age == null || age > (FRESH_SECONDS[tf] || 600) + 300;
  const delayed = status === 'DELAYED';
  return { provider, status: status || 'UNAVAILABLE', last_bar_time: lastBarTime || null, age_s: age, stale, delayed };
}

/** The chart for one account, symbol and timeframe: bars, feed health, the entry gate and markers. */
export async function chartView(storage, env, { account = 'alpaca_paper', symbol = '', tf = '5m', at = null, now = Date.now(), fetcher = fetch } = {}) {
  if (!ACCOUNTS[account]) return { ok: false, error: `Choose an account: ${Object.keys(ACCOUNTS).join(' or ')}.` };
  if (account === 'futures_history') return historyChart(storage, { market: symbol || 'MNQ', tf, at });
  if (account === 'market') return marketChart(storage, { symbol, tf, now, fetcher });
  const offered = account === 'futures_paper' ? FUTURES_TIMEFRAMES : Object.keys(TIMEFRAMES);
  // A timeframe the account does not offer (futures at 1m) answers with 5-minute bars, labelled 5m.
  const frame = offered.includes(tf) ? tf : '5m';
  const base = { ok: true, account, account_label: ACCOUNTS[account].label, mode: 'PAPER', timeframe: frame, timeframes: [...offered], live_orders: 'disabled', sources: MARKER_SOURCES };
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
  const bars = minutes <= 5 ? five : rollUp(five, minutes);
  const journal = await readTrades(storage, (t) => t.environment === 'paper' && t.data?.resolution === '5m');
  const portfolios = await readLivePortfolios(storage);
  const sim = await readSimState(storage).catch(() => null);
  const simTrades = sim ? (await readStoredTrades(storage, sim.trades).catch(() => [])).filter((t) => t.symbol === sym) : [];
  const feed = feedHealth({ provider: stored.provider || 'Yahoo MNQ=F', status: stored.status, lastBarTime: stored.last_bar_time || five.at(-1)?.t, now, tf: frame });
  return {
    ...base, state: five.length ? 'verified' : 'no_data', symbol: sym, bars: bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), feed,
    provenance: provenanceOf({ dataType: 'live-paper', source: stored.provider || 'Yahoo MNQ=F', delay: stored.delayed_by_min != null ? `about ${stored.delayed_by_min} minutes (DELAYED)` : 'DELAYED', bars, tf: frame }),
    markers: chartMarkers({ journal, portfolios, simTrades, symbol: sym }),
    // The overnight high/low and the 86-style bias (CHE's independent approximation, never the P2P indicator).
    levels: five.length ? overnightLevels(five) : null,
    entries_allowed: false, market_orders_allowed: false,
    entries_blocked_reason: 'No futures paper broker is connected (Tradovate is not signed in), so CHE takes no manual futures orders. CHE\'s MNQ trades here are research on DELAYED data.',
  };
}

/**
 * The universal chart: one ticker from the discovered universe (Coinbase, Kraken, CME front months via
 * Yahoo, CHE's recorded Rithmic minutes), its candles with an honest feed label, and CHE's own simulation
 * markers for that symbol. No orders: nothing here is connected to a broker.
 */
async function marketChart(storage, { symbol, tf, now, fetcher }) {
  const universe = await marketUniverse(storage, { fetcher, now });
  const item = resolveTicker(universe, symbol) || resolveTicker(universe, 'MNQ');
  const frame = INTERVALS[tf] ? tf : '5m';
  const view = await universeCandles(storage, item, frame, { fetcher, now });
  const sim = await readSimState(storage).catch(() => null);
  const simTrades = sim ? (await readStoredTrades(storage, sim.trades).catch(() => [])).filter((t) => t.symbol === item.symbol) : [];
  const journal = item.category === 'futures' && item.symbol === 'MNQ' ? await readTrades(storage, (t) => t.environment === 'paper' && t.data?.resolution === '5m') : [];
  const bars = (view.bars || []).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  return {
    ok: true, account: 'market', account_label: ACCOUNTS.market.label, mode: 'RESEARCH', timeframe: view.timeframe, timeframes: view.timeframes, live_orders: 'disabled', sources: MARKER_SOURCES,
    state: bars.length ? 'verified' : 'no_data', symbol: item.symbol, ticker: item, bars, built_from: view.built_from || null, fallback: view.fallback || false,
    feed: { ...view.feed, last_bar_time: bars.at(-1)?.t || null, stale: view.feed.status === 'UNAVAILABLE' || view.feed.status === 'DISCONNECTED', delayed: view.feed.status === 'DELAYED' },
    spoken: describeFeed(view), universe_problems: universe.problems,
    markers: chartMarkers({ journal, simTrades, symbol: item.symbol }),
    levels: item.category === 'futures' && bars.length ? overnightLevels(bars) : null,
    entries_allowed: false, market_orders_allowed: false,
    entries_blocked_reason: item.category === 'crypto'
      ? `Research chart on ${item.exchange} public data. No crypto exchange account is connected, so CHE places no orders here.`
      : 'Research chart on delayed public CME data. No futures broker is connected, so CHE places no orders here.',
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

/**
 * "Draw a line at 21,450" / "draw a level at 21450 on MNQ": one horizontal level. Null otherwise.
 * A follow-up ("and one at 240" after "draw a line at 230 on AAPL") keeps the earlier symbol; a draw that names no
 * symbol after "open the Alpaca chart for AAPL" takes that chart's.
 */
export function drawIntent(message, { followup = '', referent = '' } = {}) {
  if (followup) {
    const own = drawIntent(followup);
    const base = drawIntent(referent);
    const inherited = base?.symbol || chartIntent(referent)?.symbol || '';
    if (own) return own.symbol || !inherited ? own : { ...own, symbol: inherited };
    if (!base) return null;
    const next = /\b(?:at|level|line|another(?:\s+one)?|one)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\b/.exec(String(followup).toLowerCase());
    const price = next ? Number(next[1].replace(/,/g, '')) : NaN;
    return Number.isFinite(price) && price > 0 && !intervalFromWords(followup) ? { kind: 'draw', drawing: { kind: 'hline', points: [{ price }] }, symbol: base.symbol } : null;
  }
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
const CHART_TIMEFRAMES = new Set(Object.keys(INTERVALS));

/**
 * The spoken reply and the phone's `chart` object for a chart_open intent. `lastSymbol` is the stock chart the owner
 * last opened (stored as trading_chart_last_symbol), used when the request names none. The phone's Trading Room opens
 * the futures chart when no account is named, and starts the chart on `chart.timeframe` (lib/rooms/che_trading_room.dart),
 * so a bar size that chart does not offer is said plainly and the default bars it opens on are named (PR #515 review:
 * the reply said 15-minute bars while the phone showed 5).
 */
export function chartOpenReply(ask = {}, { lastSymbol = '' } = {}) {
  const symbol = ask.symbol || lastSymbol || '';
  const account = ask.account || (lastSymbol ? 'alpaca_paper' : '');
  let bars = '';
  let note = '';
  let timeframe = '';
  if (ask.timeframe) {
    const offered = (account || 'futures_paper') === 'futures_paper' ? FUTURES_TIMEFRAMES : Object.keys(TIMEFRAMES);
    timeframe = offered.includes(ask.timeframe) ? ask.timeframe : '5m';
    bars = ` on ${intervalLabel(timeframe)} bars`;
    const list = offered.map(intervalLabel);
    if (timeframe !== ask.timeframe) note = ` That chart has no ${intervalLabel(ask.timeframe)} bars; it offers ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}.`;
  }
  const text = ask.section === 'setups'
    ? (ask.answer === 'ready' ? 'Here are the setups CHE is following on this iPhone, sir.' : 'Opening the Setup Progress Board, sir. These are CHE PAPER ACCOUNT setups from the live Rithmic candles.')
    : ask.section === 'strategies' ? 'Opening Strategies, sir.'
      : ask.section === 'compare' ? 'Opening Side by Side, sir: your account beside CHE\'s paper account. Live orders stay disabled.'
        : `Opening the ${account === 'alpaca_paper' ? 'Alpaca PAPER ' : account === 'futures_paper' ? 'MNQ paper ' : ''}chart${symbol ? ` for ${symbol}` : ''}${bars}${ask.filter?.strategy ? `, showing only ${ask.filter.strategy.toUpperCase()} trades` : ''}, sir.${note}`;
  const chart = { section: ask.section, account: account || null, symbol: symbol || null, filter: ask.filter || null, ...(timeframe ? { timeframe } : {}), ...(ask.answer ? { answer: ask.answer } : {}) };
  // The spoken stock chart is remembered, so "draw a line at 230" and "switch it to the 5 minute" inherit it.
  return { text, chart, remember: ask.section === 'chart' && symbol && account !== 'futures_paper' ? symbol : '' };
}
export function chartIntent(message, { followup = '', referent = '' } = {}) {
  // A follow-up ("switch it to the 5 minute", "now the same for MSFT") carries the owner's new words alone in `followup`
  // and the earlier request in `referent` (speech_intent.js): the new symbol or bar size comes from the new words and the
  // chart from the earlier request. A market the Alpaca chart cannot show asks one question instead of re-opening AAPL.
  if (followup) {
    const own = chartIntent(followup);
    if (own) return own;
    const base = chartIntent(referent);
    if (!base || base.kind !== 'chart_open' || base.section !== 'chart') return null;
    const word = symbolFromFollowup(followup);
    const tf = intervalFromWords(followup);
    if (!word && !tf) return null;
    const futures = /^m?nq$/i.test(word);
    if (word && !futures && !/^[a-z]{1,5}$/i.test(word)) {
      return { kind: 'clarify', question: `That chart shows Alpaca PAPER stocks, sir, not ${word}. Say "analyze the ${word} chart" for a read of ${word}, or name a stock.` };
    }
    const account = futures ? 'futures_paper' : word ? 'alpaca_paper' : base.account;
    return { ...base, account, symbol: futures ? word.toUpperCase() : word ? word.toUpperCase() : base.symbol, inherit: !word, ...(tf && CHART_TIMEFRAMES.has(tf) ? { timeframe: tf } : {}) };
  }
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,\s]+/, '');
  // "Switch to the 15 minute chart", "change the chart to the 1 hour": the open chart's bar size; the symbol stays.
  if (/^(?:switch|change|flip|move|put)\b[\s\S]{0,30}\b(?:chart|bars?|timeframe|time frame)\b/.test(t) && intervalFromWords(t)) {
    const tf = intervalFromWords(t);
    return { kind: 'chart_open', section: 'chart', account: '', symbol: '', inherit: true, ...(CHART_TIMEFRAMES.has(tf) ? { timeframe: tf } : {}) };
  }
  if (/^(?:show|open|bring up|pull up|go to)\b[\s\S]{0,25}\bstrateg(?:y|ies)\s+(?:progress|section|page)\b/.test(t)) return { kind: 'chart_open', section: 'strategies' };
  // Signal Mode: "show setups", "show the setup progress board", "what setups are ready?". The board lives on the iPhone.
  if (/^(?:what|which|any)\b[\s\S]{0,25}\bsetups?\b[\s\S]{0,25}\b(?:ready|forming|triggered|active|near entry|right now)\b/.test(t)) return { kind: 'chart_open', section: 'setups', answer: 'ready' };
  if (/^(?:show|open|bring up|pull up|go to|see)\b[\s\S]{0,20}\b(?:setups|setup (?:progress|board)|signal mode|(?:trade |paper )?signals)\b/.test(t)) return { kind: 'chart_open', section: 'setups' };
  // Side by side (owner, 2026-10-23): "open side by side", "show my trades next to CHE's", "compare my trade with CHE's",
  // "open the live order preview". Opens the room's SIDE BY SIDE section; nothing is sent or placed.
  if (/^(?:show|open|bring up|pull up|go to|see)\b[\s\S]{0,30}\b(?:side[\s-]by[\s-]side|both accounts|live order preview|my (?:trades?|positions?|account) (?:next to|beside|vs\.?|versus|against) (?:che|chey|chay))\b/.test(t)
    || /^compare\b[\s\S]{0,30}\b(?:my|mine)\b[\s\S]{0,30}\b(?:che|chey|chay)(?:'s)?\b/.test(t)) {
    return { kind: 'chart_open', section: 'compare' };
  }
  const strat = /\b(ema|vwap|rsi|orb|opening range|silver bullet|order block|fvg|ict)\b[\s\S]{0,15}\btrades?\b/.exec(t);
  if (/^(?:show|open|bring up|pull up|go to|see)\b/.test(t) && strat) {
    return { kind: 'chart_open', section: 'chart', account: 'futures_paper', filter: { strategy: strat[1] } };
  }
  // "Open the Alpaca chart for AAPL on the 5 minute": an optional bar size after the symbol, or in front ("the 5 minute chart").
  const m = /^(?:show|open|bring up|pull up|go to|see)\b[\s\S]{0,40}\bchart\b(?:\s+(?:for|of)\s+([a-z]{1,5}))?(?:\s+(?:on|at|in)\s+(?:the\s+)?[\w -]{1,24}?(?:\s+(?:chart|bars?|timeframe))?)?\s*[.!?]*$/.exec(t);
  if (!m) return null;
  const account = /\b(?:alpaca|stocks?)\b/.test(t) ? 'alpaca_paper' : /\b(?:mnq|nq|futures|tradovate)\b/.test(t) ? 'futures_paper' : '';
  const symbol = (m[1] || '').toUpperCase();
  const tf = intervalFromWords(t);
  return { kind: 'chart_open', section: 'chart', account, symbol, ...(tf && CHART_TIMEFRAMES.has(tf) ? { timeframe: tf } : {}) };
}

/**
 * "Set CHE paper balance to 500", "show CHE positions", "open CHE's paper account": the CHE PAPER
 * ACCOUNT lives on the owner's iPhone, so the Worker only opens it there. A balance change is never
 * made here: the phone shows the change for the owner to confirm. Null otherwise.
 */
export function paperAccountIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,\s]+/, '');
  // CHE's own account only: "my Alpaca paper balance" stays with the Alpaca dashboard.
  if (/\b(?:alpaca|my|tradovate|fye|fund ?your ?edge|rithmic)\b/.test(t)) return null;
  if (!/\b(?:che|chey|chay|your)(?:'s)?\s+(?:paper\b|positions?\b)/.test(t)) return null;
  const set = /\b(?:set|change|make|put|reset)\b[\s\S]{0,40}\bbalance\b[\s\S]{0,12}?\b(?:to|at)\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|thousand)?\b/.exec(t);
  if (set) {
    let amount = Number(set[1].replace(/,/g, ''));
    if (set[2]) amount *= 1000;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { kind: 'paper_balance', amount: Math.round(amount * 100) / 100 };
  }
  if (/^(?:show|open|bring up|pull up|go to|see|what are|list)\b/.test(t) && /\b(?:positions?|trades?|account|balance)\b/.test(t)) return { kind: 'paper_open' };
  return null;
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

// A market order from the app needs a current price: no Alpaca trade in the last 15 minutes means
// the market is closed or the feed stopped. Limit orders still queue. Empty when the order may go.
export const MARKET_ORDER_MAX_AGE_S = 15 * 60;
export async function marketOrderFeedProblem(env, order = {}, { fetcher = fetch, now = Date.now() } = {}) {
  if (String(order.type || 'market').toLowerCase() !== 'market') return '';
  const p = await previewAlpacaPaperOrder(env, { ...order, type: 'market' }, { fetcher });
  // A failed read of Alpaca is no current price: the market order is blocked, never let through.
  if (!p.ok) return p.upstream_error ? `New market orders are blocked: ${p.detail.replace(/\s*Nothing was sent\.$/, '')} Use a limit order. Nothing was sent.` : '';
  const at = Date.parse(p.last_trade_time || '');
  if (!Number.isFinite(at)) return `New market orders are blocked: Alpaca reports no recent trade for ${p.symbol}, so there is no current price. Use a limit order. Nothing was sent.`;
  const age = Math.round((now - at) / 1000);
  if (age > MARKET_ORDER_MAX_AGE_S) return `New market orders are blocked: Alpaca's latest ${p.symbol} trade is ${Math.round(age / 60)} minutes old (market closed or the feed stopped). Use a limit order to queue it. Nothing was sent.`;
  return '';
}

// ─── Cancelling an open Alpaca PAPER order: always asked first (owner rule: confirm before removing) ───

/** "BUY 2 AAPL limit 109", "SELL 1 AAPL market": an order as the owner hears it. */
export function speakOrder(o = {}) {
  const type = String(o.type || 'market').toLowerCase();
  const price = type === 'limit' && o.limit_price != null ? ` limit ${Number(o.limit_price).toLocaleString('en-US')}` : ` ${type}`;
  return `${String(o.side || '').toUpperCase()} ${o.qty ?? '?'} ${o.symbol || ''}${price}`.replace(/\s+/g, ' ').trim();
}

const OPEN_STATUSES = new Set(['new', 'pending_new', 'accepted', 'accepted_for_bidding', 'calculated', 'partially_filled', 'pending_replace', 'replaced', 'held']);

/**
 * The confirmation a cancel needs before anything is sent: the order as Alpaca reports it now.
 * { ok: false, needs_confirmation: true, order, detail } for an open order; { ok: false, detail } when it
 * cannot be read or is no longer open. Nothing is cancelled here.
 */
export async function cancelConfirmation(env, orderId, { fetcher = fetch } = {}) {
  const read = await alpacaPaperOrder(env, orderId, { fetcher });
  if (!read.ok) return { ok: false, detail: `${read.detail} Nothing was cancelled.` };
  const order = read.order;
  if (!OPEN_STATUSES.has(order.status)) return { ok: false, order, detail: `Alpaca reports ${speakOrder(order)} as ${order.status}, so there is nothing open to cancel. Nothing was cancelled.` };
  return { ok: false, needs_confirmation: true, order, detail: `Cancel ${speakOrder(order)}? Say yes to cancel; nothing was cancelled.` };
}

const CANCEL_FILLER = new Set(['my', 'the', 'that', 'this', 'open', 'pending', 'working', 'alpaca', 'paper', 'stock', 'limit', 'market', 'buy', 'sell', 'an', 'a']);
/**
 * "Cancel my AAPL order", "cancel the open Alpaca order", "cancel my paper order": one open Alpaca PAPER
 * order to cancel, with the symbol when one is named. Null otherwise ("cancel my pizza order" names no
 * stock: a symbol must be spoken in capitals, or the sentence must say Alpaca, paper or stock).
 */
export function cancelOrderIntent(message) {
  const raw = String(message || '').trim().replace(/[’']/g, "'");
  const m = /^(?:(?:hey\s+)?(?:che|chey|chay)[,\s]+)?(?:please\s+)?(?:can you\s+|could you\s+)?cancel\s+((?:[A-Za-z.]+\s+){1,5}?)orders?(?:\s+please)?\s*[.!?]*$/i.exec(raw);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  let symbol = '';
  for (const w of words) {
    if (CANCEL_FILLER.has(w.toLowerCase())) continue;
    if (/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(w) && !symbol) { symbol = w; continue; }
    return null;
  }
  if (!symbol && !words.some((w) => /^(?:alpaca|paper|stock)$/i.test(w))) return null;
  return { kind: 'cancel_order', symbol };
}

/** The open Alpaca PAPER orders a spoken cancel names, read from Alpaca. */
export async function cancelCandidates(env, intent, { fetcher = fetch } = {}) {
  return openAlpacaPaperOrders(env, { symbol: intent?.symbol || '', fetcher });
}
