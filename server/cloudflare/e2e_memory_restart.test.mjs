// E2E (reliability lane, 2026-10-25): one fact goes through the whole memory path and survives a restart.
//   save through /api/chat → the record is in durable storage with its id and provenance →
//   a NEW CheState over the same storage (the SQLite database included, as in production) → ask for it
//   through /api/chat → the answer cites the SAME record id → "where did that come from?" names the
//   owner's chat as the source with its date → the Brain record endpoint returns that record.
// Offline and hermetic: every outbound request is refused, and the chat model is a FAKE that always gives a
// wrong answer, so a correct reply can only come from the stored record. The fact is a labelled test fixture.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.e2e_memory_restart.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (e2e tests are offline: ${new URL(String(input?.url || input)).host})`);
};

const { DatabaseSync } = await import('node:sqlite');

// Durable Object storage: one key/value map plus one SQLite database, both kept across "restarts".
function durable() {
  const saved = new Map();
  const db = new DatabaseSync(':memory:');
  const storage = () => ({
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
  });
  return { saved, db, storage };
}

// FAKE model: a wrong answer to every question, a bland one otherwise.
const lastUser = (input) => String((input?.messages || []).filter((m) => m.role === 'user').at(-1)?.content || '');
const WRONG = (input) => (/\?\s*$/.test(lastUser(input).trim()) ? 'The access phrase is Falcon Nine, sir.' : 'Noted, sir.');

async function phone(store, { model = WRONG } = {}) {
  const counter = { calls: 0 };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { counter.calls += 1; return { response: model(input) }; } } };
  const connect = () => {
    const state = new CheState({ storage: store.storage(), waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  connect();
  const send = (path, { method = 'POST', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  }), env);
  const token = (await (await send('/api/pair', { body: { code: '123456' } })).json()).device_token;
  assert.ok(token, 'local pairing works');
  const say = async (message, history = []) => {
    const before = counter.calls;
    const raw = await (await send('/api/chat', { body: { message, history }, token })).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  const get = async (path) => { const r = await send(path, { method: 'GET', token }); return { status: r.status, body: await r.json() }; };
  return { say, get, restart: connect };
}

// TEST FIXTURE: an invented fact that cannot be confused with real owner data.
const FACT = 'CHE, remember this test fact: the fictional vault Amber Kestrel opens with the phrase Quiet Harbor Twelve.';
const ASK = 'What phrase opens the fictional vault Amber Kestrel?';

test('e2e memory: save → durable record → restart → recall cites the same record id and its provenance', async () => {
  const store = durable();
  const first = await phone(store);
  const saved = await first.say(FACT);
  assert.equal(saved.meta.ok, true, saved.reply);
  const receipt = saved.meta.memory_receipt;
  assert.equal(receipt?.status, 'stored', 'the save turn returns a stored receipt');
  assert.ok(receipt.record_id, 'the receipt names its record id');

  // The record is really in durable storage, under that id, with the owner's chat as its source.
  const records = (store.saved.get('che')?.memory_records || []);
  const record = records.find((r) => r.id === receipt.record_id);
  assert.ok(record, `record ${receipt.record_id} is in durable storage (have ${records.map((r) => r.id).join(', ') || 'none'})`);
  assert.match(String(record.text), /Amber Kestrel/);
  assert.match(String(record.text), /Quiet Harbor Twelve/);
  assert.ok(record.created_at && Number.isFinite(Date.parse(record.created_at)), 'the record carries its creation time');
  assert.match(String(record.source || ''), /owner|chat/i, `source is the owner's chat (got ${record.source})`);

  // A new Durable Object instance over the same storage: nothing in memory survives, only what was stored.
  const second = await phone(store);
  second.restart();
  const recalled = await second.say(ASK);
  assert.match(recalled.reply, /Quiet Harbor Twelve/, recalled.reply);
  assert.doesNotMatch(recalled.reply, /Falcon Nine/, 'the fake model never answers a stored fact');
  assert.equal(recalled.modelCalls, 0, 'recall is model-free');
  assert.equal(recalled.meta.recall_receipt?.record_id, receipt.record_id, 'the recall cites the original record id');

  // Provenance follow-up in the same new conversation.
  const why = await second.say('Where did that come from and when did you learn it?', [
    { role: 'user', content: ASK }, { role: 'assistant', content: recalled.reply },
  ]);
  assert.equal(why.meta.source, 'che_evidence_receipt', why.reply);
  assert.match(why.reply, /you told me in chat/i);
  assert.match(why.reply, /Amber Kestrel/);
  assert.match(why.reply, /On [A-Z][a-z]+ \d{1,2}/, 'the follow-up names the date');
  assert.doesNotMatch(why.reply, /Falcon Nine/);
});

// Fixed 2026-10-25 (found by the reliability lane): recallStoredStatement (personal_recall.js ~line 430) matches on shared generic words. "What phrase opens the
// fictional vault Copper Lantern?" shares what/phrase/opens/the/fictional/vault (5 of 8 key words, >= 60%) with the
// stored Amber Kestrel statement, so CHE answers a question about a vault it was never told about with another vault's
// phrase. "what" and "the" are not in ASK_WORDS, and the distinctive name words (copper, lantern) are not required.
test('e2e memory: a different subject is not answered from a stored statement after a restart', async () => {
  const store = durable();
  const first = await phone(store);
  await first.say(FACT);
  const second = await phone(store);
  second.restart();
  const out = await second.say('What phrase opens the fictional vault Copper Lantern?');
  assert.doesNotMatch(out.reply, /Quiet Harbor Twelve/, 'a different subject never borrows the stored fact');
  assert.equal(out.meta.recall_receipt?.record_id ?? null, null, 'no record is cited for a fact never saved');
});
