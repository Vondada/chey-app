// REA compare through the Worker, offline. The owner's question "Which of those features could improve your app?"
// reached a coding job on the owner's iPhone (7:52 screenshot). The phone sends a turn that reads like a change
// to /api/change/request, not /api/chat, so REA never saw it. These tests send each turn the way the phone does
// and prove: a question is never a build, REA answers a follow-up about an investigation on record, and nothing
// is queued or written. Every outbound request is a recorded fake, so a write can only show up here.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { dnsAnswer } from './fixtures/public_dns.mjs';

const generated = new URL('./.rea_compare_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const SHA = 'a'.repeat(40);
const CHE_SHA = 'c'.repeat(40);
const PACKAGE = JSON.stringify({
  name: 'sketchpad', main: 'src/main.tsx', scripts: { dev: 'vite', test: 'vitest' },
  dependencies: { react: '18.3.1', 'react-router-dom': '6.26.0', 'fuse.js': '7.0.0', 'idb-keyval': '6.2.1', i18next: '23.0.0', jotai: '2.9.0' },
  devDependencies: { vitest: '2.0.0', '@acme/eslint-config': '1.0.0' },
}, null, 2);
const README = ['# Sketchpad', '', 'A notes and sketch app.', '', '## Features', '', '- Instant search across notes.', '- Pin notes to the top of the list.', '- Export to PNG and SVG.', '', '## License', 'MIT'].join('\n');
const SEARCH_BOX = ['export function SearchBox() {', '  const fuse = new Fuse(notes, { keys: ["title"] });', '  return <input type="search" aria-label="Search notes" />;', '}'].join('\n');
const TREE = ['package.json', 'README.md', 'LICENSE', 'src/main.tsx', 'src/App.tsx', 'src/search/SearchBox.tsx', 'test/search.test.ts', '.github/workflows/ci.yml'];
const CHE_TREE = ['lib/che_theme.dart', 'lib/home_state/send.dart', 'lib/che_key_search.dart', 'server/cloudflare/command_catalog.js', 'server/cloudflare/worker.js'];
const RAW = { 'package.json': PACKAGE, 'README.md': README, 'src/App.tsx': 'export default function App() { return null; }', 'src/search/SearchBox.tsx': SEARCH_BOX };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// One fake internet: the public repository and CHE's own repository. Anything else is refused (599) and recorded.
function fakeInternet() {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const u = String(input?.url || input);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    calls.push({ url: u, method });
    const dns = dnsAnswer(u, { private: [] });
    if (dns) return dns;
    if (u === 'https://api.github.com/repos/acme/sketchpad') return json({ full_name: 'acme/sketchpad', private: false, default_branch: 'main', license: { spdx_id: 'MIT', name: 'MIT License' }, description: 'Notes and sketches', stargazers_count: 4200, topics: ['notes'], homepage: 'https://sketchpad.example.org' });
    if (u.startsWith('https://api.github.com/repos/acme/sketchpad/commits/')) return json({ sha: SHA });
    if (u.startsWith('https://api.github.com/repos/acme/sketchpad/git/trees/')) return json({ sha: SHA, tree: TREE.map((path) => ({ path, type: 'blob' })) });
    if (u === 'https://api.github.com/repos/acme/sketchpad/languages') return json({ TypeScript: 90000, CSS: 2000 });
    if (u.startsWith('https://api.github.com/search/code') && u.includes('repo%3Aacme%2Fsketchpad')) return json({ items: [{ path: 'src/search/SearchBox.tsx' }] });
    if (u.startsWith('https://raw.githubusercontent.com/acme/sketchpad/')) {
      const path = decodeURIComponent(u.split('/').slice(6).join('/'));
      return RAW[path] ? new Response(RAW[path], { status: 200 }) : new Response('nope', { status: 404 });
    }
    if (u.startsWith('https://api.github.com/search/repositories')) return json({ items: [] });
    if (u.startsWith('https://api.github.com/repos/Vondada/chey-app/commits/main')) return json({ sha: CHE_SHA });
    if (u.startsWith('https://api.github.com/repos/Vondada/chey-app/git/trees/')) return json({ tree: CHE_TREE.map((path) => ({ path, type: 'blob' })) });
    if (u.startsWith('https://api.github.com/search/code')) return json({ items: [], incomplete_results: false });
    return json({ message: `unexpected ${method} ${u}` }, 599);
  };
  return { fetcher, calls };
}

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// One owner session. `route: 'chat'` is POST /api/chat with the phone's history; `route: 'change'` is the
// POST /api/change/request the phone uses when its own classifier reads a turn as a change to CHE.
async function owner(steps, { history: seeded = [], seed = null } = {}) {
  const saved = new Map();
  const net = fakeInternet();
  globalThis.fetch = net.fetcher;
  const modelCalls = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app',
    AI: { run: async (name, input) => { modelCalls.push({ name, input }); return { response: 'An ordinary chat-only answer.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', headers = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  if (seed) seed(saved);
  const history = [...seeded];
  const out = [];
  for (const step of steps) {
    if (step.post) {
      // A plain owner HTTP call (the job-cancel route); the snapshot shows the queue right after it.
      const res = await send(step.post, step.body, token);
      out.push({ say: step.post, route: 'post', status: res.status, body: await res.json().catch(() => ({})), jobs: saved.get('che')?.jobs || [] });
      continue;
    }
    const { say, route = 'chat' } = step;
    net.calls.length = 0;
    const modelBefore = modelCalls.length;
    const jobsBefore = (saved.get('che')?.jobs || []).length;
    let reply = '';
    let source = '';
    let status = 0;
    let jobId = '';
    if (route === 'chat') {
      const res = await send('/api/chat', { message: say, history: step.history ?? history.slice(-14) }, token);
      const raw = await res.text();
      const lines = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } });
      const done = lines.find((item) => item.type === 'done') || (lines.length === 1 ? lines[0] : {});
      reply = replyFromNdjson(raw) || done.reply || done.message || '';
      source = done.source || '';
      status = res.status;
      jobId = done.background_job_id || '';
    } else {
      // The phone's own request shape (streaming.dart: body {request}, header x-che-background-jobs).
      const res = await send('/api/change/request', { request: say }, token, { 'x-che-background-jobs': '1' });
      const body = await res.json().catch(() => ({}));
      reply = body.message || body.detail || '';
      source = body.source || '';
      status = res.status;
      jobId = body.background_job_id || '';
    }
    out.push({
      say, route, reply, source, status,
      modelCalls: modelCalls.length - modelBefore,
      jobId,
      // Every outbound request that is not a read: a repository write, PR, ref or contents change.
      repoWrites: net.calls.filter((c) => c.method !== 'GET'),
      codingJobsCreated: (saved.get('che')?.jobs || []).length - jobsBefore,
      jobs: saved.get('che')?.jobs || [],
    });
    history.push({ role: 'user', content: say }, { role: 'assistant', content: reply });
  }
  return out;
}

const INVESTIGATE = 'CHE, investigate https://github.com/acme/sketchpad and tell me how its features work.';
const OWNER_COMPARE = 'Which of those features could improve your app?';

// The owner's phone route: REA's investigation is on record; the phone sends the question to the change endpoint.
test('REA compare: after an investigation, the phone\'s "Which of those features could improve your app?" is a read-only REA comparison', async () => {
  const [investigated, compared] = await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE, route: 'change' }]);
  assert.equal(investigated.status, 200);
  assert.match(investigated.reply, /REA investigation rea-[0-9a-f]{8} of acme\/sketchpad/, 'turn 1 is the investigation');
  assert.equal(compared.source, 'che_rea', `REA must answer, got source "${compared.source}": ${compared.reply.slice(0, 200)}`);
  assert.match(compared.reply, /CHE/, 'the comparison is REA\'s answer');
  assert.equal(compared.codingJobsCreated, 0, 'no coding job is created');
  assert.doesNotMatch(compared.reply, /coding job/i, 'the reply is not a coding acceptance');
  assert.deepEqual(compared.repoWrites, [], 'no repository write (PUT, PATCH, POST, ref or pull request)');
  assert.equal(compared.modelCalls, 0, 'REA answers without the model');
});

// The owner's chat route with the phone's history: REA's reply is the last assistant turn, so REA claims it.
test('REA compare: the same question through /api/chat with REA\'s reply in history is claimed by REA, with no job and no write', async () => {
  const [investigated, compared] = await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE, route: 'chat' }]);
  assert.match(investigated.reply, /REA investigation rea-[0-9a-f]{8}/);
  assert.equal(compared.source, 'che_rea', compared.reply.slice(0, 200));
  assert.equal(compared.codingJobsCreated, 0);
  assert.deepEqual(compared.repoWrites, []);
});

// No investigation on record: the question is not REA's, and it must never become a build on any route.
test('a question with no investigation on record is never a coding job, on the chat route or the change route', async () => {
  for (const route of ['chat', 'change']) {
    const [turn] = await owner([{ say: OWNER_COMPARE, route }]);
    assert.notEqual(turn.source, 'che_rea', `${route}: REA has nothing to compare`);
    assert.equal(turn.codingJobsCreated, 0, `${route}: no coding job`);
    assert.doesNotMatch(turn.reply, /coding job/i, `${route}: no acceptance reply`);
    assert.deepEqual(turn.repoWrites, [], `${route}: no repository write`);
  }
});

// The history gate reads only the last assistant reply. If another reply came after REA's, REA steps aside, and
// the question still must not become a build.
test('a question after REA\'s reply, with a later non-REA reply in history, is not a coding job', async () => {
  const later = [{ role: 'user', content: INVESTIGATE }, { role: 'assistant', content: 'Here is a short note about dark mode.' }];
  const [investigated, turn] = await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE, route: 'chat', history: later }]);
  assert.match(investigated.reply, /REA investigation rea-/);
  assert.equal(turn.codingJobsCreated, 0, 'no coding job from a question');
  assert.doesNotMatch(turn.reply, /coding job/i);
  assert.deepEqual(turn.repoWrites, []);
});

// Cancel: the owner's job route cancels only a queued job, and cancelling one job never touches another.
// The unauthorized job is the kind a question used to create (#356); the authorized one is a real build.
const UNAUTHORIZED = { id: 'c2987a73-0000-4000-8000-00000000c298', kind: 'self_development', title: OWNER_COMPARE, request: OWNER_COMPARE, status: 'queued', attempts: 0, created_at: '2026-10-19T07:52:00.000Z', updated_at: '2026-10-19T07:52:00.000Z' };
const AUTHORIZED = { id: 'a7f3c9e1-0000-4000-8000-0000000a7f3c', kind: 'self_development', title: 'Fix the bug where the mic stays on after I stop talking', request: 'Fix the bug where the mic stays on after I stop talking.', status: 'queued', attempts: 0, created_at: '2026-10-19T07:40:00.000Z', updated_at: '2026-10-19T07:40:00.000Z' };
const RUNNING = { id: 'b1d2e3f4-0000-4000-8000-0000000b1d2e', kind: 'self_development', title: 'Running build', request: 'Running build', status: 'running', attempts: 1, created_at: '2026-10-19T07:30:00.000Z', updated_at: '2026-10-19T07:31:00.000Z' };

test('cancel: cancelling the unauthorized queued job leaves the authorized queued job untouched, and a running job is not cancelled', async () => {
  const seed = (saved) => { saved.set('che', { ...saved.get('che'), jobs: [structuredClone(UNAUTHORIZED), structuredClone(AUTHORIZED), structuredClone(RUNNING)] }); };
  const [cancelled, , refused] = await owner([
    { post: '/api/job/cancel', body: { id: UNAUTHORIZED.id } },
    { post: '/api/job/activity', body: { id: AUTHORIZED.id } },
    { post: '/api/job/cancel', body: { id: RUNNING.id } },
  ], { seed });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, 'cancelled', 'the queued unauthorized job is cancelled');
  const after = Object.fromEntries(cancelled.jobs.map((job) => [job.id, job]));
  assert.equal(after[UNAUTHORIZED.id].status, 'cancelled');
  assert.deepEqual(after[AUTHORIZED.id], AUTHORIZED, 'the authorized job is exactly as it was: still queued, not started or lost');
  assert.equal(after[RUNNING.id].status, 'running', 'a running job is never cancelled by this route');
  assert.equal(refused.jobs.length, 3, 'no job is lost');
  assert.equal(refused.jobs.find((job) => job.id === AUTHORIZED.id).status, 'queued');
});

// Review of #356 (round 2), blocker B1. The rule: a sentence starts a build only when it is (a) an imperative with a build
// verb and a target, or (b) a direct polite request for CHE to do it ("Can / Could / Would / Will you <build verb> ...").
// Every other question never builds, on /api/change/request, on /api/chat and on the REA path.
const NEVER_BUILD = [
  'Do you think any of those features could improve your app?',
  'Tell me which features could improve your app.',
  'Is there a feature that could improve your app?',
  'Could any of those features improve your app?',
  'Would any of those features improve your app?',
  'Should we add dark mode to your app?',
  'How do we fix the login bug in your app?',
];
function assertNoJob(turn, where) {
  assert.equal(turn.codingJobsCreated, 0, `${where}: no job. Reply: ${turn.reply.slice(0, 160)}`);
  assert.doesNotMatch(turn.reply, /coding job/i, `${where}: no acceptance reply`);
  assert.deepEqual(turn.repoWrites, [], `${where}: no repository write`);
}
for (const say of NEVER_BUILD) {
  test(`B1: "${say}" never builds, on either route, with or without an investigation on record`, async () => {
    for (const route of ['chat', 'change']) {
      const [alone] = await owner([{ say, route }]);
      assertNoJob(alone, `${route}, no investigation`);
      const after = await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE }, { say, route }]);
      assertNoJob(after.at(-1), `${route}, after an investigation and a comparison`);
    }
  });
}

// The REA path: a question about building the compared features is answered read-only, with no build.
for (const say of ['Should I add those features into yourself?', 'Do you think I should build those features into yourself?']) {
  test(`B1 REA: "${say}" after a comparison is a read-only REA answer with no build, on either route`, async () => {
    for (const route of ['chat', 'change']) {
      const turn = (await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE }, { say, route }])).at(-1);
      assert.equal(turn.source, 'che_rea', `${route}: ${turn.reply.slice(0, 160)}`);
      assert.match(turn.reply, /nothing was built/i, route);
      assertNoJob(turn, route);
    }
  });
}

// Each (a) and (b) example still builds. REA builds need the comparison on record and the chat route.
const STILL_BUILDS = [
  ['Add dark mode to your app.', ['chat', 'change']],
  ['Fix the login bug in your app.', ['chat', 'change']],
  ['Build the search feature into your app.', ['chat', 'change']],
  ['Build those approved features into yourself.', ['chat']],
  ['Build it into yourself.', ['chat', 'change']],
  ['Could you add dark mode to your app?', ['chat', 'change']],
  ['Can you improve your code so you can create a PR?', ['chat', 'change']],
  ['Could you add those features into yourself?', ['chat']],
];
for (const [say, routes] of STILL_BUILDS) {
  test(`B1: the build request "${say}" still builds (${routes.join(' and ')})`, async () => {
    for (const route of routes) {
      const turn = (await owner([{ say: INVESTIGATE }, { say: OWNER_COMPARE }, { say, route }])).at(-1);
      assert.equal(turn.codingJobsCreated, 1, `${route}: ${turn.reply.slice(0, 160)}`);
    }
  });
}
