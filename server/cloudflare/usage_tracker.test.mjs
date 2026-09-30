import test from 'node:test';
import assert from 'node:assert/strict';
import { addTokens, usageReport, usageIntent, speakUsage } from './usage_tracker.js';

function store() { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) }; }

test('tracks tokens by day/week/month/year', async () => {
  const s = store();
  const now = Date.parse('2026-09-30T12:00:00Z');
  await addTokens(s, 1000, now);
  await addTokens(s, 500, now);
  await addTokens(s, 2000, Date.parse('2026-09-25T12:00:00Z')); // 5 days ago
  await addTokens(s, 4000, Date.parse('2026-09-01T12:00:00Z')); // ~29 days ago
  const r = await usageReport(s, now);
  assert.equal(r.today, 1500);
  assert.equal(r.week, 3500);      // today + 5-days-ago
  assert.equal(r.month, 7500);     // + ~29-days-ago
  assert.match(speakUsage(r, 'today'), /1,500 tokens today/);
});

test('usage intent scopes', () => {
  assert.equal(usageIntent('how many tokens today').scope, 'today');
  assert.equal(usageIntent('how much have you used this month').scope, 'month');
  assert.equal(usageIntent("what's my token usage").scope, 'all');
  assert.equal(usageIntent('good afternoon'), null);
});
