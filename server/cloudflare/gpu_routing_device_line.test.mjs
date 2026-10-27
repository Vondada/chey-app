import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineDeviceLine } from './creation_studio.js';

// Owner report (2026-10-25): the character screen said "No GPU is connected" while Modal's T4 was connected. The device
// line must name Modal's real state (compute_pool.providerStatuses), and never claim a GPU that is not there.

const CPU_ONLY = { online: false, gpu: null, automatic: true, modal: null };

test('Modal ready: the device line names Modal and does not say no GPU is connected', () => {
  const line = engineDeviceLine({ ...CPU_ONLY, modal: { status: 'ready', gpu: 'NVIDIA T4', reason: '' } });
  assert.equal(line, 'A GPU is ready on Modal: NVIDIA T4. It builds the next model.');
  assert.doesNotMatch(line, /No GPU is connected/);
});

test('Modal connected but unverified: says so instead of calling it ready', () => {
  const line = engineDeviceLine({ ...CPU_ONLY, modal: { status: 'unverified', gpu: 'NVIDIA T4', reason: 'Connected, not yet proven with a character' } });
  assert.match(line, /has not built a character yet, so it is not proven/);
  assert.doesNotMatch(line, /A GPU is ready/);
});

test('Modal held by the owner\'s credit policy: the device line gives the real reason', () => {
  const reason = 'Using Modal\'s included credit is off. Say "use Modal\'s free credit" to allow it.';
  const line = engineDeviceLine({ ...CPU_ONLY, modal: { status: 'offline', gpu: 'NVIDIA T4', reason } });
  assert.equal(line, `Modal's NVIDIA T4 is connected but not used yet. ${reason}`);
  assert.doesNotMatch(line, /No GPU is connected/);
});

test('no Modal and no Colab: the Colab wording stays as it was', () => {
  const line = engineDeviceLine({ ...CPU_ONLY, modal: null, online: true });
  assert.match(line, /No GPU is connected: your Colab GPU notebook is not open/);
});
