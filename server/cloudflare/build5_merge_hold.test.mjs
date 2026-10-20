// Build 5 (owner, 2026-10-20): CHE codes herself, and never merges to main or deploys without the
// owner's explicit yes. The coding runner records whether his own request authorized the merge;
// che-autopilot merges only such a session and otherwise stops at "approved, waiting for the
// owner"; his "merge it" in CHE then merges that runner PR and the session record says he did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CheCodingRuntime, speakRuntimeStatus } from './coding_runtime.js';

const env = { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'owner/repo', CHE_CODING_RUNTIME: 'opencode', CHE_OPENCODE_MODEL: 'auto' };
const json = (status, data) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const SESSION = 'ocr-1234abcd';
const HEAD = 'a'.repeat(40);

const generated = new URL('./.build5_merge_hold.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

test('the runner is told whether the owner authorized the merge; the default is no', async () => {
  const sent = [];
  const runtime = new CheCodingRuntime(env, { fetcher: async (url, init) => { sent.push(JSON.parse(init.body)); return json(204); } });
  const base = { jobId: 'job-1', ownerRequest: 'Fix the voice bug in the current app.', baseSha: 'b'.repeat(40), targetBranch: 'che/auto/job00001' };
  const held = await runtime.createSession(base);
  assert.equal(sent[0].inputs.merge_authorized, 'false');
  assert.equal(held.merge_authorized, false);
  await runtime.createSession({ ...base, jobId: 'job-2', mergeAuthorized: true });
  assert.equal(sent[1].inputs.merge_authorized, 'true');
});

test('the workflows: the runner records the decision, and che-autopilot merges only an authorized session', () => {
  const runner = readFileSync(new URL('../../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
  assert.match(runner, /merge_authorized:\n\s+description:[^\n]+\n\s+required: false\n\s+default: 'false'/);
  assert.match(runner, /merge_authorized: process\.env\.MERGE_AUTHORIZED === 'true'/, 'the claim records it');
  assert.match(runner, /result\.merge_authorized = process\.env\.MERGE_AUTHORIZED === 'true'/, 'the final record keeps it');
  assert.match(runner, /NOT merged until the owner says yes/);
  const autopilot = readFileSync(new URL('../../.github/workflows/che-autopilot.yml', import.meta.url), 'utf8');
  const hold = autopilot.indexOf("if (runtimeNow.value.merge_authorized !== true)");
  const merge = autopilot.indexOf('github.rest.pulls.merge(');
  assert.ok(hold > 0 && merge > hold, 'the authorization check comes before the only merge call');
  assert.equal(autopilot.split('github.rest.pulls.merge(').length, 2, 'there is exactly one merge call');
  assert.match(autopilot.slice(hold, merge), /putRuntime\('approved_waiting_owner'[\s\S]*return;/);
});

function fakeGitHub({ branch = 'che/auto/abcd1234', record = {} } = {}) {
  const calls = [];
  let stored = { session_id: SESSION, state: 'approved_waiting_owner', pr_number: 412, updated_at: '2026-10-20T20:00:00Z', changed_files: 1, ...record };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname.endsWith(`/contents/mailbox/runtime/${SESSION}.json`)) {
      if (method === 'PUT') { stored = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8')); return json(200, {}); }
      return json(200, { sha: 'f'.repeat(40), content: b64(stored) });
    }
    if (u.pathname.endsWith('/pulls/412') && method === 'GET') return json(200, { number: 412, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', title: 'CHE: fix', html_url: 'https://github.com/owner/repo/pull/412', head: { sha: HEAD, ref: branch }, base: { sha: 'c'.repeat(40) } });
    if (u.pathname.includes('/check-runs')) return json(200, { check_runs: [{ name: 'analyze', status: 'completed', conclusion: 'success' }] });
    if (u.pathname.endsWith('/pulls/412/files')) return json(200, [{ filename: 'lib/rooms/che_trading_room.dart' }]);
    if (u.pathname.endsWith('/pulls/412/merge') && method === 'PUT') return json(200, { merged: true, sha: 'd'.repeat(40) });
    return json(404, { message: 'Not Found' });
  };
  return { fetcher, calls, record: () => stored };
}

function memory(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k), list: async () => new Map() };
}

test('"merge it" is the owner\'s yes for the runner PR waiting for him; the record then says he merged it', async (t) => {
  const gh = fakeGitHub();
  const real = globalThis.fetch;
  globalThis.fetch = gh.fetcher;
  t.after(() => { globalThis.fetch = real; });
  const out = await worker.handleSelfUpdateChatAction(env, memory({ che_runtime_last_session: SESSION }), { kind: 'merge' }, {});
  assert.equal(out.ok, true);
  assert.match(out.message, /Pull request #412 is merged on your yes, sir \(commit ddddddd\)/);
  assert.ok(gh.calls.includes('PUT /repos/owner/repo/pulls/412/merge'));
  assert.equal(gh.record().state, 'merged');
  assert.equal(gh.record().merged_by, 'owner');
  assert.match(speakRuntimeStatus(gh.record()), /merged pull request 412 after your yes/);
});

test('a runner PR still in review is not merged on "merge it"', async (t) => {
  const gh = fakeGitHub({ record: { state: 'reviewing' } });
  const real = globalThis.fetch;
  globalThis.fetch = gh.fetcher;
  t.after(() => { globalThis.fetch = real; });
  const out = await worker.handleSelfUpdateChatAction(env, memory({ che_runtime_last_session: SESSION }), { kind: 'merge' }, {});
  assert.equal(out.ok, false);
  assert.ok(!gh.calls.some((c) => c.endsWith('/merge')), 'a PR still in review is not merged');
});

test('CHE merges only her own branches, even on a yes', async (t) => {
  const gh = fakeGitHub({ branch: 'feature/someone-else' });
  const real = globalThis.fetch;
  globalThis.fetch = gh.fetcher;
  t.after(() => { globalThis.fetch = real; });
  const out = await worker.handleSelfUpdateChatAction(env, memory({ che_runtime_last_session: SESSION }), { kind: 'merge' }, {});
  assert.equal(out.ok, false);
  assert.match(out.message, /did not merge pull request #412.*Nothing was merged/);
  assert.ok(!gh.calls.some((c) => c.endsWith('/merge')));
  assert.equal(gh.record().state, 'approved_waiting_owner');
});

test('the waiting state is spoken as waiting, never as merged', () => {
  assert.match(speakRuntimeStatus({ state: 'approved_waiting_owner', pr_number: 7, changed_files: 1 }), /waiting for your approval, sir; I have not merged or deployed it/);
});
