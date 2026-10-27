import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_PROBE_OBJECT, probeObjectName, isMemoryProbeObject } from './probe_identity.js';

test('rotated deployment tokens use a fresh isolated object instead of a stale captured pairing environment', async () => {
  const old = await probeObjectName('controlled-old-probe-token');
  const fresh = await probeObjectName('controlled-new-probe-token');
  assert.notEqual(old, fresh);
  assert.equal(await probeObjectName('controlled-new-probe-token'), fresh, 'memory, commands and Atlas share this run');
  const objects = new Map([[MEMORY_PROBE_OBJECT, { pairing: 'old-code' }], [old, { pairing: 'old-code' }]]);
  if (!objects.has(fresh)) objects.set(fresh, { pairing: 'new-code' });
  assert.equal(objects.get(fresh).pairing, 'new-code');
  assert.equal(objects.get(old).pairing, 'old-code', 'other runs are not mutated');
  assert.ok(!fresh.includes('controlled-new-probe-token'));
});

test('reset authority accepts only exact isolated identities and never owner or prefix lookalikes', async () => {
  assert.ok(isMemoryProbeObject(MEMORY_PROBE_OBJECT));
  assert.ok(isMemoryProbeObject(await probeObjectName('fixture')));
  for (const name of ['owner', '', null, 'memory-truth-probe-owner', 'memory-truth-probe-' + 'a'.repeat(33), 'owner-memory-truth-probe']) assert.equal(isMemoryProbeObject(name), false);
  await assert.rejects(probeObjectName(''));
});
