import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCodingEvidence, VALID_SHA } from './truth_layer.js';

test('rejects truncated or invalid SHA', () => {
  const bad = validateCodingEvidence('Latest commit is d4c29d9f1d7e4e4e4e4e4e4e');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_sha');
});

test('rejects placeholder commit messages', () => {
  const bad = validateCodingEvidence('Commit: feature X');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'placeholder_message');
});

test('accepts a real 40-char SHA and strips che-remember', () => {
  const real = '011d8aa22d393c18def1450dae5e6d051ec631b0';
  assert.ok(VALID_SHA.test(real));
  const out = validateCodingEvidence(`Main is at ${real}\n\`\`\`che-remember\n[Projects] CHE\n\`\`\``);
  assert.equal(out.ok, true);
  assert.ok(!out.text.includes('che-remember'));
  assert.ok(out.text.includes(real));
});
