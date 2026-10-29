// Owner chat reliability (owner, 2026-10-28): a long, multi-part message reaches the model whole, a reply that the
// checks remove completely is named (never a blank success), and a prompt-size failure is told apart from a general
// response failure. Each test runs the real /api/chat route with a fake model and reads what the owner's phone gets.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.chat_reliability.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState, emptyReplyStream } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// Every model call is recorded with the user message it received. `reply` is what the fake model answers.
async function app(reply = 'Understood, sir.') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const saved = new Map();
  const userMessages = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { userMessages.push(String(input?.messages?.at(-1)?.content || '')); return { response: reply }; } },
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
  const say = async (message) => {
    const before = userMessages.length;
    const res = await send('POST', '/api/chat', { message, history: [] }, token);
    const raw = await res.text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const reply = items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    const error = items.find((i) => i.type === 'error') || null;
    const done = items.find((i) => i.type === 'done') || {};
    const modelInputs = userMessages.slice(before);
    return { status: res.status, reply, error, done, body: raw, modelCalls: modelInputs.length, modelInputs };
  };
  return { say, send, token, userMessages };
}

// A five-part request in the shape the owner sent (truthfulness, problem solving, memory, coding, autonomy). The
// memory part is worded so the deterministic history route does not answer for it: the model must.
const FIVE_PART = [
  '1) Truthfulness: say how sure you are about your own abilities, and what you cannot check.',
  '2) Problem solving: 17 times 23, step by step, then a sanity check.',
  '3) Coding: write a JavaScript function that reverses a string, and say how you tested it.',
  '4) Autonomy: a test fails in a plan you wrote; what do you do next without asking, and what needs my yes?',
  '5) Follow-up: summarize the five answers in one short paragraph.',
].join('\n');

test('the five-part request reaches the model whole and gets a reply, not the "could not generate" line', async () => {
  const che = await app('Sure, sir. Here are all five parts, answered in order.');
  const out = await che.say(FIVE_PART);
  assert.equal(out.status, 200);
  assert.ok(out.modelInputs.includes(FIVE_PART), 'a model call received the full five-part message unchanged');
  assert.match(out.reply, /Here are all five parts/);
  assert.equal(out.error, null);
  assert.doesNotMatch(out.body, /could not generate/i);
});

test('a long five-part request near the intake limit is accepted and its last part reaches the model', async () => {
  const part = (n) => `${n}) ${'Explain this step with its reasoning and a check. '.repeat(52)}`;
  const long = [1, 2, 3, 4, 5].map(part).join('\n');
  assert.ok(long.length > 12000 && long.length < 16000, `long request is ${long.length} characters`);
  const che = await app('Five parts received, sir.');
  const out = await che.say(long);
  assert.equal(out.status, 200);
  assert.ok(out.modelInputs.some((input) => input.includes('5) Explain this step')), 'the fifth part is in what the model received');
  assert.match(out.reply, /Five parts received/);
});

test('a request over the intake limit is refused whole with its own category, and the model is not called', async () => {
  const che = await app('never used');
  const over = 'x'.repeat(16001);
  const out = await che.say(over);
  assert.equal(out.status, 413);
  assert.equal(out.done.category ?? out.body.match(/"category":"([a-z_]+)"/)?.[1], 'message_too_long');
  assert.equal(out.modelCalls, 0, 'nothing was sent to a model');
});

test('a small follow-up gets a normal reply, so a general failure is not blamed on prompt size', async () => {
  const che = await app('Four, sir.');
  // Arithmetic is answered without a model (main, #737), so this follow-up asks a question that still goes to the model.
  const out = await che.say('What is the capital of France?');
  assert.equal(out.status, 200);
  assert.ok(out.modelCalls >= 1, 'the model answered');
  assert.match(out.reply, /Four, sir\./);
});

test('a reply that every check removed is a named error line with the request id, never a blank success', async () => {
  const removals = [{ rule: 'unverified_action', sentence: 'I merged it.' }, { rule: 'unverified_action', sentence: 'I deployed it.' }];
  const res = emptyReplyStream('req-123', removals);
  const items = (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(items.length, 1, 'one line only: no delta and no done');
  assert.equal(items[0].type, 'error');
  assert.equal(items[0].category, 'empty_after_checks');
  assert.equal(items[0].retryable, true);
  assert.equal(items[0].request_id, 'req-123');
  assert.match(items[0].message, /checks removed all of it/);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
});
