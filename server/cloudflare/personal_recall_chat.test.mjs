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
  // `history` is what the phone sends with each turn: the earlier user and assistant turns, oldest first.
  const say = async (message, { history = [] } = {}) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history }, token)).text();
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
  // The acknowledgement carries the write receipt read back from storage: the record id and the stored time.
  assert.match(saved.reply, /^I’ll remember that, sir\. Saved \"[^\"]+\" as record [\w-]+ on \d{4}-\d{2}-\d{2} at \d{2}:\d{2} UTC, and read it back from storage\.$/);
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

// ─── Owner recording (2026-10-24): the short correction of the fact under discussion ────────────────────────────────
// A conversation as the phone runs it: each turn carries the earlier turns as history.
async function conversation(che) {
  const history = [];
  return async (message) => {
    const out = await che.say(message, { history: [...history] });
    history.push({ role: 'user', content: message }, { role: 'assistant', content: out.reply });
    return out;
  };
}

test('recording: "What\'s my favorite drink?" → Sprite → "No, strawberry Sprite." updates the fact; the next ask uses it', async () => {
  const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
  const say = await conversation(che);
  await say('Remember that my favorite drink is Sprite');
  const first = await say("What's my favorite drink?");
  assert.match(first.reply, /^Your favorite drink is Sprite\./);
  const fixed = await say('No, strawberry Sprite.');
  assert.equal(fixed.modelCalls, 0, 'the correction is understood from the conversation, not sent to the model');
  assert.equal(fixed.meta.source, 'che_memory');
  assert.match(fixed.reply, /^Got it, sir: your favorite drink is strawberry Sprite\./);
  const again = await say("What's my favorite drink?");
  assert.equal(again.modelCalls, 0);
  assert.match(again.reply, /^Your favorite drink is strawberry Sprite\. You told me that on/);
  assert.doesNotMatch(again.reply, /is Sprite\./);
  // The old record stays as history, inactive, so nothing is deleted.
  const records = che.saved.get('che').memory_records;
  assert.equal(records.find((r) => r.text === 'my favorite drink is Sprite').active, false);
  assert.equal(records.find((r) => /strawberry Sprite/.test(r.text)).active !== false, true);
});

test('recording, spoken variants: "It’s strawberry Sprite." and "no strawberry sprite" (no punctuation) are the same correction', async () => {
  for (const said of ['It’s strawberry Sprite.', 'no strawberry sprite']) {
    const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
    const say = await conversation(che);
    await say('Remember that my favorite drink is Sprite');
    await say("What's my favorite drink?");
    const fixed = await say(said);
    assert.equal(fixed.modelCalls, 0, said);
    assert.match(fixed.reply, /^Got it, sir: your favorite drink is strawberry sprite\./i, said);
  }
});

// PR #515 review (P1): "Thank you, CHE." right after the answer was stored as "my favorite drink is Thank you, CHE".
test('a thank-you or remark after a personal-fact answer is never stored as a correction', async () => {
  for (const said of ['Thank you, CHE.', 'Thanks!', 'No thanks, CHE.', 'Great, thank you so much.', 'Cool.', 'Perfect.', 'Good to know.', 'Sounds good.', 'I love it.', "That's great.", 'Awesome, thanks CHE']) {
    const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
    const say = await conversation(che);
    await say('Remember that my favorite drink is Sprite');
    const first = await say("What's my favorite drink?");
    assert.match(first.reply, /^Your favorite drink is Sprite\./, said);
    const reply = await say(said);
    assert.notEqual(reply.meta.source, 'che_memory', said);
    assert.doesNotMatch(reply.reply, /^Got it, sir/, said);
    const texts = che.saved.get('che').memory_records.map((r) => r.text);
    assert.deepEqual(texts.filter((t) => /favorite drink/i.test(t)), ['my favorite drink is Sprite'], said);
    assert.equal(che.saved.get('che').memory_records.find((r) => r.text === 'my favorite drink is Sprite').active !== false, true, said);
    const again = await say("What's my favorite drink?");
    assert.match(again.reply, /^Your favorite drink is Sprite\./, said);
  }
  // The real correction, with a trailing "CHE" and a name that opens with an everyday word, still updates the fact.
  for (const [said, value] of [['No, strawberry Sprite, CHE.', 'strawberry Sprite'], ['No, Cool Ranch soda.', 'Cool Ranch soda']]) {
    const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
    const say = await conversation(che);
    await say('Remember that my favorite drink is Sprite');
    await say("What's my favorite drink?");
    const fixed = await say(said);
    assert.equal(fixed.meta.source, 'che_memory', said);
    assert.equal(fixed.reply.startsWith(`Got it, sir: your favorite drink is ${value}.`), true, `${said} -> ${fixed.reply}`);
  }
});

test('a value given after "I don\'t have a record" is saved as the fact and dated; "when did I tell you that?" cites the record', async () => {
  const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
  const say = await conversation(che);
  const none = await say("What's my favorite color?");
  assert.match(none.reply, /^I don't have a record of your favorite color/);
  const told = await say("It's blue.");
  assert.equal(told.modelCalls, 0);
  assert.match(told.reply, /^Got it, sir: your favorite color is blue\./);
  const ask = await say("What's my favorite color?");
  assert.match(ask.reply, /^Your favorite color is blue\. You told me that on \w+ \d+, \d{4}\./);
  const when = await say('When did I tell you that?');
  assert.equal(when.modelCalls, 0);
  assert.match(when.reply, /That came from what you told me: On \w+ \d+, you told me in chat: "my favorite color is blue\."/);
});

test('"that\'s not what I meant" with a fact under discussion asks for the right value and saves nothing', async () => {
  const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
  const say = await conversation(che);
  await say('Remember that my favorite drink is Sprite');
  await say("What's my favorite drink?");
  const vague = await say("That's not what I meant.");
  assert.equal(vague.modelCalls, 0);
  assert.equal(vague.meta.source, 'che_clarify');
  assert.match(vague.reply, /I have your favorite drink stored as Sprite\. Which value is right, sir\?/);
  assert.equal(che.saved.get('che').memory_records.filter((r) => r.active !== false && /favorite drink/.test(r.text)).length, 1);
  const fixed = await say('Strawberry Sprite.');
  assert.match(fixed.reply, /^Got it, sir: your favorite drink is Strawberry Sprite\./);
});

test('"what were we just discussing?" is answered from the conversation, with no model', async () => {
  const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
  const say = await conversation(che);
  await say('Remember that my favorite drink is Sprite');
  await say("What's my favorite drink?");
  const out = await say('What were we just discussing?');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /^We were just on this, sir\. You said: "What's my favorite drink\?" and I answered: "Your favorite drink is Sprite\./);
});

test('after an app restart the corrected fact is what comes back, and a correction still works with the restored history', async () => {
  const saved = new Map();
  const first = await openChe(saved, { model: () => 'MODEL_FALLBACK' });
  const say = await conversation(first);
  await say('Remember that my favorite drink is Sprite');
  await say("What's my favorite drink?");
  await say('No, strawberry Sprite.');
  const restarted = await openChe(saved, { model: () => 'MODEL_FALLBACK' });
  const again = await conversation(restarted);
  const out = await again("What's my favorite drink?");
  assert.match(out.reply, /^Your favorite drink is strawberry Sprite\./);
  const fixed = await again('No, cherry Sprite.');
  assert.match(fixed.reply, /^Got it, sir: your favorite drink is cherry Sprite\./);
});

test('the same words with no fact under discussion are not a memory write; right after his own statement they correct it', async () => {
  const che = await openChe(new Map(), { model: () => 'MODEL_FALLBACK' });
  await che.say('Remember that my favorite drink is Sprite');
  // The last turns were about something else: the words are not read as a fact.
  const out = await che.say('No, strawberry Sprite.', { history: [{ role: 'user', content: 'What time is it?' }, { role: 'assistant', content: 'It is 9:15, sir.' }] });
  assert.doesNotMatch(out.reply, /^Got it, sir: your favorite drink/);
  assert.equal(che.saved.get('che').memory_records.filter((r) => r.active !== false).map((r) => r.text).join('|'), 'my favorite drink is Sprite');
  // Right after "remember that my favorite drink is Sprite", the same words correct what he just said.
  const fixed = await che.say('No, strawberry Sprite.', { history: [{ role: 'user', content: 'Remember that my favorite drink is Sprite' }, { role: 'assistant', content: 'I’ll remember that, sir.' }] });
  assert.match(fixed.reply, /^Got it, sir: your favorite drink is strawberry Sprite\./);
});
