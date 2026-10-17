// Source-edit anchors at the executor, against the real file. An exact anchor applies. A
// stale anchor is never guessed onto a nearby block: the engineer gets the real lines back.
// An edit an earlier pass already applied is recognised and not applied twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEdits } from './self_development.js';

const FILE = 'server/cloudflare/agent_runtime.js';
const real = readFileSync(new URL('./agent_runtime.js', import.meta.url), 'utf8');
const lines = real.split('\n');

// A real block of 4 consecutive non-blank lines, at least 80 characters, occurring once.
function uniqueBlock() {
  for (let i = 40; i < lines.length - 4; i += 1) {
    const block = lines.slice(i, i + 4);
    if (block.some((line) => !line.trim())) continue;
    const text = block.join('\n');
    if (text.length >= 80 && real.split(text).length === 2) return { text, block };
  }
  throw new Error('no unique real block in agent_runtime.js');
}

const sources = () => new Map([[FILE, real]]);

test('an exact anchor applies as before (the unchanged path)', () => {
  const { text, block } = uniqueBlock();
  const replace = block.map((line, k) => (k === 1 ? `${line} // reviewed` : line)).join('\n');
  const result = applyEdits(sources(), [{ path: FILE, find: text, replace }]);
  assert.equal(result.error, undefined);
  assert.equal(result.sources.get(FILE), real.replace(text, replace));
  assert.deepEqual(result.recovered, []);
});

test('a stale anchor is never guessed onto a nearby block: the error carries the real lines and the file is unchanged', () => {
  const { block } = uniqueBlock();
  const stale = block.map((line, k) => (k === 2 ? `${line.trimEnd()}  /* stale copy from an older revision */` : line)).join('\n');
  const replace = block.map((line, k) => (k === 0 ? `${line} // should not land` : line)).join('\n');
  const result = applyEdits(sources(), [{ path: FILE, find: stale, replace }]);
  assert.match(result.error, /does not exist exactly/);
  assert.ok(result.anchor_lines, 'the closest real lines are handed back to the engineer');
  assert.equal(result.sources, undefined, 'a failed edit returns no changed sources');
});

test('a stale value is never restored over newer code (the timeout case the review found)', () => {
  const current = ['const timeoutMs = 45000;', 'const retries = 3;', 'const label = "a";', 'return send(timeoutMs);'].join('\n');
  // An earlier pass changed 30000 to 45000. This find quotes the old line and matches the other three.
  const find = ['const timeoutMs = 30000;', 'const retries = 3;', 'const label = "a";', 'return send(timeoutMs);'].join('\n');
  const replace = ['const timeoutMs = 30000;', 'const retries = 3;', 'const label = "a";', 'return send(timeoutMs);'].join('\n').replace('label = "a"', 'label = "b"');
  const result = applyEdits(new Map([['src/t.js', current]]), [{ path: 'src/t.js', find, replace }]);
  assert.match(result.error ?? '', /does not exist exactly/, 'the stale find does not apply');
  assert.equal(result.sources, undefined);
});

test('an edit an earlier pass already applied is recognised and not applied twice', () => {
  const { text, block } = uniqueBlock();
  const replace = block.map((line, k) => (k === 1 ? `${line} // applied once` : line)).join('\n');
  const edit = { path: FILE, find: text, replace };
  const once = applyEdits(sources(), [edit]).sources;
  const twice = applyEdits(once, [edit]);
  assert.equal(twice.error, undefined, twice.error);
  assert.deepEqual(twice.recovered.map((r) => r.how), ['already_applied']);
  assert.equal(twice.sources.get(FILE), once.get(FILE));
  assert.equal(twice.sources.get(FILE).split(replace).length, 2, 'the replacement appears exactly once');
});

test('a short replacement that happens to appear once is not taken as an applied change', () => {
  const current = ['function a() {', '  const q = 1;', '  return q;', '}', 'function b() {', '  return 2;', '}'].join('\n');
  const find = '  const removed = 5;';
  const result = applyEdits(new Map([['src/t.js', current]]), [{ path: 'src/t.js', find, replace: '  return q;' }]);
  assert.match(result.error ?? '', /does not exist exactly/, 'the edit is reported, not silently dropped');
});

test('two identical places are an ambiguous anchor: nothing is guessed', () => {
  const block = ['function a() {', '  const x = 1;', '  const y = 2;', '  return x + y;', '}'].join('\n');
  const current = `${block}\n\n${block}\n`;
  const result = applyEdits(new Map([['src/t.js', current]]), [{ path: 'src/t.js', find: block, replace: 'function a() { return 0; }' }]);
  assert.match(result.error, /ambiguous/);
  assert.equal(result.sources, undefined);
});

test('a far-off anchor is not forced into the file: the error carries the real nearest lines', () => {
  const find = 'export function totallyMadeUpHelper(alpha) {\n  return alpha * 42;\n}\nexport const never = 1;';
  const result = applyEdits(sources(), [{ path: FILE, find, replace: 'export const x = 1;' }]);
  assert.match(result.error, /does not exist exactly/);
  assert.equal(result.sources, undefined);
});

test('the same edit repeated across passes changes the file once', () => {
  const { text, block } = uniqueBlock();
  const replace = block.map((line, k) => (k === 0 ? `${line} // once` : line)).join('\n');
  const edit = { path: FILE, find: text, replace };
  const first = applyEdits(sources(), [edit]).sources;
  const second = applyEdits(first, [edit]);
  assert.equal(second.error, undefined, second.error);
  assert.equal(second.sources.get(FILE).split(replace).length, 2);
});
