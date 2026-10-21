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
    case 'paper_order_placed': return { room: 'trading', kind: 'paper_order', key: `paper_order:${r.key || at}`, title: `Alpaca PAPER order placed${r.symbol ? `: ${[short(r.side, 8), r.qty ? short(r.qty, 10) : '', short(r.symbol, 12)].filter(Boolean).join(' ')}` : ''}`, body: short(r.detail, 300), status: 'verified', evidence: [`receipt paper_order_placed ${at}`], refs: { receipt: r.key || '', client_order_id: r.client_order_id || '' }, at };
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

// ─── Room events at the moment things happen (owner, Build 2, 2026-10-20) ─────
// Each builder turns one real activity into one event with an honest status, its evidence and a key
// that is the same for a retry, so the Brain never records the same activity twice. They are pure:
// the caller queues the result with queueRoomEvent.

const clipText = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * An Alpaca PAPER order the owner asked for that was NOT placed (CHE's own check, the owner's limits or
 * Alpaca said no). A placed order is recorded from its receipt (recordReceipt -> receiptEvent), so this
 * returns null for it and for a repeat of an order already journalled.
 */
export function paperOrderRefusedEvent(order = {}, placed = {}, { via = 'app', at } = {}) {
  if (!placed || placed.ok || placed.repeated) return null;
  const when = at || new Date().toISOString();
  const symbol = clipText(order?.symbol, 12).toUpperCase();
  const side = clipText(order?.side, 8).toLowerCase();
  const qty = Number(order?.qty) || 0;
  const what = [side, qty || '', symbol || 'stock'].filter(Boolean).join(' ');
  const clientId = clipText(order?.client_order_id, 64);
  return {
    room: 'trading', kind: 'paper_order_refused', key: `paper_refused:${clientId || `${what}:${when.slice(0, 16)}`}`,
    title: `Alpaca PAPER order not placed: ${what}`,
    body: `${clipText(placed.detail || placed.error || 'The order was refused.', 300)} Asked from ${via === 'chat' ? 'Chat' : 'the Trading Room'}. Paper only; no money moved.`,
    status: placed.unclear ? 'unknown' : 'verified',
    evidence: [`alpaca paper order request ${clientId || 'without request id'} ${when}`],
    refs: { client_order_id: clientId, blocked_by_controls: Boolean(placed.blocked) }, at: when,
  };
}

const CONTROL_LABEL = Object.freeze({
  emergency_stop: 'Emergency Stop turned on', flatten: 'Flatten: paper positions closed', pause: 'Strategies paused', resume: 'Strategies resumed',
  restore: 'Previous strategy limits restored', set: 'Strategy limit changed', disable: 'Strategy disabled', enable: 'Strategy enabled',
});

/** A Strategy Control Center change that was applied (its audit record), with what Emergency Stop cancelled. */
export function controlChangeEvent(record = {}, { halted = null } = {}) {
  if (!record?.at || !record?.action) return null;
  const action = String(record.action);
  const label = CONTROL_LABEL[action] || `Strategy control: ${clipText(action.replace(/_/g, ' '), 40)}`;
  const scope = record.scope && record.scope !== 'all' ? ` (${clipText(Array.isArray(record.scope) ? record.scope.join(', ') : record.scope, 60)})` : '';
  const cancelled = halted?.alpaca?.state === 'verified' ? (halted.alpaca.cancelled || []).length : null;
  return {
    room: 'trading', kind: 'control', key: `control:${record.at}:${action}`,
    title: `${label}${scope}`,
    body: `${clipText(record.summary || (record.effect || []).join(' '), 900)}${record.raised_risk ? ' The owner confirmed this raise in risk.' : ''}${cancelled != null ? ` Alpaca PAPER orders cancelled: ${cancelled}.` : ''} Changed by ${clipText(record.who || 'owner', 20)}. Paper only.`,
    status: 'verified', evidence: [`strategy control audit ${record.at}`], refs: { audit_at: record.at, action }, at: record.at,
  };
}

/** A War Room meeting convened, concluded or ended without a result. */
export function meetingEvent(meeting = {}, phase = 'concluded') {
  if (!meeting?.id) return null;
  const topic = clipText(meeting.objective || meeting.title || 'a team topic', 120);
  const people = (Array.isArray(meeting.participants) ? meeting.participants : []).map((p) => clipText(p?.name, 30)).filter(Boolean);
  const at = (phase === 'convened' ? meeting.created_at : meeting.updated_at) || new Date().toISOString();
  const base = { room: 'meetings', key: `meeting:${meeting.id}:${phase}`, refs: { meeting_id: meeting.id }, at, evidence: [`war room meeting ${meeting.id} ${phase} ${at}`], status: 'verified' };
  if (phase === 'convened') {
    return { ...base, kind: 'convened', title: `Meeting convened: ${topic}`, body: `CHE convened a War Room meeting about "${topic}"${people.length ? ` with ${people.join(', ')}` : ''}.` };
  }
  if (phase === 'failed') {
    return { ...base, kind: 'failed', title: `Meeting ended without a result: ${topic}`, body: clipText(meeting.error || 'The meeting could not finish.', 300) };
  }
  const decisions = (Array.isArray(meeting.decisions) ? meeting.decisions : []).map((d) => clipText(d, 160)).filter(Boolean).slice(0, 4);
  // That the meeting concluded is verified; what it decided is the agents' and CHE's model output, and the body says so.
  return {
    ...base, kind: 'concluded', title: `Meeting concluded: ${topic}`,
    body: `${people.length ? `Participants: ${people.join(', ')}. ` : ''}${decisions.length ? `Decisions: ${decisions.join('; ')}. ` : ''}The plan is CHE's synthesis of the agents' drafts: model output, not verified facts.`,
  };
}

/** An Office worker task that completed, or failed for good (a retry is not an outcome). */
export function officeTaskEvent(task = {}, { agent = '', outcome = 'complete', verified = false, at } = {}) {
  if (!task?.id) return null;
  const when = at || task.updated_at || new Date().toISOString();
  const who = clipText(agent || task.partner_name || 'An Office agent', 40);
  if (outcome === 'advisory') {
    // Input to one chat answer: the input happened; whether it was right was never reviewed.
    return {
      room: 'office', kind: 'task_advisory', key: `task:${task.id}:advisory`,
      title: `${who} gave input on: ${clipText(task.task || 'a request', 120)}`,
      body: 'An Office desk\'s input to one of CHE\'s answers. CHE did not review it as a deliverable; it is not a completed task.',
      status: 'observed',
      evidence: [`team task ${task.id} advisory ${when}`], refs: { task_id: task.id, agent: who }, at: when,
    };
  }
  if (outcome === 'rejected') {
    // CHE rejected the result after its repair passes: that verdict is the verified outcome, not the result.
    return {
      room: 'office', kind: 'task_rejected', key: `task:${task.id}:rejected`,
      title: `CHE rejected ${who}'s result: ${clipText(task.task || 'a task', 120)}`,
      body: 'CHE did not approve the result after its repair passes, so the task is not complete. The rejected result and CHE\'s review are in the task history.',
      status: 'verified',
      evidence: [`team task ${task.id} rejected ${when}`], refs: { task_id: task.id, agent: who }, at: when,
    };
  }
  const failed = outcome === 'failed';
  return {
    room: 'office', kind: failed ? 'task_failed' : 'task_complete', key: `task:${task.id}:${failed ? 'failed' : 'complete'}`,
    title: `${who} ${failed ? 'could not finish' : 'finished'}: ${clipText(task.task || 'a task', 120)}`,
    body: failed ? 'The task failed; details are in the owner-authorized task history.' : `${verified ? 'CHE reviewed and approved the result.' : 'CHE did not review the result.'} The result is in the task history.`,
    // The outcome itself is verified; an unreviewed result is only observed.
    status: failed || verified ? 'verified' : 'observed',
    evidence: [`team task ${task.id} ${failed ? 'failed' : 'complete'} ${when}`], refs: { task_id: task.id, agent: who }, at: when,
  };
}

/** A research note written (an agent's lead) or a fresh research answer with its sources. */
export function researchEvent({ id = '', title = '', summary = '', sources = [], by = 'CHE', sourcesRead = true, at } = {}) {
  const when = at || new Date().toISOString();
  const text = clipText(title || summary, 140);
  if (!text) return null;
  const urls = (Array.isArray(sources) ? sources : []).map((s) => clipText(typeof s === 'string' ? s : s?.url || s?.title, 200)).filter(Boolean).slice(0, 6);
  return {
    room: 'research', kind: 'finding', key: `research:${clipText(id, 80) || `${text.slice(0, 60)}:${when.slice(0, 13)}`}`,
    title: `Research: ${text}`,
    body: `${clipText(summary, 600)}\n${urls.length ? `Sources: ${urls.join(', ')}` : 'No sources were cited.'}\nFound by ${clipText(by, 40)}. A finding is a lead until a source check or the owner confirms it.`,
    // The research step read its sources, but nobody checked the claim against them: observed at best. An agent's
    // cited page was not necessarily opened at all (research_memory.js), so its note is inferred.
    status: urls.length && sourcesRead ? 'observed' : 'inferred',
    evidence: urls.length ? urls : [`research by ${clipText(by, 40)} ${when}`], refs: { note_id: clipText(id, 80) }, at: when,
  };
}

// ─── The phone's rooms: music, help and screen (POST /api/brain/room-event) ───
export const PHONE_ROOM_KINDS = Object.freeze({
  music: Object.freeze(['requested', 'played', 'paused', 'liked']),
  help: Object.freeze(['explained', 'walkthrough']),
  screen: Object.freeze(['observed']),
});
const PHONE_KIND_WORD = Object.freeze({ requested: 'Music requested', played: 'Played', paused: 'Paused', liked: 'Liked', explained: 'Help explained', walkthrough: 'Help walkthrough' });

/**
 * One event the owner's phone reports, or { error }. The phone names the room, a kind from that room's
 * allowlist, a stable key and a short title; the Worker writes the record. A screen event keeps only the
 * name of the screen or room and the time, never the image or the screen's text (the screen is temporary
 * unless the owner saves it).
 */
export function phoneRoomEvent(body = {}, { now = Date.now(), isSafe = () => true } = {}) {
  const room = String(body?.room || '');
  const kinds = PHONE_ROOM_KINDS[room];
  if (!kinds) return { error: 'room must be music, help or screen' };
  const kind = String(body.kind || '');
  if (!kinds.includes(kind)) return { error: `kind must be one of ${kinds.join(', ')}` };
  const key = String(body.key || '');
  if (!/^[A-Za-z0-9:._-]{4,80}$/.test(key)) return { error: 'a stable key of 4 to 80 letters, digits or :._- is required' };
  const rawTitle = String(body.title ?? '');
  const title = clipText(rawTitle, room === 'screen' ? 80 : 200);
  if (!title || rawTitle.length > (room === 'screen' ? 80 : 200)) return { error: `a title of at most ${room === 'screen' ? 80 : 200} characters is required` };
  const rawDetail = room === 'screen' ? '' : String(body.detail ?? '');
  if (rawDetail.length > 600) return { error: 'detail is at most 600 characters' };
  const detail = clipText(rawDetail, 600);
  if (!isSafe(title) || (detail && !isSafe(detail))) return { error: 'sensitive text is never recorded' };
  const at = new Date(now).toISOString();
  if (room === 'screen') {
    return {
      room, kind, key: `${kind}:${key}`, title: `Looked at ${title}`,
      body: `The owner looked at ${title} on his phone. Only the screen's name and the time are kept; the image and the screen's text are not.`,
      status: 'observed', evidence: [`phone screen report ${at}`], refs: { screen: title }, at,
    };
  }
  return {
    room, kind, key: `${kind}:${key}`, title: `${PHONE_KIND_WORD[kind]}: ${title}`,
    body: `${detail || title}${/[.!?]$/.test(detail || title) ? '' : '.'} Reported by the owner's phone.`,
    status: 'observed', evidence: [`phone ${room} ${kind} ${at}`], refs: { phone_key: key }, at,
  };
}
