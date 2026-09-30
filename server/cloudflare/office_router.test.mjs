import assert from 'node:assert/strict';
import test from 'node:test';
import { codexWorkPacket } from './office_router.js';

test('each agent gets its own Codex thread and no credential in the packet', () => {
  const knox = codexWorkPacket({ name: 'Knox', role: 'Engineering' }, { id: 't1', job_id: 'g1', task: 'Add tests' });
  const nova = codexWorkPacket({ name: 'Nova', role: 'Product' }, { id: 't2', job_id: 'g1', task: 'Draft listing' });
  assert.equal(knox.thread_id, 'office/knox/g1');
  assert.equal(nova.thread_id, 'office/nova/g1');
  assert.equal(knox.workspace, 'office/knox');
  assert.equal(knox.report_to, 'che');
  assert.ok(!/sk-|token|key/i.test(JSON.stringify(knox).replace('owner_codex', '')));
});
