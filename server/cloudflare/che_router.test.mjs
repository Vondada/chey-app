import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnerToCheOnly, grokRequest } from './che_router.js';

test('owner messages must target CHE', () => {
  assert.deepEqual(assertOwnerToCheOnly({}), { speaker: 'owner', target: 'che' });
  assert.deepEqual(assertOwnerToCheOnly({ from: 'owner', to: 'CHE' }), { speaker: 'owner', target: 'che' });
  assert.throws(() => assertOwnerToCheOnly({ from: 'owner', to: 'knox' }), { message: 'owner_talks_to_che_only', status: 403 });
});

test('agents cannot message the owner', () => {
  for (const agent of ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra']) {
    assert.throws(() => assertOwnerToCheOnly({ from: agent, to: 'owner' }), { message: 'agents_report_to_che_only' });
  }
  assert.deepEqual(assertOwnerToCheOnly({ from: 'mira', to: 'che' }), { speaker: 'mira', target: 'che' });
  assert.throws(() => assertOwnerToCheOnly({ from: 'stranger', to: 'che' }), { message: 'unknown_speaker' });
});

test('Grok requests carry router che, agent_id and the job thread', () => {
  const r = grokRequest({ agentId: 'Atlas', jobId: 'j9', prompt: 'Research Houston' });
  assert.equal(r.router, 'che');
  assert.equal(r.agent_id, 'atlas');
  assert.equal(r.job_id, 'j9');
  assert.equal(r.thread_id, 'office/atlas/j9');
  assert.throws(() => grokRequest({ agentId: 'che', prompt: 'x' }), { message: 'unknown_agent', status: 400 });
});
