// Owner retrieval test, 2026-10-23, through the real /api/chat route. What failed on the iPhone:
//   - "What is my favorite drink, and where did you learn that?" → "I don't have a record" (he had said Sprite), because
//     only "my favorite X is Y" was understood and the Brain lookup read the newest 500 records only;
//   - "What is the secret code word for the fictional Blue Lantern project?" → the model answered, not the stored statement;
//   - "Where did that come from and when did you learn it?" → the model, with no source or date;
//   - "What did I tell ChatGPT about …" → a status reply, though no ChatGPT history is connected.
// Every fact here is said in one conversation and asked in a NEW one after a Durable Object restart over the same storage.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { ANSWER_LEDGER_KEY, RETRACTED_CLAIMS_KEY, evidenceQuestion, evidenceRequestSplit, ownerMemoryQuestion, storyRequested } from './memory_provenance.js';

const generated = new URL('./.owner_recall.test.generated.mjs', import.meta.url);
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

const FABRICATED_UNUSED = 'You personally tested a new office security protocol last Tuesday and confirmed that after-hours access required a two-step biometric check.';

const { DatabaseSync } = await import('node:sqlite');
const dbs = new WeakMap();
function storageFor(saved) {
  if (!dbs.has(saved)) dbs.set(saved, new DatabaseSync(':memory:'));
  const db = dbs.get(saved);
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => (Array.isArray(k)
      ? new Map(k.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))]))
      : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => {
      if (k && typeof k === 'object') for (const [key, value] of Object.entries(k)) saved.set(key, structuredClone(value));
      else saved.set(k, structuredClone(v));
    },
    delete: async (k) => (Array.isArray(k) ? k.filter((key) => saved.delete(key)).length : saved.delete(k)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone talking to CHE. `model` is what the chat model would
// say; `calls` counts every model call the turn made.
async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const connect = () => {
    const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
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
    const reply = replyFromNdjson(raw);
    if (!extra.history) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, modelCalls: counter.calls - before, ms: performance.now() - started };
  };
  return { say, saved, history, counter, restart: connect, post: async (path, body) => (await send(path, body, token)).json() };
}

const fresh = { history: [] };
// A model that would answer wrongly every time: a stored answer must never come from it.
const lastUser = (input) => String((input?.messages || []).filter((m) => m.role === 'user').at(-1)?.content || '');
const WRONG = (input) => (/\?\s*$|^(?:what|where|when)\b/i.test(lastUser(input).trim()) ? 'Your favorite drink is Coca-Cola and the code word is Falcon Nine.' : 'Noted, sir.');

const DRINK_PHRASINGS = [
  'My favorite drink is Sprite',
  'Remember that my favorite drink is Sprite',
  'Sprite is my favorite drink',
  "I love Sprite, it's my favorite drink",
  'My fav drink is sprite',
  'My favorite food is pizza, my favorite drink is Sprite, and my favorite color is red',
  'CHE, my favorite drink? Sprite.',
  'Remember I like to drink Sprite the most',
  'My favourite drink is Sprite',
];

for (const said of DRINK_PHRASINGS) {
  test(`"${said}" is recalled in a new conversation after a restart, with its date and the owner's words`, async () => {
    const che = await owner({ model: WRONG });
    await che.say(said, fresh);
    che.restart();
    const out = await che.say('What is my favorite drink, and where did you learn that?', fresh);
    assert.match(out.reply, /\bsprite\b/i);
    assert.doesNotMatch(out.reply, /Coca-Cola|don't have a record/i);
    assert.match(out.reply, /You told me that on [A-Z][a-z]+ \d{1,2}, \d{4}/);
    assert.match(out.reply, /In your words: "/);
    assert.equal(out.meta.source, 'che_personal_recall');
    assert.equal(out.modelCalls, 0);
  });
}

test('one sentence with three facts answers each of them', async () => {
  const che = await owner({ model: WRONG });
  await che.say('My favorite food is pizza, my favorite drink is Sprite, and my favorite color is red', fresh);
  che.restart();
  assert.match((await che.say('What is my favorite food?', fresh)).reply, /^Your favorite food is pizza\./);
  assert.match((await che.say('What is my favorite color?', fresh)).reply, /^Your favorite color is red\./);
});

test('a correction wins: blue, then red, answers red', async () => {
  const che = await owner({ model: WRONG });
  await che.say('Remember that my favorite color is blue', fresh);
  await che.say('Remember that my favorite color is red', fresh);
  che.restart();
  const out = await che.say('What is my favorite color?', fresh);
  assert.match(out.reply, /^Your favorite color is red\b/);
  assert.doesNotMatch(out.reply, /blue/i);
});

test('Blue Lantern: the stored statement answers, never the model; the follow-up names the source and date', async () => {
  const che = await owner({ model: WRONG });
  const saved = await che.say('CHE, remember this test fact: The fictional project Blue Lantern uses the internal code word Magnolia Seven.', fresh);
  assert.equal(saved.meta.source, 'che_memory');
  assert.equal(saved.meta.ok, true);
  assert.equal(saved.meta.memory_receipt.status, 'stored');
  assert.match(saved.meta.memory_receipt.text_sha256_16, /^[0-9a-f]{16}$/);
  che.restart();
  const out = await che.say('What is the secret code word for the fictional Blue Lantern project?', fresh);
  assert.match(out.reply, /Magnolia Seven/);
  assert.doesNotMatch(out.reply, /Falcon/);
  assert.equal(out.modelCalls, 0);
  assert.equal(out.meta.recall_receipt.record_id, saved.meta.memory_receipt.record_id, 'the same stored record came back after the restart');
  const why = await che.say('Where did that come from and when did you learn it?');
  assert.equal(why.meta.source, 'che_evidence_receipt');
  assert.match(why.reply, /you told me in chat: "(?:this test fact: )?The fictional project Blue Lantern uses the internal code word Magnolia Seven\."/);
  assert.match(why.reply, /On [A-Z][a-z]+ \d{1,2}/);
});

test('new arbitrary facts are recalled the same way (nothing about Blue Lantern is special)', async () => {
  const che = await owner({ model: WRONG });
  await che.say('Remember this: the fictional ship Copper Heron docks at Pier Nineteen.', fresh);
  await che.say('Remember that the fictional band Velvet Quarry rehearses on Thursdays.', fresh);
  che.restart();
  assert.match((await che.say('Where does the fictional ship Copper Heron dock?', fresh)).reply, /Pier Nineteen/);
  assert.match((await che.say('When does the fictional band Velvet Quarry rehearse?', fresh)).reply, /Thursdays/);
});

test('what was never said gets an honest "I don\'t know", never the model\'s guess', async () => {
  const che = await owner({ model: () => 'Your dentist is Dr. Karen Smith.' });
  const out = await che.say("What is my dentist's name?", fresh);
  assert.match(out.reply, /don't have a record of your dentist's name/);
  assert.doesNotMatch(out.reply, /Karen Smith/);
  assert.equal(out.modelCalls, 0);
});

test('an unrelated question is not answered from a stored statement', async () => {
  const che = await owner({ model: () => 'Paris.' });
  await che.say('Remember this test fact: The fictional project Blue Lantern uses the internal code word Magnolia Seven.', fresh);
  const out = await che.say('What is the capital of France?', fresh);
  assert.doesNotMatch(out.reply, /Magnolia|Blue Lantern/);
});

test('ChatGPT history: not connected says so; an imported export is quoted with title and date; re-import adds nothing', async () => {
  const che = await owner({ model: () => 'In ChatGPT you told me you prefer short answers.' });
  const before = await che.say('What did I tell ChatGPT about my trading rules last week?', fresh);
  assert.equal(before.meta.source, 'che_chatgpt_history');
  assert.match(before.reply, /ChatGPT history isn't connected/);
  assert.doesNotMatch(before.reply, /short answers/);
  assert.equal(before.modelCalls, 0);
  // The batch the phone sends after parsing and redacting conversations.json.
  const turns = [
    { message_id: 'm-1', conversation_id: 'c-1', conversation_title: 'MNQ rules', created_at: '2026-09-02T14:00:00Z', text: 'My trading rules: no trades in the first five minutes, and at most two losses a day.', reply: 'Good rules.' },
    { message_id: 'm-2', conversation_id: 'c-2', conversation_title: 'Dinner', created_at: '2026-09-03T01:00:00Z', text: 'Suggest a pasta recipe.' },
  ];
  const first = await che.post('/api/brain/import/chatgpt', { turns });
  assert.equal(first.stored, 2);
  const again = await che.post('/api/brain/import/chatgpt', { turns });
  assert.equal(again.stored, 0);
  assert.equal(again.duplicates, 2);
  che.restart();
  const after = await che.say('What did I tell ChatGPT about my trading rules?', fresh);
  assert.equal(after.meta.source, 'che_chatgpt_history');
  assert.match(after.reply, /"MNQ rules" on September 2, 2026, you wrote: "My trading rules: no trades in the first five minutes/);
  assert.equal(after.modelCalls, 0);
});

test('"search my memory for Sprite" lists every store with its count and the raw records', async () => {
  const che = await owner({ model: WRONG });
  await che.say('Sprite is my favorite drink', fresh);
  const out = await che.say('Search my memory for Sprite', fresh);
  assert.equal(out.meta.source, 'che_memory_search');
  assert.match(out.reply, /Sprite is my favorite drink/);
  assert.match(out.reply, /Searched: memory records: \d+; saved preferences: \d+; Brain \(synced from the phone\): \d+; ChatGPT import: not connected/);
  const none = await che.say('Search my memory for Zanzibar', fresh);
  assert.match(none.reply, /found no record of it/);
  assert.match(none.reply, /import your ChatGPT export/);
});

test('a guest never gets the owner\'s stored statements', async () => {
  const saved = new Map();
  const che = await owner({ saved, model: () => 'I am not sure.' });
  await che.say('Remember this test fact: The fictional project Blue Lantern uses the internal code word Magnolia Seven.', fresh);
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'I am not sure.' }) } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const res = await worker.fetch(new Request('https://che.example/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What is the secret code word for the fictional Blue Lantern project?', history: [] }) }), env);
  assert.doesNotMatch(await res.text(), /Magnolia/);
});
