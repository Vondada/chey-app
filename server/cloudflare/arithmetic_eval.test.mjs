// CHE exact arithmetic and correction (owner, 2026-10-28): "12 × 17 = 204" and "224 − 204 = 20" are verified, a wrong
// equation in a reply gets the exact answer beside it, a correct answer is never replaced by a correction, and a
// hedged guess is never saved as memory. Every answer is computed by arithmetic.js, never recalled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEquations, evaluate, formatRational, plainArithmetic } from './arithmetic.js';
import { numericNotes } from './numeric_truth.js';
import { guardRememberBlock } from './memory_provenance.js';

// 24 varied problems: multiplication, subtraction, division, percentages, powers, multi-step, decimals, negatives.
const PROBLEMS = [
  ['12 × 17', '204'], ['224 - 204', '20'], ['17 * 23', '391'], ['99 * 99', '9,801'], ['6 * 7 * 8', '336'],
  ['7 / 2', '3.5'], ['100 / 8', '12.5'], ['144 / 12 / 3', '4'], ['1/3 * 3', '1'], ['81 / 9 + 2', '11'],
  ['15% of 80', '12'], ['20% of 150', '30'], ['12.5% of 40', '5'], ['1000 * 1.05', '1,050'], ['45% of 200', '90'],
  ['(3 + 4) * 5 - 2', '33'], ['((10 + 2) / 4) * 3', '9'], ['2 * 3 + 4 * 5', '26'], ['10 - 4 - 3', '3'], ['250 - 13 * 4', '198'],
  ['2 ^ 10', '1,024'], ['-5 + 12', '7'], ['0.1 + 0.2', '0.3'], ['1,000 - 1', '999'],
];

test('the evaluator gets all 24 varied problems exactly', () => {
  assert.equal(PROBLEMS.length, 24);
  for (const [expression, expected] of PROBLEMS) {
    assert.equal(formatRational(evaluate(expression)), expected, `${expression} should be ${expected}`);
  }
});

test('the owner\'s two sums are exact, and the chat route answers them without a model', () => {
  assert.equal(plainArithmetic('CHE, what is 12 times 17?').result, '204');
  assert.equal(plainArithmetic('224 minus 204').result, '20');
  assert.equal(formatRational(evaluate('12 × 17')), '204');
  assert.equal(formatRational(evaluate('224 − 204')), '20');
});

test('a wrong equation in a reply is named with the exact answer; a correct one is not corrected', () => {
  const wrong = checkEquations('The answer 204 aligns with basic multiplication: 12 × 17 = 224 — so it’s off by one.');
  assert.deepEqual(wrong.map((c) => [c.status, c.note]), [['contradicted', '12 × 17 = 204, not 224.']]);
  assert.deepEqual(checkEquations('224 − 204 = 20.').map((c) => c.status), ['verified']);
  assert.equal(checkEquations('224 - 204 = 19')[0].note, '224 − 204 = 20, not 19.');
  assert.equal(numericNotes('12 × 17 = 204.'), '', 'a correct answer gets no correction note at all');
});

test('a correct answer is never replaced by an incorrect correction', () => {
  // The note is only ever added beside the reply, and the exact answer it gives is the evaluator's, never the reply's.
  const reply = 'Twelve times seventeen is 204, and 224 − 204 = 20.';
  assert.equal(numericNotes(reply), '', 'nothing in a correct reply is contradicted');
  const note = numericNotes('12 × 17 = 224.');
  assert.match(note, /Correction \(arithmetic, not memory\): 12 × 17 = 204, not 224\./);
});

test('plain sentences about maths and unfinished sums are not treated as sums', () => {
  assert.equal(plainArithmetic('Tell me about 12 times 17 in history'), null);
  assert.equal(plainArithmetic('12 times'), null);
  assert.match(plainArithmetic('what is 5 / 0').error, /Division by zero/);
});

test('a speculation is never saved as a verified memory; an owner fact still is', () => {
  const owner = ['my favourite colour is blue'];
  const reply = [
    'Noted, sir.',
    '```che-remember',
    '[Knowledge] The cache probably returned the old GitHub research.',
    '[Knowledge] CHE likely retrieved the GitHub results last turn.',
    '[People] my favourite colour is blue',
    '```',
  ].join('\n');
  const out = guardRememberBlock(reply, { ownerTurns: [...owner, 'the cache returned old research'] });
  assert.match(out.text, /my favourite colour is blue/);
  assert.doesNotMatch(out.text, /probably|likely|retrieved/);
  assert.equal(out.dropped.length, 2, 'both speculative lines were dropped');
});

test('a memory line about CHE\'s own lookups is dropped even when the owner used the same words', () => {
  const reply = '```che-remember\n[Knowledge] I searched GitHub and fetched the cached research.\n```';
  const out = guardRememberBlock(reply, { ownerTurns: ['I searched GitHub and fetched the cached research.'] });
  assert.doesNotMatch(out.text, /fetched|searched/);
  assert.equal(out.dropped.length, 1);
});
