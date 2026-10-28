// The universal problem controller on CHE's real chat route. A typed sum is answered by the controller with an execution
// receipt and no model call; a sentence about maths, or a goal with no verified path, goes to the model as before.
// Runs the real worker.js /api/chat (the same harness as chat_relevance.test.mjs), offline, with a fake model.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.problem_controller_route.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function app({ reply = 'Forty-two, sir.' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const saved = new Map();
  const modelInputs = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { modelInputs.push(String(input?.messages?.at(-1)?.content || '')); return { response: reply }; } },
  };
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql,
  };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (method, path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const token = (await (await send('POST', '/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, history = []) => {
    const before = modelInputs.length;
    const res = await send('POST', '/api/chat', { message, history }, token);
    const raw = await res.text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const text = items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { status: res.status, text, done, raw, modelCalls: modelInputs.length - before };
  };
  return { say };
}

test('a typed sum reaches the controller on the real route: verified answer, receipt, no model call', async () => {
  const che = await app();
  const out = await che.say('CHE, what is 12 times 17?');
  assert.equal(out.status, 200);
  assert.equal(out.text, '204.');
  assert.equal(out.done.source, 'che_arithmetic');
  assert.equal(out.modelCalls, 0, 'the model was not called');
  const receipt = out.done.execution_receipt;
  assert.equal(receipt.tool, 'arithmetic');
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.capability_id, 'math.exact_arithmetic');
  assert.ok(receipt.correlation_id, 'a correlation id traces the request');
  assert.ok(receipt.steps.some((s) => s.step === 'verify' && s.result === 'agrees'), 'the round trip agreed');
});

test('the precedence case the controller caught is right on the route: -2^2 + 5 is 1', async () => {
  const che = await app();
  const out = await che.say('what is -2^2 + 5');
  assert.equal(out.text, '1.');
  assert.equal(out.modelCalls, 0);
});

test('an undefined sum is answered as an error with its receipt, not guessed', async () => {
  const che = await app();
  const out = await che.say('what is 5 / 0');
  assert.equal(out.text, 'Division by zero has no answer, sir.');
  assert.equal(out.done.execution_receipt.status, 'error');
  assert.equal(out.modelCalls, 0);
});

test('a sentence about maths is not a sum: the model answers it, and no receipt is claimed', async () => {
  const che = await app({ reply: 'Twelve times seventeen is a multiplication fact from school.' });
  const out = await che.say('Tell me about 12 times 17 in history');
  assert.equal(out.done.source === 'che_arithmetic', false);
  assert.equal(out.done.execution_receipt, undefined, 'no controller receipt for a non-sum');
  assert.equal(out.modelCalls, 1, 'the model answered, as before');
});

test('a goal with no verified path falls through to the model, with no invented answer', async () => {
  const che = await app({ reply: 'Madrid, sir.' });
  const out = await che.say('What is the capital of Spain?');
  assert.equal(out.text, 'Madrid, sir.');
  assert.equal(out.modelCalls, 1);
  assert.equal(out.done.execution_receipt, undefined);
});
