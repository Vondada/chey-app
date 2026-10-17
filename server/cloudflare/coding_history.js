// Owner-facing receipt for CHE's latest coding run. It is built only from the stored
// runtime record (the result file the runner publishes), and every field the record does
// not hold is named as not recorded. Nothing here starts a job or reads repository files.
const REPO = 'Vondada/chey-app';

function listed(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

export function codingHistoryReceipt({ sessionId = '', status = null, request = '' } = {}) {
  if (!sessionId) return 'No coding run is recorded for CHE yet, sir. Nothing is running.';
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
  lines.push(runId ? `GitHub run: https://github.com/${REPO}/actions/runs/${runId}` : 'GitHub run: not recorded.');
  const tried = listed(status.models_tried);
  if (tried.length) lines.push(`Models tried: ${tried.join(', ')}.`);
  else if (status.model) lines.push(`Model: ${String(status.model)}.`);
  else lines.push('Models tried: not recorded.');
  const changed = Number(status.changed_files);
  lines.push(Number.isFinite(changed) && status.changed_files !== undefined ? `Files changed: ${changed}.` : 'Files changed: not recorded.');
  lines.push(status.pr_number ? `Pull request: #${Number(status.pr_number)}.` : 'Pull request: none recorded.');
  lines.push('Tests: not recorded in the runtime record, so none are claimed.');
  if (status.liveness === 'unverified' || status.heartbeat === 'stale') lines.push('Live state: UNVERIFIED, GitHub could not confirm the run.');
  return lines.join(' ');
}
