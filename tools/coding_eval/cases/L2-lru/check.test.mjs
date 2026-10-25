import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { LruCache } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'lru.mjs')).href);

test('get returns a stored value and undefined on a miss', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('zzz'), undefined);
});

test('a get makes a key recent, so the other key is evicted', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('c'), true);
});

test('updating an existing key evicts nothing', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10);
  assert.equal(c.size, 2);
  assert.equal(c.has('b'), true);
  assert.equal(c.get('a'), 10);
});

test('has does not change recency', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.has('a');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});

test('falsy keys work', () => {
  const c = new LruCache(3);
  c.set(0, 'zero');
  c.set('', 'empty');
  c.set(null, 'null');
  assert.equal(c.get(0), 'zero');
  assert.equal(c.get(''), 'empty');
  assert.equal(c.get(null), 'null');
  assert.equal(c.size, 3);
});

test('delete reports whether the key was present', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size, 0);
});

test('a capacity that is not a positive integer throws RangeError', () => {
  assert.throws(() => new LruCache(0), RangeError);
  assert.throws(() => new LruCache(-2), RangeError);
});
