import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codingJobTaskState, isCodingJobMirror, syncAtlasCodingTasks } from './atlas_coding_tasks.js';
import { recoverStaleWork } from './agent_runtime.js';

const atlas = () => ({ id: 'a-atlas', name: 'Atlas', role: 'Engineering / Codex jobs', status: 'available' });
const codingJob = (over = {}) => ({ id: 'job-1', kind: 'self_development', title: 'Code: add dark mode', request: 'Add dark mode to Settings', prompt: 'Add dark mode to Settings', status: 'queued', retry_count: 0, created_at: '2026-10-27T10:00:00Z', updated_at: '2026-10-27T10:00:00Z', ...over });
const office = (jobs, team = [atlas()]) => ({ team, team_tasks: [], jobs });
const mirror = (data) => data.team_tasks.find(isCodingJobMirror);

test('a queued coding job gives Atlas one linked Office task', () => {
  const data = office([codingJob()]);
  assert.equal(syncAtlasCodingTasks(data), true);
  const task = mirror(data);
  assert.equal(task.partner_name, 'Atlas');
  assert.equal(task.job_id, 'job-1');
  assert.equal(task.source, 'coding_job');
  assert.equal(task.title, 'Add dark mode to Settings');
  assert.equal(task.status, 'queued');
  // Linking twice never duplicates.
  syncAtlasCodingTasks(data);
  assert.equal(data.team_tasks.filter(isCodingJobMirror).length, 1);
});

test('no Atlas in the Office means no linked task, and other job kinds are never linked', () => {
  const none = office([codingJob()], [{ id: 'k', name: 'Knox' }]);
  assert.equal(syncAtlasCodingTasks(none), false);
  assert.equal(none.team_tasks.length, 0);
  const retired = office([codingJob()], [{ ...atlas(), retired: true }]);
  syncAtlasCodingTasks(retired);
  assert.equal(retired.team_tasks.length, 0);
  const other = office([codingJob({ kind: 'chat' }), codingJob({ id: 'old', status: 'complete' })]);
  syncAtlasCodingTasks(other);
  assert.equal(other.team_tasks.length, 0, 'chat jobs and already-finished history are not backfilled');
});

test('running and failed states mirror the job exactly', () => {
  const data = office([codingJob()]);
  syncAtlasCodingTasks(data);
  data.jobs[0].status = 'running';
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'running');
  assert.equal(data.team[0].runtime_status, 'building');
  data.jobs[0].status = 'failed';
  data.jobs[0].owner_message = 'The tests failed, sir.';
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'failed');
  assert.equal(mirror(data).error, 'The tests failed, sir.');
  assert.equal(data.team[0].runtime_status, 'idle');
  // A settled task is never rewritten afterwards.
  data.jobs[0].status = 'complete';
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'failed');
});

test('a finished job with an open PR is not complete; only a merge makes it complete', () => {
  const data = office([codingJob({ status: 'running' })]);
  syncAtlasCodingTasks(data);
  Object.assign(data.jobs[0], { status: 'complete', pr_number: 701, pr_url: 'https://github.com/o/r/pull/701', owner_message: 'PR opened.' });
  syncAtlasCodingTasks(data);
  let task = mirror(data);
  assert.equal(task.status, 'needs_review');
  assert.equal(task.pr_number, 701);
  assert.equal(task.pr_url, 'https://github.com/o/r/pull/701');
  assert.match(task.progress_note, /open; waiting for CI and the owner's merge/);
  // The merge job is waiting on CI: still not complete.
  data.jobs.unshift({ id: 'm', kind: 'merge_pr', pr_number: 701, status: 'queued', result: '' });
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'needs_review');
  // CI passed and GitHub merged it.
  Object.assign(data.jobs[0], { status: 'complete', result: 'Merged as abcdef1234567.' });
  syncAtlasCodingTasks(data);
  task = mirror(data);
  assert.equal(task.status, 'complete');
  assert.equal(task.merge_commit_sha, 'abcdef1234567');
  assert.match(task.result, /PR #701 merged as abcdef1/);
});

test('the deploy check queued after a merge is merge evidence; a refused merge is a failure', () => {
  const jobs = [{ id: 'd', kind: 'verify_deploy', pr_number: 9, merge_commit_sha: 'f'.repeat(40), status: 'complete' }];
  const merged = codingJobTaskState(codingJob({ status: 'complete', pr_number: 9 }), jobs);
  assert.equal(merged.status, 'complete');
  assert.match(merged.result, /Deploy verified/);
  const refused = codingJobTaskState(codingJob({ status: 'complete', pr_number: 9 }), [{ kind: 'merge_pr', pr_number: 9, status: 'failed', error: 'Not merged: CI failed.' }]);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /CI failed/);
  // A merge job "complete" without a commit is not invented into a merge.
  const noSha = codingJobTaskState(codingJob({ status: 'complete', pr_number: 9 }), [{ kind: 'merge_pr', pr_number: 9, status: 'complete', result: '' }]);
  assert.notEqual(noSha.status, 'complete');
  // A built change with no PR stays unverified.
  assert.equal(codingJobTaskState(codingJob({ status: 'complete' }), []).status, 'needs_review');
});

test('a job missing from history leaves its task as last seen', () => {
  const data = office([codingJob({ status: 'running' })]);
  syncAtlasCodingTasks(data);
  data.jobs = [];
  assert.equal(syncAtlasCodingTasks(data), false);
  assert.equal(mirror(data).status, 'running');
});

test('the Office runner, stale recovery and wake times never treat a mirror as runnable work', () => {
  const data = office([codingJob({ status: 'running' })]);
  syncAtlasCodingTasks(data);
  mirror(data).updated_at = '2020-01-01T00:00:00Z';
  recoverStaleWork(data);
  assert.equal(mirror(data).status, 'running', 'stale recovery does not requeue a mirror for the Office to run');
  const runtime = readFileSync(new URL('./agent_runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, /item\.status === 'queued' && due\(item\) && item\.source !== 'coding_job'/);
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /const officeTasks = data\.team_tasks\.filter\(\(t\) => t\.source !== 'coding_job'\)/);
  assert.equal((worker.match(/syncAtlasCodingTasks\(/g) || []).length, 3, 'queued, started and finished hooks');
});
