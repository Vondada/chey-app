import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyReflection, listReflections, parseItems, saveReflection, setReflectionReply, validDay, REFLECTIONS_KEY,
} from './reflections.js';

function fakeAI(reply, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (throws) throw new Error('model down');
      return typeof reply === 'function' ? reply(input) : { response: reply };
    },
  };
}

function fakeStorage() {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async put(k, v) { data.set(k, structuredClone(v)); },
  };
}

const DAY = '2026-10-21';
const EVENTS = [
  { room: 'chat', text: 'Owner: check the Office board for Atlas' },
  { room: 'agents', text: 'Agent Atlas finished the repository inspection report' },
  { room: 'create', text: 'Job failed: video render timed out' },
];

// Blocks any network use: a reflection may only talk to the Cloudflare binding.
function noNetwork(t) {
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits += 1; throw new Error('network blocked in test'); };
  t.after(() => { globalThis.fetch = realFetch; });
  return () => hits;
}

test('validDay accepts only real calendar days in YYYY-MM-DD form', () => {
  assert.equal(validDay('2026-10-21'), true);
  assert.equal(validDay('2026-02-30'), false);
  assert.equal(validDay('21-10-2026'), false);
  assert.equal(validDay(''), false);
});

test('no env.AI gives model_unavailable with no items, never invented ones', async (t) => {
  const hits = noNetwork(t);
  const out = await buildDailyReflection({ day: DAY, events: EVENTS }, {});
  assert.equal(out.status, 'model_unavailable');
  assert.deepEqual(out.items, []);
  assert.equal(hits(), 0);
});

test('no events means no_events and no model call', async () => {
  const ai = fakeAI('[]');
  const out = await buildDailyReflection({ day: DAY, events: [] }, { AI: ai });
  assert.equal(out.status, 'no_events');
  assert.deepEqual(out.items, []);
  assert.equal(ai.calls.length, 0);
});

test('invalid day is refused before any model call', async () => {
  const ai = fakeAI('[]');
  const out = await buildDailyReflection({ day: 'yesterday', events: EVENTS }, { AI: ai });
  assert.equal(out.status, 'invalid_day');
  assert.equal(ai.calls.length, 0);
});

test('only grounded, allowed items survive; invented ones are dropped', async () => {
  const model = JSON.stringify([
    { category: 'lesson', source: 3, text: 'Render timeouts need a retry plan.' },
    { category: 'money_opportunity', source: 2, text: 'Atlas could sell the inspection report.' },
    { category: 'gossip', source: 1, text: 'Wrong category.' },
    { category: 'idea', source: 9, text: 'Cites an event that does not exist.' },
    { category: 'mistake', source: 1, text: '' },
    { category: 'question_for_owner', source: '2', text: 'Quoted number is fine?' },
    { category: 'idea', source: 1.5, text: 'Fractional source.' },
  ]);
  const ai = fakeAI(`Here you go: ${model}`);
  const out = await buildDailyReflection({ day: DAY, events: EVENTS }, { AI: ai });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.items.map((i) => i.category), ['lesson', 'money_opportunity', 'question_for_owner']);
  for (const item of out.items) {
    assert.equal(item.reply, 'open');
    assert.equal(item.reply_text, '');
  }
});

test('every item carries the room of the event it cites, not a model-chosen room', async () => {
  const model = JSON.stringify([
    { category: 'lesson', source: 2, text: 'Agent reports need a check.', room: 'chat' },
    { category: 'idea', source: 3, text: 'Retry renders.' },
  ]);
  const out = await buildDailyReflection({ day: DAY, events: EVENTS }, { AI: fakeAI(model) });
  assert.deepEqual(out.items.map((i) => i.room), ['agents', 'create']);
});

test('rooms outside the allowlist (private memory included) never reach the model', async () => {
  const ai = fakeAI('[]');
  const events = [
    { room: 'memory', text: 'Private memory: owner medical note' },
    { room: 'brain', text: 'Brain: new concept linked' },
    { text: 'no room at all' },
    'plain string with no room',
  ];
  const out = await buildDailyReflection({ day: DAY, events }, { AI: ai });
  assert.ok(['ok', 'no_items'].includes(out.status));
  const sent = ai.calls[0].input.messages.map((m) => m.content).join('\n');
  assert.ok(!sent.includes('medical'), 'private memory text excluded');
  assert.ok(!sent.includes('no room at all'));
  assert.ok(sent.includes('Brain: new concept linked'));
  assert.ok(!sent.includes('plain string'));
});

test('an all-private day gives no_events and no model call', async () => {
  const ai = fakeAI('[]');
  const out = await buildDailyReflection({ day: DAY, events: [{ room: 'memory', text: 'secret' }] }, { AI: ai });
  assert.equal(out.status, 'no_events');
  assert.equal(ai.calls.length, 0);
});

test('prose with no JSON array gives no_items and zero invented items', async () => {
  const out = await buildDailyReflection({ day: DAY, events: EVENTS }, { AI: fakeAI('Today was a good day!') });
  assert.equal(out.status, 'no_items');
  assert.deepEqual(out.items, []);
});

test('model errors give model_error with no items', async () => {
  const out = await buildDailyReflection({ day: DAY, events: EVENTS }, { AI: fakeAI('', { throws: true }) });
  assert.equal(out.status, 'model_error');
  assert.deepEqual(out.items, []);
});

test('only the Cloudflare model is called, and the events reach it as input', async (t) => {
  const hits = noNetwork(t);
  const ai = fakeAI('[]');
  await buildDailyReflection({ day: DAY, events: EVENTS }, { AI: ai });
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].model, /^@cf\//);
  const sent = ai.calls[0].input.messages.map((m) => m.content).join('\n');
  for (const e of EVENTS) assert.ok(sent.includes(e.text), `event missing from model input: ${e.text}`);
  assert.ok(sent.includes('(agents)'), 'each entry is tagged with its room');
  assert.equal(hits(), 0, 'no outbound network call');
});

test('parseItems ignores malformed rows without throwing', () => {
  assert.deepEqual(parseItems('[{"category":', 3), []);
  assert.deepEqual(parseItems('[null, 5, "x"]', 3), []);
});

test('storage: save, list by day, and the owner reply is stored exactly', async () => {
  const storage = fakeStorage();
  const built = await buildDailyReflection({ day: DAY, events: EVENTS }, {
    AI: fakeAI(JSON.stringify([{ category: 'idea', source: 1, text: 'Ask Atlas for a status line.' }])),
  });
  const saved = await saveReflection(storage, built);
  assert.equal(saved.reflection.items[0].room, 'chat');
  assert.equal(saved.ok, true);
  assert.equal(storage.data.has(REFLECTIONS_KEY), true);

  const other = await saveReflection(storage, { id: 'reflection-2026-10-20', day: '2026-10-20', items: [] });
  assert.equal(other.ok, true);
  assert.deepEqual((await listReflections(storage, { day: DAY })).map((r) => r.id), [built.id]);
  assert.equal((await listReflections(storage)).length, 2);

  const owner = '  Yes, let\'s do it — “Monday” works.\n';
  const reply = await setReflectionReply(storage, built.id, 0, { reply: 'replied', reply_text: owner });
  assert.equal(reply.ok, true);
  assert.equal(reply.item.reply, 'replied');
  const [back] = await listReflections(storage, { day: DAY });
  assert.equal(back.items[0].reply, 'replied');
  assert.equal(back.items[0].reply_text, owner, 'owner words kept byte for byte');
});

test('setReflectionReply rejects bad state, index, id and oversized text', async () => {
  const storage = fakeStorage();
  await saveReflection(storage, { id: 'reflection-x', day: DAY, items: [{ category: 'lesson', text: 'a' }] });
  assert.equal((await setReflectionReply(storage, 'reflection-x', 0, { reply: 'maybe' })).ok, false);
  assert.equal((await setReflectionReply(storage, 'reflection-x', 1, { reply: 'skipped' })).ok, false);
  assert.equal((await setReflectionReply(storage, 'reflection-x', -1, { reply: 'skipped' })).ok, false);
  assert.equal((await setReflectionReply(storage, 'reflection-x', 0.5, { reply: 'skipped' })).ok, false);
  assert.equal((await setReflectionReply(storage, 'missing', 0, { reply: 'skipped' })).ok, false);
  assert.equal((await setReflectionReply(storage, 'reflection-x', 0, { reply: 'replied', reply_text: 'x'.repeat(4001) })).ok, false);
  const skipped = await setReflectionReply(storage, 'reflection-x', 0, { reply: 'skipped' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.item.reply_text, '');
});
