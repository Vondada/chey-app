// Owner-facing receipt for CHE's latest coding work. It is built only from stored records:
// the built-in job, or the runtime result file the runner publishes. Every field a record
// does not hold is named as not recorded, and nothing here starts a job or reads repository files.
const DEFAULT_REPO = 'Vondada/chey-app';

function listed(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

// Test outcomes the runtime itself reports (coding_runtime.js runtimeState). Anything else is not claimed.
function testLine(state) {
  if (state === 'tests_failed') return 'Tests: failed.';
  if (state === 'review_rejected') return 'Tests: passed, but my reviewer rejected the change.';
  if (['reviewing', 'approved_waiting_owner', 'merged'].includes(state)) return 'Tests: passed.';
  if (state === 'pr_open') return 'Tests: running.';
  return 'Tests: not recorded in the runtime record, so none are claimed.';
}

function jobReceipt(job) {
  const state = job.dead_letter ? 'dead letter' : String(job.status || 'unknown').replace(/_/g, ' ');
  return [
    `Latest coding job: built-in job ${String(job.id || '').slice(0, 12)}.`,
    `State: ${state}.`,
    job.checkpoint ? 'Its recovery checkpoint is saved.' : 'No recovery checkpoint is saved.',
    'It has no runtime record, so GitHub run, models tried, files changed, pull request and tests are not recorded.',
  ].join(' ');
}

export function codingHistoryReceipt({ kind = 'none', job = null, sessionId = '', status = null, request = '', repo = '' } = {}) {
  if (kind === 'job' && job) return jobReceipt(job);
  if (kind !== 'runtime' || !sessionId) return 'No coding run is recorded for CHE yet, sir. Nothing is running.';
  if (!status || Number(status.status) !== 200) {
    const reason = status?.status ? `GitHub answered HTTP ${status.status}` : 'GitHub did not answer';
    return `Coding run ${sessionId}: ${reason}, so I could not read its record. Its state, run and result are UNVERIFIED.`;
  }
  const lines = [`Latest coding run: ${sessionId}.`];
  const asked = String(request || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (asked) lines.push(`Request: ${asked}.`);
  lines.push(`State: ${String(status.state || 'unknown').replace(/_/g, ' ')}.`);
  const failure = [status.failure, status.error].filter(Boolean).join(' - ');
  if (failure) lines.push(`Failure: ${failure}`);
  const runId = Number(status.run_id) || 0;
  lines.push(runId ? `GitHub run: https://github.com/${repo || DEFAULT_REPO}/actions/runs/${runId}` : 'GitHub run: not recorded.');
  const tried = listed(status.models_tried);
  if (tried.length) lines.push(`Models tried: ${tried.join(', ')}.`);
  else if (status.model) lines.push(`Model: ${String(status.model)}.`);
  else lines.push('Models tried: not recorded.');
  lines.push(Number.isInteger(status.changed_files) ? `Files changed: ${status.changed_files}.` : 'Files changed: not recorded.');
  lines.push(Number.isInteger(status.pr_number) && status.pr_number > 0 ? `Pull request: #${status.pr_number}.` : 'Pull request: none recorded.');
  lines.push(testLine(String(status.state || '')));
  if (status.liveness === 'unverified' || status.heartbeat === 'stale') lines.push('Live state: UNVERIFIED, GitHub could not confirm the run.');
  return lines.join(' ');
}
