// Owner-facing answer to "what are you doing?" and "what's finished?", built only from CHE's
// durable records: background jobs, mission (objective) graphs and the latest coding run. It
// reads and never writes, and says "nothing" plainly instead of letting a model describe work
// that does not exist.
import { speakObjective } from './objective_graph.js';

const ACTIVE = new Set(['queued', 'running', 'retry', 'working']);
const WAITING = new Set(['blocked', 'waiting']);
const FINISHED = new Set(['complete', 'failed', 'cancelled']);
const RUNTIME_ACTIVE = new Set(['queued', 'dispatching', 'running', 'resuming', 'waiting_capacity']);
const DAY_MS = 24 * 3_600_000;

// Whole questions only, so "what are you doing tonight?" or "what is running on port 8080?"
// keep their own meaning.
const WAKE = "(?:(?:hey\\s+)?(?:che|chay|chey|shay)[,:]?\\s+)?";
const WHEN = '(?:\\s+(?:right\\s+now|now|currently|at\\s+the\\s+moment|today|so\\s+far))?';
const ACTIVE_ASK = new RegExp(`^${WAKE}(?:what\\s+(?:are|r)\\s+(?:you|u)\\s+(?:doing|working\\s+on|up\\s+to|busy\\s+with)|what(?:['’]s|\\s+is)\\s+(?:running|in\\s+progress|happening)|(?:is\\s+)?anything\\s+running|what\\s+jobs\\s+are\\s+running)${WHEN}[?.!\\s]*$`, 'i');
const FINISHED_ASK = new RegExp(`^${WAKE}(?:what(?:['’]s|\\s+is)\\s+(?:finished|done|completed)|what\\s+(?:did|have)\\s+(?:you|u)\\s+(?:finish(?:ed)?|complete(?:d)?|get\\s+done|done)|what\\s+got\\s+done)${WHEN}[?.!\\s]*$`, 'i');

export function activityStatusIntent(message) {
  const text = String(message || '').trim();
  if (FINISHED_ASK.test(text)) return 'finished';
  if (ACTIVE_ASK.test(text)) return 'active';
  return '';
}

function label(job) {
  return String(job.title || job.kind || 'job').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function listOf(items, max, describe) {
  const shown = items.slice(0, max).map(describe).join('; ');
  return items.length > max ? `${shown}; and ${items.length - max} more` : shown;
}

function mission(objective) {
  try { return speakObjective(objective); } catch (_) { return String(objective?.objective || 'a mission').slice(0, 120); }
}

// `runtime`: { sessionId, state } of the latest coding run, or { sessionId, unread: true } when
// GitHub could not be read, so its state is never guessed; `staleMs(job)`
// is the Worker's rule for a running job that stopped reporting progress.
export function activityReceipt({ mode = 'active', jobs = [], objectives = [], runtime = null, now = Date.now(), staleMs = () => Infinity } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const updated = (job) => Date.parse(job.updated_at || job.created_at || 0);
  const stale = (job) => job.status === 'running' && updated(job) <= now - staleMs(job);
  const active = list.filter((job) => ACTIVE.has(job.status) && !stale(job));
  const interrupted = list.filter(stale);
  const waiting = list.filter((job) => WAITING.has(job.status));
  const recent = list.filter((job) => (FINISHED.has(job.status) || job.dead_letter) && now - updated(job) <= DAY_MS)
    .sort((a, b) => updated(b) - updated(a));
  const missions = (Array.isArray(objectives) ? objectives : []).filter((o) => o && !['complete', 'cancelled'].includes(o.status));
  const runtimeState = String(runtime?.state || '');
  const runtimeUnread = Boolean(runtime?.sessionId) && runtime.unread === true;
  const runtimeLive = Boolean(runtime?.sessionId) && !runtimeUnread && RUNTIME_ACTIVE.has(runtimeState);
  const runtimeDone = Boolean(runtime?.sessionId) && !runtimeUnread && Boolean(runtimeState) && !runtimeLive;
  const unreadNote = runtimeUnread ? ` Coding run ${runtime.sessionId}: state UNVERIFIED, GitHub could not be read.` : '';

  if (mode === 'finished') {
    const done = recent.map((job) => `${label(job)} (${job.dead_letter ? 'dead letter' : job.status})`);
    if (runtimeDone) done.unshift(`coding run ${runtime.sessionId} (${runtimeState.replace(/_/g, ' ')})`);
    if (!done.length) return `Nothing finished in the last day, sir.${unreadNote}`;
    const still = active.length + (runtimeLive ? 1 : 0);
    return `Finished in the last day: ${listOf(done, 6, (item) => item)}.${still ? ` ${still} still running or queued.` : ''}${unreadNote}`;
  }

  const lines = [];
  if (runtimeLive) lines.push(`Coding run ${runtime.sessionId}: ${runtimeState.replace(/_/g, ' ')}.`);
  if (runtimeUnread) lines.push(unreadNote.trim());
  if (active.length) lines.push(`Running or queued: ${listOf(active, 5, (job) => `${label(job)} (${job.status})`)}.`);
  if (interrupted.length) lines.push(`Stopped reporting progress, not confirmed running: ${listOf(interrupted, 3, label)}.`);
  if (waiting.length) lines.push(`Waiting or blocked: ${listOf(waiting, 3, (job) => `${label(job)} (${job.status})`)}.`);
  if (missions.length) lines.push(`Missions: ${missions.slice(0, 3).map(mission).join(' ')}`);
  if (!lines.length) {
    const finished = recent.length + (runtimeDone ? 1 : 0);
    return `Nothing is running or queued right now, sir.${finished ? ` ${finished} finished in the last day; ask "what's finished" for the list.` : ''}`;
  }
  return lines.join(' ');
}
