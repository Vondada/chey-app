// Trade evidence and replay (owner mission, 2026-10-23, Priority 5): "tapping a trade opens its exact chart
// with entry, exit, stops, targets, timestamps and outcome", replayed without revealing the future.
//
// Read only. A trade is found by its stable ID (trading_visual.tradeIdOf), and its chart comes from bars CHE
// actually stored, in this order: the research dataset for that market and timeframe, the forward engine's
// DELAYED feed, then the owner's iPhone-recorded Rithmic minutes. When none of them covers the trade, the
// answer says "No recorded market data for this trade." and draws nothing. No candle or fill is ever made up.
import { LIVE_FEED } from './trading_live.js';
import { liveOrdersStatus } from './trading_environments.js';
import { loadDataset, tfOf } from './trading_research.js';
import { readRithmicCandles } from './rithmic_dataset.js';
import { RETIRED_FEEDS, minuteFeedFor } from './strategy_sim.js';
import {
  DAILY_TARGET, EVIDENCE_LABELS, EXECUTION_TYPES, auditTrades, compareWindows, currentLeader, dailyEvidence, dailyPnl, filterTrades, historyChart, journalView,
  lastForwardBar, metricsOf, openPositions, rankStrategies, readSkips, readVisualTrades, replayFrame, speakAudit, speakLeader, speakPnl,
} from './trading_visual.js';
import { tradeDayOf } from './trading_evidence.js';

export const TRADE_EVIDENCE_SOURCE = 'che_trade_evidence';
export const NO_DATA = 'No recorded market data for this trade.';
const BEFORE = 40; // bars of context before the signal
const AFTER = 10; // bars after the exit
const RITHMIC_INDEX = 'rithmic_1m_index:';
// Public exchange minutes fetched for one closed trade are kept, so a replay opens without asking the exchange again.
const TRADE_BARS = 'trade_bars:';
const COINBASE_PAGE = 300; // Coinbase returns at most 300 candles per request
const MAX_PAGES = 5;
const HEADERS = { 'User-Agent': 'CHE-Orion/1.0 (paper research; no account)', Accept: 'application/json' };

const msOf = (tf) => tfOf(tf)?.ms || (tf === '1D' ? 86_400_000 : tf === '1m' ? 60_000 : 300_000);
const clean = ({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v: v ?? null });

/** The bars around one trade from one stored series, or [] when the series does not contain the entry bar. */
export function windowAround(bars, trade, tfMs) {
  const first = Date.parse(trade.signal_time || trade.entry_time);
  const last = Date.parse(trade.exit_time || trade.entry_time);
  if (!Number.isFinite(first) || !bars.length) return [];
  const entry = Date.parse(trade.entry_time);
  if (!bars.some((b) => { const t = Date.parse(b.t); return t <= entry && entry < t + tfMs; })) return [];
  const from = first - BEFORE * tfMs;
  const to = (Number.isFinite(last) ? last : first) + AFTER * tfMs;
  return bars.filter((b) => { const t = Date.parse(b.t); return t >= from && t <= to; }).map(clean);
}

async function rithmicContracts(storage, root) {
  if (typeof storage.list !== 'function') return [];
  const keys = [...(await storage.list({ prefix: `${RITHMIC_INDEX}${root}` })).keys()];
  return keys.map((k) => k.slice(RITHMIC_INDEX.length)).filter((c) => /^[A-Z]{1,4}[FGHJKMNQUVXZ]\d{1,2}$/.test(c) && c.startsWith(root));
}

const iso = (ms) => new Date(ms).toISOString();
/** Coinbase Exchange public 1-minute candles for [from, to], oldest first; throws on an HTTP or shape error. */
async function coinbaseMinutes(product, from, to, fetcher) {
  const out = new Map();
  for (let start = from, page = 0; start < to && page < MAX_PAGES; start += COINBASE_PAGE * 60_000, page++) {
    const end = Math.min(to, start + COINBASE_PAGE * 60_000);
    const res = await fetcher(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${iso(start)}&end=${iso(end)}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Coinbase answered HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`Coinbase answered ${String(rows?.message || 'an unexpected shape').slice(0, 80)}`);
    for (const r of rows) if (Array.isArray(r) && r.length >= 6) out.set(Number(r[0]), { t: iso(Number(r[0]) * 1000), o: Number(r[3]), h: Number(r[2]), l: Number(r[1]), c: Number(r[4]), v: Number(r[5]) });
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}
const KRAKEN_SPELL = Object.freeze({ BTC: 'XBT', DOGE: 'XDG' });
/** Kraken public 1-minute OHLC since [from]; Kraken keeps only about the newest 12 hours of minutes. */
async function krakenMinutes(base, from, fetcher) {
  const res = await fetcher(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_SPELL[base] || base}USD&interval=1&since=${Math.floor(from / 1000)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Kraken answered HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error?.length) throw new Error(`Kraken answered ${String(body.error[0]).slice(0, 80)}`);
  const key = Object.keys(body?.result || {}).find((k) => k !== 'last');
  const rows = key ? body.result[key] : null;
  if (!Array.isArray(rows)) throw new Error('Kraken answered an unexpected shape');
  return rows.map((r) => ({ t: iso(Number(r[0]) * 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]) }));
}

/** A crypto simulation trade's own minutes from the same public exchange the simulation read (Coinbase, Kraken fallback). */
async function cryptoTradeBars(storage, trade, feed, ms, fetcher, now) {
  if (!trade.exit_time) return { bars: [], reason: 'The trade is still open, so its chart is drawn only after it closes.' };
  const cached = await storage.get(`${TRADE_BARS}${trade.id}`).catch(() => null);
  if (cached?.bars?.length) return { bars: cached.bars, source: cached.source };
  const from = Date.parse(trade.signal_time || trade.entry_time) - BEFORE * ms;
  const to = Math.min(now, Date.parse(trade.exit_time) + (AFTER + 1) * ms);
  const product = `${feed.base}-USD`;
  const tried = [];
  for (const [name, load, label] of [
    ['Coinbase', () => coinbaseMinutes(product, from, to, fetcher), `Coinbase Exchange ${product} 1-minute candles (public history, no account)`],
    ['Kraken', () => krakenMinutes(feed.base, from, fetcher), `Kraken ${feed.base}/USD 1-minute candles (public, no account)`],
  ]) {
    let bars = [];
    try { bars = windowAround((await load()).filter((b) => Date.parse(b.t) + ms <= now), trade, ms); } catch (e) { tried.push(`${name}: ${String(e?.message || e).slice(0, 100)}`); continue; }
    if (!bars.length) { tried.push(`${name} returned no 1-minute candles covering the entry`); continue; }
    const source = { kind: 'exchange_history', label, data_type: 'historical' };
    await storage.put(`${TRADE_BARS}${trade.id}`, { bars, source, fetched_at: iso(now) }).catch(() => {});
    return { bars, source };
  }
  return { bars: [], reason: `The exchange history for ${product} could not be read: ${tried.join('; ')}. No candle was made up.` };
}

/** The first stored series that covers the trade, with its provenance; never a mix of sources. */
export async function tradeBars(storage, trade, { fetcher = fetch, now = Date.now() } = {}) {
  const tf = trade.timeframe;
  const ms = msOf(tf);
  const market = String(trade.symbol || '').toUpperCase();
  const crypto = trade.execution_type === 'simulation' ? minuteFeedFor(market) : null;
  if (crypto?.kind === 'coinbase') return cryptoTradeBars(storage, trade, crypto, ms, fetcher, now);
  if (RETIRED_FEEDS.has(market)) return { bars: [], source: null, reason: `${market} was a Binance market, and Binance's public API refuses CHE's Worker region, so its minutes cannot be read. A different market's candles are never substituted.` };
  const ds = ['NQ', 'MNQ'].includes(market) ? await loadDataset(storage, market, tf).catch(() => null) : null;
  if (ds?.bars?.length) {
    const bars = windowAround(ds.bars, trade, ms);
    if (bars.length) return { bars, source: { kind: 'research_dataset', label: `${ds.manifest.provider || 'stored'} ${market} ${tf} (historical, delayed public source)`, data_type: 'historical' } };
  }
  if (tf === '5m') {
    const feed = (await storage.get(LIVE_FEED)) || {};
    const bars = windowAround(Array.isArray(feed.bars) ? feed.bars : [], trade, ms);
    if (bars.length) return { bars, source: { kind: 'forward_feed', label: `CHE forward feed ${feed.provider || ''} (DELAYED)`.replace('  ', ' '), data_type: 'delayed' } };
  }
  if (tf === '1m') {
    for (const contract of await rithmicContracts(storage, market)) {
      const read = await readRithmicCandles(storage, { symbol: contract, from: new Date(Date.parse(trade.signal_time || trade.entry_time) - BEFORE * ms).toISOString(), to: new Date(Date.parse(trade.exit_time || trade.entry_time) + AFTER * ms).toISOString() });
      const bars = read.ok ? windowAround(read.candles, trade, ms) : [];
      if (bars.length) return { bars, source: { kind: 'rithmic_recorded', label: `Rithmic ${contract} 1-minute, recorded by your iPhone`, data_type: 'live-recorded', missing_minutes: read.coverage?.minutes_missing ?? null } };
    }
  }
  const where = ['NQ', 'MNQ'].includes(market) ? `CHE's stored ${market} ${tf} research data, the forward feed and the iPhone's Rithmic recordings` : `CHE's stored data`;
  return { bars: [], source: null, reason: `${where} have no ${tf} bars covering ${market} at this trade's entry. No candle was made up.` };
}

const pub = ({ _raw, ...t }) => t;

/** What the replay screen needs for one trade. `null` when the ID is unknown. */
export function tradeEvidenceOf(trade, { bars = [], source = null, reason = null } = {}) {
  const ms = msOf(trade.timeframe);
  const closed = Boolean(trade.exit_time);
  return {
    ok: true, id: trade.id, key: trade.key, label: trade.evidence_label || EVIDENCE_LABELS[trade.execution_type],
    execution_type: trade.execution_type, execution_label: trade.execution_label, data_label: trade.data_label,
    strategy: trade.strategy, variant: trade.variant, strategy_version: trade.strategy_version, symbol: trade.symbol, timeframe: trade.timeframe, side: trade.side, qty: trade.qty, session: trade.session,
    signal: { time: trade.signal_time, why: trade.signal_why, price: trade.signal_ref },
    entry: { time: trade.entry_time, price: trade.entry_price, raw: trade.entry_raw, basis: trade.entry_basis },
    exit: closed ? { time: trade.exit_time, price: trade.exit_price, raw: trade.exit_raw, reason: trade.exit_reason } : null,
    stop: trade.stop, target: trade.target, status: closed ? 'closed' : 'open',
    outcome: { result: trade.result, r: trade.r, net: trade.net, gross: trade.gross, commissions: trade.commissions, slippage: trade.slippage, unit: trade.net == null ? null : 'USD' },
    bars, bars_source: source, no_data: bars.length ? null : NO_DATA, no_data_reason: bars.length ? null : reason || null,
    replay: {
      supported: bars.length > 0, timeframe_ms: ms, start: bars[0]?.t || null, end: bars.length ? new Date(Date.parse(bars.at(-1).t) + ms).toISOString() : null,
      rule: 'A bar is shown once it has closed (open time + timeframe <= replay clock). Markers appear when their time is reached; the exit only after its bar closes.',
    },
    links: {
      strategy: { id: trade.strategy, open_view: 'trading_controls' },
      journal: { view: 'journal', id: trade.id, path: `/api/trading/visual?view=journal&strategy=${encodeURIComponent(trade.strategy || '')}` },
      brain: { ref: `trade:${trade.id}` },
      replay_route: `/trade-replay?id=${trade.id}`,
    },
    live_orders: liveOrdersStatus(),
  };
}

/** Newest first: the trades the owner can open, with their IDs and labels. */
export function tradeList(trades, { limit = 100, executionType = '' } = {}) {
  const list = trades.filter((t) => !executionType || t.execution_type === executionType)
    .sort((a, b) => String(b.exit_time || b.entry_time).localeCompare(String(a.exit_time || a.entry_time)));
  return { total: list.length, trades: list.slice(0, limit).map((t) => {
    const p = pub(t);
    return { id: p.id, label: p.evidence_label, execution_type: p.execution_type, strategy: p.strategy, symbol: p.symbol, timeframe: p.timeframe, side: p.side, entry_time: p.entry_time, exit_time: p.exit_time, result: p.result, r: p.r, net: p.net };
  }) };
}

/** "My last trade": CHE's newest closed forward paper trade, else its newest closed simulation trade. Backtests are never "the last trade". */
export function lastTrade(trades) {
  for (const kinds of [['forward_paper', 'daily_paper'], ['simulation']]) {
    const t = trades.filter((x) => kinds.includes(x.execution_type) && x.exit_time).sort((a, b) => String(b.exit_time).localeCompare(String(a.exit_time)))[0];
    if (t) return t;
  }
  return null;
}

/**
 * The trade a card or chart marker names. The ledger ID (T + 13) first; then the record's own ID as older app builds
 * sent it from a chart marker (a simulation trade's "strategy|symbol|time", a forward trade's "portfolio|entry time"),
 * so a tap on an installed build still opens the right trade. Never a guess: an ID that names no record finds nothing.
 */
export function findTrade(trades, id) {
  const raw = String(id || '').trim();
  const want = raw.toUpperCase();
  if (!raw) return null;
  const byId = trades.find((t) => t.id === want);
  if (byId) return byId;
  const lc = raw.toLowerCase();
  return trades.find((t) => {
    const r = t._raw || {};
    if (t.execution_type === 'simulation') return String(r.id || '').toLowerCase() === lc;
    if (t.execution_type === 'forward_paper' || t.execution_type === 'daily_paper') return `${r.portfolio}|${r.entry?.time}`.toLowerCase() === lc;
    return false;
  }) || null;
}

/** One trade's full evidence, read from storage. */
export async function readTradeEvidence(storage, id, opts = {}) {
  const { trades } = await readVisualTrades(storage);
  const want = String(id || '').trim().toUpperCase();
  const trade = findTrade(trades, id);
  if (!trade) return { ok: false, error: `No CHE trade has the ID ${want || '(none)'}.`, id: want };
  return tradeEvidenceOf(trade, await tradeBars(storage, trade, opts));
}

/** "Replay my last trade", "replay trade T0ABC…": null otherwise. */
export function tradeReplayIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,:\s]+/, '').trim();
  const byId = /\b(?:replay|open|show)\s+(?:the\s+)?trade\s+(t[0-9a-z]{13})\b/.exec(t);
  if (byId) return { kind: 'trade_replay', id: byId[1].toUpperCase() };
  if (/^(?:please\s+)?replay\s+(?:a\s+|the\s+)?trade[.!?]*$/.test(t)) return { kind: 'trade_replay', id: null };
  // The Command Center's "Replay trade {input}" with something that is not an ID: answered as an unknown ID, never guessed.
  const other = /^replay\s+trade\s+(\S[\s\S]{0,60}?)[.!?]*$/.exec(t);
  if (other) return { kind: 'trade_replay', id: other[1].trim().toUpperCase() };
  if (/^(?:please\s+)?(?:replay|play back|rewind)\b[\s\S]{0,25}\b(?:last|latest|most recent|previous)\s+(?:paper\s+)?trade\b/.test(t)
    || /^(?:show|open)\b[\s\S]{0,20}\breplay\s+of\s+(?:my|che's|your|the)\s+(?:last|latest|most recent)\s+trade\b/.test(t)) return { kind: 'trade_replay', id: null };
  return null;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an unknown time');
/** The spoken line for an opened replay; every fact comes from the record. */
export function speakTradeReplay(e) {
  if (!e?.ok) return `${e?.error || 'That trade was not found.'} Nothing was opened.`;
  const out = e.outcome.result === 'win' ? 'a win' : e.outcome.result === 'loss' ? 'a loss' : e.outcome.result === 'flat' ? 'flat' : 'still open';
  const r = e.outcome.r == null ? '' : `, ${e.outcome.r > 0 ? '+' : ''}${e.outcome.r}R`;
  const data = e.no_data ? ` ${e.no_data_reason || e.no_data} The trade's details are shown without a chart.` : '';
  return `Opening the replay of trade ${e.id}: ${e.label}, ${e.strategy} ${e.side} on ${e.symbol} ${e.timeframe}, entered ${when(e.entry.time)} Eastern, ${out}${r}.${data}`;
}

/** GET /api/trading/visual?view=…: one read of the trade records, projected for the view asked for (moved from worker.js). */
export async function tradingVisualViewOf(storage, q) {
  const view = q.get('view') || 'summary';
  const filters = Object.fromEntries(['instrument', 'timeframe', 'strategy', 'from', 'to', 'execution_type', 'side', 'result'].map((k) => [k, (q.get(k) || '').slice(0, 40)]).filter(([, v]) => v));
  const { trades, records, duplicates, sources, research } = await readVisualTrades(storage);
  const shown = filterTrades(trades, filters);
  const today = tradeDayOf(new Date().toISOString());
  const base = { ok: true, view, paper_only: true, live_orders: liveOrdersStatus(), today, filters, sources, research, execution_types: EXECUTION_TYPES };
  if (view === 'evidence') {
    const rows = dailyEvidence(shown, { skips: await readSkips(storage), today });
    return { ...base, target: DAILY_TARGET, target_rule: 'A daily target, never a quota: trades are never forced, and a day below it says why.', rows: rows.slice(0, 400), total_rows: rows.length };
  }
  if (view === 'pnl') {
    const pnl = dailyPnl({ trades, positions: await openPositions(storage), lastBar: await lastForwardBar(storage), day: q.get('day') || today });
    return { ...base, pnl, spoken: speakPnl(pnl) };
  }
  if (view === 'replay') {
    const tf = q.get('timeframe') || '5m';
    const chart = await historyChart(storage, { market: q.get('instrument') || 'MNQ', tf, at: q.get('cursor'), trades });
    return { ...base, ...replayFrame({ bars: chart.bars, trades: filterTrades(shown, { timeframe: tf, instrument: chart.symbol }), cursor: q.get('cursor'), timeframe: tf }), provenance: chart.provenance || null };
  }
  if (view === 'compare') return { ...base, windows: compareWindows(shown) };
  if (view === 'leader') { const l = currentLeader(trades); return { ...base, ...l, spoken: speakLeader(l) }; }
  if (view === 'journal') return { ...base, ...journalView(trades, await readSkips(storage), { ...filters, include_skips: q.get('skips') !== '0' }) };
  if (view === 'audit') { const a = auditTrades(records); return { ...base, ...a, ids: { unique_trades: trades.length, duplicates_hidden: duplicates.filter((d) => d.kind === 'duplicate').length, conflicts_hidden: duplicates.filter((d) => d.kind === 'conflict').length, examples: duplicates.slice(0, 10) }, spoken: speakAudit(a) }; }
  // Trade evidence (Priority 5): one trade by its stable ID, with its own stored bars; or the list of IDs.
  if (view === 'trade') {
    const want = (q.get('id') || '').trim().toUpperCase();
    const trade = want === 'LAST' ? lastTrade(trades) : findTrade(trades, q.get('id'));
    if (!trade) return { ...base, ok: false, error: want === 'LAST' ? 'CHE has no closed forward paper or simulation trade yet.' : `No CHE trade has the ID ${want || '(none)'}.` };
    return { ...base, trade: tradeEvidenceOf(trade, await tradeBars(storage, trade)) };
  }
  if (view === 'trades') return { ...base, ...tradeList(shown, { limit: Math.min(200, Number(q.get('limit')) || 100) }) };
  if (view === 'ranking') return { ...base, ranking: rankStrategies(shown, { executionType: filters.execution_type || 'forward_paper' }), rule: 'Ranked by the lower end of the 95% expectancy range in R, never by win rate; under 30 trades is provisional.' };
  const l = currentLeader(trades);
  return { ...base, totals: metricsOf(shown), leader: l.leader, headline: l.headline, provisional: l.provisional,
    pnl: dailyPnl({ trades, positions: await openPositions(storage), lastBar: await lastForwardBar(storage), day: today }) };
}
