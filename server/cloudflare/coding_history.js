// Owner-facing receipt for CHE's latest coding work, for both "coding status" and history questions.
// It is built only from stored records: the built-in job, or the runtime result file the runner
// publishes. The state sentence is speakRuntimeStatus's (resume, retry and unconfirmed-run wording
// included); every evidence field a record does not hold is named as not recorded. Nothing here
// starts a job or reads repository files.
import { runtimeState, runtimeStateClass, speakRuntimeStatus } from './coding_runtime.js';

const DEFAULT_REPO = 'Vondada/chey-app';

function listed(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function clip(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const status = String(job.status || 'queued');
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

// A built-in job keeps its outcome as result and error text, which is read back as written.
function jobReceipt(job, stale, unread) {
  const lines = [jobState(job, stale), `Built-in job: ${String(job.id || '').slice(0, 12)}.`];
  const asked = clip(job.request || job.title || job.prompt);
  if (asked) lines.push(`Request: ${asked}.`);
  if (clip(job.result)) lines.push(`Result: ${sentence(job.result)}`);
  if (clip(job.error)) lines.push(`Error: ${sentence(job.error)}`);
  lines.push('Its record has no GitHub run link, model list or changed-file count.');
  if (unread) lines.push(unread);
  return lines.join(' ');
}

function unreadReason(status) {
  if (!status) return 'I could not read its record';
  return status.detail ? `I could not read its record: ${clip(status.detail, 160)}` : `I could not read its record (HTTP ${status.status})`;
}

// `unreadRun`: a newer runtime session whose record could not be read, reported beside the
// active built-in job instead of being silently dropped.
export function codingHistoryReceipt({ kind = 'none', job = null, stale = false, sessionId = '', status = null, request = '', repo = '', unreadRun = null } = {}) {
  if (kind === 'job' && job) {
    const unread = unreadRun ? `A newer coding run, ${unreadRun.sessionId}, exists, but ${unreadReason(unreadRun.status)}; its state is UNVERIFIED.` : '';
    return jobReceipt(job, stale, unread);
  }
  if (kind !== 'runtime' || !sessionId) return 'No coding job has started yet, sir. Nothing is running.';
  if (!status || Number(status.status) !== 200) {
    return `Coding run ${sessionId}: ${unreadReason(status)}. Its state, run and result are UNVERIFIED.`;
  }
  const state = runtimeState(status);
  const lines = [`Latest coding run: ${sessionId}.`];
  const asked = clip(request);
  if (asked) lines.push(`Request: ${asked}.`);
  // getStatus marks liveness 'unverified' when GitHub could not be asked; the run is then
  // neither running nor failed, whatever its last record said.
  lines.push(status.liveness === 'unverified' && runtimeStateClass(status) === 'active'
    ? `State: UNVERIFIED, last recorded as ${state.replace(/_/g, ' ')}.`
    : `State: ${state.replace(/_/g, ' ')}.`);
  lines.push(speakRuntimeStatus(status));
  const failure = [status.failure, clip(status.error)].filter(Boolean).join(' - ');
  if (failure) lines.push(`${['waiting_capacity', 'resuming'].includes(state) ? 'Last failure' : 'Failure'}: ${sentence(failure)}`);
  const runId = Number(status.run_id) || 0;
  lines.push(runId ? `GitHub run: https://github.com/${repo || DEFAULT_REPO}/actions/runs/${runId}` : 'GitHub run: not recorded.');
  const tried = listed(status.models_tried);
  if (tried.length) lines.push(`Models tried: ${tried.join(', ')}.`);
  else if (status.model) lines.push(`Model: ${String(status.model)}.`);
  else lines.push('Models tried: not recorded.');
  lines.push(Number.isInteger(status.changed_files) ? `Files changed: ${status.changed_files}.` : 'Files changed: not recorded.');
  lines.push(Number.isInteger(status.pr_number) && status.pr_number > 0 ? `Pull request: #${status.pr_number}.` : 'Pull request: none recorded.');
  lines.push(testLine(state));
  // heartbeat 'stale': GitHub confirmed the run is alive but its progress file is old.
  if (status.heartbeat === 'stale' && status.liveness !== 'unverified') lines.push('GitHub shows the run is still live, but it has not reported progress recently.');
  return lines.join(' ');
}
