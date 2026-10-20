// The room event queue (owner, 2026-10-20): a room that produces a verified fact or a meaningful
// change (a journalled trade, a finished REA investigation, a coding receipt, a chat conclusion)
// queues one event here with its source and status. The Brain drains the queue (brain_rooms.js)
// on the next chat turn, Brain sync or alarm, writes one record with provenance, links it to what
// it already knows and the phone picks it up through /api/brain/changes. No imports, so any module
// can queue without pulling the Brain in. Nothing here is a second event bus: it is a bounded list
// in the same durable storage, drained by the one Brain store.
export const ROOM_EVENTS_KEY = 'che_room_events';
export const ROOM_EVENT_LIMIT = 120;

/** The statuses a room may give a conclusion; anything else is refused. */
export const EVENT_STATUSES = Object.freeze(['verified', 'derived', 'observed', 'inferred', 'hypothesis', 'proposed', 'unknown', 'superseded', 'contradicted']);

/**
 * Queues one event. `room` names the producing room (brain_rooms.ROOMS), `status` is one of
 * EVENT_STATUSES, `key` dedupes repeats of the same fact, `evidence` lists what backs it (ids,
 * urls, receipts), `refs` points at the authoritative record ("read it live there, do not copy").
 */
// One isolate is one Durable Object, so every queue write goes through this chain. A read-modify-write can then
// never interleave with another one in the same isolate (review, 2026-10-20).
let queueChain = Promise.resolve();
const serialised = (task) => { const next = queueChain.then(task, task); queueChain = next.catch(() => {}); return next; };

export async function queueRoomEvent(storage, event, now = Date.now()) {
  return serialised(() => queueRoomEventNow(storage, event, now));
}

async function queueRoomEventNow(storage, event, now) {
  if (!storage?.get || !storage?.put || !event || typeof event !== 'object') return false;
  if (!event.room || !event.title) return false;
  const status = EVENT_STATUSES.includes(event.status) ? event.status : 'unknown';
  let list = [];
  try { list = (await storage.get(ROOM_EVENTS_KEY)) || []; } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  const entry = {
    room: String(event.room).slice(0, 40), kind: String(event.kind || 'event').slice(0, 40), key: String(event.key || '').slice(0, 160),
    title: String(event.title).slice(0, 200), body: String(event.body || '').slice(0, 4000), status,
    evidence: Array.isArray(event.evidence) ? event.evidence.map((e) => String(e).slice(0, 300)).slice(0, 12) : [],
    refs: event.refs && typeof event.refs === 'object' ? event.refs : {},
    confidence: Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null,
    derivation: String(event.derivation || '').slice(0, 600),
    requires_owner_confirmation: Boolean(event.requires_owner_confirmation),
    surface: Boolean(event.surface),
    supersedes: String(event.supersedes || '').slice(0, 160),
    sensitivity: String(event.sensitivity || 'room').slice(0, 20),
    at: event.at || new Date(now).toISOString(),
  };
  if (entry.key && list.some((item) => item.key === entry.key && item.room === entry.room)) return false;
  list.push(entry);
  try { await storage.put(ROOM_EVENTS_KEY, list.slice(-ROOM_EVENT_LIMIT)); } catch (_) { return false; }
  return true;
}

/** The queued events, read only. The caller publishes them, then acknowledges the ones it handled. */
export async function peekRoomEvents(storage) {
  try { const list = (await storage.get(ROOM_EVENTS_KEY)) || []; return Array.isArray(list) ? list : []; } catch (_) { return []; }
}

/** Identity of a queued event, the same for a repeat, so a handled event is removed exactly once. */
export const eventSignature = (event) => `${event?.room || ''}|${event?.key || ''}|${event?.at || ''}|${event?.title || ''}`;

/**
 * Removes the events a drain has handled. Events queued meanwhile stay, and a crash before this call
 * leaves the events queued: publishing is idempotent (the Brain answers 'present' to a repeat), so a
 * repeat drain is safe. Owner review 2026-10-20: the old take-then-write lost events on a crash.
 */
export async function ackRoomEvents(storage, handled) {
  return serialised(() => ackRoomEventsNow(storage, handled));
}

async function ackRoomEventsNow(storage, handled) {
  const done = new Set(handled.map(eventSignature));
  if (!done.size) return 0;
  const list = await peekRoomEvents(storage);
  const kept = list.filter((event) => !done.has(eventSignature(event)));
  try { await storage.put(ROOM_EVENTS_KEY, kept); } catch (_) { return 0; }
  return list.length - kept.length;
}

/**
 * A receipt (truth_layer.recordReceipt) as a room event, or null for kinds that are not room conclusions
 * (tool executions are kept losslessly in their own store). Every mapped event is verified: a receipt is
 * written only by the Worker after the real action.
 */
// Tools that act on music: the generic music connector, Spotify, Apple Music, playlists, songs.
// Matched on the name with "_" and "-" read as spaces ("music_control" -> "music control").
const MUSIC_TOOL = /\b(?:music|spotify|apple music|playlists?|songs?|albums?|soundcloud)\b/i;

export function receiptEvent(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const at = r.at || new Date().toISOString();
  const number = Number(r.number) > 0 ? `#${Number(r.number)}` : '';
  const short = (text, n = 160) => String(text || '').slice(0, n);
  // A study receipt names its repositories as a list (one or many).
  const repos = (x) => (Array.isArray(x.repos) ? x.repos.map(String).join(', ') : String(x.repo || ''));
  const coding = (title, body) => ({ room: 'coding', kind: r.kind, key: `${r.kind}:${r.number || r.job_id || r.key || at}`, title, body, status: 'verified', evidence: [`receipt ${r.kind} ${at}`], refs: { receipt: r.key || '', job_id: r.job_id || '', number: r.number || null, url: r.url || '' }, at });
  switch (r.kind) {
    case 'job_started': return coding(`Coding job ${short(r.job_id, 12)} started${r.job_kind ? ` (${short(r.job_kind, 30)})` : ''}`, short(r.topic || r.request || r.detail || '', 400));
    case 'proposal_ready': return { ...coding(`Change proposal ready${number ? ` ${number}` : ''}`, short(r.summary || r.detail, 400)), status: 'proposed' };
    case 'pr_opened': return coding(`Pull request ${number} opened: ${short(r.summary, 100)}`, `${short(r.summary, 300)}${r.url ? `\n${r.url}` : ''}${Array.isArray(r.files) ? `\nFiles: ${r.files.slice(0, 8).join(', ')}` : ''}`);
    case 'update_approved': return coding(`Update ${number} approved by the owner`, short(r.detail, 300));
    case 'ci_passed': return coding(`Checks passed on pull request ${number}`, short(r.detail, 300));
    case 'merged': return coding(`Pull request ${number} merged${r.sha ? ` as ${String(r.sha).slice(0, 12)}` : ''}`, short(r.detail, 300));
    case 'deployed': return coding(`Update ${number} deployed to the live Worker`, short(r.detail, 300));
    case 'deploy_failed': return { ...coding(`Deploy of update ${number} failed`, short(r.detail || r.error, 300)), status: 'verified' };
    case 'study_started': return coding(`Repository study started${repos(r) ? `: ${short(repos(r), 80)}` : ''}`, short(r.topic ? `Topic: ${r.topic}` : repos(r), 300));
    case 'study_complete': return coding(`Repository study complete${repos(r) ? `: ${short(repos(r), 80)}` : ''}`, `${Number(r.findings) || 0} finding${Number(r.findings) === 1 ? '' : 's'}${r.topic ? ` on ${r.topic}` : ''}.`);
    case 'trade_placed': return { room: 'trading', kind: 'order', key: `trade_placed:${r.key || at}`, title: 'Live order placed through the trading desk', body: short(r.detail, 300), status: 'verified', evidence: [`receipt trade_placed ${at}`], refs: { receipt: r.key || '' }, at, sensitivity: 'private' };
    case 'paper_order_placed': return { room: 'trading', kind: 'paper_order', key: `paper_order:${r.key || at}`, title: `Alpaca PAPER order placed${r.symbol ? `: ${short(r.symbol, 12)}` : ''}`, body: short(r.detail, 300), status: 'verified', evidence: [`receipt paper_order_placed ${at}`], refs: { receipt: r.key || '', client_order_id: r.client_order_id || '' }, at };
    case 'mail_sent': return { room: 'office', kind: 'mail', key: `mail_sent:${r.key || at}`, title: `Flagstaff mail sent to ${short(r.peer || 'a peer', 24)}`, body: short(r.detail || r.text, 300), status: 'verified', evidence: [`receipt mail_sent ${at}`], refs: { receipt: r.key || '' }, at };
    // A music service or plugin really did something (owner, 2026-10-20): the Music Room's verified record.
    case 'tool_execution': {
      const tool = String(r.tool || '');
      if (r.status !== 'success' || !MUSIC_TOOL.test(`${tool} ${r.operation || ''}`.replace(/[_-]+/g, ' '))) return null;
      return { room: 'music', kind: 'action', key: `music:${r.invocation_id || r.key || at}`, title: `Music: ${short(r.operation || 'action', 60)} through ${short(tool, 40)}`, body: short(typeof r.verified_response === 'string' ? r.verified_response : JSON.stringify(r.verified_response ?? ''), 300), status: 'verified', evidence: [`receipt tool_execution ${r.invocation_id || ''} ${at}`.trim()], refs: { receipt: r.key || '', invocation_id: r.invocation_id || '' }, at };
    }
    case 'mail_received': return { room: 'office', kind: 'mail', key: `mail_received:${r.key || at}`, title: `Flagstaff mail received from ${short(r.peer || 'a peer', 24)}`, body: short(r.detail || r.text, 300), status: 'observed', evidence: [`receipt mail_received ${at}`], refs: { receipt: r.key || '' }, at };
    default: return null;
  }
}
