import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateUpdateFiles } from './self_update.js';
import { CheCodingRuntime, RUNTIME_RUN_TITLE_PREFIX, codingRuntimeEnabled, ownerRequiresMergeApproval, recoverableRuntimeFailure, runtimeSessionId, runtimeState, runtimeStateClass, speakRuntimeStatus, validateRuntimeRequest } from './coding_runtime.js';

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

test('a GitHub error during the liveness check never declares a silent run failed', async () => {
  const id = 'ocr-1234abcd';
  const old = new Date(Date.now() - 36 * 60_000).toISOString();
  const actionsCalls = [];
  const flaky = (record) => async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/runtime/')) return record ? response(200, { content: record }) : response(404, { message: 'Not Found' });
    if (u.includes('/actions/')) {
      actionsCalls.push({ url: u, headers: init.headers || {} });
      return response(503, { message: 'Service Unavailable' });
    }
    return response(404, { message: 'Not Found' });
  };

  // No execution record and GitHub cannot list runs: unverified, not dead.
  const dispatch = await new CheCodingRuntime(env, { fetcher: flaky(null) }).getStatus(id, { acceptedAt: old });
  assert.equal(dispatch.state, 'queued');
  assert.equal(dispatch.liveness, 'unverified');
  assert.equal(dispatch.failure, undefined);
  assert.equal(recoverableRuntimeFailure(dispatch), false, 'an unverified run is never recovery material');
  assert.match(speakRuntimeStatus(dispatch), /could not confirm/i);
  assert.doesNotMatch(speakRuntimeStatus(dispatch), /currently running|queued on|stopped reporting|never started/i, 'neither running nor dead is claimed');

  // Old heartbeat on a claimed run and GitHub cannot read that run.
  const content = Buffer.from(JSON.stringify({ session_id: id, state: 'running', claimed_at: old, run_id: 77 })).toString('base64');
  const running = await new CheCodingRuntime(env, { fetcher: flaky(content) }).getStatus(id, { acceptedAt: old });
  assert.equal(running.state, 'running');
  assert.equal(running.liveness, 'unverified');
  assert.equal(recoverableRuntimeFailure(running), false);
  assert.doesNotMatch(speakRuntimeStatus(running), /currently running/i);

  // Every extra GitHub call identifies itself; GitHub refuses requests without a User-Agent.
  assert.ok(actionsCalls.length >= 2);
  assert.ok(actionsCalls.some((call) => call.url.includes('/actions/runs/77')));
  assert.ok(actionsCalls.some((call) => /\/actions\/workflows\/[^/]+\/runs/.test(call.url)));
  for (const call of actionsCalls) assert.ok(call.headers['User-Agent'], `User-Agent sent to ${call.url}`);

  // Past the bound no CHE run can still be working, so the stale rule applies again.
  const ancient = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
  const expired = await new CheCodingRuntime(env, { fetcher: flaky(null) }).getStatus(id, { acceptedAt: ancient });
  assert.equal(expired.state, 'failed');
  assert.equal(expired.failure, 'dispatch_stale');

  // A run id GitHub no longer knows is not live work.
  const gone = await new CheCodingRuntime(env, { fetcher: async (url) => (String(url).includes('/contents/mailbox/runtime/')
    ? response(200, { content })
    : response(404, { message: 'Not Found' })) }).getStatus(id, { acceptedAt: old });
  assert.equal(gone.state, 'failed');
  assert.equal(gone.failure, 'runtime_stale');
});

test('another session\'s queued run never keeps this silent session alive', async () => {
  const mine = 'ocr-1234abcd';
  const other = 'ocr-99990000';
  const accepted = Date.now() - 36 * 60_000;
  const old = new Date(accepted).toISOString();
  const at = (ms) => new Date(accepted + ms).toISOString();
  const runtime = (runs, seen = []) => new CheCodingRuntime(env, { fetcher: async (url) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/runtime/')) return response(404, { message: 'Not Found' });
    if (u.includes('/actions/workflows/')) { seen.push(u); return response(200, { workflow_runs: runs }); }
    return response(404, { message: 'Not Found' });
  } });

  // The workflow titles every run with its session id, through the dispatch input.
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  assert.match(workflow, new RegExp(`^run-name: ${RUNTIME_RUN_TITLE_PREFIX}\\$\\{\\{ inputs\\.job_id \\}\\}$`, 'm'));

  // Only the other session is queued; this session's own run already finished.
  const seen = [];
  const dead = await runtime([
    { status: 'queued', display_title: `${RUNTIME_RUN_TITLE_PREFIX}${other}`, created_at: at(30_000) },
    { status: 'completed', display_title: `${RUNTIME_RUN_TITLE_PREFIX}${mine}`, created_at: at(5_000) },
  ], seen).getStatus(mine, { acceptedAt: old });
  assert.equal(dead.state, 'failed', 'the other session\'s run proves nothing about this one');
  assert.equal(dead.failure, 'dispatch_stale');
  assert.equal(recoverableRuntimeFailure(dead), true);
  assert.match(seen[0], /created=%3E%3D/, 'the lookup is bounded to runs since this dispatch');

  // No run of this session at all, only another session's: still not alive.
  const absent = await runtime([{ status: 'in_progress', display_title: `${RUNTIME_RUN_TITLE_PREFIX}${other}`, created_at: at(10_000) }]).getStatus(mine, { acceptedAt: old });
  assert.equal(absent.state, 'failed');

  // This session's own titled run is live: dispatching, never failed.
  const live = await runtime([
    { status: 'completed', display_title: `${RUNTIME_RUN_TITLE_PREFIX}${other}`, created_at: at(30_000) },
    { status: 'queued', display_title: `${RUNTIME_RUN_TITLE_PREFIX}${mine}`, created_at: at(5_000) },
  ]).getStatus(mine, { acceptedAt: old });
  assert.equal(live.state, 'dispatching');
  assert.equal(recoverableRuntimeFailure(live), false);

  // A run from before the run-name change carries only the workflow name.
  // It counts only when GitHub created it right after this dispatch.
  const legacyTitle = 'CHE OpenCode coding runtime';
  const legacy = await runtime([{ status: 'queued', display_title: legacyTitle, created_at: at(20_000) }]).getStatus(mine, { acceptedAt: old });
  assert.equal(legacy.state, 'dispatching', 'a pre-change run created with this dispatch is its pending run');
  const lateLegacy = await runtime([{ status: 'queued', display_title: legacyTitle, created_at: at(20 * 60_000) }]).getStatus(mine, { acceptedAt: old });
  assert.equal(lateLegacy.state, 'failed', 'an unnamed run created long after this dispatch is someone else\'s');

  // A full page without this session's run cannot prove it dead.
  const crowded = Array.from({ length: 100 }, (_, i) => ({ status: 'completed', display_title: `${RUNTIME_RUN_TITLE_PREFIX}ocr-${String(i).padStart(8, '0')}`, created_at: at(60_000) }));
  const busy = await runtime(crowded).getStatus(mine, { acceptedAt: old });
  assert.equal(busy.liveness, 'unverified');
  assert.equal(recoverableRuntimeFailure(busy), false);
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

// ─── The OpenCode run step itself (che-opencode-runtime.yml), run with a fake opencode ───

function runStepScript(name) {
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  const at = workflow.indexOf(`- name: ${name}`);
  const run = workflow.indexOf('run: |', at);
  const lines = workflow.slice(run + 'run: |'.length).split('\n').slice(1);
  const out = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith('          ')) break;
    out.push(line.slice(10));
  }
  return out.join('\n');
}

test('a model that cannot do the request is stopped at its first fatal error, and the next model gets the time', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'che-opencode-'));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  spawnSync('mkdir', ['-p', bin, repo]);
  spawnSync('git', ['init', '-q', repo]);
  // Each fake model behaves like a real failure seen on 2026-10-17 (run 39009613493),
  // except that OpenCode then retries until killed; the good model edits a file.
  writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env bash
model=""; while [ $# -gt 0 ]; do [ "$1" = --model ] && model=$2; shift; done
echo "$model" >> "${dir}/tried"
case "$model" in
  google/quota) echo '{"type":"error","error":{"name":"APIError","data":{"message":"You exceeded your current quota, please check your plan"}}}';;
  groq/small) echo '{"type":"error","error":{"name":"ContextOverflowError","data":{"message":"Request too large for model on input tokens per minute (ITPM): Limit 7000, Requested 10182"}}}';;
  groq/reads) echo '{"type":"tool","part":{"output":"server/cloudflare/notes.md: a ContextOverflowError happened yesterday"}}'; echo ok > "${repo}/edited.txt"; exit 0;;
esac
sleep 60
`);
  chmodSync(join(bin, 'opencode'), 0o755);
  writeFileSync(join(dir, 'che-runtime-prompt.txt'), 'OWNER REQUEST: a tiny change');
  const output = join(dir, 'output');
  // The runner stages the gate and verifier from the base before any attempt; the step uses that copy.
  const trusted = join(dir, 'trusted');
  const { copyFileSync } = await import('node:fs');
  spawnSync('mkdir', ['-p', join(trusted, 'tools'), join(trusted, 'server/cloudflare')]);
  copyFileSync(new URL('../../tools/che_coding_checkpoint.mjs', import.meta.url), join(trusted, 'tools/che_coding_checkpoint.mjs'));
  copyFileSync(new URL('../../tools/che_coding_paid_gate.mjs', import.meta.url), join(trusted, 'tools/che_coding_paid_gate.mjs'));
  copyFileSync(new URL('./coding_failover.mjs', import.meta.url), join(trusted, 'server/cloudflare/coding_failover.mjs'));
  const started = Date.now();
  const res = spawnSync('bash', ['-c', runStepScript('Run OpenCode in the isolated checkout')], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, FREE_CANDIDATES: 'google/quota groq/small groq/reads', GITHUB_OUTPUT: output, HOME: dir, RUNNER_TEMP: dir, CHE_TRUSTED_TOOLS: trusted, BASE_SHA: 'a'.repeat(40) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(res.status, 0, res.stderr);
  assert.ok(seconds < 30, `the two failing models were stopped early (${seconds}s, not 2 x 300s)`);
  const out = readFileSync(output, 'utf8');
  assert.match(out, /exit_code=0/);
  assert.match(out, /model=groq\/reads/);
  assert.match(res.stdout, /google\/quota failed \(exit 75\): stopped after .*cannot do the request with this key/);
  assert.match(res.stdout, /groq\/small failed \(exit 75\)/);
  assert.equal(readFileSync(join(dir, 'tried'), 'utf8').trim().split('\n').join(' '), 'google/quota groq/small groq/reads');
  assert.equal(readFileSync(join(repo, 'edited.txt'), 'utf8').trim(), 'ok', 'file text mentioning an error never stops a working model');
});

test('every model attempt leaves its own receipt, so an earlier failure is not lost when a later model succeeds', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'che-opencode-'));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  spawnSync('mkdir', ['-p', bin, repo]);
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env bash
model=""; while [ $# -gt 0 ]; do [ "$1" = --model ] && model=$2; shift; done
case "$model" in
  google/quota) echo '{"type":"error","error":{"name":"APIError","data":{"message":"You exceeded your current quota, please check your plan"}}}';;
  groq/small) echo '{"type":"error","error":{"name":"ContextOverflowError","data":{"message":"Request too large for model on input tokens per minute (ITPM): Limit 7000, Requested 10182"}}}';;
  groq/reads) echo '{"type":"tool","part":{"output":"notes"}}'; echo ok > "${repo}/edited.txt"; exit 0;;
esac
sleep 60
`);
  chmodSync(join(bin, 'opencode'), 0o755);
  writeFileSync(join(dir, 'che-runtime-prompt.txt'), 'OWNER REQUEST: a tiny change');
  const trusted = join(dir, 'trusted');
  spawnSync('mkdir', ['-p', join(trusted, 'tools'), join(trusted, 'server/cloudflare')]);
  copyFileSync(new URL('../../tools/che_coding_checkpoint.mjs', import.meta.url), join(trusted, 'tools/che_coding_checkpoint.mjs'));
  copyFileSync(new URL('../../tools/che_coding_paid_gate.mjs', import.meta.url), join(trusted, 'tools/che_coding_paid_gate.mjs'));
  copyFileSync(new URL('./coding_failover.mjs', import.meta.url), join(trusted, 'server/cloudflare/coding_failover.mjs'));
  const res = spawnSync('bash', ['-c', runStepScript('Run OpenCode in the isolated checkout')], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, FREE_CANDIDATES: 'google/quota groq/small groq/reads', GITHUB_OUTPUT: join(dir, 'output'), HOME: dir, RUNNER_TEMP: dir, CHE_TRUSTED_TOOLS: trusted, BASE_SHA: 'a'.repeat(40) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, res.stderr);
  const receipts = readFileSync(join(dir, 'che-attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.map((r) => [r.model, r.kind, r.resumable, r.exit_code]), [
    ['google/quota', 'quota', true, 75],
    ['groq/small', 'too_large', false, 75],
    ['groq/reads', 'success', false, 0],
  ], 'the quota and size failures before the working model are kept, not overwritten by its success');
  assert.match(receipts[0].error, /exceeded your current quota/);
  assert.equal(receipts[2].progress, 'delivered', 'the successful attempt is recorded with its change');
  for (const receipt of receipts) {
    assert.ok(receipt.cap_seconds > 0 && receipt.cap_seconds <= 120, 'each attempt names the time it was allowed');
    assert.ok(receipt.seconds >= 0 && receipt.seconds < 60, 'each attempt names the time it took');
  }
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  assert.match(workflow, /const attemptsFile = `\$\{process\.env\.RUNNER_TEMP\}\/che-attempts\.jsonl`;/, 'the record reads every attempt');
  assert.match(workflow, /^\s+attempts,$/m, 'the job record carries the attempts');
});

test('a blocked coding session turns the run red after its record is posted, never a green wrapper', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  const post = publish.indexOf('- name: Post compact result to CHE mailbox branch');
  const fail = publish.indexOf('- name: Fail the run when the coding session was blocked');
  assert.ok(post > 0 && fail > post, 'the record is posted first');
  assert.match(publish, /core\.setOutput\('state', String\(result\.state \|\| ''\)\)/);
  assert.match(publish.slice(fail), /if: steps\.post\.outputs\.state == 'blocked' \|\| steps\.post\.outputs\.state == 'failed'[\s\S]*exit 1/);
  assert.doesNotMatch(publish.slice(fail, fail + 600), /\$\{\{ inputs\.[a-z_]+ \}\}[^\n]*\n[^\n]*echo/, 'inputs reach the shell only through env');
});

test('auto free-first choice uses stable Flash instead of Pro and never selects paid models without approval', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'che-models-'));
  // The Google list OpenCode showed on 2026-10-17, plus Groq's.
  writeFileSync(join(dir, 'opencode'), `#!/usr/bin/env bash
[ "$1" = models ] || exit 2
case "$2" in
  google) printf '%s\\n' google/gemini-2.5-pro google/gemini-3.1-pro-preview google/gemini-omni-flash-preview google/gemini-2.5-flash google/gemini-2.5-flash-lite google/gemini-2.0-flash;;
  groq) printf '%s\\n' groq/llama-3.3-70b-versatile groq/qwen/qwen3.8-27b;;
esac
`);
  chmodSync(join(dir, 'opencode'), 0o755);
  const output = join(dir, 'output');
  const res = spawnSync('bash', ['-c', runStepScript('Resolve model')], {
    env: { PATH: `${dir}:${process.env.PATH}`, REQUESTED: 'auto', HAS_GOOGLE: 'true', HAS_GROQ: 'true', CHE_CODING_FREE_PROVIDERS: 'google,groq', K_GOOGLE: 'x', K_GROQ: 'y', GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const candidates = readFileSync(output, 'utf8').match(/free_candidates=(.*)/)[1].trim().split(' ');
  assert.ok(candidates.includes('google/gemini-2.5-flash'), 'stable Flash remains usable when Pro has no quota');
  assert.ok(candidates.every((m) => !/pro|preview|lite/.test(m)), 'never choose Pro, preview or Lite as free coding engines');
  assert.ok(candidates.includes('groq/qwen/qwen3.8-27b'), 'other verified-free providers still follow');
  assert.match(readFileSync(output, 'utf8'), /paid_candidates=\n/);
  assert.ok(!candidates.some((m) => /lite/.test(m)));
});

test('the real ocr-8e7f69c5 record is spoken with its cause and the recovery that really happens', async () => {
  const { runtimeFailureCause } = await import('./coding_runtime.js');
  const record = {
    session_id: 'ocr-8e7f69c5', runtime: 'opencode', state: 'blocked', failure: 'opencode_failed', changed_files: 0, opencode_exit_code: 124,
    models_tried: ['google/gemini-2.5-pro', 'google/gemini-3.1-pro-preview', 'google/gemini-omni-flash-preview', 'groq/llama-3.3-70b-versatile', 'groq/qwen/qwen3.8-27b', 'google/gemini-2.5-flash'],
    error: '{ type : error , error :{ name : ContextOverflowError , data :{ message : Request too large for model `qwen/qwen3.8-27b` on input tokens per minute (ITPM): Limit 7000, Requested 10182',
  };
  assert.equal(runtimeFailureCause(record).kind, 'too_large');
  // Codex #327: recovery runs CHE's own coding team on other engines, which these OpenCode key limits do not bind.
  assert.equal(recoverableRuntimeFailure(record), true);
  const spoken = speakRuntimeStatus(record);
  assert.match(spoken, /failed with no files changed yet after trying 6 models \(google\/gemini-2\.5-pro, .*google\/gemini-2\.5-flash\); the last one failed because the request is larger than the token limit/);
  assert.match(spoken, /recovering the coding job automatically with my own coding team on other engines/);
  assert.match(spoken, /OpenCode itself needs a model key with enough quota and token limit/);
  for (const [error, kind] of [['You exceeded your current quota, please check your plan', 'quota'], ['The model `x` does not exist or you do not have access to it.', 'access'], ['socket hang up', 'unknown']]) {
    assert.equal(runtimeFailureCause({ error }).kind, kind, error);
  }
  assert.doesNotMatch(speakRuntimeStatus({ state: 'blocked', failure: 'opencode_failed', error: 'socket hang up' }), /needs a model key/);
});

test('Codex #327: the record keeps every model the run may try, so the last cause belongs to the last model listed', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  const freeLimit = Number(workflow.match(/head -(\d+) \| tr '\\n' ' '/)[1]);
  const limit = freeLimit + 2; // Qwen Coder and DeepSeek final fallbacks
  assert.equal(limit, 8);
  assert.match(workflow, new RegExp(`models_tried: String\\(process\\.env\\.TRIED \\|\\| ''\\)\\.trim\\(\\)\\.split\\(/\\\\s\\+/\\)\\.filter\\(Boolean\\)\\.slice\\(0, ${limit}\\)`));
  const spoken = speakRuntimeStatus({ state: 'blocked', failure: 'opencode_failed', models_tried: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'] });
  assert.match(spoken, /after trying 6 models \(a\/1, a\/2, a\/3, a\/4, a\/5, a\/6\)/);
});

// Every leak form the review found, plus the hardening forms. The paid step and the PR step used
// their own redaction before; each step's redact() is now run on every case.
const SHELL_LEAKS = [
  ['Authorization: Bearer abc.def.GhIjKlMnOpQr123456', 'GhIjKlMnOpQr123456'],
  ['bearer tokenValue987654321', 'tokenValue987654321'],
  ['https://api.example.com/v1/models?api_key=SUPERSECRET123456789&alt=json', 'SUPERSECRET123456789'],
  ['https://hooks.example.com/x?token=tok_live_987654321abcdef', 'tok_live_987654321abcdef'],
  ['{"access_token":"ya29.a0AfH6SMBx1234567890"}', 'ya29.a0AfH6SMBx1234567890'],
  ['xai-AbCdEf1234567890', 'AbCdEf1234567890'],
  ['password=hunter2hunter2', 'hunter2hunter2'],
  // Built at run time so this file never holds a GitHub-token-shaped string (CHE's edit check refuses one).
  [`token ${'gh'}p_abcdefghijklmnopqrstuvwxyz0123456789 rejected`, 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['x-api-key: AbCdEfGh12345678', 'AbCdEfGh12345678'],
  ['api-key: ZyXwVu98765432', 'ZyXwVu98765432'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ['client_secret=s3cr3tValue123456', 's3cr3tValue123456'],
];

test('every runner step that writes error text redacts each leak case through the shared redactor', async () => {
  const { mkdtempSync, copyFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'che-redact-'));
  const trusted = join(dir, 'trusted');
  mkdirSync(join(trusted, 'tools'), { recursive: true });
  mkdirSync(join(trusted, 'server/cloudflare'), { recursive: true });
  copyFileSync(new URL('../../tools/che_coding_checkpoint.mjs', import.meta.url), join(trusted, 'tools/che_coding_checkpoint.mjs'));
  copyFileSync(new URL('./coding_failover.mjs', import.meta.url), join(trusted, 'server/cloudflare/coding_failover.mjs'));
  const steps = ['Run OpenCode in the isolated checkout', 'Run capped paid OpenRouter only after free attempts', 'Commit, push and open PR'];
  for (const step of steps) {
    const redactLine = runStepScript(step).split('\n').find((line) => /^redact\(\) \{/.test(line));
    assert.ok(redactLine, `${step} defines redact()`);
    assert.match(redactLine, /che_coding_checkpoint\.mjs" redact \|/, `${step} uses the shared redactor`);
    for (const [input, secret] of SHELL_LEAKS) {
      // The free and paid steps use CHE_TRUSTED_TOOLS; the PR step stages its own copy as $trust.
      const res = spawnSync('bash', ['-c', `CHE_TRUSTED_TOOLS='${trusted}'; trust='${trusted}'\n${redactLine}\nredact`], {
        input,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.includes(secret), false, `${step} must not carry ${secret}: ${res.stdout}`);
    }
  }
});

// The tail, head or cut commands on a shell line that run before any redactor in their pipeline.
// Quoted text and ${VAR} are blanked first, so a grep pattern like 'error|quota' is not split.
function unredactedCuts(line) {
  const text = line.replace(/'[^']*'/g, "''").replace(/\$\{[A-Za-z_]+\}/g, '$VAR');
  const bad = [];
  for (const fragment of text.split(/\$\(|\)|;|\{|\}/)) {
    let clean = false;
    for (const command of fragment.split('|').map((part) => part.trim())) {
      if (/^redact(?:_raw)?\b/.test(command)) clean = true;
      else if (/^(?:tail|head|cut)\b/.test(command) && !clean) bad.push(command);
    }
  }
  return bad;
}

test('no error or log text in the runtime workflow bypasses the shared redactor', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  const lines = workflow.split('\n');
  assert.doesNotMatch(workflow, /sed\s+-E?\s*'s\/\(AIza/, 'no inline key-prefix sed redaction remains');
  assert.doesNotMatch(workflow, /\[key\]/, 'only the shared redactor writes the [key] marker');
  const definitions = lines.filter((line) => /^\s*redact\(\) \{/.test(line));
  assert.equal(definitions.length, 3, 'the free step, the paid step and the PR step each define redact()');
  for (const line of definitions) assert.match(line, /node "\$(?:CHE_TRUSTED_TOOLS|trust)\/tools\/che_coding_checkpoint\.mjs" redact \|/);
  // Every command substitution that reads a model log, checkpoint verdict or PR error prints redacted text.
  // A line that only writes one of these files (`2>file`, `>file`) prints nothing; a read is what matters.
  const reads = (line) => line.replace(/\d?>>?\s*"?[^\s")]+"?/g, '');
  const readers = lines.filter((line) => /\$\(/.test(line) && /opencode-stderr\.log|opencode-events\.jsonl|checkpoint-verdict\.json|checkpoint-restore\.json|pr-err\.txt/.test(reads(line)));
  assert.equal(readers.length, 6, `expected the six known readers, found ${readers.length}`);
  for (const line of readers) assert.match(line, /\bredact\b/, `unredacted text: ${line.trim()}`);
  // Order: a log window is cut only after the redactor ran, so a key split by the cut leaves nothing.
  for (const line of readers) assert.deepEqual(unredactedCuts(line), [], `cut before redaction: ${line.trim()}`);
  const rawDefinitions = lines.filter((line) => /^\s*redact_raw\(\) \{/.test(line));
  assert.equal(rawDefinitions.length, 2, 'the free and paid steps define redact_raw()');
  for (const line of rawDefinitions) assert.match(line, /redact_raw\(\) \{ node "\$CHE_TRUSTED_TOOLS\/tools\/che_coding_checkpoint\.mjs" redact; \}/);
  for (const line of definitions) assert.match(line, /che_coding_checkpoint\.mjs" redact \|.*\bcut -c/, 'redact() cuts only after the redactor ran');
  // The guard itself catches the old order on the paid and free lines.
  assert.deepEqual(unredactedCuts('err=$(tail -c 400 ${RUNNER_TEMP}/opencode-stderr.log | redact)'), ['tail -c 400 $VAR/opencode-stderr.log']);
  assert.equal(unredactedCuts("why=$( { tail -c 4000 ${RUNNER_TEMP}/opencode-stderr.log; grep -iE 'error|quota' ${RUNNER_TEMP}/opencode-events.jsonl | tail -2; } 2>/dev/null | redact)").length, 2);
});

test('a key split by the log window is redacted before the window is cut, so no fragment survives', async () => {
  const { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'che-window-'));
  const trusted = join(base, 'trusted');
  mkdirSync(join(trusted, 'tools'), { recursive: true });
  mkdirSync(join(trusted, 'server/cloudflare'), { recursive: true });
  copyFileSync(new URL('../../tools/che_coding_checkpoint.mjs', import.meta.url), join(trusted, 'tools/che_coding_checkpoint.mjs'));
  copyFileSync(new URL('./coding_failover.mjs', import.meta.url), join(trusted, 'server/cloudflare/coding_failover.mjs'));
  // A 33-character key; a cut 13 characters into it leaves this 20-character tail, which no rule matches.
  const key = ['sk', '-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'].join('');
  const fragment = key.slice(13);
  const cases = [
    { step: 'Run capped paid OpenRouter only after free attempts', window: 400, old: 'err=$(tail -c 400 ${RUNNER_TEMP}/opencode-stderr.log | redact)' },
    { step: 'Run OpenCode in the isolated checkout', window: 4000, old: "err=$( { tail -c 4000 ${RUNNER_TEMP}/opencode-stderr.log; grep -iE 'error' ${RUNNER_TEMP}/opencode-events.jsonl | tail -2; } 2>/dev/null | redact)" },
  ];
  for (const { step, window, old } of cases) {
    const dir = mkdtempSync(join(base, 'step-'));
    // The key sits so that the last `window` bytes start exactly 13 characters into it.
    writeFileSync(join(dir, 'opencode-stderr.log'), `request failed for ${key}${'x'.repeat(window - 20)}`);
    writeFileSync(join(dir, 'opencode-events.jsonl'), '');
    const script = runStepScript(step).split('\n');
    const definitions = script.filter((line) => /^redact(?:_raw)?\(\) \{/.test(line)).join('\n');
    const windowed = script.map((line) => line.trim()).filter((line) => /^(?:why|err)=\$\(/.test(line) && /opencode-stderr\.log/.test(line));
    assert.ok(windowed.length >= 1, `${step} has a windowed error line`);
    const run = (line) => spawnSync('bash', ['-c', "CHE_TRUSTED_TOOLS='" + trusted + "'\n" + definitions + '\n' + line + '\nprintf "%s" "${err:-$why}"'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir },
    });
    const before = run(old);
    assert.equal(before.status, 0, before.stderr);
    assert.ok(before.stdout.includes(fragment), `${step}: the old order leaves the fragment ${fragment}: ${before.stdout.slice(0, 60)}`);
    for (const line of windowed) {
      const after = run(line);
      assert.equal(after.status, 0, after.stderr);
      assert.equal(after.stdout.includes(fragment), false, `${step}: no fragment after redact-first: ${after.stdout.slice(0, 60)}`);
      assert.match(after.stdout, /\[key\]/, `${step}: the key is replaced`);
    }
  }
});

// The runtime job's steps write only under RUNNER_TEMP. A fixed /tmp path is shared with every
// other process on the machine, so a test reading it could be truncated mid-run.
test('the runtime job uses no fixed /tmp path: each test can own its scratch directory', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  const runtime = workflow.slice(workflow.indexOf('\n  runtime:\n'), workflow.indexOf('\n  deliver:\n'));
  assert.ok(runtime.length > 1000, 'the runtime job is found');
  // /tmp as a word, so `mktemp -p /tmp` or a bare /tmp also fails, not only /tmp/ followed by a name.
  assert.doesNotMatch(runtime, /(^|[\s"'=:])\/tmp\b/m, 'every runtime scratch path comes from RUNNER_TEMP');
  assert.match(runtime, /OPENCODE_CONFIG: \$\{\{ runner\.temp \}\}\/che-opencode-config\.json/);
});
