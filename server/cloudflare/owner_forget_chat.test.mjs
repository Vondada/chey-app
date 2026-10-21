// Owner report (2026-10-21): "CHE, forget all the technical stuff for a minute. Talk to me normally..." was held as a
// deletion ("Before I delete or remove anything, I need your yes"). These tests post exact owner messages through the
// real /api/chat route. Everyday "forget" reaches the normal conversation route; a request to forget stored personal
// data is still held for the owner's yes and nothing is deleted.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.owner_forget_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function owner(model = () => 'Sure. Here is how I would put it: I like plain talk, with a dry joke when it fits.') {
  const saved = new Map();
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
  const state = new CheState({ storage }, env);
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
    // A held request answers with one JSON object; a conversation answers with an NDJSON stream.
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    if (held && !Array.isArray(held) && held.type === undefined) return { reply: held.reply, done: held, modelCalls: calls.n - before };
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, done, modelCalls: calls.n - before };
  };
  return { say, saved };
}

const EXACT = 'CHE, forget all the technical stuff for a minute. Talk to me normally. What’s your personality like? Show me, don’t just describe it.';
const HOLD = /need your yes|Should I go ahead/;

test('the owner\'s exact message is a conversation: no deletion hold, nothing deleted, the model answers', async () => {
  const che = await owner();
  const out = await che.say(EXACT);
  assert.doesNotMatch(out.reply, HOLD, 'no deletion hold');
  assert.doesNotMatch(out.reply, /Before I delete/);
  assert.equal(out.done.pending_owner_action, undefined, 'no owner action is pending');
  assert.equal(out.modelCalls, 1, 'the normal conversation route answered');
  assert.match(out.reply, /plain talk/);
  assert.equal((che.saved.get('che:pending_owner_action') || null), null);
});

test('other everyday "forget" and "clear" phrases are conversation, not deletion', async () => {
  for (const message of ['CHE, forget about work for now and tell me a joke.', 'forget what I was saying, I got distracted', 'clear my head for a second, what should we talk about?', 'drop the technical talk and be friendly', 'leave that aside, how are you?']) {
    const che = await owner();
    const out = await che.say(message);
    assert.doesNotMatch(out.reply, HOLD, message);
    assert.equal(out.modelCalls, 1, `${message} reached the conversation route`);
  }
});

test('a request to forget stored personal data is still held for the owner\'s yes, and nothing is deleted', async () => {
  const che = await owner();
  await che.say('Remember that my favorite food is pizza.');
  const before = JSON.stringify(che.saved.get('media_index') || null);
  const out = await che.say('CHE, forget my favorite food.');
  assert.match(out.reply, HOLD);
  assert.doesNotMatch(out.reply, /\bdeleted\b/i);
  assert.equal(JSON.stringify(che.saved.get('media_index') || null), before);
});
