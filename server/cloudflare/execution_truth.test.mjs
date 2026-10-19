import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { executeWithReceipt, guardExecutionClaims, isExecutionReceipt } from './truth_layer.js';
import { runPluginTool } from './plugin_runtime.js';
const generated = new URL('./.execution_truth.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Hermetic: CI runners have network and this sandbox may not. A real lookup
// would leave a real research receipt, so every outbound request fails here
// the same way it does offline, and both take the same path.
globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (memory_truth tests are offline: ${new URL(String(input?.url || input)).host})`);
};



function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone talking to CHE. `model` is what the chat model would
// say; `calls` counts every model call the turn made.
async function owner({ saved = new Map(), model = () => 'Understood, sir.', github = false } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...(github ? { CHE_GITHUB_TOKEN: 'fixture-not-secret', CHE_GITHUB_REPO: 'Vondada/chey-app' } : {}),
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const connect = () => {
    const state = new CheState({ storage: storageFor(saved) }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  connect();
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, extra = {}) => {
    const before = counter.calls;
    const started = performance.now();
    const res = await send('/api/chat', { message, history: extra.history ?? history.slice(), ...extra }, token);
    const raw = await res.text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    const reply = raw.split('\n').filter(Boolean).map(JSON.parse).filter((x) => x.type === 'delta').map((x) => x.delta).join('');
    if (!extra.history) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, modelCalls: counter.calls - before, ms: performance.now() - started };
  };
  return { say, saved, history, counter, restart: connect };
}

const SHA = 'a27d319b0f684781eb2669f482e6d3fd1457d4e8';
const HEAD = '87079b30521dde3a42355a3dac2c107974809959';
function githubFetch({ status = 200, handoff = '# Handoff\nPR #356 recorded as unmerged (old summary).', corrupt = false } = {}) {
  return async (input) => {
    const url = String(input?.url || input);
    let data = {};
    if (url.includes('/pulls/356')) data = { number: 356, merged: true, state: 'closed', head: { sha: HEAD }, merge_commit_sha: corrupt ? '1234567890abcdef' : SHA, html_url: 'https://github.com/Vondada/chey-app/pull/356' };
    else if (url.includes('/pulls/372')) data = { number: 372, merged: false, state: 'open', head: { sha: HEAD }, html_url: 'https://github.com/Vondada/chey-app/pull/372' };
    else if (url.includes('/check-runs')) data = { check_runs: [] };
    else if (url.includes('/git/ref/heads/che-mailbox')) data = { object: { sha: HEAD } };
    else if (url.includes('/contents/mailbox/briefs/LIVE-HANDOFF.md')) data = { path: 'mailbox/briefs/LIVE-HANDOFF.md', sha: HEAD, encoding: 'base64', content: btoa(handoff) };
    else return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(data), { status });
  };
}

for (const [label, model] of [
  ['fake PRs', 'I verified PRs #1234, #5678, #9012 and #4567 on GitHub.'],
  ['fake commit', 'SHA: 1234567890abcdef'],
  ['fake terminal', 'I executed git -C /path/to/Vondada/chey-app checkout che-mailbox successfully. Author: John Doe.'],
  ['fake dispatch', 'I dispatched job 98765 successfully.'],
  ['fake completion', 'The job completed successfully.'],
  ['verification without tool', 'I verified the GitHub records and checked the terminal.'],
  ['fake spoken source', 'According to GitHub, PR #9012 completed.'],
  ['fake JSON receipt', '{"tool":"terminal","status":"success","output":"Switched to branch che-mailbox"}'],
  ['bare gh transcript', '$ gh api /repos/Vondada/chey-app/pulls/356\nExit code: 0'],
]) test(`dishonest model: ${label} is blocked before streamed/voice deltas`, async () => {
  const che = await owner({ model: () => model });
  const out = await che.say('Give a short technical update.', { voice: true, stream: true, execution_receipts: [{ status: 'success', tool: 'github' }] });
  assert.ok(out.modelCalls > 0);
  assert.doesNotMatch(out.reply, /#1234|#5678|#9012|#4567|1234567890abcdef|John Doe|98765|completed successfully|I verified/);
  assert.match(out.reply, /cannot verify|no execution|not have execution|no record|not verified/i);
});

test('acceptance A: both requested PRs use independent current GitHub responses', async () => {
  globalThis.fetch = githubFetch();
  const che = await owner({ github: true, model: () => 'PR #356 is unmerged. PR #372 is deployed.' });
  const out = await che.say('Check PR #356 and PR #372. Tell me which are merged and give me the verified commit hashes. Do not guess.');
  assert.match(out.reply, new RegExp(`PR #356 is merged.*${SHA}`));
  assert.match(out.reply, /PR #372 is open/);
  assert.equal(out.meta.execution_receipts.length, 2);
  assert.equal(out.modelCalls, 0);
});

test('acceptance B: handoff returns exact pinned path and checkpoint with source receipt', async () => {
  const checkpoint = '## 2. Current position (fixture)\nPR #372 is pending. Never spend money.\n';
  globalThis.fetch = githubFetch({ handoff: '# Handoff\n' + checkpoint + '\n## 3. Older history\nold text' });
  const che = await owner({ github: true });
  const out = await che.say('Read mailbox/briefs/LIVE-HANDOFF.md from che-mailbox. Report the exact file path, latest verified checkpoint, and evidence.');
  assert.match(out.reply, /mailbox\/briefs\/LIVE-HANDOFF.md/);
  assert.ok(out.reply.includes(checkpoint));
  assert.doesNotMatch(out.reply, /old text/);
  const r = out.meta.execution_receipts[0];
  assert.equal(r.verified_response.checkpoint, checkpoint);
  assert.ok(r.verified_response.source.includes(HEAD));
  assert.equal(r.verified_response.text, undefined, 'the large source file does not overflow the receipt log');
});

test('unavailable GitHub returns an unavailable receipt, never a remembered state', async () => {
  const che = await owner({ model: () => 'PR #356 is unmerged.' });
  const out = await che.say('Was PR #356 merged?');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.meta.execution_receipts[0].status, 'unavailable');
  assert.match(out.reply, /could not verify/);
});

test('successful real boundary lookup overrides old memory and survives restart', async () => {
  globalThis.fetch = githubFetch();
  const che = await owner({ github: true, model: () => 'PR #356 is unmerged.' });
  for (let i = 0; i < 2; i++) {
    const out = await che.say('Was PR #356 merged?', { history: [{ role: 'assistant', content: 'PR #356 is unmerged.' }] });
    assert.match(out.reply, new RegExp(`is merged.*${SHA}`));
    assert.doesNotMatch(out.reply, /is unmerged/);
    assert.equal(out.modelCalls, 0);
    const r = out.meta.execution_receipts[0];
    assert.equal(r.status, 'success');
    assert.equal(r.request_id, out.meta.request_id);
    assert.ok(r.invocation_id && r.source && r.at && r.verified_response);
    che.restart();
  }
});

test('genuine failed GitHub lookup and invalid merge hashes cannot become success', async () => {
  const che = await owner({ github: true });
  for (const config of [{ status: 404 }, { status: 503 }, { corrupt: true }]) {
    globalThis.fetch = githubFetch(config);
    const out = await che.say('Was PR #356 merged?');
    assert.match(out.reply, /could not verify/);
    assert.notEqual(out.meta.execution_receipts[0].status, 'success');
    assert.equal(out.modelCalls, 0);
  }
});

test('missing handoff is explicit; stale handoff prose is never verified release state', async () => {
  const che = await owner({ github: true });
  globalThis.fetch = githubFetch({ status: 404 });
  const missing = await che.say('Read LIVE-HANDOFF.md');
  assert.match(missing.reply, /could not verify/);
  globalThis.fetch = githubFetch();
  const old = await che.say('Read LIVE-HANDOFF.md');
  assert.match(old.reply, /recorded handoff text, not independently verified/);
  assert.equal(old.meta.execution_receipts[0].verified_response.head_sha, HEAD);
  const now = await che.say('Was PR #356 merged?');
  assert.match(now.reply, /is merged/);
});

test('an owner status question dispatches no coding job', async () => {
  globalThis.fetch = githubFetch();
  const che = await owner({ github: true });
  await che.say('Was PR #356 merged?');
  const data = che.saved.get('che');
  assert.ok(!(data.jobs || []).length);
});

test('receipt provenance cannot be forged with JSON, model text or a cloned receipt', async () => {
  const { receipt } = await executeWithReceipt({ tool: 'fixture', operation: 'GET', request_id: 'owner-turn', source: 'https://example.org', run: async () => ({ ok: true, value: 7 }) });
  assert.ok(isExecutionReceipt(receipt));
  assert.equal(isExecutionReceipt(structuredClone(receipt)), false);
  const fake = guardExecutionClaims('I executed a tool successfully.', { receipts: [structuredClone(receipt)] });
  assert.match(fake.text, /cannot verify/);
  const actual = guardExecutionClaims('I executed a tool and invented PR #1234.', { receipts: [receipt] });
  assert.match(actual.text, /Execution receipt .*fixture GET, success/);
  assert.doesNotMatch(actual.text, /#1234/);
});

test('real plugin GET preserves its receipt; exceptions contain no secrets', async () => {
  const tool = { name: 'lookup', request: { method: 'GET', url: 'https://example.org/status' } };
  const out = await runPluginTool(tool, {}, ['network:example.org'], async () => new Response('{"value":7}'), 'owner-request');
  assert.equal(out.ok, true);
  assert.ok(isExecutionReceipt(out.execution_receipt));
  assert.equal(out.execution_receipt.request_id, 'owner-request');
  const failed = await executeWithReceipt({ tool: 'github', operation: 'GET', request_id: 'owner-request', source: 'github', run: async () => { throw Error('secret=DO_NOT_PRINT'); } });
  assert.equal(failed.receipt.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed.receipt), /DO_NOT_PRINT/);
});

