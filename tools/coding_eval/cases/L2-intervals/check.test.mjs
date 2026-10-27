import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { mergeIntervals } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'intervals.mjs')).href);

test('overlapping intervals merge', () => {
  assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);
});

test('touching intervals merge', () => {
  assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
});

test('unsorted input is sorted by start', () => {
  assert.deepEqual(mergeIntervals([[5, 6], [1, 2]]), [[1, 2], [5, 6]]);
});

test('a contained interval is absorbed', () => {
  assert.deepEqual(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]);
});

test('the input is not changed', () => {
  const input = [[3, 4], [1, 2]];
  mergeIntervals(input);
  assert.deepEqual(input, [[3, 4], [1, 2]]);
});

test('an empty input gives an empty array', () => {
  assert.deepEqual(mergeIntervals([]), []);
});

test('start greater than end throws RangeError', () => {
  assert.throws(() => mergeIntervals([[5, 1]]), RangeError);
});

test('a non-finite or malformed item throws TypeError', () => {
  assert.throws(() => mergeIntervals([[NaN, 2]]), TypeError);
  assert.throws(() => mergeIntervals([1, 2]), TypeError);
});
