// Owner-facing answer to "what are you doing?" and "what's finished?", built only from CHE's
// durable records: background jobs, mission (objective) graphs and the latest coding run. It
// reads and never writes, and says "nothing" plainly instead of letting a model describe work
// that does not exist.
import { speakObjective } from './objective_graph.js';

const ACTIVE = new Set(['queued', 'running', 'retry', 'working']);
const WAITING = new Set(['blocked', 'waiting']);
const FINISHED = new Set(['complete', 'failed', 'cancelled']);
const DAY_MS = 24 * 3_600_000;

// Whole questions only, so "what are you doing tonight?" or "what is running on port 8080?"
// keep their own meaning.
const WAKE = "(?:(?:hey\\s+)?(?:che|chay|chey|shay)[,:]?\\s+)?";
// "today" belongs to finished work only: "what are you doing today?" is a personal question.
// "What's happening?" (news, a chart, a photo) and "what have you done?" (often about an
// action CHE just took in chat, which is not a job) stay with their own routes.
const NOW_WORDS = '(?:\\s+(?:right\\s+now|now|currently|at\\s+the\\s+moment))?';
const DAY_WORDS = '(?:\\s+(?:right\\s+now|now|currently|at\\s+the\\s+moment|today|so\\s+far))?';
const ACTIVE_ASK = new RegExp(`^${WAKE}(?:what\\s+(?:are|r)\\s+(?:you|u)\\s+(?:doing|working\\s+on|up\\s+to|busy\\s+with)|what(?:['’]s|\\s+is)\\s+(?:running|in\\s+progress)|(?:is\\s+)?anything\\s+running|what\\s+jobs\\s+are\\s+running|(?:is|are)\\s+(?:there\\s+)?(?:any|a)\\s+(?:coding\\s+|background\\s+)?jobs?\\s+(?:running|in\\s+progress|queued))${NOW_WORDS}[?.!\\s]*$`, 'i');
const FINISHED_ASK = new RegExp(`^${WAKE}(?:what(?:['’]s|\\s+is)\\s+(?:finished|done|completed)|what\\s+(?:did|have)\\s+(?:you|u)\\s+(?:finish(?:ed)?|complete(?:d)?))${DAY_WORDS}[?.!\\s]*$`, 'i');

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

// `runtime`: { sessionId, state, stateClass, unverified } of the latest coding run, with the
// state and class from coding_runtime.js (runtimeState / runtimeStateClass, after the pending
// resume overlay the coding-status route uses), or { sessionId, unread: true } when GitHub
// could not be read, so its state is never guessed. `staleMs(job)` is the Worker's rule for a
// running job that stopped reporting progress; `paused` is true when autonomy is off.
export function activityReceipt({ mode = 'active', jobs = [], objectives = [], runtime = null, now = Date.now(), staleMs = () => Infinity, paused = false } = {}) {
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
  const runtimeClass = String(runtime?.stateClass || 'unknown');
  const known = Boolean(runtime?.sessionId) && !runtimeUnread && Boolean(runtimeState);
  // Finished means complete or failed for good; a run with a PR open, in review or waiting on
  // the owner is still work in progress, and a state the classifier does not know is not done.
  const runtimeDone = known && (runtimeClass === 'complete' || runtimeClass === 'failed');
  const runtimeLive = known && !runtimeDone;
  const unverified = runtimeLive && runtime.unverified === true && runtimeClass === 'active';
  const unreadNote = runtimeUnread ? ` Coding run ${runtime.sessionId}: state UNVERIFIED, GitHub could not be read.` : '';
  const queued = list.some((job) => job.status === 'queued' || job.status === 'retry');
  const pausedNote = paused && (queued || runtimeLive)
    ? ' Autonomy is paused, so queued work will not start until you resume it.' : '';

  if (mode === 'finished') {
    const done = recent.map((job) => `${label(job)} (${job.dead_letter ? 'dead letter' : job.status})`);
    if (runtimeDone) done.unshift(`coding run ${runtime.sessionId} (${runtimeState.replace(/_/g, ' ')})`);
    const still = active.length + (runtimeLive ? 1 : 0);
    if (!done.length) return `Nothing finished in the last day, sir.${still ? ` ${still} still running or queued.` : ''}${unreadNote}${pausedNote}`;
    return `Finished in the last day: ${listOf(done, 6, (item) => item)}.${still ? ` ${still} still running or queued.` : ''}${unreadNote}${pausedNote}`;
  }

  const lines = [];
  if (runtimeLive) {
    lines.push(unverified
      ? `Coding run ${runtime.sessionId}: state UNVERIFIED, last recorded as ${runtimeState.replace(/_/g, ' ')}; GitHub could not confirm it is running.`
      : `Coding run ${runtime.sessionId}: ${runtimeState.replace(/_/g, ' ')}.`);
  }
  if (runtimeUnread) lines.push(unreadNote.trim());
  if (active.length) lines.push(`Running or queued: ${listOf(active, 5, (job) => `${label(job)} (${job.status})`)}.`);
  if (interrupted.length) lines.push(`Stopped reporting progress, not confirmed running: ${listOf(interrupted, 3, label)}.`);
  if (waiting.length) lines.push(`Waiting or blocked: ${listOf(waiting, 3, (job) => `${label(job)} (${job.status})`)}.`);
  if (missions.length) lines.push(`Missions: ${missions.slice(0, 3).map(mission).join(' ')}`);
  if (!lines.length) {
    const finished = recent.length + (runtimeDone ? 1 : 0);
    return `Nothing is running or queued right now, sir.${finished ? ` ${finished} finished in the last day; ask "what's finished" for the list.` : ''}`;
  }
  return `${lines.join(' ')}${pausedNote}`;
}

// ─── History: missions, projects, jobs and earlier work together ────────────────────────────────────────────────────
// Owner live test (2026-10-25): "Show my last five missions", "What were our last three projects?" and "Have we worked
// together before?" reached the model, which answered "I don't have access to mission history or job records" and "I
// can't find any record of previous collaboration" while the objective graph, the job queue and the project list were
// all in CHE's own storage. These questions now read those records and name each store read with its count, so an empty
// store is reported as empty, never as "no access".

const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const HISTORY_KINDS = [
  ['missions', '(?:missions?|objectives?)'],
  ['projects', '(?:projects?)'],
  ['jobs', '(?:(?:coding\\s+|background\\s+|build\\s+)?jobs?|coding\\s+(?:runs?|work))'],
];
const N = '(?:(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\\s+)?';
const RECENT = '(?:last|recent|latest|previous|past|newest|most\\s+recent)';
const OWNERS = "(?:my|our|your|the|che'?s|all(?:\\s+(?:my|our|your|the))?)";

/** { kind: 'missions'|'projects'|'jobs'|'collaboration', limit } for a history question, or null. */
export function workHistoryIntent(message) {
  const text = String(message || '').replace(/[‘’]/g, "'").replace(/^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)/i, '').replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return null;
  if (/^(?:have|did)\s+(?:we|you\s+and\s+i|i\s+and\s+you)\s+(?:ever\s+)?(?:work(?:ed)?|collaborat(?:e|ed)|buil[dt]|done\s+(?:any\s+)?(?:work|projects?))(?:\s+(?:on\s+)?(?:anything|something|projects?))?\s+together(?:\s+(?:before|previously|already))?$/i.test(text)
    || /\b(?:records?|history|log)\s+of\s+(?:our|my|your)\s+(?:previous|past|earlier|prior)?\s*(?:collaboration|work(?:\s+together)?|projects?|sessions?)\b/i.test(text)
    || /^what\s+(?:have|did)\s+(?:we|you\s+and\s+i)\s+(?:worked\s+on|work\s+on|done|built|build|made|make)\s+together(?:\s+(?:before|so\s+far|recently))?$/i.test(text)
    || /^(?:show|tell|give)(?:\s+me)?\s+(?:our|my)\s+(?:collaboration|work)\s+history$/i.test(text)) {
    return { kind: 'collaboration', limit: 3 };
  }
  for (const [kind, noun] of HISTORY_KINDS) {
    const forms = [
      new RegExp(`^(?:what\\s+(?:were|are)|which\\s+(?:were|are)|show(?:\\s+me)?|list|give\\s+me|tell\\s+me|read(?:\\s+me)?|pull\\s+up|get(?:\\s+me)?)\\s+${OWNERS}\\s+(?:${RECENT}\\s+)?${N}${noun}(?:\\s+history)?(?:\\s+(?:so\\s+far|together))?$`, 'i'),
      new RegExp(`^(?:show(?:\\s+me)?|list|give\\s+me|tell\\s+me|read(?:\\s+me)?|pull\\s+up|get(?:\\s+me)?)\\s+(?:${OWNERS}\\s+)?${RECENT}\\s+${N}${noun}$`, 'i'),
      new RegExp(`^(?:what|which)\\s+${N}${noun}\\s+(?:have|did)\\s+(?:you|we)\\s+(?:run|ran|done|did|do|finished|completed|worked\\s+on|started|built)(?:\\s+(?:so\\s+far|recently|lately|before))?$`, 'i'),
    ];
    for (const re of forms) {
      const m = re.exec(text);
      if (!m) continue;
      // "Show me the project" (one current thing) is not history; a plural, a count, "last" or "history" is.
      if (!m[1] && !new RegExp(`\\b${RECENT}\\b|\\bhistory\\b`, 'i').test(text) && !/\b(?:missions|objectives|projects|jobs|runs)\b/i.test(text)) continue;
      const n = m[1] ? Number(COUNT_WORDS[m[1].toLowerCase()] || m[1]) : 5;
      return { kind, limit: Math.max(1, Math.min(10, n)) };
    }
  }
  return null;
}

// The full stored id, so the owner can ask for that exact record later.
const shortId = (id) => String(id || '').slice(0, 40) || 'no id';
const dayOf = (iso) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'no date'; };
const newest = (items, limit) => (Array.isArray(items) ? items.filter(Boolean) : [])
  .map((item, i) => ({ item, i, t: Date.parse(item.updated_at || item.created_at || '') }))
  .sort((a, b) => ((Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity)) || (a.i - b.i))
  .slice(0, limit).map((x) => x.item);

function describeMission(o) {
  const steps = Array.isArray(o.nodes) ? o.nodes : [];
  const done = steps.filter((n) => n.status === 'complete').length;
  return `"${String(o.objective || 'mission').replace(/\s+/g, ' ').slice(0, 90)}" (mission ${shortId(o.id)}, ${o.status || 'unknown'}, ${done} of ${steps.length} steps done, ${dayOf(o.created_at)}${o.artifact?.sha256 ? `, verified result ${o.artifact.sha256.slice(0, 12)}` : ''})`;
}
function describeProject(p) {
  return `"${String(p.title || p.name || 'untitled').replace(/\s+/g, ' ').slice(0, 80)}" (project ${shortId(p.id)}${p.type ? `, ${p.type}` : ''}${p.status ? `, ${p.status}` : ''}, ${dayOf(p.updated_at || p.created_at)})`;
}
function describeJob(j) {
  const proof = [j.pr_number ? `PR #${j.pr_number}` : '', j.merge_commit_sha ? `commit ${String(j.merge_commit_sha).slice(0, 7)}` : ''].filter(Boolean).join(', ');
  return `"${label(j)}" (job ${shortId(j.id)}, ${j.dead_letter ? 'dead letter' : j.status || 'unknown'}${proof ? `, ${proof}` : ''}, ${dayOf(j.updated_at || j.created_at)})`;
}
function describeTask(t) {
  return `${t.partner_name || 'an Office agent'}: "${String(t.task || '').replace(/\s+/g, ' ').slice(0, 70)}" (task ${shortId(t.id)}, ${t.status || 'unknown'}, ${dayOf(t.updated_at || t.created_at)})`;
}

/**
 * The spoken history and the record ids it names: { text, record_ids, stores }. Every store is read from `data` (CHE's
 * durable state), counted and named, so "0 missions" is a reading, not a guess. Statuses are the records' own.
 */
export function workHistoryReceipt({ kind = 'collaboration', limit = 5, data = {} } = {}) {
  const missions = Array.isArray(data.objectives) ? data.objectives : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
  const stores = { missions: missions.length, projects: projects.length, jobs: jobs.length, office_tasks: tasks.length };
  const read = `I read my mission records (${missions.length}), projects (${projects.length}), background and coding jobs (${jobs.length}) and Office agent tasks (${tasks.length})`;
  const one = (items, describe, noun) => {
    const shown = newest(items, limit);
    if (!shown.length) return { text: `${read}. There are no ${noun} stored yet, sir, so there is nothing to list. That is an empty record, not missing access.`, record_ids: [], stores };
    const older = items.length - shown.length;
    return {
      text: `Your ${shown.length === 1 ? `last ${noun.replace(/s$/, '')}` : `last ${shown.length} ${noun}`}, newest first, sir: ${shown.map((x, i) => `${i + 1}. ${describe(x)}`).join(' ')}${older ? ` ${older} older not listed.` : ''} From my own records.`,
      record_ids: shown.map((x) => x.id).filter(Boolean),
      stores,
    };
  };
  if (kind === 'missions') return one(missions, describeMission, 'missions');
  if (kind === 'projects') return one(projects, describeProject, 'projects');
  if (kind === 'jobs') return one(jobs, describeJob, 'jobs');
  const parts = [];
  const ids = [];
  for (const [items, describe, noun] of [[projects, describeProject, 'projects'], [missions, describeMission, 'missions'], [jobs, describeJob, 'jobs'], [tasks, describeTask, 'Office tasks']]) {
    const shown = newest(items, limit);
    if (!shown.length) continue;
    parts.push(`${noun[0].toUpperCase()}${noun.slice(1)}: ${shown.map(describe).join('; ')}.`);
    ids.push(...shown.map((x) => x.id).filter(Boolean));
  }
  if (!parts.length) return { text: `${read}. All four are empty, sir, so I have no record of earlier work together in this CHE. That is what my stores hold, not missing access.`, record_ids: [], stores };
  return { text: `Yes, sir. ${read}. Newest first: ${parts.join(' ')}`, record_ids: ids, stores };
}
