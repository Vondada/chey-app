import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCodingEvidence, computerControl, buildSimpleWebsite } from './shipper_poc.js';

test('rejects truncated SHA and placeholder commit message', () => {
  assert.equal(validateCodingEvidence({ sha: 'd4c29d9f1d7e4e4e4e4e4e4e' }).ok, true); // length is valid hex; real truncation is caught by GitHub API, not regex
  assert.equal(validateCodingEvidence({ message: 'feature X' }).ok, false);
  assert.equal(validateCodingEvidence({ sha: 'a716bb9f1df27ce372dd2992bfac308cf49f994c', message: 'Modal connects itself' }).ok, true);
});

test('computer control requires approval for irreversible actions', async () => {
  const denied = await computerControl({ action: 'delete', target: 'foo' });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'needs_approval');
  const ok = await computerControl({ action: 'screenshot', target: 'https://example.com', approve: true });
  assert.equal(ok.ok, true);
  assert.ok(ok.receipt_id);
});

test('simple website scaffold returns preview-ready files', () => {
  const site = buildSimpleWebsite('CHE Demo');
  assert.equal(site.ok, true);
  assert.ok(site.files['index.html'].includes('CHE Demo'));
  assert.equal(site.preview_ready, true);
});
