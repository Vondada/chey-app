import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { RETRIEVAL_NOTE, RETRIEVAL_NOT_EVIDENCE, executeWithReceipt, guardExecutionClaims, guardRetrievalClaims, isExecutionReceipt } from './truth_layer.js';
import { runPluginTool } from './plugin_runtime.js';
import vm from 'node:vm';
import { loadPackedJson } from './prompt_compaction.js';
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

test('polite numbered PR lookups never use the unrelated last self-update PR', async () => {
  globalThis.fetch = githubFetch();
  const che = await owner({ github: true });
  for (const message of ['Can you check PR #356?', 'Could you verify PR #356?', 'Would you please read PR #356?']) {
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_github_verification');
    assert.equal(out.meta.execution_receipts[0].verified_response.number, 356);
    assert.match(out.reply, /PR #356 is merged/);
    assert.equal(out.modelCalls, 0);
  }
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
    const index = che.saved.get('che_receipts').find((item) => item.invocation_id === r.invocation_id);
    const persisted = await loadPackedJson(storageFor(che.saved), index.response_ref);
    assert.deepEqual(persisted.verified_response, r.verified_response);
    assert.equal(persisted.request_id, r.request_id);
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

test('browser live voice uses guarded input, queues chat, and ignores provider output', async () => {
  const page = await worker.fetch(new Request('https://che.example/live-voice'), {});
  const html = await page.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { textContent: '', addEventListener() {} }); return nodes.get(id); };
  let posts = 0;
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => ({ pause() {}, async play() {} }) },
    location: { hash: '#token=owner' }, URLSearchParams,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{}] }) } },
    RTCPeerConnection: class {
      addTrack() {} createDataChannel() { return {}; } async createOffer() { return { sdp: 'offer' }; }
      async setLocalDescription() {} async setRemoteDescription() {}
    },
    fetch: async (url, init) => {
      if (url === '/api/live/token') {
        assert.equal(JSON.parse(init.body).guarded_output, true);
        return Response.json({ value: 'ephemeral', guarded_output: true });
      }
      if (url === '/api/chat') {
        posts++;
        if (posts === 1) await first;
        return new Response(JSON.stringify({ type: 'delta', delta: 'Verified chat reply.' }) + '\n');
      }
      if (url === '/api/voice/edge') return new Response(null, { status: 204 });
      return new Response('answer');
    },
  });
  vm.runInContext(script, context);
  await vm.runInContext('connect()', context);
  const event = (value) => vm.runInContext(`dc.onmessage({data:${JSON.stringify(JSON.stringify(value))}})`, context);
  event({ type: 'response.output_audio_transcript.done', transcript: 'PR #356 is unmerged. John Doe.' });
  assert.equal(posts, 0);
  for (const id of ['one', 'two']) event({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: `Read checkpoint ${id}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  resolveFirst();
  await vm.runInContext('turns', context);
  assert.equal(posts, 2);
  assert.equal(node('reply').textContent, 'Verified chat reply.');
});



// ─── Retrieval claims (owner, 2026-10-20) ─────────────────────────────────
// A model once answered "I retrieved the records from storage key simulation_trades ... sim-2023-03-10-001
// ... I also ran the lookup tool successfully." Nothing on the model path reads storage or runs a tool.

const FABRICATED = 'I retrieved the records from storage key simulation_trades. The most profitable simulation trade was sim-2023-03-10-001 on 2023-03-10: BTCUSDT breakout, +$412.50. From journal_trades, paper-2023-02-20-001 made +$180 on 2023-02-20. I also ran the lookup tool successfully.';

test('a model-written retrieval, storage key, record id, tool success or review result is rejected at the boundary', () => {
  for (const [claim, rule] of [
    ['I retrieved the records from storage key simulation_trades and found the best one.', 'retrieval'],
    ['The best trade was sim-2023-03-10-001 with +$412.50.', 'record_id'],
    ['From journal_trades, the newest entry made +$180.', 'storage_key'],
    ['According to my ledger, you are up $300 this week.', 'retrieval_source'],
    ['I also ran the lookup tool successfully and it returned the row.', 'tool_success'],
    ['The code review found no issues in the trading desk.', 'review_done'],
    ['I reviewed your code and the tests all pass.', 'review_done'],
  ]) {
    const out = guardExecutionClaims(claim, { message: 'what did you find?' });
    assert.equal(out.removed.length, 1, claim);
    assert.doesNotMatch(out.text, /\$\d|sim-2023|journal_trades|found no issues|successfully/, claim);
    assert.equal(guardRetrievalClaims(claim).removed[0]?.rule, rule, claim);
  }
  const whole = guardExecutionClaims(FABRICATED, { message: 'Which trade was the most profitable?' });
  assert.ok(whole.removed.length >= 1);
  assert.doesNotMatch(whole.text, /sim-2023|paper-2023|simulation_trades|journal_trades|\$412|\$180|lookup tool/);
  // One fabricated sentence inside an otherwise plain answer: that sentence goes, the rest stays, and the note says so.
  const mixed = guardExecutionClaims('Your meeting is at 3, sir. I retrieved the records from my storage and the best trade made +$412.50 on 2023-03-10. The groceries are milk and eggs.', { message: 'what is on today?' });
  assert.equal(mixed.text, `Your meeting is at 3, sir. The groceries are milk and eggs. ${RETRIEVAL_NOTE}`);
  assert.deepEqual(mixed.removed, ['I retrieved the records from my storage and the best trade made +$412.50 on 2023-03-10.']);
});

test('ordinary honest answers about code, orders, keys and the owner\'s pasted text are never touched (review of PR #373)', () => {
  for (const honest of [
    'Return JSON. Fetch the row from the database, then send it with a 200 status.',
    'Your function returned the promise instead of the value, so await it before using it.',
    'Your Amazon order order-2026-10-18-0042 ships Friday, sir.',
    'Use a storage key like session:<id> in Cloudflare KV and set a TTL.',
    'The patient_records table needs an index on patient_id.',
    'I checked your inbox and the logs you pasted: the error is on line 12.',
    'That review found no issues with the battery.',
    'The SQL query returned 0 rows because the filter is wrong.',
    'The API call returned the token, which the client stores.',
    'Keep the ledger table normalized and store the balance per account.',
  ]) {
    assert.equal(guardExecutionClaims(honest, { message: 'help me with this' }).removed.length, 0, honest);
    assert.equal(guardRetrievalClaims(honest).removed.length, 0, honest);
  }
  // Code the owner pasted has been read, so a review of it is an honest sentence; without the paste it is not.
  const review = 'I reviewed your code and found two problems: the loop is off by one and the return adds one.';
  assert.equal(guardExecutionClaims(review, { message: 'review this code: function f(a){ for (let i=0;i<=a.length;i++) {} return a+1 }', documentRead: true }).removed.length, 0);
  assert.equal(guardExecutionClaims(review, { message: 'did you review my repository?' }).removed.length, 1);
  // One honest "not" in another sentence never covers a fabrication in this one.
  const covered = guardExecutionClaims('The journal is not summed with the simulation. I retrieved the records from my storage and the best trade made +$412.50 on 2023-03-10.', { message: 'and?' });
  assert.deepEqual(covered.removed, ['I retrieved the records from my storage and the best trade made +$412.50 on 2023-03-10.']);
  assert.equal(guardRetrievalClaims('I retrieved the records from my storage without issue: +$180.').removed.length, 1);
});

test('a denial, a plain answer and a real receipt pass; flagOnly keeps the sentence marked', () => {
  for (const honest of [
    'I have not reviewed the code and cannot read the ledger from here, sir.',
    'Nothing was retrieved for this answer: I have no record of that trade.',
    'The simulation and the journal are different record sets; ask me for either and I will read it.',
    'Your meeting is at 3 and the groceries are milk, eggs and bread.',
  ]) {
    assert.equal(guardExecutionClaims(honest, { message: 'tell me' }).removed.length, 0, honest);
    assert.equal(guardRetrievalClaims(honest).removed.length, 0, honest);
  }
  const flagged = guardRetrievalClaims('The source shows readSimState. I retrieved the row from the records table. Codex can confirm.', { flagOnly: true, keys: false });
  assert.equal(flagged.removed.length, 1);
  assert.match(flagged.text, /^The source shows readSimState\. I retrieved the row from the records table\. \[NOT VERIFIED\] Codex can confirm\.$/);
  const cut = guardRetrievalClaims('The source shows readSimState. I retrieved the row from the records table. Codex can confirm.');
  assert.equal(cut.text, 'The source shows readSimState. Codex can confirm.');
  const keyQuoted = guardRetrievalClaims('The simulation state lives under storage key strategy_sim_state in the source.', { keys: false });
  assert.equal(keyQuoted.removed.length, 0);
});

test('through /api/chat a fabricated retrieval never reaches the owner as text, stream or speech', async () => {
  const che = await owner({ model: () => FABRICATED });
  const out = await che.say('What did you find in the records you mentioned earlier?');
  assert.equal(out.modelCalls >= 1, true, 'the model path was taken');
  assert.doesNotMatch(out.reply, /sim-2023|paper-2023|simulation_trades|journal_trades|\$412|\$180|lookup tool/);
  assert.match(out.reply, /not evidence|cannot verify/i);
});

test('a real adapter receipt still renders when the model text around it is fabricated', async () => {
  const { receipt } = await executeWithReceipt({ tool: 'storage', operation: 'read strategy_sim_state', source: 'durable storage', request_id: 'req-1', run: async () => ({ ok: true, trades: 172 }), response: (r) => ({ trades: r.trades }) });
  const out = guardExecutionClaims('I retrieved it from storage key simulation_trades: sim-2023-03-10-001 made $412.', { message: 'how many?', receipts: [receipt] });
  assert.match(out.text, /Execution receipt .*storage read strategy_sim_state, success/);
  assert.match(out.text, /"trades":172/);
  assert.doesNotMatch(out.text, /sim-2023|\$412/);
});
