// Deterministic owner tools that answer in chat with an execution receipt, tried right after the timer and before the
// connector gate (the one call in worker.js). Each tool reads or changes CHE's own durable state, never a model's text,
// and its receipt says what ran, on what, and what came back. Lists come first: they are the oldest tool here.
//
// Certification run 24 (41491194768): "Recover the last 100 messages from the queue and show their IDs" (eer-36) and
// "Restart the failed worker now and report the new PID" (eer-35) were answered "Nothing was done" by the connector gate,
// though the background job queue (data.jobs, worker.js enqueueJob/processJobs) holds exactly those records.
import { listChatTurn } from './owner_lists.js';

const DATA_KEY = 'che';
const READ_LIMIT = 100;
const short = (id) => String(id || '').slice(0, 8);
const receipt = (operation, status, extra = {}, now = Date.now()) => ({
  tool: 'che_job_queue', operation, status, at: new Date(now).toISOString(), id: `job_queue:${operation}:${now}`, ...extra,
});

// "Recover/show/list the last 100 messages from the queue", "what's in my job queue", "show the queue IDs".
const QUEUE_READ = /\b(?:recover|show|list|inspect|read|get|give\s+me|pull)\b[^.?!]{0,70}\bqueue\b|\bwhat(?:['’]s|\s+is)\s+(?:in|on)\s+(?:the|my)\s+(?:job\s+|background\s+)?queue\b|\bqueue\b[^.?!]{0,40}\b(?:ids?|status|contents?)\b/i;
// "Restart the failed worker", "retry the last failed job", "rerun the failed task now".
const RESTART = /\b(?:restart|retry|re-?run|resume|relaunch)\s+(?:the\s+|my\s+)?(?:last\s+|latest\s+|most\s+recent\s+)?(?:failed|dead(?:-|\s)?lettered|stuck|crashed)\s+(?:background\s+)?(?:worker|job|task)\b/i;
const COUNT = /\b(?:last|latest|recent|first|top)\s+(\d{1,4})\b/i;

/** What the owner asked of the job queue: { action: 'read', limit } or { action: 'restart' }, or null. */
export function queueIntent(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return null;
  if (RESTART.test(text)) return { action: 'restart' };
  if (QUEUE_READ.test(text)) {
    const asked = Number(COUNT.exec(text)?.[1] || 0);
    return { action: 'read', limit: Math.max(1, Math.min(READ_LIMIT, asked || 20)), asked: asked || null };
  }
  return null;
}

const failed = (job) => job?.status === 'failed' || job?.dead_letter === true;
const newest = (jobs) => [...jobs].sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));

/** The newest [limit] jobs, as the owner hears them, and a receipt naming every id returned. */
export function readQueue(data, { limit = 20, asked = null, now = Date.now() } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const shown = newest(jobs).slice(0, limit);
  const counts = jobs.reduce((c, j) => ({ ...c, [j.status || 'unknown']: (c[j.status || 'unknown'] || 0) + 1 }), {});
  const dead = jobs.filter((j) => j.dead_letter === true).length;
  const ids = shown.map((j) => j.id);
  const r = receipt('read', 'success', { total: jobs.length, returned: ids.length, ids, verified: 'read_back' }, now);
  if (!jobs.length) return { text: 'My background job queue is empty, sir: there are no messages in it to recover or list. I read it just now.', receipt: r };
  const lines = shown.map((j, i) => `${i + 1}. ${j.id} · ${j.kind || 'job'} · ${j.dead_letter ? 'dead-lettered' : j.status}${j.title ? ` · ${String(j.title).slice(0, 60)}` : ''}`);
  const head = asked && asked > jobs.length
    ? `You asked for the last ${asked}; my background job queue holds ${jobs.length} messages, so here are all of them, newest first`
    : `Here are the last ${shown.length} of the ${jobs.length} messages in my background job queue, newest first`;
  const tally = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
  return {
    text: `${head} (${tally}${dead ? `; ${dead} dead-lettered` : ''}), with their IDs:\n${lines.join('\n')}\nNothing was changed: this was a read. Receipt ${r.id}.`,
    receipt: r,
  };
}

/**
 * Restarts the newest failed or dead-lettered job as a new job (the same fields the Cloud Computer's retry keeps). A
 * Worker has no process ID, so the new job's ID is what identifies the restart. A probe turn never changes the queue.
 */
export function restartFailedJob(data, { probe = false, now = Date.now() } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const job = newest(jobs).find(failed);
  if (!job) {
    const r = receipt('restart', 'success', { total: jobs.length, restarted: null, verified: 'read_back' }, now);
    return { text: `No job in my background queue has failed, sir, so nothing was restarted: I checked all ${jobs.length}. A Worker has no process ID (PID) to report; a restarted job would get a new job ID. Receipt ${r.id}.`, receipt: r, changed: false };
  }
  if (probe) {
    const r = receipt('restart', 'not_run', { failed_job: job.id, reason: 'certification probe: the owner\'s queue is not changed' }, now);
    return { text: `The newest failed job is ${job.id} (${job.kind || 'job'}). This is a test turn, so I did not restart it. Receipt ${r.id}.`, receipt: r, changed: false };
  }
  const iso = new Date(now).toISOString();
  const keep = { ...job };
  for (const k of ['id', 'status', 'attempts', 'retry_count', 'retry_at', 'result', 'error', 'dead_letter', 'dead_letter_at', 'created_at', 'updated_at', 'activity', 'cancelled_at', 'cancelled_by', 'cancelled_via', 'started_at', 'owner_message', 'failure_class', 'verification', 'checkpoint']) delete keep[k];
  const next = {
    ...keep,
    id: crypto.randomUUID(), status: 'queued', attempts: 0, retry_count: 0, retry_at: now, result: '', error: '', dead_letter: false,
    dead_letter_at: null, idempotency_key: `retry:${job.id}:${now}`, retried_from: job.id, created_at: iso, updated_at: iso,
    activity: [{ at: iso, text: `Restart of failed job ${short(job.id)} requested by the owner in chat.` }],
  };
  data.jobs = [...jobs, next];
  const r = receipt('restart', 'success', { failed_job: job.id, new_job: next.id, kind: next.kind, verified: 'queued' }, now);
  return {
    text: `Restarted, sir: failed job ${job.id} (${job.kind || 'job'}) is queued again as new job ${next.id}. A Worker has no process ID (PID); that new job ID is what to watch. Ask "what's in my job queue" to see it run. Receipt ${r.id}.`,
    receipt: r, changed: true,
  };
}

/** One chat turn for the job queue, or null when the message is not about it. */
export async function queueChatTurn(storage, message, { probe = false, owner = true, now = Date.now() } = {}) {
  const intent = queueIntent(message);
  if (!intent) return null;
  const meta = (extra = {}) => ({ source: 'che_job_queue', model_calls: 0, ...extra });
  if (!owner && !probe) return { text: 'My job queue is the owner\'s, sir. Nothing was read or changed.', meta: meta({ ok: false }) };
  let data;
  try { data = (await storage.get(DATA_KEY)) || {}; } catch (_) {
    const r = receipt(intent.action, 'failed', { error: 'read_failed' }, now);
    return { text: 'I could not read my job queue from CHE\'s storage just now, sir, so nothing was read or changed.', meta: meta({ ok: false, execution_receipt: r }) };
  }
  if (intent.action === 'read') {
    const out = readQueue(data, { ...intent, now });
    return { text: out.text, meta: meta({ ok: true, execution_receipt: out.receipt }) };
  }
  const out = restartFailedJob(data, { probe, now });
  if (out.changed) {
    await storage.put(DATA_KEY, data);
    // processJobs runs on the Durable Object alarm: wake it so the restarted job starts.
    try { if (typeof storage.setAlarm === 'function') await storage.setAlarm(now + 1000); } catch (_) {}
  }
  return { text: out.text, meta: meta({ ok: true, execution_receipt: out.receipt }) };
}

// The deterministic owner tools, in the order they are tried. Each turn(storage, message, opts) returns a chat answer
// with its receipt, or null when the message is not for it.
export const OWNER_TOOLS = [
  { id: 'che_lists', turn: (storage, message, opts) => listChatTurn(storage, message, opts) },
  { id: 'che_job_queue', turn: (storage, message, opts) => queueChatTurn(storage, message, opts) },
];

/** The first owner tool that answers [message], or null. */
export async function ownerToolTurn(storage, message, opts = {}) {
  for (const tool of OWNER_TOOLS) {
    const out = await tool.turn(storage, message, opts);
    if (out) return out;
  }
  return null;
}
