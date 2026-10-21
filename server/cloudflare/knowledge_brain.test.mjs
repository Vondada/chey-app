// Knowledge references in the Brain: each one is a record, linked to related records as it is stored, and linked
// items are leads, never citations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeLibrary } from './knowledge_library.js';
import { CheBrainStore } from './brain_store.js';

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const TEXT = 'Retries with exponential backoff spread load after a failure. Add jitter to every wait so clients do not retry together. '.repeat(6);

test('a catalogued reference is a Brain record with no passage, under its category', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved', topics: ['stability', 'circuit breakers'] });
  const record = new CheBrainStore(kl.storage).get(ref.key);
  assert.ok(record, 'the reference is in the Brain');
  assert.equal(record.path, 'Knowledge/Debugging and Reliability');
  assert.equal(record.verification, 'unverified_reference');
  assert.match(record.body, /catalogued only, text not stored/);
  assert.equal(record.source.ref_id, ref.id);
});

test('indexed owner text: the Brain holds only an opening, and is owner-attested', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const ref = kl.catalog({ title: 'Team notes', category: 'software_engineering', kind: 'note', license: 'owner' });
  kl.index(ref.id, TEXT);
  const record = new CheBrainStore(kl.storage).get(ref.key);
  assert.equal(record.verification, 'owner_attested');
  assert.ok(record.body.length < TEXT.length, 'the full text is not copied into the Brain');
  assert.match(record.body, /Opening: Retries with exponential backoff/);
});

test('references that share topics are linked to each other in the Brain as they are stored', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const a = kl.catalog({ title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved', topics: ['circuit breakers', 'stability'] });
  const b = kl.catalog({ title: 'Resilient Services', creator: 'A. Writer', category: 'software_engineering', kind: 'book', license: 'all rights reserved', topics: ['circuit breakers', 'failure'] });
  const brain = new CheBrainStore(kl.storage);
  const linked = brain.get(b.key);
  assert.ok(linked.links.some((l) => l.to === a.key), 'the newer reference links to the older one');
});

test('a search answer lists linked references as leads and never cites them', async () => {
  const kl = new KnowledgeLibrary(await storage());
  const owner = kl.catalog({ title: 'Team notes', category: 'software_engineering', kind: 'note', license: 'owner', topics: ['retry', 'backoff'] });
  kl.index(owner.id, TEXT);
  kl.catalog({ title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved', topics: ['retry', 'backoff'] });
  const answer = kl.answer('How should retries back off?');
  assert.equal(answer.status, 'answered');
  assert.deepEqual(answer.citations.map((c) => c.match(/^\[([^,\]]+)/)[1]), ['Team notes']);
  assert.match(answer.text, /Linked in the Brain \(not quoted\): Release It!/);
  assert.ok(answer.related.some((r) => r.title === 'Release It!'));
});

test('compare cites the indexed side and says the catalogued side is unread', async () => {
  const { knowledgeReply, knowledgeIntent } = await import('./knowledge_library.js');
  const kl = new KnowledgeLibrary(await storage());
  const owner = kl.catalog({ title: 'Team notes', category: 'software_engineering', kind: 'note', license: 'owner' });
  kl.index(owner.id, TEXT);
  kl.catalog({ title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved' });
  const reply = knowledgeReply(kl, knowledgeIntent('Compare Team notes and Release It! in my knowledge library'));
  assert.match(reply, /\[Team notes, part 1/);
  assert.match(reply, /Release It!.*catalogued only\. I have not read it/);
  const learned = knowledgeReply(kl, knowledgeIntent('What did you learn from Release It! in my knowledge library?'));
  assert.match(learned, /I have not read "Release It!"/);
});
