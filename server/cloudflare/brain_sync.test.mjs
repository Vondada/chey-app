// The Brain through the Worker: the phone's sync endpoints, the owner gate, and the
// hooks that keep the state blob, the chat and the Brain telling one story.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fnv1a32 } from './brain_store.js';

const generated = new URL('./.brain_sync.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
));
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (brain_sync tests are offline: ${new URL(String(input?.url || input)).host})`);
};

async function sqlFor() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}

function storageFor(saved, sql) {
  return {
    sql,
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '', reverse = false, limit, startAfter } = {}) => {
      let keys = [...saved.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      if (reverse) keys.reverse();
      if (limit) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(saved.get(k))]));
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const sql = await sqlFor();
  if (!sql) return null;
  const waits = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => ({ response: model(input) }) },
  };
  const state = new CheState({ storage: storageFor(saved, sql), waitUntil: (p) => waits.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, { method = 'GET', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await call('/api/pair', { method: 'POST', body: { code: '123456' } })).json()).device_token;
  const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };
  return { call, token, saved, settle };
}

test('the Brain endpoints are the owner’s only', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  for (const path of ['/api/brain/status', '/api/brain/changes', '/api/brain/folders', '/api/brain/search?q=x', '/api/brain/conflicts']) {
    assert.equal((await che.call(path)).status, 401, `${path} without a paired device`);
  }
  assert.equal((await che.call('/api/brain/push', { method: 'POST', body: { ops: [] } })).status, 401);
  const status = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(status.available, true);
  assert.equal(status.records, 1, 'a fresh Brain holds only CHE herself (che:core)');
  assert.equal(status.by_kind.core, 1);
  assert.equal(status.regions.length, 16);
});

test('a memory saved on the phone is pushed once, joins CHE’s memory list with the same id, and comes back through /changes', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const op = { op_id: 'phone-1', type: 'put', record: {
    id: 'mem:11111111-1111-4111-8111-111111111111', kind: 'memory', region: 'Personal Memory', path: 'Family',
    title: 'Sister', body: 'My sister is called Ana.', verification: 'owner_attested', source: { kind: 'memory_record' },
  } };
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [op], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'created');
  assert.equal(pushed.results[0].rev, 1);
  assert.equal(pushed.digest.count, 1);
  const state = await (await che.call('/api/state', { token: che.token })).json();
  assert.ok(state.memories.includes('My sister is called Ana.'), 'the owner memory list has it');
  assert.equal(state.memory_records.find((r) => r.text === 'My sister is called Ana.').id, '11111111-1111-4111-8111-111111111111');
  assert.equal(state.memory_records[0].verification_status, 'owner_attested');

  const replay = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [op] } })).json();
  assert.equal(replay.results[0].outcome, 'duplicate', 'the same op twice changes nothing');
  assert.equal((await (await che.call('/api/state', { token: che.token })).json()).memories.length, 1);

  const changes = await (await che.call('/api/brain/changes?since=0', { token: che.token })).json();
  const mine = changes.records.find((r) => r.id === op.record.id);
  assert.ok(mine);
  assert.equal(mine.body, 'My sister is called Ana.');
  assert.equal(mine.verification, 'owner_attested');
  assert.equal(mine.deleted, false);
  assert.equal(changes.digest.count, changes.records.length);
  // The projection of the state blob did not rewrite the phone's record into a conflict.
  const conflicts = await (await che.call('/api/brain/conflicts', { token: che.token })).json();
  assert.equal(conflicts.conflicts.length, 0);
});

test('deleting a memory on the Memory screen leaves a tombstone every replica receives, and clear tombstones them all', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  for (const text of ['The owner’s car is blue.', 'The owner’s dog is Rex.']) {
    assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  }
  const before = await (await che.call('/api/brain/changes?since=0', { token: che.token })).json();
  const car = before.records.find((r) => r.body === 'The owner’s car is blue.');
  assert.ok(car, 'the state blob memory was projected into the Brain');
  assert.equal(car.region, 'Personal Memory');
  assert.equal(car.verification, 'owner_attested');
  const state = await (await che.call('/api/state', { token: che.token })).json();
  const index = state.memories.indexOf('The owner’s car is blue.');
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index } })).status, 200);
  const after = await (await che.call(`/api/brain/changes?since=${before.next}`, { token: che.token })).json();
  const tomb = after.records.find((r) => r.id === car.id);
  assert.ok(tomb, 'the deletion is a change the phone pulls');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.body, '');
  assert.equal((await che.call('/api/memory/clear', { method: 'POST', token: che.token, body: {} })).status, 200);
  const status = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(status.by_kind.memory ?? 0, 0, 'no live memory records after clear');
  assert.ok(status.tombstones >= 2);
  const search = await (await che.call('/api/brain/search?q=dog%20rex', { token: che.token })).json();
  assert.equal(search.hits.length, 0, 'a deleted memory is not searchable');
});

test('an owner chat exchange is kept word for word in Conversations and Corrections, with the same id as its brainmem record', async (t) => {
  const che = await owner({ model: () => 'We decided the lighthouse script ends with Maya keeping the key, sir, and the epilogue with Jonah was cut.' });
  if (!che) return t.skip('node:sqlite unavailable');
  const res = await che.call('/api/chat', { method: 'POST', token: che.token, body: { message: 'What did we decide about the lighthouse script ending?', history: [] } });
  assert.equal(res.status, 200);
  await res.text();
  await che.settle();
  const legacy = await (await che.call('/api/brain/memories', { token: che.token })).json();
  assert.equal(legacy.memories.length, 1);
  const status = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(status.by_kind.conversation, 1);
  const record = await (await che.call(`/api/brain/record?id=conv:${legacy.memories[0].id}`, { token: che.token })).json();
  assert.equal(record.region, 'Conversations and Corrections');
  assert.match(record.body, /You said: What did we decide about the lighthouse script ending\?/);
  assert.match(record.body, /epilogue with Jonah was cut\./, 'the whole answer, not the first sentences');
  assert.equal(record.source.full_text, true);
  const hits = await (await che.call('/api/brain/search?q=lighthouse%20script%20ending', { token: che.token })).json();
  assert.equal(hits.hits[0].id, record.id);
  const folders = await (await che.call('/api/brain/folders', { token: che.token })).json();
  assert.equal(folders.regions.find((r) => r.region === 'Conversations and Corrections').count, 1);
});

test('a concurrent edit from the phone is kept as a conflict, never dropped, and the owner can pick a side', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const record = { id: 'note:x', kind: 'note', region: 'Learned Knowledge', path: 'Notes', title: 'Boiler', body: 'The boiler service is every October.', verification: 'owner_attested' };
  await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'a', type: 'put', record }] } });
  await che.call('/api/brain/record', { method: 'POST', token: che.token, body: { record: { ...record, body: 'The boiler service is every November.' }, base_rev: 1 } });
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'b', type: 'put', record: { ...record, body: 'The boiler service is every September.' }, base_rev: 1 }] } })).json();
  assert.equal(pushed.results[0].outcome, 'conflict');
  assert.equal(pushed.results[0].record.body, 'The boiler service is every November.', 'the phone learns the stored copy');
  const open = await (await che.call('/api/brain/conflicts', { token: che.token })).json();
  assert.equal(open.conflicts.length, 1);
  assert.equal(open.conflicts[0].incoming.body, 'The boiler service is every September.');
  const resolved = await (await che.call('/api/brain/conflicts/resolve', { method: 'POST', token: che.token, body: { id: open.conflicts[0].id, choice: 'incoming' } })).json();
  assert.equal(resolved.ok, true);
  const now = await (await che.call('/api/brain/record?id=note:x', { token: che.token })).json();
  assert.equal(now.body, 'The boiler service is every September.');
  assert.equal(now.rev, 3);
  const digest = (await (await che.call('/api/brain/status', { token: che.token })).json()).digest;
  const core = await (await che.call('/api/brain/record?id=che:core', { token: che.token })).json();
  assert.equal(digest.count, 2, 'the note and CHE herself');
  assert.equal(digest.sum, (fnv1a32('note:x:3') + fnv1a32(`che:core:${core.rev}`)) % 4294967296, 'the digest is the sum of id:rev hashes');
});

test('a memory deleted on the phone leaves CHE’s memory list and stays deleted through the next projection; an edit there changes its words here', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const record = { id: 'mem:22222222-2222-4222-8222-222222222222', kind: 'memory', region: 'Personal Memory', path: 'Family', title: 'Sister', body: 'My sister is called Ana.', verification: 'owner_attested', source: { kind: 'memory_record' } };
  await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'c1', type: 'put', record }], device: 'iphone' } });
  await che.call('/api/brain/changes?since=0', { token: che.token });
  const edited = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'c2', type: 'put', record: { ...record, body: 'My sister is called Ana and lives in Lisbon.' }, base_rev: (await (await che.call(`/api/brain/record?id=${record.id}`, { token: che.token })).json()).rev }], device: 'iphone' } })).json();
  assert.equal(edited.results[0].outcome, 'updated');
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, ['My sister is called Ana and lives in Lisbon.'], 'the edit reached the memory list');
  const deleted = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'c3', type: 'delete', id: record.id }], device: 'iphone' } })).json();
  assert.equal(deleted.results[0].outcome, 'deleted');
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, [], 'the deletion reached the memory list');
  assert.equal(state.memory_records.length, 0);
  const changes = await (await che.call('/api/brain/changes?since=0', { token: che.token })).json();
  const mine = changes.records.find((r) => r.id === record.id);
  assert.equal(mine.deleted, true, 'the projection after the delete does not bring it back');
  assert.equal((await (await che.call('/api/brain/search?q=ana%20lisbon', { token: che.token })).json()).hits.length, 0);
  const replay = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'c3', type: 'delete', id: record.id }], device: 'iphone' } })).json();
  assert.equal(replay.results[0].outcome, 'duplicate');
  assert.equal(replay.results[0].first_outcome, 'deleted');
});

test('a long memory saved on the phone stays whole in the Brain after the projection; the memory list shows its display copy', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const long = `Plan for the barbershop.\nOpen at nine.\n${'Detail sentence number. '.repeat(120)}fact399`;
  const record = { id: 'mem:33333333-3333-4333-8333-333333333333', kind: 'memory', region: 'Personal Memory', path: 'Business', title: 'Barbershop plan', body: long, verification: 'owner_attested', source: { kind: 'memory_record' } };
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'l1', type: 'put', record }], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'created');
  const changes = await (await che.call('/api/brain/changes?since=0', { token: che.token })).json();
  const mine = changes.records.find((r) => r.id === record.id);
  assert.equal(mine.body, long, 'the whole text comes back to the phone');
  assert.equal(mine.rev, 1);
  const state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories[0].length, 500, 'the memory list holds the display copy');
  assert.equal((await (await che.call('/api/brain/search?q=fact399', { token: che.token })).json()).hits.length, 1);
  const status = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(status.open_conflicts, 0);
  const again = await (await che.call(`/api/brain/record?id=${record.id}`, { token: che.token })).json();
  assert.equal(again.rev, 1, 'a second projection (status) changes nothing');
});

test('a twin the phone pushed under its own id is deleted by the Memory screen too, and "clear all" clears every memory record', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const text = `The warehouse routine: ${'count the courier bags, '.repeat(60)}then lock up.`;
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  const legacyId = state.memory_records[0].id;
  const whole = await (await che.call(`/api/brain/record?id=mem:${legacyId}`, { token: che.token })).json();
  assert.equal(whole.body, text, 'the Brain keeps the whole text of an online save');
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 't1', type: 'put', record: { id: 'mem:full', kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'Warehouse', body: text, verification: 'owner_attested', source: { kind: 'memory_record' } } }], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'created');
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1, 'no second row for the same words');
  assert.deepEqual(state.memory_records[0].brain_twins, ['mem:full']);
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0 } })).status, 200);
  assert.equal((await (await che.call('/api/brain/record?id=mem:full', { token: che.token })).json()).deleted, true, 'the twin is gone too');
  assert.equal((await (await che.call('/api/brain/search?q=warehouse%20routine%20courier', { token: che.token })).json()).hits.length, 0);
  await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 't2', type: 'put', record: { id: 'mem:only', kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'Only', body: 'Only on the phone, pushed later.', verification: 'owner_attested', source: { kind: 'memory_record' } } }], device: 'iphone' } });
  assert.equal((await che.call('/api/memory/clear', { method: 'POST', token: che.token, body: {} })).status, 200);
  const status = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(status.by_kind.memory ?? 0, 0, 'no live memory record survives clear all');
});

test('a flags-only amendment does not turn the phone\'s next edit into a conflict, and keeps the author', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const record = { id: 'mem:44444444-4444-4444-8444-444444444444', kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'Dog', body: 'My dog is called Rex.', verification: 'owner_attested', source: { kind: 'memory_record' } };
  await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'f1', type: 'put', record }], device: 'iphone' } });
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: 'My dog is called Max.' } });
  await che.call('/api/brain/changes?since=0', { token: che.token });
  const amended = await (await che.call(`/api/brain/record?id=${record.id}`, { token: che.token })).json();
  assert.equal(amended.origin, 'iphone', 'an amendment keeps the author');
  const edited = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'f2', type: 'put', record: { ...record, body: 'My dog was called Rex; he passed in 2025.' }, base_rev: 1 }], device: 'iphone' } })).json();
  assert.equal(edited.results[0].outcome, 'updated', 'not a conflict: the content had not changed since rev 1');
  const now = await (await che.call(`/api/brain/record?id=${record.id}`, { token: che.token })).json();
  assert.equal(now.body, 'My dog was called Rex; he passed in 2025.');
  assert.equal(now.source.content_rev, undefined, 'a content change clears the content marker');
});

test('a twin that differs only in letter case is deleted with its row, and a duplicate online add still reaches the Brain whole', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: 'My dog is called Rex.' } })).status, 200);
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'cc1', type: 'put', record: { id: 'mem:caseTwin', kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'dog', body: 'my dog is called rex.', verification: 'owner_attested', source: { kind: 'memory_record' } } }], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'created');
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  assert.deepEqual(state.memory_records[0].brain_twins, ['mem:caseTwin']);
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0 } })).status, 200);
  assert.equal((await (await che.call('/api/brain/record?id=mem:caseTwin', { token: che.token })).json()).deleted, true);
  assert.equal((await (await che.call('/api/brain/search?q=dog%20rex', { token: che.token })).json()).hits.length, 0);
  // The same first 500 characters, a different tail: the list keeps one row, the Brain the longer text.
  const head = 'The route to the shop: '.repeat(30);
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: `${head} ending one.` } });
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: `${head} ending two, with the new gate code left out.` } });
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  const row = state.memory_records[0];
  const whole = await (await che.call(`/api/brain/record?id=mem:${row.id}`, { token: che.token })).json();
  assert.match(whole.body, /ending one/, 'the first text stays whole under the row: nothing is overwritten');
  assert.equal(row.brain_twins?.length, 1, 'the second text is a twin of the row');
  const twin = await (await che.call(`/api/brain/record?id=${row.brain_twins[0]}`, { token: che.token })).json();
  assert.match(twin.body, /gate code left out/, 'the second text is whole under its own id');
  assert.equal((await (await che.call('/api/brain/search?q=gate%20code', { token: che.token })).json()).hits.length, 1);
  // A longer text that merely continues the first is an edit of the row, not a twin.
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: `${head} ending one. And the shop closes at six.` } });
  const extended = await (await che.call(`/api/brain/record?id=mem:${row.id}`, { token: che.token })).json();
  assert.match(extended.body, /closes at six/);
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0 } })).status, 200);
  assert.equal((await (await che.call(`/api/brain/record?id=${row.brain_twins[0]}`, { token: che.token })).json()).deleted, true, 'the row\'s delete reaches the twin');
  assert.equal((await (await che.call('/api/brain/search?q=route%20shop', { token: che.token })).json()).hits.length, 0);
});

test('a text whose 500th character is a space: two phone pushes, one row, and the row\'s delete reaches both', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const text = 'word '.repeat(150).trim();
  for (const [op, id] of [['w1', 'mem:p1'], ['w2', 'mem:p2']]) {
    const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: op, type: 'put', record: { id, kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'Words', body: text, verification: 'owner_attested', source: { kind: 'memory_record' } } }], device: 'iphone' } })).json();
    assert.equal(pushed.results[0].outcome, 'created');
  }
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1, 'one row for the same words');
  assert.deepEqual(state.memory_records[0].brain_twins, ['mem:p2']);
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0 } })).status, 200);
  for (const id of ['mem:p1', 'mem:p2']) {
    assert.equal((await (await che.call(`/api/brain/record?id=${id}`, { token: che.token })).json()).deleted, true, `${id} deleted`);
  }
  assert.equal((await (await che.call('/api/brain/search?q=word', { token: che.token })).json()).hits.length, 0);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memory_records.length, 0);
});

test('the Memory screen names a memory by position and words: a moved list never deletes a neighbour, missing words are a 404', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  for (const text of ['First memory.', 'Second memory.', 'Third memory.']) {
    assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  }
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, ['First memory.', 'Second memory.', 'Third memory.']);
  // The phone still shows an old list where "First memory." sat at index 1: the words win.
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 1, text: 'first memory.' } })).status, 200);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, ['Second memory.', 'Third memory.'], 'the named memory went, not the one that moved into its slot');
  // Words the list no longer has: nothing is deleted.
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0, text: 'First memory.' } })).status, 404);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 2);
  // Index alone (older phones) still works on the current list.
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 0 } })).status, 200);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, ['Third memory.']);
  assert.equal((await (await che.call('/api/brain/search?q=second', { token: che.token })).json()).hits.length, 0);
  assert.equal((await (await che.call('/api/brain/search?q=first', { token: che.token })).json()).hits.length, 0);
});

test('a delete pushed from the phone tombstones the row\'s twins too, and a clean memory is never refused for a word the 500-char window cuts', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const head = 'Directions to the gate: '.repeat(25);
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: `${head} ending one.` } });
  await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: `${head} ending two, with the code left out.` } });
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  const row = state.memory_records[0];
  assert.equal(row.brain_twins?.length, 1);
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'pd1', type: 'delete', id: `mem:${row.id}` }], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'deleted');
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 0);
  assert.equal((await (await che.call(`/api/brain/record?id=${row.brain_twins[0]}`, { token: che.token })).json()).deleted, true, 'the twin is gone too');
  assert.equal((await (await che.call('/api/brain/search?q=gate%20ending', { token: che.token })).json()).hits.length, 0);
  // A 540-character clean text whose collapsed 500th character cuts "pinnacle" after "pin".
  const filler = 'The hike was long and the view was worth every step of it. '.repeat(9); // 531 chars
  const text = `${filler.slice(0, 497)}pinnacle of the whole trip, and we came down before dark.`;
  assert.equal(text.replace(/\s+/g, ' ').trim().slice(497, 500), 'pin');
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1, 'the clean memory is on the Memory screen');
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: 'My card pin is 1234.' } })).status, 400, 'a real secret is still refused');
});

test('the phone\'s words reach the cloud whole: a multi-line memory is deleted by its raw excerpt, a clean long text is added from the phone, "clear all" without a body clears', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const multi = 'Line one about the boiler.\nLine two:   the valve sticks.';
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: multi } })).status, 200);
  // 495 characters of filler, then "x pinnacle": the collapsed 500th character cuts "pin" after a space.
  const long = `${'ab '.repeat(165)}x pinnacle of the whole trip, worth every step.`;
  assert.equal(long.slice(497, 500), 'pin');
  const pushed = await (await che.call('/api/brain/push', { method: 'POST', token: che.token, body: { ops: [{ op_id: 'px1', type: 'put', record: {
    id: 'mem:22222222-2222-4222-8222-222222222222', kind: 'memory', region: 'Personal Memory', path: 'Memory', title: 'Hike', body: long, verification: 'owner_attested', source: { kind: 'memory_record' },
  } }], device: 'iphone' } })).json();
  assert.equal(pushed.results[0].outcome, 'created');
  let state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 2, 'the pushed clean memory has a Memory-screen row');
  // A phone that loaded its list from the replica sends the raw excerpt (newlines kept) at a stale slot.
  assert.equal((await che.call('/api/memory/delete', { method: 'POST', token: che.token, body: { index: 5, text: multi } })).status, 200);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  assert.equal((await (await che.call('/api/brain/search?q=boiler', { token: che.token })).json()).hits.length, 0);
  // The phone's "clear all" sends no body at all.
  assert.equal((await che.call('/api/memory/clear', { method: 'POST', token: che.token })).status, 200);
  state = await (await che.call('/api/state', { token: che.token })).json();
  assert.deepEqual(state.memories, []);
  assert.equal((await (await che.call('/api/brain/search?q=pinnacle', { token: che.token })).json()).hits.length, 0);
});

test('a clean memory whose 160-character title cut ends on a word fragment still enters the Brain whole', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  // 202 clean characters; a hard 160-character title cut would end on "abc pin".
  const text = `${'ab '.repeat(51)}abc pinnacle of the whole trip, worth every step.`;
  assert.equal(text.slice(157, 160), 'pin');
  assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  const state = await (await che.call('/api/state', { token: che.token })).json();
  assert.equal(state.memories.length, 1);
  const record = await (await che.call(`/api/brain/record?id=mem:${state.memory_records[0].id}`, { token: che.token })).json();
  assert.equal(record.deleted, false, 'the Brain holds the memory the list shows');
  assert.equal(record.body, text);
  assert.ok(!/pin$/.test(record.title), `the title ends on a whole word: ${record.title}`);
  assert.equal((await (await che.call('/api/brain/search?q=pinnacle', { token: che.token })).json()).hits.length, 1);
});

test('rebuilding the review keeps every task in its worker\'s brain, and the recovery report route answers on a fresh store', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const fresh = await (await che.call('/api/brain/recovery', { token: che.token })).json();
  assert.equal(fresh.available, true);
  assert.match(fresh.note, /No recovery pass has run yet/);
  const created = await (await che.call('/api/team/create', { method: 'POST', token: che.token, body: { role: 'Product and listings', specialty: 'Listings and pricing' } })).json();
  const nova = created.partner;
  assert.equal(nova.name, 'Nova', 'the first internal worker hired is Nova');
  assert.equal((await che.call('/api/team/assign', { method: 'POST', token: che.token, body: { partner_id: nova.id, task: 'Write the Etsy listing for the brass lamp.' } })).status, 200);
  const before = await (await che.call('/api/brain/workers', { token: che.token })).json();
  const novaBefore = before.workers.find((w) => w.name === 'Nova');
  assert.equal(novaBefore.records >= 2, true, `her hub record and the task: ${JSON.stringify(novaBefore)}`);
  assert.equal(novaBefore.tasks.live, 1);
  const run = await (await che.call('/api/brain/review', { method: 'POST', token: che.token, body: { run: true } })).json();
  assert.ok(run.run);
  const after = await (await che.call('/api/brain/workers', { token: che.token })).json();
  const novaAfter = after.workers.find((w) => w.name === 'Nova');
  assert.equal(novaAfter.tasks.live, 1, 'the rebuild did not move her task out of her brain');
  assert.equal(novaAfter.records, novaBefore.records);
  const task = (await (await che.call('/api/brain/search?q=brass%20lamp', { token: che.token })).json()).hits[0];
  assert.ok(task);
  assert.equal(task.source.agent, 'Nova');
});

test('a sync pull carries the digest only on its last page, and that digest matches every page pulled', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  for (const text of ['The owner’s car is blue.', 'The owner’s dog is Rex.', 'The owner’s cat is Mia.']) {
    assert.equal((await che.call('/api/memory/add', { method: 'POST', token: che.token, body: { memory: text } })).status, 200);
  }
  let since = 0;
  let pages = 0;
  let pulled = 0;
  let last = null;
  for (;;) {
    const page = await (await che.call(`/api/brain/changes?since=${since}&limit=1`, { token: che.token })).json();
    pages += 1;
    pulled += page.records.length;
    since = page.next;
    if (!page.more) { last = page; break; }
    assert.equal(page.digest, undefined, 'a middle page skips the whole-table digest');
  }
  assert.ok(pages > 2, 'the pull really was paged');
  assert.equal(last.digest.count, pulled, 'the last page’s digest covers everything pulled');
});

test('a Brain status read does not re-run the legacy projection more than every ten minutes', async (t) => {
  const che = await owner();
  if (!che) return t.skip('node:sqlite unavailable');
  const first = await (await che.call('/api/brain/status', { token: che.token })).json();
  const at = first.legacy_projection?.at;
  assert.ok(at, 'the first status read projects');
  const second = await (await che.call('/api/brain/status', { token: che.token })).json();
  assert.equal(second.legacy_projection?.at, at, 'a second read within ten minutes reuses it');
});

test('when Cloudflare’s free daily allowance is used up, every stateful request says so with the reset time', async (t) => {
  const sql = await sqlFor();
  if (!sql) return t.skip('node:sqlite unavailable');
  const storage = storageFor(new Map(), sql);
  let refuse = '';
  const get = storage.get;
  storage.get = async (key) => { if (refuse) throw new Error(refuse); return get(key); };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path) => worker.fetch(new Request(`https://che.example${path}`), env);
  refuse = 'Exceeded allowed rows read in Durable Objects free tier.';
  for (const path of ['/api/commands', '/api/brain/status', '/health/engines']) {
    const res = await call(path);
    assert.equal(res.status, 503, path);
    const body = await res.json();
    assert.equal(body.category, 'cloud_daily_limit', path);
    assert.match(body.detail, /free daily allowance for rows read is used up/);
    assert.match(body.detail, /resets at 00:00 UTC/);
    assert.match(body.resets_at, /T00:00:00\.000Z$/);
    assert.ok(Number(res.headers.get('Retry-After')) > 0);
  }
  // Any other failure keeps the plain message and never claims a quota.
  refuse = 'SQLITE_BUSY: database is locked';
  const other = await (await call('/api/commands')).json();
  assert.notEqual(other.category, 'cloud_daily_limit');
  assert.doesNotMatch(other.detail, /allowance/);
  // A refusal of the Durable Object call itself (outside the object's catch) is answered the same way.
  const refused = { fetch: async () => { throw new Error('Exceeded allowed duration in Durable Objects free tier.'); } };
  const outside = await worker.fetch(new Request('https://che.example/health/engines'), { ...env, CHE_STATE: { getByName: () => refused } });
  assert.equal(outside.status, 503);
  const outsideBody = await outside.json();
  assert.equal(outsideBody.category, 'cloud_daily_limit');
  assert.match(outsideBody.detail, /allowance for compute time is used up/);
  // Anything else still surfaces as Cloudflare's own error, unchanged.
  const broken = { fetch: async () => { throw new Error('Network connection lost.'); } };
  await assert.rejects(worker.fetch(new Request('https://che.example/health/engines'), { ...env, CHE_STATE: { getByName: () => broken } }), /Network connection lost/);
});
