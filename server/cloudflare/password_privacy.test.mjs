// Owner rule (AGENTS.md): a password is never sent to the Worker's model, AI
// provider, chat history, memory or logs. These tests run the real /api/chat
// route offline: the fake model records every input it is sent.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { PASSWORD_PLACEHOLDER, hasPasswordSentence, redactPasswordSentences, redactSecrets, scrubAuditEntry } from './privacy_policy.js';
import { TEST_RUN_HONEST_REPLY, guardTestRunClaims, testRunRequest } from './truth_layer.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.password_privacy.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const SECRETS = ['hunter2', 'Blue$tone9', 'correct horse battery'];

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Here is the answer, sir.' } = {}) {
  const inputs = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { inputs.push(input); return { response: model(input) }; } },
  };
  const connect = () => {
    const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
  };
  connect();
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const say = async (message, history = []) => {
    const before = inputs.length;
    const res = await send('/api/chat', { message, history }, token);
    const raw = await res.text();
    await settle();
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = events.find((e) => e.type === 'done') || {};
    return { raw, done, reply: replyFromNdjson(raw), modelCalls: inputs.length - before, status: res.status };
  };
  return { say, saved, inputs };
}

// Everything CHE keeps, serialized: the audit log, chat-facing state, memory.
const stored = (saved) => JSON.stringify([...saved.entries()]);

test('the redactor replaces a password value and keeps the rest of the sentence', () => {
  assert.equal(redactPasswordSentences('my gmail password is hunter2').text, `my gmail password is ${PASSWORD_PLACEHOLDER}`);
  assert.equal(redactPasswordSentences('my bank password: Blue$tone9').text, `my bank password: ${PASSWORD_PLACEHOLDER}`);
  assert.equal(redactPasswordSentences('the wifi password is correct horse battery').text, `the wifi password is ${PASSWORD_PLACEHOLDER}`);
  assert.equal(redactPasswordSentences('gmail password = x1y2z3').text, `gmail password = ${PASSWORD_PLACEHOLDER}`);
  assert.equal(redactPasswordSentences('my password is hunter2, and check my inbox.').text, `my password is ${PASSWORD_PLACEHOLDER}.`);
  assert.deepEqual(redactPasswordSentences('my gmail password is hunter2').secrets, ['hunter2']);
  assert.equal(redactSecrets('my gmail password is hunter2 for the account'), `my gmail password is ${PASSWORD_PLACEHOLDER}`);
});

test('the redactor leaves sentences that mention a password without a value alone', () => {
  for (const text of ['how do I reset my password?', 'what is my gmail password?', 'passwords are stored where?',
    'my password is in the vault', 'my password is not working', "my password isn't working", 'the test for the password vault is in test/che_password_vault_test.dart']) {
    assert.equal(hasPasswordSentence(text), false, text);
    assert.equal(redactPasswordSentences(text).text, text);
  }
});

test('the audit scrub covers every text field and older records', () => {
  assert.equal(scrubAuditEntry({ task: 'my gmail password is hunter2', route: 'owner_chat' }).task, `my gmail password is ${PASSWORD_PLACEHOLDER}`);
});

for (const message of ['my gmail password is hunter2', 'my bank password: Blue$tone9', 'the wifi password is correct horse battery']) {
  test(`/api/chat refuses a password sentence before any model, audit or memory write: "${message}"`, async () => {
    const che = await owner();
    const res = await che.say(message);
    assert.equal(res.status, 200);
    assert.equal(res.done.source, 'che_password_refused');
    assert.equal(res.modelCalls, 0, 'no model call');
    assert.equal(res.done.ok, false);
    for (const secret of SECRETS) {
      assert.equal(res.raw.includes(secret), false, `reply echoes "${secret}"`);
      assert.equal(stored(che.saved).includes(secret), false, `storage keeps "${secret}"`);
    }
    assert.equal(che.saved.has('ai_audit'), false, 'no audit record was written');
  });
}

test('a password in the chat history never reaches the model, the audit log or the reply', async () => {
  const che = await owner({ model: () => 'Your question is answered, sir.' });
  const history = [
    { role: 'user', content: 'my gmail password is hunter2' },
    { role: 'assistant', content: 'I did not keep that, sir.' },
  ];
  const res = await che.say('how do I reset my password?', history);
  assert.equal(res.modelCalls, 1, 'an ordinary question still reaches the model');
  const sent = JSON.stringify(che.inputs);
  assert.equal(sent.includes('hunter2'), false, 'model input must not contain the password');
  assert.ok(sent.includes('how do I reset my password?'), 'the question itself is sent unchanged');
  assert.equal(stored(che.saved).includes('hunter2'), false, 'audit and storage must not contain the password');
  assert.equal(res.raw.includes('hunter2'), false);
});

test('an old audit record that holds a password is scrubbed when the log is next written', async () => {
  const saved = new Map([['ai_audit', [{ at: '2026-10-01T00:00:00.000Z', task: 'my gmail password is hunter2', route: 'owner_chat', provider: 'x', model: 'y' }]]]);
  const che = await owner({ saved });
  await che.say('how do I reset my password?');
  assert.equal(stored(che.saved).includes('hunter2'), false);
});

test('"run the tests" gets the honest answer with no model call and claims no run', async () => {
  for (const message of ['run the tests', 'run the worker tests', 'CHE, run the test suite']) {
    const che = await owner({ model: () => 'I ran all the Worker tests just now: 2077 tests, 2070 passed.' });
    const res = await che.say(message);
    assert.equal(res.modelCalls, 0, `${message}: no model call`);
    assert.equal(res.done.source, 'che_tests_not_run', message);
    assert.equal(res.reply, TEST_RUN_HONEST_REPLY, message);
    assert.equal(/2077|2070|passed|ran all/i.test(res.reply), false, 'no invented count or run');
    assert.match(res.reply, /have not run any tests/);
    assert.match(res.reply, /\/che-release/);
  }
});

test('a model reply that claims a test run with counts is replaced by the honest answer', async () => {
  const che = await owner({ model: () => 'I ran all the Worker tests just now: 2077 tests, 2070 passed.' });
  const res = await che.say('how is the vault code doing?');
  assert.equal(res.modelCalls, 1, 'the question reaches the model');
  assert.equal(res.reply, TEST_RUN_HONEST_REPLY);
  assert.equal(res.raw.includes('2077'), false);
});

test('the claim guard keeps ordinary sentences about tests and backed claims', () => {
  const vault = 'the test file for the vault is test/che_password_vault_test.dart';
  assert.equal(guardTestRunClaims(vault, { receipts: [] }).text, vault);
  assert.equal(guardTestRunClaims(vault, { receipts: [] }).removed.length, 0);
  const claim = 'I ran all the Worker tests just now: 2077 tests, 2070 passed.';
  assert.equal(guardTestRunClaims(claim, { receipts: [] }).text, TEST_RUN_HONEST_REPLY);
  const backed = guardTestRunClaims(claim, { receipts: [{ kind: 'test_run', tests: 2077, passed: 2070, failed: 7, at: new Date().toISOString() }] });
  assert.equal(backed.removed.length, 0, 'a real test_run receipt with the same counts keeps the claim');
  assert.equal(guardTestRunClaims('All tests passed.', { receipts: [{ kind: 'ci_passed', at: new Date().toISOString() }] }).removed.length, 0);
  assert.equal(testRunRequest('run the tests'), true);
  assert.equal(testRunRequest('explain the tests'), false);
});
