import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modalKeyRow } from './modal_gpu.js';
import { KEY_PROVIDERS, MODAL_PASTE_REFUSAL, saveKey } from './resilience.js';

// Owner report (2026-10-25): the Keys screen asked for a second Modal key, although Modal is already connected through
// the CHE Modal deploy workflow. These tests pin the row, the paste refusal, the setup text and the Worker wiring.

test('the Modal row is read-only, has no key to paste, and never carries a secret value', () => {
  const row = modalKeyRow({ exists: true, page: 'https://modal.com/settings' });
  assert.equal(row.readonly, true);
  assert.equal(row.check, 'modal');
  assert.equal(row.status, 'not tried yet');
  assert.equal(row.last4, '');
  assert.doesNotMatch(JSON.stringify(row), /ak-|as-|bearer:|wk-|ws-/);
});

test('with no stored credential the row says Modal is not set up, still with nothing to paste', () => {
  const row = modalKeyRow({ exists: false });
  assert.equal(row.status, 'not set up');
  assert.match(row.detail, /nothing to paste/);
});

test('a paste is refused in words that point to Check Connection, before anything is stored', async () => {
  let wrote = false;
  const storage = { get: async () => undefined, put: async () => { wrote = true; }, delete: async () => { wrote = true; } };
  const r = await saveKey(storage, 'modal', 'wk-ID:ws-SECRET@https://vondada--che-gpu.us-east.modal.run');
  assert.equal(r.ok, false);
  assert.equal(r.detail, MODAL_PASTE_REFUSAL);
  assert.equal(wrote, false);
  assert.match(MODAL_PASTE_REFUSAL, /deploy workflow/);
  assert.match(MODAL_PASTE_REFUSAL, /Check Connection/);
  assert.doesNotMatch(MODAL_PASTE_REFUSAL, /Proxy Auth|paste as/i);
});

test('the setup text no longer asks for a second Proxy Auth Token', () => {
  const accounts = KEY_PROVIDERS.modal.accounts;
  assert.doesNotMatch(accounts, /Proxy Auth|wk-ID|paste as/i);
  assert.match(accounts, /deploy workflow/);
  assert.match(accounts, /Check Connection/);
});

test('the Worker lists Modal from the row builder, refuses a paste, and no longer lists Modal as a pasteable key', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /from '\.\/modal_gpu\.js'/);
  assert.match(worker, /filter\(\(\[id\]\) => id !== 'modal'\)/);
  assert.match(worker, /await modalKeyRowFor\(this\.keyEnv \|\| this\.env, this\.ctx\.storage\)/);
});
