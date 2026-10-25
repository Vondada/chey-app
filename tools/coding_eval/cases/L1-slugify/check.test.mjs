import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { slugify } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'slugify.mjs')).href);

test('basic words are joined with a dash', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('runs of separators collapse and edges are trimmed', () => {
  assert.equal(slugify('  a -- b__c!! '), 'a-b-c');
});

test('accents are removed', () => {
  assert.equal(slugify('Café Crème'), 'cafe-creme');
});

test('digits are kept', () => {
  assert.equal(slugify('CHE 2 v10'), 'che-2-v10');
});

test('symbols only and empty input give an empty string', () => {
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(''), '');
});

test('a non-string throws TypeError', () => {
  assert.throws(() => slugify(42), TypeError);
  assert.throws(() => slugify(null), TypeError);
});
