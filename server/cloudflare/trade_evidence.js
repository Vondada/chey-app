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
import { EVIDENCE_LABELS, readVisualTrades } from './trading_visual.js';

export const TRADE_EVIDENCE_SOURCE = 'che_trade_evidence';
export const NO_DATA = 'No recorded market data for this trade.';
const BEFORE = 40; // bars of context before the signal
const AFTER = 10; // bars after the exit
const RITHMIC_INDEX = 'rithmic_1m_index:';

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

/** The first stored series that covers the trade, with its provenance; never a mix of sources. */
export async function tradeBars(storage, trade) {
  const tf = trade.timeframe;
  const ms = msOf(tf);
  const market = String(trade.symbol || '').toUpperCase();
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
  return { bars: [], source: null };
}

const pub = ({ _raw, ...t }) => t;

/** What the replay screen needs for one trade. `null` when the ID is unknown. */
export function tradeEvidenceOf(trade, { bars = [], source = null } = {}) {
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
    bars, bars_source: source, no_data: bars.length ? null : NO_DATA,
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

/** One trade's full evidence, read from storage. */
export async function readTradeEvidence(storage, id) {
  const { trades } = await readVisualTrades(storage);
  const want = String(id || '').trim().toUpperCase();
  const trade = trades.find((t) => t.id === want);
  if (!trade) return { ok: false, error: `No CHE trade has the ID ${want || '(none)'}.`, id: want };
  return tradeEvidenceOf(trade, await tradeBars(storage, trade));
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
  const data = e.no_data ? ` ${e.no_data} The trade's details are shown without a chart.` : '';
  return `Opening the replay of trade ${e.id}: ${e.label}, ${e.strategy} ${e.side} on ${e.symbol} ${e.timeframe}, entered ${when(e.entry.time)} Eastern, ${out}${r}.${data}`;
}
