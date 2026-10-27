import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_LEDGER_PATH, aiModelStatus, readModelLedger, workerKeyPresence } from './model_status.js';
import { attemptReceipt } from './coding_failover.mjs';
import { mergeLedger, providerVerdict } from './model_router.mjs';

const ENV = { CHE_GITHUB_TOKEN: 'ghs_faketokenfaketokenfake', CHE_GITHUB_REPO: 'o/r', OPENROUTER_API_KEY: 'sk-or-v1-realvaluerealvalue', XAI_API_KEY: '' };
const NOW = Date.parse('2026-10-27T12:00:00Z');

function memoryStorage() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => { map.set(k, v); }, map };
}

const LEDGER = mergeLedger(null, {
  session_id: 'ocr-0000beef', state: 'pr_open', completed_by_model: 'openrouter/qwen/qwen3-coder:free',
  attempts: [attemptReceipt({ model: 'openrouter/qwen/qwen3-coder:free', exitCode: 0, seconds: 90, capSeconds: 420, progress: 'delivered', coverage: 'free' })],
  routing: { verdicts: { openrouter: providerVerdict('openrouter', { evidence: { key_present: true, auth: { ok: true, status: 200 }, openrouter_key: { is_free_tier: true, usage: 0 } }, now: NOW }) } },
  billing: { openrouter: { usage_before: 0, usage_after: 0, delta_usd: 0, verified: true } },
}, NOW);

const ledgerFetch = (calls) => async (url) => {
  calls.push(url);
  return { ok: true, status: 200, json: async () => ({ content: btoa(JSON.stringify(LEDGER)) }) };
};

test('the status reads the runner ledger on che-mailbox and shows only verified facts', async () => {
  const calls = [];
  const view = await aiModelStatus(ENV, memoryStorage(), { fetcher: ledgerFetch(calls), now: NOW + 60_000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`/repos/o/r/contents/${MODEL_LEDGER_PATH.replaceAll('/', '\\/')}\\?ref=che-mailbox$`));
  assert.equal(view.ledger_source, 'che-mailbox');
  assert.equal(view.authorized_spend_usd, 0);
  const or = view.providers.find((p) => p.id === 'openrouter');
  assert.equal(or.connected, 'verified');
  assert.equal(or.usage, 'free');
  assert.equal(or.current_model, 'openrouter/qwen/qwen3-coder:free');
  assert.equal(or.requests_completed, 1);
  assert.equal(or.billed_usd_verified, 0);
  assert.equal(or.worker_key_present, true);
  assert.match(view.spoken, /finished by openrouter\/qwen\/qwen3-coder:free/);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /realvalue|faketoken/, 'no key or token value reaches the app');
});

test('the status is cached for five minutes, so the Keys tab does not wait on GitHub every time', async () => {
  const calls = [];
  const storage = memoryStorage();
  await aiModelStatus(ENV, storage, { fetcher: ledgerFetch(calls), now: NOW });
  await aiModelStatus(ENV, storage, { fetcher: ledgerFetch(calls), now: NOW + 4 * 60_000 });
  assert.equal(calls.length, 1);
  await aiModelStatus(ENV, storage, { fetcher: ledgerFetch(calls), now: NOW + 6 * 60_000 });
  assert.equal(calls.length, 2);
});

test('no ledger yet, GitHub down or slow: every provider is shown blocked and unverified, never invented', async () => {
  const missing = await readModelLedger(ENV, { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(missing.source, 'none_yet');
  const down = await aiModelStatus(ENV, memoryStorage(), { fetcher: async () => ({ ok: false, status: 502, json: async () => ({}) }), now: NOW });
  assert.equal(down.ledger_source, 'unavailable');
  assert.ok(down.providers.every((p) => p.usage === 'blocked' && p.connected !== 'verified' && p.remaining_allowance_usd === null));
  const slow = await readModelLedger(ENV, { fetcher: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(slow.source, 'unavailable');
  const unconfigured = await aiModelStatus({}, memoryStorage(), { now: NOW });
  assert.equal(unconfigured.ledger_source, 'unavailable');
  assert.match(unconfigured.spoken, /No provider is verified at no cost for coding yet/);
});

test('worker key presence is true or false only', () => {
  const keys = workerKeyPresence({ ...ENV, CHE_OPENAI_API_KEY: 'sk-abc' });
  assert.equal(keys.openrouter, true);
  assert.equal(keys.openai, true);
  assert.equal(keys.xai, false);
  assert.ok(Object.values(keys).every((v) => typeof v === 'boolean'));
});
