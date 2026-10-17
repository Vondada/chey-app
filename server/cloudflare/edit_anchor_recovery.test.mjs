// Source-edit anchors are recovered at the executor, against the real file, without
// duplicating work: a near-miss find re-anchors to its one clear match, an edit an
// earlier pass already applied is a no-op, and anything ambiguous is never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEdits, fuzzyLocate } from './self_development.js';

const real = readFileSync(new URL('./agent_runtime.js', import.meta.url), 'utf8');
const lines = real.split('\n');

// A real block of 4 consecutive non-blank lines that occurs exactly once in the file.
function uniqueBlock() {
  for (let i = 40; i < lines.length - 4; i += 1) {
    const block = lines.slice(i, i + 4);
    if (block.some((line) => !line.trim())) continue;
    const text = block.join('\n');
    if (real.split(text).length === 2) return { text, start: i, block };
  }
  throw new Error('no unique real block in agent_runtime.js');
}

test('an exact anchor applies as before (the unchanged path)', () => {
  const { text, block } = uniqueBlock();
  const replace = block.map((line, k) => (k === 1 ? `${line} // reviewed` : line)).join('\n');
  const result = applyEdits(new Map([['server/cloudflare/agent_runtime.js', real]]), [
    { path: 'server/cloudflare/agent_runtime.js', find: text, replace },
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.sources.get('server/cloudflare/agent_runtime.js'), real.replace(text, replace));
  assert.deepEqual(result.recovered, []);
});

test('a near-miss anchor (one stale line in the real block) re-anchors to its one clear match', () => {
  const { text, block } = uniqueBlock();
  const stale = block.map((line, k) => (k === 2 ? `${line.trimEnd()}  /* stale copy from an older revision */` : line)).join('\n');
  assert.notEqual(stale, text);
  const replace = block.map((line, k) => (k === 0 ? `${line} // recovered` : line)).join('\n');
  const result = applyEdits(new Map([['server/cloudflare/agent_runtime.js', real]]), [
    { path: 'server/cloudflare/agent_runtime.js', find: stale, replace },
  ]);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.sources.get('server/cloudflare/agent_runtime.js'), real.replace(text, replace), 'the replacement lands on the real block');
  assert.deepEqual(result.recovered.map((r) => r.how), ['fuzzy']);
});

test('an edit an earlier pass already applied is a no-op, so the change is never duplicated', () => {
  const { text, block } = uniqueBlock();
  const replace = block.map((line, k) => (k === 1 ? `${line} // applied once` : line)).join('\n');
  const edit = { path: 'server/cloudflare/agent_runtime.js', find: text, replace };
  const once = applyEdits(new Map([['server/cloudflare/agent_runtime.js', real]]), [edit]).sources;
  const twice = applyEdits(once, [edit]);
  assert.equal(twice.error, undefined, twice.error);
  assert.deepEqual(twice.recovered.map((r) => r.how), ['already_applied']);
  const text2 = twice.sources.get('server/cloudflare/agent_runtime.js');
  assert.equal(text2, once.get('server/cloudflare/agent_runtime.js'));
  assert.equal(text2.split(replace).length, 2, 'the replacement appears exactly once');
});

test('two similar places are an ambiguous match: nothing is guessed, the real lines go back', () => {
  const twin = ['function a() {', '  const x = 1;', '  const y = 2;', '  return x + y;', '}', '', 'function b() {', '  const x = 1;', '  const y = 2;', '  return x - y;', '}'].join('\n');
  const find = ['function a() {', '  const x = 1;', '  const y = 2;', '  return x * y;', '}'].join('\n');
  assert.equal(fuzzyLocate(twin, find), null, 'both blocks score alike, so neither is chosen');
  const result = applyEdits(new Map([['src/t.js', twin]]), [{ path: 'src/t.js', find, replace: 'function a() { return 0; }' }]);
  assert.match(result.error, /does not exist exactly/);
  assert.ok(result.anchor_lines, 'the closest real lines are handed back to the engineer');
});

test('a far-off anchor is not forced into the file: the error carries the real nearest lines', () => {
  const find = 'export function totallyMadeUpHelper(alpha) {\n  return alpha * 42;\n}\nexport const never = 1;';
  const result = applyEdits(new Map([['server/cloudflare/agent_runtime.js', real]]), [
    { path: 'server/cloudflare/agent_runtime.js', find, replace: 'export const x = 1;' },
  ]);
  assert.match(result.error, /does not exist exactly/);
  assert.equal(result.sources, undefined, 'a failed edit returns no changed sources');
});

test('the same failing edit repeated across passes does not change the file twice', () => {
  const { text, block } = uniqueBlock();
  const stale = block.map((line, k) => (k === 2 ? `${line.trimEnd()}  /* stale */` : line)).join('\n');
  const replace = block.map((line, k) => (k === 0 ? `${line} // once` : line)).join('\n');
  const edit = { path: 'server/cloudflare/agent_runtime.js', find: stale, replace };
  const first = applyEdits(new Map([['server/cloudflare/agent_runtime.js', real]]), [edit]).sources;
  const second = applyEdits(first, [edit]);
  assert.equal(second.error, undefined, second.error);
  assert.equal(second.sources.get('server/cloudflare/agent_runtime.js').split(replace).length, 2);
  assert.equal(text.length > 0, true);
});
