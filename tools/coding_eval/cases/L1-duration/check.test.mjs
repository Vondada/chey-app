import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseDuration } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'duration.mjs')).href);

test('parts add up to seconds', () => {
  assert.equal(parseDuration('1h 30m 5s'), 5405);
});

test('a single day part', () => {
  assert.equal(parseDuration('2d'), 172800);
});

test('a single seconds part', () => {
  assert.equal(parseDuration('90s'), 90);
});

test('fractional parts are allowed', () => {
  assert.equal(parseDuration('1.5h'), 5400);
});

test('units are case-insensitive', () => {
  assert.equal(parseDuration('1H 2M'), 3720);
});

test('spaces between parts are optional', () => {
  assert.equal(parseDuration('1h30m'), 5400);
});

test('empty, unitless and unknown text throw Error', () => {
  for (const text of ['', '10', 'abc', '-5s']) {
    assert.throws(() => parseDuration(text), Error, `input ${JSON.stringify(text)}`);
  }
});
