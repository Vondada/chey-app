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
const { default: worker, CheState, busyError, enqueueJob, selfUpdateChatIntent, isExistingChangeCommand, selectReadyJobs, shouldHandleSelfUpdateAction, MAX_JOB_ATTEMPTS } = mod;

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
