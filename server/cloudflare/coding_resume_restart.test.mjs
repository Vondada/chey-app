// Coding job resume across a Worker restart (reliability lane rel-infra-app, 2026-10-25). coding_resume.test.mjs
// drives one CheState instance. Real resumes span isolate evictions and deploys: the pending resume lives in Durable
// Object storage, and every step must come out the same from a brand-new instance: wait out the backoff, dispatch the
// SAME session exactly once, never dispatch again while that run may be alive, and finish cleanly when it is claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { runtimeSessionId } from './coding_runtime.js';
import { RESUME_BACKOFF_MS } from './coding_failover.mjs';

const generated = new URL('./.coding_resume_restart.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let CheState;
try { ({ CheState } = await import(`${generated.href}?t=${Date.now()}`)); } finally { try { unlinkSync(generated); } catch (_) {} }

const REPO = 'o/r';
const BASE = 'b'.repeat(40);
const JOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const REQUEST = 'Make the coding status name the resume attempt after a restart.';
const BRANCH = `che/auto/${JOB.slice(0, 8)}`;
const SESSION = runtimeSessionId({ repo: REPO, baseSha: BASE, targetBranch: BRANCH, ownerRequest: REQUEST, jobId: JOB, model: 'auto' });

test('a pending coding resume survives restarts: backoff, one dispatch of the same session, no duplicate, clean claim', async () => {
  const start = Date.now();
  // Durable storage: one Map that outlives every CheState instance (a restart is a new instance over it).
  const saved = new Map([
    ['che_runtime_last_session', SESSION],
    ['che_runtime_last_session_at', new Date(start - 2 * 60_000).toISOString()],
    ['che_runtime_last_job_id', JOB],
    ['che_runtime_last_base_sha', BASE],
    ['che_runtime_last_branch', BRANCH],
    ['che_runtime_last_request', REQUEST],
  ]);
  const env = { CHE_CODING_RUNTIME: 'opencode', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: REPO };
  const restart = () => new CheState({
    storage: {
      get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
      put: async (key, value) => { saved.set(key, structuredClone(value)); },
      delete: async (key) => { saved.delete(key); },
      setAlarm: async () => {},
    },
  }, env);
  let record = { session_id: SESSION, runtime: 'opencode', state: 'blocked', failure: 'opencode_failed', resumable: true, failure_kind: 'quota', resume_count: 0, updated_at: new Date(start).toISOString() };
  let runs = [];
  const dispatches = [];
  const original = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(`https://api.github.com/repos/${REPO}`, '');
    if (path.includes(`/contents/mailbox/runtime/${SESSION}.json`)) return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(record)).toString('base64') }), { status: 200 });
    if (path.includes('/actions/workflows/') && path.includes('/runs?')) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    if (path.includes('/dispatches')) { dispatches.push(JSON.parse(String(init.body || '{}'))); return new Response(null, { status: 202 }); }
    if (path.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: BASE }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    // 1. The failure is judged on one instance: a resume is scheduled after the first backoff; nothing dispatched.
    const waiting = await restart().recoverOpenCodeFailure();
    assert.equal(waiting.state, 'waiting_capacity');
    const scheduled = saved.get('che_runtime_resume');
    assert.equal(scheduled.session_id, SESSION);
    assert.equal(dispatches.length, 0);

    // 2. Restart before the backoff ends: the new instance keeps waiting and does not reschedule or dispatch.
    const again = await restart().recoverOpenCodeFailure();
    assert.equal(again.state, 'waiting_capacity');
    assert.equal(saved.get('che_runtime_resume').next_at, scheduled.next_at, 'the restart kept the same resume time');
    assert.equal(dispatches.length, 0);

    // 3. Restart after the backoff: the new instance dispatches the SAME session, once.
    Date.now = () => realNow() + RESUME_BACKOFF_MS[0] + 60_000;
    const resuming = await restart().recoverOpenCodeFailure();
    assert.equal(resuming.state, 'resuming');
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].inputs.job_id, SESSION, 'the stable session id, so the runner resumes from its checkpoint');
    assert.equal(dispatches[0].inputs.base_sha, BASE);
    assert.equal(dispatches[0].inputs.target_branch, BRANCH);
    assert.ok(saved.get('che_runtime_resume').dispatched_at, 'the dispatch is checkpointed before anything else');

    // 4. Restart while that run is queued on GitHub: never a second dispatch, never a duplicate team job.
    runs = [{ display_title: `CHE OpenCode runtime ${SESSION}`, status: 'queued', created_at: new Date(Date.now()).toISOString() }];
    for (let i = 0; i < 3; i += 1) {
      const still = await restart().recoverOpenCodeFailure();
      assert.equal(still.state, 'resuming');
    }
    assert.equal(dispatches.length, 1, 'restarts never dispatch the same resume twice');
    assert.equal((saved.get('che')?.jobs || []).filter((job) => job.kind === 'self_development').length, 0);

    // 5. The runner claims it; the next instance sees it running and clears the pending resume.
    record = { ...record, state: 'running', resume_count: 1, resumable: false };
    const live = await restart().recoverOpenCodeFailure();
    assert.equal(live.recovered, false);
    assert.equal(saved.has('che_runtime_resume'), false, 'resume complete');
    assert.equal(dispatches.length, 1);
    assert.equal((saved.get('che')?.jobs || []).filter((job) => job.kind === 'self_development').length, 0, 'no built-in duplicate after the claim');
  } finally {
    globalThis.fetch = original;
    Date.now = realNow;
  }
});
