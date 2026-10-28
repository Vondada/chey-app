// Owner chat relevance (owner, 2026-10-28): "CHE, what is 12 times 17?" must answer 204, not a search correction;
// an earlier research turn must not leak into a new answer; the receipt guard acts only on the sentences that claim
// work, and a failed multipart request must not break the next question. Runs the real /api/chat route.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { plainArithmetic } from './arithmetic.js';
import { guardClaimedResearchActions } from './truth_layer.js';

const generated = new URL('./.chat_relevance.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// `reply` is what the fake model answers; `fail` makes every model call throw, as a failed provider does.
async function app({ reply = 'Four, sir.', fail = false } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const saved = new Map();
  const modelInputs = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => {
      modelInputs.push(String(input?.messages?.at(-1)?.content || ''));
      if (fail) throw Object.assign(new Error('provider unavailable'), { status: 503 });
      return { response: reply };
    } },
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
    const reply = items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { status: res.status, reply, raw, items, modelCalls: modelInputs.length - before };
  };
  return { say };
}

// A previous research turn, as the owner's history carries it.
const RESEARCH_HISTORY = [
  { role: 'user', content: 'CHE, research the best GitHub repos for voice agents and compare them.' },
  { role: 'assistant', content: 'I searched GitHub and compared three repositories. The top one has the most stars.' },
];

test('"12 times 17" is answered 204 by computation, even after a research turn, with no model call', async () => {
  const che = await app({ reply: 'I searched GitHub and compared the results, sir.' });
  const out = await che.say('CHE, what is 12 times 17?', RESEARCH_HISTORY);
  assert.equal(out.status, 200);
  assert.equal(out.reply, '204.');
  assert.equal(out.modelCalls, 0, 'the answer did not come from a model');
  assert.doesNotMatch(out.raw, /execution receipts/);
});

test('the arithmetic reader computes the operations the owner uses, and refuses what it cannot read', () => {
  assert.equal(plainArithmetic('CHE, what is 12 times 17?').result, '204');
  assert.equal(plainArithmetic('what is 12 x 17').result, '204');
  assert.equal(plainArithmetic('7 divided by 2').result, '3.5');
  assert.equal(plainArithmetic('0.1 + 0.2').result, '0.3');
  assert.equal(plainArithmetic('1,000 minus 1').result, '999');
  assert.match(plainArithmetic('what is 5 / 0').error, /Division by zero/);
  assert.equal(plainArithmetic('12 times'), null, 'an unfinished sum goes the usual way');
  assert.equal(plainArithmetic('Tell me about 12 times 17 in history'), null, 'a sentence about maths is not a sum');
});

test('the receipt guard acts only when a reply claims work: a plain answer passes unchanged', () => {
  assert.deepEqual(guardClaimedResearchActions('Four, sir.', { tools: [] }), { text: 'Four, sir.', corrected: false });
  const lone = guardClaimedResearchActions('I searched the web and compared sources.', { tools: [] });
  assert.equal(lone.corrected, true);
  assert.match(lone.text, /execution receipts/, 'a reply that is only a claim is still corrected');
});

test('a failed multipart request does not stop the next question from being answered', async () => {
  const multipart = Array.from({ length: 5 }, (_, i) => `${i + 1}) ${'Explain this step with its reasoning. '.repeat(40)}`).join('\n');
  const che = await app({ fail: true });
  const failed = await che.say(multipart);
  assert.notEqual(failed.status, 500, 'a failed model call is answered, not left to crash the route');
  const next = await che.say('CHE, what is 12 times 17?');
  assert.equal(next.reply, '204.', 'the next question is answered on its own');
});

test('a failing provider never returns an answer to a different question', async () => {
  const che = await app({ fail: true });
  const out = await che.say('What is the capital of Spain?');
  assert.doesNotMatch(out.reply, /204|GitHub|Four/, 'no answer from another question appears');
});
