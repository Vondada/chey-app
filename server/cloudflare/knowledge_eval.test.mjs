// Retrieval quality for the Knowledge Library, offline on a fixed corpus. It measures what the owner asked for:
// relevance (the right reference is found), citation correctness (every cited title and part was really stored),
// hallucination (a catalogued work is never cited as read), latency and storage. The numbers are printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeLibrary, knowledgeTaskContext } from './knowledge_library.js';
import { seedKnowledgeCatalog } from './knowledge_catalog_seed.js';

// The title in a citation: "[Title by Creator, edition, part N; …]".
const titleOf = (citation) => citation.slice(1).split(/ by |, /)[0];

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const CORPUS = [
  { title: 'Team retry notes', creator: 'Team', category: 'software_engineering', kind: 'note', license: 'owner', topics: ['retry', 'backoff'], text: 'Retries should wait longer after each failure, with random jitter, so clients do not retry at the same moment. Stop after a few attempts.' },
  { title: 'Database indexing memo', creator: 'Team', category: 'search_rag', kind: 'note', license: 'owner', topics: ['index', 'query'], text: 'A B-tree index lets the database find rows by key without reading the whole table. Add an index on columns you filter by most often.' },
  { title: 'Public domain logic primer', creator: 'Anon', category: 'math_statistics', kind: 'documentation', license: 'public_domain', topics: ['logic', 'proof'], text: 'A valid argument is one where the conclusion must be true whenever every premise is true. Test validity by searching for a counterexample.' },
  { title: 'The Lighthouse', creator: 'N. Writer', category: 'creative_writing', kind: 'fiction', license: 'owner', topics: ['lighthouse', 'keeper'], text: 'The keeper climbed the stairs every night, counting each step to hold the storm at bay. The light never failed.' },
];
const QUESTIONS = [
  { q: 'how should retries back off with jitter', want: 'Team retry notes' },
  { q: 'when does a database index help a query', want: 'Database indexing memo' },
  { q: 'what makes an argument valid with a counterexample', want: 'Public domain logic primer' },
];
const CATALOGUED = { title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved', topics: ['retry', 'circuit breakers'] };

test('retrieval quality on a fixed corpus: relevance, citations, no hallucinated reading, latency and storage', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const build = Date.now();
  for (const item of CORPUS) {
    const ref = kl.catalog({ title: item.title, creator: item.creator, category: item.category, kind: item.kind, license: item.license, topics: item.topics });
    kl.index(ref.id, item.text.repeat(4));
  }
  kl.catalog(CATALOGUED);
  const buildMs = Date.now() - build;

  let relevant = 0;
  let cited = 0;
  let correct = 0;
  const times = [];
  for (const { q, want } of QUESTIONS) {
    const t0 = performance.now();
    const answer = kl.answer(q);
    times.push(performance.now() - t0);
    if (answer.citations.length) cited += 1;
    if (answer.citations[0] && titleOf(answer.citations[0]) === want) relevant += 1;
    // Each citation must name a reference that is really indexed.
    const indexed = new Set(kl.list({ limit: 500 }).filter((r) => r.access === 'indexed').map((r) => r.title));
    if (answer.citations.every((c) => indexed.has(titleOf(c)))) correct += 1;
  }
  // The catalogued work matches the question but must never be cited as read.
  const unread = kl.answer('circuit breakers and retry stability');
  const hallucinated = unread.citations.some((c) => c.includes('Release It!'));
  const storedChars = kl.list({ limit: 500 }).reduce((n, r) => n + Number(r.chars || 0), 0);
  const report = {
    relevance_at_1: `${relevant}/${QUESTIONS.length}`,
    citation_correctness: `${correct}/${QUESTIONS.length}`,
    cited_answers: `${cited}/${QUESTIONS.length}`,
    hallucinated_readings: hallucinated ? 1 : 0,
    latency_ms_p50: Number(times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(2)),
    index_build_ms: buildMs,
    references: kl.list({ limit: 500 }).length,
    indexed_references: kl.list({ limit: 500 }).filter((r) => r.access === 'indexed').length,
  };
  console.log('KNOWLEDGE_EVAL', JSON.stringify(report));
  assert.equal(relevant, QUESTIONS.length, 'every question finds the right reference');
  assert.equal(correct, QUESTIONS.length, 'every citation names an indexed reference');
  assert.equal(hallucinated, false, 'a catalogued work is never cited as read');
  assert.ok(report.latency_ms_p50 < 200, 'a search answers in well under 200 ms on this corpus');
});

test('an Office agent gets indexed passages, and catalogued works are named as unread', async () => {
  const store = await storage();
  const kl = new KnowledgeLibrary(store);
  const ref = kl.catalog(CORPUS[0]);
  kl.index(ref.id, CORPUS[0].text.repeat(4));
  kl.catalog(CATALOGUED);
  const context = knowledgeTaskContext(store, 'retry with jitter and circuit breakers');
  assert.match(context, /\[Team retry notes by Team, part 1/);
  assert.match(context, /Catalogued only, NOT read[^\n]*Release It!/);
  assert.equal(knowledgeTaskContext(store, 'nothing in the library matches zebra gardening'), '');
});

test('the full seed catalogue adds no text: a question about it is answered as unread, never as read', async () => {
  const kl = new KnowledgeLibrary(await storage());
  seedKnowledgeCatalog(kl);
  const answer = kl.answer('What does Release It say about circuit breakers?');
  assert.equal(answer.status, 'cataloged_only');
  assert.deepEqual(answer.citations, []);
});
