import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationMemoryCount,
  listConversationMemories,
  memoryTokens,
  recordConversationMemory,
  replyFromNdjson,
} from './brain_memory.js';

/** Durable Object storage subset: get/put(map)/list(prefix, reverse, limit, end). */
export function memoryStorage() {
  const saved = new Map();
  return {
    saved,
    get: async (key) => saved.get(key),
    put: async (key, value) => {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, v);
      else saved.set(key, value);
    },
    list: async ({ prefix = '', reverse = false, limit = Infinity, end } = {}) => {
      let keys = [...saved.keys()].filter((k) => k.startsWith(prefix) && (end === undefined || k < end)).sort();
      if (reverse) keys.reverse();
      keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, saved.get(k)]));
    },
  };
}

test('every exchange becomes a memory with what was said and answered', async () => {
  const storage = memoryStorage();
  const m = await recordConversationMemory(storage, {
    message: 'How do ES futures react to CPI news?',
    reply: 'ES usually moves hard in the first minutes after CPI. Volume spikes. Wait for the range.',
    now: 1_000,
  });
  assert.equal(m.title, 'How do ES futures react to CPI news?');
  assert.match(m.body, /You said: How do ES futures/);
  assert.match(m.body, /CHE answered: ES usually moves/);
  assert.equal(await conversationMemoryCount(storage), 1);
  const listed = await listConversationMemories(storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokens, undefined, 'tokens stay server-side');
});

test('new memories build on related earlier ones and strengthen them', async () => {
  const storage = memoryStorage();
  const a = await recordConversationMemory(storage, { message: 'Show me the ES futures chart', reply: 'Loading ES futures.', now: 1_000 });
  await recordConversationMemory(storage, { message: 'What is the weather in Chicago', reply: 'Sunny.', now: 2_000 });
  const c = await recordConversationMemory(storage, { message: 'Backtest ES futures on the daily chart', reply: 'Running the ES backtest.', now: 3_000 });
  assert.deepEqual(c.links, [a.id], 'linked only to the memory sharing real topics');
  const [newest, , oldest] = await listConversationMemories(storage);
  assert.equal(newest.id, c.id);
  assert.equal(oldest.strength, 2, 'the earlier memory grew stronger');
  assert.deepEqual(oldest.links, [c.id]);
});

test('no cap: memories keep growing and page back through history', async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 2600; i++) {
    await recordConversationMemory(storage, { message: `Topic number ${i} notes`, reply: 'Okay.', now: 10_000 + i, id: `m${i}` });
  }
  assert.equal(await conversationMemoryCount(storage), 2600);
  const first = await listConversationMemories(storage);
  assert.equal(first.length, 2000);
  assert.equal(first[0].id, 'm2599');
  const older = await listConversationMemories(storage, { before: first.at(-1).at });
  assert.equal(older.length, 600);
  assert.equal(older.at(-1).id, 'm0');
});

test('secrets are never stored', async () => {
  const storage = memoryStorage();
  assert.equal(await recordConversationMemory(storage, { message: 'My password is hunter2', reply: 'Saved in your vault.' }), null);
  const m = await recordConversationMemory(storage, { message: 'Log in to my bank', reply: 'Your password is hunter2 and the security code is 1234.' });
  assert.equal(m.body, 'You said: Log in to my bank');
  assert.equal(await conversationMemoryCount(storage), 1);
});

test('reply is rebuilt from the chat NDJSON stream; tokens skip filler', () => {
  const ndjson = [
    JSON.stringify({ type: 'step', text: 'x' }),
    JSON.stringify({ type: 'delta', delta: 'Hello, ' }),
    JSON.stringify({ type: 'delta', delta: 'sir.' }),
    JSON.stringify({ type: 'done' }),
  ].join('\n');
  assert.equal(replyFromNdjson(ndjson), 'Hello, sir.');
  assert.deepEqual(memoryTokens('Please, sir, the ES chart'), ['chart']);
});

test('War Room meetings become one remembered thread each, updated as they grow', async () => {
  const { syncWarRoomMemories, recallMemories } = await import('./brain_memory.js');
  const storage = memoryStorage();
  const data = { meetings: [{ id: 'm1', objective: 'Pick the ES paper strategy', status: 'running', board: [
    { from: 'Atlas', text: 'Breakout after the opening range has the best backtest.', at: '2026-10-04T10:00:00Z' },
  ] }] };
  assert.equal(await syncWarRoomMemories(storage, data), 1);
  assert.equal(await syncWarRoomMemories(storage, data), 0, 'unchanged meeting is not rewritten');
  data.meetings[0].board.push({ from: 'CHE', kind: 'synthesis', text: 'Final plan: opening-range breakout, paper only.', at: '2026-10-04T10:05:00Z' });
  data.meetings[0].status = 'complete';
  assert.equal(await syncWarRoomMemories(storage, data), 1);
  const all = await listConversationMemories(storage);
  assert.equal(all.length, 1, 'one memory per meeting, never duplicated');
  assert.match(all[0].body, /Final plan: opening-range breakout/);
  const [hit] = await recallMemories(storage, 'What did the War Room decide?');
  assert.equal(hit.kind, 'war_room');
});

test('Flagstaff exchanges are recalled when the owner asks what another AI said', async () => {
  const { rememberThread, recallMemories, rememberedText } = await import('./brain_memory.js');
  const storage = memoryStorage();
  await recordConversationMemory(storage, { message: 'What is the weather', reply: 'Sunny.', now: 1_000 });
  await rememberThread(storage, { id: 'flagstaff:x1', kind: 'flagstaff', title: 'Flagstaff: chatgpt: voice latency', body: 'chatgpt said in Flagstaff: prefetch the next chunk.\nCHE replied: done in the pipeline.', now: 2_000 });
  const found = await recallMemories(storage, 'What did ChatGPT tell you in the mailbox?');
  assert.equal(found[0].id, 'flagstaff:x1');
  const block = rememberedText(found);
  assert.match(block, /REMEMBERED CONVERSATIONS/);
  assert.match(block, /\[Flagstaff/);
  assert.equal(await rememberThread(storage, { id: 'flagstaff:x2', kind: 'flagstaff', body: 'password is hunter2' }), null, 'secrets never stored');
});
