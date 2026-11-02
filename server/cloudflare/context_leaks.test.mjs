// Stored text that leaked into unrelated replies (certification run 20): an old owner message copied back as the answer,
// a coding-job list under "Can you hear me?", and a live-price notice in place of an explanation. Wording here is not
// from the question bank.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { recallMemories, recordConversationMemory, rememberedText, replyFromNdjson } from './brain_memory.js';
import { auditReply, claimKindsIn } from './hallucination_auditor.js';
import { guardOwnerReply, verifiedState } from './truth_layer.js';
import { ownerMemoryQuestion } from './memory_provenance.js';

const generated = new URL('./.context_leaks.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async (input) => { throw new TypeError(`offline test: ${new URL(String(input?.url || input)).host}`); };

function memoryStorage(saved = new Map()) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '', reverse = false, limit = Infinity } = {}) => {
      let keys = [...saved.keys()].filter((k) => typeof k === 'string' && k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      return new Map(keys.slice(0, limit).map((k) => [k, saved.get(k)]));
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

test('a short reply or a one-word overlap brings back no remembered talk', async () => {
  const storage = memoryStorage();
  await recordConversationMemory(storage, { message: 'Sure thing', reply: 'Okay, sir.', now: 1_000 });
  await recordConversationMemory(storage, { message: 'Carry on', reply: 'Carrying on, sir.', now: 2_000 });
  await recordConversationMemory(storage, { message: 'Open the garden journal', reply: 'Opened, sir.', now: 3_000 });
  for (const ask of ['Sure thing.', 'Carry on.', 'Please open the window, it is hot in here.', 'Uh huh.']) {
    assert.deepEqual(await recallMemories(storage, ask, { ownerWordsOnly: true }), [], ask);
  }
});

test('a related talk still comes back, quoted as his old words, never as "You said:"', async () => {
  const storage = memoryStorage();
  await recordConversationMemory(storage, { message: 'The boiler in the cellar makes a knocking noise at night.', reply: 'Noted, sir.', now: 1_000 });
  const found = await recallMemories(storage, 'Is the knocking noise from the boiler dangerous?', { ownerWordsOnly: true });
  assert.equal(found.length, 1);
  const block = rememberedText(found);
  assert.match(block, /the owner wrote then: "The boiler in the cellar makes a knocking noise at night\."/);
  assert.doesNotMatch(block, /You said:|CHE answered/);
  assert.match(block, /never repeat one as your reply/);
});

test('a live-price claim needs a quoted figure; an explanation that says "current price" stays', () => {
  const explain = 'Contango is when a futures contract trades above the current price of the underlying, because holding it costs money.';
  assert.deepEqual(claimKindsIn(explain), []);
  assert.equal(auditReply(explain, { evidence: {} }).text, explain);
  for (const quote of ['The current price of gold is 2,410 dollars.', 'Right now 5120 is the latest price for the index.']) {
    assert.deepEqual(claimKindsIn(quote), ['live_price'], quote);
    assert.match(auditReply(quote, { evidence: {} }).text, /cannot give a live price/);
  }
});

test('a promise to ask another AI with nothing sent is removed', () => {
  const state = verifiedState([], [], {});
  const out = guardOwnerReply('I will message Gemini about it. Sounds good.', state);
  assert.deepEqual(out.removed.map((r) => r.rule), ['peer_collaboration']);
  assert.equal(out.text, 'Sounds good.');
  // Asking the owner, or a general "I'll ask", is not a peer claim.
  assert.equal(guardOwnerReply('I will ask you one more thing first.', state).removed.length, 0);
});

test('through /api/chat: a removed AI promise is answered with the AI record, not the coding-job list', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: "I'll ask Copilot. Copilot will get back to us." }) } };
  const state = new CheState({ storage: memoryStorage(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const data = saved.get('che');
  const at = new Date().toISOString();
  data.jobs = [...(data.jobs || []), { id: 'abcd1234-job', kind: 'self_development', status: 'queued', title: 'probe', created_at: at, updated_at: at }];
  saved.set('che', data);
  const reply = replyFromNdjson(await (await send('/api/chat', { message: 'Is the sound coming through okay?', history: [] }, token)).text());
  assert.doesNotMatch(reply, /Coding job|abcd1234|I'll ask Copilot/);
  assert.match(reply, /No message to another AI is on record/);
});

test('the owner in the third person, and a place he liked, are questions for his records, not the model', () => {
  assert.deepEqual(ownerMemoryQuestion('What did the owner say about the garden fence?', []), { topic: 'the garden fence' });
  assert.ok(ownerMemoryQuestion('Which museum did I enjoy in Vienna?', []));
  assert.ok(ownerMemoryQuestion('What was the hotel I visited in Oslo?', []));
  // Someone else's owner, advice, and a present-tense preference stay with the model.
  for (const ask of ['What did the owner of the bakery tell you?', 'What should I visit in Rome?', 'Which car do I like more, the red or the blue?']) {
    assert.equal(ownerMemoryQuestion(ask, []), null, ask);
  }
});
