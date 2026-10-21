import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeLibrary, KNOWLEDGE_CATEGORIES } from './knowledge_library.js';
import { KNOWLEDGE_CATALOG_SEED, seedKnowledgeCatalog } from './knowledge_catalog_seed.js';

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

test('the owner list has 77 items: 41 books (40 plus the Stanford IR book), 12 comics, 15 movies, 8 documentation, 1 paper', () => {
  assert.equal(KNOWLEDGE_CATALOG_SEED.length, 77);
  const kinds = KNOWLEDGE_CATALOG_SEED.reduce((acc, [, , , kind]) => ({ ...acc, [kind]: (acc[kind] || 0) + 1 }), {});
  assert.equal(kinds.comic, 12);
  assert.equal(kinds.movie, 15);
  assert.equal(kinds.book, 41);
  assert.equal(kinds.documentation, 8);
  assert.equal(kinds.paper, 1);
});

test('every seed item uses a known category and no title and creator pair repeats', () => {
  const ids = new Set(KNOWLEDGE_CATEGORIES.map((c) => c.id));
  const keys = new Set();
  for (const [title, creator, category] of KNOWLEDGE_CATALOG_SEED) {
    assert.ok(ids.has(category), `${title} has an unknown category`);
    keys.add(`${title}|${creator}`.toLowerCase());
  }
  assert.equal(keys.size, 77);
});

test('seeding catalogs all 77 once; repeating it adds nothing', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const first = seedKnowledgeCatalog(kl);
  assert.equal(first.added, 77);
  assert.deepEqual(first.errors, []);
  const again = seedKnowledgeCatalog(kl);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 77);
  assert.equal(kl.list({ limit: 500 }).length, 77);
});

test('nothing from the seed is indexed or cited: all cataloged, and the status says so', async () => {
  const kl = new KnowledgeLibrary(await storage());
  seedKnowledgeCatalog(kl);
  assert.equal(kl.list({ limit: 500 }).filter((r) => r.access === 'indexed').length, 0);
  const answer = kl.answer('What does Release It say about circuit breakers?');
  assert.equal(answer.status, 'cataloged_only');
  assert.deepEqual(answer.citations, []);
});

test('movies are never returned as technical evidence', async () => {
  const kl = new KnowledgeLibrary(await storage());
  seedKnowledgeCatalog(kl);
  const movieNote = kl.list({ limit: 500 }).find((r) => r.title === 'Ex Machina');
  assert.match(movieNote.note, /Fiction/);
  assert.equal(movieNote.kind, 'movie');
});

// The owner's library opens with its catalog in place: an empty production-like store seeds once, a reopen adds
// nothing, and a reference he indexed keeps its text and status.
test('an empty library is seeded on first open, once; a reopen adds nothing and an indexed reference keeps its text', async () => {
  const { ensureKnowledgeCatalog, KNOWLEDGE_SEED_VERSION } = await import('./knowledge_catalog_seed.js');
  const store = await storage();
  const saved = new Map();
  const put = { storage: { ...store, get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v) } };
  const kl = new KnowledgeLibrary(put.storage);
  const first = await ensureKnowledgeCatalog(put.storage, kl);
  assert.equal(first.seeded, true);
  assert.equal(first.added, 77);
  assert.equal(first.version, KNOWLEDGE_SEED_VERSION);
  assert.equal(kl.list({ limit: 500 }).length, 77);

  const owned = kl.catalog({ title: 'Retry notes', creator: 'Owner', category: 'software_engineering', kind: 'note', license: 'owner' });
  kl.index(owned.id, 'Retries with exponential backoff spread load after a failure, and only transient errors should be retried. '.repeat(6));
  const indexedBefore = kl.get(owned.id);

  const again = await ensureKnowledgeCatalog(put.storage, new KnowledgeLibrary(put.storage));
  assert.equal(again.seeded, false, 'the second open is a no-op');
  const reseeded = seedKnowledgeCatalog(new KnowledgeLibrary(put.storage));
  assert.equal(reseeded.added, 0, 'a forced re-seed adds nothing');
  assert.equal(reseeded.duplicates, 77);
  const indexedAfter = new KnowledgeLibrary(put.storage).get(owned.id);
  assert.equal(indexedAfter.access, 'indexed');
  assert.equal(indexedAfter.revision, indexedBefore.revision);
  assert.equal(new KnowledgeLibrary(put.storage).list({ limit: 500 }).length, 78);
});

test('without SQLite storage nothing is seeded and nothing is marked as done', async () => {
  const { ensureKnowledgeCatalog } = await import('./knowledge_catalog_seed.js');
  const saved = new Map();
  const noSql = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v) };
  const result = await ensureKnowledgeCatalog(noSql, new KnowledgeLibrary(noSql));
  assert.equal(result.seeded, false);
  assert.equal(saved.has('knowledge_catalog_seed'), false);
});
