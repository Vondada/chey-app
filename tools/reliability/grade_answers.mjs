// Reconstruction grader: runs CHE's recorded code answers (from the mailbox) against the spec of each question.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const files = ['claude.jsonl', 'archive/claude.jsonl'].map((f) => `${process.argv[2]}/${f}`);
const msgs = new Map();
for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const m = JSON.parse(l); msgs.set(m.id, m); }
const code = (id) => { const t = msgs.get(id)?.text || ''; const m = /```[a-z]*\n([\s\S]*?)```/.exec(t); return m ? m[1].replace(/^export /gm, '') : null; };
const load = (id, name) => { const src = code(id); if (!src) return { error: 'no code block' }; try { return { fn: new Function(`${src}\nreturn ${name};`)() }; } catch (e) { return { error: `does not compile: ${e.message}` }; } };
const cases = {
  'f0fe8771-5224-48e5-9cd6-fbef53e8e7db': ['chunk', (chunk) => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); assert.deepEqual(chunk([], 3), []);
    const a = [1, 2, 3]; chunk(a, 2); assert.deepEqual(a, [1, 2, 3]); assert.throws(() => chunk([1], 0), RangeError); assert.throws(() => chunk([1], 1.5), RangeError);
  }],
  'b3125eed-3e35-4a0c-9696-cfcc8ec3691a': ['parseDuration', null],
  'ed9df6da-a918-40de-9b36-d134c051423e': ['parseDuration', (p) => {
    assert.equal(p('1h30m15s'), 5415); assert.equal(p('45s'), 45); assert.equal(p('2H'), 7200); assert.equal(p('30m1h'), null);
    for (const bad of ['', ' 1h', '1h 2m', '5x', '5', '1.5h', '1h1h']) assert.equal(p(bad), null, bad); assert.equal(p('0s'), 0);
  }],
  '9ffd0225-c8ee-426c-bf08-d56dc4492f80': ['LRUCache', (L) => {
    const c = new L(2); c.put(1, 1); c.put(2, 2); assert.equal(c.get(1), 1); c.put(3, 3); assert.equal(c.get(2), -1); c.put(4, 4);
    assert.equal(c.get(1), -1); assert.equal(c.get(3), 3); assert.equal(c.get(4), 4); assert.throws(() => new L(0), RangeError);
    const d = new L(1); d.put('a', 1); d.put('a', 2); assert.equal(d.get('a'), 2);
  }],
  'adbfa5be-80b4-47f4-9191-f1e7c015f646': ['evaluateRPN', (e) => {
    assert.equal(e(['2', '1', '+', '3', '*']), 9); assert.equal(e(['4', '13', '5', '/', '+']), 6); assert.equal(e(['-7', '2', '/']), -3);
    for (const bad of [['1', '+'], ['1', '2'], ['1', '0', '/'], [], ['1', 'x', '+']]) assert.throws(() => e(bad), Error, JSON.stringify(bad));
  }],
  '8dd1908f-aa79-4dd9-8d8b-e7ac2220c68c': ['countWords', (c) => {
    assert.equal(c('a b'), 2); assert.equal(c('  a\tb\n c  '), 3); assert.equal(c(''), 0); assert.equal(c('   '), 0);
  }],
  '17a6b2d2-0a54-4a0a-bdfe-b1c3c0f44551': ['({ canAttempt, recordAttempt })', ({ canAttempt, recordAttempt }) => {
    let s = {}; for (let i = 0; i < 5; i++) { assert.equal(canAttempt(s, 'format'), true); s = recordAttempt(s, 'format'); }
    assert.equal(canAttempt(s, 'format'), false); assert.equal(canAttempt(s, 'semantic'), true);
    const before = s; const after = recordAttempt(s, 'semantic'); assert.notEqual(before, after);
    let t = {}; for (let i = 0; i < 3; i++) t = recordAttempt(t, 'semantic'); assert.equal(canAttempt(t, 'semantic'), false);
    assert.throws(() => recordAttempt({}, 'x')); assert.throws(() => canAttempt({}, 'x'));
  }],
};
for (const [id, [name, test]] of Object.entries(cases)) {
  const got = load(id, name);
  if (got.error) { console.log(id, 'FAIL', got.error); continue; }
  if (!test) { console.log(id, 'compiled (no test)'); continue; }
  try { test(got.fn); console.log(id, 'PASS'); } catch (e) { console.log(id, 'FAIL', e.message.split('\n')[0]); }
}
