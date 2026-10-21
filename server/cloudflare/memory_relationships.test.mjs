// Owner report (2026-10-21): CHE keeps mixing up the owner, Claude, Atlas and Flagstaff correspondence. Stored
// provenance was right, but live answers did not enforce it: owner evidence ignored Brain records, other speakers
// were never checked, and the model saw Brain records with no speaker. Replayed through /api/chat with real
// fixture records (written into this test's own storage, never invented as real memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.memory_relationships.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { BRAIN_REGIONS, CheBrainStore } = await import('./brain_store.js');
const { storedSpeaker, guardSpeakerAttributions, guardOwnerAttributions } = await import('./memory_provenance.js');

const QUESTION_1 = 'What instruction did I give you about Atlas, and what did Claude tell you about Atlas?';
const QUESTION_2 = 'Which Atlas instruction came from me and which came from Claude? Give me the dates.';

// Real shapes: the phone's owner record, a Flagstaff exchange from Claude, and an Office report from Atlas.
const FIXTURES = [
  { op: 'fx-owner', origin: 'phone', record: { id: 'mem:phone-atlas-paper', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Atlas', title: 'Atlas: paper trading only', body: 'Keep Atlas on paper trading only.', verification: 'owner_attested', source: { kind: 'owner_chat' }, created_at: '2026-10-02T09:00:00.000Z', links: [] } },
  { op: 'fx-claude', origin: 'cloud', record: { id: 'conv:flagstaff:claude-atlas-1', kind: 'flagstaff', region: BRAIN_REGIONS.coding, path: 'Outside correspondence/Flagstaff replies', title: 'Claude on Atlas', body: 'Claude: Atlas should run the research lab next.', verification: 'external_correspondence', source: { kind: 'flagstaff_exchange', advice_only: true, owner_words: false, peer: 'Claude' }, created_at: '2026-03-15T10:00:00.000Z', links: [] } },
  { op: 'fx-atlas', origin: 'atlas', record: { id: 'office:atlas-run-1', kind: 'office', region: BRAIN_REGIONS.coding, path: 'Office/Atlas', title: 'Atlas run report', body: 'Atlas: the research lab run finished with 3 notes.', verification: 'observed', source: { kind: 'office_report', agent: 'Atlas' }, created_at: '2026-10-05T08:00:00.000Z', links: [] } },
];

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}

async function storageFor({ withRecords = true, withSql = true } = {}) {
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
    if (withRecords) {
      const store = new CheBrainStore(storage);
      for (const f of FIXTURES) {
        const result = store.apply({ op_id: f.op, type: 'put', record: f.record }, { origin: f.origin });
        if (result.outcome !== 'created') throw new Error(`fixture ${f.record.id} not created: ${result.outcome}`);
      }
    }
  }
  return storage;
}

async function owner(storage, modelReply, record) {
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (model, input) => {
      record.models.push({ model, input });
      record.prompts.push(input.messages.map((x) => x.content).join('\n'));
      return { response: modelReply };
    } },
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

test('owner question 1: each answer names its stored speaker, and Claude is never the owner', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [], prompts: [] };
  const che = await owner(storage, 'You told me Atlas should run the research lab next.', record);
  const { reply, done } = await che.say(QUESTION_1);
  assert.equal(done.source, 'che_memory_search');
  assert.deepEqual(record.models, [], 'the model is never asked about who said what');
  assert.match(reply, /mem:phone-atlas-paper[\s\S]*sender: owner \(as stored\)/, 'the owner record is attributed to the owner, as stored');
  assert.match(reply, /conv:flagstaff:claude-atlas-1[\s\S]*sender: Claude \(as stored\)/, 'the Claude message is attributed to Claude, not the owner');
  assert.match(reply, /office:atlas-run-1[\s\S]*sender: Atlas \(as stored\)/, 'the Office report keeps Atlas as its speaker');
  assert.doesNotMatch(reply, /2023|February 10|March 15|by tone/i);
});

test('owner question 2: dates come from the stored records only', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [], prompts: [] };
  const che = await owner(storage, 'I told you on February 10, 2023 and Claude wrote on March 15, 2023.', record);
  const { reply, done } = await che.say(QUESTION_2);
  assert.equal(done.source, 'che_memory_search');
  assert.match(reply, /2026-10-02/);
  assert.match(reply, /2026-03-15/);
  assert.doesNotMatch(reply, /2023/);
  assert.deepEqual(record.models, []);
});

test('a model answer that gives Claude\'s words to the owner, or a speaker\'s words to the wrong speaker, is removed', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [], prompts: [] };
  const che = await owner(storage, [
    'You told me Atlas should run the research lab next.',
    'Claude reported the research lab run finished with 3 notes.',
    'You told me to keep Atlas on paper trading only.',
  ].join(' '), record);
  const { reply } = await che.say('Summarize my notes about Atlas.');
  assert.doesNotMatch(reply, /You told me Atlas should run the research lab next/, 'Claude\'s recommendation is not the owner\'s words');
  assert.doesNotMatch(reply, /Claude reported the research lab run finished/, 'Atlas\'s report is not Claude\'s');
  assert.match(reply, /keep Atlas on paper trading only/, 'the owner\'s stored Brain statement is still kept');
});

test('the model is shown each stored record with its speaker, so it need not guess one from wording', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [], prompts: [] };
  const che = await owner(storage, 'Noted.', record);
  await che.say('Summarize my notes about Atlas.');
  const prompt = record.prompts.join('\n');
  assert.match(prompt, /speaker owner/, 'the owner record is labelled with its stored speaker');
  assert.match(prompt, /speaker Claude/, 'the Claude record is labelled Claude');
  assert.match(prompt, /speaker Atlas/, 'the Office report is labelled Atlas');
});

test('an unreadable Brain store gives an honest answer, never remembered records', async (t) => {
  const storage = await storageFor({ withSql: false });
  const record = { models: [], prompts: [] };
  const che = await owner(storage, 'You told me on February 10, 2023 to keep Atlas on paper.', record);
  const { reply, done } = await che.say(QUESTION_1);
  assert.equal(done.source, 'che_memory_search');
  assert.match(reply, /Brain store could not be read/);
  assert.doesNotMatch(reply, /2023|sender: owner \(as stored\)|mem:/, 'no record is named when the store is unreadable');
});

test('unit: a speaker comes only from stored fields, never from the wording of a record', () => {
  assert.equal(storedSpeaker(FIXTURES[0].record).speaker, 'owner');
  assert.equal(storedSpeaker(FIXTURES[1].record).speaker, 'Claude');
  assert.equal(storedSpeaker(FIXTURES[2].record).speaker, 'Atlas');
  const wordingOnly = { id: 'x', kind: 'note', verification: 'observed', source: { kind: 'note' }, body: 'Claude: I said keep Atlas on paper.' };
  assert.equal(storedSpeaker(wordingOnly).speaker, '', 'a body that says "Claude:" does not make Claude the speaker');
  assert.equal(storedSpeaker({ verification: 'owner_attested', source: { kind: 'owner_chat' }, body: 'Claude: keep it.' }).speaker, 'owner', 'a stored owner record stays the owner\'s, whatever its words');
});

test('unit: a named speaker\'s words need a stored record from that speaker that supports them', () => {
  const records = [{ text: 'Claude: Atlas should run the research lab next.', speaker: 'Claude' }];
  assert.equal(guardSpeakerAttributions('Claude told you Atlas should run the research lab next.', { records }).removed.length, 0);
  assert.equal(guardSpeakerAttributions('Atlas told you Atlas should run the research lab next.', { records }).removed.length, 1, 'the wrong speaker is removed');
  assert.equal(guardSpeakerAttributions('Claude recommended a gym membership.', { records }).removed.length, 1, 'content no record supports is removed');
  assert.equal(guardSpeakerAttributions('Claude is a model made by Anthropic.', { records }).removed.length, 0, 'no speech act, nothing attributed');
});

test('unit: owner evidence counts stored owner-attested Brain records, and only those', () => {
  const brainOwner = { ...FIXTURES[0].record, text: FIXTURES[0].record.body, verification_status: 'owner_attested' };
  assert.equal(guardOwnerAttributions('You told me to keep Atlas on paper trading only.', { records: [brainOwner] }).removed.length, 0, 'a stored owner Brain record supports the owner statement');
  const brainClaude = { ...FIXTURES[1].record, text: FIXTURES[1].record.body, verification_status: 'external_correspondence' };
  assert.equal(guardOwnerAttributions('You told me Atlas should run the research lab next.', { records: [brainClaude] }).removed.length, 1, 'Claude\'s message never counts as the owner\'s');
});

test('a model answer that writes a record id, or gives a peer words it never wrote, is removed on any path', async (t) => {
  const storage = await storageFor();
  if (!storage) return t.skip('node:sqlite unavailable');
  const record = { models: [], prompts: [] };
  const che = await owner(storage, 'Claude said it in record mem:claude-atlas-99 that Atlas should stop.', record);
  const { reply } = await che.say('What do you know about Atlas?');
  assert.doesNotMatch(reply, /mem:claude-atlas-99/, 'a model-written record id is never shown as evidence');
  assert.doesNotMatch(reply, /Claude said it/, 'Claude\'s words, with no stored record, are not given to the peer');
});
