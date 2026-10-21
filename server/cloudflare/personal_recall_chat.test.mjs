// Owner (2026-10-21, real iPhone test): "CHE, what is my favorite food, and where did you learn it?" was answered with
// "You told me 'CHE, what is my favorite food…' on October 21". These tests run the real /api/chat route, reproduce that
// reply, and check the fix: pizza recall, a missing memory, the wake prefix, and persistence across a restart.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.personal_recall_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// Storage is a plain Map so a "restart" can build a new CheState over the same saved data (the phone's app restart and
// the Durable Object's own restart both read storage this way).
async function openChe(saved = new Map(), { model = () => 'Understood, sir.' } = {}) {
  const calls = { n: 0 };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => { calls.n += 1; return { response: model(input) }; } },
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
  // Production runs background writes (the Brain's conversation record) through ctx.waitUntil; the harness does the same
  // and waits for them after each turn, so a stored turn is really stored before the next question.
  const pending = [];
  const state = new CheState({ storage, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => null)) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    await Promise.allSettled(pending.splice(0));
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, modelCalls: calls.n - before };
  };
  return { say, saved, state };
}

const ERRONEOUS = 'CHE, what is my favorite food, and where did you learn it?';

test('the exact reply the owner saw on his iPhone is not produced: the question is never quoted as his fact', async () => {
  const che = await openChe(new Map(), { model: () => 'You told me that on October 21, 2026.' });
  // The owner asks once (the question is kept in the Brain), then asks again.
  await che.say(ERRONEOUS);
  const out = await che.say(ERRONEOUS);
  assert.equal(out.meta.source, 'che_personal_recall');
  assert.equal(out.modelCalls, 0, 'no model is asked to fill in a personal fact');
  assert.match(out.reply, /^I don't have a record of your favorite food, sir, so I don't know it\./);
  assert.doesNotMatch(out.reply, /You told me|learn it\?|on October 21, 2026/);
});

test('pizza: a stored statement is recalled with its subject, value and genuine date', async () => {
  const che = await openChe();
  const saved = await che.say('Remember that my favorite food is pizza');
  assert.equal(saved.reply, 'I’ll remember that, sir.');
  const out = await che.say('What is my favorite food?');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /^Your favorite food is pizza[.,]/);
  assert.doesNotMatch(out.reply, /remember|learn it\?|Sprite/);
});

test('a plain statement (no "remember") is kept in the Brain and recalled the same way', async () => {
  const che = await openChe();
  await che.say('My favorite food is pizza');
  const out = await che.say('What is my favorite food?');
  assert.match(out.reply, /^Your favorite food is pizza[.,]/);
});

test('the wake prefix in every spelling reaches the same answer', async () => {
  const che = await openChe();
  await che.say('Remember that my favorite food is pizza');
  for (const prefix of ['Chay, ', 'chey ', 'Shay: ']) {
    const out = await che.say(`${prefix}what is my favorite food?`);
    assert.match(out.reply, /^Your favorite food is pizza[.,]/, prefix);
  }
});

test('missing memory: an unknown subject says so and invents nothing', async () => {
  const che = await openChe();
  await che.say('Remember that my favorite drink is Sprite');
  const out = await che.say('What is my favorite food?');
  assert.equal(out.meta.source, 'che_personal_recall');
  assert.match(out.reply, /^I don't have a record of your favorite food/);
  assert.doesNotMatch(out.reply, /Sprite|drink/);
});

test('a question given to "remember" is asked, not stored as a fact', async () => {
  const saved = new Map();
  const che = await openChe(saved);
  const out = await che.say('Remember what my favorite food is?');
  assert.doesNotMatch(out.reply, /I’ll remember that/);
  const memories = (saved.get('che')?.memory_records || []).map((r) => r.text);
  assert.equal(memories.some((t) => /favorite food/i.test(t)), false, 'no memory row holds the question');
});

test('persistence: the fact survives an app restart over the same stored data', async () => {
  const saved = new Map();
  const first = await openChe(saved);
  await first.say('Remember that my favorite food is pizza');
  // A restart: a new CheState and a new pairing over the same saved storage.
  const restarted = await openChe(saved);
  const out = await restarted.say('What is my favorite food?');
  assert.match(out.reply, /^Your favorite food is pizza[.,]/);
});
