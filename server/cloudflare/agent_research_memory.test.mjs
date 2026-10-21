// Pages CHE reads are kept for another day, labeled as leads, and unsafe text is never stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { storeLoopReads, RESEARCH_PATH } from './agent_research_memory.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}
async function brain() {
  const saved = new Map();
  const storage = {
    get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); }, delete: async (k) => saved.delete(k),
    list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const sql = await sqlStorage();
  if (!sql) return null;
  storage.sql = sql;
  return new CheBrainStore(storage);
}

test('a page she read is kept as an unverified research lead, with its address and the question', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  const out = storeLoopReads(store, {
    question: 'favorite food?',
    observations: [{ ok: true, read: true, url: 'https://example.org/food', text: 'Pizza is the most popular food in this article.' }],
  });
  assert.equal(out.kept.length, 1);
  const record = store.get(out.kept[0].id);
  assert.equal(record.kind, 'research');
  assert.equal(record.verification, 'unverified_research_lead');
  assert.equal(record.path, RESEARCH_PATH);
  assert.equal(record.region, BRAIN_REGIONS.learned);
  assert.equal(record.source.url, 'https://example.org/food');
  assert.match(record.body, /Question: favorite food\?/);
});

test('a page that was only listed in search results, not read, is not stored', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  const out = storeLoopReads(store, { observations: [{ ok: true, read: false, items: [{ url: 'https://x.example' }] }] });
  assert.equal(out.kept.length, 0);
});

test('a page with a password or a secret in its text is not stored', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  const out = storeLoopReads(store, {
    observations: [{ ok: true, read: true, url: 'https://bank.example', text: 'Your password: hunter2 and session token abc' }],
  });
  assert.equal(out.kept.length, 0);
  assert.equal(out.skipped.length, 1);
});

test('a stored page is found by a later search, next to other records, and stays a lead', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  storeLoopReads(store, {
    question: 'pizza history',
    observations: [{ ok: true, read: true, url: 'https://example.org/pizza', text: 'Pizza began in Naples and spread worldwide.' }],
  });
  const hits = store.search('pizza naples', { limit: 5 });
  assert.ok(hits.some((h) => h.kind === 'research' && h.verification === 'unverified_research_lead'));
});
