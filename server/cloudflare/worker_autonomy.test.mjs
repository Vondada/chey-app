// Worker-level failure injection: background jobs, idempotency, Flagstaff
// duplicate/terminal packets, chat coding routes, merge intent and /health.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.worker_autonomy.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState, busyError, enqueueJob, selfUpdateChatIntent, isExistingChangeCommand, selectReadyJobs, shouldHandleSelfUpdateAction, MAX_JOB_ATTEMPTS, MAX_JOB_RETRIES } = mod;

function storageFor(saved, alarms = []) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (when) => alarms.push(when),
    deleteAlarm: async () => {},
  };
}

test('router "all engines failed" errors count as busy (they are retried, not failed)', () => {
  const error = new Error("I'm having trouble reaching my cloud engines, sir.");
  error.category = 'temporary_cloud_unavailable';
  assert.equal(busyError(error), true);
  assert.equal(busyError(new Error('Syntax problem in the prompt')), false);
});

test('duplicate owner requests are queued once (idempotent enqueue)', () => {
  const data = { jobs: [] };
  const first = enqueueJob(data, { prompt: 'Draft the weekly report' });
  const second = enqueueJob(data, { prompt: '  draft the WEEKLY report ' });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(data.jobs.length, 1);
  first.job.status = 'complete';
  assert.equal(enqueueJob(data, { prompt: 'Draft the weekly report' }).deduplicated, false, 'finished work can be requested again');
});

test('a job that keeps crashing the Worker mid-run is dead-lettered, not re-run forever', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'x' }; } } });
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  saved.set('che', { jobs: [{ id: 'j', prompt: 'Summarise', status: 'running', attempts: MAX_JOB_ATTEMPTS, updated_at: stale, created_at: stale }], devices: {}, memories: [] });
  await state.processJobs();
  const job = saved.get('che').jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.dead_letter, true);
  assert.ok(job.dead_letter_at);
  assert.equal(aiCalls, 0, 'terminal jobs never spend AI');
  await state.processJobs();
  assert.equal(aiCalls, 0);
});

test('an interrupted job with attempts left is requeued with backoff and its attempt is counted', async () => {
  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'done' }) } });
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  saved.set('che', { jobs: [{ id: 'j', prompt: 'Summarise', status: 'running', attempts: 1, updated_at: stale, created_at: stale }], devices: {}, memories: [] });
  await state.processJobs();
  const job = saved.get('che').jobs[0];
  assert.equal(job.status, 'queued');
  assert.ok(job.retry_at > Date.now(), 'backoff, not an immediate hot loop');
});

test('temporary failures back off 5/10/20 minutes, then dead-letter', async () => {
  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { const e = new Error('503 overloaded'); e.status = 503; throw e; } } });
  saved.set('che', { jobs: [{ id: 'j', prompt: 'Summarise', status: 'queued', created_at: new Date().toISOString() }], devices: {}, memories: [] });
  const gaps = [];
  for (let i = 0; i < 4; i += 1) {
    const before = Date.now();
    await state.processJobs();
    const job = saved.get('che').jobs[0];
    if (job.status === 'queued') { gaps.push(Math.round((job.retry_at - before) / 60_000)); job.retry_at = 0; saved.get('che').jobs[0] = job; }
  }
  assert.deepEqual(gaps, [5, 10, 20]);
  const job = saved.get('che').jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.dead_letter, true);
});

test('Flagstaff: a terminal failed packet arriving again never re-runs the AI, and its receipt retry is bounded', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const state = new CheState({ storage: storageFor(saved) }, { AI: { run: async () => { aiCalls += 1; return { response: 'reply' }; } } });
  saved.set('flagstaff_auto_reply:m1', { status: 'failed', at: Date.now(), sender: 'gemini', retry_count: 4, reply_id: '' });
  for (let i = 0; i < 5; i += 1) await state.replyToFlagstaffMessage({ id: 'm1', from: 'gemini', to: 'che', text: 'hello again' });
  assert.equal(aiCalls, 0);
  const rec = saved.get('flagstaff_auto_reply:m1');
  assert.ok(rec.reply_id, 'the visible receipt was posted');
  assert.equal(rec.status, 'failed');
});

test('Flagstaff: a packet whose replies keep getting interrupted stops after the attempt ceiling', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const state = new CheState({ storage: storageFor(saved) }, { AI: { run: async () => { aiCalls += 1; return { response: 'ok' }; } } });
  saved.set('flagstaff_auto_reply:m2', { status: 'processing', at: Date.now() - 60_000, sender: 'grok', attempts: 4 });
  const out = await state.replyToFlagstaffMessage({ id: 'm2', from: 'grok', to: 'che', text: 'ping' });
  assert.equal(out.skipped, true);
  assert.equal(aiCalls, 0);
});

test('Flagstaff: the same new packet delivered twice is answered once', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const state = new CheState({ storage: storageFor(saved) }, { AI: { run: async () => { aiCalls += 1; return { response: 'answer' }; } } });
  const msg = { id: 'm3', from: 'chatgpt', to: 'che', text: 'Review this plan please.' };
  await state.replyToFlagstaffMessage(msg);
  await state.replyToFlagstaffMessage(msg);
  assert.equal(aiCalls, 1);
});

test('merge intent needs an explicit command; negations and questions do not merge', () => {
  for (const text of ['merge it', 'CHE, merge the PR', 'yes, merge and deploy', 'go ahead and merge', 'Ship it.']) {
    assert.equal(selfUpdateChatIntent(text)?.kind, 'merge', text);
  }
  for (const text of ["don't merge it", 'should I merge the PR?', 'never merge without CI', 'what does merge mean']) {
    assert.notEqual(selfUpdateChatIntent(text)?.kind, 'merge', text);
  }
  assert.equal(selfUpdateChatIntent('is it deployed?')?.kind, 'deploy-status');
});

test('/health reports the running version for deployment verification', async () => {
  const res = await worker.fetch(new Request('https://che.example/health'), { CF_VERSION_METADATA: { id: 'v-1', tag: 'abc123def456' } });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version_tag, 'abc123def456');
  assert.equal(body.version_id, 'v-1');
});

async function pairedChat(env, saved) {
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return { state, chat: (message) => send('/api/chat', { message }, token) };
}

const GITHUB_OK = (files) => async (url) => {
  const u = String(url);
  const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
  if (u.includes('/search/code')) return ok({ items: [] });
  if (u.endsWith('/repos/o/r')) return ok({ default_branch: 'main' });
  if (u.includes('/git/ref/heads/main')) return ok({ object: { sha: 'sha1' } });
  if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
  const m = /\/contents\/(.+)\?ref=/.exec(u);
  if (m && files[m[1]]) return ok({ sha: 'blob1', content: Buffer.from(files[m[1]]).toString('base64') });
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
};

test('chat: engines down during a coding request → saved background job and a human sentence, no traces', async () => {
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { const e = new Error("I'm having trouble reaching my cloud engines, sir."); e.category = 'temporary_cloud_unavailable'; e.diagnostic = 'groq 429 | gemini 503'; throw e; } },
  };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': "class A { String s = 'Ready'; }\n" });
  try {
    const res = await chat('Update your code: make the ready banner friendlier');
    // Only the words the owner sees/hears (the metadata carries a random job id).
    const text = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'delta').map((l) => l.delta).join('');
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /429|503|groq|gemini|diagnostic|token|provide the source|filename/i);
    assert.match(text, /saved the coding job|continue/i);
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.ok(job, 'coding job checkpointed');
    // Asking again does not create a second job.
    await (await chat('Update your code: make the ready banner friendlier')).text();
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('chat: a successful coding request renders a real che-update card and saves it for "create the PR"', async () => {
  const saved = new Map();
  const files = { 'lib/main.dart': "class A {\n  String s = 'Ready. Type or speak a request.';\n}\n" };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_m, input) => {
        const system = String(input.messages?.[0]?.content || '');
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
        if (system.includes('Engineer') || system.includes('Implementation')) return { response: JSON.stringify({ summary: 'Friendlier banner', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready when you are.'" }] }) };
        return { response: 'ok' };
      },
    },
  };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(files);
  try {
    const res = await chat('Change your code: improve the home screen ready banner');
    const lines = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.filter((l) => l.type === 'delta').map((l) => l.delta).join('');
    assert.doesNotMatch(reply, /```|class A|che-update/, 'no code in chat unless the owner asks');
    assert.match(reply, /create the PR/);
    const shown = (await (await chat('show me the code')).text());
    assert.match(shown, /```diff/);
    assert.match(shown, /Ready when you are/);
    const pending = saved.get('pending_self_update');
    assert.ok(pending?.proposal?.expected_base_sha);
    assert.equal(pending.proposal.base_files['lib/main.dart'], 'blob1');
  } finally {
    globalThis.fetch = original;
  }
});

test('end-to-end: "make one small real improvement" → recover → review → approve → PR → merge after CI → verified deploy', async () => {
  const saved = new Map();
  let engineerCalls = 0;
  let reviewCalls = 0;
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    CF_VERSION_METADATA: { id: 'v2', tag: 'merge0000001' },
    AI: {
      run: async (_m, input) => {
        const system = String(input.messages?.[0]?.content || '');
        if (system.includes('Source Recovery')) return { response: JSON.stringify({ plan: 'home', search_terms: ['Ready'], paths: ['server/cloudflare/worker.js'] }) };
        // Injected: planners return prose instead of JSON.
        if (system.includes('Architect')) return { response: 'I would improve the status text.' };
        if (system.includes('Review')) {
          reviewCalls += 1;
          // Injected: first reviewer engine is down.
          if (reviewCalls === 1) { const e = new Error('503'); e.status = 503; throw e; }
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: ['Verified against fetched source.'] }) };
        }
        if (system.includes('Engineer') || system.includes('Implementation')) {
          engineerCalls += 1;
          // Injected: first engineer claims it was not given source.
          if (engineerCalls === 1) return { response: JSON.stringify({ no_change: true, summary: 'The source code was not provided.', evidence: ['cannot inspect the repository'] }) };
          return { response: JSON.stringify({ summary: 'Clearer health reply', edits: [{ path: 'server/cloudflare/worker.js', find: "agent: 'CHE cloud'", replace: "agent: 'CHE cloud', status: 'ready'" }] }) };
        }
        return { response: 'ok' };
      },
    },
  };
  const workerSource = "export default { fetch() { return Response.json({ ok: true, agent: 'CHE cloud' }); } };\n";
  let ciDone = false;
  const calls = [];
  const fakeGitHubAll = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, u, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (u === 'https://api.github.com/graphql') return reply({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (u.includes('/search/code')) return reply({ message: 'rate limited' }, 403); // injected: search unavailable
    const path = u.replace('https://api.github.com/repos/o/r', '');
    if (method === 'GET' && path === '') return reply({ default_branch: 'main' });
    if (method === 'GET' && path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: 'base1' } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/che')) return reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && path.startsWith('/git/trees/')) return reply({ tree: [{ type: 'blob', path: 'server/cloudflare/worker.js' }] });
    const content = /^\/contents\/(.+)\?ref=/.exec(path);
    if (method === 'GET' && content) return content[1] === 'server/cloudflare/worker.js' ? reply({ sha: 'blobW', content: Buffer.from(workerSource).toString('base64') }) : reply({}, 404);
    if (method === 'GET' && path.startsWith('/git/commits/')) return reply({ tree: { sha: 't0' } });
    if (method === 'POST' && path === '/git/trees') return reply({ sha: 't1' }, 201);
    if (method === 'POST' && path === '/git/commits') return reply({ sha: 'c1' }, 201);
    if (method === 'POST' && path === '/git/refs') return reply({}, 201);
    if (method === 'POST' && path === '/pulls') return reply({ number: 77, html_url: 'https://github.com/o/r/pull/77', head: { sha: 'h77' } }, 201);
    if (method === 'GET' && path.startsWith('/pulls?state=all')) return reply([]);
    if (method === 'GET' && path === '/pulls/77') return reply({ number: 77, html_url: 'u77', state: 'open', merged: false, draft: true, mergeable: true, mergeable_state: 'clean', node_id: 'N', title: 'CHE update: x', head: { sha: 'h77', ref: 'che/update-x' }, base: { sha: 'base1' } });
    if (method === 'GET' && path.startsWith('/pulls/77/files')) return reply([{ filename: 'server/cloudflare/worker.js' }]);
    if (method === 'GET' && path.startsWith('/commits/h77/check-runs')) return reply({ check_runs: [{ name: 'Worker tests', status: ciDone ? 'completed' : 'in_progress', conclusion: ciDone ? 'success' : null }] });
    if (method === 'PUT' && path === '/pulls/77/merge') return reply({ sha: 'merge0000001abc' });
    if (method === 'GET' && path.startsWith('/actions/runs')) return reply({ workflow_runs: [{ name: 'Deploy CHE Worker', status: 'completed', conclusion: 'success', html_url: 'run' }] });
    return reply({ message: `unexpected ${method} ${path}` }, 500);
  };
  const { state, chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHubAll;
  const replyOf = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'delta').map((l) => l.delta).join('');
  try {
    // 1. Vague owner request, no filename or guidance.
    const proposal = await replyOf(await chat('CHE, make one small real improvement to your code.'));
    assert.match(proposal, /Say "create the PR"/, proposal);
    assert.doesNotMatch(proposal, /```|export default/);
    assert.doesNotMatch(proposal, /provide|paste|filename|not provided|cannot inspect|503/i);
    // 2. Owner authorization step.
    const opened = await replyOf(await chat('Create the PR'));
    assert.match(opened, /Real draft PR #77 is open/);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.u.endsWith('/git/commits')).length, 1, 'one atomic commit');
    // 3. Owner authorizes merge while CI is still running → CHE waits.
    const waiting = await replyOf(await chat('merge it'));
    assert.match(waiting, /merge it the moment every required check passes/);
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing merged before CI passes');
    // 4. CI passes; the background merge job merges with the checked head.
    ciDone = true;
    const job = saved.get('che').jobs.find((j) => j.kind === 'merge_pr');
    job.retry_at = 0;
    const data = saved.get('che'); data.jobs = data.jobs.map((j) => (j.id === job.id ? job : j)); saved.set('che', data);
    await state.processJobs();
    const merge = calls.find((c) => c.method === 'PUT');
    assert.equal(merge.body.sha, 'h77');
    assert.match(merge.body.commit_title, /\[worker-deploy\]/);
    // 5. Deployment truth is verified before anyone calls it deployed.
    const verify = saved.get('che').jobs.find((j) => j.kind === 'verify_deploy');
    verify.retry_at = 0;
    const d2 = saved.get('che'); d2.jobs = d2.jobs.map((j) => (j.id === verify.id ? verify : j)); saved.set('che', d2);
    await state.processJobs();
    assert.equal(saved.get('last_self_update_deploy').state, 'deployed');
    const status = await replyOf(await chat('is it deployed?'));
    assert.match(status, /PR #77 is deployed/);
    assert.match(status, /live Worker is running that commit/);
  } finally {
    globalThis.fetch = original;
  }
});

test('one-button "Update CHE": one approval → PR → merge after CI → verified deploy → real change history', async () => {
  const saved = new Map();
  let engineerCalls = 0;
  let reviewCalls = 0;
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    CF_VERSION_METADATA: { id: 'v2', tag: 'merge0000001' },
    AI: {
      run: async (_m, input) => {
        const system = String(input.messages?.[0]?.content || '');
        if (system.includes('Source Recovery')) return { response: JSON.stringify({ plan: 'home', search_terms: ['Ready'], paths: ['server/cloudflare/worker.js'] }) };
        // Injected: planners return prose instead of JSON.
        if (system.includes('Architect')) return { response: 'I would improve the status text.' };
        if (system.includes('Review')) {
          reviewCalls += 1;
          // Injected: first reviewer engine is down.
          if (reviewCalls === 1) { const e = new Error('503'); e.status = 503; throw e; }
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: ['Verified against fetched source.'] }) };
        }
        if (system.includes('Engineer') || system.includes('Implementation')) {
          engineerCalls += 1;
          // Injected: first engineer claims it was not given source.
          if (engineerCalls === 1) return { response: JSON.stringify({ no_change: true, summary: 'The source code was not provided.', evidence: ['cannot inspect the repository'] }) };
          return { response: JSON.stringify({ summary: 'Clearer health reply', edits: [{ path: 'server/cloudflare/worker.js', find: "agent: 'CHE cloud'", replace: "agent: 'CHE cloud', status: 'ready'" }] }) };
        }
        return { response: 'ok' };
      },
    },
  };
  const workerSource = "export default { fetch() { return Response.json({ ok: true, agent: 'CHE cloud' }); } };\n";
  let ciDone = false;
  const calls = [];
  const fakeGitHubAll = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, u, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (u === 'https://api.github.com/graphql') return reply({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (u.includes('/search/code')) return reply({ message: 'rate limited' }, 403); // injected: search unavailable
    const path = u.replace('https://api.github.com/repos/o/r', '');
    if (method === 'GET' && path === '') return reply({ default_branch: 'main' });
    if (method === 'GET' && path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: 'base1' } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/che')) return reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && path.startsWith('/git/trees/')) return reply({ tree: [{ type: 'blob', path: 'server/cloudflare/worker.js' }] });
    const content = /^\/contents\/(.+)\?ref=/.exec(path);
    if (method === 'GET' && content) return content[1] === 'server/cloudflare/worker.js' ? reply({ sha: 'blobW', content: Buffer.from(workerSource).toString('base64') }) : reply({}, 404);
    if (method === 'GET' && path.startsWith('/git/commits/')) return reply({ tree: { sha: 't0' } });
    if (method === 'POST' && path === '/git/trees') return reply({ sha: 't1' }, 201);
    if (method === 'POST' && path === '/git/commits') return reply({ sha: 'c1' }, 201);
    if (method === 'POST' && path === '/git/refs') return reply({}, 201);
    if (method === 'POST' && path === '/pulls') return reply({ number: 77, html_url: 'https://github.com/o/r/pull/77', head: { sha: 'h77' } }, 201);
    if (method === 'GET' && path.startsWith('/pulls?state=all')) return reply([]);
    if (method === 'GET' && path === '/pulls/77') return reply({ number: 77, html_url: 'u77', state: 'open', merged: false, draft: true, mergeable: true, mergeable_state: 'clean', node_id: 'N', title: 'CHE update: x', head: { sha: 'h77', ref: 'che/update-x' }, base: { sha: 'base1' } });
    if (method === 'GET' && path.startsWith('/pulls/77/files')) return reply([{ filename: 'server/cloudflare/worker.js' }]);
    if (method === 'GET' && path.startsWith('/commits/h77/check-runs')) return reply({ check_runs: [{ name: 'Worker tests', status: ciDone ? 'completed' : 'in_progress', conclusion: ciDone ? 'success' : null }] });
    if (method === 'PUT' && path === '/pulls/77/merge') return reply({ sha: 'merge0000001abc' });
    if (method === 'GET' && path.startsWith('/actions/runs')) return reply({ workflow_runs: [{ name: 'Deploy CHE Worker', status: 'completed', conclusion: 'success', html_url: 'run' }] });
    return reply({ message: `unexpected ${method} ${path}` }, 500);
  };
  const { state, chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHubAll;
  const replyOf = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'delta').map((l) => l.delta).join('');
  try {
    // 1. Vague owner request, no filename or guidance.
    const proposal = await replyOf(await chat('CHE, make one small real improvement to your code.'));
    assert.match(proposal, /Say "create the PR"/, proposal);
    assert.doesNotMatch(proposal, /```|export default/);
    assert.doesNotMatch(proposal, /provide|paste|filename|not provided|cannot inspect|503/i);
    // 2. One owner approval: PR opens and the merge is authorized together.
    const shipped = await replyOf(await chat('Update CHE'));
    assert.match(shipped, /Update approved, sir\. Pull request #77 is open/, shipped);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.u.endsWith('/git/commits')).length, 1, 'one atomic commit');
    assert.ok(saved.get('che').jobs.some((j) => j.kind === 'merge_pr' && j.pr_number === 77), 'merge queued for after CI');
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing merged before CI passes');
    // 4. CI passes; the background merge job merges with the checked head.
    ciDone = true;
    // Office autonomy paused by the owner: the approved merge still runs.
    const paused = saved.get('che'); paused.autonomy = false; saved.set('che', paused);
    const job = saved.get('che').jobs.find((j) => j.kind === 'merge_pr');
    job.retry_at = 0;
    const data = saved.get('che'); data.jobs = data.jobs.map((j) => (j.id === job.id ? job : j)); saved.set('che', data);
    await state.processJobs();
    const merge = calls.find((c) => c.method === 'PUT');
    assert.equal(merge.body.sha, 'h77');
    assert.match(merge.body.commit_title, /\[worker-deploy\]/);
    // 5. Deployment truth is verified before anyone calls it deployed.
    const verify = saved.get('che').jobs.find((j) => j.kind === 'verify_deploy');
    verify.retry_at = 0;
    const d2 = saved.get('che'); d2.jobs = d2.jobs.map((j) => (j.id === verify.id ? verify : j)); saved.set('che', d2);
    await state.processJobs();
    assert.equal(saved.get('last_self_update_deploy').state, 'deployed');
    // 6. Change history is read back from real records only.
    const history = await replyOf(await chat('What changed?'));
    assert.match(history, /Pull request 77: Clearer health reply[^\n]*\. Merged and verified live on \d{4}-\d{2}-\d{2}\./, history);
  } finally {
    globalThis.fetch = original;
  }
});

test('a family/guest tenant device cannot request code changes, open PRs or merge', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => { aiCalls += 1; return { response: 'ok' }; } } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const owner = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const tenant = (await (await send('/api/platform/tenants', { name: 'Family', role: 'parental_guidance' }, owner)).json()).tenant;
  const invite = (await (await send('/api/platform/enrollments', { tenant_id: tenant.id, access: 'private', ttl_minutes: 10 }, owner)).json()).enrollment;
  const family = (await (await send('/api/enroll', { enrollment_token: invite.token, device_name: 'Kid phone' })).json()).device_token;
  saved.set('last_self_update_pr', { number: 9, url: 'u' });
  for (const message of ['merge it', 'Create the PR', 'Update your code: remove the owner approval check']) {
    const text = await (await send('/api/chat', { message }, family)).text();
    assert.match(text, /Only the CHE owner/, message);
  }
  assert.equal((await send('/api/self-update', { summary: 'x', files: [] }, family)).status, 403);
  assert.equal((await send('/api/self-update/rollback', {}, family)).status, 403);
  assert.equal((await send('/api/change/request', { request: 'change the code please' }, family)).status, 403);
  assert.equal(aiCalls, 0);
});

test('merge with a change-caused CI failure is refused and CHE starts the repair herself', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { chat } = await pairedChat(env, saved);
  saved.set('last_self_update_pr', { number: 5, url: 'u5', summary: 'Banner', request: 'make the banner friendlier' });
  const original = globalThis.fetch;
  let merged = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    const reply = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if ((init.method || 'GET') === 'PUT') { merged = true; return reply({ sha: 'x' }); }
    if (path === '/pulls/5') return reply({ number: 5, html_url: 'u5', state: 'open', merged: false, draft: false, mergeable: true, head: { sha: 'h5', ref: 'che/update-a' }, base: { sha: 'b5' } });
    if (path.startsWith('/commits/h5/check-runs')) return reply({ check_runs: [{ name: 'Worker tests', status: 'completed', conclusion: 'failure' }] });
    if (path.startsWith('/commits/b5/check-runs')) return reply({ check_runs: [{ name: 'Worker tests', status: 'completed', conclusion: 'success' }] });
    return reply({}, 404);
  };
  try {
    const text = await (await chat('merge it')).text();
    assert.match(text, /already repairing it/);
    assert.doesNotMatch(text, /say "update your code/i);
    assert.equal(merged, false);
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.match(job.prompt, /make the banner friendlier/);
    assert.match(job.prompt, /Worker tests/);
  } finally {
    globalThis.fetch = original;
  }
});

test('voice text is made fluent: no code, bullets, dashes, ellipses or line breaks', async () => {
  const { fluentSpeechText } = mod;
  const out = fluentSpeechText('Sure, sir...\n\n- First — the banner\n- Second (the card)\n```js\nconst x = 1;\n```\nDone!');
  assert.equal(out, 'Sure, sir First the banner Second the card Done!');
});

test('a GitHub permission refusal tells the owner exactly what GitHub said', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { chat } = await pairedChat(env, saved);
  saved.set('pending_self_update', { proposal: { summary: 'Tweak', files: [{ path: 'docs/a.md', content: 'hi\n' }] }, request: 'tweak' });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    const method = init.method || 'GET';
    const reply = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (method === 'GET' && path === '') return reply({ default_branch: 'main' });
    if (path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: 'b1' } });
    if (path.startsWith('/git/ref/heads/che')) return reply({}, 404);
    if (path.startsWith('/contents/')) return reply({}, 404);
    if (path.startsWith('/git/commits/')) return reply({ tree: { sha: 't' } });
    if (method === 'POST' && path === '/git/trees') return reply({ sha: 't2' }, 201);
    if (method === 'POST' && path === '/git/commits') return reply({ sha: 'c2' }, 201);
    if (method === 'POST' && path === '/git/refs') return reply({}, 201);
    if (method === 'POST' && path === '/pulls') return reply({ message: 'Resource not accessible by personal access token' }, 403);
    return reply({}, 404);
  };
  try {
    const text = await (await chat('Create the PR')).text();
    assert.match(text, /Resource not accessible by personal access token/);
  } finally { globalThis.fetch = original; }
});

test('GitHub secondary rate limits are temporary, not a permissions problem', async () => {
  const { classifyFailure } = await import('./recovery_policy.js');
  assert.equal(classifyFailure({ status: 403, detail: 'You have exceeded a secondary rate limit' }).failure_class, 'B');
});

test('"Show me the code" sent to the coding route shows the saved change instead of starting a new coding job', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => { aiCalls += 1; return { response: 'x' }; } } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  saved.set('pending_self_update', { proposal: { summary: 'Brain room', files: [{ path: 'lib/brain.dart', content: 'x' }] }, request: 'rebuild the Brain room', diff: '--- lib/brain.dart\n+ new brain' });
  saved.set('che_last_engineering_request', { request: 'rebuild the Brain room', integrate: true });
  const res = await send('/api/change/request', { request: 'Show me the code' }, token);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.message, /```diff[\s\S]*new brain/);
  assert.equal(aiCalls, 0, 'no coding job was run');
  assert.equal(saved.get('che_last_engineering_request').request, 'rebuild the Brain room', 'the real request is kept');
  assert.ok(saved.get('pending_self_update'), 'the reviewed change is still waiting');
});

test('"create the PR" refuses a saved comment-only change and starts a real rebuild instead', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'x' }) } };
  const { chat } = await pairedChat(env, saved);
  saved.set('pending_self_update', {
    proposal: { summary: 'Brain room', files: [{ path: 'lib/agents/che_office_world.dart', content: 'x' }] },
    request: 'rebuild the Brain room to match the design',
    diff: '--- lib/agents/che_office_world.dart (around line 11)\n  // the room\n+ //\n+ // The Brain room renders a black starfield.\n--- docs/memory-brain/README.md\n- - Every learned thought is a glowing teal dot\n+ - Neural network constellation',
  });
  const original = globalThis.fetch;
  let githubWrites = 0;
  globalThis.fetch = async (url, init = {}) => { if ((init.method || 'GET') !== 'GET') githubWrites += 1; return new Response('{}', { status: 404 }); };
  try {
    const text = await (await chat('Create the PR')).text();
    assert.match(text, /only edits comments and documentation/);
    assert.equal(githubWrites, 0, 'nothing was written to GitHub');
    assert.equal(saved.has('pending_self_update'), false);
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.ok(job && text.includes(job.id.slice(0, 8)));
  } finally { globalThis.fetch = original; }
});


test('ready-job selection serializes Office skill imports', () => {
  const jobs = [
    { id: 'skill-a', kind: 'office_skill_import', status: 'queued', retry_at: 0 },
    { id: 'skill-b', kind: 'office_skill_import', status: 'queued', retry_at: 0 },
    { id: 'chat-a', kind: 'chat', status: 'queued', retry_at: 0 },
    { id: 'study-a', kind: 'repo_study', status: 'queued', retry_at: 0 },
    { id: 'chat-b', kind: 'chat', status: 'queued', retry_at: 0 },
  ];
  const selected = selectReadyJobs(jobs, Date.now(), 4);
  assert.equal(selected.filter((job) => job.kind === 'office_skill_import').length, 1);
  assert.deepEqual(selected.map((job) => job.id), ['skill-a', 'chat-a', 'study-a', 'chat-b']);
});

test('existing-change shortcut excludes a genuine coding request about PR support', () => {
  assert.equal(isExistingChangeCommand(selfUpdateChatIntent('Show me the code')), true);
  assert.equal(isExistingChangeCommand(selfUpdateChatIntent('Create the PR')), true);
  const accessFeature = selfUpdateChatIntent('Can you update your code so you can create a PR?');
  assert.equal(accessFeature?.kind, 'access');
  assert.equal(isExistingChangeCommand(accessFeature), false);
});


test('running skill import blocks next import while unrelated work stays parallel', () => {
  const jobs = [
    { id: 'skill-running', kind: 'office_skill_import', status: 'running', retry_at: 0 },
    { id: 'skill-next', kind: 'office_skill_import', status: 'queued', retry_at: 0 },
    { id: 'chat-a', kind: 'chat', status: 'queued', retry_at: 0 },
    { id: 'study-a', kind: 'repo_study', status: 'queued', retry_at: 0 },
  ];
  assert.deepEqual(selectReadyJobs(jobs, Date.now(), 4).map((job) => job.id), ['chat-a', 'study-a']);
});

test('chat distinguishes access questions from requests to add PR capability', () => {
  const question = selfUpdateChatIntent('Do you have GitHub write access?');
  assert.equal(shouldHandleSelfUpdateAction('Do you have GitHub write access?', question), true);
  const coding = selfUpdateChatIntent('Can you update your code so you can create a PR?');
  assert.equal(coding?.kind, 'access');
  assert.equal(shouldHandleSelfUpdateAction('Can you update your code so you can create a PR?', coding), false);
});


test('update-yourself PR capability wording reaches self-development instead of access status', () => {
  const message = 'Can you update yourself so you can create a PR?';
  const intent = selfUpdateChatIntent(message);
  assert.equal(intent?.kind, 'access');
  assert.equal(shouldHandleSelfUpdateAction(message, intent), false);
});


test('Copilot: improve-your-code capability request routes to self-development', () => {
  const message = 'Can you improve your code so you can create a PR?';
  const intent = selfUpdateChatIntent(message);
  assert.equal(intent?.kind, 'access');
  assert.equal(shouldHandleSelfUpdateAction(message, intent), false);
});

// ── Topic study: "Study build-your-own-x: these topics, then implement" ──
const { OWNER_PROMPT: BYOX_PROMPT, README: BYOX_README } = await import('./topic_study.fixtures.mjs');
const BYOX = 'codecrafters-io/build-your-own-x';

function topicStudyFetch({ tutorial = (u) => new Response(`<article><h1>${u}</h1>${'<p>An inverted index maps each word to its documents; rank results with TF-IDF.</p>'.repeat(10)}</article>`, { status: 200, headers: { 'content-type': 'text/html' } }) } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method || 'GET'} ${u}`);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (u === `https://api.github.com/repos/${BYOX}`) return ok({ default_branch: 'master', license: null, description: 'Master programming by recreating your favorite technologies from scratch.', stargazers_count: 551000 });
    if (u.startsWith(`https://api.github.com/repos/${BYOX}/readme`)) return ok({ content: Buffer.from(BYOX_README).toString('base64') });
    if (u.startsWith(`https://api.github.com/repos/${BYOX}/contents`)) return ok([{ path: 'README.md' }]);
    if (u.includes('/git/trees/HEAD')) return ok({ tree: [{ path: 'server/cloudflare/brain_graph.js' }, { path: 'lib/brain/che_brain_room.dart' }] });
    if (u.startsWith('https://api.github.com')) return new Response('{}', { status: 404 });
    return tutorial(u);
  };
  fn.calls = calls;
  return fn;
}

function topicEnv(analysis, counter = { ai: 0 }) {
  return {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { counter.ai += 1; return { response: JSON.stringify(analysis) }; } },
  };
}

const ADD_ANALYSIS = { lessons: ['An inverted index maps words to documents', 'TF-IDF ranks results'], verdict: 'ADD', why: 'my memory search has no relevance ranking.', che_area: 'Brain room memory search (server/cloudflare/brain_graph.js)', implementation_request: 'Add TF-IDF ranking to Brain room memory search.' };

test('the owner build-your-own-x prompt starts one study per named topic, in order, and no coding yet', async () => {
  const saved = new Map();
  const counter = { ai: 0 };
  const env = topicEnv(ADD_ANALYSIS, counter);
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = topicStudyFetch();
  try {
    const text = await (await chat(BYOX_PROMPT)).text();
    assert.match(text, /found your 6 topics: 1, Search Engine\. 2, Database\. 3, Bot\. 4, Neural Network\. 5, Visual Recognition System\. 6, Git\./);
    assert.match(text, /no reuse license/);
    assert.match(text, /Nothing in the app has changed yet\./);
    assert.equal(counter.ai, 0, 'starting the study spends no AI');
    const jobs = saved.get('che').jobs;
    const studies = jobs.filter((job) => job.kind === 'repo_study');
    assert.equal(studies.length, 6);
    assert.equal(jobs.filter((job) => job.kind === 'self_development').length, 0, 'nothing is built before it is studied');
    assert.equal(new Set(studies.map((job) => job.lane)).size, 1);
    assert.deepEqual(studies.map((job) => job.lane_order).sort(), [1, 2, 3, 4, 5, 6]);
    assert.ok(studies.every((job) => job.implement_after === true && job.topic.tutorials.length >= 1));
    assert.deepEqual(selectReadyJobs(jobs, Date.now(), 4).map((job) => job.topic.title), ['Search Engine'], 'one topic at a time, first one first');
    await (await chat(BYOX_PROMPT)).text();
    assert.equal(saved.get('che').jobs.filter((job) => job.kind === 'repo_study').length, 6, 'saying it twice does not double the work');
  } finally { globalThis.fetch = original; }
});

test('the same prompt sent by the app to the coding endpoint is studied first, not coded blind', async () => {
  const saved = new Map();
  const counter = { ai: 0 };
  const env = topicEnv(ADD_ANALYSIS, counter);
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const original = globalThis.fetch;
  globalThis.fetch = topicStudyFetch();
  try {
    const body = await (await send('/api/change/request', { request: BYOX_PROMPT }, token)).json();
    assert.match(body.message, /found your 6 topics/);
    assert.equal(body.background_job_ids.length, 6);
    assert.equal(counter.ai, 0);
    assert.equal(saved.get('che').jobs.filter((job) => job.kind === 'self_development').length, 0);
  } finally { globalThis.fetch = original; }
});

test('a topic study reads real tutorials, reports them truthfully and lines up exactly one build', async () => {
  const saved = new Map();
  const env = topicEnv(ADD_ANALYSIS);
  const { chat, state } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  const fetcher = topicStudyFetch();
  globalThis.fetch = fetcher;
  try {
    await (await chat(BYOX_PROMPT)).text();
    await state.processJobs();
    const jobs = saved.get('che').jobs;
    const first = jobs.find((job) => job.topic?.title === 'Search Engine');
    assert.equal(first.status, 'complete');
    assert.match(first.owner_message, /^Topic 1 of 6, Search Engine, studied, sir\. I read 3 tutorials: Search engine in JS \(JavaScript\); Building a search engine using Redis and redis-py \(Python\); A search engine in CSS \(CSS\)\./);
    assert.match(first.owner_message, /lined up for my coding team/);
    assert.equal(jobs.find((job) => job.topic?.title === 'Database').status, 'queued', 'topic 2 waits for topic 1');
    assert.ok(fetcher.calls.includes('GET https://example.dev/js-search'), 'the tutorial was really fetched');
    assert.ok(!fetcher.calls.some((call) => call.includes('youtube')));
    const builds = jobs.filter((job) => job.kind === 'self_development');
    assert.equal(builds.length, 1);
    assert.match(builds[0].prompt, /Topic 1 of 6: Search Engine/);
    assert.match(builds[0].prompt, /https:\/\/example\.dev\/js-search/);
    assert.match(builds[0].prompt, /never copy/);
    assert.match(builds[0].prompt, /Add TF-IDF ranking to Brain room memory search\./);
    const queue = saved.get('study_build_queue');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].status, 'building');
    assert.equal(queue[0].job_id, builds[0].id);
    assert.ok(saved.get('topic_study_reports').some((report) => report.topic === 'Search Engine' && report.read.length === 3));
  } finally { globalThis.fetch = original; }
});

test('a topic that does not fit, or whose tutorials cannot be read, builds nothing and says so', async () => {
  for (const scenario of ['skip', 'unreadable']) {
    const saved = new Map();
    const counter = { ai: 0 };
    const env = topicEnv({ lessons: ['x'], verdict: 'SKIP', why: 'it is about desktop rendering.', che_area: '', implementation_request: '' }, counter);
    const { chat, state } = await pairedChat(env, saved);
    const original = globalThis.fetch;
    globalThis.fetch = topicStudyFetch(scenario === 'unreadable' ? { tutorial: () => new Response('gone', { status: 404 }) } : {});
    try {
      await (await chat(BYOX_PROMPT)).text();
      await state.processJobs();
      const first = saved.get('che').jobs.find((job) => job.topic?.title === 'Search Engine');
      assert.equal(first.status, 'complete');
      if (scenario === 'skip') assert.match(first.owner_message, /It does not fit me: it is about desktop rendering\. I am not building anything for it\./);
      else {
        assert.match(first.owner_message, /could not read any of its tutorials \(HTTP 404; HTTP 404; HTTP 404\)/);
        assert.equal(counter.ai, 0, 'nothing was learned, so no AI was asked to pretend');
      }
      assert.equal(saved.get('che').jobs.filter((job) => job.kind === 'self_development').length, 0);
      assert.equal(saved.has('study_build_queue'), false);
    } finally { globalThis.fetch = original; }
  }
});

test('study builds wait while a reviewed change awaits the owner, then the next topic starts', async () => {
  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } });
  saved.set('che', { jobs: [{ id: 'build-1', kind: 'self_development', status: 'complete', study_build: 's:1', prompt: 'p', created_at: new Date().toISOString() }], devices: {}, memories: [] });
  saved.set('study_build_queue', [
    { id: 's:1', order: 1, topic: 'Search Engine', request: 'Topic 1', status: 'building', job_id: 'build-1', at: '2026-10-03T06:00:00.000Z' },
    { id: 's:2', order: 2, topic: 'Database', request: 'Topic 2: Database build', status: 'waiting', at: '2026-10-03T06:05:00.000Z' },
  ]);
  saved.set('pending_self_update', { proposal: { summary: 'Search ranking', files: [{ path: 'a.js', content: 'x' }] }, request: 'Topic 1' });
  assert.equal(await state.advanceStudyBuilds(), null, 'one approval slot: Database waits for the owner');
  assert.equal(saved.get('che').jobs.filter((job) => job.kind === 'self_development').length, 1);
  assert.equal(saved.get('study_build_queue')[0].status, 'done');
  saved.delete('pending_self_update');
  const message = await state.advanceStudyBuilds();
  assert.match(message, /^My coding team started building Database from your study list \(job [0-9a-f]{8}\)\.$/);
  const build = saved.get('che').jobs.find((job) => job.study_build === 's:2');
  assert.equal(build.prompt, 'Topic 2: Database build');
  assert.equal(await state.advanceStudyBuilds(), null, 'only one build at a time');
});

test('lane jobs run one at a time in order; other work stays parallel', () => {
  const now = Date.now();
  const jobs = [
    { id: 't3', kind: 'repo_study', status: 'queued', lane: 'study:a', lane_order: 3 },
    { id: 't2', kind: 'repo_study', status: 'queued', lane: 'study:a', lane_order: 2 },
    { id: 'chat', kind: 'chat', status: 'queued' },
    { id: 'other', kind: 'repo_study', status: 'queued', lane: 'study:b', lane_order: 1 },
  ];
  assert.deepEqual(selectReadyJobs(jobs, now, 4).map((job) => job.id), ['t2', 'chat', 'other']);
  assert.deepEqual(selectReadyJobs([{ id: 't1', status: 'running', lane: 'study:a', lane_order: 1 }, ...jobs], now, 4).map((job) => job.id), ['chat', 'other']);
  // A backing-off head keeps its place: later topics do not jump ahead.
  assert.deepEqual(selectReadyJobs([{ ...jobs[1], retry_at: now + 60_000 }, jobs[0]], now, 4).map((job) => job.id), []);
});

test('"Discard that change" removes the saved change and starts the next study build', async () => {
  for (const phrase of ['Discard that change', 'CHE, scrap the update', "I don't want that change", 'throw that change away', 'Reject the code']) {
    assert.equal(selfUpdateChatIntent(phrase)?.kind, 'discard', phrase);
  }
  for (const phrase of ['Delete it', 'Cancel my 3pm meeting', "Don't merge", 'discard the email draft', 'Can you discard changes to a file in git?']) {
    assert.notEqual(selfUpdateChatIntent(phrase)?.kind, 'discard', phrase);
  }
  const saved = new Map();
  const { chat } = await pairedChat({ CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } }, saved);
  assert.match(await (await chat('Discard that change')).text(), /no saved change waiting/);
  saved.set('pending_self_update', { proposal: { summary: 'Agent cache', files: [{ path: 'lib/agents/che_office_store.dart', content: 'x' }] }, request: 'r', from_job: 'j1' });
  saved.set('study_build_queue', [{ id: 's:1', order: 1, topic: 'Search Engine', request: 'Topic 1 of 6: Search Engine build', status: 'waiting', at: new Date().toISOString() }]);
  const text = await (await chat('Discard that change')).text();
  assert.match(text, /Discarded, sir\. The saved change to lib\/agents\/che_office_store\.dart is gone and nothing from it was merged\./);
  assert.match(text, /My coding team started building Search Engine/);
  assert.equal(saved.has('pending_self_update'), false);
  assert.ok(saved.get('che').jobs.some((job) => job.study_build === 's:1'));
});


// ── Batching: "batch them" and parallel builds without losing a change ──
const BATCH_PROMPT = BYOX_PROMPT.replace(' one topic at a time:', ' and batch them so you work on them together:');

test('a study prompt without "one at a time" runs its topics together', async () => {
  const saved = new Map();
  const { chat } = await pairedChat(topicEnv(ADD_ANALYSIS), saved);
  const original = globalThis.fetch;
  globalThis.fetch = topicStudyFetch();
  try {
    const text = await (await chat(BATCH_PROMPT)).text();
    assert.match(text, /6 study jobs that run together/);
    assert.match(text, /builds the useful ones in parallel, up to three at a time/);
    const studies = saved.get('che').jobs.filter((job) => job.kind === 'repo_study');
    assert.equal(studies.length, 6);
    assert.ok(studies.every((job) => !job.lane));
    assert.equal(selectReadyJobs(saved.get('che').jobs, Date.now(), 4).length, 4, 'four studies start at once');
  } finally { globalThis.fetch = original; }
});

test('"Batch them" releases one-at-a-time studies already lined up, and only then', async () => {
  const saved = new Map();
  const { chat } = await pairedChat(topicEnv(ADD_ANALYSIS), saved);
  const original = globalThis.fetch;
  globalThis.fetch = topicStudyFetch();
  try {
    await (await chat(BYOX_PROMPT)).text();
    assert.equal(selectReadyJobs(saved.get('che').jobs, Date.now(), 4).length, 1, 'serial before batching');
    const text = await (await chat('Batch them and do them fast')).text();
    assert.match(text, /Batched, sir\. 6 studies now run together instead of one by one\./);
    assert.match(text, /up to 3 topics at the same time/);
    assert.match(text, /nothing is merged without you/);
    assert.equal(selectReadyJobs(saved.get('che').jobs, Date.now(), 4).length, 4);
    assert.equal(saved.get('che').jobs.filter((job) => job.kind === 'self_development').length, 0, 'batching starts no blind coding job');
  } finally { globalThis.fetch = original; }
  // With no study work lined up, "batch them" is not hijacked.
  const fresh = new Map();
  const state = new CheState({ storage: storageFor(fresh) }, topicEnv(ADD_ANALYSIS));
  assert.equal(await state.batchStudies(), null);
});

test('batched study builds run up to three at once even while a change awaits the owner', async () => {
  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } });
  saved.set('che', { jobs: [], devices: {}, memories: [] });
  saved.set('study_batch_sessions', ['s']);
  saved.set('study_build_queue', ['Search Engine', 'Database', 'Bot', 'Git'].map((topic, i) => ({ id: `s:${i + 1}`, session: 's', order: i + 1, topic, request: `build ${topic}`, status: 'waiting', at: `2026-10-03T07:0${i}:00.000Z` })));
  saved.set('pending_self_update', { proposal: { summary: 'earlier', files: [] }, reviewed_at: new Date().toISOString() });
  const message = await state.advanceStudyBuilds();
  assert.match(message, /^My coding team started building Search Engine, Database and Bot from your study list at the same time \(jobs [0-9a-f]{8}, [0-9a-f]{8}, [0-9a-f]{8}\)\. 1 more topic is waiting after them\.$/);
  assert.equal(saved.get('che').jobs.filter((job) => job.study_build).length, 3);
  assert.equal(await state.advanceStudyBuilds(), null, 'never more than three at once');
});

test('a reviewed change never overwrites one the owner has not decided on; it waits and comes next', async () => {
  const saved = new Map();
  const files = { 'lib/main.dart': "class A {\n  String s = 'Ready. Type or speak a request.';\n}\n" };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_m, input) => {
        const system = String(input.messages?.[0]?.content || '');
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
        if (system.includes('Engineer') || system.includes('Implementation')) return { response: JSON.stringify({ summary: 'Friendlier banner', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready when you are.'" }] }) };
        return { response: 'ok' };
      },
    },
  };
  const { chat, state } = await pairedChat(env, saved);
  const first = { proposal: { summary: 'Search ranking', files: [{ path: 'server/cloudflare/brain_graph.js', content: 'x' }] }, request: 'search', reviewed_at: new Date().toISOString(), from_job: 'build-1' };
  saved.set('pending_self_update', first);
  const data = saved.get('che') || { jobs: [], devices: {}, memories: [] };
  data.jobs.unshift({ id: 'build-2', kind: 'self_development', status: 'queued', prompt: 'Change your code: improve the ready banner', request: 'banner', study_build: 's:2', study_topic: 'Database', created_at: new Date().toISOString(), attempts: 0 });
  saved.set('che', data);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(files);
  try {
    await state.processJobs();
    const job = saved.get('che').jobs.find((item) => item.id === 'build-2');
    assert.equal(job.status, 'complete');
    assert.match(job.owner_message, /The Database build finished and passed review, sir\. It waits behind the change you have not decided on yet/);
    assert.equal(saved.get('pending_self_update').from_job, 'build-1', 'the first change is untouched');
    assert.equal(saved.get('ready_self_updates').length, 1);
    const text = await (await chat('Discard that change')).text();
    assert.match(text, /Discarded, sir\./);
    assert.match(text, /The next reviewed change is ready, sir, for Database: Friendlier banner/);
    assert.match(text, /create the PR\\?" to open it/);
    assert.equal(saved.get('pending_self_update').from_job, 'build-2');
    assert.equal(saved.get('ready_self_updates').length, 0);
  } finally { globalThis.fetch = original; }
});

test('a handoff whose coding job could not start is not marked done, so the owner can retry it', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) } };
  const line = JSON.stringify({ id: 'h1', at: '2026-10-04T00:00:00Z', from: 'claude', to: 'che', text: 'Make the Ready banner say Ready, sir.' });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/contents/mailbox/claude.jsonl')) return new Response(JSON.stringify({ sha: 's', content: Buffer.from(`${line}\n`).toString('base64') }));
    // Injected: GitHub refuses the coding job (bad credentials).
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  };
  const { chat } = await pairedChat(env, saved);
  const replyOf = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'delta').map((l) => l.delta).join('');
  try {
    const first = await replyOf(await chat("do Claude's handoff"));
    assert.doesNotMatch(first, /already started/, first);
    assert.equal(saved.has('mail_handoff_done:claude:h1'), false, 'a failed start is not recorded as done');
    const second = await replyOf(await chat("do Claude's handoff"));
    assert.doesNotMatch(second, /already started/, second);
  } finally {
    globalThis.fetch = original;
  }
});

test('"build me a website" → CHE writes, checks and hosts a real page; "change the website" edits it', async () => {
  const saved = new Map();
  let builds = 0;
  const page = (footer) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fade Kings</title></head><body><header><h1>Fade Kings</h1></header><main><p>Fresh cuts.</p></main><footer>${footer}</footer></body></html>`;
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => {
      if (/web developer/.test(String(input.messages?.[0]?.content || ''))) { builds += 1; return { response: page(builds === 1 ? 'Open daily' : 'Open late') }; }
      return { response: 'ok' };
    } },
  };
  const { chat } = await pairedChat(env, saved);
  const replyOf = async (res) => {
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    return { text: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') };
  };
  const built = await replyOf(await chat('Build me a website for my barbershop called Fade Kings'));
  assert.match(built.text, /Your site "Fade Kings" is built, sir\. It passed my checks/, built.text);
  assert.equal(built.done.media_type, 'page');
  const url = built.done.media_url;
  assert.match(url, /^https:\/\/che\.example\/site\/[a-f0-9]{20}$/);
  const hosted = await worker.fetch(new Request(url), env);
  assert.equal(hosted.status, 200);
  assert.match(await hosted.text(), /Open daily/);
  const edited = await replyOf(await chat('change the website: say we are open late'));
  assert.match(edited.text, /I updated "Fade Kings" \(version 2\)/, edited.text);
  assert.equal(edited.done.media_url, url, 'same link after an edit');
  assert.match(await (await worker.fetch(new Request(url), env)).text(), /Open late/);
});

test('a request to ADD a GitHub capability reaches the coding pipeline (no "vectorRecall before initialization" crash)', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { const e = new Error('engines down'); e.category = 'temporary_cloud_unavailable'; throw e; } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': 'class A {}\n' });
  try {
    const text = (await (await chat('Can you add the ability to create a GitHub pull request from voice?')).text());
    assert.doesNotMatch(text, /before initialization|ReferenceError/, text);
    assert.match(text, /che_self_development/);
  } finally {
    globalThis.fetch = original;
  }
});

const deltaText = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'delta').map((l) => l.delta).join('');

test('a guessed "owner/repo" that GitHub 404s is prose, not a dead end: CHE continues instead of stopping', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Here is what I found.' }) } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{"message":"Not Found"}', { status: 404 }); };
  try {
    const reply = await deltaText(await chat('Research the fast/slow tradeoff in the github readme and summarize it'));
    assert.doesNotMatch(reply, /did not start a study|Could not inspect/, reply);
    assert.equal(calls.filter((u) => u === 'https://api.github.com/repos/fast/slow').length, 1, 'validated once, never retried');
  } finally {
    globalThis.fetch = original;
  }
});

function failingCrewEnv(counter, { recoverWith = '' } = {}) {
  return {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_m, input) => {
        counter.ai += 1;
        const system = String(input.messages?.[0]?.content || '');
        const user = String(input.messages?.[1]?.content || '');
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'banner', search_terms: ['Ready'], paths: ['lib/main.dart'] }) };
        if (system.includes('Review')) {
          counter.reviews += 1;
          const approved = Boolean(recoverWith) && user.includes(recoverWith);
          return { response: JSON.stringify({ approved, target_correct: approved, notes: approved ? [] : ['The banner text change breaks the VoiceOver label.'] }) };
        }
        if (system.includes('Engineer') || system.includes('Implementation')) {
          counter.engineer += 1;
          if (user.includes('Recovery of a failed job')) {
            counter.recoveryPrompts += 1;
            if (user.includes('VoiceOver label')) counter.sawReviewerReason += 1;
            if (recoverWith) return { response: JSON.stringify({ summary: 'Keep the label', edits: [{ path: 'lib/main.dart', find: "'Ready'", replace: `'${recoverWith}'` }] }) };
          }
          // The same two strategies every time (one per engineer).
          const v = counter.engineer % 2 ? 'Hi' : 'Hello';
          return { response: JSON.stringify({ summary: `Say ${v}`, edits: [{ path: 'lib/main.dart', find: "'Ready'", replace: `'${v}'` }] }) };
        }
        return { response: 'ok' };
      },
    },
  };
}

test('three failed attempts stop safely; recovery uses the evidence, never repeats them, and is bounded', async () => {
  const saved = new Map();
  const counter = { ai: 0, reviews: 0, engineer: 0, recoveryPrompts: 0, sawReviewerReason: 0 };
  const { chat } = await pairedChat(failingCrewEnv(counter), saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': "class A { String s = 'Ready'; }\n" });
  try {
    await deltaText(await chat('Update your code: make the ready banner friendlier'));
    const record = saved.get('che_failed_engineering');
    assert.ok(record, 'failure evidence retained');
    assert.ok(record.failed_strategies.length >= 1 && record.fingerprints.length >= 2);
    assert.ok(record.diagnosis);
    assert.ok(counter.engineer <= 6, `three rounds of two engineers at most, got ${counter.engineer}`);

    // Recovery 1: same two strategies come back → rejected as duplicates
    // before any reviewer spends tokens on them.
    const reviewsBefore = counter.reviews;
    await deltaText(await chat('Diagnose and recover the failed coding job'));
    assert.ok(counter.recoveryPrompts >= 1, 'engineers were told this is a recovery');
    assert.ok(counter.sawReviewerReason >= 1, 'engineers saw the earlier reviewer reason');
    assert.equal(counter.reviews, reviewsBefore, 'repeated strategies never reach review');
    assert.equal(saved.get('che_failed_engineering').recovery_runs, 1);
    assert.equal(saved.get('che_failed_engineering').recovery_lock_until, 0, 'lock released');

    await deltaText(await chat('Retry the failed coding job'));
    // Budget spent: the third recovery answers from the record with no AI.
    const aiBefore = counter.ai;
    const third = await deltaText(await chat('Recover the previous failed job again'));
    assert.match(third, /already ran 2 recovery passes/, third);
    assert.equal(counter.ai, aiBefore, 'no engines spent once the recovery budget is used');
  } finally {
    globalThis.fetch = original;
  }
});

test('a recovery already running is not started twice', async () => {
  const saved = new Map();
  const counter = { ai: 0, reviews: 0, engineer: 0, recoveryPrompts: 0, sawReviewerReason: 0 };
  const { chat } = await pairedChat(failingCrewEnv(counter), saved);
  saved.set('che_failed_engineering', { request: 'make the ready banner friendlier', failed_strategies: [], fingerprints: [], diagnosis: 'x', recovery_runs: 0, recovery_lock_until: Date.now() + 60_000 });
  const reply = await deltaText(await chat('Diagnose and recover the failed coding job'));
  assert.match(reply, /already recovering that coding job/);
  assert.equal(counter.ai, 0);
});

test('recovery can succeed with a materially different strategy, and the record is closed', async () => {
  const saved = new Map();
  const counter = { ai: 0, reviews: 0, engineer: 0, recoveryPrompts: 0, sawReviewerReason: 0 };
  const { chat } = await pairedChat(failingCrewEnv(counter, { recoverWith: 'Ready, sir' }), saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': "class A { String s = 'Ready'; }\n" });
  try {
    saved.set('che_failed_engineering', { request: 'Update your code: make the ready banner friendlier', failed_strategies: [{ engineer: 'Knox', outcome: 'review_rejected', why: 'The banner text change breaks the VoiceOver label.', edits: [] }], fingerprints: [], files: ['lib/main.dart'], diagnosis: 'Independent review rejected every candidate.', recovery_runs: 0, recovery_lock_until: 0 });
    const reply = await deltaText(await chat('Reopen the engineering record and recover that failed job'));
    assert.match(reply, /create the PR/, reply);
    assert.ok(saved.get('che_failed_engineering').resolved_at, 'record closed after a reviewed fix');
  } finally {
    globalThis.fetch = original;
  }
});

test('an engine outage during recovery neither queues a blind job nor spends the recovery budget', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { const e = new Error('engines down'); e.category = 'temporary_cloud_unavailable'; throw e; } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': "class A { String s = 'Ready'; }\n" });
  try {
    saved.set('che_failed_engineering', { request: 'Update your code: make the ready banner friendlier', failed_strategies: [], fingerprints: [], files: ['lib/main.dart'], diagnosis: 'x', recovery_runs: 1, recovery_lock_until: 0 });
    await deltaText(await chat('Diagnose and recover the failed coding job'));
    assert.equal((saved.get('che')?.jobs || []).filter((j) => j.kind === 'self_development').length, 0, 'no blind background job');
    assert.equal(saved.get('che_failed_engineering').recovery_runs, 1, 'outage did not spend the budget');
    assert.equal(saved.get('che_failed_engineering').recovery_lock_until, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('"set up the memory database" → steps; owner connects it in Keys; memory reports connected', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { chat } = await pairedChat(env, saved);
  const steps = await deltaText(await chat('Set up the memory database'));
  assert.match(steps, /supabase\.com/);
  assert.match(steps, /https:\/\/che\.example\/app/);
  const token = (await (await worker.fetch(new Request('https://che.example/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }) }), env)).json()).device_token;
  const call = (path, body) => worker.fetch(new Request(`https://che.example${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }), env);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/che_memory?') ? new Response('[]', { status: 200 }) : new Response('{}', { status: 404 }));
  try {
    const connected = await call('/api/keys/memory', { url: 'https://abc.supabase.co', token: 'eyJhbGciOiJIUzI1NiJ9.service-role-key-for-tests' });
    assert.equal(connected.status, 200);
    const keys = await (await call('/api/keys')).json();
    assert.equal(keys.memory.status, 'healthy');
    assert.equal(JSON.stringify(keys).includes('service-role-key'), false, 'the key never comes back');
    const again = await deltaText(await chat('Set up the memory database'));
    assert.match(again, /already connected/);
  } finally {
    globalThis.fetch = original;
  }
});

test('chat prompt carries the permanent link rule: real https address, named, never copy/paste', async () => {
  const saved = new Map();
  const systems = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { systems.push(String(input.messages?.[0]?.content || '')); return { response: 'Open Supabase: https://supabase.com/dashboard/new' }; } } };
  const { chat } = await pairedChat(env, saved);
  await deltaText(await chat('How do I make a Supabase account?'));
  const prompt = systems.find((s) => s.includes('ACCESSIBILITY')) || '';
  assert.match(prompt, /LINKS \(permanent rule\)/);
  assert.match(prompt, /full https:\/\/ address/);
  assert.match(prompt, /never tell him to copy or paste a URL/);
  assert.match(prompt, /never guess one/);
});

// ─── Saved coding jobs vs. engines that return nothing (Oct 3 recording) ─────
function emptyEngineEnv(mode) {
  const counter = { engineer: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_m, input) => {
        const system = String(input.messages?.[0]?.content || '');
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
        if (system.includes('Engineer')) {
          counter.engineer += 1;
          return mode.value === 'empty' ? { response: '' } : { response: JSON.stringify({ summary: 'Friendlier banner', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready when you are.'" }] }) };
        }
        return { response: 'ok' };
      },
    },
  };
  return { env, counter };
}
const BANNER_FILES = { 'lib/main.dart': "class A {\n  String s = 'Ready. Type or speak a request.';\n}\n" };
const dueNow = (saved) => { const data = saved.get('che'); for (const job of data.jobs) if (job.status === 'queued') job.retry_at = 0; saved.set('che', data); };

test('7/8. a saved coding job whose engines return nothing is requeued (not failed), resumes by itself, and is never duplicated', async () => {
  const saved = new Map();
  const mode = { value: 'empty' };
  const { env } = emptyEngineEnv(mode);
  const state = new CheState({ storage: storageFor(saved) }, env);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(BANNER_FILES);
  try {
    const request = 'Update your code: make the ready banner friendlier';
    const { job } = await state.queueSelfDevelopment({ request });
    dueNow(saved);
    await state.processJobs();
    let stored = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(stored.status, 'queued', 'empty engine output is retryable, not a terminal failure');
    assert.equal(stored.retry_count, 1);
    assert.ok(stored.retry_at > Date.now(), 'backs off before resuming');
    assert.doesNotMatch(String(stored.error), /exhausted|Your last answer was empty/);
    // The owner (or a handoff) asking again does not create a second job.
    const again = await state.queueSelfDevelopment({ request });
    assert.equal(again.deduplicated, true);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1);
    // Engines recover: the same job resumes on its own and finishes reviewed.
    mode.value = 'good';
    dueNow(saved);
    await state.processJobs();
    stored = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(stored.status, 'complete', stored.error);
    assert.equal(saved.get('pending_self_update').from_job, job.id);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1);
  } finally { globalThis.fetch = original; }
});

test('9. engines that never produce usable output cannot loop: the saved job stops after its retry limit', async () => {
  const saved = new Map();
  const { env, counter } = emptyEngineEnv({ value: 'empty' });
  const state = new CheState({ storage: storageFor(saved) }, env);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(BANNER_FILES);
  try {
    const { job } = await state.queueSelfDevelopment({ request: 'Update your code: make the ready banner friendlier' });
    for (let i = 0; i < 8; i += 1) { dueNow(saved); await state.processJobs(); }
    const stored = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.dead_letter, true);
    assert.equal(stored.retry_count, MAX_JOB_RETRIES);
    assert.ok(counter.engineer <= (MAX_JOB_RETRIES + 1) * 12, `engineer calls ${counter.engineer}`);
  } finally { globalThis.fetch = original; }
});

test('review: a recovery whose engines return nothing says nothing was saved (it is not queued); through the router that is an outage, which spends no recovery run', async () => {
  const saved = new Map();
  const { env } = emptyEngineEnv({ value: 'empty' });
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(BANNER_FILES);
  try {
    saved.set('che_failed_engineering', { request: 'Update your code: make the ready banner friendlier', failed_strategies: [], fingerprints: [], files: ['lib/main.dart'], diagnosis: 'x', recovery_runs: 0, recovery_lock_until: 0 });
    const reply = await deltaText(await chat('Diagnose and recover the failed coding job'));
    assert.doesNotMatch(reply, /saved the coding job|continue it automatically/i, reply);
    assert.match(reply, /nothing was saved/i, reply);
    assert.equal((saved.get('che')?.jobs || []).filter((j) => j.kind === 'self_development').length, 0);
    // The router turns an empty Workers AI answer into "all engines failed",
    // i.e. an outage: by design that spends no recovery run, and nothing
    // retries without the owner asking again.
    assert.equal(saved.get('che_failed_engineering').recovery_runs, 0);
  } finally { globalThis.fetch = original; }
});

test('review: a job waiting on its retry backoff blocks duplicates past 30 minutes; long coding runs are not treated as stale', async () => {
  const old = new Date(Date.now() - 45 * 60_000).toISOString();
  const data = { jobs: [{ id: 'j1', kind: 'self_development', status: 'queued', retry_count: 1, idempotency_key: 'k', created_at: old, updated_at: old }] };
  assert.equal(enqueueJob(data, { kind: 'self_development', prompt: 'p', idempotency_key: 'k' }).deduplicated, true);
  const fresh = { jobs: [{ id: 'j2', kind: 'chat', status: 'queued', retry_count: 0, idempotency_key: 'k2', created_at: old, updated_at: old }] };
  assert.equal(enqueueJob(fresh, { kind: 'chat', prompt: 'p', idempotency_key: 'k2' }).deduplicated, false, 'never-retried jobs keep the 30-minute window');

  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } });
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  saved.set('che', { jobs: [{ id: 'run', kind: 'self_development', status: 'running', attempts: 1, prompt: 'p', created_at: tenMinutesAgo, updated_at: tenMinutesAgo }], devices: {}, memories: [] });
  await state.processJobs();
  assert.equal(saved.get('che').jobs[0].status, 'running', 'a 10-minute coding run is still in flight, not requeued');
  // The watchdog alarm is set for when that run would count as interrupted.
  const alarms = [];
  const watched = new CheState({ storage: storageFor(saved, alarms) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } });
  await watched.scheduleWork();
  const due = Date.parse(tenMinutesAgo) + 20 * 60_000;
  assert.ok(alarms.some((t) => t >= due && t <= due + 5000), `alarm at stale deadline, got ${alarms}`);
});
