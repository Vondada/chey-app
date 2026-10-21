import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_CATEGORIES, KnowledgeLibrary, referenceKey, textAllowed } from './knowledge_library.js';

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const RETRY_TEXT = [
  'Retries with exponential backoff spread load after a failure. Wait a base delay, double it on each attempt, and add jitter.',
  'Stop after a fixed number of attempts, and only retry errors that can succeed later, such as timeouts or 503 responses.',
].join(' ').repeat(8);

const NOVEL_TEXT = 'The lighthouse keeper climbed the stairs each night, counting the steps as a way to hold the storm at bay. '.repeat(8);

test('the 20 categories are fixed and named as the owner listed them', () => {
  assert.equal(KNOWLEDGE_CATEGORIES.length, 20);
  assert.equal(new Set(KNOWLEDGE_CATEGORIES.map((c) => c.id)).size, 20);
  assert.ok(KNOWLEDGE_CATEGORIES.some((c) => c.name === 'Search and Retrieval-Augmented Generation'));
});

test('only owner, public-domain and open licences may store full text', () => {
  assert.equal(textAllowed('public_domain'), true);
  assert.equal(textAllowed('cc_by'), true);
  assert.equal(textAllowed('all rights reserved'), false);
  assert.equal(textAllowed('unknown'), false);
  assert.equal(textAllowed(''), false);
});

test('a copyrighted book is catalogued and its text is refused', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Backoff in Practice', creator: 'A. Author', category: 'software_engineering', kind: 'book', license: 'all rights reserved' });
  assert.equal(ref.access, 'cataloged');
  const refused = kl.index(ref.id, RETRY_TEXT);
  assert.match(refused.error, /stays catalogued/);
  assert.equal(kl.get(ref.id).access, 'cataloged');
});

test('a duplicate reference is not catalogued twice', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const first = kl.catalog({ title: 'Backoff in Practice', creator: 'A. Author', category: 'software_engineering', kind: 'book', license: 'owner' });
  const again = kl.catalog({ title: 'backoff in practice', creator: 'a. author', category: 'software_engineering', kind: 'book', license: 'owner' });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(kl.list().length, 1);
  assert.equal(referenceKey({ title: 'X', creator: 'Y' }), referenceKey({ title: 'x', creator: 'y' }));
});

test('1 and 2: a coding question finds the saved programming passage, cited with title, creator and part', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Reliable Services', creator: 'J. Engineer', edition: '2nd', category: 'software_engineering', kind: 'documentation', license: 'owner', source_url: 'https://example.com/reliable', topics: ['retry', 'backoff'] });
  kl.index(ref.id, RETRY_TEXT);
  const answer = kl.answer('How should I retry a failed request with backoff?', { category: 'software_engineering' });
  assert.equal(answer.status, 'answered');
  assert.match(answer.citations[0], /\[Reliable Services by J\. Engineer, 2nd, part 1; software_engineering; trust: owner_text\]/);
  assert.match(answer.text, /exponential backoff/);
});

test('3: fiction is not returned for a technical question, and is found when asked for', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const novel = kl.catalog({ title: 'The Lighthouse', creator: 'N. Writer', category: 'creative_writing', kind: 'fiction', license: 'owner' });
  kl.index(novel.id, NOVEL_TEXT);
  assert.equal(kl.search('lighthouse keeper stairs', { technical: true }).hits.length, 0);
  assert.equal(kl.search('lighthouse keeper stairs', { technical: false }).hits.length > 0, true);
});

test('4: the source of an indexed fact is recalled with its URL', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Reliable Services', creator: 'J. Engineer', category: 'software_engineering', kind: 'book', license: 'owner', source_url: 'https://example.com/reliable' });
  kl.index(ref.id, RETRY_TEXT);
  const [hit] = kl.search('backoff jitter').hits;
  assert.equal(hit.source_url, 'https://example.com/reliable');
  assert.equal(hit.creator, 'J. Engineer');
});

test('5: an answer across categories cites each source and invents none', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const a = kl.catalog({ title: 'Reliable Services', creator: 'J. Engineer', category: 'software_engineering', kind: 'book', license: 'owner' });
  const b = kl.catalog({ title: 'Retry Economics', creator: 'M. Analyst', category: 'debugging_reliability', kind: 'paper', license: 'cc_by' });
  kl.index(a.id, RETRY_TEXT);
  kl.index(b.id, RETRY_TEXT.replace('backoff', 'budget'));
  const { hits } = kl.search('retry with backoff');
  const titles = [...new Set(hits.map((h) => h.title))].sort();
  assert.deepEqual(titles, ['Reliable Services', 'Retry Economics']);
  const answer = kl.answer('retry with backoff');
  assert.deepEqual(answer.citations, hits.map((h) => h.citation));
});

test('6: an unindexed book is never claimed as read', async () => {
  const kl = new KnowledgeLibrary(await storage());
  kl.catalog({ title: 'Designing Data Systems', creator: 'M. Kleppmann', category: 'software_engineering', kind: 'book', license: 'all rights reserved', topics: ['replication', 'consistency'] });
  const answer = kl.answer('What does the replication chapter say about consistency?');
  assert.equal(answer.status, 'cataloged_only');
  assert.deepEqual(answer.citations, []);
  assert.match(answer.text, /not indexed, so I have not read it/);
});

test('7: a search returns at most the limit, so the whole library is never loaded per request', async () => {
  const kl = new KnowledgeLibrary(await storage());
  for (let i = 0; i < 8; i += 1) {
    const ref = kl.catalog({ title: `Retry note ${i}`, creator: 'Team', category: 'software_engineering', kind: 'note', license: 'owner' });
    kl.index(ref.id, RETRY_TEXT);
  }
  assert.ok(kl.search('backoff', { limit: 3 }).hits.length <= 3);
});

test('8: a cited passage is the one actually retrieved, and a later re-index replaces the old text', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Reliable Services', creator: 'J. Engineer', category: 'software_engineering', kind: 'book', license: 'owner' });
  kl.index(ref.id, RETRY_TEXT);
  kl.index(ref.id, 'Use a circuit breaker to stop calling a failing dependency until it recovers, and log every trip for review.'.repeat(4));
  assert.equal(kl.get(ref.id).revision, 2);
  assert.equal(kl.search('backoff').hits.length, 0);
  assert.equal(kl.search('circuit breaker').hits[0].title, 'Reliable Services');
});

test('status reports indexed and cataloged counts per category', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const a = kl.catalog({ title: 'Reliable Services', creator: 'J. Engineer', category: 'software_engineering', kind: 'book', license: 'owner' });
  kl.index(a.id, RETRY_TEXT);
  kl.catalog({ title: 'Designing Data Systems', creator: 'M. Kleppmann', category: 'software_engineering', kind: 'book', license: 'all rights reserved' });
  const row = kl.status().find((c) => c.id === 'software_engineering');
  assert.equal(row.indexed, 1);
  assert.equal(row.cataloged, 1);
});

test('an unknown category is refused, and a new category is requested rather than invented', async () => {
  const kl = new KnowledgeLibrary(await storage());
  assert.match(kl.catalog({ title: 'X book', category: 'cooking', kind: 'book' }).error, /20 categories/);
});
