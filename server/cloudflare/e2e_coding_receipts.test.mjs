// E2E (reliability lane, 2026-10-25): a coding mission never reports a pull request or a merge without a receipt.
// The owner asks through the real /api/chat route. The runtime record comes from a FAKE GitHub contents API (the
// runner's result file on che-mailbox) and CHE's own job list in durable storage; the chat model is a FAKE that
// would invent a merged PR, so any PR or merge claim in a reply must come from a record.
// A "receipt" here is what the record itself holds: a PR number for a PR, a PR number (and for job proof a commit SHA)
// for a merge. Offline: GitHub is a local fake; every other host is refused.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.e2e_coding_receipts.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const REPO = 'Vondada/chey-app';
const SESSION = 'ocr-0e2e0001';
let runtimeRecord = null; // what the fake GitHub serves as mailbox/runtime/<session>.json
globalThis.fetch = async (input) => {
  const url = new URL(String(input?.url || input));
  if (url.host === 'api.github.com' && url.pathname === `/repos/${REPO}/contents/mailbox/runtime/${SESSION}.json`) {
    if (!runtimeRecord) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(runtimeRecord)).toString('base64') }), { status: 200 });
  }
  if (url.host === 'api.github.com') return new Response(JSON.stringify({ message: 'Not Found (fake GitHub)' }), { status: 404 });
  throw new TypeError(`fetch failed (e2e tests are offline: ${url.host})`);
};

// FAKE model: writes the fabricated report the owner saw on 2026-10-21 for every call.
const FABRICATED = 'Done! I merged pull request #777 (commit da39a3ee5e6dbacd) and deployed it, sir.';

async function owner({ jobs = [], runtimeAt = new Date().toISOString() } = {}) {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'fake-token-for-e2e', CHE_GITHUB_REPO: REPO,
    AI: { run: async () => { calls += 1; return { response: FABRICATED }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  // Seed after pairing so the pairing write does not replace it.
  const data = saved.get('che') || {};
  data.jobs = jobs;
  saved.set('che', data);
  if (runtimeRecord) {
    saved.set('che_runtime_last_session', SESSION);
    saved.set('che_runtime_last_session_at', runtimeAt);
    saved.set('che_runtime_last_request', 'TEST FIXTURE: add a small test');
  }
  const say = async (message) => {
    const before = calls;
    const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: calls - before };
  };
  return { say };
}

const MERGE_WORDS = /\bmerged\b(?! or deployed)/i;
const PR_OPENED = /\bopened (?:a |its |pull request|PR)/i;

async function status(record) {
  runtimeRecord = record ? { session_id: SESSION, updated_at: new Date().toISOString(), ...record } : null;
  const che = await owner();
  return che.say('coding status');
}

test('a merged run WITH its PR number and run id: the merge is reported with that receipt', async () => {
  const out = await status({ state: 'merged', pr_number: 512, run_id: 4242, changed_files: 1, additions: 3, deletions: 0, models_tried: ['fixture-model'] });
  assert.equal(out.meta.source, 'che_coding_history', out.reply);
  assert.equal(out.modelCalls, 0, 'no model writes a coding receipt');
  assert.match(out.reply, /merged pull request 512/);
  assert.match(out.reply, /Pull request: #512\./);
  assert.match(out.reply, new RegExp(`https://github.com/${REPO}/actions/runs/4242`));
  assert.doesNotMatch(out.reply, /#777|da39a3e/, 'the fake model never reaches the reply');
});

test('an open PR WITH its number is named; tests are reported as running, not passed', async () => {
  const out = await status({ state: 'pr_open', pr_number: 513, changed_files: 2 });
  assert.match(out.reply, /opened pull request 513/);
  assert.match(out.reply, /Tests: running\./);
  assert.doesNotMatch(out.reply, MERGE_WORDS);
});

test('a run still running reports neither a PR nor a merge', async () => {
  const out = await status({ state: 'running' });
  assert.doesNotMatch(out.reply, MERGE_WORDS);
  assert.doesNotMatch(out.reply, PR_OPENED);
  assert.match(out.reply, /Pull request: none recorded\./);
});

test('no run record at all: "No coding job has started yet", never the model\'s merged PR', async () => {
  runtimeRecord = null;
  const che = await owner();
  const out = await che.say('coding status');
  assert.match(out.reply, /No coding job has started yet/);
  assert.doesNotMatch(out.reply, /#777|merged/i);
});

// Fixed 2026-10-25 (found by the reliability lane): speakRuntimeStatus (coding_runtime.js, `case 'merged'` ~line 399 and `case 'pr_open'`
// ~line 396) says "I merged its pull request" / "opened a pull request" when the record has NO pr_number, while the
// same reply then says "Pull request: none recorded." A merge or PR is claimed without its receipt.
test('a "merged" record with NO PR number must not claim a merge', async () => {
  const out = await status({ state: 'merged' });
  assert.match(out.reply, /Pull request: none recorded\./);
  assert.doesNotMatch(out.reply, /\bI merged\b/, out.reply);
});

test('a "pr_open" record with NO PR number must not claim a PR was opened', async () => {
  const out = await status({ state: 'pr_open' });
  assert.doesNotMatch(out.reply, PR_OPENED, out.reply);
});

// CHE's own job records: "last completed coding work and its GitHub proof".
const PROOF = 'What is the last completed coding job you finished, and what is the GitHub proof?';

test('proof: a complete merge job WITHOUT a commit SHA is not reported as verified work', async () => {
  runtimeRecord = null;
  const che = await owner({ jobs: [
    { id: 'job-merge-nosha', kind: 'merge_pr', status: 'complete', title: 'TEST FIXTURE merge', pr_number: 600, result: 'Merged.', created_at: '2026-10-24T10:00:00Z' },
  ] });
  const out = await che.say(PROOF);
  assert.equal(out.meta.source, 'che_coding_history', out.reply);
  assert.equal(out.meta.ok, false);
  assert.match(out.reply, /I cannot verify that I completed a coding job/);
  assert.doesNotMatch(out.reply, /#600|#777/);
  assert.equal(out.modelCalls, 0);
});

test('proof: a complete merge job WITH its SHA and PR number is cited from the record, labelled as not a live GitHub check', async () => {
  runtimeRecord = null;
  const sha = '0c43197c66529ee0902ee373fc0889467490ee71';
  const che = await owner({ jobs: [
    { id: 'job-merge-sha', kind: 'merge_pr', status: 'complete', title: 'TEST FIXTURE merge', pr_number: 523, merge_commit_sha: sha, created_at: '2026-10-24T22:00:00Z' },
    { id: 'job-failed', kind: 'merge_pr', status: 'failed', title: 'older failed merge', pr_number: 400, merge_commit_sha: 'a'.repeat(40) },
  ] });
  const out = await che.say(PROOF);
  assert.equal(out.meta.ok, true, out.reply);
  assert.equal(out.meta.sha, sha);
  assert.match(out.reply, /Commit: 0c43197/);
  assert.match(out.reply, /PR: #523/);
  assert.match(out.reply, /not a live GitHub check/);
  assert.doesNotMatch(out.reply, /#400|#777/, 'a failed job and the model are never cited');
});
