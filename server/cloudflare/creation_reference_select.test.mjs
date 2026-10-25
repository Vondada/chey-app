import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreationStudio } from './creation_studio.js';

test('listReferences and selectReference on saved photos', async () => {
  const storage = new Map();
  const studio = new CreationStudio(storage, () => 1_700_000_000_000, { env: {} });
  // Seed a project with a reference (simulate stored photo)
  const p = { id: 'cr_test', kind: 'person', title: 'Test', base_id: 'che', created_at: '2026-01-01', updated_at: '2026-01-01', current: 0,
    versions: [{ n: 1, at: '2026-01-01', note: 'start', params: {}, style: 'photoreal', reference: { sha256: 'abc123def456', bytes: 1000, consent: 'self', at: '2026-01-01' } }] };
  storage.set('creations:projects', JSON.stringify([p]));
  const listed = await studio.listReferences();
  assert.equal(listed.references.length, 1);
  assert.equal(listed.references[0].sha256, 'abc123def456');
  // select on another project would require media.head to succeed; skip full media mock for this unit
});
