// Owner report (2026-10-21): CHE first said her long-term memory and Flagstaff records were unavailable, then
// "retrieved" two records dated February 10 and March 15, 2023 about Atlas, gave no record ids or sources, and
// said she told the owner from Claude by tone, context and keywords. Replayed here through /api/chat.
// The records below are fixtures written into the test's own storage, never a stand-in for real memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.brain_retrieval_provenance.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { BRAIN_REGIONS, CheBrainStore } = await import('./brain_store.js');
const { memorySearchIntent, memorySearchReply, memorySearchTerms } = await import('./memory_search.js');
const { guardExecutionClaims } = await import('./truth_layer.js');

const OWNER_QUESTION_1 = 'CHE, can you search my long-term memory and the Flagstaff records right now?';
const OWNER_QUESTION_2 = 'Distinguish the previous instruction I gave you about Atlas from the instruction Claude gave you. Give me the dates, record IDs and where each came from.';
const INVENTED = 'I searched my long-term memory and the Flagstaff records. I found two records: an owner instruction dated February 10, 2023 about Atlas, and a Claude instruction dated March 15, 2023 about Atlas. I told them apart by tone, context and keywords.';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}

// Storage for the Worker. `withSql: false` leaves the Brain store unreadable, as a storage without SQL does.
async function storageFor({ withSql = true } = {}) {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  if (withSql) {
    const sql = await sqlStorage();
    if (!sql) return null;
    storage.sql = sql;
  }
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

// A Flagstaff session as lockMailbox stores it (one SQLite row per locked session).
function seedArchive(storage, session) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS flagstaff_archive (id TEXT PRIMARY KEY, locked_at TEXT NOT NULL, body TEXT NOT NULL)');
  storage.sql.exec('INSERT INTO flagstaff_archive (id, locked_at, body) VALUES (?, ?, ?)', session.id, session.locked_at, JSON.stringify(session));
}

test('owner questions: the memory search answers from the stores, with no model call and no invented date', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  seedArchive(storage, {
    id: 'sess-2026-10-02', locked_at: '2026-10-02T11:00:00.000Z', count: 1,
    messages: [{ at: '2026-10-02T10:00:00.000Z', from: 'owner', to: 'che', text: 'Atlas: keep the paper desk on until I say otherwise.' }],
  });
  const record = { models: [] };
  const che = await owner(storage, INVENTED, record);

  const first = await che.say(OWNER_QUESTION_1);
  assert.equal(first.done.source, 'che_memory_search');
  assert.equal(first.done.model_calls, 0);
  assert.doesNotMatch(first.reply, /cannot access|not available|could not be reached/i, 'no false "unavailable" claim when the stores were read');

  const second = await che.say(OWNER_QUESTION_2);
  assert.equal(second.done.source, 'che_memory_search');
  assert.match(second.reply, /sess-2026-10-02/, 'the reply names the archived session it read');
  assert.match(second.reply, /2026-10-02/, 'the date is the stored message date');
  assert.match(second.reply, /from "owner" \(as stored\)|from "owner"/, 'the sender is the stored one');
  for (const invented of ['February 10, 2023', 'March 15, 2023', '2023', 'tone', 'context and keywords']) {
    assert.doesNotMatch(second.reply, new RegExp(invented.replace(/[.]/g, '\\.')), `"${invented}" must not reach the owner`);
  }
  assert.deepEqual(record.models, [], 'the no-tools model is never asked about memory');
});

test('owner questions: a stored Brain record is retrieved with its id, text and sender as stored', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.apply({ op_id: 'fixture-food', type: 'put', record: {
    id: 'mem:favorite-food', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Preferences',
    title: 'Favorite food', body: 'Your favorite food is pizza.', verification: 'owner_attested',
    source: { kind: 'owner_chat' }, links: [],
  } }, { origin: 'owner' });
  const record = { models: [] };
  const che = await owner(storage, 'I do not know.', record);
  const { reply, done } = await che.say('Search my long-term memory for my favorite food.');
  assert.equal(done.source, 'che_memory_search');
  assert.match(reply, /mem:favorite-food/, 'the record id is named');
  assert.match(reply, /pizza/, 'the stored text is the answer');
  assert.match(reply, /sender: owner \(as stored\)/, 'the sender is the stored origin, not an inference');
  assert.deepEqual(record.models, []);
});

test('an invented dated record and a tone-based authorship claim in a model answer are removed', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [] };
  const che = await owner(storage, INVENTED, record);
  const { reply } = await che.say('What do you know about Atlas?');
  assert.doesNotMatch(reply, /February 10, 2023|March 15, 2023/);
  assert.doesNotMatch(reply, /by tone|tone, context/i);
  assert.doesNotMatch(reply, /I searched my long-term memory/);
  assert.match(reply, /cannot verify/i, 'the owner is told the claim has no record behind it');
});

test('the memory search reports unavailable and empty results honestly, and invents nothing for either', () => {
  assert.equal(memorySearchIntent(OWNER_QUESTION_1), true);
  assert.equal(memorySearchIntent(OWNER_QUESTION_2), true);
  assert.equal(memorySearchIntent('Open my video library.'), false, 'the video library keeps its own route');
  assert.equal(memorySearchIntent('Remember that my favorite food is pizza.'), false, 'a fact to remember is not a search');

  const unavailable = memorySearchReply(OWNER_QUESTION_2, { brainHits: null, archive: null });
  assert.match(unavailable.text, /could not read the Brain store or the Flagstaff archive/);
  assert.deepEqual(unavailable.records, []);

  const empty = memorySearchReply(OWNER_QUESTION_2, { brainHits: [], archive: [{ at: '2026-10-02T10:00:00Z', from: 'owner', to: 'che', text: 'Garage door code note.', session: 's1' }] });
  assert.match(empty.text, /Nothing matched/);
  assert.doesNotMatch(empty.text, /\d{4}-\d{2}-\d{2}|February|March/);
  assert.deepEqual(empty.records, []);

  assert.deepEqual(memorySearchTerms(OWNER_QUESTION_2), ['atlas'], 'only the topic is searched, not the words about the question');
});

test('claim guard: a memory search or a record claim the model made without a receipt is removed', () => {
  assert.equal(guardExecutionClaims('I searched my long-term memory and found nothing.').removed.length, 1);
  assert.equal(guardExecutionClaims('I did not search my long-term memory.').removed.length, 0, 'a denial is not a claim');
  assert.equal(guardExecutionClaims('I found two records about Atlas.').removed.length, 1);
  assert.equal(guardExecutionClaims(INVENTED).removed.length >= 2, true);
  assert.equal(guardExecutionClaims('I told the owner and Claude apart by tone.').removed.length, 1, 'authorship from tone is removed');
  assert.equal(guardExecutionClaims('I cannot tell who wrote a message by tone.').removed.length, 0, 'an honest "cannot" stays');
  assert.equal(guardExecutionClaims('The meeting is on 2023-02-10 at noon.').removed.length, 0, 'a date with no record claim stays');
});

test('claim guard: a dated record stands only when its date is in the stored text the model was given', () => {
  const reply = 'The instruction dated 2026-10-02 is the one to follow.';
  assert.equal(guardExecutionClaims(reply).removed.length, 1, 'no stored text: the dated record is removed');
  assert.equal(guardExecutionClaims(reply, { verifiedText: '[2026-10-02] Atlas: keep the paper desk on.' }).removed.length, 0, 'a date the stored text shows stays');
  assert.equal(guardExecutionClaims(reply, { verifiedText: 'Atlas notes from 2026-09-01.' }).removed.length, 1, 'a different date does not');
});
