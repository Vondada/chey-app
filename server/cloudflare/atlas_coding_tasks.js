// Atlas's Office desk shows CHE's real coding jobs (Big J World slice, 2026-10-27).
//
// Atlas is the Engineering / Codex jobs head (office_company.js). A self-development coding job lives in
// data.jobs; this module gives Atlas one linked Office task per job (source 'coding_job', job_id = job.id)
// and mirrors the job's real state into it. The task is a read-only mirror: the Office runner never runs it
// (agent_runtime.js skips source 'coding_job'), and it is marked complete only when the job's PR is merged,
// which the merge job (CI must pass first) or the deploy check queued after a merge records. Nothing here
// invents a state: a job that was trimmed from history leaves its task as it was last seen.
import { queueAgentTask } from './agent_runtime.js';

export const CODING_JOB_SOURCE = 'coding_job';
const LINKABLE = new Set(['queued', 'running']);
// A complete mirror keeps refreshing its merge and deploy evidence (it never leaves complete); these never change.
const SETTLED = new Set(['failed', 'cancelled', 'rejected']);
const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const isCodingJobMirror = (task) => task?.source === CODING_JOB_SOURCE;

function atlasAgent(data) {
  return (data.team || []).find((a) => String(a?.name || '').toLowerCase() === 'atlas' && !a.retired) || null;
}

function jobRequest(job) {
  return clip(job.request || job.prompt || String(job.title || '').replace(/^Code:\s*/, ''), 3000);
}

// Merge evidence for PR #n from the real job records only.
function mergeEvidence(jobs, number) {
  const forPr = (kind) => jobs.find((j) => j?.kind === kind && Number(j.pr_number || 0) === number);
  const merge = forPr('merge_pr');
  const deploy = forPr('verify_deploy'); // queued only after a successful merge
  const sha = clip(deploy?.merge_commit_sha, 64)
    || (merge?.status === 'complete' ? (/Merged as ([0-9a-f]{7,64})/.exec(String(merge.result || ''))?.[1] || '') : '');
  return { merge, deploy, sha };
}

// The task fields the job's state supports right now.
export function codingJobTaskState(job, jobs = []) {
  const status = String(job?.status || '');
  const pr = Number(job?.pr_number || 0) || 0;
  const base = { job_status: status, pr_number: pr || null, pr_url: clip(job?.pr_url, 300) };
  if (status === 'queued') {
    return { ...base, status: 'queued', progress_note: Number(job.retry_count || 0) > 0 ? 'Waiting to retry after a temporary problem.' : 'Queued; not started yet.' };
  }
  if (status === 'running') return { ...base, status: 'running', progress_note: 'Coding job is running.' };
  if (status === 'cancelled') return { ...base, status: 'cancelled', progress_note: 'Coding job was cancelled.' };
  if (status === 'failed') {
    return { ...base, status: 'failed', error: clip(job.owner_message || job.error || 'Coding job failed.', 600), progress_note: 'Coding job failed.' };
  }
  if (status !== 'complete') return null;
  if (!pr) {
    // Built and reviewed (or found already satisfied) but no PR merged: not verified complete.
    return { ...base, status: 'needs_review', result: clip(job.owner_message || job.result, 2000), progress_note: 'Built and reviewed; no pull request is merged yet.' };
  }
  const { merge, deploy, sha } = mergeEvidence(jobs, pr);
  if (sha) {
    const deployNote = deploy?.status === 'complete' ? ' Deploy verified.' : deploy?.status === 'failed' ? ' Deploy failed; production keeps the previous version.' : deploy ? ' Deploy check running.' : '';
    return { ...base, status: 'complete', merge_commit_sha: sha, result: `PR #${pr} merged as ${sha.slice(0, 7)}.${deployNote}`, progress_note: `PR #${pr} merged.${deployNote}` };
  }
  if (merge?.status === 'failed') {
    return { ...base, status: 'failed', error: clip(merge.owner_message || merge.error || `PR #${pr} was not merged.`, 600), progress_note: `PR #${pr} was not merged.` };
  }
  return { ...base, status: 'needs_review', result: clip(job.owner_message || job.result, 2000), progress_note: merge ? `PR #${pr} is open; waiting for CI before merging.` : `PR #${pr} is open; waiting for CI and the owner's merge.` };
}

// Links new coding jobs to Atlas and mirrors every linked job. Returns true when anything changed.
export function syncAtlasCodingTasks(data, at = new Date().toISOString()) {
  if (!data || !Array.isArray(data.jobs)) return false;
  data.team_tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
  let changed = false;
  const atlas = atlasAgent(data);
  if (atlas) {
    const linked = new Set(data.team_tasks.filter(isCodingJobMirror).map((t) => t.job_id));
    // Oldest first so the newest job ends up first in the Office list.
    for (const job of [...data.jobs].reverse()) {
      if (job?.kind !== 'self_development' || !LINKABLE.has(job.status) || linked.has(job.id)) continue;
      const request = jobRequest(job);
      const task = queueAgentTask(data, atlas, `Coding job: ${request}`, CODING_JOB_SOURCE, { job_id: job.id, kind: CODING_JOB_SOURCE });
      task.title = clip(request, 120) || 'Coding job';
      linked.add(job.id);
      changed = true;
    }
  }
  const touched = new Set();
  for (const task of data.team_tasks) {
    if (!isCodingJobMirror(task) || SETTLED.has(task.status)) continue;
    const job = data.jobs.find((j) => j?.id === task.job_id);
    const next = job && codingJobTaskState(job, data.jobs);
    if (!next) continue;
    // Complete means merged; later evidence (the deploy check) updates the result but never undoes the merge.
    if (task.status === 'complete' && next.status !== 'complete') continue;
    const before = JSON.stringify([task.status, task.result, task.error, task.progress_note, task.pr_number, task.pr_url, task.merge_commit_sha]);
    task.status = next.status;
    task.job_status = next.job_status;
    task.progress_note = next.progress_note;
    task.pr_number = next.pr_number;
    task.pr_url = next.pr_url || task.pr_url || '';
    if (next.merge_commit_sha) task.merge_commit_sha = next.merge_commit_sha;
    task.result = next.result ?? '';
    task.error = next.error ?? '';
    if (JSON.stringify([task.status, task.result, task.error, task.progress_note, task.pr_number, task.pr_url, task.merge_commit_sha]) !== before) {
      task.updated_at = at;
      touched.add(task.partner_id);
      changed = true;
    }
  }
  // Atlas's desk shows what he really holds: building while a coding job runs, idle once nothing is open.
  for (const agentId of touched) {
    const agent = (data.team || []).find((a) => a.id === agentId);
    if (!agent) continue;
    const mine = data.team_tasks.filter((t) => t.partner_id === agentId);
    // The Office runner owns the desk while it runs one of Atlas's own tasks.
    if (mine.some((t) => !isCodingJobMirror(t) && ['running', 'reviewing'].includes(t.status))) continue;
    const running = mine.find((t) => isCodingJobMirror(t) && t.status === 'running');
    const open = mine.find((t) => ['queued', 'running', 'reviewing', 'review_pending'].includes(t.status));
    agent.runtime_status = running ? 'building' : open ? 'waiting' : 'idle';
    agent.runtime_task = running ? clip(running.title || running.task, 80) : open ? clip(open.title || open.task, 80) : null;
    agent.runtime_updated_at = at;
    if (!open) agent.status = 'available';
  }
  return changed;
}
