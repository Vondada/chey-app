import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { TokenBucket } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'rate_limit.mjs')).href);

test('a new key starts full and then runs out', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSecond: 1 });
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 0), false);
});

test('tokens refill with elapsed time', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 500), false);
  assert.equal(b.take('a', 1000), true);
});

test('refill is capped at capacity', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSecond: 10 });
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 100000), true);
  assert.equal(b.take('a', 100000), true);
  assert.equal(b.take('a', 100000), false);
});

test('keys are independent', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('a', 0), false);
  assert.equal(b.take('b', 0), true);
});

test('a clock that goes backwards adds no tokens and keeps the latest time', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
  assert.equal(b.take('k', 0), true);
  assert.equal(b.take('k', 1000), true);
  assert.equal(b.take('k', 500), false);
  assert.equal(b.take('k', 1500), false);
  assert.equal(b.take('k', 2000), true);
});

test('an invalid configuration throws RangeError', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillPerSecond: NaN }), RangeError);
});

test('a non-finite time throws TypeError', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
  assert.throws(() => b.take('a', NaN), TypeError);
});
