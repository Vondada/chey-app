import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore, RELATIONSHIP_TYPES, VERIFICATION_STATES, assessSignificance, backfillConversations, contentHash, displayCopy, fnv1a32, isSafeText, normalizeLinks, normalizeRecord, projectLegacyState, rememberExchange, sameDisplayCopy } from './brain_store.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const sample = (over = {}) => ({
  id: 'mem:abc', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Family',
  title: 'Mom’s birthday', body: 'Mom’s birthday is on the 4th of July.', verification: 'owner_attested',
  source: { kind: 'memory_record' }, links: [{ type: 'related_to', to: 'mem:dad' }], ...over,
});

test('the Brain has sixteen regions, eighteen relationship types and the fact-check verification labels', () => {
  assert.equal(Object.keys(BRAIN_REGIONS).length, 16);
  assert.equal(RELATIONSHIP_TYPES.length, 18);
  assert.ok(VERIFICATION_STATES.includes('owner_attested') && VERIFICATION_STATES.includes('model_opinion') && VERIFICATION_STATES.includes('unknown'));
});

test('fnv1a32 is the reference value the phone must match', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('mem:abc:3'), fnv1a32('mem:abc:3'));
  assert.notEqual(fnv1a32('mem:abc:3'), fnv1a32('mem:abc:4'));
});

test('records are normalized: unknown region falls back, links are typed and unique, significance is explained', () => {
  const r = normalizeRecord({ id: ' x1 ', region: 'Nowhere', body: 'Some body text that is long enough.', links: ['a', { type: 'bogus', to: 'a' }, { type: 'verified_by', to: 'b' }], verification: 'made_up' });
  assert.equal(r.id, 'x1');
  assert.equal(r.region, BRAIN_REGIONS.learned);
  assert.equal(r.verification, 'unknown');
  assert.deepEqual(r.links, [{ type: 'related_to', to: 'a' }, { type: 'verified_by', to: 'b' }]);
  assert.equal(r.title, 'Some body text that is long enough.');
  assert.equal(r.significance.auditor, 'rules_v1');
  assert.ok(r.significance.reasons.length > 0);
  assert.equal(normalizeRecord({}).error, 'A record needs an id.');
  assert.equal(normalizeLinks([{ to: 'z', type: 'solves' }, { to: 'z', type: 'solves' }]).length, 1);
});

test('significance rules are explainable and the owner’s score always wins', () => {
  const rules = assessSignificance({ verification: 'owner_attested', kind: 'correction', body: 'CHE, my sister is called Ana, not Anna.', links: [] });
  assert.ok(rules.score > 0.7, String(rules.score));
  assert.ok(rules.reasons.includes('the owner said it himself'));
  assert.ok(rules.reasons.includes('a correction of something CHE got wrong'));
  const owner = assessSignificance({ verification: 'model_opinion', body: 'x', significance: { owner_score: 0.9 } });
  assert.equal(owner.score, 0.9);
  assert.equal(owner.auditor, 'owner');
  const opinion = assessSignificance({ verification: 'model_opinion', body: 'The market will probably rise next week.' });
  assert.ok(opinion.reasons.some((r) => /not a fact/.test(r)));
});

test('apply: created, unchanged, updated, merged links, concurrent edit becomes a conflict with both copies kept', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const created = store.apply({ op_id: 'op1', type: 'put', record: sample() }, { origin: 'phone' });
  assert.equal(created.outcome, 'created');
  assert.equal(created.rev, 1);
  assert.equal(created.record.origin, 'phone');
  assert.equal(store.apply({ op_id: 'op2', type: 'put', record: sample(), base_rev: 1 }).outcome, 'unchanged');
  const merged = store.apply({ op_id: 'op3', type: 'put', record: sample({ links: [{ type: 'verified_by', to: 'conv:1' }] }), base_rev: 0 });
  assert.equal(merged.outcome, 'merged');
  assert.deepEqual(merged.record.links.map((l) => l.to).sort(), ['conv:1', 'mem:dad']);
  assert.equal(merged.rev, 2);
  const updated = store.apply({ op_id: 'op4', type: 'put', record: sample({ body: 'Mom’s birthday is on the 5th of July.' }), base_rev: 2 });
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.rev, 3);
  assert.deepEqual(updated.record.links.map((l) => l.to).sort(), ['conv:1', 'mem:dad'], 'an update keeps the union of links');
  const conflict = store.apply({ op_id: 'op5', type: 'put', record: sample({ body: 'Mom’s birthday is on the 6th of July.' }), base_rev: 2 }, { origin: 'phone' });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.record.body, 'Mom’s birthday is on the 5th of July.', 'the stored copy stays');
  const open = store.conflicts();
  assert.equal(open.length, 1);
  assert.equal(open[0].incoming.body, 'Mom’s birthday is on the 6th of July.', 'the incoming copy is kept too');
  assert.equal(store.status().open_conflicts, 1);
  const resolved = store.resolveConflict(open[0].id, 'incoming');
  assert.equal(resolved.ok, true);
  assert.equal(store.get('mem:abc').body, 'Mom’s birthday is on the 6th of July.');
  assert.equal(store.conflicts().length, 0);
});

test('apply: a duplicate op returns its first outcome, a delete always wins, and only a client that saw the tombstone recreates', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.apply({ op_id: 'a', type: 'put', record: sample() });
  const again = store.apply({ op_id: 'a', type: 'put', record: sample({ body: 'different' }) });
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.first_outcome, 'created');
  assert.equal(store.get('mem:abc').body, sample().body, 'a replayed op changes nothing');
  const deleted = store.apply({ op_id: 'd', type: 'delete', id: 'mem:abc' }, { origin: 'phone' });
  assert.equal(deleted.outcome, 'deleted');
  assert.equal(deleted.record.deleted, true);
  assert.equal(deleted.record.body, '', 'a tombstone carries no content');
  assert.equal(deleted.record.rev, 2);
  const stale = store.apply({ op_id: 's', type: 'put', record: sample(), base_rev: 1 });
  assert.equal(stale.outcome, 'deleted', 'a stale put after a delete does not resurrect the record');
  const recreated = store.apply({ op_id: 'r', type: 'put', record: sample(), base_rev: 2 });
  assert.equal(recreated.outcome, 'created');
  assert.equal(recreated.rev, 3);
  assert.equal(store.apply({ type: 'delete', id: 'never-existed' }).outcome, 'deleted', 'deleting an unknown id leaves a tombstone so every replica forgets it');
});

test('apply: secrets never enter the Brain, from either side', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const rejected = store.apply({ type: 'put', record: sample({ body: 'my bank password is hunter2' }) }, { origin: 'phone' });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(store.get('mem:abc'), null);
});

test('changes page by seq oldest first and carry tombstones; the digest matches an independent computation', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  for (let i = 0; i < 5; i += 1) store.put(sample({ id: `n:${i}`, body: `Note number ${i} with enough words.` }));
  store.delete('n:2');
  const first = store.changes({ since: 0, limit: 3 });
  assert.equal(first.records.length, 3);
  assert.equal(first.more, true);
  assert.deepEqual(first.records.map((r) => r.id), ['n:0', 'n:1', 'n:3']);
  const second = store.changes({ since: first.next, limit: 3 });
  assert.deepEqual(second.records.map((r) => r.id), ['n:4', 'n:2']);
  assert.equal(second.records[1].deleted, true);
  assert.equal(second.more, false);
  const expected = { count: 5, sum: ['n:0:1', 'n:1:1', 'n:3:1', 'n:4:1', 'n:2:2'].reduce((s, k) => (s + fnv1a32(k)) % 4294967296, 0) };
  assert.deepEqual(store.digest(), expected);
  assert.equal(store.changes({ since: second.next }).records.length, 0);
});

test('search, folders and list use the stored places, and deleted records disappear from all of them', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.put(sample({ id: 'k:1', region: BRAIN_REGIONS.trading, path: 'Backtests', title: 'Silver backtest', body: 'The silver momentum backtest lost 3 percent over 2024.', places: [{ region: BRAIN_REGIONS.experiments, path: 'Backtests' }] }));
  store.put(sample({ id: 'k:2', region: BRAIN_REGIONS.coding, path: 'Worker', title: 'Worker deploy', body: 'The Worker deploys from main with the worker-deploy tag.' }));
  const hits = store.search('what happened with the silver backtest');
  assert.equal(hits[0].id, 'k:1');
  assert.equal(store.search('silver', { region: BRAIN_REGIONS.experiments })[0]?.id, 'k:1', 'a record is found through a secondary place');
  assert.equal(store.search('silver', { region: BRAIN_REGIONS.media }).length, 0);
  const folders = store.folders();
  assert.equal(folders.length, 16, 'every region appears even when empty');
  assert.equal(folders.find((f) => f.region === BRAIN_REGIONS.trading).count, 1);
  assert.equal(folders.find((f) => f.region === BRAIN_REGIONS.experiments).folders[0].path, 'Backtests');
  assert.equal(store.list({ region: BRAIN_REGIONS.coding }).records[0].id, 'k:2');
  store.delete('k:1');
  assert.equal(store.search('silver').length, 0);
  assert.equal(store.folders().find((f) => f.region === BRAIN_REGIONS.trading).count, 0);
  assert.equal(store.status().records, 1);
  assert.equal(store.status().tombstones, 1);
});

test('legacy state projects into stable ids once; a second run skips everything by hash; a changed row updates', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = {
    memory_records: [{ id: 'r1', text: 'The owner’s dog is called Rex.', title: 'Dog', category: 'Family', source: 'owner_chat', verification_status: 'owner_attested', created_at: '2026-10-01T00:00:00.000Z', active: true }],
    memory_notes: [{ id: 'n1', title: 'Fiverr thumbnail gigs', bullets: ['Offer: thumbnails at 25 dollars', 'Why: demand is steady'], sources: ['https://example.com/gigs'], kind: 'opportunity', verification_status: 'unverified_research_lead', created_at: '2026-10-02T00:00:00.000Z' }],
    learned_knowledge: ['Unverified research lead — Market: silver fell.'],
    team_tasks: [{ id: 't1', task: 'Research silver', status: 'running', agent_name: 'Scout', agent_id: 'ag1' }],
    nightly_reviews: [{ at: '2026-10-03T07:07:00.000Z', review: 'Nothing failed today.' }],
  };
  const first = projectLegacyState(store, data);
  assert.equal(first.projected, 5);
  const mem = store.get('mem:r1');
  assert.equal(mem.region, BRAIN_REGIONS.personal);
  assert.equal(mem.verification, 'owner_attested');
  assert.equal(store.get('note:n1').region, BRAIN_REGIONS.business);
  assert.equal(store.get('note:n1').kind, 'opportunity');
  assert.equal(store.get('task:t1').path, 'Active');
  assert.deepEqual(store.get('task:t1').links, [{ type: 'produced_by_agent', to: 'agent:ag1' }]);
  assert.equal(store.get('review:2026-10-03T07:07:00.000Z').verification, 'model_opinion');
  assert.ok(store.get(`know:${fnv1a32(data.learned_knowledge[0]).toString(16)}`));
  const second = projectLegacyState(store, data);
  assert.equal(second.projected, 0);
  assert.equal(second.skipped, 5);
  const seqBefore = store.status().seq;
  data.team_tasks[0].status = 'done';
  const third = projectLegacyState(store, data);
  assert.equal(third.projected, 1);
  assert.equal(store.get('task:t1').path, 'Historical');
  assert.equal(store.status().seq, seqBefore + 1, 'only the changed row was rewritten');
  assert.equal(store.get('mem:r1').rev, 1);
});

test('a live exchange is kept word for word, and the brainmem backfill resumes from its cursor without replacing it', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const long = 'Here is the whole answer. '.repeat(80);
  const live = rememberExchange(store, { id: 'conv_1', message: 'What did we decide about the trading bot?', reply: long, at: '2026-10-10T10:00:00.000Z' });
  assert.equal(live.outcome, 'created');
  assert.equal(store.get('conv:conv_1').body.length, `You said: What did we decide about the trading bot?\nCHE answered: ${long.trim()}`.length);
  assert.equal(store.get('conv:conv_1').path, 'Chat/2026-10-10');

  const legacy = new Map();
  for (let i = 1; i <= 7; i += 1) {
    legacy.set(`brainmem:${String(i).padStart(15, '0')}:conv_${i}`, { id: `conv_${i}`, at: `2026-10-0${i}T00:00:00.000Z`, title: `Q ${i}`, body: `You said: question ${i}\nCHE answered: short.`, links: i > 1 ? [`conv_${i - 1}`] : [] });
  }
  const fakeStorage = { list: async ({ prefix, limit, startAfter }) => {
    const keys = [...legacy.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit);
    return new Map(keys.map((k) => [k, legacy.get(k)]));
  } };
  const one = await backfillConversations(store, fakeStorage, { batch: 3 });
  assert.equal(one.added, 2, 'conv_1 already has a fuller live record and is not replaced');
  assert.equal(one.done, false);
  const two = await backfillConversations(store, fakeStorage, { batch: 3 });
  assert.equal(two.added, 3);
  const three = await backfillConversations(store, fakeStorage, { batch: 3 });
  assert.equal(three.added, 1);
  assert.equal(three.done, true);
  assert.equal(store.get('conv:conv_1').body.includes(long.trim()), true);
  assert.deepEqual(store.get('conv:conv_3').links, [{ type: 'related_to', to: 'conv:conv_2' }]);
  assert.equal(store.get('conv:conv_3').source.full_text, false);
  const four = await backfillConversations(store, fakeStorage, { batch: 3 });
  assert.equal(four.added, 0);
  assert.equal(store.status().conversation_backfill.done, true);
});

test('contentHash ignores links and significance, so relationship-only edits merge instead of conflicting', () => {
  const a = normalizeRecord(sample());
  const b = normalizeRecord(sample({ links: [{ type: 'solves', to: 'prob:1' }], significance: { owner_score: 1 } }));
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash(normalizeRecord(sample({ body: 'changed' }))));
});

test('a secret anywhere in a long record is refused, not only in its first 500 characters', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const long = `${'The meeting notes go on and on. '.repeat(40)}By the way the wifi password is hunter2.`;
  assert.equal(isSafeText(long), false);
  assert.equal(isSafeText('The meeting notes go on and on. '.repeat(40)), true);
  const rejected = store.put(sample({ id: 'note:long', body: long }));
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(store.get('note:long'), null);
  assert.equal(rememberExchange(store, { id: 'x', message: 'Remember this', reply: long, at: '2026-10-10T10:00:00.000Z' }).outcome, 'rejected');
});

test('CHE’s own writes never resurrect a deleted record, and the legacy projection respects the tombstone', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.apply({ type: 'put', record: sample({ id: 'mem:r9' }) }, { origin: 'phone' });
  store.apply({ type: 'delete', id: 'mem:r9' }, { origin: 'phone' });
  assert.equal(store.put(sample({ id: 'mem:r9' })).outcome, 'deleted');
  assert.equal(store.get('mem:r9').deleted, true);
  const data = { memory_records: [{ id: 'r9', text: sample().body, title: 'Mom', category: 'Family', source: 'owner_chat', verification_status: 'owner_attested', created_at: '2026-10-01T00:00:00.000Z', active: true }] };
  projectLegacyState(store, data);
  assert.equal(store.get('mem:r9').deleted, true, 'the lingering legacy row does not bring it back');
  assert.equal(store.search('birthday').length, 0);
  const again = projectLegacyState(store, data);
  assert.equal(again.projected, 0);
});

test('re-sending a subset of a record’s links changes nothing', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  store.put(sample({ id: 'l:1', links: [{ type: 'related_to', to: 'a' }, { type: 'solves', to: 'b' }] }));
  const rev = store.get('l:1').rev;
  assert.equal(store.put(sample({ id: 'l:1', links: [{ type: 'solves', to: 'b' }] })).outcome, 'unchanged');
  assert.equal(store.put(sample({ id: 'l:1', links: [] })).outcome, 'unchanged');
  assert.equal(store.get('l:1').rev, rev);
  assert.equal(store.put(sample({ id: 'l:1', links: [{ type: 'tests', to: 'c' }] })).outcome, 'merged');
  assert.equal(store.get('l:1').links.length, 3);
});

test('the legacy display copy never overwrites a phone-authored or fuller memory; only its flags carry over', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const long = `First line of the memory.\nSecond line with detail.\n\n  Indented third   line. ${'More words here. '.repeat(200)}`;
  store.apply({ op_id: 'p1', type: 'put', record: sample({ id: 'mem:long', kind: 'memory', body: long, source: { kind: 'memory_record' } }) }, { origin: 'iphone' });
  const legacyText = long.replace(/\s+/g, ' ').trim().slice(0, 500);
  const data = { memory_records: [{ id: 'long', text: legacyText, title: 'First line', category: 'Family', source: 'owner_chat', verification_status: 'owner_attested', created_at: '2026-10-01T00:00:00.000Z', active: true }] };
  projectLegacyState(store, data);
  const after = store.get('mem:long');
  assert.equal(after.body, long, 'the Brain keeps the whole text with its lines');
  assert.equal(after.rev, 1, 'no revision churn from the display copy');
  assert.ok(store.search('words here').length >= 1);
  data.memory_records[0].active = false;
  data.memory_records[0].superseded_at = '2026-10-18T00:00:00.000Z';
  projectLegacyState(store, data);
  const flagged = store.get('mem:long');
  assert.equal(flagged.body, long);
  assert.equal(flagged.source.active, false);
  assert.equal(flagged.source.superseded_at, '2026-10-18T00:00:00.000Z');
  assert.equal(flagged.rev, 2);
  assert.equal(projectLegacyState(store, data).projected, 0, 'and then nothing more');
});

test('the secret gate reads the whole text at once: no false refusal where a window would cut a word, and source fields are scanned', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const clean = `${'word '.repeat(59)}spin ${'word '.repeat(19)}pins ${'word '.repeat(120)}`;
  assert.equal(isSafeText(clean), true);
  assert.equal(store.put(sample({ id: 'note:clean', body: clean })).outcome, 'created');
  assert.equal(store.put(sample({ id: 'note:src', body: 'A harmless note.', source: { kind: 'test', note: 'the password is hunter2' } })).outcome, 'rejected');
});

test('the display copy of a display copy is the same copy, even when the cut lands on a space', () => {
  for (const text of ['word '.repeat(150), `  ${'ab '.repeat(200)}`, 'short', '', 'x'.repeat(700)]) {
    const once = displayCopy(text);
    assert.equal(displayCopy(once), once, JSON.stringify(text.slice(0, 20)));
    assert.ok(once.length <= 500);
    assert.equal(once, once.trim());
    assert.ok(sameDisplayCopy(text, once));
  }
});
