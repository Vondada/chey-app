// Relationship discovery (owner, 2026-10-20): Brain records are related by the exact references they
// share (pull request, commit, job, investigation, repository, file, package, record set, symbol), then
// by distinctive words in title and body, each link with its basis and status. Offline, in-memory SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CheBrainStore } from './brain_store.js';
import { discoverRelations, entitiesOf, relationReason, RELATIONS_VERSION } from './brain_relations.js';
import { RELINK_DONE_KEY, answerCrossRoom, crossRoomIntent, publishRoomEvent, relinkRecords } from './brain_rooms.js';
import { receiptEvent } from './room_events.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key),
  };
}

test('entitiesOf reads exact references from title, body and refs, and ignores look-alikes', () => {
  const e = (text, source) => entitiesOf(source ? { title: text, source } : text);
  assert.deepEqual(e('Pull request #374 merged as 502cf47dafa5').sort(), ['pr:374', 'sha:502cf47'].sort());
  assert.ok(e('Update #375 deployed to the live Worker').includes('pr:375'));
  assert.ok(e('Coding job c2987a73 started').includes('job:c2987a73'));
  assert.ok(e('REA investigation complete', { refs: { investigation: 'rea-9f2c01ab' } }).includes('inv:rea-9f2c01ab'));
  assert.ok(e('See https://github.com/Vondada/chey-app/pull/371 for the fix').includes('pr:371'));
  assert.ok(e('See https://github.com/Vondada/chey-app/pull/371 for the fix').includes('repo:vondada/chey-app'));
  assert.ok(e('The bug is in brain_rooms.js and lib/rooms/che_trading_ledgers.dart').includes('file:che_trading_ledgers.dart'));
  assert.ok(e('REA inspected npm left-pad 1.3.0', { refs: { target: 'npm:left-pad@1.3.0' } }).includes('npm:left-pad'));
  assert.ok(e('2 forward paper trades closed on MNQ').includes('symbol:MNQ'));
  assert.ok(e('The forward paper journal closed 2 trades').includes('ledger:forward_paper_journal'));
  assert.ok(e('Buy $AAPL on the dip').includes('symbol:AAPL'));
  // Look-alikes: a bare update count, an all-caps word, an npm command, a date, a plain hex-free word.
  assert.deepEqual(e('I made 3 updates and update 3 more; the CEO said OK'), []);
  assert.deepEqual(e('Run npm install then npm test'), []);
  assert.deepEqual(e('Recorded at 2026-10-20 as planned'), []);
  // Provenance lines a room event appends are not the subject.
  assert.deepEqual(entitiesOf({ title: 'A note', body: 'Body.\nEvidence: receipt pr_opened #12 at abc1234def.\nSource room: Coding Room.' }), []);
});

test('records that share a pull request link across rooms with no shared title word (derived, both directions)', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  const merged = publishRoomEvent(store, receiptEvent({ kind: 'merged', number: 374, sha: '502cf47dafa5d74b', detail: 'squash', at: '2026-10-20T11:00:00Z' }));
  const screen = publishRoomEvent(store, { room: 'screen', kind: 'observation', key: 'screen:1', title: 'Screen: GitHub checks page', body: 'GitHub shows checks for PR #374, all green.', status: 'observed', at: '2026-10-20T11:05:00Z' });
  assert.equal(screen.outcome, 'created');
  const link = screen.links.find((l) => l.to === merged.id);
  assert.ok(link, 'the screen observation links to the merge receipt of the same pull request');
  assert.equal(link.basis, 'pr'); assert.equal(link.status, 'derived'); assert.equal(link.type, 'relevant_to');
  assert.deepEqual(link.shared, ['374']);
  assert.match(relationReason(link), /the same pull request \(#374\)/);
  const back = store.get(merged.id);
  assert.ok(back.links.some((l) => l.to === screen.id), 'the older record links back');
  assert.ok(back.source.relations.some((r) => r.to === screen.id && r.basis === 'pr' && r.status === 'derived'));
  assert.equal(store.get(screen.id).source.relations_v, RELATIONS_VERSION);
});

test('later stages of one pull request build upon the earlier ones in the same room', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  const opened = publishRoomEvent(store, receiptEvent({ kind: 'pr_opened', number: 371, summary: 'Coding runtime fallback', at: '2026-10-20T09:00:00Z' }));
  const deployed = publishRoomEvent(store, receiptEvent({ kind: 'deployed', number: 371, detail: 'Worker version abc', at: '2026-10-20T10:00:00Z' }));
  const link = deployed.links.find((l) => l.to === opened.id);
  assert.equal(link?.type, 'builds_upon');
  assert.equal(link?.basis, 'pr');
});

test('a symbol or record set links across rooms only, and not when every record names it', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  for (let i = 0; i < 3; i += 1) publishRoomEvent(store, { room: 'trading', kind: 'journal_trades', key: `j${i}`, title: `${i + 1} forward paper trades closed`, body: 'MNQ 5-minute journal.', status: 'verified', at: `2026-10-20T10:0${i}:00Z` });
  const tick = store.get('room:trading:j2');
  assert.equal((tick.source.relations || []).filter((r) => r.basis === 'symbol' || r.basis === 'ledger').length, 0, 'ticks of one series in one room are not related to each other');
  const rea = publishRoomEvent(store, { room: 'rea', kind: 'investigation', key: 'r1', title: 'REA investigation complete: an MNQ order-flow tool', body: 'Mapped 9 features.', status: 'verified', at: '2026-10-20T10:10:00Z' });
  assert.ok(rea.links.some((l) => l.basis === 'symbol' && l.shared.includes('MNQ') && l.room === 'trading'), 'MNQ links the REA record to the Trading Room');
  // Too common to mean anything: with many records naming it, the symbol stops linking.
  for (let i = 3; i < 12; i += 1) publishRoomEvent(store, { room: 'research', kind: 'note', key: `n${i}`, title: `Note ${i}`, body: `MNQ volatility note ${i}.`, status: 'observed', at: `2026-10-20T11:${String(i).padStart(2, '0')}:00Z` });
  const late = publishRoomEvent(store, { room: 'office', kind: 'task', key: 'o1', title: 'Worker task about MNQ', body: 'x', status: 'verified', at: '2026-10-20T12:00:00Z' });
  assert.equal(late.links.filter((l) => l.basis === 'symbol').length, 0);
});

test('distinctive body words link records whose titles differ (a candidate, never derived)', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  const a = publishRoomEvent(store, { room: 'research', kind: 'note', key: 'a', title: 'Notes from the latency study', body: 'Websocket reconnect backoff causes stale quotes during reconnect storms.', status: 'verified', at: '2026-10-20T10:00:00Z' });
  const b = publishRoomEvent(store, { room: 'rea', kind: 'investigation', key: 'b', title: 'REA finding on a broker app', body: 'Their websocket reconnect uses jittered backoff to avoid stale quotes.', status: 'verified', at: '2026-10-20T10:05:00Z' });
  const link = b.links.find((l) => l.to === a.id);
  assert.ok(link, 'shared body words relate the two');
  assert.equal(link.basis, 'terms'); assert.equal(link.status, 'candidate');
  assert.ok(link.shared.includes('websocket') && link.shared.includes('reconnect'));
  assert.equal((store.get(a.id).links || []).some((l) => l.to === b.id), false, 'a candidate link is not written back on the other record');
  // Two unrelated records share nothing.
  const c = publishRoomEvent(store, { room: 'music', kind: 'play', key: 'c', title: 'Played a jazz playlist', body: 'Evening listening.', status: 'observed', at: '2026-10-20T10:06:00Z' });
  assert.equal(c.links.length, 0);
  assert.equal(discoverRelations(store, { id: 'none', title: '', body: '' }).length, 0);
});

test('relinking finds relations for older records a few at a time, then stops querying', sqlite, async () => {
  const saved = new Map();
  const storage = storageFor(saved);
  const store = new CheBrainStore(storage);
  // Written as an older version would have: no relations version.
  for (const [id, title, at] of [['room:coding:pr_opened:380', 'Pull request #380 opened: voice fix', '2026-10-19T10:00:00Z'], ['room:screen:screen:x', 'Screen: PR #380 diff', '2026-10-19T11:00:00Z']]) {
    store.put({ id, kind: id.startsWith('room:coding') ? 'room_pr_opened' : 'room_observation', region: 'coding', path: 'x', title, body: 'old', source: { kind: 'room_event', room: id.split(':')[1] }, verification: 'verified_source', links: [], created_at: at }, { origin: 'cloud' });
  }
  const first = await relinkRecords(storage, store, { limit: 1 });
  assert.equal(first.checked, 1);
  const second = await relinkRecords(storage, store, { limit: 5 });
  assert.equal(second.checked, 1);
  assert.ok(store.get('room:coding:pr_opened:380').links.some((l) => l.to === 'room:screen:screen:x'));
  const third = await relinkRecords(storage, store);
  assert.equal(third.done, true);
  assert.equal(saved.get(RELINK_DONE_KEY), RELATIONS_VERSION);
  assert.equal((await relinkRecords(storage, store)).checked, 0, 'no query once done');
});

test('"what is connected to" and "how is X related to Y" parse only for a real anchor; ordinary questions stay with the model', () => {
  assert.deepEqual(crossRoomIntent('What is connected to pull request 374?'), { kind: 'related', rooms: [], topic: 'pull request 374' });
  assert.deepEqual(crossRoomIntent("CHE, what's related to this?"), { kind: 'related', rooms: [], topic: 'this' });
  assert.equal(crossRoomIntent('What else is linked to job c2987a73').kind, 'related');
  assert.deepEqual(crossRoomIntent('What is connected to the breakout strategy in the Brain?'), { kind: 'related', rooms: [], topic: 'the breakout strategy' });
  assert.deepEqual(crossRoomIntent('How is PR 371 related to job c2987a73?'), { kind: 'relate', rooms: [], topic: 'PR 371', other: 'job c2987a73' });
  assert.equal(crossRoomIntent('What is connected to brain_rooms.js?').kind, 'related');
  for (const m of ['What is related to Three.js?', 'What is connected to MNQ?', 'What is related to diabetes?', 'How is inflation related to interest rates?', 'Is coffee linked to anxiety?', 'What is connected to the internet?', 'How are you connected to the server?']) {
    assert.equal(crossRoomIntent(m), null, m);
  }
});

test('answers name each connection with its room, status and reason, and say so when there is none', sqlite, async () => {
  const store = new CheBrainStore(storageFor());
  publishRoomEvent(store, receiptEvent({ kind: 'merged', number: 374, sha: '502cf47dafa5', at: '2026-10-20T11:00:00Z' }));
  publishRoomEvent(store, { room: 'screen', kind: 'observation', key: 'screen:1', title: 'Screen: GitHub checks page', body: 'Checks for PR #374, all green.', status: 'observed', at: '2026-10-20T11:05:00Z' });
  const ask = (message) => answerCrossRoom({ store, storage: null, env: {}, intent: crossRoomIntent(message) });
  const related = await ask('What is connected to pull request 374?');
  assert.match(related.text, /Pull request #374 merged/);
  assert.match(related.text, /Screen: GitHub checks page \(Screen, observed, not verified\)/);
  const how = await ask('How is PR 374 related to commit 502cf47?');
  assert.match(how.text, /both name|linked to/);
  const none = await ask('What is connected to pull request 999?');
  assert.match(none.text, /Nothing in the Brain names "pull request 999"/);
  assert.equal(none.hits, 0);
  publishRoomEvent(store, { room: 'music', kind: 'play', key: 'm', title: 'Played PR 120 playlist', body: 'x', status: 'observed', at: '2026-10-20T11:06:00Z' });
  const apart = await ask('How is PR 374 related to PR 120?');
  assert.match(apart.text, /no recorded link or shared reference/);
});
