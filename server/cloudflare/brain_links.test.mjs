// Brain links: a new research page is linked to the older pages it relates to, and the walk and cluster
// lookups reach everything that connects, with the path CHE followed. Uses the Brain's own SQL store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { clusterOf, expandByLinks } from './brain_relations.js';
import { storeLoopReads, listResearchPages } from './agent_research_memory.js';

async function brain() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  const saved = new Map();
  const storage = {
    get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); }, delete: async (k) => saved.delete(k),
    list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {},
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
  };
  return new CheBrainStore(storage);
}

const note = (id, title, body, links = []) => ({ id, kind: 'note', region: BRAIN_REGIONS.learned, path: 'Test', title, body, verification: 'unverified_research_lead', source: {}, links, created_at: '2026-10-21T10:00:00.000Z' });

test('a new page links forward to an older page that shares its distinctive words (a candidate)', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  store.put(note('old-pizza', 'Pizza origin Naples', 'Pizza began in Naples Italy history of the dish', []), { origin: 'owner', now: 1 });
  storeLoopReads(store, {
    question: 'pizza history',
    observations: [{ ok: true, read: true, url: 'https://example.org/naples-pizza', text: 'Naples pizza origin history: the dish began in Naples Italy and spread.' }],
    now: '2026-10-21T10:00:00.000Z',
  });
  const page = listResearchPages(store).pages.find((p) => p.url.includes('naples-pizza'));
  assert.ok(page, 'the page was kept');
  const link = store.get(page.id).links.find((l) => l.to === 'old-pizza');
  assert.ok(link, 'the new page links to the older one');
  // Word overlap alone is not written back on the older page: that keeps the graph precise.
  assert.equal((store.get('old-pizza').links || []).some((l) => l.to === page.id), false);
});

test('the walk follows links outward and records the path; the cluster holds everything connected', async (t) => {
  const store = await brain();
  if (!store) return t.skip('node:sqlite unavailable');
  store.put(note('c', 'C', 'far away', []), { origin: 'owner', now: 1 });
  store.put(note('b', 'B', 'middle', [{ type: 'builds_upon', to: 'c' }]), { origin: 'owner', now: 2 });
  store.put(note('a', 'A', 'start', [{ type: 'related_to', to: 'b' }]), { origin: 'owner', now: 3 });
  store.put(note('lone', 'Lone', 'not linked to anything', []), { origin: 'owner', now: 4 });
  const walk = expandByLinks(store, [store.get('a')], { depth: 2 });
  const byId = Object.fromEntries(walk.map((w) => [w.record.id, w]));
  assert.equal(byId.b.depth, 1);
  assert.equal(byId.c.depth, 2);
  assert.deepEqual(byId.c.via, [{ type: 'related_to', from: 'a' }, { type: 'builds_upon', from: 'b' }], 'the path is kept');
  assert.equal(byId.c.via.length, 2);
  const cluster = clusterOf(store, 'a').map((r) => r.id).sort();
  assert.deepEqual(cluster, ['a', 'b', 'c']);
  assert.ok(!cluster.includes('lone'), 'an unlinked record is not in the cluster');
});
