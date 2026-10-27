// Owner-facing receipt for CHE's latest coding work, for both "coding status" and history questions.
// It is built only from stored records: the built-in job, or the runtime result file the runner
// publishes. The state sentence is speakRuntimeStatus's (resume, retry and unconfirmed-run wording
// included); every evidence field a record does not hold is named as not recorded. Nothing here
// starts a job or reads repository files.
import { runtimeState, runtimeStateClass, speakRuntimeStatus } from './coding_runtime.js';

const DEFAULT_REPO = 'Vondada/chey-app';

function listed(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

// Only text and numbers are read back: an object in a record field is not spoken as "[object Object]".
function clip(value, max = 300) {
  if (!['string', 'number'].includes(typeof value)) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Counts the runner writes as numbers, accepted as numeric text too.
function count(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Record text read back as one spoken sentence.
function sentence(value) {
  const text = clip(value);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// Test outcomes the runtime itself reports (coding_runtime.js runtimeState). Anything else is not claimed.
function testLine(state) {
  if (state === 'tests_failed') return 'Tests: failed.';
  if (state === 'review_rejected') return 'Tests: passed, but my reviewer rejected the change.';
  if (['reviewing', 'approved_waiting_owner', 'merged'].includes(state)) return 'Tests: passed.';
  if (state === 'pr_open') return 'Tests: running.';
  return 'Tests: not recorded in the runtime record, so none are claimed.';
}

// The built-in job's state, in the words "coding status" has always used. `stale`: a running job
// that stopped reporting progress (the Worker's jobStaleMs rule) is not confirmed running.
function jobState(job, stale) {
  const status = clip(job.status) || 'unknown';
  const checkpoint = job.checkpoint ? ' Its recovery checkpoint is saved.' : '';
  if (stale) {
    return `The latest coding job stopped reporting progress and is not confirmed running, sir. ${job.checkpoint
      ? 'Its checkpoint is saved for recovery, but recovery has not started yet.'
      : 'It saved no checkpoint, so a retry starts from the beginning.'}`;
  }
  if (status === 'running') return `The latest coding job is running, sir.${checkpoint}`;
  if (status === 'queued') {
    return Number(job.retry_count || 0) > 0
      ? `The latest coding job is retrying automatically, sir.${checkpoint}`
      : `The latest coding job is queued, sir.${checkpoint}`;
  }
  const terminal = job.dead_letter ? 'dead letter' : status.replace(/_/g, ' ');
  return `The latest coding job status is ${terminal}, sir.${checkpoint}`;
}

// The short job ID the owner names ("coding job f1a27d86"); '' when none is named.
export function namedJobId(message) {
  const m = /\b(?:(?:coding|opencode)\s+)?(?:jobs?|runs?)\s+(?:id\s+|number\s+|#\s*)?([0-9a-f]{8})\b/i.exec(String(message || ''));
  return m ? m[1].toLowerCase() : '';
}

// The stored job whose ID starts with the named short ID. Returns null when none matches (never the newest job).
export function jobForShortId(jobs, shortId) {
  if (!shortId) return null;
  return (Array.isArray(jobs) ? jobs : []).find((job) => String(job?.id || '').toLowerCase().startsWith(shortId)) || null;
}

// The named job answers the question, never the newest one. Returns { job } for a stored job,
// { reply } when the ID matches nothing (said plainly), or {} when no job ID was named.
export function namedJobAnswer(message, jobs = [], sessionId = '') {
  const shortId = namedJobId(message);
  if (!shortId) return {};
  const job = jobForShortId(jobs, shortId);
  if (job) return { job };
  if (String(sessionId || '').toLowerCase().startsWith(shortId)) return {};
  return { reply: missingJobReply(shortId) };
}

export function missingJobReply(shortId) {
  return `I have no coding job ${shortId} in my records, sir. Nothing was started or changed. Ask for "my last coding job" to see the newest one.`;
}

// A built-in job keeps its outcome as result and error text, which is read back as written.
function jobReceipt(job, stale, unread, olderActive) {
  const id = clip(job.id).slice(0, 12);
  const lines = [jobState(job, stale), id ? `Built-in job: ${id}.` : 'Built-in job: its record has no id.'];
  const asked = clip(job.request || job.title || job.prompt);
  if (asked) lines.push(`Request: ${asked}.`);
  if (clip(job.result)) lines.push(`Result: ${sentence(job.result)}`);
  if (clip(job.error)) lines.push(`Error: ${sentence(job.error)}`);
  lines.push('Its record has no GitHub run link, model list or changed-file count.');
  if (olderActive) lines.push(`An older coding job, ${String(olderActive.id || '').slice(0, 12)}, is still ${Number(olderActive.retry_count || 0) > 0 && olderActive.status === 'queued' ? 'retrying' : clip(olderActive.status) || 'active'}.`);
  if (unread) lines.push(unread);
  return lines.join(' ');
}

function unreadReason(status) {
  if (!status) return 'I could not read its record';
  const detail = clip(status.detail, 160).replace(/[.!?]+$/, '');
  return detail ? `I could not read its record: ${detail}` : `I could not read its record (HTTP ${status.status})`;
}

// `unreadRun`: a newer runtime session whose record could not be read, reported beside the
// active built-in job instead of being silently dropped.
// `olderActive`: an older built-in job still queued or running beside the newest one reported.
export function codingHistoryReceipt({ kind = 'none', job = null, stale = false, sessionId = '', status = null, request = '', repo = '', unreadRun = null, olderActive = null } = {}) {
  if (kind === 'job' && job) {
    const unread = unreadRun ? `A newer coding run, ${unreadRun.sessionId}, exists, but ${unreadReason(unreadRun.status)}; its state is UNVERIFIED.` : '';
    return jobReceipt(job, stale, unread, olderActive);
  }
  // Other kinds of job may be running, so nothing is said about them.
  if (kind !== 'runtime' || !sessionId) return 'No coding job has started yet, sir.';
  if (!status || Number(status.status) !== 200) {
    return `Coding run ${sessionId}: ${unreadReason(status)}. Its state, run and result are UNVERIFIED.`;
  }
  // A state that is not text is not read back as "[object Object]"; it is unknown.
  const record = { ...status, state: typeof status.state === 'string' ? status.state : 'unknown', failure: clip(status.failure) };
  const state = runtimeState(record);
  const lines = [`Latest coding run: ${sessionId}.`];
  const asked = clip(request);
  if (asked) lines.push(`Request: ${asked}.`);
  // getStatus marks liveness 'unverified' when GitHub could not be asked; the run is then
  // neither running nor failed, whatever its last record said.
  lines.push(status.liveness === 'unverified' && runtimeStateClass(record) === 'active'
    ? `State: UNVERIFIED, last recorded as ${state.replace(/_/g, ' ')}.`
    : `State: ${state.replace(/_/g, ' ')}.`);
  const files = count(status.changed_files);
  const pr = count(status.pr_number);
  const tried = listed(status.models_tried);
  // The spoken sentence reads only fields of the expected type, so an odd record cannot put
  // "[object Object]" or "NaN" into it.
  lines.push(speakRuntimeStatus({
    ...record,
    changed_files: files ?? undefined,
    pr_number: pr || undefined,
    additions: count(status.additions) ?? undefined,
    deletions: count(status.deletions) ?? undefined,
    models_tried: tried,
    failure: clip(status.failure),
    error: clip(status.error, 2000),
    review: clip(status.review),
    remaining: clip(status.remaining),
  }));
  const failure = [clip(status.failure), clip(status.error)].filter(Boolean).join(' - ');
  if (failure) lines.push(`${['waiting_capacity', 'resuming'].includes(state) ? 'Last failure' : 'Failure'}: ${sentence(failure)}`);
  const runId = Number(status.run_id) || 0;
  lines.push(runId ? `GitHub run: https://github.com/${repo || DEFAULT_REPO}/actions/runs/${runId}` : 'GitHub run: not recorded.');
  const unreadable = Array.isArray(status.models_tried) ? status.models_tried.length - tried.length : 0;
  if (tried.length) lines.push(`Models tried: ${tried.join(', ')}${unreadable > 0 ? `, plus ${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} I could not read` : ''}.`);
  else if (clip(status.model)) lines.push(`Model: ${clip(status.model)}.`);
  else lines.push('Models tried: not recorded.');
  lines.push(files === null ? 'Files changed: not recorded.' : `Files changed: ${files}.`);
  lines.push(pr ? `Pull request: #${pr}.` : 'Pull request: none recorded.');
  lines.push(testLine(state));
  // heartbeat 'stale': GitHub confirmed the run is alive but its progress file is old.
  if (status.heartbeat === 'stale' && status.liveness !== 'unverified') lines.push('GitHub shows the run is still live, but it has not reported progress recently.');
  return lines.join(' ');
}

// The owner asks for CHE's last completed coding work and its GitHub proof (owner, 2026-10-21). The answer is built
// from CHE's own job records only: a PR merge or a deploy counts when its record carries the commit SHA. Work by
// Claude or another agent is not in these records and is never reported as CHE's.
const SHA = /\b([0-9a-f]{7,40})\b/;
export const PROOF_ASK = /\b(?:last|latest|most recent)\b[^.?!]{0,40}\b(?:completed|finished|genuinely completed|genuinely finished)\b[^.?!]{0,30}\b(?:coding|code|task|job|work)\b|\b(?:github|commit|sha|pull request|PR)\b[^.?!]{0,30}\b(?:proof|evidence)\b|\b(?:proof|evidence)\b[^.?!]{0,30}\b(?:github|commit|sha|pull request|PR)\b/i;

export function proofAsked(message) {
  return PROOF_ASK.test(String(message || ''));
}

/** The newest completed work CHE recorded, with its PR, commit SHA, link and deploy status, or an honest "cannot verify". */
export function completedWorkProof(jobs = [], repo = '') {
  const done = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.status === 'complete');
  const repoLink = repo ? `https://github.com/${repo}` : '';
  // The job list is newest first (enqueueJob unshifts), so the first match is the newest.
  for (const job of done) {
    const fromResult = job.kind === 'merge_pr' ? SHA.exec(String(job.result || '').replace(/^.*Merged as\s*/i, '')) : null;
    const sha = String(job.merge_commit_sha || (job.kind === 'verify_deploy' ? job.prompt : '') || fromResult?.[1] || '').trim();
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    if (!['merge_pr', 'verify_deploy'].includes(job.kind)) continue;
    const pr = Number(job.pr_number) || 0;
    const lines = [`Last completed coding work I can verify, from my own job record: "${String(job.title || job.kind).slice(0, 120)}".`];
    lines.push(`Commit: ${sha.slice(0, 7)}${repoLink ? ` (${repoLink}/commit/${sha})` : ''}.`);
    if (pr) lines.push(`PR: #${pr}${repoLink ? ` (${repoLink}/pull/${pr})` : ''}.`);
    lines.push(job.kind === 'verify_deploy'
      ? `Deploy: verified by job ${job.id || 'unknown'}, which completed.`
      : 'Deploy: not recorded for this job.');
    lines.push(`Verification: my job ${job.id || 'unknown'} is recorded complete; this answer reads that record, not a live GitHub check.`);
    return { ok: true, text: lines.join('\n'), job_id: job.id || null, sha };
  }
  return { ok: false, text: 'I cannot verify that I completed a coding job. My job records hold no completed PR merge or deploy with a commit SHA. Work by Claude or another agent is not mine, so I do not count it.' };
}

// The other AIs whose coding work CHE's job records never hold. Named in a question about who did coding work, the answer
// says so, then gives CHE's own record. Handoffs, mailbox messages and consultations are routed before this (worker.js).
const OTHER_AGENT = /\b(claude|codex|chatgpt|gpt|gemini|cursor|copilot|grok)\b|\b(?:another|other|which|what)\s+(?:agent|ai)\b/i;
// "What is Claude currently working on?" (owner live test, 2026-10-25) is a question about that AI's work too.
const AGENT_WORK = /\b(?:finish\w*|complet\w*|wrote|written|write|made|merged?|did|done|built|build|changed|change|changes|commit\w*|pull requests?|PRs?|coding|code|job|task|work|working|far\s+(?:did|has|have)|progress|get|got)\b/i;
const AGENT_SPEECH = /\b(?:say|said|tell|told|ask|asked|message|mailbox|hand\s*off|handed|pass|send|sent|forward|consult|work\s+with|compare|coordinate|collaborate|check\s+with|repl(?:y|ies|ied)|respon(?:d|ds|ded|se|ses)|answer(?:s|ed)?)\b/i;
// A question, not an instruction to another AI: it opens like one, or ends with one.
const ASKS = /^(?:(?:che|chay|chey)[,:]?\s+)?(?:did|does|do|has|have|is|was|were|who|which|what|how|where|when|why|tell\s+me\s+(?:who|which|what|how|whether))\b/i;

/** The agent a question about coding work names ("Claude", "Codex"), or '' when it names none or is not about work. */
export function otherAgentWorkAsk(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || AGENT_SPEECH.test(text) || !(ASKS.test(text) || text.endsWith('?'))) return '';
  const agent = OTHER_AGENT.exec(text);
  return agent && AGENT_WORK.test(text) ? agent[0].toLowerCase() : '';
}

/** The reply to a question about another AI's coding work: CHE does not own it, and CHE's own record is given instead. */
// `correspondence`: what that AI itself wrote in the Flagstaff mailbox, read from the Brain's imported correspondence
// (brain_office.answerCorrespondenceQuestion), quoted with file and message id. It is that AI's own report, not CHE's
// verification, and it is said so.
export function otherAgentWorkReply(agent, jobs = [], repo = '', { correspondence = '' } = {}) {
  const named = /^(?:another|other|which|what)\b/.test(agent) ? 'another agent' : agent[0].toUpperCase() + agent.slice(1);
  const own = completedWorkProof(jobs, repo).text;
  const said = correspondence ? ` ${correspondence}` : '';
  return `I can't see ${named}'s live session in my own records, sir, so I can't confirm what it is doing right now or whether it reached a verified result.${said} ${own}`;
}

// ─── What another AI says it is working on: the live che-mailbox ────────────────────────────────────────────────────
// Owner live test (2026-10-25): "What is Claude currently working on?" answered "Nothing is running right now" from
// CHE's own job list, while Claude's mailbox thread and the live handoff on the che-mailbox branch said what it was
// doing. The answer now quotes that AI's newest mailbox message and its handoff entry, with message id, time and
// branch commit, as that AI's own report, never CHE's verification. A mailbox CHE has no credentials for is a missing
// tool, and a GitHub read that fails is a failed read: each is said as such, never as "nothing".
const clipLine = (text, n) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const minute = (iso) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'no recorded time'; };

/**
 * { text, records, outcome } from a live mailbox thread ({ messages } or { error }) and the live handoff
 * (mailbox.readLiveHandoff's result). outcome: retrieved | no_match | tool_unavailable | storage_failed.
 */
export function agentMailboxReport(agent, thread = {}, handoff = null) {
  const peer = String(agent || '').toLowerCase() === 'gpt' ? 'chatgpt' : String(agent || '').toLowerCase();
  const named = peer ? peer[0].toUpperCase() + peer.slice(1) : 'That AI';
  if (thread?.error) {
    const missing = /needs CHE_GITHUB_TOKEN|credentials|unavailable/i.test(thread.error);
    return missing
      ? { outcome: 'tool_unavailable', records: [], text: `My live mailbox reader isn't connected (no GitHub mailbox credentials), so I can't read what ${named} reported.` }
      : { outcome: 'storage_failed', records: [], text: `I couldn't read ${named}'s mailbox thread on GitHub just now (${clipLine(thread.error, 80)}), so I won't guess what it reported.` };
  }
  const theirs = (Array.isArray(thread?.messages) ? thread.messages : []).filter((m) => m?.from === peer && String(m.text || '').trim());
  const newest = theirs.map((m, i) => ({ m, i, t: Date.parse(String(m.at || '')) }))
    .sort((a, b) => ((Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity)) || (b.i - a.i))[0]?.m || null;
  const parts = [];
  const records = [];
  if (newest) {
    parts.push(`${named}'s newest mailbox message (mailbox/${peer}.jsonl, message ${newest.id || 'with no id'}, written ${minute(newest.at)}): "${clipLine(newest.text, 260)}"`);
    if (newest.id) records.push(`mailbox:${peer}:${newest.id}`);
  }
  // The handoff's "Current position" holds one entry per AI, newest first; the first one headed by this AI is its own.
  if (handoff?.status === 200 && handoff.checkpoint) {
    const entry = String(handoff.checkpoint).split(/\n(?=\*\*)/).find((block) => new RegExp(`^\\*\\*${named}\\b`, 'i').test(block.trim()));
    if (entry) {
      const head = /^\*\*([^*]+)\*\*/.exec(entry.trim());
      parts.push(`Its entry in the live handoff (che-mailbox ${String(handoff.head_sha || '').slice(0, 7)}): "${clipLine(head ? head[1] : entry, 260)}"`);
      records.push(`handoff:${String(handoff.head_sha || '').slice(0, 12)}`);
    }
  }
  if (!parts.length) return { outcome: 'no_match', records: [], text: `I read ${named}'s mailbox thread and the live handoff just now and found no message or handoff entry from ${named}, so I have no report of what it is doing.` };
  return { outcome: 'retrieved', records, text: `${parts.join(' ')} That is ${named}'s own report, not something I verified.` };
}

/**
 * The report part of "what is Claude working on?": { text, records, outcome }. `live(peer)` resolves to
 * [thread, handoff] from the che-mailbox branch (null when the mailbox has no credentials); `brain(peer)` reads the copy
 * imported into the Brain ({ text, records }). The Brain is read only when the live mailbox is missing or failed.
 */
export async function agentReportTurn(agent, { live = null, brain = null } = {}) {
  if (/^(?:another|other|which|what)\b/.test(String(agent || ''))) return { text: '', records: [], outcome: 'no_match' };
  const peer = agent === 'gpt' ? 'chatgpt' : agent;
  let report = agentMailboxReport(peer, { error: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.' });
  if (live) {
    try { const [thread, handoff] = await live(peer); report = agentMailboxReport(peer, thread, handoff); } catch (error) { report = agentMailboxReport(peer, { error: String(error?.message || error) }); }
  }
  if (report.outcome === 'retrieved' || report.outcome === 'no_match' || !brain) return report;
  try {
    const told = brain(peer);
    const records = told?.records || [];
    return { text: `${report.text} ${told?.text || ''}`.trim(), records, outcome: records.length ? 'retrieved' : report.outcome };
  } catch (_) {
    return { text: `${report.text} I could not read the imported mailbox in my Brain just now either, so I won't guess what it reported.`, records: [], outcome: 'storage_failed' };
  }
}
