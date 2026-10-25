import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseCsv } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'csv.mjs')).href);

test('rows and fields split on commas and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('a quoted field keeps its comma', () => {
  assert.deepEqual(parseCsv('x,"a,b",y'), [['x', 'a,b', 'y']]);
});

test('an escaped quote becomes one quote', () => {
  assert.deepEqual(parseCsv('"he said ""hi"""'), [['he said "hi"']]);
});

test('a quoted field may contain a line break', () => {
  assert.deepEqual(parseCsv('"a\nb",c'), [['a\nb', 'c']]);
});

test('CRLF line endings work and a trailing line break adds no row', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('empty fields are kept', () => {
  assert.deepEqual(parseCsv('a,,b'), [['a', '', 'b']]);
});

test('empty text gives no rows', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('an unclosed quote throws', () => {
  assert.throws(() => parseCsv('"abc'), Error);
});
