import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CODING_PAID_USD, validateMonthlyCap, paidGate, keyStatusSummary } from './che_coding_paid_gate.mjs';

// The owner's real key today: cap set, monthly reset, BYOK not counted, nothing spent.
const verified = { data: { limit: 15, limit_reset: 'monthly', limit_remaining: 15, include_byok_in_limit: false, is_provisioning_key: false, is_management_key: false, byok_usage_monthly: 0 } };
const CONFIRMED = { byokConfirmedNone: true };

test('the cap is $15/month, and a key with BYOK counted in its limit needs nothing else', () => {
  assert.equal(MAX_CODING_PAID_USD, 15);
  assert.deepEqual(validateMonthlyCap({ data: { ...verified.data, include_byok_in_limit: true } }), { ok: true, limit: 15, remaining: 15, byok: 'counted_in_cap' });
});

test('without BYOK counted in the limit, paid needs the owner-confirmed no-BYOK account', () => {
  const blocked = validateMonthlyCap(verified);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /CHE_CODING_OPENROUTER_NO_BYOK/);
  const allowed = validateMonthlyCap(verified, MAX_CODING_PAID_USD, CONFIRMED);
  assert.deepEqual(allowed, { ok: true, limit: 15, remaining: 15, byok: 'confirmed_none' });
});

test('the live tripwire blocks paid use when this key has BYOK spend, even when the owner confirmed none', () => {
  const spent = { data: { ...verified.data, byok_usage_monthly: 0.42 } };
  const verdict = validateMonthlyCap(spent, MAX_CODING_PAID_USD, CONFIRMED);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /exactly zero BYOK spend/);
});

test('absent or malformed BYOK usage cannot bypass the owner-confirmed zero-spend tripwire', () => {
  const { byok_usage_monthly: _omitted, include_byok_in_limit: _flag, ...sparse } = verified.data;
  assert.equal(validateMonthlyCap({ data: sparse }, MAX_CODING_PAID_USD, CONFIRMED).ok, false);
  assert.equal(validateMonthlyCap({ data: sparse }).ok, false);
  assert.equal(validateMonthlyCap({ data: { ...verified.data, byok_usage_monthly: '0' } }, MAX_CODING_PAID_USD, CONFIRMED).ok, false);
  assert.equal(validateMonthlyCap({ data: { ...verified.data, byok_usage_monthly: -1 } }, MAX_CODING_PAID_USD, CONFIRMED).ok, false);
});

test('refuse uncapped, larger, wrong reset, exhausted, low-balance and privileged keys, even when BYOK is confirmed', () => {
  for (const key of [
    { ...verified.data, limit: null },
    { ...verified.data, limit: 20 },
    { ...verified.data, limit: 15.01 },
    { ...verified.data, limit: 0 },
    { ...verified.data, limit_reset: 'daily' },
    { ...verified.data, limit_reset: null },
    { ...verified.data, limit_remaining: 0 },
    { ...verified.data, limit_remaining: 0.2 },
    { ...verified.data, limit_remaining: null },
    { ...verified.data, is_management_key: true },
    { ...verified.data, is_provisioning_key: true },
  ]) assert.equal(validateMonthlyCap({ data: key }, MAX_CODING_PAID_USD, CONFIRMED).ok, false, JSON.stringify(key));
});

test('the status summary carries field names and numbers only, never a label or key text', () => {
  const summary = keyStatusSummary({ data: { ...verified.data, label: 'sk-or-v1-secretlabel', name: 'secret text' } });
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
  assert.equal(summary.values.limit, 15);
  assert.equal(summary.values.limit_reset, 'monthly');
  assert.equal(summary.values.include_byok_in_limit, false);
  assert.ok(summary.fields.includes('label'), 'field names are reported');
});

test('no approval means no request, even if paid key exists', async () => {
  let calls = 0;
  const result = await paidGate({
    env: { CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder', CHE_CODING_OPENROUTER_NO_BYOK: 'true' },
    fetcher: async () => { calls++; return { ok: true, json: async () => verified }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('when approved, the cap is read from the provider API before any paid request, and the owner confirmation is applied', async () => {
  let inspected = '';
  const result = await paidGate({
    env: { CHE_CODING_PAID_FALLBACK: 'true', CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder', CHE_CODING_OPENROUTER_NO_BYOK: 'true' },
    fetcher: async (url) => {
      inspected = url;
      return { ok: true, json: async () => verified };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.byok, 'confirmed_none');
  assert.equal(inspected, 'https://openrouter.ai/api/v1/key');
});

test('without the owner confirmation, an otherwise valid key is still blocked', async () => {
  const result = await paidGate({
    env: { CHE_CODING_PAID_FALLBACK: 'true', CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder' },
    fetcher: async () => ({ ok: true, json: async () => verified }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /BYOK is ruled out/);
});

test('unreachable key verification fails closed', async () => {
  const result = await paidGate({
    env: { CHE_CODING_PAID_FALLBACK: 'true', CHE_CODING_OPENROUTER_PAID_KEY: 'placeholder', CHE_CODING_OPENROUTER_NO_BYOK: 'true' },
    fetcher: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, false);
});

test('run as a script from a path with special characters, the check still runs and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate #?% '));
  const dir = join(root, 'tools');
  mkdirSync(dir, { recursive: true });
  copyFileSync(new URL('./che_coding_paid_gate.mjs', import.meta.url), join(dir, 'che_coding_paid_gate.mjs'));
  writeFileSync(join(root, 'marker'), '');
  const result = spawnSync(process.execPath, [join(dir, 'che_coding_paid_gate.mjs')], {
    env: { PATH: process.env.PATH, CHE_CODING_PAID_FALLBACK: 'false' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, 'a blocked check exits non-zero; it never reads as a pass');
  assert.match(result.stderr, /Paid coding fallback blocked/);
});

test('the script is not run when merely imported, so tests stay offline', () => {
  const out = execFileSync(process.execPath, ['-e', "import('./che_coding_paid_gate.mjs').then(m => console.log(typeof m.paidGate))"], {
    cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8',
  });
  assert.equal(out.trim(), 'function');
});
