import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDay, nightlyContext, parseReview, runNightlyReview } from './nightly.js';

function store(entries) {
  const m = new Map(Object.entries(entries));
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
}

const logs = {
  log_index: [{ id: 'a', updated_at: '2026-09-28T23:00:00Z' }, { id: 'old', updated_at: '2026-09-01T00:00:00Z' }],
  'log:a': { title: 'Store', turns: [
    { at: '2026-09-27T10:00:00Z', user: 'yesterday', che: 'x' },
    { at: '2026-09-28T20:00:00Z', user: 'Set up Stripe', che: 'Done: account active', error: false },
    { at: '2026-09-28T21:00:00Z', user: 'You there?', che: '', error: true },
  ] },
  'log:old': { turns: [{ at: '2026-09-01T00:00:00Z', user: 'ancient', che: 'x' }] },
};

test('collects only today’s turns and counts failures', async () => {
  const day = await collectDay(store(logs), '2026-09-28T00:00:00Z');
  assert.equal(day.turns, 2);
  assert.equal(day.failures, 1);
  assert.match(day.text, /Set up Stripe/);
  assert.doesNotMatch(day.text, /yesterday|ancient/);
});

test('review is saved as notes and lessons feed tomorrow’s context', async () => {
  const data = { last_nightly_at: '2026-09-28T00:00:00Z', learned_knowledge: [] };
  const env = { AI: { run: async () => ({ response: JSON.stringify({
    summary: 'Owner set up Stripe. One answer failed.',
    lessons: ['Never invent plugins.'],
    open_threads: ['Add Stripe key'],
    stated_preferences: [],
  }) }) } };
  const result = await runNightlyReview(env, store(logs), data, 'm', Date.parse('2026-09-29T07:07:00Z'));
  assert.equal(result.status, 200);
  assert.equal(data.nightly_reviews.length, 1);
  assert.deepEqual(data.learned_knowledge, ['Never invent plugins.']);
  assert.equal(data.last_nightly_at, '2026-09-29T07:07:00.000Z');
  assert.match(nightlyContext(data), /Never invent plugins/);
});

test('quiet days and bad AI output are handled honestly', async () => {
  const data = { last_nightly_at: '2026-09-30T00:00:00Z' };
  const quiet = await runNightlyReview({ AI: { run: async () => { throw new Error('should not run'); } } }, store(logs), data, 'm');
  assert.equal(quiet.review, null);
  assert.equal(parseReview('not json'), null);
  assert.equal(nightlyContext({}), '');
});
