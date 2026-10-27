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
  assert.equal((worker.match(/syncAtlasCodingTasks\(/g) || []).length, 4, 'queued, swept, started and finished hooks');
});

// ---- PR #678 review fixes
import { unlinkSync, writeFileSync } from 'node:fs';
import { CODING_JOB_MIRROR_ERROR, cancelAgentTasks, handoffAgentTask, processAgentWork, queueAgentTask, requeueAgentReview, steerAgentTask } from './agent_runtime.js';

const generated = new URL('./.atlas_coding_tasks.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let workerMod;
try { workerMod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: workerEntry, CheState, MAX_JOB_ATTEMPTS } = workerMod;
function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}
async function paired(saved) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => workerEntry.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return (path, body, method) => send(path, body, token, method);
}
const replyText = async (res) => (await res.text()).split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } })
  .map((event) => (event.type === 'delta' ? event.delta || '' : '')).join('');

// Finding 1: stopping or cancelling never reports a coding job stopped while it keeps running.
test('the Office never cancels a coding-job mirror: stop keeps it and says so, the cancel route refuses', async () => {
  const data = office([codingJob({ status: 'running' })]);
  syncAtlasCodingTasks(data);
  const other = queueAgentTask(data, data.team[0], 'Draft a README', 'owner');
  const { cancelled, kept } = cancelAgentTasks(data, 'atlas');
  assert.deepEqual(cancelled.map((t) => t.id), [other.id]);
  assert.equal(kept.length, 1);
  assert.equal(mirror(data).status, 'running');

  const saved = new Map();
  const send = await paired(saved);
  const che = saved.get('che');
  Object.assign(che, { team: [atlas()], jobs: [codingJob({ status: 'running', updated_at: new Date().toISOString() })], team_tasks: [] });
  syncAtlasCodingTasks(che);
  saved.set('che', che);
  const res = await send(`/api/office/tasks/${mirror(che).id}`, { action: 'cancel' }, 'PATCH');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).detail, CODING_JOB_MIRROR_ERROR);
  assert.equal(mirror(saved.get('che')).status, 'running');
  const reply = await replyText(await send('/api/chat', { message: "stop Atlas's task" }));
  assert.doesNotMatch(reply, /^Stopped/);
  assert.match(reply, /Nothing was stopped, sir\. I did not stop the CHE coding job on Atlas's desk/);
  assert.equal(mirror(saved.get('che')).status, 'running');
  assert.equal(saved.get('che').jobs[0].status, 'running');
});

// Finding 2: a coding job the stale sweep fails reaches Atlas's desk even when processJobs returns early.
for (const autonomy of [true, false]) {
  test(`a swept coding job updates its mirror before processJobs returns early (autonomy ${autonomy ? 'on' : 'paused'})`, async () => {
    const saved = new Map();
    let aiCalls = 0;
    const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'x' }; } } });
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const data = { autonomy, devices: {}, memories: [], team: [atlas()], team_tasks: [],
      jobs: [codingJob({ status: 'running', attempts: MAX_JOB_ATTEMPTS, updated_at: stale, created_at: stale })] };
    syncAtlasCodingTasks(data);
    assert.equal(mirror(data).status, 'running');
    saved.set('che', data);
    await state.processJobs();
    const after = saved.get('che');
    assert.equal(after.jobs[0].status, 'failed');
    assert.equal(mirror(after).status, 'failed');
    assert.equal(aiCalls, 0);
  });
}

// Finding 3: a merged mirror keeps refreshing its deploy evidence and never leaves complete.
test('a complete mirror shows the later deploy result and never regresses', () => {
  const data = office([codingJob({ status: 'running', pr_number: 12 }),
    { id: 'm', kind: 'merge_pr', pr_number: 12, status: 'complete', result: 'Merged as 1234567abcdef.' }]);
  syncAtlasCodingTasks(data);
  data.jobs[0].status = 'complete';
  data.jobs.unshift({ id: 'd', kind: 'verify_deploy', pr_number: 12, merge_commit_sha: '1234567abcdef', status: 'queued' });
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'complete');
  assert.match(mirror(data).result, /Deploy check running/);
  data.jobs[0].status = 'complete';
  assert.equal(syncAtlasCodingTasks(data), true);
  assert.match(mirror(data).result, /Deploy verified/);
  data.jobs[0].status = 'failed';
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'complete');
  assert.match(mirror(data).result, /Deploy failed/);
  // Merge evidence trimmed from history: the task stays complete as last seen.
  data.jobs = [data.jobs.find((j) => j.kind === 'self_development')];
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'complete');
  assert.match(mirror(data).result, /Deploy failed/);
});

// Finding 4: no Office review, steer or handoff path can complete or move a mirror.
test('a needs_review mirror cannot be re-reviewed, steered, handed off or approved by the Office review', async () => {
  let data = office([codingJob({ status: 'running', pr_number: 33 })]);
  Object.assign(data, { autonomy: true, meetings: [] });
  syncAtlasCodingTasks(data);
  Object.assign(data.jobs[0], { status: 'complete', owner_message: 'PR #33 opened.' });
  syncAtlasCodingTasks(data);
  const task = mirror(data);
  assert.equal(task.status, 'needs_review');
  assert.equal(requeueAgentReview(data, task.id).error, CODING_JOB_MIRROR_ERROR);
  assert.equal(steerAgentTask(data, task.id, 'merge it now').error, CODING_JOB_MIRROR_ERROR);
  data.team.push({ id: 'k', name: 'Knox' });
  assert.equal(handoffAgentTask(data, task.id, 'k').error, CODING_JOB_MIRROR_ERROR);
  assert.equal(task.status, 'needs_review');
  // Even a mirror forced into review_pending is never picked up and approved by a model.
  task.status = 'review_pending';
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('model must not be called'); };
  try {
    await processAgentWork({ env: { AI: { run: async () => { calls++; return { response: 'APPROVED' }; } } }, load: async () => data, save: async (v) => { data = v; }, notify: () => {}, models: { fast: 'f', strong: 's' } }, 3);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 0);
  assert.equal(mirror(data).status, 'review_pending');
  syncAtlasCodingTasks(data);
  assert.equal(mirror(data).status, 'needs_review', 'the job state, not a review, decides the mirror');
});
