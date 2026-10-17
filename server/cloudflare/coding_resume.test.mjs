// A capacity-blocked OpenCode session resumes from its verified checkpoint, after a
// backoff, in the SAME session (same id), and never more than RESUME_LIMIT times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { runtimeSessionId, runtimeStateClass, speakRuntimeStatus } from './coding_runtime.js';
import { RESUME_LIMIT, RESUME_BACKOFF_MS } from './coding_failover.mjs';

// worker.js imports cloudflare:workers, which only the Worker runtime provides. The
// autonomy suite loads a copy with a plain DurableObject base; this one does the same.
const generated = new URL('./.coding_resume.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let CheState;
try { ({ CheState } = await import(`${generated.href}?t=${Date.now()}`)); } finally { try { unlinkSync(generated); } catch (_) {} }

const REPO = 'o/r';
const BASE = 'a'.repeat(40);
const JOB = '6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const REQUEST = 'Fix the coding status wording so it names the resume attempt.';
const BRANCH = `che/auto/${JOB.slice(0, 8)}`;
const SESSION = runtimeSessionId({ repo: REPO, baseSha: BASE, targetBranch: BRANCH, ownerRequest: REQUEST, jobId: JOB, model: 'auto' });

function harness({ record, dispatch = 202, now = Date.now() }) {
  const saved = new Map([
    ['che_runtime_last_session', SESSION],
    ['che_runtime_last_session_at', new Date(now - 2 * 60_000).toISOString()],
    ['che_runtime_last_job_id', JOB],
    ['che_runtime_last_base_sha', BASE],
    ['che_runtime_last_branch', BRANCH],
    ['che_runtime_last_request', REQUEST],
  ]);
  const env = { CHE_CODING_RUNTIME: 'opencode', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: REPO };
  const state = new CheState({
    storage: {
      get: async (key) => saved.get(key),
      put: async (key, value) => { saved.set(key, value); },
      delete: async (key) => { saved.delete(key); },
      setAlarm: async () => {},
    },
  }, env);
  const dispatches = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(`https://api.github.com/repos/${REPO}`, '');
    if (path.includes(`/contents/mailbox/runtime/${SESSION}.json`)) {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(record.current)).toString('base64') }), { status: 200 });
    }
    if (path.includes('/dispatches')) {
      dispatches.push(JSON.parse(String(init.body || '{}')));
      return new Response(null, { status: dispatch });
    }
    return new Response('{}', { status: 404 });
  };
  return { state, saved, dispatches, restore: () => { globalThis.fetch = original; } };
}

const blocked = (extra = {}) => ({
  session_id: SESSION, runtime: 'opencode', state: 'blocked', failure: 'opencode_failed',
  resumable: true, failure_kind: 'quota', resume_count: 0, updated_at: new Date().toISOString(), ...extra,
});

test('a quota failure with a checkpoint waits for its backoff, dispatches the same session, and is live once claimed', async () => {
  const now = Date.now();
  const record = { current: blocked() };
  const h = harness({ record, now });
  try {
    const waiting = await h.state.recoverOpenCodeFailure();
    assert.equal(waiting.state, 'waiting_capacity');
    assert.equal(waiting.recovered, false);
    assert.equal(h.dispatches.length, 0, 'nothing is dispatched before the backoff ends');
    const pending = h.saved.get('che_runtime_resume');
    assert.equal(pending.session_id, SESSION);
    assert.equal(Date.parse(pending.next_at) - now >= RESUME_BACKOFF_MS[0] - 5_000, true, 'first backoff is 15 minutes');

    // The backoff ends: the same session is dispatched with the same base, branch and job.
    pending.next_at = new Date(now - 1000).toISOString();
    h.saved.set('che_runtime_resume', pending);
    const resuming = await h.state.recoverOpenCodeFailure();
    assert.equal(resuming.state, 'resuming');
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].inputs.job_id, SESSION, 'the dispatch carries the stable session id');
    assert.equal(h.dispatches[0].inputs.base_sha, BASE);
    assert.equal(h.dispatches[0].inputs.target_branch, BRANCH);

    // Until the runner claims it, the old "blocked" record is not judged again: no second resume.
    const still = await h.state.recoverOpenCodeFailure();
    assert.equal(still.state, 'resuming');
    assert.equal(h.dispatches.length, 1, 'a waiting resume never dispatches twice');

    // The runner claims the resume: its record carries the new claim count, so the session is live.
    record.current = { ...record.current, state: 'running', resume_count: 1, resumable: false };
    const live = await h.state.recoverOpenCodeFailure();
    assert.equal(live.recovered, false);
    assert.equal(h.saved.has('che_runtime_resume'), false, 'the resume is complete');
    assert.equal((h.saved.get('che')?.jobs || []).filter((job) => job.kind === 'self_development').length, 0, 'no built-in duplicate');
  } finally { h.restore(); }
});

test('resumes are bounded: after RESUME_LIMIT resumes, CHE\'s own coding team takes over instead of looping', async () => {
  const record = { current: blocked({ resume_count: RESUME_LIMIT }) };
  const h = harness({ record });
  try {
    const recovered = await h.state.recoverOpenCodeFailure();
    assert.equal(recovered.recovered, true);
    assert.equal(h.saved.has('che_runtime_resume'), false);
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.saved.get('che').jobs.filter((job) => job.kind === 'self_development').length, 1);
  } finally { h.restore(); }
});

test('a non-capacity failure (access, too large, unknown) is never resumed, even with a checkpoint', async () => {
  const record = { current: blocked({ resumable: false, failure_kind: 'access' }) };
  const h = harness({ record });
  try {
    const recovered = await h.state.recoverOpenCodeFailure();
    assert.equal(recovered.recovered, true, 'it goes straight to CHE\'s own team');
    assert.equal(h.saved.has('che_runtime_resume'), false);
  } finally { h.restore(); }
});

test('a resume nobody claims within the window is given up, and CHE\'s own team takes over', async () => {
  const now = Date.now();
  const record = { current: blocked() };
  const h = harness({ record, now });
  try {
    h.saved.set('che_runtime_resume', {
      session_id: SESSION, job_id: JOB, base_sha: BASE, target_branch: BRANCH, request: REQUEST,
      resume_count: 0, attempt: 1, failure_kind: 'quota', next_at: new Date(now - 60 * 60_000).toISOString(),
      dispatched_at: new Date(now - 40 * 60_000).toISOString(), dispatch_failures: 0,
    });
    const recovered = await h.state.recoverOpenCodeFailure();
    assert.equal(h.saved.has('che_runtime_resume'), false);
    assert.equal(h.saved.get('che_runtime_resume_blocked'), SESSION);
    assert.equal(recovered.recovered, true);
  } finally { h.restore(); }
});

test('the spoken status is honest: waiting, resuming and a bounded attempt count are named, never "failed"', () => {
  const waiting = { state: 'waiting_capacity', failure_kind: 'quota', resume_at: '2026-10-17T13:15:00.000Z', resume_attempt: 1, resume_limit: 3 };
  const spoken = speakRuntimeStatus(waiting);
  assert.match(spoken, /ran out of free model capacity \(quota\)/);
  assert.match(spoken, /resume it from that checkpoint at 13:15 UTC, attempt 1 of 3/);
  assert.match(spoken, /Nothing is lost/);
  assert.equal(runtimeStateClass(waiting), 'active');
  assert.match(speakRuntimeStatus({ state: 'resuming' }), /resuming the coding job from its verified checkpoint/);
  assert.equal(runtimeStateClass({ state: 'resuming' }), 'active');
});
