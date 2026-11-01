// Status questions about CHE's trading and memory: is trading live, is the market data real-time, is Rithmic
// connected, what was the latest paper trade, what has CHE learned, and is long-term memory storing.
//
// Every answer is built from stored runtime records: the forward-paper feed and journal (trading_live.js), the
// Rithmic candles the owner's phone sent (rithmic_dataset.js) and the conversation-memory store (brain_memory.js).
// A missing record is said to be missing. Nothing here guesses a connection, a trade or a memory, and nothing calls a model.
import { conversationMemoryCount, listConversationMemories } from './brain_memory.js';
import { rithmicStatus } from './rithmic_dataset.js';
import { liveAnswer, tradeLine } from './trading_live_chat.js';
import { namesOtherSubject, subjectSet } from './route_subject.js';

// A status question is short. A long turn about other things keeps its own route.
const MAX_STATUS_TURN = 400;

const RITHMIC = /\brithmic\b/i;
const RITHMIC_STATE = /\b(?:connect\w*|live|working|receiv\w*|status|feed|data|running|online|logged|up|on)\b/i;
const MEMORY = /\bmemor(?:y|ies)\b/i;
// Asking CHE to recall, forget or fill in what she remembers is a memory question, not a status check. Those go to the recall route.
const MEMORY_RECALL = /\b(?:remember|recall|forget|fill in|blanks?|from memory|tell me what|what (?:did|do|have|was|is|were|are) i|what (?:is|was) my|i (?:said|told you)|my (?:birthday|cousin|job|city|voice))\b/i;
// The memory status answers how many conversation memories are stored and whether storing works. A turn that names
// another subject ("what secrets are stored in your memory") asks about contents, not the store's health.
const MEMORY_SUBJECT = subjectSet(['memory', 'memories', 'long', 'term', 'longterm', 'conversation', 'conversations', 'working',
  'works', 'work', 'status', 'health', 'healthy', 'saved', 'saving', 'stored', 'storing', 'store', 'record', 'records', 'recording',
  'many', 'count', 'check', 'available', 'on', 'off', 'running', 'enabled', 'active', 'persistent', 'permanent', 'fine', 'broken',
  'full', 'empty', 'size', 'number', 'total', 'tell', 'show', 'give', 'let', 'know', 'yours']);
const MEMORY_STATE = /\b(?:working|works|status|health|saved|stored|records?|how\s+many|count|check|is\s+(?:your|the)|are\s+(?:your|the)|available|on)\b/i;
const LATEST = /\b(?:latest|last|newest|most\s+recent)\s+(?:paper\s+)?trade\b|\b(?:show|read|tell)\s+me\s+(?:your|the)\s+(?:latest|last|newest|most\s+recent)\b[\s\S]{0,15}\btrade\b/i;
const FEED = /\b(?:real[-\s]?time|live)\s+(?:market\s+)?(?:data|feed|prices?|quotes?|bars?)\b|\b(?:receiv\w*|getting|get|have)\s+(?:any\s+|real[-\s]?time\s+)?(?:market\s+)?(?:data|prices?|bars?)\b|\b(?:is|are)\s+(?:your|the)\s+(?:trading|feed|market\s+data|data)\s+(?:live|on|connected|running|working|status)\b|\b(?:is|are)\s+(?:you|your\s+trading)\s+live\b/i;
const EVIDENCE_WORDS = /\b(?:replay|evidence|prove|proof|verify|verified|why|explain|audit|receipt|reason)\b/i;
const LEARNED = /\b(?:what\s+(?:have|did)\s+you\s+(?:learn|learned)|trading\s+(?:skills?|lessons?|learning))\b/i;

/**
 * The status question in [message], or null. The first match wins, in this order: Rithmic, memory, the latest paper
 * trade, the live feed, and what was learned. Each names a kind the reply builder answers from records.
 */
export function tradingStatusIntent(message) {
  const text = String(message || '').trim().replace(/[’']/g, "'");
  if (!text || text.length > MAX_STATUS_TURN) return null;
  // Replays, proofs and explanations of a trade belong to the evidence and why routes, not the status route.
  if (EVIDENCE_WORDS.test(text)) return null;
  if (RITHMIC.test(text) && RITHMIC_STATE.test(text)) return { kind: 'rithmic' };
  if (MEMORY.test(text) && MEMORY_STATE.test(text) && !MEMORY_RECALL.test(text) && !namesOtherSubject(text, MEMORY_SUBJECT)) return { kind: 'memory' };
  if (LATEST.test(text)) return { kind: 'latest' };
  if (FEED.test(text)) return { kind: 'live' };
  if (LEARNED.test(text)) return { kind: 'learning' };
  return null;
}

const when = (iso) => {
  const ms = Date.parse(iso);
  if (!iso || Number.isNaN(ms)) return 'an unknown time';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' Central';
};

/** The feed sentence, from the stored feed record: provider, symbol, status, last bar and when it was checked. */
export function feedSentence(dash) {
  const f = dash?.feed;
  if (!f) return `No market data has been read yet, sir. ${dash?.feed_blocker || ''}`.trim();
  const parts = [`Market data: ${f.status} from ${f.provider} ${f.provider_symbol}${f.contract ? ` (${f.contract})` : ''}.`];
  parts.push(f.status === 'LIVE' ? 'That is real-time data.' : 'That is delayed data: research only, not execution evidence.');
  if (f.last_bar_time) parts.push(`Last bar ${when(f.last_bar_time)}${Number.isFinite(f.latency_s) ? `, about ${Math.round(f.latency_s)} seconds behind` : ''}.`);
  if (f.checked_at) parts.push(`Feed checked ${when(f.checked_at)}.`);
  if (f.error) parts.push(`Last feed error: ${f.error}.`);
  return parts.join(' ');
}

const paperState = (dash) => (dash?.state?.enabled
  ? `Paper trading is on, sir${dash.state.started_at ? `, since ${when(dash.state.started_at)}` : ''}`
  : `Paper trading is off, sir${dash?.state?.stopped_at ? `, since ${when(dash.state.stopped_at)}` : ''}`);

const realMoney = (dash) => (dash?.broker?.live_orders === 'disabled'
  ? 'Real-money orders are disabled.'
  : 'Real-money orders need your approval of each exact order.');

/**
 * Reads the stored records each status answer needs. [dash] is the trading dashboard (liveTradingDashboard in the
 * Worker). Memory is read as a count and the newest record's time, never its text.
 */
export async function gatherTradingStatus(storage, dash) {
  const [count, newest, rithmic] = await Promise.all([
    conversationMemoryCount(storage),
    listConversationMemories(storage, { limit: 1 }).then((rows) => rows[0] || null),
    rithmicStatus(storage),
  ]);
  return { dash, rithmic, memory: { count, latest_at: newest?.at || null } };
}

/** The spoken answer for one status kind, from the gathered records. Pure: no storage, no clock, no model. */
export function tradingStatusReply(kind, facts) {
  const { dash, rithmic, memory } = facts;
  switch (kind) {
    case 'live':
      return `${paperState(dash)}. ${feedSentence(dash)} ${realMoney(dash)} Paper trades are simulated and send no broker order.`;
    case 'rithmic': {
      if (!rithmic.symbols.length) {
        return 'No Rithmic candles have reached this server yet, sir. Rithmic logs in on your iPhone and its login never reaches the Worker, so I cannot see whether the phone is connected right now. The phone sends each closed one-minute candle when it records one.';
      }
      const list = rithmic.symbols.map((s) => `${s.symbol}: ${s.hours} hour${s.hours === 1 ? '' : 's'} recorded, newest candle ${when(s.latest_t)}, received ${when(s.received_at)}`).join('; ');
      return `The server holds Rithmic one-minute candles from your phone, sir: ${list}. That is a record of what the phone sent, not a live connection check. The Rithmic login stays on your iPhone.`;
    }
    case 'memory':
      if (!memory.count) return 'No conversation memories are stored yet, sir, so long-term memory has nothing to recall.';
      return `Long-term memory is storing: ${memory.count} conversation memor${memory.count === 1 ? 'y' : 'ies'}, the newest saved ${when(memory.latest_at)}. That is the stored record. I did not run a recall test just now.`;
    case 'latest': {
      const t = dash?.trades?.[0];
      if (!t) return `No paper trade has closed yet, sir. ${dash?.positions?.length || 0} open. ${feedSentence(dash)}`;
      return `Latest closed paper trade: ${tradeLine(t)}. Paper only, no real money.`;
    }
    case 'learning':
      return liveAnswer({ kind: 'learning' }, dash);
    default:
      return feedSentence(dash);
  }
}
