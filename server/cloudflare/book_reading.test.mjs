import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBookSummary, BOOK_TEXT_CHARS } from './book_reading.js';

function fakeAI(reply, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (throws) throw new Error('model down');
      return { response: reply };
    },
  };
}

function noNetwork(t) {
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits += 1; throw new Error('network blocked in test'); };
  t.after(() => { globalThis.fetch = realFetch; });
  return () => hits;
}

test('refuses when the caller supplied no text, and never calls the model', async () => {
  const ai = fakeAI('a summary');
  for (const text of [undefined, null, '', '   ', 42]) {
    const out = await readBookSummary({ bookId: 'b1', text, title: 'Book' }, { AI: ai });
    assert.equal(out.status, 'refused', `text=${JSON.stringify(text)}`);
    assert.deepEqual(out.items, []);
  }
  assert.equal(ai.calls.length, 0);
});

test('refuses without a book id', async () => {
  const ai = fakeAI('a summary');
  const out = await readBookSummary({ bookId: '', text: 'Some text' }, { AI: ai });
  assert.equal(out.status, 'refused');
  assert.equal(ai.calls.length, 0);
});

test('no env.AI gives model_unavailable with no items', async () => {
  const out = await readBookSummary({ bookId: 'b1', text: 'Some text', title: 'Dune' }, {});
  assert.equal(out.status, 'model_unavailable');
  assert.deepEqual(out.items, []);
});

test('returns a book-category reflection carrying the book title', async () => {
  const out = await readBookSummary(
    { bookId: 'b1', text: 'Chapter one text.', title: 'The Practice of Ideas' },
    { AI: fakeAI('  The book argues   that ideas need practice.  ') },
  );
  assert.equal(out.status, 'ok');
  assert.equal(out.title, 'The Practice of Ideas');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].category, 'book');
  assert.equal(out.items[0].title, 'The Practice of Ideas');
  assert.equal(out.items[0].text, 'The book argues that ideas need practice.');
  assert.equal(out.items[0].reply, 'open');
});

test('title falls back to the book id when none is supplied', async () => {
  const out = await readBookSummary({ bookId: 'b9', text: 'Text' }, { AI: fakeAI('Short.') });
  assert.equal(out.title, 'b9');
  assert.equal(out.items[0].title, 'b9');
});

test('empty model output gives no_items, not an invented summary', async () => {
  const out = await readBookSummary({ bookId: 'b1', text: 'Text', title: 'T' }, { AI: fakeAI('   ') });
  assert.equal(out.status, 'no_items');
  assert.deepEqual(out.items, []);
});

test('model errors give model_error with no items', async () => {
  const out = await readBookSummary({ bookId: 'b1', text: 'Text', title: 'T' }, { AI: fakeAI('', { throws: true }) });
  assert.equal(out.status, 'model_error');
  assert.deepEqual(out.items, []);
});

test('only the Cloudflare model is called, the text is capped, and no network is used', async (t) => {
  const hits = noNetwork(t);
  const ai = fakeAI('Short.');
  await readBookSummary({ bookId: 'b1', text: 'x'.repeat(BOOK_TEXT_CHARS + 5000), title: 'T' }, { AI: ai });
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].model, /^@cf\//);
  const userText = ai.calls[0].input.messages[1].content;
  assert.ok(userText.length <= BOOK_TEXT_CHARS + 200, 'text sent to the model is capped');
  assert.equal(hits(), 0, 'no outbound network call');
});
