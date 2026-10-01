import assert from 'node:assert/strict';
import test from 'node:test';

import { addOwnerMemory } from './research_memory.js';

test('owner memories keep provenance, verification time and supersession history', () => {
  const data = { memories: [], memory_records: [] };
  const first = addOwnerMemory(data, 'My favorite drink is Sprite', {
    source: 'owner_chat',
    scope: 'owner',
    confidence: 1,
  });
  assert.equal(first.added, true);
  assert.equal(data.memory_records.length, 1);
  assert.equal(data.memory_records[0].source, 'owner_chat');
  assert.equal(data.memory_records[0].scope, 'owner');
  assert.equal(data.memory_records[0].confidence, 1);
  assert.ok(Date.parse(data.memory_records[0].created_at) > 0);
  assert.ok(Date.parse(data.memory_records[0].last_verified_at) > 0);

  const second = addOwnerMemory(data, 'My favorite drink is ginger ale', {
    source: 'owner_chat',
  });
  assert.equal(second.added, true);
  assert.deepEqual(data.memories, ['My favorite drink is ginger ale']);
  assert.equal(data.memory_records.length, 2);
  assert.equal(data.memory_records[0].active, false);
  assert.equal(data.memory_records[0].superseded_by, 'My favorite drink is ginger ale');
  assert.equal(data.memory_records[1].active, true);
});
