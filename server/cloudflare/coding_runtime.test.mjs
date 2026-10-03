import test from 'node:test';
import assert from 'node:assert/strict';
import { CheCodingRuntime, codingRuntimeEnabled, runtimeSessionId, validateRuntimeRequest } from './coding_runtime.js';

function response(status, data = null) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const env = {
  CHE_CODING_RUNTIME: 'opencode',
  CHE_GITHUB_REPO: 'Vondada/chey-app',
  CHE_GITHUB_TOKEN: 'test-token',
  CHE_OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
};

test('runtime is feature flagged off by default', async () => {
  assert.equal(codingRuntimeEnabled({}), false);
  let called = false;
  const runtime = new CheCodingRuntime({}, { fetcher: async () => { called = true; return response(500); } });
  const out = await runtime.createSession({ ownerRequest: 'Fix the voice bug safely.', baseSha: 'abcdef1', targetBranch: 'che/test' });
  assert.equal(out.disabled, true);
  assert.equal(called, false);
});

test('request validation refuses secrets before dispatch', () => {
  assert.match(validateRuntimeRequest('use ghp_123456789012345678901234567890 now').error, /secret/i);
});

test('session ids are stable for the same coding job', () => {
  const input = { repo: 'Vondada/chey-app', baseSha: 'abcdef1', targetBranch: 'che/test', ownerRequest: 'Fix the voice bug', jobId: 'job-1' };
  assert.equal(runtimeSessionId(input), runtimeSessionId(input));
});

test('createSession dispatches the pinned workflow with compact inputs', async () => {
  let request;
  const runtime = new CheCodingRuntime(env, { fetcher: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return response(204);
  } });
  const out = await runtime.createSession({ jobId: 'job-1', ownerRequest: 'Fix the voice bug in the current app.', baseSha: 'abcdef1234567', targetBranch: 'claude/che-coding-runtime' });
  assert.equal(out.status, 202);
  assert.equal(out.state, 'queued');
  assert.match(request.url, /actions\/workflows\/che-opencode-runtime\.yml\/dispatches$/);
  assert.equal(request.body.inputs.job_id, out.session_id);
  assert.equal(request.body.inputs.base_sha, 'abcdef1234567');
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
