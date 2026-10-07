import assert from 'node:assert/strict';
import test from 'node:test';
import { rankTopics, scoutTopics } from './topic_scout.js';

test('no source means no invented topics', async () => {
  const out = await scoutTopics({});
  assert.equal(out.ok, false);
  assert.equal(out.topics.length, 0);
  assert.match(out.error, /No topics were invented/);
});

test('feed titles become topics with the source kept', async () => {
  const out = await scoutTopics(
    { CHE_TREND_URLS: 'https://feeds.example/top' },
    async () => ({ ok: true, text: async () => '<rss><channel><title>Feed</title><item><title>Why Rome fell</title></item><item><title>Why Rome fell</title></item></channel></rss>' }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.topics.length, 1);
  assert.equal(out.topics[0].title, 'Why Rome fell');
  assert.equal(out.topics[0].source, 'https://feeds.example/top');
});

test('rank drops blanks and dupes', () => {
  const topics = rankTopics([
    { title: 'Same', source: 'a' },
    { title: 'same', source: 'b' },
    { title: '   ', source: 'c' },
    { title: 'Other', source: 'd' },
  ]);
  assert.deepEqual(topics.map((item) => item.title), ['Same', 'Other']);
});
