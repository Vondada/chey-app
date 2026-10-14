import assert from 'node:assert/strict';
import test from 'node:test';

import {
  retrieveVectorContext,
  storeVectorMemory,
  vectorContextText,
  vectorMemoryReadiness,
} from './vector_memory.js';

function fakeEnv() {
  return {
    CHE_PGVECTOR_REST_URL: 'https://db.example/rest/v1',
    CHE_PGVECTOR_TOKEN: 'secret',
    AI: {
      run: async (_model, input) => {
        assert.deepEqual(Object.keys(input), ['text']);
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
  };
}

test('pgvector recall embeds the question and returns sanitized nearest memories', async () => {
  const calls = [];
  const recall = await retrieveVectorContext(fakeEnv(), 'What did we decide?', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json([
      {
        id: '1',
        external_id: 'decision-1',
        kind: 'decision',
        title: 'Voice stack',
        content: 'Use local wake word and realtime voice after wake.',
        source: 'owner_context',
        similarity: 0.91,
      },
    ]);
  });
  assert.equal(recall.checked, true);
  assert.equal(recall.matches.length, 1);
  assert.equal(calls[0].url, 'https://db.example/rest/v1/rpc/match_che_memory');
  assert.deepEqual(calls[0].body.query_embedding, [0.1, 0.2, 0.3]);
  assert.match(vectorContextText(recall), /Voice stack/);
  assert.match(vectorContextText(recall), /0\.910/);
});

test('pgvector recall reports not configured instead of pretending it checked', async () => {
  const recall = await retrieveVectorContext({ AI: fakeEnv().AI }, 'hi');
  assert.equal(recall.checked, false);
  assert.equal(recall.status, 'not_configured');
  assert.equal(vectorMemoryReadiness({}).configured, false);
});

test('approved memory can be mirrored into Postgres/pgvector', async () => {
  const calls = [];
  const result = await storeVectorMemory(fakeEnv(), {
    external_id: 'memory:1',
    kind: 'memory',
    title: 'Favorite drink',
    content: 'Favorite drink: Sprite',
    source: 'explicit_memory',
  }, async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response('', { status: 201 });
  });
  assert.equal(result.stored, true);
  assert.equal(calls[0].body.external_id, 'memory:1');
  assert.deepEqual(calls[0].body.embedding, [0.1, 0.2, 0.3]);
  assert.match(calls[0].init.headers.Prefer, /merge-duplicates/);
});

test('pgvector excludes disproven, superseded, expired memories while labelling old references unverified', async () => {
  const result = await retrieveVectorContext(fakeEnv(), 'Where do I live?', async () => Response.json([
    { id: 'old', content: 'An obsolete address', similarity: 0.98, metadata: { active: false } },
    { id: 'superseded', content: 'Former favorite', similarity: 0.97, metadata: { superseded_at: '2026-10-01T00:00:00Z' } },
    { id: 'expired', content: 'Yesterday weather', similarity: 0.95, metadata: { expires_at: '2020-01-01T00:00:00Z' } },
    { id: 'unverified', content: 'Agent claim about a place', similarity: 0.88, source: 'research_note' },
    { id: 'owner', content: 'My favorite drink is Sprite', similarity: 0.81, metadata: { verification_status: 'owner_attested' } },
  ]));
  assert.deepEqual(result.matches.map(x => x.id), ['unverified', 'owner']);
  const context = vectorContextText(result);
  assert.match(context, /unverified reference/);
  assert.match(context, /owner-attested/);
  assert.doesNotMatch(context, /obsolete address|Former favorite|Yesterday weather/);
});
