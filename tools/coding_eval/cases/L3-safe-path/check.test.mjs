import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { safeJoinPath } = await import(pathToFileURL(join(process.env.CHE_CANDIDATE_DIR, 'safe_path.mjs')).href);

test('a normal relative path joins under base', () => {
  assert.equal(safeJoinPath('/srv/data', 'notes/a.txt'), '/srv/data/notes/a.txt');
});

test('dots that stay inside base are allowed', () => {
  assert.equal(safeJoinPath('/srv/data', 'a/../b.txt'), '/srv/data/b.txt');
});

test('empty and dot paths return base', () => {
  assert.equal(safeJoinPath('/srv/data', ''), '/srv/data');
  assert.equal(safeJoinPath('/srv/data', '.'), '/srv/data');
});

test('a trailing slash on base is allowed', () => {
  assert.equal(safeJoinPath('/srv/data/', 'a'), '/srv/data/a');
});

test('climbing out of base throws', () => {
  for (const p of ['../secret', 'a/../../secret', '..', '../data-evil/x']) {
    assert.throws(() => safeJoinPath('/srv/data', p), Error, p);
  }
});

test('absolute user paths throw', () => {
  assert.throws(() => safeJoinPath('/srv/data', '/etc/passwd'), Error);
});

test('backslash separators throw', () => {
  assert.throws(() => safeJoinPath('/srv/data', '..\\secret'), Error);
});

test('percent-encoded dots and slashes throw in any case', () => {
  for (const p of ['%2e%2e/secret', '%2E%2E%2Fsecret', 'x%2f..%2f..', 'y%5c..']) {
    assert.throws(() => safeJoinPath('/srv/data', p), Error, p);
  }
});

test('a NUL byte throws', () => {
  assert.throws(() => safeJoinPath('/srv/data', 'a\0b'), Error);
});

test('a relative base throws', () => {
  assert.throws(() => safeJoinPath('srv/data', 'a'), Error);
});

test('non-string inputs throw TypeError', () => {
  assert.throws(() => safeJoinPath('/srv/data', 5), TypeError);
  assert.throws(() => safeJoinPath(null, 'a'), TypeError);
});
