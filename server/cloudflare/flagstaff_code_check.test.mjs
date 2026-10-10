import assert from 'node:assert/strict';
import test from 'node:test';
import { jsRegexFlagProblems } from './flagstaff_code_check.js';

const block = (code) => '```javascript\n' + code + '\n```';

test('valid regex flags and plain division are not flagged', () => {
  assert.deepEqual(jsRegexFlagProblems(block('const r = /ab+c/gi;\nconst avg = total / count;\nconst q = a/b/g;')), []);
});

test('the verbose x flag on one line is flagged', () => {
  const problems = jsRegexFlagProblems(block('const r = /ab/x;'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /regex flag x/);
});

test('an unknown flag is flagged', () => {
  assert.match(jsRegexFlagProblems(block('const r = /ab/q;'))[0], /regex flag q/);
});

test('a multi-line verbose regex closing with /x is flagged, as in the self-coding E2 reply', () => {
  const code = ['const regex = /^', '  (?:(\\d+)H)?', '$/x;'].join('\n');
  assert.match(jsRegexFlagProblems(block(code))[0], /verbose flag/);
});

test('prose outside code blocks is never flagged', () => {
  assert.deepEqual(jsRegexFlagProblems('Use /x for verbose mode in other languages.'), []);
});
