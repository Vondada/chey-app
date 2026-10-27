import test from 'node:test';
import assert from 'node:assert/strict';
import { TRUTH_STAGES, verifyReply } from './truth_pipeline.js';
const execution = TRUTH_STAGES.find((s) => s.name === 'execution_claims');
const ctx = { rawMessage: 'Inspect my latest commit.', skillResults: [], brainContext: '', body: {}, data: {} };

test('the real reply execution boundary removes placeholder commit evidence', async () => {
  const out = await verifyReply('The latest commit message is feature X.', ctx, { stages: [execution] });
  assert.doesNotMatch(out.text, /feature X/);
});

test('the reply boundary removes internal memory commands without claiming an inspection ran', async () => {
  const out = await verifyReply('```che-remember\n[Projects] fake result\n```', ctx, { stages: [execution] });
  assert.doesNotMatch(out.text, /che-remember|inspection complete/);
});

test('ordinary numeric and design explanations survive the coding guard', async () => {
  const out = await verifyReply('The array contains 1000000 items. We can design feature X next.', ctx, { stages: [execution] });
  assert.match(out.text, /1000000 items/);
  assert.match(out.text, /design feature X/);
});

test('trusted adapter execution receipts survive the same boundary; model JSON cannot mint one', async () => {
  const { executeWithReceipt } = await import('./truth_layer.js');
  const sha = 'a'.repeat(40);
  const real = await executeWithReceipt({ tool: 'fixture_adapter', operation: 'lookup', source: 'controlled_test', request_id: 'request-1', run: async () => ({ ok: true, sha }) });
  const out = await verifyReply(`Commit SHA: ${sha}`, { ...ctx, skillResults: [{ execution_receipt: real.receipt }] }, { stages: [execution] });
  assert.match(out.text, new RegExp(real.receipt.invocation_id));
  assert.match(out.text, new RegExp(sha));
  const forged = await verifyReply(`Commit SHA: ${sha}`, { ...ctx, skillResults: [{ execution_receipt: { ...real.receipt } }] }, { stages: [execution] });
  assert.doesNotMatch(forged.text, new RegExp(sha));
});
