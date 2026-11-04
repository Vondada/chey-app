// GitHub issues from chat (github_issues.js). Certification run 24 (41491194768), csd-38: "Create a GitHub issue titled
// 'Flaky login test' with reproduction steps." went to the model, which can file nothing. Unit tests with a recording
// GitHub stand-in, then the real /api/chat with in-memory storage: the issue number and link in the reply are the ones
// GitHub returned, no duplicate is filed, steps are never invented, and a probe turn files nothing.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { issueBody, issueRequest, issueTurn } from './github_issues.js';
import { COMMANDS, dispatchPrompt } from './command_catalog.js';

test('the Command Center has the GitHub issue command, and its prompt is one this tool files (Codex review on #921)', () => {
  const command = COMMANDS.find((c) => c.id === 'github-issue');
  assert.equal(command.route, 'che_github_issue');
  assert.equal(issueRequest(dispatchPrompt(command, "Owner's login fails")).title, "Owner's login fails");
});

const ENV = { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'owner/repo' };
function fakeGitHub(open = []) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
    if (init.method === 'GET') return new Response(JSON.stringify(open), { status: 200 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ number: 4242, title: body.title, html_url: 'https://github.com/owner/repo/issues/4242' }), { status: 201 });
  };
  return { calls, fetcher };
}

test('issue requests are recognised with their title; questions, negations and other tickets are not', () => {
  assert.deepEqual(issueRequest("Create a GitHub issue titled 'Flaky login test' with reproduction steps."), { title: 'Flaky login test', steps: '', wantsSteps: true });
  assert.equal(issueRequest('Open a new GitHub issue called Voice cuts out on long replies').title, 'Voice cuts out on long replies');
  assert.equal(issueRequest('File an issue on GitHub titled "Gallery crash" steps: 1. open Gallery 2. scroll fast').steps, '1. open Gallery 2. scroll fast');
  assert.deepEqual(issueRequest('Create a GitHub issue.'), { title: '', steps: '', wantsSteps: false });
  // Codex review on #921: a double-quoted title keeps its apostrophe; every creation verb can be negated.
  assert.equal(issueRequest('Create a GitHub issue titled "Owner\'s login fails".').title, "Owner's login fails");
  assert.equal(issueRequest("Create a GitHub issue titled 'Owner's login fails' please").title, "Owner's login fails");
  for (const q of ["Don't add a GitHub issue titled 'Flaky login test'.", "Don't start a GitHub issue for this.", 'Never log a GitHub issue for this.', 'How do I create a GitHub issue?', "Don't open a GitHub issue for that.", 'Explain how to file a GitHub issue.', 'Book a ticket to Paris.', 'What is a GitHub issue?']) assert.equal(issueRequest(q), null, q);
});

test('the body keeps the owner\'s words and never invents reproduction steps', () => {
  const body = issueBody(issueRequest("Create a GitHub issue titled 'Flaky login test' with reproduction steps."), 'Create a GitHub issue titled \'Flaky login test\' with reproduction steps.', Date.UTC(2026, 10, 4));
  assert.match(body, /^Filed by CHE from the owner's chat request on 2026-11-04\./);
  assert.match(body, /## Reproduction steps\n_Not provided yet\. Add the exact steps/);
  const given = issueBody({ title: 'x', steps: '1. open Gallery 2. scroll fast' }, 'msg');
  assert.match(given, /## Reproduction steps\n1\. open Gallery 2\. scroll fast/);
});

test('a turn files the issue and reports GitHub\'s own number and link; an open issue with the title is not filed twice', async () => {
  const gh = fakeGitHub();
  const out = await issueTurn(null, "Create a GitHub issue titled 'Flaky login test' with reproduction steps.", { env: ENV, fetcher: gh.fetcher, now: 1 });
  assert.equal(gh.calls.at(-1).method, 'POST');
  assert.equal(gh.calls.at(-1).url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(gh.calls.at(-1).body.title, 'Flaky login test');
  assert.equal(gh.calls.at(-1).auth, 'Bearer test-token');
  assert.match(out.text, /^I filed issue #4242 "Flaky login test" in owner\/repo, sir: https:\/\/github\.com\/owner\/repo\/issues\/4242\. You did not give the reproduction steps, so I left that section marked to fill in rather than invent them\./);
  assert.deepEqual([out.meta.execution_receipt.status, out.meta.execution_receipt.issue_number], ['success', 4242]);
  const dup = fakeGitHub([{ number: 7, title: 'Flaky login test', html_url: 'https://github.com/owner/repo/issues/7' }]);
  const again = await issueTurn(null, "Create a GitHub issue titled 'Flaky login test'.", { env: ENV, fetcher: dup.fetcher });
  assert.equal(dup.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(again.text, /^Issue #7 "Flaky login test" is already open in owner\/repo, sir, so I did not file a duplicate/);
  assert.equal(again.meta.execution_receipt.deduplicated, true);
});

test('refusals, missing setup and test turns file nothing and say so', async () => {
  const gh = fakeGitHub();
  const probe = await issueTurn(null, "Create a GitHub issue titled 'Flaky login test'.", { env: ENV, fetcher: gh.fetcher, probe: true });
  assert.equal(gh.calls.length, 0);
  assert.match(probe.text, /This is a test turn, so nothing was filed/);
  assert.equal(probe.meta.execution_receipt.status, 'not_run');
  const noTitle = await issueTurn(null, 'Create a GitHub issue.', { env: ENV, fetcher: gh.fetcher });
  assert.match(noTitle.text, /^What should the issue be titled, sir\?/);
  const unset = await issueTurn(null, "Create a GitHub issue titled 'x y'.", { env: {}, fetcher: gh.fetcher });
  assert.equal(unset.meta.execution_receipt.status, 'failure');
  assert.equal(gh.calls.length, 0);
  const denied = await issueTurn(null, "Create a GitHub issue titled 'x y'.", { env: ENV, fetcher: async (u, i) => new Response(i.method === 'GET' ? '[]' : '{"message":"Resource not accessible by integration"}', { status: i.method === 'GET' ? 200 : 403 }) });
  assert.match(denied.text, /my GitHub token is not allowed to create issues in that repository\. Nothing was filed\./);
  assert.equal((await issueTurn(null, "Create a GitHub issue titled 'x y'.", { env: ENV, owner: false, fetcher: gh.fetcher })).meta.ok, false);
});

// Through the real /api/chat.
const generated = new URL('./.github_issues.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: the owner\'s request files one issue and the reply carries its receipt; a probe turn files none', async () => {
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url?.url || url);
    if (u.startsWith('https://api.github.com/repos/owner/repo/issues')) {
      if ((init.method || 'GET') === 'GET') return new Response('[]', { status: 200 });
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ number: 99, title: posts.at(-1).title, html_url: 'https://github.com/owner/repo/issues/99' }), { status: 201 });
    }
    return new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...ENV, AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const frames = (await (await post('/api/chat', { message: "Create a GitHub issue titled 'Flaky login test' with reproduction steps.", history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = frames.find((f) => f.type === 'done');
  assert.equal(done.source, 'che_github_issue');
  assert.match(frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), /^I filed issue #99 "Flaky login test" in owner\/repo/);
  assert.equal(done.execution_receipt.issue_number, 99);
  assert.equal(posts.length, 1);
  const probe = await state.probeChat({ message: "Create a GitHub issue titled 'Flaky login test' with reproduction steps." });
  assert.match(probe.reply, /This is a test turn, so nothing was filed/);
  assert.equal(posts.length, 1, 'a certification turn filed nothing');
});
