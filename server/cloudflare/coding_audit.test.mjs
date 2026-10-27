// Coding audit (Reliability Test 2, 2026-10-27): "Why did my coding agent fail, what did it try, and what
// actually happened?" is answered from the runner's own records on che-mailbox, never by the model.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyFailure, clearAuditCache, codingAuditApi, codingAuditIntent, codingAuditTurn, listRuns, noStoredJobReceipt,
  normalizeRecord, readRun, sanitizeText, speakRun,
} from './coding_audit.js';

const fixture = (id) => JSON.parse(readFileSync(new URL(`./fixtures/coding_runtime/${id}.json`, import.meta.url), 'utf8'));
const QWEN = fixture('ocr-49bea5b4'); // real record: one attempt, OpenCode "Unexpected server error"
const MERGED = fixture('ocr-cb88d817'); // real record: merged as PR #150 with its merge commit
const SIX = fixture('ocr-ee486cba'); // real record: six models tried, no per-attempt receipts
const ENV = { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app' };

// A fake GitHub: the runtime directory, its commit history and each record, from `records` (id → record).
function github(records, { fail = null, commitsFail = false } = {}) {
  const calls = [];
  const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
  const fetcher = async (url) => {
    const u = String(url);
    calls.push(u);
    if (fail) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: fail });
    if (u.includes('/contents/mailbox/runtime?ref=che-mailbox')) return ok(Object.keys(records).map((id) => ({ type: 'file', name: `${id}.json`, sha: `blob-${id}` })));
    if (u.includes('/commits?sha=che-mailbox')) {
      if (commitsFail) return new Response('{}', { status: 502 });
      return ok(Object.keys(records).map((id, i) => ({ commit: { message: `runtime: ${id}`, committer: { date: new Date(Date.UTC(2026, 9, 26, 1, 0) - i * 3_600_000).toISOString() } } })));
    }
    const m = /\/contents\/mailbox\/runtime\/(ocr-[0-9a-f]{8})\.json\?ref=che-mailbox/.exec(u);
    if (m && records[m[1]]) return ok({ sha: `blob-${m[1]}`, content: Buffer.from(JSON.stringify(records[m[1]])).toString('base64') });
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  return { fetcher, calls };
}

test('a real qwen failure record: one attempt, no fallback, a runner-internal error, not a provider outage', () => {
  const run = normalizeRecord(QWEN, { name: 'ocr-49bea5b4.json', repo: 'Vondada/chey-app' });
  assert.equal(run.id, 'ocr-49bea5b4');
  assert.equal(run.attempts.source, 'attempt ledger');
  assert.equal(run.attempts.list.length, 1);
  const [a] = run.attempts.list;
  assert.equal(a.provider, 'openrouter');
  assert.equal(a.model, 'openrouter/qwen/qwen3.8-27b:free');
  assert.equal(a.exit_code, 1);
  assert.equal(a.seconds, 2);
  assert.match(a.error, /^UnknownError: Unexpected server error\. Check server logs for details\. \(ref err_6c7e99e3\)$/);
  assert.equal(run.fallback.attempted, false);
  assert.equal(run.outcome, 'failed');
  assert.deepEqual([run.failure_class.layer, run.failure_class.category], ['runner', 'runner_internal_error']);
  assert.equal(run.ci.workflow_run_url, 'https://github.com/Vondada/chey-app/actions/runs/40253860341');
  assert.equal(run.pr_number, 'not recorded');
  const said = speakRun(run);
  assert.match(said, /Fallback: none; only one model was tried\./);
  assert.match(said, /does not say whether the model provider caused it/);
  assert.match(said, /Evidence: che-mailbox mailbox\/runtime\/ocr-49bea5b4\.json; https:\/\/github\.com\/Vondada\/chey-app\/actions\/runs\/40253860341\./);
  assert.doesNotMatch(said, /succeeded|completed: merged|telemetry/i);
});

test('the real merged record is the only kind called completed, with PR and merge commit as evidence', () => {
  const run = normalizeRecord(MERGED, { repo: 'Vondada/chey-app' });
  assert.equal(run.outcome, 'succeeded');
  assert.equal(run.pr_number, 150);
  assert.equal(run.merge_commit_sha, '9dcab9f24564705782533a9b77b81af6f73d4956');
  assert.equal(run.ci.ci_run_id, 37154488959);
  assert.equal(run.attempts.source, 'models_tried (no per-attempt receipts)');
  assert.ok(run.not_recorded.includes('per_attempt_receipts'));
  assert.match(speakRun(run), /Outcome: completed: merged, with its pull request and merge commit on record\..*pull\/150/);
  // The same state without the evidence is not success.
  const bare = normalizeRecord({ ...MERGED, merge_commit_sha: undefined });
  assert.equal(bare.outcome, 'unverified');
  assert.equal(normalizeRecord({ ...MERGED, pr_number: undefined }).outcome, 'unverified');
});

test('fallback is detected from the model order, and the legacy error text is read as words', () => {
  const run = normalizeRecord(SIX);
  assert.equal(run.fallback.attempted, true);
  assert.deepEqual(run.fallback.models_in_order, SIX.models_tried);
  assert.match(speakRun(run), /Fallback: yes, it moved through 6 models in this order: openrouter\/qwen\/qwen3\.8-27b:free then google\/gemini-2\.5-pro/);
  // Per-attempt detail the record never held is not invented.
  assert.equal(run.attempts.list[0].exit_code, 'not recorded');
  assert.equal(run.attempts.list[0].error, 'not recorded');
});

test('provider failures and tool/runner failures are told apart', () => {
  const layer = (rec) => { const r = normalizeRecord({ session_id: 'ocr-11111111', state: 'blocked', ...rec }); return [r.failure_class.layer, r.failure_class.category]; };
  const attempt = (error, extra = {}) => ({ failure: 'opencode_failed', attempts: [{ model: 'groq/x', exit_code: 1, kind: 'unknown', error, ...extra }] });
  assert.deepEqual(layer(attempt('{"statusCode": 503, "message": "Service Unavailable"}')), ['provider', 'provider_5xx']);
  assert.deepEqual(layer(attempt('You exceeded your current quota')), ['provider', 'quota']);
  assert.deepEqual(layer(attempt('x', { kind: 'rate_limit' })), ['provider', 'rate_limit']);
  assert.deepEqual(layer(attempt('The model `m` does not exist or you do not have access to it.')), ['provider', 'access']);
  assert.deepEqual(layer(attempt('ContextOverflowError: Request too large')), ['provider', 'too_large']);
  assert.deepEqual(layer(attempt('', { exit_code: 124, kind: 'timeout' })), ['runner', 'timeout']);
  assert.deepEqual(layer({ failure: 'opencode_failed', opencode_exit_code: 1, models_tried: [], attempts: [] }), ['runner', 'no_attempt']);
  assert.deepEqual(layer({ failure: 'unsafe_files', unsafe_files: ['server/cloudflare/package.json'], models_tried: ['a/b'] }), ['guard', 'unsafe_files']);
  assert.deepEqual(layer({ failure: 'deliver_failed', models_tried: ['a/b'] }), ['delivery', 'deliver_failed']);
  assert.deepEqual(layer({ state: 'tests_failed', models_tried: ['a/b'] }), ['tests', 'tests_failed']);
  assert.deepEqual(layer({ state: 'review_rejected', failure: 'opencode_failed', models_tried: ['a/b'] }), ['review', 'review_rejected']);
  assert.equal(classifyFailure(normalizeRecord(MERGED)).layer, 'none');
});

test('token-like strings in a record never leave the audit: not in the normalized run, the reply or the API', async () => {
  const secrets = ['sk-or-v1-0123456789abcdefABCDEF0123', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'ak-ZXCVBNMASDFGHJKL1234', 'AKIAIOSFODNN7EXAMPLE1', 'deadbeefdeadbeefdeadbeefdeadbeef00', 'QmFzZTY0U2VjcmV0VG9rZW5WYWx1ZTEyMzQ1Njc4OTA=', 'hunter2pass', 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123'];
  const record = {
    session_id: 'ocr-5ec7e700', state: 'blocked', failure: 'opencode_failed', run_id: 1, review: `APPROVE ${secrets[1]}`,
    error: `Bearer ${secrets[0]} failed`, new_ledger_note: `retry with ${secrets[3]}`, target_branch: `che/${secrets[5]}`,
    attempts: [{ model: 'openrouter/x', exit_code: 1, kind: 'unknown', error: `{"type":"error","error":{"name":"APIError","data":{"message":"Authorization: Bearer ${secrets[0]} ${secrets[1]} ${secrets[2]} https://user:${secrets[7]}@api.example.com ${secrets[4]} ${secrets[6]} ${secrets[8]} key=${secrets[3]}"}}}`, provider_note: secrets[5] }],
  };
  const run = normalizeRecord(record, { repo: 'o/r' });
  const { fetcher } = github({ 'ocr-5ec7e700': record });
  clearAuditCache();
  const turn = await codingAuditTurn('show coding attempts for ocr-5ec7e700', ENV, { owner: true, fetcher });
  clearAuditCache();
  const api = await (await codingAuditApi(new Request('https://che.local/api/coding/audit/ocr-5ec7e700'), '/api/coding/audit/ocr-5ec7e700', ENV, true, { fetcher })).text();
  for (const out of [JSON.stringify(run), turn.text, api]) {
    for (const secret of secrets) assert.ok(!out.includes(secret), `leaked ${secret.slice(0, 8)}…`);
  }
  assert.match(turn.text, /APIError/);
  assert.equal(run.extra_fields.new_ledger_note.includes('[key]'), true, 'a newer field passes through, redacted');
  assert.equal(sanitizeText(`see https://bob:pw@host/x`), 'see https://[credentials]@host/x');
});

test('newer record fields are tolerated and passed through; odd field types read as not recorded', () => {
  const run = normalizeRecord({ session_id: 'ocr-22222222', state: 'blocked', failure: 'opencode_failed', changed_files: { n: 1 }, run_id: 'x',
    attempts: [{ model: 'a/b', exit_code: 1, kind: 'unknown', error: 'boom', provider_status: 503, fallback_reason: 'next model', ledger: [1, 2] }], router_decision: 'free first' });
  assert.equal(run.changes.changed_files, 'not recorded');
  assert.equal(run.ci.workflow_run_id, 'not recorded');
  assert.deepEqual(run.attempts.list[0].extra, { provider_status: 503, fallback_reason: 'next model', ledger: '[list of 2]' });
  assert.equal(run.extra_fields.router_decision, 'free first');
  assert.doesNotMatch(speakRun(run), /\[object Object\]|NaN|undefined/);
});

test('a nonexistent run id is said to have no record, and nothing is made up', async () => {
  clearAuditCache();
  const { fetcher } = github({ 'ocr-49bea5b4': QWEN });
  const res = await readRun(ENV, 'ocr-00000000', { fetcher });
  assert.equal(res.found, false);
  const turn = await codingAuditTurn('Show coding attempts for ocr-00000000', ENV, { owner: true, fetcher });
  assert.equal(turn.meta.outcome, 'no_match');
  assert.match(turn.text, /^There is no coding run record ocr-00000000, sir: mailbox\/runtime\/ocr-00000000\.json does not exist on che-mailbox\./);
  assert.doesNotMatch(turn.text, /attempt|model|merged|failed because/i);
});

test('a GitHub read failure is said as that failure with its status, never as missing telemetry', async () => {
  for (const status of [401, 500]) {
    clearAuditCache();
    const { fetcher } = github({}, { fail: status });
    const turn = await codingAuditTurn('Why did my coding agent fail?', ENV, { owner: true, fetcher });
    assert.equal(turn.meta.outcome, 'storage_failed');
    assert.equal(turn.meta.status, status);
    assert.match(turn.text, new RegExp(`HTTP ${status}: Bad credentials`));
    assert.match(turn.text, /I won't guess/);
    assert.doesNotMatch(turn.text, /telemetry|no record|ocr-/i);
    const one = await codingAuditTurn('show coding attempts for ocr-49bea5b4', ENV, { owner: true, fetcher });
    assert.equal(one.meta.outcome, 'storage_failed', 'a failed read is never "no such record"');
  }
  const none = await codingAuditTurn('Why did my coding agent fail?', {}, { owner: true, fetcher: async () => { throw new Error('no call expected'); } });
  assert.match(none.text, /no GitHub credentials/);
});

test('the failure summary reads the newest records in commit order, bounded, and names the repeated failure', async () => {
  clearAuditCache();
  const records = { 'ocr-49bea5b4': QWEN, 'ocr-aaaaaaa1': { ...QWEN, session_id: 'ocr-aaaaaaa1' }, 'ocr-cb88d817': MERGED };
  const { fetcher, calls } = github(records);
  const turn = await codingAuditTurn('Why did my coding agent fail, what did it try, and what actually happened?', ENV, { owner: true, fetcher });
  assert.equal(turn.meta.source, 'che_coding_audit');
  assert.equal(turn.meta.model_calls, 0);
  assert.equal(turn.meta.total_records, 3);
  assert.match(turn.text, /3 in mailbox\/runtime on che-mailbox; the newest 3, ordered by commit history\)\. Of those: 2 failed, 1 succeeded\./);
  assert.match(turn.text, /2 of the 3 newest runs failed the same way \(runner internal error on openrouter\/qwen\/qwen3\.8-27b:free\)/);
  assert.match(turn.text, /The latest failure: Coding run ocr-49bea5b4/);
  assert.ok(calls.length <= 5, `bounded reads: ${calls.length}`);
  // Cached briefly: a second ask in the same minute makes no GitHub call.
  const before = calls.length;
  await codingAuditTurn('What did the coding agent try?', ENV, { owner: true, fetcher });
  assert.equal(calls.length, before);
  // Without the commit order the records are still listed, and the order is said to be unknown.
  clearAuditCache();
  const listed = await listRuns(ENV, { fetcher: github(records, { commitsFail: true }).fetcher });
  assert.match(listed.order, /^unknown \(the commit history read failed: HTTP 502\)$/);
  assert.equal(listed.runs.length, 3);
});

test('guests get no records, and the HTTP routes are owner-only', async () => {
  const { fetcher, calls } = github({ 'ocr-49bea5b4': QWEN });
  const turn = await codingAuditTurn('Why did my coding agent fail?', ENV, { owner: false, fetcher });
  assert.equal(turn.meta.outcome, 'permission_denied');
  const res = await codingAuditApi(new Request('https://che.local/api/coding/audit'), '/api/coding/audit', ENV, false, { fetcher });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
  clearAuditCache();
  const list = await codingAuditApi(new Request('https://che.local/api/coding/audit?limit=5'), '/api/coding/audit', ENV, true, { fetcher });
  const body = await list.json();
  assert.equal(list.status, 200);
  assert.equal(body.runs[0].id, 'ocr-49bea5b4');
  assert.equal((await codingAuditApi(new Request('https://che.local/api/coding/audit/ocr-00000000'), '/api/coding/audit/ocr-00000000', ENV, true, { fetcher })).status, 404);
  assert.equal((await codingAuditApi(new Request('https://che.local/api/coding/audit/nope'), '/api/coding/audit/nope', ENV, true, { fetcher })).status, 400);
  assert.equal((await codingAuditApi(new Request('https://che.local/api/coding/audit', { method: 'POST' }), '/api/coding/audit', ENV, true, { fetcher })).status, 405);
});

test('the audit intent: the owner\'s wordings and speech-recognition variants, not instructions or relays', () => {
  for (const m of ['Why did my coding agent fail, what did it try, and what actually happened?', 'Why did my coding agent fail?', 'What did the coding agent try?',
    'what did my coding job try', 'why did my coating agent fail', 'why did my codeing agent fail', 'what happened to my coding agent', 'did the coding agent fall back to another model',
    'why did the open code runner fail', 'what models did the coding agent try']) assert.equal(codingAuditIntent(m), 'failure', m);
  for (const m of ['Show coding attempts for ocr-1a2b3c4d', 'why did ocr-49bea5b4 fail', 'what happened in ocr 49bea5b4', 'audit ocr-49bea5b4']) assert.equal(codingAuditIntent(m), 'run', m);
  for (const m of ['show my coding runs', 'list my recent coding runs', 'coding audit', 'coding attempts', 'coding run history']) assert.equal(codingAuditIntent(m), 'list', m);
  for (const m of ['Why did the coding job fail?', 'coding history', 'coding status', 'Fix why my coding agent fails', 'Tell Claude why the coding agent failed',
    'Retry the failed coding job', 'Why did the coding agent fail? Retry it.', 'Ask ChatGPT why did the coding job fail?', 'Make the coding agent stop failing',
    'why did my trade fail', 'what did you try for dinner', 'Remember that the coding agent failed because of quota']) assert.equal(codingAuditIntent(m), '', m);
});

test('"coding status" with nothing stored on the device names the runner\'s newest record instead of "no job"', async () => {
  clearAuditCache();
  const text = await noStoredJobReceipt(ENV, { fetcher: github({ 'ocr-49bea5b4': QWEN }).fetcher });
  assert.match(text, /^No coding job is stored on this device, sir, but my coding runner's newest record on GitHub \(of 1\) is this\. Coding run ocr-49bea5b4/);
  clearAuditCache();
  assert.equal(await noStoredJobReceipt(ENV, { fetcher: github({}).fetcher }), 'No coding job has started yet, sir.');
  assert.equal(await noStoredJobReceipt({}), 'No coding job has started yet, sir.');
  clearAuditCache();
  assert.match(await noStoredJobReceipt(ENV, { fetcher: github({}, { fail: 500 }).fetcher }), /could not check my coding runner's records on GitHub: .*HTTP 500/);
});

// ─── Through the real /api/chat ─────────────────────────────────────────────────────────────────────────────
const generated = new URL('./.coding_audit.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
));
let mod;
try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) { /* gone */ } }

function storageFor(saved) {
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => (Array.isArray(k) ? k.filter((x) => saved.delete(x)).length : saved.delete(k)),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

async function chatWith(fetcher, { guest = false } = {}) {
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...ENV, AI: { run: async () => { modelCalls += 1; return { response: 'I lack an authorized telemetry connection, sir.' }; } } };
  const state = new mod.CheState({ storage: storageFor(new Map()), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token, method = 'POST') => mod.default.fetch(new Request(`https://che.local${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.github.com/') ? fetcher(url, init) : new Response('{}', { status: 503 }));
  const token = guest ? '' : (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const ask = async (message) => {
    const lines = (await (await send('/api/chat', { message }, token)).text()).trim().split('\n').map((l) => JSON.parse(l));
    return { text: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') || {} };
  };
  return { ask, get: (path) => send(path, null, token, 'GET'), models: () => modelCalls, restore: () => { globalThis.fetch = real; } };
}

test('/api/chat: the Reliability Test 2 question is answered from the records with 0 model calls', async () => {
  clearAuditCache();
  const chat = await chatWith(github({ 'ocr-49bea5b4': QWEN, 'ocr-cb88d817': MERGED }).fetcher);
  try {
    const { text, done } = await chat.ask('Why did my coding agent fail, what did it try, and what actually happened?');
    assert.equal(done.source, 'che_coding_audit');
    assert.equal(done.model_calls, 0);
    assert.equal(chat.models(), 0);
    assert.match(text, /The latest failure: Coding run ocr-49bea5b4/);
    assert.match(text, /What it tried: 1 attempt: 1\. openrouter\/qwen\/qwen3\.8-27b:free, exit code 1/);
    assert.doesNotMatch(text, /telemetry/i);
    const one = await chat.ask('show coding attempts for ocr-cb88d817');
    assert.match(one.text, /Pull request: #150\. Merge commit: 9dcab9f24564\./);
    const missing = await chat.ask('show coding attempts for ocr-00000000');
    assert.match(missing.text, /There is no coding run record ocr-00000000/);
    // The existing record route keeps its own question, and with nothing stored it names the runner's newest record.
    const status = await chat.ask('Why did the coding job fail?');
    assert.equal(status.done.source, 'che_coding_history');
    assert.match(status.text, /No coding job is stored on this device, sir, but my coding runner's newest record on GitHub \(of 2\) is this\. Coding run ocr-49bea5b4/);
    const api = await chat.get('/api/coding/audit/ocr-49bea5b4');
    assert.equal(api.status, 200);
    assert.equal((await api.json()).run.failure_class.category, 'runner_internal_error');
    assert.equal(chat.models(), 0);
  } finally {
    chat.restore();
  }
});

test('/api/chat: a GitHub failure is an honest failed read through the real route', async () => {
  clearAuditCache();
  const chat = await chatWith(github({}, { fail: 403 }).fetcher);
  try {
    const { text, done } = await chat.ask('Why did my coding agent fail?');
    assert.equal(done.source, 'che_coding_audit');
    assert.equal(done.outcome, 'storage_failed');
    assert.match(text, /HTTP 403/);
    assert.equal(chat.models(), 0);
  } finally {
    chat.restore();
  }
});

// ─── The deploy's live check ──────────────────────────────────────────────────────────────────────────────
async function deployProbe(fetcher, { model = 'Here is the answer, sir.' } = {}) {
  clearAuditCache();
  const states = new Map();
  const token = 'p'.repeat(40);
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: token, ...ENV, AI: { run: async () => { modelCalls += 1; return { response: model }; } } };
  env.CHE_STATE = { getByName: (name) => {
    if (!states.has(name)) states.set(name, new mod.CheState({ storage: storageFor(new Map()), waitUntil: () => {}, id: { name } }, env));
    return { fetch: (request) => states.get(name).fetch(request) }; // production stubs expose fetch only
  } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.github.com/') ? fetcher(url, init) : new Response('{}', { status: 503 }));
  try {
    const denied = await mod.default.fetch(new Request('https://che.example/api/coding-audit/probe', { method: 'POST' }), env);
    const res = await mod.default.fetch(new Request('https://che.example/api/coding-audit/probe', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env);
    return { denied: denied.status, report: await res.json(), modelCalls, states };
  } finally {
    globalThis.fetch = real;
  }
}

test('the deploy probe asks the isolated test CHE the Reliability Test 2 question and a missing id, from the records', async () => {
  const { denied, report, modelCalls, states } = await deployProbe(github({ 'ocr-49bea5b4': QWEN, 'ocr-cb88d817': MERGED }).fetcher);
  assert.equal(denied, 404, 'no route without the per-deploy token');
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 1));
  assert.deepEqual(report.steps.map((s) => [s.route, s.model_calls, s.outcome]), [['che_coding_audit', 0, 'retrieved'], ['che_coding_audit', 0, 'no_match']]);
  assert.equal(modelCalls, 0);
  assert.equal(states.has('owner'), false, 'the owner\'s CHE is never asked');
  assert.doesNotMatch(JSON.stringify(report), /p{40}|123456|test-token|device_token/);
});

test('the deploy probe fails on a failed record read, and its guard catches a missing-access claim', async () => {
  const { report } = await deployProbe(github({}, { fail: 401 }).fetcher);
  assert.equal(report.ok, false);
  assert.equal(report.steps[0].pass, false);
  assert.match(report.steps[0].reply, /HTTP 401/);
  const { CLAIMS_MISSING_ACCESS } = await import('./coding_audit.js');
  for (const claim of ["I don't have an authorized telemetry or audit-log connection to my coding providers' runtime records.", 'I would need a new plugin for that.', 'That needs a GitHub connector.', 'I lack an authorized runtime connection.']) assert.match(claim, CLAIMS_MISSING_ACCESS, claim);
  // The record's own words never trip it.
  assert.doesNotMatch(speakRun(normalizeRecord(QWEN)), CLAIMS_MISSING_ACCESS);
  assert.doesNotMatch(speakRun(normalizeRecord({ ...QWEN, attempts: [{ ...QWEN.attempts[0], kind: 'access', error: 'The model does not exist or you do not have access to it.' }] })), CLAIMS_MISSING_ACCESS);
});
