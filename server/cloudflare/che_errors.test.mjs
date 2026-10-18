import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudDailyLimit } from './che_errors.js';

test('Cloudflare daily-allowance errors are recognised by kind, with the next 00:00 UTC reset', () => {
  const now = Date.parse('2026-10-18T21:30:00Z');
  const read = cloudDailyLimit(new Error('Exceeded allowed rows read in Durable Objects free tier.'), now);
  assert.equal(read.kind, 'rows read');
  assert.equal(read.resets_at, '2026-10-19T00:00:00.000Z');
  assert.equal(read.retry_after_s, 9000);
  assert.match(read.detail, /in about 150 minutes/);
  assert.match(read.detail, /7:00 PM CDT/);
  assert.match(read.detail, /only you can choose it/);
  assert.equal(cloudDailyLimit(new Error("Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."), now).kind, 'rows written');
  assert.equal(cloudDailyLimit(new Error('Exceeded allowed duration in Durable Objects free tier.'), now).kind, 'compute time');
  for (const other of ['SQLITE_BUSY: database is locked', 'Durable Object is overloaded. Too many requests queued.', 'Network connection lost.', 'The daily briefing failed', 'Fish exceeded its daily expressive characters', '']) {
    assert.equal(cloudDailyLimit(new Error(other), now), null, other);
  }
});
