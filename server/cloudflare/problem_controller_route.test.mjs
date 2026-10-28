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
  return { say, env, state };
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

test('the live arithmetic probe reads every step through the real route and reports the receipts', async () => {
  const { arithmeticProbe } = await import('./problem_controller_probe.js');
  const che = await app();
  const report = await arithmeticProbe(che.env, new Request('https://che.example/api/arithmetic/probe', { headers: { Authorization: 'Bearer probe-token' } }), 'probe-object');
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.pass && !s.optional).map((s) => [s.name, s.reply])));
  assert.equal(report.total, 6);
  assert.equal(report.steps[0].receipt.status, 'success');
  assert.equal(report.steps[4].receipt.capability_id, 'math.trade_expectancy');
  assert.equal(report.steps[2].receipt.status, 'error');
});

// Periodic production (the owner's Intelligence Test 1): the same question is answered by the controller with both
// readings and no model call. CHE previously answered 301 seconds from the model path, which had no check.
const PRODUCTION = 'A machine produces 3 parts every 4 seconds. After every 12 parts, it stops for 5 seconds. Starting with no parts and no initial delay, what is the minimum time to produce exactly 100 parts?';

test('the periodic-production question is answered by the controller: 176 s batched, 173.33 s continuous, no model call', async () => {
  const che = await app({ reply: '301 seconds.' });
  const res = await che.say(PRODUCTION);
  assert.equal(res.status, 200);
  assert.equal(res.modelCalls, 0, 'the model must not answer a verified production problem');
  assert.equal(res.done.source, 'che_arithmetic');
  assert.equal(res.done.ok, true);
  assert.equal(res.done.execution_receipt.capability_id, 'math.periodic_production');
  assert.match(res.text, /176 seconds/);
  assert.match(res.text, /173\.33 seconds/);
  assert.match(res.text, /batches of 3/);
  assert.doesNotMatch(res.text, /301/);
});

test('a production-like question without every parameter still goes to the model, unanswered by the controller', async () => {
  const che = await app({ reply: 'It depends on the machine, sir.' });
  const res = await che.say('A machine produces parts. How long does it take to produce 100 parts?');
  assert.equal(res.modelCalls, 1);
  assert.equal(res.done.source === 'che_arithmetic', false);
});
// Hypothetical trading figures (Intelligence Test 4): the figures the owner gives are calculated, and the paper journal
// is not read for them. A question about the owner's own results still reaches the journal routes.
const HYPOTHETICAL = "A paper trading strategy made 100 trades: 70 wins averaging $4 each and 30 losses averaging $15 each. It has a 70% win rate. Should I keep running it? Calculate its expected profit per trade, identify what the win rate hides, and explain what additional evidence you need.";

test('hypothetical trade figures are calculated on the real route: -$1.70 per trade, no journal, no model call', async () => {
  const che = await app({ reply: 'Zero trades, sir.' });
  const res = await che.say(HYPOTHETICAL);
  assert.equal(res.status, 200);
  assert.equal(res.modelCalls, 0);
  assert.equal(res.done.source, 'che_arithmetic');
  assert.equal(res.done.execution_receipt.capability_id, 'math.trade_expectancy');
  assert.match(res.text, /-\$1\.70/);
  assert.match(res.text, /-\$170\.00/);
  assert.match(res.text, /78\.95%/);
  assert.doesNotMatch(res.text, /paper journal|evidence pass|portfolios/);
});

test('a second hypothetical with different figures is calculated the same way (nothing is hardcoded)', async () => {
  const che = await app({ reply: 'Zero trades, sir.' });
  const res = await che.say('Suppose a strategy has a 40% win rate, wins $10 and loses $4. What is the expected profit per trade?');
  assert.equal(res.modelCalls, 0);
  assert.match(res.text, /\$1\.60/);
});

test('conflicting hypothetical counts are refused on the route, with no journal figures', async () => {
  const che = await app({ reply: 'Zero trades, sir.' });
  const res = await che.say('A strategy made 100 trades: 70 wins averaging $4 and 25 losses averaging $15. Expected profit per trade?');
  assert.equal(res.modelCalls, 0);
  assert.equal(res.done.ok, false);
  assert.match(res.text, /make 95 trades, not 100/);
});

test('the owner\'s own results still go to the journal route, not the hypothetical calculator', async () => {
  const che = await app({ reply: 'Unverified model reply.' });
  const res = await che.say("What's my expectancy so far?");
  assert.notEqual(res.done.source, 'che_arithmetic');
});

// Unseen scenarios (not the owner's numbers): the route calculates from whatever figures the message supplies.
test('an unseen scenario on the route: 55% win rate, $8 wins, $5 losses is +$2.15 a trade', async () => {
  const che = await app({ reply: 'Unverified.' });
  const res = await che.say('A paper strategy has a 55% win rate: wins $8 and loses $5 on average. Should I keep running it? What is the expected profit per trade?');
  assert.equal(res.modelCalls, 0);
  assert.equal(res.done.source, 'che_arithmetic');
  assert.match(res.text, /\$2\.15/);
});

test('an unseen scenario on the route: 50 wins of $12 and 70 losses of $5 over 120 trades is $2.08 (exactly 25/12) a trade', async () => {
  const che = await app({ reply: 'Unverified.' });
  const res = await che.say('A strategy made 120 trades: 50 wins averaging $12 each and 70 losses averaging $5 each. What is the expected profit per trade?');
  assert.equal(res.modelCalls, 0);
  assert.match(res.text, /\$2\.08 \(exactly 25\/12 dollars\)/);
  assert.match(res.text, /-?\$250\.00/);
});
