// CHE's trade records, read by name (owner, 2026-10-20). CHE keeps several separate record sets:
// the strategy simulation (1-minute paper strategies), the forward paper journal (MNQ 5-minute
// paper trades), the daily evidence pass, the Trading Lab's paper book, and orders held at the
// broker. Each has its own storage and its own count; they are never added together. A question
// that names one of them ("the simulator's last trade", "the paper journal vs the simulation"),
// a record id, a storage key or the sample rule is answered here from the real records, and
// never by a language model: a model once invented sim-2023-03-10-001, paper-2023-02-20-001 and
// storage keys named simulation_trades and journal_trades. Read only: nothing here orders, spends
// or calls a model. A record set that cannot be read says so instead of giving a number.
import { MIN_SAMPLE, STATE_KEY as SIM_STATE_KEY, TRADE_CAP, TRADE_CHUNK, leaderboard, readSimState, readStoredTrades, strategySimIntent } from './strategy_sim.js';
import { LIVE_PORTFOLIOS, LIVE_RUNS, LIVE_STATE, RESOLUTION, liveDashboard } from './trading_live.js';
import { EVIDENCE_PORTFOLIOS, EVIDENCE_RUNS, evidenceIntent } from './trading_evidence_runner.js';
import { MIN_TRADES, RECORD_PREFIX, readTrades, summarize } from './trading_evidence.js';
import { readBook, tradingIntent } from './trading_lab.js';
import { ORDER_ASK, liveIntent } from './trading_live_chat.js';
import { deskIntent } from './trading_desk.js';

export const LEDGER_SOURCE = 'che_trading_ledgers';

/** Every record set, with the real storage it lives in. The order is the order they are read aloud. */
export const LEDGERS = Object.freeze([
  {
    id: 'strategy_simulation', label: 'strategy simulation',
    what: 'paper strategies on 1-minute bars (BTCUSDT, ETHUSDT, MNQ), stepped every minute',
    storage_keys: [SIM_STATE_KEY, 'strategy_sim_trades:<chunk number>'], module: 'strategy_sim.js',
    rule: `a strategy is profitable only with ${MIN_SAMPLE} out-of-sample trades, positive expectancy after costs and a 95% Wilson lower bound above break-even; ${TRADE_CHUNK} is the size of one storage chunk and ${TRADE_CAP} the cap on stored trades, neither is a sample rule`,
  },
  {
    id: 'forward_paper_journal', label: 'forward paper journal',
    what: 'MNQ 5-minute forward paper trades from the Trading Room engine',
    storage_keys: [LIVE_STATE, LIVE_PORTFOLIOS, LIVE_RUNS, `${RECORD_PREFIX}paper:<portfolio>:<entry time> (resolution ${RESOLUTION})`], module: 'trading_live.js',
    rule: `a strategy is ranked only after ${MIN_TRADES} journal trades`,
  },
  {
    id: 'daily_evidence', label: 'daily evidence pass',
    what: 'NQ daily-bar research trades from the evidence pass',
    storage_keys: [EVIDENCE_RUNS, EVIDENCE_PORTFOLIOS, `${RECORD_PREFIX}paper:<portfolio>:<entry time> (daily)`], module: 'trading_evidence_runner.js',
    rule: `a result is evidence only after ${MIN_TRADES} trades`,
  },
  {
    id: 'lab_paper_book', label: 'Trading Lab paper book',
    what: 'the Trading Lab watch list and its learning paper trades',
    storage_keys: ['trading_paper_book'], module: 'trading_lab.js',
    rule: 'learning only; never promoted on its own',
  },
  {
    id: 'broker_alpaca_paper', label: 'Alpaca PAPER account',
    what: 'orders held at Alpaca, read live when asked',
    storage_keys: [], module: 'broker_alpaca.js',
    rule: 'not a CHE ledger: say "check my Alpaca paper orders" to read it from Alpaca',
  },
]);

// ─── The question ─────────────────────────────────────────────────────────

const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chay|chey)[,:]?\s+)?/i;
// Trading words proper. "Record", "position" and a bare "journal" are not: "a record of my dentist appointment",
// "your last position at the company" and "your last journal entry" are other routes' (review of PR #373).
const TRADE_WORDS = /\btrad(?:e|es|ed|ing|er)\b|\bstrateg(?:y|ies)\b|\bprofit\w*|\bwin\s+rate\b|\bledgers?\b|\bp\s*&\s*l\b|\bpnl\b|\bpaper\s+journal\b|\bsimulat(?:ion|or)\b/i;
const NAMED = {
  strategy_simulation: /\bstrateg(?:y|ies)\s+sim(?:ulation)?\b|\bsimulat(?:ion|or)(?:'s)?\b|\bsim\s+trades?\b/i,
  // "Trading journal" and "my trading journal" are the Trading Lab's book (the /trade-journal command, trading_lab.speakBook).
  forward_paper_journal: /\b(?:forward|live)\s+paper\b|\bpaper(?:\s+trading)?\s+journal\b|\bjournal\s+trades?\b/i,
  daily_evidence: /\bevidence\s+pass\b|\bdaily\s+(?:research|evidence)\b/i,
  lab_paper_book: /\btrading\s+lab\b|\bpaper\s+book\b|\blab(?:'s)?\s+(?:paper\s+)?(?:trades?|book)\b/i,
  broker_alpaca_paper: /\balpaca\b/i,
};
// The desk's simulated account is NinjaTrader's, not this simulation (same rule as strategySimIntent).
const DESK_SIM = /\bsimulat(?:ion|ed)\s+(?:trading|account|accounts|mode)\b|\bbroker\s+simulation\b|\bswitch\s+to\s+simulation\b/i;
// A made-up trade record id looks like sim-2023-03-10-001; CHE's own ids never do, and an order or ticket id is not a trade.
const RECORD_ID = /\b(?:sim|paper|trade|journal|evidence|ledger|strategy|fill|position)[-_](?:\d{4}-\d{2}-\d{2}|\d{8})[-_]\d{2,}\b/i;
const KINDS = [
  ['record', /\b(?:pull|show|read|find|look\s+up|retrieve|open|fetch|get)\b[^.!?\n]{0,40}\brecord\b|\brecord\s+(?:for|of|named|called)\b/i],
  ['storage', /\bstorage\s+keys?\b|\bwhich\s+keys?\b|\bwhere\s+(?:do\s+you|is|are|does)\b[^.!?\n]{0,30}\b(?:store|stored|kept|saved|live|held)\b|\bunder\s+what\s+key\b/i],
  ['rule', /\b(?:30|100|thirty|hundred|\d+)[- ]trade\b|\bsample\s+(?:size|you\s+need|required|requirement|rule)\b|\bbefore\s+you\s+(?:call|count|rank|promote|trust)\b|\bout[- ]of[- ]sample\b|\bminimum\s+(?:number\s+of\s+)?trades?\b|\bhow\s+many\s+trades\s+(?:do\s+you\s+need|before|until|are\s+(?:needed|required))/i],
  ['settings', /\b(?:settings?|parameters?|params|configuration|config)\b/i],
  ['best', /\bbest\b|\bmost\s+profitable\b|\btop\s+strateg|\bleaderboard\b|\bwinning\s+strateg|\bperforming\b/i],
  ['last', /\b(?:last|latest|newest|most\s+recent|final)\b[^.!?\n]{0,30}\b(?:trade|entry|record|position|fill)\b|\bnewest\s+entry\b/i],
  ['count', /\bhow\s+many\b|\bnumber\s+of\b|\bcount\b|\btotal\b/i],
  ['compare', /\bversus\b|\bvs\.?\b|\bcompared?\b|\bdifferen(?:ce|t)\b|\bbut\s+(?:the|my|your)\b|\bwhy\s+(?:does|do|is|are)\b|\bonly\s+\d+\b|\bboth\b/i],
];

/** Which record sets the owner named and what he asked of them, or null when another route owns the turn. */
export function ledgerIntent(message) {
  const text = String(message || '').replace(/[’']/g, "'").replace(WAKE, '').trim();
  if (!text || text.length > 1200) return null;
  const recordId = RECORD_ID.exec(text)?.[0] || '';
  if (!TRADE_WORDS.test(text) && !recordId) return null;
  // Orders, desk reads and the simulation's own controls (pause, resume, the plain status forms) keep
  // their routes and their holds; a specific read of the simulation ("its best strategy") is answered here.
  const sim = strategySimIntent(text);
  if (ORDER_ASK.test(text) || deskIntent(text) || (sim && sim.kind !== 'status')) return null;
  if (DESK_SIM.test(text)) return null;
  // A coding, messaging or peer request that mentions trading belongs to its own route.
  if (/\b(?:code|coding|feature|function|bug|fix|pull\s+request|commit|deploy|e-?mail|mailbox|youtube|video|website)\b|\b(?:ask|tell)\s+(?:claude|chatgpt|codex|gemini|cursor|copilot|grok)\b/i.test(text)) return null;
  const ledgers = LEDGERS.filter((l) => NAMED[l.id].test(text)).map((l) => l.id);
  const kinds = KINDS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  if (recordId && !kinds.includes('record')) kinds.unshift('record');
  // "Pull the record" with no trade record id is a memory or document question, not a ledger read.
  if (kinds[0] === 'record' && !recordId) { kinds.shift(); if (!ledgers.length) return null; }
  if (sim && ledgers.length <= 1 && !kinds.length && !recordId) return null;
  let kind = kinds[0] || (ledgers.length > 1 ? 'compare' : ledgers.length ? 'status' : '');
  if (ledgers.length > 1 && kinds.includes('compare')) kind = 'compare';
  if (!kind) return null;
  // Nothing named and no record, key or rule asked: the existing trading reads keep their turns
  // ("how many paper trades did you win", "which trading strategy is performing best").
  if (!ledgers.length && kind !== 'record') {
    // A question about the owner's own strategy or a lesson ("is my sample size of 30 trades enough",
    // "what settings should I use", "your best profit tip") is teaching, not a read of CHE's records: it
    // needs "you" or "your" and a trading noun (a trade, a strategy, P&L, a win rate, a ledger).
    if (!/\byou(?:r|rs)?\b/i.test(text) || /\b(?:my|mine|our|should|would|how\s+do\s+i|tips?|advice|ideas?|lessons?)\b/i.test(text)) return null;
    if (!/\btrades?\b|\bstrateg(?:y|ies)\b|\bpnl\b|\bp\s*&\s*l\b|\bwin\s+rate\b|\bledgers?\b|\bsimulat|\bpaper\s+journal\b/i.test(text)) return null;
    if (kind !== 'storage' && kind !== 'rule') {
      if (liveIntent(text) || evidenceIntent(text) || tradingIntent(text)) return null;
      if (!['last', 'best', 'settings', 'count'].includes(kind)) return null;
    }
  }
  return { ledgers: ledgers.length ? ledgers : LEDGERS.map((l) => l.id), named: ledgers, kind, kinds, record_id: recordId || null };
}

// ─── The records ──────────────────────────────────────────────────────────

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const isLive = (t) => t.environment === 'paper' && t.data?.resolution === RESOLUTION;
const isDaily = (t) => t.environment === 'paper' && (t.data?.resolution ?? 'daily') === 'daily';

async function safely(id, read) {
  const base = LEDGERS.find((l) => l.id === id);
  try {
    return { ...base, unavailable: false, ...(await read()) };
  } catch (error) {
    return { ...base, unavailable: true, trades: null, error: String(error?.message || error).slice(0, 160) };
  }
}

function simTrade(t) {
  if (!t) return null;
  return {
    id: t.id, strategy: t.strategy, symbol: t.symbol, signal_t: t.signal_t, entry_t: t.entry_t, exit_t: t.exit_t, exit_reason: t.exit_reason,
    entry: r2(t.entry), exit: r2(t.exit), stop: r2(t.stop), target: r2(t.target), r: r3(t.r), params: t.params || null,
  };
}

function journalTrade(t) {
  if (!t) return null;
  return {
    key: `${RECORD_PREFIX}${t.environment}:${t.portfolio}:${t.entry.time}`, strategy: t.strategy, filter: t.filter, side: t.side, contract: t.contract, qty: t.qty,
    entry_time: t.entry.time, entry: r2(t.entry.fill), exit_time: t.exit.time, exit: r2(t.exit.fill), exit_reason: t.exit.reason, net_pnl: r2(t.net_pnl), r_net: r3(t.r_net), params: t.params || null,
  };
}

/** Every record set, read separately. `trades` is that set's own count; a set that cannot be read says so. */
export async function readLedgers(storage, { now = Date.now() } = {}) {
  const sim = await safely('strategy_simulation', async () => {
    const state = await readSimState(storage);
    const trades = await readStoredTrades(storage, state.trades);
    const board = leaderboard(trades, state.symbols);
    const lead = board.find((row) => row.trades > 0) || null;
    return {
      status: state.paused ? 'paused' : 'running', last_tick: state.last_tick || null, trades: state.trades.stored, dropped: state.trades.dropped,
      open: Object.keys(state.open || {}).length, newest: simTrade(trades[trades.length - 1]),
      best: lead && { strategy: lead.id, name: lead.name, trades: lead.trades, win_rate: lead.win_rate, expectancy_r: r3(lead.expectancy_r), out_of_sample: lead.sample_size, out_of_sample_expectancy_r: r3(lead.out_of_sample.expectancy_r), label: lead.label, reasons: lead.reasons, params: lead.params },
      profitable: board.filter((row) => row.label === 'profitable').length, strategies: board.length, min_sample: MIN_SAMPLE,
    };
  });
  const journal = await safely('forward_paper_journal', async () => {
    const dash = await liveDashboard(storage, { now });
    const best = dash.by_strategy[0] || null;
    return {
      status: dash.state?.enabled ? 'on' : 'off', trades: dash.totals.trades, wins: dash.totals.wins, losses: dash.totals.losses, win_rate: dash.totals.win_rate,
      net_pnl: dash.totals.net_pnl, expectancy_r: dash.totals.expectancy_r, open: dash.positions.length, newest: journalTrade(dash.trades[0]),
      feed: dash.feed ? { status: dash.feed.status, provider: dash.feed.provider, checked_at: dash.feed.checked_at } : null,
      best: best && { strategy: best.strategy, name: best.name, filter: best.filter, trades: best.trades, win_rate: best.win_rate, expectancy_r: best.expectancy_r, net_pnl: best.net_pnl, ranked: best.ranked, params: { target_r: best.target_r, filter: best.filter } },
      min_sample: MIN_TRADES, last_run: dash.runs[0]?.at || null,
    };
  });
  const evidence = await safely('daily_evidence', async () => {
    const trades = await readTrades(storage, isDaily);
    const runs = (await storage.get(EVIDENCE_RUNS)) || [];
    const s = summarize(trades);
    return { status: runs.length ? 'ran' : 'not run yet', runs: runs.length, trades: s.trades, wins: s.wins, losses: s.losses, win_rate: s.win_rate, net_pnl: s.net_pnl, expectancy_r: s.expectancy_r, newest: journalTrade(trades[trades.length - 1]), min_sample: MIN_TRADES, last_run: runs[runs.length - 1]?.at || null };
  });
  const lab = await safely('lab_paper_book', async () => {
    const book = await readBook(storage);
    const last = book.closed[book.closed.length - 1] || null;
    return { status: 'learning', trades: book.closed.length, open: book.open.length, watching: book.watch.length, newest: last && { id: last.id, symbol: last.symbol, strategy: last.strategy, closed_at: last.closed_at, r: r3(last.r) } };
  });
  const broker = { ...LEDGERS[4], unavailable: false, trades: null, status: 'read live on request' };
  return [sim, journal, evidence, lab, broker];
}

// ─── Said aloud and shown as large text ───────────────────────────────────

const n = (x, word = 'trade') => `${x} ${word}${x === 1 ? '' : 's'}`;
const money = (x) => (x == null ? 'not measured' : `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toFixed(2)}`);
const whenShort = (iso) => (iso ? String(iso).replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, ' UTC') : 'unknown time');

function newestLine(l) {
  if (!l.newest) return 'no closed trade recorded yet';
  const t = l.newest;
  if (l.id === 'strategy_simulation' && t.r != null) return `newest: ${t.strategy} on ${t.symbol}, signal ${whenShort(t.signal_t)}, exit on ${t.exit_reason} at ${whenShort(t.exit_t)}, ${t.r >= 0 ? '+' : ''}${t.r} R after costs (record ${t.id})`;
  if (l.id === 'lab_paper_book') return `newest: ${t.strategy} on ${t.symbol}, closed ${whenShort(t.closed_at)}${t.r == null ? '' : `, ${t.r >= 0 ? '+' : ''}${t.r} R`}`;
  if (l.id === 'strategy_simulation' && t.r == null) return `newest: ${t.strategy} on ${t.symbol}, signal ${whenShort(t.signal_t)}, exit on ${t.exit_reason} at ${whenShort(t.exit_t)} (record ${t.id})`;
  return `newest: ${t.side} ${t.qty} ${t.contract}, ${t.strategy}, entered ${whenShort(t.entry_time)}, exited on ${t.exit_reason} at ${whenShort(t.exit_time)}, net ${money(t.net_pnl)} (record ${t.key})`;
}

function bestLine(l, withSettings) {
  if (!l.best) return 'no strategy has a closed trade yet, so there is no best one';
  const b = l.best;
  const settings = withSettings && b.params ? ` Settings: ${Object.entries(b.params).map(([k, v]) => `${k} ${v}`).join(', ')}.` : '';
  if (l.id === 'strategy_simulation') {
    return `${b.label === 'profitable' ? 'best' : 'leading, not proven yet'}: ${b.name}, ${n(b.trades)}, win rate ${b.win_rate == null ? 'not measured' : `${Math.round(b.win_rate * 100)}%`}, ${b.out_of_sample} out of sample at ${b.out_of_sample_expectancy_r} R per trade${b.label === 'profitable' ? '' : ` (${b.reasons.join('; ')})`}.${settings}`;
  }
  return `${b.ranked ? 'best' : 'leading, not ranked yet'}: ${b.name}, ${n(b.trades)}, win rate ${b.win_rate == null ? 'not measured' : `${b.win_rate}%`}, ${b.expectancy_r} R per trade, net ${money(b.net_pnl)}${b.ranked ? '' : ` (fewer than ${l.min_sample} trades)`}.${settings}`;
}

function countLine(l) {
  if (l.id === 'strategy_simulation') return `${n(l.trades)} stored${l.dropped ? `, ${l.dropped} oldest dropped by the cap` : ''}, ${n(l.open, 'open position')}, ${l.status}`;
  if (l.id === 'forward_paper_journal') return `${n(l.trades)} journalled (${l.wins} won, ${l.losses} lost), ${n(l.open, 'open position')}, paper trading ${l.status}`;
  if (l.id === 'daily_evidence') return `${n(l.trades)} recorded over ${n(l.runs, 'pass')}${l.runs ? '' : ' (the pass has not run yet)'}`;
  if (l.id === 'lab_paper_book') return `${n(l.trades, 'closed trade')}, ${n(l.open, 'open')}, watching ${l.watching} markets`;
  return 'not counted here; its orders live at Alpaca';
}

/** One numbered line per record set asked about, each named by its source, never combined. */
export function speakLedgers(intent, ledgers) {
  const chosen = ledgers.filter((l) => intent.ledgers.includes(l.id));
  const lines = [];
  if (intent.kind === 'record') {
    // CHE's own ids are strategy|symbol|entry minute and evr:paper:<portfolio>:<entry time>; an id of this shape was never issued.
    lines.push(`No record named ${intent.record_id} exists in any of my record sets, sir, so I will not describe one. Simulation trades are keyed strategy|symbol|entry minute inside strategy_sim_trades chunks; journal trades are keyed ${RECORD_PREFIX}paper:<portfolio>:<entry time>. A model never gets to invent an id.`);
    return lines.join('\n');
  }
  if (intent.kind === 'rule') {
    lines.push(`The sample rules, sir, one per record set:`);
    for (const l of chosen.filter((x) => x.id !== 'broker_alpaca_paper')) lines.push(`${lines.length}. ${l.label}: ${l.rule}.`);
    lines.push(`There is no 100-trade requirement anywhere: ${TRADE_CHUNK} is only how many simulation trades fit in one storage chunk.`);
    return lines.join('\n');
  }
  if (intent.kind === 'storage') {
    lines.push('Where each record set lives, sir (Worker durable storage; nothing is named simulation_trades or journal_trades):');
    for (const l of chosen) lines.push(`${lines.length}. ${l.label}: ${l.storage_keys.length ? l.storage_keys.join(', ') : 'no CHE storage, read from Alpaca when asked'} (${l.module}).`);
    return lines.join('\n');
  }
  lines.push(chosen.length > 1 ? 'Separate record sets, sir; I never add them together.' : `From the ${chosen[0].label}, sir (${chosen[0].what}):`);
  for (const l of chosen) {
    // The exception text stays in the API record; the owner hears only that the read failed.
    if (l.unavailable) { lines.push(`${lines.length}. ${l.label}: I could not read it just now, so I give no number for it.`); continue; }
    if (l.id === 'broker_alpaca_paper') { lines.push(`${lines.length}. ${l.label}: ${l.rule}.`); continue; }
    const parts = [countLine(l)];
    if (['last', 'status', 'compare'].includes(intent.kind) || intent.kinds.includes('last')) parts.push(newestLine(l));
    if (['best', 'settings', 'status', 'compare'].includes(intent.kind) || intent.kinds.includes('best')) parts.push(bestLine(l, intent.kind === 'settings' || intent.kinds.includes('settings')));
    lines.push(`${lines.length}. ${l.label} (${l.what}): ${parts.join('; ')}.`);
  }
  if (intent.kind === 'compare') lines.push('Each count is that set\'s own closed trades; the simulation and the journal are different strategies on different bars, so their numbers never match and are never summed.');
  lines.push('Paper only: no money, no broker order and no model call in this answer.');
  return lines.join('\n');
}
