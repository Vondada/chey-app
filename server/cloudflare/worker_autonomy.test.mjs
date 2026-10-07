// Worker-level failure injection: background jobs, idempotency, Flagstaff
// duplicate/terminal packets, chat coding routes, merge intent and /health.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { researchKey, isSafeToStore, rememberKnowledge, markPureResearch } from './knowledge_cache.js';
import { COMPLETE_CHAT_ONLY_AUTONOMY_EXAM } from './autonomy_exam_fixture.mjs';

const generated = new URL('./.worker_autonomy.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, openAiVision, CheState, busyError, enqueueJob, selfUpdateChatIntent, isExistingChangeCommand, selectReadyJobs, shouldHandleSelfUpdateAction, MAX_JOB_ATTEMPTS, MAX_JOB_RETRIES } = mod;

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
  return { state, chat: (message, extra = {}) => send('/api/chat', { message, ...extra }, token), api: (path, body) => send(path, body, token) };
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

const OWNER_DISCOVERY_QUESTION = 'CHE, inspect your current repository and find the existing War Room implementation. Tell me the exact files/components responsible for it. Do not create or propose replacement architecture.';
const OWNER_SAFE_CODING_QUESTION = 'CHE, find one small, real improvement or missing regression test in your current codebase. Implement it using the current exact source, validate it, independently review it, and prepare one PR. Do not merge without my authorization.';

test('owner capability test: GPS reasoning stays in the reasoning lane without starting code or PR work', async () => {
  const saved = new Map();
  const question = 'CHE, explain why GPS satellites need corrections from both special and general relativity. Keep it understandable, but verify your reasoning.';
  let sawQuestion = false;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_model, input) => {
    sawQuestion ||= input.messages.some((message) => String(message.content).includes(question));
    return { response: 'Satellite speed slows its clock, while weaker gravity speeds its clock. Both effects change the timestamps used to measure distance.' };
  } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const reply = replyFromNdjson(await (await chat(question)).text());
    assert.equal(sawQuestion, true);
    assert.match(reply, /Satellite speed/);
    assert.ok(!(saved.get('che').jobs || []).some((job) => ['self_development', 'merge_pr'].includes(job.kind)));
    assert.equal(saved.get('pending_self_update'), undefined);
  } finally { globalThis.fetch = original; }
});

test('owner capability test: repository and autonomy discovery reads source without coding dispatch or prohibited access', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_CODING_RUNTIME: 'opencode', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls++; return { response: 'I cannot inspect your repository.' }; } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  const calls = [];
  const files = {
    'lib/main.dart': "import 'agents/che_war_room_screen.dart';\nvoid main() { CheWarRoomScreen(); }",
    'lib/agents/che_war_room_screen.dart': "import '../widgets/che_native_scene_world.dart';\nclass CheWarRoomScreen { CheNativeSceneWorld build() => CheNativeSceneWorld(); }",
    'lib/widgets/che_native_scene_world.dart': 'class CheNativeSceneWorld { final scene = "War Room"; }',
    'assets/office3d/warroom.html': '<h1>Unused War Room copy</h1>',
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('/search/code')) {
      const query = new URL(String(url)).searchParams.get('q').match(/^"(.*?)"/)?.[1] || '';
      return new Response(JSON.stringify({ items: Object.entries(files).filter(([, content]) => content.toLowerCase().includes(query.toLowerCase())).map(([path]) => ({ path })) }));
    }
    return GITHUB_OK(files)(url, init);
  };
  try {
    const response = await chat(OWNER_DISCOVERY_QUESTION);
    const text = replyFromNdjson(await response.text());
    assert.match(text, /lib\/agents\/che_war_room_screen\.dart/);
    assert.match(text, /lib\/widgets\/che_native_scene_world\.dart/);
    assert.match(text, /sha1/);
    assert.equal(aiCalls, 0);
    assert.ok(calls.some((c) => c.url.includes('/contents/')));
    assert.ok(!calls.some((c) => c.url.includes('/search/code')), 'when the pinned archive is unavailable, unpinned GitHub search cannot supply graph evidence');
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(!(saved.get('che').jobs || []).length);
    const callsBeforeAutonomyDiscovery = calls.length;
    await chat('CHE, find the autonomy and coding-runner implementation in your current codebase. Tell me the exact files/components responsible.');
    assert.ok(calls.slice(callsBeforeAutonomyDiscovery).some((c) => /\/git\/ref\/heads\/main|\/git\/trees\/|\/contents\/(?:lib|server)\//.test(c.url)), 'read-only autonomy discovery should inspect the pinned source');
    assert.equal(aiCalls, 0);
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(!(saved.get('che').jobs || []).length);

    const diagnosticPrompt = 'CHE, inspect your current GitHub main branch and investigate why your previous self-diagnostic entered the coding pipeline. Do not modify code, start a coding job, create a PR, merge, or deploy. Report only verified findings, and clearly separate anything inferred or unknown.';
    const diagnosticReply = replyFromNdjson(await (await chat(diagnosticPrompt)).text());
    assert.match(diagnosticReply, /VERIFIED/);
    assert.match(diagnosticReply, /INFERRED/);
    assert.match(diagnosticReply, /UNKNOWN/);
    assert.match(diagnosticReply, /sha1/, 'diagnostic must use the exact pinned repository head');
    assert.doesNotMatch(diagnosticReply, /health_check\.yml|diagnostic-tool|auto-remediate|build-manifest\.json|fix-version-mismatch/i, 'unsupported repository facts can never reach owner chat');
    assert.equal(aiCalls, 0, 'verified repository diagnostics bypass generic model generation');
    assert.ok(!(saved.get('che').jobs || []).length, 'read-only diagnostic creates no coding job');

    const callsBeforeProhibitedDiscovery = calls.length;
    await chat('CHE, find the War Room files in your codebase, but do not access the codebase; use only your existing knowledge.');
    assert.ok(calls.slice(callsBeforeProhibitedDiscovery).every((c) => c.url.includes('/contents/mailbox')), 'an explicit source-access prohibition must prevent repository source reads');
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(!(saved.get('che').jobs || []).length);

    const aiCallsBeforeProhibitedMutation = aiCalls;
    const prohibitedMutation = replyFromNdjson(await (await chat('CHE, inspect your current repository and find the War Room files; do not make any code changes.')).text());
    assert.match(prohibitedMutation, /lib\/agents\/che_war_room_screen\.dart/);
    assert.match(prohibitedMutation, /sha1/);
    assert.equal(aiCalls, aiCallsBeforeProhibitedMutation);
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.ok(!(saved.get('che').jobs || []).length);
  } finally { globalThis.fetch = original; }
});

test('current-turn policy blocks stale capabilities, old jobs and collaboration from escalating read-only work', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = {
    CHE_PAIR_CODE: '123456',
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    CHE_CODING_RUNTIME: 'opencode',
    CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { aiCalls += 1; return { response: 'VERIFIED: I reviewed the routing without changing it.' }; } },
  };
  const { chat, api } = await pairedChat(env, saved);
  saved.set('che_last_engineering_request', {
    request: 'Update your code: old authorized work that must not hijack this turn',
    integrate: true,
    at: new Date(Date.now() - 60_000).toISOString(),
  });
  const original = globalThis.fetch;
  const files = {
    'server/cloudflare/worker.js': 'function router() { return "routing"; }',
    'server/cloudflare/code_scout.js': 'export function currentTurnActionPolicy() { return "EXPLORE"; }',
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return GITHUB_OK(files)(url, init);
  };
  try {
    await (await chat(
      'CHE, inspect your current repository and diagnose why a coding job could hijack a read-only request. Do not modify code or start a coding job.',
      { requested_capabilities: ['self_development', 'background_work'] },
    )).text();
    assert.equal((saved.get('che').jobs || []).filter((j) => j.kind === 'self_development').length, 0);
    assert.equal(saved.has('che_runtime_last_session'), false);
    assert.equal(saved.has('pending_self_update'), false);
    assert.ok(calls.every((c) => c.method === 'GET'), 'read-only inspection never mutates GitHub');

    await (await chat('Work with Claude to review your routing and tell me what is wrong.')).text();
    assert.equal((saved.get('che').jobs || []).filter((j) => j.kind === 'self_development').length, 0, 'read-only collaboration cannot inherit the stale BUILD request');

    const legacy = await api('/api/change/request', {
      request: 'Investigate why the coding pipeline failed and report the findings without making code changes.',
    });
    assert.equal(legacy.status, 200);
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.chat_only, true);
    assert.equal(legacyBody.execution_mode, 'EXPLORE');
    assert.equal((saved.get('che').jobs || []).filter((j) => j.kind === 'self_development').length, 0);

    await (await chat("Che check your code and tell me what's wrong don't change nothing", {
      requested_capabilities: ['self_development'],
    })).text();
    assert.equal((saved.get('che').jobs || []).filter((j) => j.kind === 'self_development').length, 0, 'voice-like negation remains authoritative');
    assert.ok(aiCalls >= 1, 'read-only reasoning can still answer without BUILD');
  } finally {
    globalThis.fetch = original;
  }
});

test('authorized BUILD still dispatches exactly one OpenCode mutation session', async () => {
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456',
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    CHE_CODING_RUNTIME: 'opencode',
    CHE_OPENCODE_MODEL: 'openrouter/openai/gpt-oss-20b:free',
    AI: { run: async () => ({ response: 'unused' }) },
  };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/actions/workflows/che-opencode-runtime.yml/dispatches')) {
      dispatches += 1;
      assert.equal(init.method, 'POST');
      return new Response(null, { status: 204 });
    }
    if (u.includes('/contents/mailbox/runtime/')) return new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  };
  try {
    const reply = replyFromNdjson(await (await chat('Fix your routing system and merge it if tests pass.')).text());
    assert.match(reply, /OpenCode coding runner/i);
    assert.equal(dispatches, 1);
    assert.match(String(saved.get('che_runtime_last_session') || ''), /^ocr-[0-9a-f]{8}$/);
    await (await chat('Fix your routing system and merge it if tests pass.')).text();
    assert.equal(dispatches, 1, 'duplicate active owner request reuses its OpenCode session');
  } finally {
    globalThis.fetch = original;
  }
});

test('owner capability test: a PR-only request never reaches the auto-merging OpenCode workflow', async () => {
  const saved = new Map();
  const state = new CheState({ storage: storageFor(saved) }, { CHE_CODING_RUNTIME: 'opencode' });
  saved.set('che', { autonomy: true, jobs: [], devices: {}, memories: [] });
  let dispatches = 0;
  state.startOpenCodeSession = async () => { dispatches++; return { status: 202, session_id: 'ocr-1234abcd' }; };
  await state.selfDevelopmentReply(OWNER_SAFE_CODING_QUESTION);
  assert.equal(dispatches, 0, 'the runtime auto-merge lane cannot satisfy the owner merge hold');
});

test('legacy project-create route honors terminal chat-only isolation', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = {
    CHE_PAIR_CODE: '123456',
    AI: { run: async () => { aiCalls += 1; return { response: 'I would build it safely in chat only.' }; } },
  };
  const { api } = await pairedChat(env, saved);
  const brief = 'Answer in this chat only and do not create or modify code; explain how you would build me an app.';
  const res = await api('/api/project/create', { title: 'Hypothetical app', type: 'app', brief });
  const body = await res.json();
  assert.equal(res.status, 409, 'non-2xx so an installed client cannot announce a project');
  assert.equal(body.project_created, false);
  assert.equal(body.project, undefined);
  assert.match(body.detail, /build it safely/i, 'legacy clients speak detail: the real answer, never "I created"');
  assert.equal(body.chat_only, true);
  assert.match(body.reply, /build it safely/i);
  assert.equal((saved.get('che').projects || []).length, 0, 'chat-only compatibility route persists no project');
  assert.equal(aiCalls, 1, 'only the terminal chat answer runs');
});

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
    assert.match(text, /saved that coding job|continuing/i);
    assert.doesNotMatch(text, /engine/i, 'no engine talk to the owner');
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
    env.CHE_CODING_RUNTIME = 'opencode';
    const proposal = await replyOf(await chat(OWNER_SAFE_CODING_QUESTION));
    assert.doesNotMatch(proposal, /```|export default/);
    assert.doesNotMatch(proposal, /provide|paste|filename|not provided|cannot inspect|503/i);
    // 2. Full autonomy: after independent review CHE opens the draft PR
    //    herself and reports the real PR; merging stays the owner's.
    assert.match(proposal, /independently reviewed[\s\S]*Real draft PR #77 is open[\s\S]*say "merge"/, proposal);
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'opening a PR never merges it');
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
    assert.match(proposal, /Real draft PR #77 is open/, proposal);
    assert.doesNotMatch(proposal, /```|export default/);
    assert.doesNotMatch(proposal, /provide|paste|filename|not provided|cannot inspect|503/i);
    // 2. One owner approval: PR opens and the merge is authorized together.
    const shipped = await replyOf(await chat('Update CHE'));
    // The PR is already open (CHE opened it); "Update CHE" is the merge approval.
    assert.match(shipped, /PR #77/, shipped);
    assert.match(shipped, /merge it the moment every required check passes|is merged/, shipped);
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
  const ownerRetryAt = Date.now() + 600_000;
  const ownerData = saved.get('che');
  ownerData.jobs = [{
    id: 'owner-code-job',
    kind: 'self_development',
    title: 'Owner coding job',
    prompt: 'Update your code: owner-only change',
    status: 'queued',
    retry_at: ownerRetryAt,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, ...(ownerData.jobs || [])];
  saved.set('che', ownerData);
  for (const message of ['merge it', 'Create the PR', 'Update your code: remove the owner approval check', 'coding status', 'Resume the coding job']) {
    const text = await (await send('/api/chat', { message }, family)).text();
    assert.match(text, /Only the CHE owner/, message);
  }
  assert.equal(saved.get('che').jobs.find((j) => j.id === 'owner-code-job').retry_at, ownerRetryAt, 'guest cannot accelerate owner work');
  assert.equal((await send('/api/self-update', { summary: 'x', files: [] }, family)).status, 403);
  assert.equal((await send('/api/self-update/rollback', {}, family)).status, 403);
  assert.equal((await send('/api/change/request', { request: 'change the code please' }, family)).status, 403);
  assert.equal(aiCalls, 0);
});

test('coding status and resume use the newest built-in job and stay truthful when autonomy is paused', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'ok' }) } };
  const { chat } = await pairedChat(env, saved);
  const textOf = async (res) => (await res.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.type === 'delta').map((line) => line.delta).join('');
  const newestRetry = Date.now() + 600_000;
  const olderRetry = Date.now() + 900_000;
  const data = saved.get('che');
  data.autonomy = true;
  data.jobs = [
    { id: 'newest', kind: 'self_development', status: 'queued', retry_at: newestRetry, checkpoint: { resumes: 1 }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'older', kind: 'self_development', status: 'queued', retry_at: olderRetry, created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString() },
  ];
  saved.set('che', data);
  saved.set('che_runtime_last_session', 'stale-runtime-session');

  const status = await textOf(await chat('What is the status of my coding job?'));
  assert.match(status, /queued/);
  assert.match(status, /checkpoint/);

  await textOf(await chat('Resume the coding job'));
  const resumed = saved.get('che');
  assert.ok(resumed.jobs[0].retry_at <= Date.now() + 1000, 'newest queued job resumes immediately');
  assert.equal(resumed.jobs[1].retry_at, olderRetry, 'older queued job is untouched');

  const pausedRetry = Date.now() + 1_200_000;
  resumed.autonomy = false;
  resumed.jobs[0].retry_at = pausedRetry;
  saved.set('che', resumed);
  const pausedReply = await textOf(await chat('Resume the coding job'));
  assert.match(pausedReply, /autonomy is paused/i);
  assert.equal(saved.get('che').jobs[0].retry_at, pausedRetry, 'paused job is not falsely accelerated');
});

test('coding status reports a newer OpenCode session over an older queued built-in job', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { chat } = await pairedChat(env, saved);
  const textOf = async (res) => (await res.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.type === 'delta').map((line) => line.delta).join('');
  const data = saved.get('che');
  const older = new Date(Date.now() - 120_000).toISOString();
  data.jobs = [{ id: 'old-builtin', kind: 'self_development', status: 'queued', retry_at: Date.now() + 600_000, created_at: older, updated_at: older }];
  saved.set('che', data);
  saved.set('che_runtime_last_session', 'ocr-1234abcd');
  saved.set('che_runtime_last_session_at', new Date().toISOString());
  saved.set('che_runtime_last_request_summary', 'Get the newest CHE IPA onto my iPhone');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('/contents/') ? new Response('{}', { status: 404 }) : realFetch(url, init);
  try {
    const status = await textOf(await chat('coding status'));
    assert.match(status, /Get the newest CHE IPA onto my iPhone/);
    assert.match(status, /OpenCode runner/);
    assert.doesNotMatch(status, /old-builtin/);
    assert.match(await textOf(await chat('What happened to my coding job?')), /Get the newest CHE IPA onto my iPhone/);
    assert.match(await textOf(await chat('check the coding logs')), /Get the newest CHE IPA onto my iPhone/);
    saved.set('che_runtime_last_session_at', new Date(Date.now() - 600_000).toISOString());
    assert.match(await textOf(await chat('coding status')), /latest coding job is queued/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('coding status is read-only; failed OpenCode work recovers only through the background recovery path', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { state, chat } = await pairedChat(env, saved);
  const textOf = async (res) => (await res.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.type === 'delta').map((line) => line.delta).join('');
  saved.set('che_runtime_last_session', 'ocr-1234abcd');
  saved.set('che_runtime_last_session_at', new Date().toISOString());
  saved.set('che_runtime_last_request_summary', 'Fix coding status state reporting');
  saved.set('che_runtime_last_request', 'Fix coding status state reporting and preserve the full original owner request beyond the spoken summary.');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    if (path.includes('/contents/mailbox/runtime/ocr-1234abcd.json')) {
      const payload = btoa(JSON.stringify({ session_id: 'ocr-1234abcd', state: 'opencode_failed', failure: 'opencode failed' }));
      return new Response(JSON.stringify({ content: payload }), { status: 200 });
    }
    return original(url, init);
  };
  try {
    const status = await textOf(await chat('coding status'));
    assert.match(status, /OpenCode attempt failed/i);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 0, 'status polling never creates a recovery job');

    const recovered = await state.recoverOpenCodeFailure();
    assert.equal(recovered.recovered, true);
    const jobs = saved.get('che').jobs.filter((j) => j.kind === 'self_development');
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].request, /preserve the full original owner request beyond the spoken summary/);

    const again = await textOf(await chat('coding status'));
    assert.match(again, /latest coding job is queued/i);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1, 'status polling remains side-effect free after recovery');
  } finally {
    globalThis.fetch = original;
  }
});

test('persisted legacy OpenCode failure is observable without mutation and background recovery remains idempotent', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const { state, chat } = await pairedChat(env, saved);
  const textOf = async (res) => (await res.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.type === 'delta').map((line) => line.delta).join('');
  saved.set('che_runtime_last_session', 'ocr-1234abcd');
  saved.set('che_runtime_last_session_at', new Date().toISOString());
  saved.set('che_runtime_last_request_summary', 'Fix coding status state reporting');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    if (path.includes('/contents/mailbox/runtime/ocr-1234abcd.json')) {
      const payload = btoa(JSON.stringify({ session_id: 'ocr-1234abcd', state: 'blocked', failure: 'opencode_failed', models_tried: ['a/model'] }));
      return new Response(JSON.stringify({ content: payload }), { status: 200 });
    }
    return original(url, init);
  };
  try {
    const first = await textOf(await chat('coding status'));
    assert.match(first, /OpenCode attempt failed/i);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 0);

    const recovered = await state.recoverOpenCodeFailure();
    assert.equal(recovered.recovered, true);
    let jobs = saved.get('che').jobs.filter((j) => j.kind === 'self_development');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].request, 'Fix coding status state reporting', 'legacy records recover from the only request text they persisted');

    assert.equal(await state.recoverOpenCodeFailure(), null, 'a recovered terminal attempt cannot enqueue twice');
    const second = await textOf(await chat('coding status'));
    assert.match(second, /latest coding job is queued/i);
    jobs = saved.get('che').jobs.filter((j) => j.kind === 'self_development');
    assert.equal(jobs.length, 1, 'status polling cannot create a duplicate recovery job');
  } finally {
    globalThis.fetch = original;
  }
});

test('OpenCode terminal failure is recovered by the alarm path without owner status polling', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'ok' }) } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  saved.set('che_runtime_last_session', 'ocr-1234abcd');
  saved.set('che_runtime_last_session_at', new Date().toISOString());
  saved.set('che_runtime_last_request_summary', 'Fix coding status state reporting');
  saved.set('che_runtime_last_request', 'Fix coding status state reporting and keep the exact owner mission through automatic recovery.');
  saved.set('che_runtime_monitor_until', Date.now() + 3_600_000);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    if (path.includes('/contents/mailbox/runtime/ocr-1234abcd.json')) {
      const payload = btoa(JSON.stringify({ session_id: 'ocr-1234abcd', state: 'blocked', failure: 'opencode_failed' }));
      return new Response(JSON.stringify({ content: payload }), { status: 200 });
    }
    return original(url, init);
  };
  try {
    const recovered = await state.recoverOpenCodeFailure();
    assert.equal(recovered.recovered, true);
    const jobs = saved.get('che').jobs.filter((j) => j.kind === 'self_development');
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].request, /exact owner mission through automatic recovery/);
    assert.equal(saved.get('che_runtime_last_session_at'), '');
    assert.equal(saved.get('che_runtime_monitor_until'), 0);
    const again = await state.recoverOpenCodeFailure();
    assert.equal(again, null, 'a recovered terminal attempt cannot enqueue twice');
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1);
  } finally {
    globalThis.fetch = original;
  }
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
    assert.ok(counter.engineer <= 10, `existing bounded engineer allowance, got ${counter.engineer}`);

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
  const attemptsAtAiStart = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { attemptsAtAiStart.push(saved.get('che_failed_engineering').recovery_runs); const e = new Error('engines down'); e.category = 'temporary_cloud_unavailable'; throw e; } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = GITHUB_OK({ 'lib/main.dart': "class A { String s = 'Ready'; }\n" });
  try {
    saved.set('che_failed_engineering', { request: 'Update your code: make the ready banner friendlier', failed_strategies: [], fingerprints: [], files: ['lib/main.dart'], diagnosis: 'x', recovery_runs: 1, recovery_lock_until: 0 });
    await deltaText(await chat('Diagnose and recover the failed coding job'));
    assert.ok(attemptsAtAiStart.length > 0, 'AI work started');
    assert.ok(attemptsAtAiStart.every((runs) => runs === 2), 'the next recovery attempt was persisted before AI work');
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

const EXAM_ANSWER = `1. Verified from the stated ideal model: both arrive simultaneously because acceleration is independent of mass. Assumption: identical release conditions.\nassert a_10kg == a_50kg\n\n2. Verified from the function: it retains every reading unnecessarily. Real risks are non-numeric input, malformed packets, invalid bias, and an undefined NaN/infinity policy. It does not inherently divide by zero because a key is created only when a value is appended. A typed replacement should keep one running sum and count per sensor.\n\n3. Using the standard transfer equations, Δv1 = 2.426 km/s, Δv2 = 1.467 km/s, total = 3.893 km/s, t = π√(((r1+r2)/2)^3/μ) = 5.275 h, and mf = 2500 exp(-3893/(320×9.80665)) ≈ 723 kg. These are calculated values under the supplied ideal assumptions.\n\n4. A can own state_lock while waiting for valve_lock as B owns valve_lock while waiting for state_lock: AB-BA deadlock. Use one lock for coupled state, or enforce the same global lock order in both threads; RLock alone does not fix cross-thread inversion.\n\n5. I would discover the current source and SHA, save the objective/checkpoint, make the smallest patch, run targeted then broader tests, obtain independent verification, and roll back or recover on failure. I would then open a PR, wait for an authorized merge/deployment, verify the deployed version, and smoke-test production. If a provider dies, I preserve the same objective/checkpoint, classify the outage separately without consuming a logical implementation attempt, switch to a healthy provider, avoid a repeated failed strategy, and resume without duplicating a commit or PR. I did not execute any of those actions in this chat-only exam.`;

test('foreground full autonomy exam cannot be hijacked by a checkpointed coding job', async () => {
  const saved = new Map();
  const mode = { value: 'empty' };
  const { env } = emptyEngineEnv(mode);
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const originalRun = env.AI.run;
  env.AI.run = async (model, input) => {
    const system = String(input.messages?.[0]?.content || '');
    const allMessages = JSON.stringify(input.messages || []);
    if (allMessages.includes('CHE AUTONOMY EXAM')) return { response: EXAM_ANSWER };
    if (!system.includes('Architect') && !system.includes('Engineer') && !system.includes('Review') && !system.includes('Source Recovery')) {
      return { response: EXAM_ANSWER };
    }
    return originalRun(model, input);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = GITHUB_OK(BANNER_FILES);
  try {
    const request = 'Update your code: make the ready banner friendlier';
    const { job } = await state.queueSelfDevelopment({ request });
    dueNow(saved);
    await state.processJobs();
    const interrupted = saved.get('che').jobs.find((item) => item.id === job.id);
    assert.equal(interrupted.status, 'queued');
    const before = structuredClone(interrupted);

    const { chat, api } = await pairedChat(env, saved);
    const answer = await deltaText(await chat(COMPLETE_CHAT_ONLY_AUTONOMY_EXAM, { requested_capabilities: ['self_development', 'background_work'] }));
    assert.match(answer, /both arrive simultaneously/);
    assert.match(answer, /does not inherently divide by zero/);
    assert.match(answer, /2\.426 km\/s/);
    assert.match(answer, /AB-BA deadlock/);
    assert.match(answer, /preserve the same objective\/checkpoint/);

    const after = saved.get('che').jobs;
    assert.equal(after.length, 1, 'the exam creates no new job');
    assert.deepEqual(after[0], before, 'foreground chat does not alter the saved job');
    assert.equal(saved.has('pending_self_update'), false, 'no repository proposal was created');
    assert.equal(saved.has('last_self_update_pr'), false, 'no PR receipt was created');
    assert.equal(saved.has('last_self_update_deploy'), false, 'no deployment receipt was created');

    await deltaText(await chat(COMPLETE_CHAT_ONLY_AUTONOMY_EXAM));
    assert.equal(saved.get('che').jobs.length, 1, 'repeating the exam remains side-effect free');
    await deltaText(await chat('What is the status of my coding job?'));
    assert.equal(saved.get('che').jobs.length, 1, 'status is a read, not a new job');
    await deltaText(await chat('Resume the coding job'));
    assert.equal(saved.get('che').jobs.length, 1, 'resume targets the existing job');
    assert.equal(saved.get('che').jobs[0].id, job.id);

    const rejected = await api('/api/change/request', { request: COMPLETE_CHAT_ONLY_AUTONOMY_EXAM });
    assert.equal(rejected.status, 200, 'legacy mutation endpoint is safely rerouted to chat');
    const rerouted = await rejected.json();
    assert.equal(rerouted.chat_only, true);
    assert.match(rerouted.message, /both arrive simultaneously/);

    const hypothetical = await api('/api/change/request', {
      request: 'Fix your code only as a hypothetical example; answer in this chat only and do not modify your code.',
    });
    assert.equal(hypothetical.status, 200, 'hard repository prohibition stays chat-only on the legacy route');
    assert.equal((await hypothetical.json()).chat_only, true);
    assert.equal(saved.get('che').jobs.length, 1, 'contradictory hypothetical wording creates no coding job');

    mode.value = 'good';
    dueNow(saved);
    await state.processJobs();
    const resumed = saved.get('che').jobs.find((item) => item.id === job.id);
    assert.equal(resumed.status, 'complete', resumed.error);
    assert.equal(saved.get('che').jobs.length, 1, 'recovery completes without duplication');
    assert.equal(saved.get('pending_self_update').from_job, job.id);
  } finally { globalThis.fetch = originalFetch; }
});

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

test('saved coding job recovers a missing anchor automatically with the same job and reviewed proposal', async () => {
  const saved = new Map();
  const { env } = emptyEngineEnv({ value: 'good' });
  const originalRun = env.AI.run;
  let engineers = 0;
  let refreshReads = 0;
  env.AI.run = async (model, input) => {
    const system = String(input.messages?.[0]?.content || '');
    if (system.includes('Engineer')) {
      engineers += 1;
      if (engineers <= 2) return { response: JSON.stringify({ edits: [{ path: 'lib/main.dart', find: 'obsolete banner', replace: 'Ready when you are.' }] }) };
      const p = JSON.parse(input.messages[1].content);
      assert.equal(p.repository_sha, 'sha1');
      assert.ok(refreshReads >= 2, 'file was re-read before retry');
      assert.ok(p.failed_anchors.length > 0);
      assert.ok(p.inspected.some((f) => f.source.includes('Ready. Type or speak a request.')));
    }
    return originalRun(model, input);
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  const originalFetch = globalThis.fetch;
  const github = GITHUB_OK(BANNER_FILES);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/contents/lib/main.dart?ref=sha1')) refreshReads += 1;
    return github(url, init);
  };
  try {
    const { job } = await state.queueSelfDevelopment({ request: 'Update your code: make the ready banner friendlier' });
    const data = saved.get('che');
    data.jobs.find((j) => j.id === job.id).checkpoint = { genuine_passes: 2, fingerprints: [], failed_strategies: [], resumes: 1, round_offset: 2 };
    saved.set('che', data);
    dueNow(saved);
    await state.processJobs();
    const stored = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(stored.status, 'complete', stored.error);
    assert.equal(saved.get('che').jobs.length, 1);
    assert.equal(saved.get('pending_self_update').from_job, job.id);
    assert.ok(saved.get('pending_self_update').proposal.files.some((f) => f.content.includes('Ready when you are.')));
    assert.equal(stored.checkpoint, undefined);
    assert.doesNotMatch(String(stored.owner_message), /edits did not match.*3 implementation passes/);
  } finally { globalThis.fetch = originalFetch; }
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
  // The watchdog alarm is set for when that run would count as interrupted
  // (paper trading just ticked, so its hourly alarm comes later).
  saved.set('trading_paper_book', { last_tick: new Date().toISOString() });
  const alarms = [];
  const watched = new CheState({ storage: storageFor(saved, alarms) }, { CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } });
  await watched.scheduleWork();
  const due = Date.parse(tenMinutesAgo) + 20 * 60_000;
  assert.ok(alarms.some((t) => t >= due && t <= due + 5000), `alarm at stale deadline, got ${alarms}`);
});

test('an idle CHE still wakes hourly for paper-trading learning', async () => {
  const saved = new Map();
  saved.set('che', { jobs: [], devices: {}, memories: [], autonomy: false });
  saved.set('trading_paper_book', { last_tick: '2026-10-04T10:00:00.000Z' });
  const alarms = [];
  const state = new CheState({ storage: storageFor(saved, alarms) }, { CHE_DISABLE_KEYLESS_AI: '1' });
  await state.scheduleWork();
  assert.ok(alarms.length >= 1, 'an alarm is set with nothing else queued');
  assert.equal(alarms[alarms.length - 1], Math.max(Date.parse('2026-10-04T11:00:00.000Z'), alarms[alarms.length - 1]));
  assert.ok(alarms[alarms.length - 1] <= Math.max(Date.now() + 1000, Date.parse('2026-10-04T11:00:00.000Z')));
});

test('trading desk through chat: switch modes, connect, alerts said first, take the trade', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TRADOVATE_OAUTH_CLIENT_ID: '123', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'sec' };
  const { chat } = await pairedChat(env, saved);
  const say = async (m) => replyFromNdjson(await (await chat(m)).text());
  assert.match(await say('CHE, switch to live trading'), /Switched from paper trading.*to your NinjaTrader LIVE account, real money.*take the trade.*not connected yet/s);
  assert.equal(saved.get('trading_desk').mode, 'live');
  const connect = await say('connect my NinjaTrader account');
  assert.match(connect, /https:\/\/trader\.tradovate\.com\/oauth\?/);
  assert.match(connect, /password goes only to Tradovate/);
  // An entry CHE found is said before the reply to whatever the owner says next.
  saved.set('trading_desk', { ...saved.get('trading_desk'), alerts: [{ id: 'a1', paper_id: 'p1', at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, status: 'pending', announced: false, mode: 'live' }] });
  const next = await say("what's my trading mode");
  assert.match(next, /^Trade alert, sir, good entry on your LIVE account: buy 1 MES at 5820.*take the trade[\s\S]*You are on your NinjaTrader LIVE account/);
  assert.doesNotMatch(await say("what's my trading mode"), /Trade alert/, 'said once');
  // No live account chosen: the yes is answered honestly and nothing is placed.
  assert.match(await say('take the trade'), /Which live account.*Nothing was placed/);
  assert.equal(saved.get('trading_desk').alerts[0].status, 'pending');
  // Reading accounts needs the sign-in; CHE says so instead of guessing.
  assert.match(await say('list my trading accounts'), /could not read your live accounts.*not connected/);
  assert.match(await say('switch to paper trading'), /to paper trading/);
});

test('trading desk: the NinjaTrader sign-in page is public but only accepts CHE\'s one-time state', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TRADOVATE_OAUTH_CLIENT_ID: '123', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'sec' };
  await pairedChat(env, saved);
  const res = await worker.fetch(new Request('https://che.example/broker/tradovate/callback?code=x&state=forged'), env);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /invalid or expired/);
  assert.equal(saved.has('tradovate_auth'), false);
});

test('autonomy exam runs its levels back to back: each finished level starts the next at once', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const { state, chat } = await pairedChat(env, saved);
  const say = async (m) => replyFromNdjson(await (await chat(m)).text());
  assert.match(await say('CHE, run the autonomy exam'), /level 1, level 2, level 3, level 4, level 5.*each starting as soon as the one before finishes/);
  const examJobs = () => saved.get('che').jobs.filter((j) => j.kind === 'autonomy_exam');
  assert.equal(examJobs().length, 1, 'only the first level is queued');
  assert.equal(examJobs()[0].exam_level, 1);
  assert.deepEqual(examJobs()[0].exam_next, [2, 3, 4, 5]);
  assert.ok(!examJobs()[0].retry_at, 'no fixed wait');
  assert.match(await say('run the autonomy exam'), /already running.*level 1, then 2, 3, 4, 5/, 'no second chain');
  // Engines busy: the level waits to retry and holds the rest back.
  const ran = [];
  state.runAutonomyExamJob = async (job) => { ran.push(job.exam_level); return { id: job.id, status: 'queued', retry_at: Date.now() - 1, result: '', error: 'busy' }; };
  await state.processJobs();
  assert.equal(examJobs().length, 1, 'a retrying level does not start the next');
  // Each finished level (pass or fail) starts the next immediately.
  state.runAutonomyExamJob = async (job) => { ran.push(job.exam_level); return { id: job.id, status: job.exam_level === 3 ? 'failed' : 'complete', result: 'graded', owner_message: 'graded', error: '' }; };
  for (let i = 0; i < 6; i++) await state.processJobs();
  assert.deepEqual(ran, [1, 1, 2, 3, 4, 5]);
  assert.equal(examJobs().filter((j) => ['queued', 'running'].includes(j.status)).length, 0, 'the chain ends after level 5');
  // A level dead-lettered by the stale sweep (interrupted too often) still
  // starts the next level instead of stranding the rest of the exam.
  assert.match(await say('run the autonomy exam'), /started the autonomy exam/);
  const data = saved.get('che');
  const first = data.jobs.find((j) => j.kind === 'autonomy_exam' && j.status === 'queued');
  const earlier = new Set(data.jobs.map((j) => j.id));
  Object.assign(first, { status: 'running', attempts: 99, updated_at: new Date(Date.now() - 3600_000).toISOString() });
  saved.set('che', data);
  state.runAutonomyExamJob = async (job) => ({ id: job.id, status: 'complete', result: 'graded', owner_message: 'graded', error: '' });
  await state.processJobs();
  const after = saved.get('che').jobs.filter((j) => j.kind === 'autonomy_exam');
  assert.equal(after.find((j) => j.id === first.id).status, 'failed');
  assert.ok(after.some((j) => j.exam_level === 2 && !earlier.has(j.id)), 'level 2 started after the dead-lettered level 1');
  for (let i = 0; i < 6; i++) await state.processJobs();
  assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'autonomy_exam' && ['queued', 'running'].includes(j.status)).length, 0);
  // A single level runs alone.
  assert.match(await say('run autonomy exam level 3'), /started the autonomy exam, sir: level 3\./);
  assert.deepEqual(examJobs().find((j) => j.status === 'queued').exam_next, []);
});

test('memory-first: a verified owner fact is answered with zero AI engine calls', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'model reply' }; } } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; return new Response('{}', { status: 500 }); };
  try {
    // Remembering a fact that contains a URL saves it (it is not fetched as a page).
    assert.equal(replyFromNdjson(await (await chat('Remember that my Worker URL is https://che.example.workers.dev')).text()), 'I’ll remember that, sir.');
    assert.equal(aiCalls + providerCalls, 0, 'remembering a plain fact costs no AI either');
    aiCalls = 0;
    providerCalls = 0;
    const reply = replyFromNdjson(await (await chat("What's my Worker URL?")).text());
    assert.equal(reply, 'Your worker url is https://che.example.workers.dev, sir.');
    assert.equal(aiCalls, 0, 'no Workers AI call');
    assert.equal(providerCalls, 0, 'no external provider call');
    const ledger = saved.get('che_reliability_ledger');
    assert.equal(ledger.totals.memory_answers, 1);
    assert.ok(ledger.totals.tokens_saved > 0);
    assert.match(replyFromNdjson(await (await chat('reliability report')).text()), /1 answers from memory with no AI call/);
    // The memory list stays the authority: once the memory is deleted the
    // cached fact is no longer spoken.
    const d = saved.get('che');
    d.memories = [];
    saved.set('che', d);
    assert.notEqual(replyFromNdjson(await (await chat("What's my Worker URL?")).text()), 'Your worker url is https://che.example.workers.dev, sir.');
  } finally {
    globalThis.fetch = original;
  }
});

test('zero-pass unusable engine output is recoverable instead of terminal', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const { state } = await pairedChat(env, saved);
  const data = saved.get('che');
  data.jobs = [{ id: 'job-zero', kind: 'self_development', status: 'queued', prompt: 'fix the coding recovery path', retry_count: 0, attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  saved.set('che', data);
  state.runSelfDevelopmentJob = async (job) => {
    const error = new Error('stopped after 0 implementation passes because the engines then returned no usable output (empty or malformed answers).');
    error.failure_class = 'B';
    error.checkpoint = { genuine_passes: 0, fingerprints: [], failed_strategies: [], resumes: 1 };
    throw error;
  };
  await state.processJobs();
  const job = saved.get('che').jobs.find((j) => j.id === 'job-zero');
  assert.equal(job.status, 'queued');
  assert.equal(job.retry_count, 1, 'the zero-pass outage consumed one bounded recovery retry');
  assert.match(job.error, /0 implementation passes/, 'the real failure remains recorded');
  assert.equal(job.checkpoint.genuine_passes, 0);
  assert.ok(!job.owner_message, 'pre-implementation engine outage stays quiet while CHE retries');
});

test('control plane: a job interrupted by an engine failure keeps its checkpoint and the retry continues the same job quietly', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const { state } = await pairedChat(env, saved);
  const data = saved.get('che');
  data.jobs = [{ id: 'job-1', kind: 'self_development', status: 'queued', prompt: 'change the home status wording', retry_count: 0, attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  saved.set('che', data);
  const seen = [];
  state.runSelfDevelopmentJob = async (job) => {
    seen.push(job.checkpoint || null);
    if (!job.checkpoint) {
      const error = new Error('Engines returned no usable output after 1 implementation pass(es).');
      error.failure_class = 'B'; // FAILURE_CLASS.TEMPORARY_EXTERNAL
      error.checkpoint = { genuine_passes: 1, fingerprints: ['fp-1'], resumes: 1 };
      throw error;
    }
    return { id: job.id, status: 'complete', result: 'done', owner_message: 'done', error: '' };
  };
  await state.processJobs();
  let job = saved.get('che').jobs.find((j) => j.id === 'job-1');
  assert.equal(job.status, 'queued', 'retried, not failed');
  assert.deepEqual(job.checkpoint, { genuine_passes: 1, fingerprints: ['fp-1'], resumes: 1 });
  assert.ok(!job.owner_message, 'a recoverable engine failure is not announced');
  job.retry_at = 0;
  const d = saved.get('che');
  d.jobs = d.jobs.map((j) => (j.id === 'job-1' ? job : j));
  saved.set('che', d);
  await state.processJobs();
  job = saved.get('che').jobs.find((j) => j.id === 'job-1');
  assert.equal(job.status, 'complete');
  assert.deepEqual(seen[1], { genuine_passes: 1, fingerprints: ['fp-1'], resumes: 1 }, 'the same job resumed from its checkpoint');
  assert.equal(job.checkpoint, undefined, 'a finished job drops its checkpoint');
  const ledger = saved.get('che_reliability_ledger');
  assert.equal(ledger.totals.jobs_completed, 1);
  assert.equal(ledger.totals.recoveries, 1);
  assert.equal(ledger.totals.retries, 1, 'each retry is counted once, not re-added every pass');
  assert.equal(ledger.totals.owner_visible_failures, 0);
});

test('control plane keeps exam isolation: a late job from an older run cannot overwrite the current run, and a pass is never downgraded', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' }; // no GitHub: the level grades as failed
  const { state } = await pairedChat(env, saved);
  const pass = { level: 1, passed: true, checks: [], failed_checks: [] };
  saved.set('che_autonomy_exam', { run_id: 'run-b', results: { 1: pass } });
  const late = await state.runAutonomyExamJob({ id: 'old', exam_level: 1, exam_run_id: 'run-a' });
  assert.match(late.result, /Stale autonomy exam result ignored/);
  assert.deepEqual(saved.get('che_autonomy_exam').results[1], pass, 'older run did not overwrite');
  await state.runAutonomyExamJob({ id: 'same', exam_level: 1, exam_run_id: 'run-b' });
  assert.equal(saved.get('che_autonomy_exam').results[1].passed, true, 'a later failure in the same run cannot downgrade a pass');
});

test('autonomy exam: single levels queue behind a running exam and re-tests keep the other levels\' scores', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const { state, chat } = await pairedChat(env, saved);
  const say = async (m) => replyFromNdjson(await (await chat(m)).text());
  assert.match(await say('run autonomy exam level 3'), /started the autonomy exam, sir: level 3\./);
  assert.match(await say('run autonomy exam level 5'), /lined up level 5 right after it/);
  const running = saved.get('che').jobs.find((j) => j.kind === 'autonomy_exam' && j.status === 'queued');
  assert.deepEqual(running.exam_next, [5]);
  const runId = saved.get('che_autonomy_exam').run_id;
  state.runAutonomyExamJob = async (job) => {
    const stored = saved.get('che_autonomy_exam');
    stored.results[job.exam_level] = { level: job.exam_level, passed: job.exam_level === 3, failed_checks: [] };
    saved.set('che_autonomy_exam', stored);
    return { id: job.id, status: 'complete', result: 'graded', owner_message: '', error: '' };
  };
  for (let i = 0; i < 3; i++) await state.processJobs();
  const scores = saved.get('che_autonomy_exam');
  assert.equal(scores.run_id, runId);
  assert.deepEqual(Object.keys(scores.results).sort(), ['3', '5'], 'level 5 ran in the same run and level 3 was kept');
  // Re-testing level 5 alone keeps level 3's score and replaces only level 5.
  assert.match(await say('run autonomy exam level 5'), /started the autonomy exam, sir: level 5\./);
  const retest = saved.get('che_autonomy_exam');
  assert.notEqual(retest.run_id, runId);
  assert.deepEqual(Object.keys(retest.results), ['3']);
  // A full exam starts a clean score.
  for (let i = 0; i < 2; i++) await state.processJobs();
  assert.match(await say('run the autonomy exam'), /level 1, level 2, level 3, level 4, level 5/);
  assert.deepEqual(saved.get('che_autonomy_exam').results, {});
});

test('final review: a verified research-cache hit ends the turn with zero research, panel or model calls', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'model reply' }; } } };
  const { chat } = await pairedChat(env, saved);
  const question = 'Research and compare sources on the latest provider limits';
  const now = Date.now();
  saved.set(`kc:${researchKey(question)}`, { key: researchKey(question), answer: 'Groq allows 30 requests a minute on the free tier.', source: 'research_library', sources: ['https://console.groq.com/docs/rate-limits'], limitation: '', confidence: 0.85, verified_at: now - 60_000, expires_at: now + 3600_000, volatile: true, pure: true });
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; return new Response('{}', { status: 500 }); };
  try {
    const reply = replyFromNdjson(await (await chat(question)).text());
    assert.match(reply, /Groq allows 30 requests a minute/);
    assert.match(reply, /console\.groq\.com/);
    assert.equal(aiCalls, 0, 'no Workers AI call (no model panel, no chat model)');
    assert.equal(providerCalls, 0, 'no research fetch or provider call');
    assert.equal(saved.get('che_reliability_ledger').totals.memory_answers, 1);
    // A request to DO something with the same facts is never short-circuited:
    // the action and its permission checks must run.
    const actionQ = 'Email John the latest provider limits';
    saved.set(`kc:${researchKey(actionQ)}`, { ...saved.get(`kc:${researchKey(question)}`), key: researchKey(actionQ) });
    await (await chat(actionQ)).text();
    assert.ok(aiCalls + providerCalls > 0, 'an action request runs the full path');
    aiCalls = 0; providerCalls = 0;
    // A cached result from a turn that also ran actions (not marked pure) is not reused alone.
    const mixedQ = 'Research the current GPU prices';
    saved.set(`kc:${researchKey(mixedQ)}`, { ...saved.get(`kc:${researchKey(question)}`), key: researchKey(mixedQ), pure: false });
    await (await chat(mixedQ)).text();
    assert.ok(aiCalls + providerCalls > 0, 'only pure research answers are reused without inference');
    // Expired volatile research is not reused: the normal path runs again.
    saved.set(`kc:${researchKey(question)}`, { ...saved.get(`kc:${researchKey(question)}`), verified_at: now - 2 * 3600_000 });
    await (await chat(question)).text();
    assert.ok(aiCalls + providerCalls > 0, 'stale knowledge is re-checked, never spoken as current');
  } finally {
    globalThis.fetch = original;
  }
});

test('final review: the knowledge cache checks the WHOLE stored value for secrets, not just its first 500 characters', async () => {
  const late = `${'Long research summary. '.repeat(60)} The admin password is hunter2 and the api key is sk-live-abc.`;
  assert.ok(late.indexOf('password') > 500);
  assert.equal(isSafeToStore(late), false);

  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
  assert.equal(await rememberKnowledge(storage, { key: 'research:x', answer: late }), null);
  assert.equal(m.size, 0, 'nothing was persisted');
  assert.equal(await rememberKnowledge(storage, { key: 'research:y', answer: 'fine', limitation: `${'x '.repeat(400)} seed phrase: alpha beta` }), null, 'the limitation is persisted too, so it is checked too');
  assert.ok(await rememberKnowledge(storage, { key: 'research:z', answer: `${'Rate limits per minute vary by plan. '.repeat(40)}` }), 'ordinary long research still caches');
});

test('five-layer exam end to end: a layer queues as a job, an engine outage retries it ungraded, a real answer is graded and spoken', async () => {
  const saved = new Map();
  let answer = null;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { if (!answer) throw Object.assign(new Error('provider 503'), { status: 503 }); return { response: answer }; } } };
  const { state, chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    assert.match(replyFromNdjson(await (await chat('run the five layer exam layer 1')).text()), /five-layer exam, sir: layer 1/);
    let job = saved.get('che').jobs.find((j) => j.kind === 'reasoning_exam');
    assert.equal(job.exam_layer, 1);
    await state.processJobs();
    job = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(job.status, 'queued', 'an outage is retried, not scored');
    assert.deepEqual(saved.get('che_reasoning_exam').results, {}, 'no grade was recorded during the outage');
    answer = 'Using h = 1/2 g t^2: 45 = 5 t^2, so t = 3 s and v = g t = 30 m/s.\nASSERT time_s=3 speed_ms=30';
    const d = saved.get('che');
    d.jobs = d.jobs.map((j) => (j.id === job.id ? { ...j, retry_at: 0 } : j));
    saved.set('che', d);
    await state.processJobs();
    job = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(job.status, 'complete');
    assert.equal(saved.get('che_reasoning_exam').results[1].passed, true);
    assert.match(replyFromNdjson(await (await chat('five layer exam results')).text()), /Layer 1, Constraint reasoning: passed/);
  } finally {
    globalThis.fetch = original;
  }
});

test('objective graph through the Worker: steps run as real jobs, independent ones together, and the objective completes', async () => {
  const saved = new Map();
  const prompts = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (model, input) => { const p = JSON.stringify(input.messages || input); prompts.push(p); return { response: p.includes('Compare the two notes') ? 'Comparison written.' : 'Note written.' }; } } };
  const { state, api } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const bad = await api('/api/objective/create', { objective: 'loop', nodes: [{ id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'y', depends_on: ['a'] }] });
    assert.equal(bad.status, 400, 'a cyclic plan is refused');
    const res = await (await api('/api/objective/create', { objective: 'Two notes and a comparison', nodes: [
      { id: 'a', prompt: 'Write a short note about apples' },
      { id: 'b', prompt: 'Write a short note about pears' },
      { id: 'c', prompt: 'Compare the two notes', depends_on: ['a', 'b'] },
    ] })).json();
    assert.equal(res.started, 2, 'the two independent steps start together');
    await state.processJobs();
    let o = saved.get('che').objectives[0];
    assert.deepEqual(o.nodes.map((n) => n.status), ['complete', 'complete', 'running'], 'the dependent step starts only after both');
    await state.processJobs();
    o = saved.get('che').objectives[0];
    assert.equal(o.status, 'complete');
    assert.equal(o.nodes[2].output, 'Comparison written.');
    assert.ok(prompts.some((p) => p.includes('Compare the two notes') && p.includes('Note written.')), 'the dependent step received the verified upstream results');
    assert.match((await (await api('/api/objectives', {})).json()).spoken[0], /3 of 3 steps done/);
  } finally {
    globalThis.fetch = original;
  }
});

test('resource finder through chat: answered from the real list with zero AI calls; no match falls through to the normal path', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'model reply' }; } } };
  const { chat } = await pairedChat(env, saved);
  const { _clearCatalogCache } = await import('./resource_catalogs.js');
  _clearCatalogCache();
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).includes('raw.githubusercontent.com/punkpeye/awesome-mcp-servers')) return new Response('## Productivity\n- [notion-mcp](https://github.com/x/notion-mcp) - MCP server for Notion pages and databases\n- [notion-plain](http://plain.example/notion) - Notion MCP server over plain http\n', { status: 200 });
    return new Response('{}', { status: 500 });
  };
  try {
    const reply = replyFromNdjson(await (await chat('is there an MCP server for Notion')).text());
    assert.match(reply, /From awesome-mcp-servers, 1 MCP server match for "notion", sir: 1, notion-mcp/);
    assert.equal(aiCalls, 0);
    assert.ok(fetched.every((u) => u.includes('raw.githubusercontent.com')), 'only the list itself was read');
    const openedRaw = await (await chat('open number one')).text();
    assert.match(replyFromNdjson(openedRaw), /Number 1, notion-mcp, sir: https:\/\/github\.com\/x\/notion-mcp/);
    assert.ok(openedRaw.includes('"open_url":"https://github.com/x/notion-mcp"'), 'the app receives the link to open');
    assert.equal(aiCalls, 0, 'a spoken choice costs no AI either');
    const picked = await (await chat('pick number one')).text();
    assert.match(replyFromNdjson(picked), /Number 1, notion-mcp/);
    assert.ok(!picked.includes('open_url'), 'only "open" asks the app to open a link');
    await (await chat('is there an MCP server for Zzyzx')).text();
    assert.ok(aiCalls > 0 || fetched.some((u) => !u.includes('raw.githubusercontent.com')), 'no match: the normal path answers instead of a dead end');
    assert.doesNotMatch(replyFromNdjson(await (await chat('open number one')).text()), /notion-mcp/, 'an intervening reply retires the older list');
  } finally {
    globalThis.fetch = original;
  }
});

test('research cache: informational verbs still hit with zero inference, but conversation-dependent queries do not', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { aiCalls += 1; return { response: 'fresh model answer' }; } } };
  const { chat } = await pairedChat(env, saved);
  const storage = storageFor(saved);
  const question = 'research how to make sourdough';
  await rememberKnowledge(storage, { key: researchKey(question), answer: 'Use a mature starter.', source: 'research_library', confidence: 0.95, ttl_ms: 60000 }, Date.now());
  await markPureResearch(storage, question);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const cached = replyFromNdjson(await (await chat(question)).text());
    assert.match(cached, /mature starter/);
    assert.equal(aiCalls, 0, 'make inside an informational research query is not misclassified as an external action');

    for (const mixed of ['research how to make sourdough and email it to John', 'research how to make sourdough, then text Sam', 'can you research how to make sourdough and share it']) {
      await rememberKnowledge(storage, { key: researchKey(mixed), answer: 'Use a mature starter.', source: 'research_library', confidence: 0.95, ttl_ms: 60000 }, Date.now());
      await markPureResearch(storage, mixed);
      aiCalls = 0;
      await (await chat(mixed)).text();
      assert.ok(aiCalls > 0, `a research turn with a chained action is never answered from cache: ${mixed}`);
    }

    aiCalls = 0;
    const contextual = replyFromNdjson(await (await chat('research it', {
      history: [
        { role: 'user', content: 'We are discussing project B.' },
        { role: 'assistant', content: 'Understood.' },
      ],
    })).text());
    assert.notEqual(contextual, 'Use a mature starter.', 'a message-only cache entry cannot answer a context-dependent query');
    assert.ok(aiCalls > 0, 'conversation context falls through to reasoning instead of the zero-inference shortcut');
  } finally {
    globalThis.fetch = original;
  }
});

test('T17 truthful status: with autonomy paused, "resume the coding job" never claims it resumed and leaves the job untouched', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'x' }) } };
  const { chat } = await pairedChat(env, saved);
  const data = saved.get('che');
  const retryAt = Date.now() + 3600_000;
  data.autonomy = false;
  data.jobs = [{ id: 'job-p', kind: 'self_development', status: 'queued', prompt: 'p', retry_count: 1, attempts: 1, retry_at: retryAt, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  saved.set('che', data);
  const reply = replyFromNdjson(await (await chat('Resume the coding job')).text());
  assert.doesNotMatch(reply, /\bI resumed\b/i);
  assert.match(reply, /paused/i);
  assert.equal(saved.get('che').jobs[0].retry_at, retryAt, 'paused job not rescheduled');
});

test('free engines only: a stored OpenAI key is never used for vision, voice or live voice unless paid AI is turned on', async () => {
  const calls = [];
  const fetcher = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); };
  const out = await openAiVision({ OPENAI_API_KEY: 'sk-test' }, { name: 'a.png', mediaType: 'image/png', base64: 'AAAA' }, 'what is this', fetcher);
  assert.ok(out.error, 'no paid vision call');
  assert.equal(calls.length, 0);
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_OPENAI_API_KEY: 'sk-test', AI: { run: async () => ({ response: 'ok' }) } };
  const { api } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 200 }); };
  try {
    const live = await api('/api/live/token', {});
    assert.equal(live.status, 503);
    assert.doesNotMatch(JSON.stringify(await live.json()), /openai|engine|key/i);
    assert.ok(!seen.some((u) => u.includes('api.openai.com')), 'no paid live-voice session was created');
  } finally {
    globalThis.fetch = original;
  }
});

test('engines all busy: CHE answers from research she already has, with no word about engines', async () => {
  const saved = new Map();
  const busy = () => { const e = new Error('all engines busy'); e.category = 'temporary_cloud_unavailable'; e.status = 503; throw e; };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => busy() } };
  const { chat } = await pairedChat(env, saved);
  const question = 'research the boiling point of water at sea level';
  const now = Date.now();
  saved.set(`kc:${researchKey(question)}`, { key: researchKey(question), answer: 'Water boils at 100 degrees Celsius (212 Fahrenheit) at sea level.', source: 'research_library', sources: ['https://en.wikipedia.org/wiki/Boiling_point'], limitation: '', confidence: 0.85, verified_at: now - 60_000, expires_at: now + 3600_000, volatile: false });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const res = await chat(`${question} and explain why`);
    const text = res.status === 200 ? replyFromNdjson(await res.text()) : JSON.stringify(await res.json());
    assert.doesNotMatch(text, /engine|route|provider|switching/i, 'never about engines');
  } finally {
    globalThis.fetch = original;
  }
});

test('free engines only: the paid ElevenLabs voice is never called unless paid AI is on', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ELEVENLABS_API_KEY: 'el', CHE_ELEVENLABS_VOICE_ID: 'v', AI: { run: async () => { throw new Error('tts down'); } } };
  const { api } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 500 }); };
  try {
    await api('/api/voice/synthesize', { text: 'hello sir' });
    assert.ok(!seen.some((u) => u.includes('elevenlabs.io')), 'no paid voice call');
  } finally {
    globalThis.fetch = original;
  }
});

test('engines busy on a compound research request: no partial answer is passed off as complete; the full request is queued', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { const e = new Error('all engines busy'); e.category = 'temporary_cloud_unavailable'; e.status = 503; throw e; } } };
  const { chat } = await pairedChat(env, saved);
  const q = 'research the boiling point of water at sea level and explain why';
  const now = Date.now();
  saved.set(`kc:${researchKey(q)}`, { key: researchKey(q), answer: 'Water boils at 100 degrees Celsius (212 Fahrenheit) at sea level.', source: 'research_library', sources: [], limitation: '', confidence: 0.85, verified_at: now - 60_000, expires_at: now + 3600_000, volatile: false });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const res = await chat(q);
    const body = res.status === 200 ? replyFromNdjson(await res.text()) : JSON.stringify(await res.json());
    assert.doesNotMatch(body, /engine/i);
    if (res.status === 200) assert.ok(false, 'a partial research fact must not be returned as the full answer');
    assert.ok((saved.get('che').jobs || []).some((j) => j.prompt === q), 'the full request continues as a background job');
  } finally {
    globalThis.fetch = original;
  }
});

test('engines busy while autonomy is paused: CHE says the request is saved and paused, never "shortly"', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { const e = new Error('all engines busy'); e.category = 'temporary_cloud_unavailable'; e.status = 503; throw e; } } };
  const { chat } = await pairedChat(env, saved);
  const d = saved.get('che'); d.autonomy = false; saved.set('che', d);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  try {
    const res = await chat('Why is the sky blue in the evening?');
    const body = await res.json();
    assert.match(body.detail, /paused/i);
    assert.match(body.detail, /resume/i);
    assert.doesNotMatch(body.detail, /shortly|engine/i);
  } finally {
    globalThis.fetch = original;
  }
});

// ---- Mission acceptance through the Worker (cognitive-execution mission) ----

test('A5 + A18 + A6: an engine outage mid-mission keeps the mission; the SAME node resumes after a Worker restart and the mission completes', async () => {
  const saved = new Map();
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => {
    calls += 1;
    if (calls === 1) { const e = new Error('503 Service Unavailable: engine overloaded'); e.status = 503; e.category = 'temporary_cloud_unavailable'; throw e; }
    return { response: 'Step done.' };
  } } };
  const { state, api } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const created = await (await api('/api/objective/create', { objective: 'Two-step mission', nodes: [{ id: 'a', prompt: 'Draft the plan' }, { id: 'b', prompt: 'Review the plan', depends_on: ['a'] }] })).json();
    assert.equal(created.started, 1);
    await state.processJobs();
    let data = saved.get('che');
    let node = data.objectives[0].nodes[0];
    const job = data.jobs.find((j) => j.id === node.job_id);
    assert.equal(job.status, 'queued', 'the outage is retried, not failed');
    assert.equal(node.status, 'running', 'the mission still holds the same node');
    // Worker restart/redeploy: a brand-new Durable Object instance on the same storage.
    const restarted = new CheState({ storage: storageFor(saved) }, env);
    job.retry_at = 0;
    data.jobs = data.jobs.map((j) => (j.id === job.id ? job : j));
    saved.set('che', data);
    await restarted.processJobs();
    data = saved.get('che');
    node = data.objectives[0].nodes[0];
    assert.equal(node.status, 'complete');
    assert.equal(node.job_id, job.id, 'the same node and job resumed; nothing restarted');
    assert.equal(data.jobs.filter((j) => j.node_id === 'a').length, 1, 'no duplicate job for the node');
    await restarted.processJobs();
    assert.equal(saved.get('che').objectives[0].status, 'complete');
  } finally {
    globalThis.fetch = original;
  }
});

test('A7: a mission step already answered in verified research memory finishes with zero model calls', async () => {
  const saved = new Map();
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: 'model' }; } } };
  const { api } = await pairedChat(env, saved);
  const question = 'What is the capital of Australia?';
  await rememberKnowledge(storageFor(saved), { key: researchKey(question), answer: 'Canberra is the capital of Australia.', source: 'research_library', confidence: 0.9 });
  const before = calls;
  const res = await (await api('/api/objective/create', { objective: 'Geography', nodes: [{ id: 'q', prompt: question }] })).json();
  assert.equal(res.started, 0, 'nothing queued');
  const node = saved.get('che').objectives[0].nodes[0];
  assert.equal(node.status, 'complete');
  assert.equal(node.output, 'Canberra is the capital of Australia.');
  assert.equal(node.verification.by, 'verified_memory');
  assert.equal(calls, before, 'zero model calls');
  assert.equal(saved.get('che').objectives[0].status, 'complete');
});

test('A8: a CI-failed event repairs only the affected node by itself; non-owners cannot change a mission', async () => {
  const saved = new Map();
  const prompts = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { prompts.push(JSON.stringify(input.messages)); return { response: 'Done.' }; } } };
  const { state, api } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const { objective } = await (await api('/api/objective/create', { objective: 'Fix X', nodes: [{ id: 'fix', prompt: 'Fix X' }, { id: 'note', prompt: 'Write release note' }] })).json();
    await state.processJobs();
    assert.equal(saved.get('che').objectives[0].status, 'complete');
    const out = await (await api('/api/objective/event', { id: objective.id, event: { id: 'ci-77', type: 'ci_failed', node_id: 'fix', evidence: 'Worker tests failed: health route' } })).json();
    assert.equal(out.started, 1, 'the failed node is requeued with a recovery strategy');
    const dup = await (await api('/api/objective/event', { id: objective.id, event: { id: 'ci-77', type: 'ci_failed', node_id: 'fix', evidence: 'Worker tests failed: health route' } })).json();
    assert.equal(dup.duplicate, true, 'the same CI event is handled once');
    await state.processJobs();
    const o = saved.get('che').objectives[0];
    assert.equal(o.status, 'complete');
    assert.equal(o.nodes.find((n) => n.id === 'fix').strategy, 'fix_reported_failure');
    assert.ok(prompts.some((p) => p.includes('failed verification') && p.includes('health route')), 'the repair saw the CI evidence');
    assert.equal(saved.get('che').jobs.filter((j) => j.node_id === 'note').length, 1, 'the healthy node was not re-run');
    // Owner boundary: a non-owner tenant cannot mutate or inject events.
    const guest = await worker.fetch(new Request('https://che.example/api/objective/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: objective.id, event: { type: 'ci_failed', node_id: 'fix' } }) }), env);
    assert.ok([401, 403].includes(guest.status));
  } finally {
    globalThis.fetch = original;
  }
});

test('voice: "mission status" speaks the live mission graph with zero model calls', async () => {
  const saved = new Map();
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: 'x' }; } } };
  const { chat, api } = await pairedChat(env, saved);
  assert.match(replyFromNdjson(await (await chat('mission status')).text()), /No mission is in progress/);
  await api('/api/objective/create', { objective: 'Fix the microphone problem', nodes: [{ id: 'a', prompt: 'find it' }, { id: 'b', prompt: 'fix it', depends_on: ['a'] }] });
  const before = calls;
  assert.match(replyFromNdjson(await (await chat("how's my mission going?")).text()), /Fix the microphone problem: 0 of 2 steps done, 1 running/);
  assert.equal(calls, before);
});

test('app builds by voice: CHE starts the build herself, reports only the real result, and repairs a code failure on her own', async () => {
  const saved = new Map();
  let aiCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => { aiCalls += 1; return { response: 'x' }; } } };
  const { state, chat } = await pairedChat(env, saved);
  const say = async (m) => replyFromNdjson(await (await chat(m)).text());
  const dispatched = [];
  let runState = { status: 'in_progress', conclusion: null };
  let steps = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/dispatches')) { dispatched.push({ u, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
    if (u.includes('/runs?event=workflow_dispatch')) return new Response(JSON.stringify({ workflow_runs: [{ id: 41, html_url: 'https://github.com/o/r/actions/runs/41', head_sha: 'abc1234', created_at: new Date().toISOString(), ...runState }] }), { status: 200 });
    if (u.includes('/actions/runs/41/jobs')) return new Response(JSON.stringify({ jobs: [{ steps }] }), { status: 200 });
    return new Response('{}', { status: 500 });
  };
  const advance = async () => {
    const d = saved.get('che');
    for (const j of d.jobs) if (j.kind === 'verify_app_build' && j.status === 'queued') j.retry_at = 0;
    saved.set('che', d);
    await state.processJobs();
  };
  try {
    assert.match(await say('update my phone'), /started your app update/);
    assert.equal(dispatched[0].u, 'https://api.github.com/repos/o/r/actions/workflows/che-shorebird.yml/dispatches');
    assert.match(await say('is the app build done yet?'), /still building/);
    await advance();
    assert.equal(saved.get('che').jobs.find((j) => j.kind === 'verify_app_build').status, 'queued', 'still waiting; not called done');
    runState = { status: 'completed', conclusion: 'success' };
    steps = [{ name: 'Shorebird patch', conclusion: 'success' }];
    await advance();
    const done = saved.get('che').jobs.find((j) => j.kind === 'verify_app_build');
    assert.equal(done.status, 'complete');
    assert.match(done.owner_message, /Close and reopen me/);
    assert.match(await say('app build status'), /ready, sir/);
    // A full build that fails in the app code: CHE starts the repair herself.
    assert.match(await say('build a new iPhone app'), /started a new iPhone app build/);
    assert.equal(dispatched[1].u, 'https://api.github.com/repos/o/r/actions/workflows/che-iphone-ipa.yml/dispatches');
    runState = { status: 'completed', conclusion: 'failure' };
    steps = [{ name: 'Flutter analyze', conclusion: 'failure' }];
    await advance();
    const failed = saved.get('che').jobs.find((j) => j.kind === 'verify_app_build' && j.build_mode === 'release');
    assert.equal(failed.status, 'failed');
    assert.match(failed.owner_message, /failed, sir, at: Flutter analyze[\s\S]*started the repair myself/);
    const repair = saved.get('che').jobs.find((j) => j.kind === 'self_development' && j.title === 'Repair the iPhone build');
    assert.ok(repair, 'a repair job was queued');
    assert.match(repair.prompt, /Flutter analyze[\s\S]*actions\/runs\/41/);
    assert.equal(aiCalls, 0, 'building and checking cost no AI');
  } finally {
    globalThis.fetch = original;
  }
});

test('app builds: a refused dispatch is reported honestly and nothing is queued', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async () => ({ response: 'x' }) } };
  const { chat } = await pairedChat(env, saved);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
  try {
    const out = replyFromNdjson(await (await chat('update my phone')).text());
    assert.match(out, /could not start the app update[\s\S]*403[\s\S]*Nothing was changed/);
    assert.ok(!saved.get('che').jobs.some((j) => j.kind === 'verify_app_build'));
  } finally {
    globalThis.fetch = original;
  }
});
