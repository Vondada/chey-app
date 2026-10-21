// Retrieval from the Brain must find what the owner told CHE in chat. Before this, owner chat turns (kind
// `conversation`) were filtered out of every chat search, so a fact said in chat could never come back.
// Replayed through /api/chat with fixture records written into the test's own storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { BRAIN_REGIONS, CheBrainStore, retrievableOwnerRecord, retrievalBody } from './brain_store.js';

const generated = new URL('./.chat_retrieval.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}

async function storageFor() {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const sql = await sqlStorage();
  if (!sql) return null;
  storage.sql = sql;
  return storage;
}

async function owner(storage, modelReply, record) {
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (model, input) => { record.models.push({ model, input }); return { response: modelReply }; } },
  };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    say: async (message) => {
      const res = await post('/api/chat', { message, agent_mode: 'full' }, token);
      const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: res.status, reply: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') || {} };
    },
  };
}

// An owner chat turn as rememberExchange stores it.
function ownerTurn(id, said, answered, at = '2026-10-19T09:00:00.000Z') {
  return {
    id: `conv:${id}`, kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-19',
    title: said.slice(0, 80), body: `You said: ${said}\nCHE answered: ${answered}`,
    verification: 'owner_attested', source: { kind: 'owner_chat', full_text: true }, links: [], created_at: at,
  };
}

test('an owner chat turn is retrievable; another AI conversation record is not', () => {
  assert.equal(retrievableOwnerRecord({ kind: 'conversation', verification: 'owner_attested', body: 'You said: pizza' }), true);
  assert.equal(retrievableOwnerRecord({ kind: 'conversation', verification: 'model_opinion', body: 'You said: pizza' }), false);
  assert.equal(retrievableOwnerRecord({ kind: 'conversation', verification: 'owner_attested', body: 'Claude said: pizza' }), false);
  assert.equal(retrievableOwnerRecord({ kind: 'memory', verification: 'owner_attested', body: 'x' }), true);
});

test('only the owner words of a chat turn are quoted, never CHE\'s own answer', () => {
  const record = ownerTurn('a', 'my favorite food is pizza', 'Noted, sir. I will remember that.');
  assert.equal(retrievalBody(record), 'my favorite food is pizza');
  assert.equal(retrievalBody({ kind: 'memory', body: 'Your favorite food is pizza.' }), 'Your favorite food is pizza.');
});

test('search ranks a record that matches more of the question\'s words above one that matches fewer', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const put = (id, title, body) => store.apply({ op_id: `fx-${id}`, type: 'put', record: {
    id, kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Preferences', title, body,
    verification: 'owner_attested', source: { kind: 'owner_chat' }, links: [],
  } }, { origin: 'owner' });
  put('mem:one', 'Pizza', 'Pizza is good.');
  put('mem:three', 'Favorite food', 'The favorite food is pizza with basil.');
  put('mem:two', 'Food', 'Food: the favorite dish is pasta.');
  const ids = store.search('my favorite food pizza', { limit: 2 }).map((r) => r.id);
  // Matching words: three has favorite, food and pizza (3); two has favorite and food (2); one has pizza (1).
  assert.deepEqual(ids, ['mem:three', 'mem:two'], 'the record with the most matching words comes first, and the cut keeps the best ones');
});

test('a fact the owner told CHE in chat is found by a normal question, with the owner as the stored speaker', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.apply({ op_id: 'fx-chat-food', type: 'put', record: ownerTurn('food1', 'my favorite food is pizza', 'Noted, sir.') }, { origin: 'owner' });

  const record = { models: [] };
  const che = await owner(storage, 'I do not know your favorite food.', record);
  await che.say('What is my favorite food?');
  const prompt = JSON.stringify(record.models.at(-1)?.input || {});
  assert.match(prompt, /pizza/, 'the model is given the owner\'s chat words');
  assert.match(prompt, /speaker owner/, 'the owner is the stored speaker');
  assert.doesNotMatch(prompt, /Noted, sir/, 'CHE\'s own answer is not presented as the owner\'s words');
});

test('"search my memory" finds the same owner chat turn and names its stored sender', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.apply({ op_id: 'fx-chat-food2', type: 'put', record: ownerTurn('food2', 'my favorite food is pizza', 'Noted, sir.') }, { origin: 'owner' });

  const record = { models: [] };
  const che = await owner(storage, 'unused', record);
  const { reply, done } = await che.say('Search my long-term memory for my favorite food.');
  assert.equal(done.source, 'che_memory_search');
  assert.equal(done.model_calls, 0);
  assert.match(reply, /pizza/);
  assert.match(reply, /sender: owner \(as stored\)/);
  assert.doesNotMatch(reply, /Noted, sir/);
  assert.deepEqual(record.models, []);
});
