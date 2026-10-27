import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chunk } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'chunk.mjs')).href);

test('splits into chunks with a shorter last chunk', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('an empty list gives no chunks', () => {
  assert.deepEqual(chunk([], 3), []);
});

test('a size larger than the list gives one chunk', () => {
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

test('the input is not changed', () => {
  const input = [1, 2, 3];
  chunk(input, 2);
  assert.deepEqual(input, [1, 2, 3]);
});

test('a size that is not a positive integer throws RangeError', () => {
  for (const size of [0, -1, 1.5, NaN]) {
    assert.throws(() => chunk([1], size), RangeError, `size ${size}`);
  }
});

test('a non-array list throws TypeError', () => {
  assert.throws(() => chunk('abc', 2), TypeError);
});
