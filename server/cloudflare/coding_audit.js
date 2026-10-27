// CHE's coding audit: why a coding run failed, what it tried and what actually happened, read from the
// runtime records the OpenCode runner itself publishes (che-opencode-runtime.yml posts one
// mailbox/runtime/ocr-<8hex>.json per run to the che-mailbox branch). Owner live test, 2026-10-27
// ("Reliability Test 2"): asked why her coding agent failed, CHE's model said she had no authorized
// telemetry or audit-log connection. She has one: the Worker's GitHub token already reads these records
// (coding_runtime.getStatus). The question was unrouted, so the model guessed.
//
// Read-only and owner-only. No new storage: the records stay on che-mailbox, read through the same
// GitHub client (coding_runtime.gh) and cached in memory for a minute. Every field a record does not hold
// is "not recorded", never inferred; error text is redacted before it is stored, spoken or returned;
// a failed GitHub read is said as that failure with its HTTP status, never as "no telemetry". Unknown
// and newer record fields are tolerated (the attempt ledger is still growing): known fields are
// normalized, other plain fields are passed through redacted.
import { gh } from './coding_runtime.js';
import { classifyModelFailure, redactSecrets } from './coding_failover.mjs';
import { codingHistoryIntent } from './code_scout.js';
import { otherAgentWorkAsk } from './coding_history.js';

export const AUDIT_REF = 'che-mailbox';
export const AUDIT_DIR = 'mailbox/runtime';
const NR = 'not recorded';
const CACHE_MS = 60_000;
const STALE_MS = 35 * 60_000;
const LIST_MAX = 20;
const ID = /^ocr-[0-9a-f]{8}$/;
const cache = new Map();

// ─── Redaction ────────────────────────────────────────────────────────────────────────────────────────────
// The runner's own redactor first (provider keys, bearer/basic auth, key headers and parameters, token
// fields), then what it does not cover: credentials inside URLs, ak-/as- style keys, and long hex or
// base64 runs that can be tokens. A commit SHA in error text is redacted too; the record's own SHA
// fields are read separately and validated as SHAs.
const EXTRA_SECRETS = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:'"]+(?::[^\s\/@'"]*)?@/gi, '$1[credentials]@'],
  [/\b(?:ak|as|AKIA|ASIA)[-_]?[A-Za-z0-9]{16,}\b/g, '[key]'],
  [/\b(?:github_pat|ghp|gho|ghu|ghs|ghr|glpat|xox[abpr])[-_][A-Za-z0-9_-]{6,}/g, '[key]'],
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
  [/(?<![A-Za-z0-9+\/_-])(?=[A-Za-z0-9+\/_-]*\d)(?=[A-Za-z0-9+\/_-]*[A-Za-z])[A-Za-z0-9+\/_-]{32,}={0,2}/g, '[token]'],
];
export function sanitizeText(value, max = 300) {
  if (!['string', 'number'].includes(typeof value)) return '';
  let text = redactSecrets(String(value));
  for (const [pattern, replacement] of EXTRA_SECRETS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

// The runner stores OpenCode's error event as JSON text; its name, message and ref are what it says.
function errorWords(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  try {
    const event = JSON.parse(text);
    const err = event?.error || event;
    const message = err?.data?.message || err?.message || '';
    const code = Number(err?.data?.statusCode || err?.statusCode || event?.statusCode) || 0;
    if (message) return sanitizeText(`${err.name ? `${err.name}: ` : ''}${message}${code ? ` (HTTP ${code})` : ''}${err?.data?.ref ? ` (ref ${err.data.ref})` : ''}`);
  } catch (_) { /* not JSON: read as text */ }
  // Older records stored the event with its quotes stripped: "{ type : error , ... message : X , ref : Y }".
  const legacy = /^\{\s*type\s*:\s*([a-z_]+)\b/i.exec(text);
  if (legacy) {
    if (legacy[1].toLowerCase() !== 'error') return `the last runner event stored is a ${legacy[1]} event, not an error message`;
    const name = /\bname\s*:\s*([A-Za-z]+)/.exec(text)?.[1] || '';
    const message = /\bmessage\s*:\s*(.+?)\s*,\s*(?:ref|statusCode|isRetryable|responseBody|metadata|url)\b|\bmessage\s*:\s*(.+?)\s*\}|\bmessage\s*:\s*(.{3,200})/.exec(text);
    const ref = /\bref\s*:\s*(err_[A-Za-z0-9]+)/.exec(text)?.[1] || '';
    const words = message ? (message[1] || message[2] || message[3]).replace(/[\s:,]+$/, '') : '';
    if (words) return sanitizeText(`${name ? `${name}: ` : ''}${words}${ref ? ` (ref ${ref})` : ''}`);
  }
  return sanitizeText(text);
}

// ─── Normalization ────────────────────────────────────────────────────────────────────────────────────────
const str = (v) => (typeof v === 'string' && v.trim() ? sanitizeText(v, 200) : NR);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NR));
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : NR);
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v.trim()) ? v.trim().toLowerCase() : NR);
const has = (v) => v !== NR;
function providerOf(model) {
  const m = String(model || '');
  return m.includes('/') ? m.slice(0, m.indexOf('/')) : NR;
}
// Plain extra fields a newer runner adds, passed through redacted; objects and arrays are named only.
function extras(object, known) {
  const out = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (known.has(key) || !/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
    if (typeof value === 'string') out[key] = sanitizeText(value, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else out[key] = Array.isArray(value) ? `[list of ${value.length}]` : '[object]';
  }
  return out;
}
const ATTEMPT_KEYS = new Set(['model', 'exit_code', 'kind', 'resumable', 'seconds', 'cap_seconds', 'progress', 'error']);
const RECORD_KEYS = new Set(['session_id', 'runtime', 'runtime_version', 'state', 'status', 'claimed_at', 'started_at', 'finished_at', 'updated_at', 'owner_merged_at', 'merged_by',
  'run_id', 'base_sha', 'target_branch', 'model', 'changed_files', 'additions', 'deletions', 'files', 'unsafe_files', 'opencode_exit_code', 'patch_artifact', 'failure',
  'models_tried', 'attempts', 'error', 'failure_kind', 'resumable', 'resume_count', 'merge_authorized', 'pr_number', 'ci_run_id', 'review_model', 'review', 'merge_commit_sha',
  'checkpoint', 'remaining', 'progress']);

function normalizeAttempts(record) {
  const ledger = Array.isArray(record.attempts) ? record.attempts.filter((a) => a && typeof a === 'object') : [];
  if (ledger.length) {
    return { source: 'attempt ledger', list: ledger.slice(0, 12).map((a, i) => {
      const model = typeof a.model === 'string' && a.model.trim() ? sanitizeText(a.model, 120) : NR;
      return {
        n: i + 1, provider: providerOf(model), model,
        exit_code: num(a.exit_code), kind: str(a.kind), resumable: typeof a.resumable === 'boolean' ? a.resumable : NR,
        seconds: num(a.seconds), cap_seconds: num(a.cap_seconds), progress: str(a.progress),
        error: errorWords(a.error) || NR, extra: extras(a, ATTEMPT_KEYS),
      };
    }) };
  }
  const tried = Array.isArray(record.models_tried) ? record.models_tried.filter((m) => typeof m === 'string' && m.trim()).slice(0, 8) : [];
  if (tried.length) {
    // Older records list the models without per-attempt receipts: only the order is known.
    return { source: 'models_tried (no per-attempt receipts)', list: tried.map((m, i) => ({
      n: i + 1, provider: providerOf(m), model: sanitizeText(m, 120), exit_code: NR, kind: NR, resumable: NR, seconds: NR, cap_seconds: NR, progress: NR,
      error: i === tried.length - 1 ? (errorWords(record.error) || NR) : NR, extra: {},
    })) };
  }
  return { source: 'none', list: [] };
}

const PROVIDER_WORDS = {
  quota: 'the model provider\'s quota for that key is used up',
  rate_limit: 'the model provider is rate limiting that key',
  access: 'the key has no access to that model',
  too_large: 'the request is larger than the token limit of that model key',
};
const PROVIDER_5XX = /\b(?:statusCode\W{0,3}5\d\d|HTTP 5\d\d|5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)|overloaded|upstream error|provider returned error)\b/i;
const RUNNER_INTERNAL = /\bUnknownError\b|Unexpected server error/i;

// Which layer failed: the model provider, the OpenCode runner itself, a guard, delivery, tests or review.
export function classifyFailure(run) {
  const { state, failure } = run.execution;
  const last = run.attempts.list.at(-1) || null;
  const text = last && has(last.error) ? last.error : '';
  const exit = last && has(last.exit_code) ? last.exit_code : run.execution.exit_code;
  if (['succeeded', 'no_change', 'in_progress', 'waiting_owner'].includes(run.outcome)) return { layer: 'none', category: 'none', words: 'nothing has failed by its record' };
  if (run.outcome === 'stale') return { layer: 'runner', category: 'stale', words: 'the runner stopped updating its record before it finished' };
  if (failure === 'unsafe_files') return { layer: 'guard', category: 'unsafe_files', words: `the runner's safety guard refused the change because it touched protected files (${run.changes.unsafe_files.join(', ') || 'list not recorded'})` };
  if (failure === 'deliver_failed') return { layer: 'delivery', category: 'deliver_failed', words: 'the code change was made but the pull request could not be opened (a GitHub delivery step, not the model)' };
  if (state === 'tests_failed') return { layer: 'tests', category: 'tests_failed', words: 'the tests failed on the pull request' };
  if (state === 'review_rejected') return { layer: 'review', category: 'review_rejected', words: 'the independent reviewer rejected the change' };
  if (run.outcome === 'not_delivered') return { layer: 'unknown', category: 'not_delivered', words: 'the record shows the change was made, but holds no pull request and no delivery result' };
  if (failure === 'opencode_failed' || last) {
    if (!run.attempts.list.length) return { layer: 'runner', category: 'no_attempt', words: `no model attempt was recorded: the runner exited${has(run.execution.exit_code) ? ` with code ${run.execution.exit_code}` : ''} before any model ran, and no error text was stored` };
    const kind = last && has(last.kind) && last.kind !== 'unknown' ? last.kind : classifyModelFailure({ text, exitCode: Number(exit) || 0 }).kind;
    if (PROVIDER_WORDS[kind]) return { layer: 'provider', category: kind, words: PROVIDER_WORDS[kind] };
    if (kind === 'timeout') return { layer: 'runner', category: 'timeout', words: 'the attempt ran out of its time budget' };
    if (PROVIDER_5XX.test(text)) return { layer: 'provider', category: 'provider_5xx', words: 'the model provider returned a server error' };
    if (RUNNER_INTERNAL.test(text)) return { layer: 'runner', category: 'runner_internal_error', words: 'the OpenCode runner reported its own internal error; the record does not say whether the model provider caused it, so it is not counted as a provider outage' };
    return { layer: 'unknown', category: 'unclassified', words: text ? 'the record\'s error text does not say which layer failed' : 'the record holds no error text' };
  }
  if (failure && failure !== NR) return { layer: 'runner', category: failure, words: `the runner stopped with ${failure.replace(/_/g, ' ')}` };
  return { layer: 'unknown', category: 'not_recorded', words: 'the record does not say why' };
}

function outcomeOf(r, now) {
  const { state } = r.execution;
  if (['merged', 'complete'].includes(state)) return has(r.pr_number) && has(r.merge_commit_sha) ? 'succeeded' : 'unverified';
  if (state === 'no_change') return 'no_change';
  if (['queued', 'running', 'dispatching', 'retrying', 'resuming', 'waiting_capacity', 'pr_open', 'reviewing'].includes(state)) {
    const beat = Date.parse([r.timestamps.updated_at, r.timestamps.claimed_at].find(has) || '');
    return Number.isFinite(beat) && now - beat > STALE_MS ? 'stale' : 'in_progress';
  }
  if (state === 'approved_waiting_owner') return 'waiting_owner';
  if (state === 'implemented') return 'not_delivered';
  return 'failed';
}

/** One runtime record, normalized. `meta`: { path, blob_sha, recorded_at, repo, name }. */
export function normalizeRecord(record = {}, meta = {}, { now = Date.now() } = {}) {
  const rec = record && typeof record === 'object' ? record : {};
  const id = typeof rec.session_id === 'string' && ID.test(rec.session_id) ? rec.session_id : NR;
  const repo = meta.repo || '';
  const runId = num(rec.run_id);
  const ciId = num(rec.ci_run_id);
  const prNumber = num(rec.pr_number);
  const run = {
    id,
    record_path: meta.path || (has(id) ? `${AUDIT_DIR}/${id}.json` : NR),
    record_ref: AUDIT_REF,
    record_blob_sha: typeof meta.blob_sha === 'string' && meta.blob_sha ? meta.blob_sha : NR,
    record_name_matches: meta.name ? meta.name === `${id}.json` : NR,
    agent: { runtime: str(rec.runtime), version: str(rec.runtime_version), executor: has(runId) ? 'GitHub Actions (che-opencode-runtime.yml)' : NR },
    timestamps: { claimed_at: time(rec.claimed_at), started_at: time(rec.started_at), finished_at: time(rec.finished_at), updated_at: time(rec.updated_at), owner_merged_at: time(rec.owner_merged_at), recorded_on_branch_at: time(meta.recorded_at) },
    requested_model: str(rec.model),
    target_branch: str(rec.target_branch),
    base_sha: sha(rec.base_sha),
    attempts: normalizeAttempts(rec),
    fallback: null,
    execution: { state: str(rec.state), failure: typeof rec.failure === 'string' && rec.failure.trim() ? sanitizeText(rec.failure, 60) : NR, exit_code: num(rec.opencode_exit_code), failure_kind: str(rec.failure_kind) },
    changes: {
      changed_files: num(rec.changed_files), additions: num(rec.additions), deletions: num(rec.deletions),
      files: Array.isArray(rec.files) ? rec.files.filter((f) => typeof f === 'string').slice(0, 40).map((f) => sanitizeText(f, 160)) : NR,
      unsafe_files: Array.isArray(rec.unsafe_files) ? rec.unsafe_files.filter((f) => typeof f === 'string').slice(0, 20).map((f) => sanitizeText(f, 160)) : [],
      patch_artifact: str(rec.patch_artifact),
    },
    pr_number: typeof prNumber === 'number' && prNumber > 0 ? prNumber : NR,
    merge_commit_sha: sha(rec.merge_commit_sha),
    merged_by: str(rec.merged_by),
    ci: {
      workflow_run_id: runId,
      workflow_run_url: has(runId) && repo ? `https://github.com/${repo}/actions/runs/${runId}` : NR,
      ci_run_id: ciId,
      ci_run_url: has(ciId) && repo ? `https://github.com/${repo}/actions/runs/${ciId}` : NR,
      pr_url: typeof prNumber === 'number' && prNumber > 0 && repo ? `https://github.com/${repo}/pull/${prNumber}` : NR,
    },
    review: { model: str(rec.review_model), verdict: typeof rec.review === 'string' && rec.review.trim() ? sanitizeText(rec.review.split('\n')[0], 40) : NR },
    extra_fields: extras(rec, RECORD_KEYS),
  };
  const order = run.attempts.list.map((a) => a.model).filter(has);
  run.fallback = {
    attempted: run.attempts.list.length > 1 ? true : run.attempts.list.length === 1 ? false : NR,
    models_in_order: order,
    resumable: typeof rec.resumable === 'boolean' ? rec.resumable : NR,
    resume_count: num(rec.resume_count),
  };
  run.outcome = outcomeOf(run, now);
  run.failure_class = classifyFailure(run);
  run.not_recorded = [
    ...Object.entries(run.timestamps).filter(([, v]) => !has(v)).map(([k]) => k),
    ...['pr_number', 'merge_commit_sha'].filter((k) => !has(run[k])),
    ...(!has(run.ci.workflow_run_id) ? ['run_id'] : []),
    ...(run.attempts.source === 'none' ? ['attempts'] : run.attempts.source !== 'attempt ledger' ? ['per_attempt_receipts'] : []),
  ];
  return run;
}

// ─── Reading the records (GitHub contents and commits API, che-mailbox) ──────────────────────────────────
function decode(content) {
  const binary = atob(String(content || '').replace(/\s+/g, ''));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
}
const readFailure = (res, what) => ({ ok: false, status: res.status || 0, detail: `GitHub refused or failed the read of ${what} (${res.status ? `HTTP ${res.status}` : 'network error'}${res.data?.message ? `: ${sanitizeText(res.data.message, 120)}` : ''}).` });
function configured(env) {
  return Boolean(env?.CHE_GITHUB_TOKEN) && /^[\w.-]+\/[\w.-]+$/.test(String(env?.CHE_GITHUB_REPO || '').trim());
}
const NOT_CONFIGURED = { ok: false, status: 503, detail: 'The Worker has no GitHub credentials (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO), so the runtime records cannot be read.' };

/** One run's audit: { ok, run } | { ok:false, found:false } (no such record) | { ok:false, status, detail } (read failed). */
export async function readRun(env, sessionId, { fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const id = String(sessionId || '').trim().toLowerCase();
  if (!ID.test(id)) return { ok: false, status: 400, detail: 'A coding run id looks like ocr- and eight hex characters.' };
  if (!configured(env)) return NOT_CONFIGURED;
  const key = `run|${env.CHE_GITHUB_REPO}|${id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const path = `${AUDIT_DIR}/${id}.json`;
  const res = await gh(env, 'GET', `/contents/${path}?ref=${AUDIT_REF}`, null, fetcher);
  let value;
  if (res.status === 404) value = { ok: false, found: false, status: 404, id, detail: `No runtime record ${path} exists on ${AUDIT_REF}.` };
  else if (!res.ok) value = readFailure(res, path);
  else {
    try {
      value = { ok: true, run: normalizeRecord(decode(res.data?.content), { path, blob_sha: res.data?.sha, name: `${id}.json`, repo: env.CHE_GITHUB_REPO }, { now }) };
    } catch (_) { value = { ok: false, status: 502, detail: `The runtime record ${path} is not valid JSON.` }; }
  }
  if (value.ok || value.found === false) cache.set(key, { at: now, value });
  return value;
}

/**
 * The newest runs, newest first: { ok, total, order, runs, unread }. The directory listing proves what
 * exists; the branch's commit history ("runtime: ocr-…") gives the order and the time each record was
 * written. Bounded: one listing, one commit page, at most `limit` record reads.
 */
export async function listRuns(env, { limit = 8, fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (!configured(env)) return NOT_CONFIGURED;
  const n = Math.max(1, Math.min(LIST_MAX, Number(limit) || 8));
  const key = `list|${env.CHE_GITHUB_REPO}|${n}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const dir = await gh(env, 'GET', `/contents/${AUDIT_DIR}?ref=${AUDIT_REF}`, null, fetcher);
  if (dir.status === 404) return { ok: true, total: 0, order: 'none', runs: [], unread: [] };
  if (!dir.ok) return readFailure(dir, `${AUDIT_DIR} on ${AUDIT_REF}`);
  const names = new Map((Array.isArray(dir.data) ? dir.data : [])
    .filter((f) => f?.type !== 'dir' && /^ocr-[0-9a-f]{8}\.json$/.test(String(f?.name || '')))
    .map((f) => [f.name.slice(0, -5), f.sha || '']));
  const commits = await gh(env, 'GET', `/commits?sha=${AUDIT_REF}&path=${AUDIT_DIR}&per_page=100`, null, fetcher);
  const recordedAt = new Map();
  let order = 'commit history';
  if (commits.ok && Array.isArray(commits.data)) {
    for (const c of commits.data) {
      const m = /\b(ocr-[0-9a-f]{8})\b/.exec(String(c?.commit?.message || ''));
      if (m && names.has(m[1]) && !recordedAt.has(m[1])) recordedAt.set(m[1], c?.commit?.committer?.date || c?.commit?.author?.date || '');
    }
  } else order = `unknown (the commit history read failed: ${commits.status ? `HTTP ${commits.status}` : 'network error'})`;
  const ids = [...recordedAt.keys(), ...[...names.keys()].filter((id) => !recordedAt.has(id)).sort()];
  const picked = ids.slice(0, n);
  const runs = [];
  const unread = [];
  await Promise.all(picked.map(async (id, i) => {
    const path = `${AUDIT_DIR}/${id}.json`;
    const res = await gh(env, 'GET', `/contents/${path}?ref=${AUDIT_REF}`, null, fetcher);
    if (!res.ok) { unread.push({ id, status: res.status || 0 }); return; }
    try {
      runs[i] = normalizeRecord(decode(res.data?.content), { path, blob_sha: res.data?.sha || names.get(id), recorded_at: recordedAt.get(id), name: `${id}.json`, repo: env.CHE_GITHUB_REPO }, { now });
    } catch (_) { unread.push({ id, status: 502 }); }
  }));
  const read = runs.filter(Boolean);
  unread.sort((a, b) => picked.indexOf(a.id) - picked.indexOf(b.id));
  const statuses = unread.map((u) => `${u.id}: ${u.status ? `HTTP ${u.status}` : 'network error'}`).join(', ');
  // Records exist but none could be read (a rate limit, a revoked token): that is a failed read, never "no records".
  if (picked.length && !read.length) {
    return { ok: false, status: unread[0]?.status || 502, unread, detail: `${names.size} record${names.size === 1 ? '' : 's'} exist in ${AUDIT_DIR} on ${AUDIT_REF}, but none of the ${picked.length} I tried could be read (${statuses}).` };
  }
  const value = { ok: true, total: names.size, order, runs: read, unread, tried: picked.length,
    unread_words: unread.length ? `${unread.length} of the ${picked.length} records I tried could not be read (${statuses}).` : '' };
  // Only a complete read is cached, so an unreadable record is tried again on the next ask.
  if (!unread.length) cache.set(key, { at: now, value });
  return value;
}

export function clearAuditCache() { cache.clear(); }

// ─── Owner-facing words ──────────────────────────────────────────────────────────────────────────────────
const at = (iso) => (has(iso) ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
function when(run) {
  const t = run.timestamps;
  if (has(t.finished_at)) return `finished ${at(t.finished_at)}`;
  if (has(t.updated_at)) return `last updated ${at(t.updated_at)}`;
  if (has(t.recorded_on_branch_at)) return `record written ${at(t.recorded_on_branch_at)}`;
  return 'time not recorded';
}
function attemptWords(a) {
  const bits = [`${a.n}. ${a.model}`];
  if (has(a.exit_code)) bits.push(`exit code ${a.exit_code}`);
  if (has(a.seconds)) bits.push(`${a.seconds} s${has(a.cap_seconds) ? ` of a ${a.cap_seconds} s cap` : ''}`);
  if (has(a.kind)) bits.push(`failure kind ${a.kind.replace(/_/g, ' ')}`);
  if (has(a.progress)) bits.push(a.progress === 'none' ? 'no edits kept' : `edits ${a.progress}`);
  if (has(a.error)) bits.push(`error "${a.error.slice(0, 160)}"`);
  return bits.join(', ');
}
const OUTCOME_WORDS = {
  succeeded: 'completed: merged, with its pull request and merge commit on record',
  unverified: 'recorded as merged, but without a pull request number and merge commit, so I cannot confirm it completed',
  no_change: 'finished with nothing to change',
  in_progress: 'still in progress by its record',
  stale: 'last recorded as active, but its record has not been updated for over 35 minutes, so I cannot confirm it is still running',
  waiting_owner: 'passed tests and review and is waiting for your approval to merge',
  not_delivered: 'made a change that was never delivered as a pull request',
  failed: 'did not complete',
};

/** The spoken audit of one run. */
export function speakRun(run) {
  const lines = [];
  const agent = `${has(run.agent.runtime) ? (run.agent.runtime === 'opencode' ? 'OpenCode runner' : run.agent.runtime) : 'coding runner'}${has(run.agent.version) ? ` ${run.agent.version}` : ''}`;
  lines.push(`Coding run ${run.id} (${agent}${has(run.ci.workflow_run_id) ? `, GitHub Actions run ${run.ci.workflow_run_id}` : ''}), ${when(run)}: state ${run.execution.state.replace(/_/g, ' ')}${has(run.execution.failure) ? `, ${run.execution.failure.replace(/_/g, ' ')}` : ''}.`);
  const list = run.attempts.list;
  if (list.length) {
    lines.push(`What it tried: ${list.length} attempt${list.length === 1 ? '' : 's'}${run.attempts.source === 'attempt ledger' ? '' : ' (the record lists models only, no per-attempt receipts)'}: ${list.map(attemptWords).join('; ')}.`);
  } else {
    lines.push(`What it tried: no model attempt is recorded${has(run.requested_model) ? ` (requested model: ${run.requested_model})` : ''}.`);
  }
  const fb = run.fallback;
  lines.push(fb.attempted === true
    ? `Fallback: yes, it moved through ${fb.models_in_order.length} models in this order: ${fb.models_in_order.join(' then ')}.`
    : fb.attempted === false ? 'Fallback: none; only one model was tried.' : 'Fallback: not recorded.');
  if (fb.resumable === true) lines.push(`It kept a checkpoint and may resume (resumes so far: ${has(fb.resume_count) ? fb.resume_count : 'not recorded'}).`);
  if (run.failure_class.layer !== 'none') lines.push(`What actually happened: ${run.failure_class.layer === 'unknown' ? '' : `a ${run.failure_class.layer} failure; `}${run.failure_class.words}.`);
  const c = run.changes;
  lines.push(`Files changed: ${has(c.changed_files) ? `${c.changed_files}${has(c.additions) && has(c.deletions) ? ` (+${c.additions}/-${c.deletions})` : ''}` : NR}. Pull request: ${has(run.pr_number) ? `#${run.pr_number}` : 'none recorded'}. Merge commit: ${has(run.merge_commit_sha) ? run.merge_commit_sha.slice(0, 12) : 'none recorded'}.`);
  lines.push(`Outcome: ${OUTCOME_WORDS[run.outcome] || run.outcome}.`);
  const ev = [`che-mailbox ${run.record_path}`];
  if (has(run.ci.workflow_run_url)) ev.push(run.ci.workflow_run_url);
  if (has(run.ci.ci_run_url)) ev.push(`CI ${run.ci.ci_run_url}`);
  if (has(run.ci.pr_url)) ev.push(run.ci.pr_url);
  lines.push(`Evidence: ${ev.join('; ')}.`);
  return lines.join(' ');
}

const signature = (run) => `${run.failure_class.category}|${run.attempts.list.at(-1)?.model || 'none'}`;

/** "Why did my coding agent fail?": the newest failed run in detail, and how the recent runs ended. */
export function speakFailureSummary(listed) {
  const runs = listed.runs;
  if (!runs.length) return `I read ${AUDIT_DIR} on ${AUDIT_REF}: it holds no coding run records, so there is no failure to explain.`;
  const failed = runs.filter((r) => ['failed', 'not_delivered', 'stale', 'unverified'].includes(r.outcome));
  const head = `I read my coding runner's own records on GitHub (${listed.total} in ${AUDIT_DIR} on ${AUDIT_REF}; the newest ${runs.length}${listed.unread.length ? ' I could read' : ''}, ordered by ${listed.order}).`;
  const tally = {};
  for (const r of runs) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
  const counts = Object.entries(tally).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ');
  const unread = listed.unread_words ? ` ${listed.unread_words}` : '';
  if (!failed.length) return `${head} Of those: ${counts}. None of them failed.${unread} Newest: ${speakRun(runs[0])}`;
  const latest = failed[0];
  const same = failed.filter((r) => signature(r) === signature(latest)).length;
  const pattern = same > 1 ? ` ${same} of the ${runs.length} newest runs failed the same way (${latest.failure_class.category.replace(/_/g, ' ')}${latest.attempts.list.length ? ` on ${latest.attempts.list.at(-1).model}` : ''}).` : '';
  const newer = runs[0] !== latest ? ` The newest record, ${runs[0].id}, is ${OUTCOME_WORDS[runs[0].outcome] || runs[0].outcome}.` : '';
  return `${head} Of those: ${counts}.${pattern}${newer}${unread} The latest failure: ${speakRun(latest)}`;
}

export function speakRunList(listed) {
  if (!listed.runs.length) return `I read ${AUDIT_DIR} on ${AUDIT_REF}: no coding run records are there.`;
  const rows = listed.runs.map((r) => `${r.id}, ${when(r)}: ${r.execution.state.replace(/_/g, ' ')}${has(r.execution.failure) ? ` (${r.execution.failure.replace(/_/g, ' ')})` : ''}, ${r.attempts.list.length} attempt${r.attempts.list.length === 1 ? '' : 's'}${r.attempts.list.length ? ` on ${r.attempts.list.map((a) => a.model).join(', ')}` : ''}${has(r.pr_number) ? `, PR #${r.pr_number}` : ''}.`);
  const unread = listed.unread_words ? ` ${listed.unread_words}` : '';
  return `My coding runner has ${listed.total} run records in ${AUDIT_DIR} on ${AUDIT_REF}. The newest ${listed.runs.length}${listed.unread.length ? ' I could read' : ''}, ordered by ${listed.order}: ${rows.map((row, i) => `${i + 1}. ${row}`).join(' ')}${unread} Ask "show coding attempts for" a run id for its full audit.`;
}

// ─── Chat intent ─────────────────────────────────────────────────────────────────────────────────────────
// "coding", and how speech recognition hears it ("codeing", "coating", "cording", "open code").
const CODER = String.raw`(?:coding|codeing|codding|coating|cording|opencode|open\s+code)`;
const SUBJECT = new RegExp(String.raw`\b${CODER}(?:'s)?\s+(?:agents?|jobs?|runs?|runners?|tasks?|attempts?|crew|sessions?|work)\b|\bcode\s+(?:agent|runner)\b`, 'i');
const RUN_ID = /\bocr[-\s]?([0-9a-f]{8})\b/i;
const FAIL_ASK = /\b(?:why|how\s+come|what\s+(?:made|caused))\b[^.?!]{0,80}\b(?:fail\w*|break|broke|broken|crash\w*|stop(?:ped)?|go\s+wrong|went\s+wrong|block\w*|error\w*)\b|\bwhat\s+(?:actually\s+|really\s+)?(?:went\s+wrong|happened)\b/i;
const TRY_ASK = /\bwhat\b[^.?!]{0,40}\b(?:try|tried|attempt\w*)\b|\b(?:which|what)\s+models?\b|\bfall\s*(?:back|over)\b|\b(?:show|list|give|read)\b[^.?!]{0,30}\battempts?\b|\battempts?\s+(?:for|of|on)\b/i;
const LIST_ASK = new RegExp(String.raw`^\s*(?:(?:che|chey|chay)[,:]?\s+)?(?:(?:show|list|read|give)\s+(?:me\s+)?(?:my\s+|your\s+|all\s+|the\s+)?(?:(?:recent|latest|last(?:\s+\d+)?)\s+)?${CODER}\s+(?:runs|jobs|attempts|run\s+history|audit)|${CODER}\s+(?:audit|attempts|run\s+history)(?:\s+log)?)\s*[?.!]?\s*$`, 'i');
const AUDIT_WORD = /\b(?:audit|attempts?|history|record|evidence|explain|show|details?|what|why|how|did|status|happened)\b/i;
// An instruction to change or rerun something, or a message for someone else, is not a question for the records.
const NOT_A_READ = /^\s*(?:(?:che|chey|chay)[,:]?\s+)?(?:please\s+)?(?:fix|make|change|build|implement|add|update|retry|rerun|re-run|restart|resume|cancel|stop|delete|remove|debug|repair|recover|tell|ask|message|send|forward|email|text|remember|write|create|draft)\b|\b(?:tell|ask|message|email)\s+(?:claude|codex|chatgpt|gemini|cursor|copilot|grok|dad|mom)\b|\b(?:retry|rerun|re-run|try\s+again|fix\s+it|recover\s+it|another\s+(?:go|try))\b/i;

/** 'run' (one named run), 'failure' (why did it fail / what did it try), 'list', or '' for anything else. */
export function codingAuditIntent(message) {
  const text = String(message || '').replace(/[’]/g, "'").trim();
  if (!text || text.length > 400 || /^\s*\//.test(text) || NOT_A_READ.test(text)) return '';
  // Another AI's coding work ("What did Claude try on the coding task?") is not in these records: its own route
  // (coding_history.otherAgentWorkAsk) reads that AI's mailbox and handoff.
  if (otherAgentWorkAsk(text)) return '';
  const id = RUN_ID.exec(text);
  if (id) return AUDIT_WORD.test(text) || SUBJECT.test(text) ? 'run' : '';
  if (LIST_ASK.test(text)) return 'list';
  // The existing record route (coding_history) keeps every question it already answers.
  if (!SUBJECT.test(text) || !(FAIL_ASK.test(text) || TRY_ASK.test(text))) return '';
  return codingHistoryIntent(text) ? '' : 'failure';
}

/**
 * The chat turn, or null when the message is not a coding-audit question. Returns { text, meta } for
 * ndjsonReply. `owner`: the request came from the owner's device.
 */
export async function codingAuditTurn(message, env, { owner = false, fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const kind = codingAuditIntent(message);
  if (!kind) return null;
  const base = { source: 'che_coding_audit', model_calls: 0, audit: kind };
  if (!owner) return { text: 'Only the CHE owner can read the coding run records, sir.', meta: { ...base, ok: false, outcome: 'permission_denied' } };
  const failed = (res) => ({ text: `I could not read my coding run records just now: ${res.detail} So I can't say ${kind === 'list' ? 'which runs there are' : 'what the run tried or why it failed'}, and I won't guess.`, meta: { ...base, ok: false, status: res.status, outcome: 'storage_failed' } });
  if (kind === 'run') {
    const id = `ocr-${RUN_ID.exec(String(message))[1].toLowerCase()}`;
    const res = await readRun(env, id, { fetcher, now });
    if (res.found === false) return { text: `There is no coding run record ${id}, sir: ${AUDIT_DIR}/${id}.json does not exist on ${AUDIT_REF}. Nothing was started or changed.`, meta: { ...base, ok: true, session_id: id, outcome: 'no_match', records: 0 } };
    if (!res.ok) return failed(res);
    return { text: speakRun(res.run), meta: { ...base, ok: true, session_id: id, outcome: 'retrieved', records: 1, record_ids: [res.run.record_path], run_outcome: res.run.outcome, failure_layer: res.run.failure_class.layer } };
  }
  const listed = await listRuns(env, { limit: 8, fetcher, now });
  if (!listed.ok) return failed(listed);
  const text = kind === 'list' ? speakRunList(listed) : speakFailureSummary(listed);
  const ids = listed.runs.map((r) => r.record_path);
  return { text, meta: { ...base, ok: true, outcome: ids.length ? 'retrieved' : 'no_match', records: ids.length, record_ids: ids, total_records: listed.total, unreadable_records: listed.unread.length } };
}

// ─── HTTP: GET /api/coding/audit[?limit=N] and GET /api/coding/audit/ocr-xxxxxxxx (owner device only) ───
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
export async function codingAuditApi(request, path, env, owner, { fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (!owner) return reply({ detail: 'Not found.' }, 404);
  if (request.method !== 'GET') return reply({ detail: 'Method not allowed.' }, 405);
  const m = /^\/api\/coding\/audit(?:\/([^/]+))?\/?$/.exec(path);
  if (!m) return reply({ detail: 'Not found.' }, 404);
  if (m[1]) {
    const res = await readRun(env, decodeURIComponent(m[1]), { fetcher, now });
    return res.ok ? reply(res) : reply(res, res.status && res.status >= 400 ? res.status : 502);
  }
  const limit = Number(new URL(request.url).searchParams.get('limit')) || 8;
  const res = await listRuns(env, { limit, fetcher, now });
  return res.ok ? reply({ ...res, ref: AUDIT_REF, dir: AUDIT_DIR }) : reply(res, res.status && res.status >= 400 ? res.status : 502);
}

// "Coding status" with no job or session stored on this device used to say "No coding job has started yet"
// while the runner's records on GitHub held runs. The newest record is named instead; without credentials,
// or with no records, the old sentence stands; a failed read is said as one.
export const NO_JOB_TEXT = 'No coding job has started yet, sir.';
export async function noStoredJobReceipt(env, { fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (!configured(env)) return NO_JOB_TEXT;
  const listed = await listRuns(env, { limit: 1, fetcher, now });
  if (!listed.ok) return `No coding job is stored on this device, sir, and I could not check my coding runner's records on GitHub: ${listed.detail}`;
  if (!listed.runs.length) return NO_JOB_TEXT;
  return `No coding job is stored on this device, sir, but my coding runner's newest record on GitHub (of ${listed.total}) is this. ${speakRun(listed.runs[0])}`;
}

// ─── The deploy's live check (che-worker-deploy.yml) ────────────────────────────────────────────────────
// Asks the isolated test CHE (the memory probe's object, never the owner's) the question she failed in
// Reliability Test 2, and a run id that does not exist, through the real /api/chat. The test CHE reads the
// same che-mailbox records with the Worker's own GitHub token. A reply that claims a missing telemetry,
// plugin or connector, any model call, or a failed record read fails the check.
export const CLAIMS_MISSING_ACCESS = /telemetry|plug-?ins?\b|audit[- ]?logs?\b|\bconnectors?\b|\bauthori[sz]ed\s+(?:\w+\s+){0,3}(?:connection|integration)\b/i;
export async function codingAuditProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE coding audit check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const step = async (name, message, check) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    const recordBacked = done.source === 'che_coding_audit' && done.model_calls === 0 && !CLAIMS_MISSING_ACCESS.test(reply);
    steps.push({ name, pass: res.status === 200 && recordBacked && Boolean(check({ reply, done })), ms: Date.now() - started, route: done.source || 'model', model_calls: done.model_calls ?? null, outcome: done.outcome || '', reply: reply.slice(0, 600) });
  };
  try {
    await step('Reliability Test 2: why did my coding agent fail, answered from the records', 'Why did my coding agent fail, what did it try, and what actually happened?',
      ({ reply, done }) => done.outcome === 'retrieved' && /^I read my coding runner's own records on GitHub/.test(reply) && /Evidence: che-mailbox mailbox\/runtime\/ocr-[0-9a-f]{8}\.json/.test(reply));
    await step('a run id with no record is said to have none', 'show coding attempts for ocr-00000000',
      ({ reply, done }) => done.outcome === 'no_match' && /^There is no coding run record ocr-00000000/.test(reply));
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const passed = steps.filter((s) => s.pass).length;
  return { ok: passed === steps.length, passed, total: steps.length, steps };
}
