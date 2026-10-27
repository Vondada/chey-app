// Provider evidence: each of the four facts is separate, and only a completed, checksummed render says "rendered".
import assert from 'node:assert/strict';
import test from 'node:test';
import { providerState, trustedProviders } from './provider_evidence.js';

const SHA = 'a'.repeat(64);
const full = {
  credential_present: true,
  authenticated_at: '2026-10-27T10:00:00Z',
  gpu: { name: 'Tesla T4', allocated_at: '2026-10-27T10:01:00Z' },
  render: { job_id: 'job_1', status: 'complete', sha256: SHA, seconds: 42, output: 'clip.mp4' },
};

test('no evidence means not configured; a saved key alone is credential_only, never connected', () => {
  assert.equal(providerState({}).state, 'not_configured');
  const keyOnly = providerState({ credential_present: true });
  assert.equal(keyOnly.state, 'credential_only');
  assert.equal(keyOnly.authenticated, false);
  assert.match(keyOnly.say, /not been checked/);
});

test('an accepted key is authenticated, but without a GPU it is not gpu_allocated', () => {
  const s = providerState({ credential_present: true, authenticated_at: full.authenticated_at });
  assert.equal(s.state, 'authenticated');
  assert.equal(s.gpu_allocated, false);
});

test('a GPU name is required for gpu_allocated; a generic word is not enough', () => {
  const noName = providerState({ ...full, gpu: { name: 'worker', allocated_at: full.gpu.allocated_at }, render: {} });
  assert.equal(noName.gpu_allocated, false);
  assert.equal(noName.state, 'authenticated');
  assert.equal(providerState({ ...full, render: {} }).state, 'gpu_allocated');
});

test('rendered needs a completed job with an output, a 64-hex SHA-256 and a positive duration', () => {
  assert.equal(providerState(full).state, 'rendered');
  assert.equal(providerState({ ...full, render: { ...full.render, status: 'running' } }).rendered, false);
  assert.equal(providerState({ ...full, render: { ...full.render, sha256: 'not-a-hash' } }).rendered, false);
  assert.equal(providerState({ ...full, render: { ...full.render, seconds: 0 } }).rendered, false);
  assert.equal(providerState({ ...full, render: { ...full.render, output: '' } }).rendered, false);
});

test('a render without an authenticated key or a GPU does not count as rendered', () => {
  assert.equal(providerState({ credential_present: true, render: full.render }).rendered, false);
  assert.equal(providerState({ ...full, gpu: { name: '', allocated_at: full.gpu.allocated_at } }).rendered, false);
});

test('trustedProviders orders by evidence and drops providers with no key', () => {
  const list = trustedProviders([
    { id: 'modal', evidence: { credential_present: true, authenticated_at: full.authenticated_at } },
    { id: 'kaggle', evidence: full },
    { id: 'hf', evidence: {} },
  ]);
  assert.deepEqual(list.map((p) => p.id), ['kaggle', 'modal']);
  assert.equal(list[0].state, 'rendered');
});
