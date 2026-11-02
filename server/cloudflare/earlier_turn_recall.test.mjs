// Questions about the owner's own earlier words, plans and counts (certification run 19: mr-06, mr-08, mr-21, mr-23,
// mr-28, vcc-20, vcc-25, vcc-31, vcc-36, vcc-37). They are answered from stored records or the conversation sent with
// the turn, or CHE says plainly that there is no record. A model never fills them in. The wording here is not taken
// from the question bank, so the rule is general.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { answerOwnerMemoryQuestion, ownerMemoryQuestion } from './memory_provenance.js';

const generated = new URL('./.earlier_turn_recall.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (earlier_turn_recall tests are offline: ${new URL(String(input?.url || input)).host})`);
};

const INVENTED = 'You are having lunch with Marcus from accounting. You mentioned Atlas 7 times and Nova 3 times.';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner(model = () => INVENTED) {
  const counter = { calls: 0 };
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  // Each turn is sent like the certification probe: one message, with the history given (empty by default).
  const say = async (message, history = []) => {
    const before = counter.calls;
    const raw = await (await send('/api/chat', { message, history }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  return { say };
}

const EARLIER = [{ role: 'user', content: 'Draft a note to the landlord about the leaking tap.' }, { role: 'assistant', content: 'Here is a draft: ...' }];

test('a reference to an earlier turn, with no earlier turns sent, is "no record" (any wording)', () => {
  for (const ask of [
    'Read me back the last message I sent you.',
    'Do it the same as before, but shorter.',
    'You told me earlier that it would rain. Why?',
    'Pick up where we left off.',
    'Call me by the name I gave you at the beginning of the conversation.',
    'Translate my previous sentence into German.',
    'Did I like the opening of your last draft?',
  ]) {
    assert.deepEqual(ownerMemoryQuestion(ask, []), { topic: '', noHistory: true }, ask);
    const out = answerOwnerMemoryQuestion({}, ownerMemoryQuestion(ask, []), []);
    assert.equal(out.kind, 'none', ask);
    assert.match(out.answer, /don't have our earlier messages/, ask);
    // With earlier turns sent, the conversation answers: this route stays out of the way.
    assert.equal(ownerMemoryQuestion(ask, EARLIER), null, ask);
  }
});

test('a count or ranking of the owner\'s own mentions is never invented', () => {
  for (const ask of ['How often did I bring up my car insurance?', 'List my three most discussed topics.', 'How many times have I told you about my knee?']) {
    const q = ownerMemoryQuestion(ask, []);
    assert.equal(q?.tally, true, ask);
    const out = answerOwnerMemoryQuestion({}, q, []);
    assert.match(out.answer, /don't have a count/, ask);
    assert.doesNotMatch(out.answer, /\d/, ask);
  }
});

test('general questions that share these words are not memory questions', () => {
  for (const ask of [
    'What did Einstein say about time?',
    'What was the last question on Jeopardy last night?',
    'Who said I think therefore I am?',
    'How many times has Brazil won the World Cup?',
    'Write a story where the hero says the same as before.',
    'What did Lincoln say at the start of the Gettysburg Address?',
    'Which teams are the most mentioned in sports news?',
  ]) {
    assert.equal(ownerMemoryQuestion(ask, []), null, ask);
  }
});

test('/api/chat: who/where questions about the owner\'s plans come from records or say none, never from the model', async () => {
  const che = await owner();
  const none = await che.say('Who did I say I am having lunch with on Saturday?');
  assert.equal(none.meta.source, 'che_memory_provenance');
  assert.equal(none.modelCalls, 0);
  assert.match(none.reply, /don't have any record/);
  assert.doesNotMatch(none.reply, /Marcus/);
  await che.say('Remember that I am having lunch with Priya on Saturday.');
  const found = await che.say('Who did I say I am having lunch with on Saturday?');
  assert.equal(found.meta.source, 'che_memory_provenance');
  assert.equal(found.modelCalls, 0);
  assert.match(found.reply, /Priya/);
  assert.doesNotMatch(found.reply, /Marcus/);
});

test('/api/chat: an earlier-turn reference with an empty conversation gets no guess; with turns the model reads them', async () => {
  const che = await owner();
  for (const ask of ['Say my last question again.', 'Keep telling the tale from where we stopped.', 'Which contacts do I mention most often? Rank my top three most mentioned people.']) {
    const out = await che.say(ask);
    assert.equal(out.meta.source, 'che_memory_provenance', ask);
    assert.equal(out.modelCalls, 0, ask);
    assert.match(out.reply, /don't have/, ask);
    assert.doesNotMatch(out.reply, /Marcus|Atlas|Nova/, ask);
  }
  const withTurns = await che.say('Say my last question again.', EARLIER);
  assert.notEqual(withTurns.meta.source, 'che_memory_provenance');
  assert.ok(withTurns.modelCalls >= 1, 'with the conversation sent, the model answers from it');
  const general = await che.say('What did Marie Curie say about fear?');
  assert.ok(general.modelCalls >= 1, 'a general question still reaches the model');
  assert.notEqual(general.meta.source, 'che_memory_provenance');
});

test('an explicit memory write that mentions an earlier turn or a count is a save, not a recall (Codex, #876)', () => {
  for (const say of [
    'Remember that my last question was about my car insurance',
    'Remember that my most mentioned contact is Priya.',
    'Keep in mind that my earlier sentence was a joke.',
    'Please remember my most mentioned client is Rafael.',
    'Note that my previous message was about the garage.',
    'My most mentioned contact is Priya.',
  ]) {
    assert.equal(ownerMemoryQuestion(say, []), null, say);
  }
  // A question that starts with "remember" still asks.
  assert.equal(ownerMemoryQuestion('Can you remember the last question I asked?', [])?.noHistory, true);
  assert.equal(ownerMemoryQuestion('Remember what I said at the start of the call?', [])?.noHistory, true);
});

test('/api/chat: those writes are saved and read back; the recall questions still get "no record"', async () => {
  const che = await owner();
  for (const say of [
    'Remember that my last question was about my car insurance',
    'Remember that my most mentioned contact is Priya.',
    'Keep in mind that my earlier sentence was a joke.',
    'Please remember my most mentioned client is Rafael.',
  ]) {
    const out = await che.say(say);
    assert.equal(out.meta.source, 'che_memory', say);
    assert.equal(out.modelCalls, 0, say);
    assert.match(out.reply, /Saved ".+" as record/, say);
    assert.doesNotMatch(out.reply, /don't have our earlier messages|don't have a count/, say);
  }
  const contact = await che.say('What did I tell you about my most mentioned contact?');
  assert.equal(contact.meta.source, 'che_memory_provenance');
  assert.match(contact.reply, /Priya/);
  const insurance = await che.say('What did I tell you about my car insurance?');
  assert.match(insurance.reply, /my last question was about my car insurance/);
  for (const ask of ['Say my last question again.', 'Who are my most mentioned friends?', 'How often did I bring up my car insurance?']) {
    const out = await che.say(ask);
    assert.equal(out.meta.source, 'che_memory_provenance', ask);
    assert.equal(out.modelCalls, 0, ask);
    assert.match(out.reply, /don't have/, ask);
    assert.doesNotMatch(out.reply, /Marcus|Atlas|Nova/, ask);
  }
});
