import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CODING_PAID_USD, validateMonthlyCap, paidGate } from './che_coding_paid_gate.mjs';

const verified = { data: { limit: 15, limit_reset: 'monthly', limit_remaining: 4.25, include_byok_in_limit: true, is_management_key: false } };

test('coded paid cap is $15/month and does not authorize paid usage by itself', () => {
  assert.equal(MAX_CODING_PAID_USD, 15);
  assert.equal(validateMonthlyCap(verified).ok, true);
});
test('refuse uncapped, larger, wrong reset, BYOK-excluded, exhausted and privileged keys', () => {
  for (const key of [
    { ...verified.data, limit: null },
    { ...verified.data, limit: 20 },
    { ...verified.data, limit: 15.01 },
    { ...verified.data, limit_reset: 'daily' },
    { ...verified.data, include_byok_in_limit: false },
    { ...verified.data, limit_remaining: 0 },
    { ...verified.data, is_management_key: true },
  ]) assert.equal(validateMonthlyCap({ data: key }).ok, false);
});
test('no approval means no request, even if paid key exists', async () => {
  let calls = 0;
  const result = await paidGate({
    env: { CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder' },
    fetcher: async () => { calls++; return { ok: true, json: async () => verified }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
test('when approved, verify key cap using API before paid request', async () => {
  let inspected = '';
  const result = await paidGate({
    env: { CHE_CODING_PAID_FALLBACK: 'true', CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder' },
    fetcher: async (url) => {
      inspected = url;
      return { ok: true, json: async () => verified };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(inspected, 'https://openrouter.ai/api/v1/key');
});
test('unreachable key verification fails closed', async () => {
  const result = await paidGate({
    env: { CHE_CODING_PAID_FALLBACK: 'true', CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder' },
    fetcher: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, false);
});
