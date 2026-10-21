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
