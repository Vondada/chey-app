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
  assert.doesNotMatch(before.reply, /choose Import/, 'no import screen exists on the phone yet; never point the owner at one');
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

// ─── Owner report, 2026-10-23 evening (after #491) ───────────────────────────────────────────────────────────────────
// "Show a saved Brain record" and "Inspect your memory system" → "I couldn't finish that answer" (both went to a busy
// model); "What's my favorite drink?" → "no record" while Sprite was in the phone's Brain notes, which reach the Worker
// only as brain_context. An engine that is down must not matter for any of the three.
const DOWN = () => { throw Object.assign(new Error('upstream 503'), { status: 503 }); };
const PHONE_NOTES = (...lines) => ({ brain_context: [`[CHE BRAIN — what you know, by category]\nPeople:\n${lines.map((l) => `- ${l}`).join('\n')}`] });

test('a fact kept only in the phone Brain notes is recalled, labelled as a phone note, with no model', async () => {
  for (const note of ["[People] The owner's favorite drink is Sprite", 'Favorite drink: Sprite', 'My favorite drink is Sprite']) {
    const che = await owner({ model: DOWN });
    const out = await che.say("What's my favorite drink?", { ...fresh, ...PHONE_NOTES('[Projects] CHE app on iPhone', note) });
    assert.match(out.reply, /^Your favorite drink is Sprite\. That is from the Brain notes on your phone/, note);
    assert.doesNotMatch(out.reply, /You told me|don't have a record/i);
    assert.equal(out.meta.source, 'che_personal_recall');
    assert.equal(out.meta.recall_receipt.store, 'phone_brain_notes');
    assert.equal(out.meta.recall_receipt.owner_attested, false);
    assert.equal(out.modelCalls, 0);
  }
});

test('a dated record of the fact wins over an undated phone note; no note and no record is still an honest miss', async () => {
  const che = await owner({ model: WRONG });
  await che.say('My favorite drink is Sprite', fresh);
  const out = await che.say("What's my favorite drink?", { ...fresh, ...PHONE_NOTES('Favorite drink: Coke') });
  assert.match(out.reply, /^Your favorite drink is Sprite\. You told me that on /);
  const none = await (await owner({ model: DOWN })).say("What's my favorite drink?", { ...fresh, ...PHONE_NOTES('Favorite food: pizza') });
  assert.match(none.reply, /don't have a record of your favorite drink/);
  assert.equal(none.modelCalls, 0);
});

test('"Show a saved Brain record" opens the newest real record with its id, and says so when there is none', async () => {
  const empty = await owner({ model: DOWN });
  const nothing = await empty.say('Show a saved Brain record', fresh);
  assert.equal(nothing.meta.source, 'che_brain_record');
  assert.match(nothing.reply, /no saved records yet/);
  assert.doesNotMatch(nothing.reply, /couldn't finish/i);
  assert.deepEqual(nothing.meta.record_ids, []);

  const che = await owner({ model: WRONG });
  await che.say('My favorite drink is Sprite', fresh);
  const out = await che.say('Show a saved Brain record', fresh);
  assert.equal(out.meta.source, 'che_brain_record');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.meta.record_ids.length, 1);
  assert.match(out.reply, /My favorite drink is Sprite/);
  assert.match(out.reply, new RegExp(`Record ${out.meta.record_ids[0].slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // The id the reply links is the record the Brain serves under that id, and it holds the owner's words.
  const opened = await che.post('/api/brain/record', { id: out.meta.record_ids[0] });
  assert.equal(opened.record?.id ?? opened.id, out.meta.record_ids[0]);
  assert.match(JSON.stringify(opened), /My favorite drink is Sprite/);
});

test('"Show me my brain record about Sprite" opens a matching record; an unknown topic is a specific miss', async () => {
  const che = await owner({ model: WRONG });
  await che.say('My favorite drink is Sprite', fresh);
  await che.say('Remember that my dog is named Rex', fresh);
  const out = await che.say('Show me my brain record about Sprite', fresh);
  assert.match(out.reply, /about "Sprite"/);
  assert.match(out.reply, /Sprite/);
  const miss = await che.say('Show me a brain record about zeppelins', fresh);
  assert.match(miss.reply, /no saved Brain record that mentions "zeppelins".*search my memory for zeppelins/);
  assert.equal(miss.modelCalls, 0);
});

test('"Inspect your memory system" completes with real counts while the model is down', async () => {
  const che = await owner({ model: WRONG });
  await che.say('My favorite drink is Sprite', fresh);
  const down = await owner({ saved: che.saved, model: DOWN });
  for (const asked of ['Inspect your memory system', 'CHE, check your memory', 'memory status', 'How is your memory doing?']) {
    const out = await down.say(asked, { ...fresh, ...PHONE_NOTES('Favorite drink: Sprite') });
    assert.equal(out.meta.source, 'che_memory_inspection', asked);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^I checked my memory stores just now, sir\. Memory records: \d+/);
    assert.match(out.reply, /Brain on the Worker: \d+ records/);
    assert.match(out.reply, /Your phone sent 1 Brain note/);
    assert.ok(out.meta.memory_inspection.brain.records >= 1);
  }
});

test('ordinary sentences are not caught by the record or inspection routes', async () => {
  const { brainRecordIntent, memoryInspectIntent } = await import('./owner_recall.js');
  for (const t of ['Show me the record for MNQ today', 'Check your email', 'Fix your memory system', 'Delete my brain records', 'Show me a video about brains', 'My memory is bad lately']) {
    assert.equal(brainRecordIntent(t), null, t);
    assert.equal(memoryInspectIntent(t), false, t);
  }
});

// Codex review of #499 (merged a7c1062), three P1 threads. Each fails before the fix.
test('a phone-note answer keeps its provenance when the owner asks how CHE knows it', async () => {
  const che = await owner({ model: DOWN });
  const notes = PHONE_NOTES('[People] The owner\'s favorite drink is Sprite');
  await che.say("What's my favorite drink?", notes);
  const out = await che.say('How do you know that?', notes);
  assert.match(out.reply, /phone/i, out.reply);
  assert.match(out.reply, /no date|undated/i, out.reply);
  assert.doesNotMatch(out.reply, /language model alone/, 'must not claim the model alone');
  assert.doesNotMatch(out.reply, /you told me/i, 'a phone note is not attested as the owner\'s own words');
});

test('a third-person note is never recalled as the owner\'s fact', async () => {
  for (const note of ['His favorite drink is Coke', "Sam's favorite drink is Coke", 'Her favorite drink is Coke']) {
    const che = await owner({ model: DOWN });
    const out = await che.say("What's my favorite drink?", { ...fresh, ...PHONE_NOTES(note) });
    assert.doesNotMatch(out.reply, /Coke/, note);
    assert.match(out.reply, /don't have a record of your favorite drink/, note);
  }
});
