import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateUpdateFiles } from './self_update.js';
import { CheCodingRuntime, codingRuntimeEnabled, ownerRequiresMergeApproval, recoverableRuntimeFailure, runtimeSessionId, runtimeState, runtimeStateClass, speakRuntimeStatus, validateRuntimeRequest } from './coding_runtime.js';

function response(status, data = null) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const env = {
  CHE_CODING_RUNTIME: 'opencode',
  CHE_GITHUB_REPO: 'Vondada/chey-app',
  [['CHE', 'GITHUB', 'TOKEN'].join('_')]: 'test-token',
  CHE_OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
};

test('owner merge holds cannot dispatch the runtime auto-merge workflow through any caller', async () => {
  for (const hold of ['Do not merge without my authorization.', "Don't deploy yet.", 'Never automatically merge.', 'Merge only after my approval.', 'Only merge after I approve.', 'Ask me before merging.', 'Ask for my approval before you merge it.', 'Merge it after I approve it.', 'I will deploy it myself.', 'No deployment until my approval.', 'Wait for me to approve before merging.', 'Stop before merging.', 'Leave the PR unmerged.', 'Prepare a PR-only change.', 'Prepare a draft PR.', 'Prepare a PR but no merge.', 'Open a PR and leave merging to me.', 'I will merge it.', 'Merge only when I say so.', "Implement the fix, but don't auto-merge it.", 'Do not auto merge it.', "I'll merge it myself."]) {
    assert.equal(ownerRequiresMergeApproval(hold), true, hold);
    let dispatched = false;
    const runtime = new CheCodingRuntime(env, { fetcher: async () => { dispatched = true; return response(204); } });
    const out = await runtime.createSession({ ownerRequest: `Fix a real low-risk defect. ${hold}`, baseSha: 'a'.repeat(40), targetBranch: 'che/auto/test' });
    assert.equal(out.status, 409);
    assert.equal(dispatched, false);
  }
  assert.equal(ownerRequiresMergeApproval('Implement a merger for records.'), false);
});

test('runtime is feature flagged off by default', async () => {
  assert.equal(codingRuntimeEnabled({}), false);
  let called = false;
  const runtime = new CheCodingRuntime({}, { fetcher: async () => { called = true; return response(500); } });
  const out = await runtime.createSession({ ownerRequest: 'Fix the voice bug safely.', baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', targetBranch: 'che/test' });
  assert.equal(out.disabled, true);
  assert.equal(called, false);
});

test('explicit merge authorization survives PR preparation wording; a simultaneous prohibition still wins', async () => {
  for (const request of ['Open a PR and merge it after tests pass.', 'Prepare a PR. Merge it after tests pass.', 'Create a pull request, then ship it after CI.']) {
    assert.equal(ownerRequiresMergeApproval(request), false, request);
    let dispatched = false;
    const runtime = new CheCodingRuntime(env, { fetcher: async () => { dispatched = true; return response(204); } });
    const out = await runtime.createSession({ ownerRequest: request, baseSha: 'a'.repeat(40), targetBranch: 'che/auto/test' });
    assert.equal(out.status, 202);
    assert.equal(dispatched, true);
  }
  assert.equal(ownerRequiresMergeApproval('Open a PR and merge it after tests pass, but do not merge without my authorization.'), true);
});

test('request validation refuses secrets before dispatch', () => {
  const syntheticCredential = ['ghp', '1234567890'.repeat(3)].join('_');
  assert.match(validateRuntimeRequest(`use ${syntheticCredential} now`).error, /secret/i);
  assert.match(validateUpdateFiles([{ path: 'server/cloudflare/example.js', content: `const token = '${syntheticCredential}';` }]).error, /secret/i);
});

test('the runtime regression file remains editable through CHE secret validation', () => {
  const content = readFileSync(new URL('./coding_runtime.test.mjs', import.meta.url), 'utf8');
  const result = validateUpdateFiles([{ path: 'server/cloudflare/coding_runtime.test.mjs', content }]);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.files.length, 1);
});

test('session ids are stable for the same coding job', () => {
  const input = { repo: 'Vondada/chey-app', baseSha: 'abcdef1', targetBranch: 'che/test', ownerRequest: 'Fix the voice bug', jobId: 'job-1', model: 'openrouter/openai/gpt-oss-20b:free' };
  assert.equal(runtimeSessionId(input), runtimeSessionId(input));
  assert.notEqual(runtimeSessionId(input), runtimeSessionId({ ...input, model: 'groq/openai/gpt-oss-20b' }));
});

test('OpenCode mutation runtime rejects EXPLORE and PLAN before any workflow dispatch', async () => {
  for (const executionMode of ['EXPLORE', 'PLAN']) {
    let called = false;
    const runtime = new CheCodingRuntime(env, { fetcher: async () => { called = true; return response(204); } });
    const out = await runtime.createSession({
      executionMode,
      jobId: 'job-readonly',
      ownerRequest: 'Inspect the routing and explain what is wrong.',
      baseSha: 'b'.repeat(40),
      targetBranch: 'che/auto/read-only',
    });
    assert.equal(out.status, 403, executionMode);
    assert.equal(out.denied, true, executionMode);
    assert.equal(called, false, executionMode);
  }
});

test('createSession dispatches the pinned workflow with compact inputs', async () => {
  let request;
  const runtime = new CheCodingRuntime(env, { fetcher: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return response(204);
  } });
  const out = await runtime.createSession({ jobId: 'job-1', ownerRequest: 'Fix the voice bug in the current app.', baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', targetBranch: 'claude/che-coding-runtime' });
  assert.equal(out.status, 202);
  assert.equal(out.job_id, 'job-1');
  assert.equal(out.state, 'queued');
  assert.match(out.accepted_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(request.url, /actions\/workflows\/che-opencode-runtime\.yml\/dispatches$/);
  assert.equal(request.body.inputs.job_id, out.session_id);
  assert.equal(request.body.inputs.base_sha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(request.body.inputs.target_branch, 'claude/che-coding-runtime');
  assert.equal(request.body.inputs.model, env.CHE_OPENCODE_MODEL);
  assert.equal(Buffer.from(request.body.inputs.request_b64, 'base64').toString('utf8'), 'Fix the voice bug in the current app.');
});

test('getStatus treats no result as queued and validates finished JSON', async () => {
  let missing = true;
  const id = 'ocr-1234abcd';
  const runtime = new CheCodingRuntime(env, { fetcher: async () => {
    if (missing) return response(404, { message: 'Not Found' });
    const value = Buffer.from(JSON.stringify({ session_id: id, state: 'done', changed_files: 2 })).toString('base64');
    return response(200, { content: value });
  } });
  assert.equal((await runtime.getStatus(id)).state, 'queued');
  missing = false;
  const done = await runtime.getStatus(id);
  assert.equal(done.state, 'done');
  assert.equal(done.changed_files, 2);
});

test('missing or silent runtime records become failed after the bounded stale window', async () => {
  const id = 'ocr-1234abcd';
  const old = new Date(Date.now() - 36 * 60_000).toISOString();
  const missing = new CheCodingRuntime(env, { fetcher: async () => response(404, { message: 'Not Found' }) });
  const dispatch = await missing.getStatus(id, { acceptedAt: old });
  assert.equal(dispatch.state, 'failed');
  assert.equal(dispatch.failure, 'dispatch_stale');
  assert.equal(recoverableRuntimeFailure(dispatch), true);
  assert.doesNotMatch(speakRuntimeStatus(dispatch), /is running/i);

  const content = Buffer.from(JSON.stringify({ session_id: id, state: 'running', claimed_at: old })).toString('base64');
  const silent = new CheCodingRuntime(env, { fetcher: async () => response(200, { content }) });
  const running = await silent.getStatus(id);
  assert.equal(running.state, 'failed');
  assert.equal(running.failure, 'runtime_stale');
  assert.equal(recoverableRuntimeFailure(running), true);
  assert.doesNotMatch(speakRuntimeStatus(running), /is running/i);
});

test('a silent session whose workflow run is still live is never declared failed', async () => {
  const id = 'ocr-1234abcd';
  const old = new Date(Date.now() - 36 * 60_000).toISOString();

  // No claim file, but an uncompleted dispatch run created after acceptance:
  // the runner simply has not claimed it yet (e.g. queued concurrency).
  const dispatching = new CheCodingRuntime(env, { fetcher: async (url) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/runtime/')) return response(404, { message: 'Not Found' });
    if (u.includes('/actions/workflows/')) return response(200, { workflow_runs: [{ status: 'in_progress', created_at: new Date(Date.now() - 35 * 60_000).toISOString() }] });
    return response(404, { message: 'Not Found' });
  } });
  const dispatch = await dispatching.getStatus(id, { acceptedAt: old });
  assert.equal(dispatch.state, 'dispatching', 'a live dispatch is reported as still dispatching, never dead');
  assert.equal(recoverableRuntimeFailure(dispatch), false, 'a live run is never recovery material');

  // Old heartbeat, but the claimed run itself is still in progress.
  const content = Buffer.from(JSON.stringify({ session_id: id, state: 'running', claimed_at: old, run_id: 77 })).toString('base64');
  const liveRun = new CheCodingRuntime(env, { fetcher: async (url) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/runtime/')) return response(200, { content });
    if (u.includes('/actions/runs/77')) return response(200, { status: 'in_progress' });
    return response(404, { message: 'Not Found' });
  } });
  const running = await liveRun.getStatus(id, { acceptedAt: old });
  assert.equal(running.state, 'running', 'GitHub confirms the run is in progress');
  assert.equal(recoverableRuntimeFailure(running), false);

  // The same silent record after its run completed is genuinely stale.
  const finishedRun = new CheCodingRuntime(env, { fetcher: async (url) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/runtime/')) return response(200, { content });
    if (u.includes('/actions/runs/77')) return response(200, { status: 'completed' });
    return response(404, { message: 'Not Found' });
  } });
  const stale = await finishedRun.getStatus(id, { acceptedAt: old });
  assert.equal(stale.state, 'failed');
  assert.equal(stale.failure, 'runtime_stale');
  assert.equal(recoverableRuntimeFailure(stale), true);
});

test('getStatus normalizes a completed result that still reports running', async () => {
  const id = 'ocr-deadbeef';
  const value = Buffer.from(JSON.stringify({ session_id: id, status: 'complete', state: 'running', changed_files: 1 })).toString('base64');
  const runtime = new CheCodingRuntime(env, { fetcher: async () => response(200, { content: value }) });
  const out = await runtime.getStatus(id);
  assert.equal(out.status, 'complete');
  assert.equal(out.state, 'complete');
  assert.equal(runtimeStateClass(out), 'complete');
  assert.doesNotMatch(speakRuntimeStatus(out), /running|stopped/i);
});


test('getStatus turns a running result that reports failed into failed', async () => {
  const id = 'ocr-facefeed';
  const value = Buffer.from(JSON.stringify({ session_id: id, status: 'failed', state: 'running', progress: 40 })).toString('base64');
  const runtime = new CheCodingRuntime(env, { fetcher: async () => response(200, { content: value }) });
  const out = await runtime.getStatus(id);
  assert.equal(out.state, 'failed');
  assert.notEqual(runtimeStateClass(out), 'complete');
});

test('running at numeric progress 100 uses canonical complete; partial and malformed progress stay active', async () => {
  const id = 'ocr-deadbeef';
  for (const [progress, state] of [[100, 'complete'], [110, 'complete'], [99, 'running'], ['100', 'running'], [null, 'running']]) {
    const value = Buffer.from(JSON.stringify({ session_id: id, state: 'running', progress })).toString('base64');
    const runtime = new CheCodingRuntime(env, { fetcher: async () => response(200, { content: value }) });
    const out = await runtime.getStatus(id);
    assert.equal(out.state, state);
    assert.equal(runtimeStateClass(out), state === 'complete' ? 'complete' : 'active');
  }
});

test('runtime lifecycle normalizes legacy blocked failures and never calls active work stopped', () => {
  assert.equal(runtimeState({ state: 'blocked', failure: 'opencode_failed' }), 'opencode_failed');
  assert.equal(runtimeStateClass({ state: 'blocked', failure: 'opencode_failed' }), 'failed');
  assert.equal(recoverableRuntimeFailure({ state: 'blocked', failure: 'opencode_failed' }), true);
  for (const state of ['queued', 'dispatching', 'running', 'retrying', 'recovering']) {
    const spoken = speakRuntimeStatus({ state });
    assert.doesNotMatch(spoken, /stopped/i, `${state} must remain active`);
    assert.equal(runtimeStateClass({ state }), 'active');
  }
  assert.match(speakRuntimeStatus({ state: 'running' }), /running/i);
  assert.match(speakRuntimeStatus({ state: 'mystery_state' }), /status is mystery state/i);
  assert.doesNotMatch(speakRuntimeStatus({ state: 'mystery_state' }), /stopped/i);
});

test('unsafe runtime blockers are not automatically retried as coding failures', () => {
  assert.equal(recoverableRuntimeFailure({ state: 'blocked', failure: 'unsafe_files' }), false);
  assert.equal(recoverableRuntimeFailure({ state: 'blocked', failure: 'invalid_base_sha' }), false);
});
