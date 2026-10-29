// The universal problem controller: a bare sum is solved by the verified arithmetic (arithmetic.js), with a receipt and
// no model call. Anything without a verified path is reported as needs_model, never answered from a guess.
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, formatRational } from './arithmetic.js';
import { ARITHMETIC_ID, answerForChat, classify, exactText, seedRegistry, solve } from './problem_controller.js';
import { emptyRegistry, serving } from './capability_registry.js';

// Hand-checked expected answers from school arithmetic, not from this code.
const KNOWN = [
  ['12 × 17', '204'],
  ['17 x 23', '391'],
  ['(7+8)*(9-4)', '75'],
  ['2+3*4', '14'],
  ['-2^2 + 5', '1'],
  ['2^-1', '0.5'],
  ['2^10 - 1', '1,023'],
  ['1/3 + 1/6', '0.5'],
  ['0.1 + 0.2', '0.3'],
  ['100 / 8', '12.5'],
  ['3.5 * 4', '14'],
  ['2^64', '18,446,744,073,709,551,616'],
];

test('the arithmetic capability serves only after the registry promotion gate', () => {
  assert.ok(serving(seedRegistry(), ARITHMETIC_ID), 'a promoted capability serves');
  assert.equal(serving(emptyRegistry(), ARITHMETIC_ID), null, 'an unregistered capability never serves');
});

test('every known problem is verified, uses no model, and carries the capability id', () => {
  const registry = seedRegistry();
  for (const [goal, expected] of KNOWN) {
    const r = solve(goal, { registry });
    assert.equal(r.status, 'verified', goal);
    assert.equal(r.result, expected, goal);
    assert.equal(r.model_calls, 0, `${goal} must not call a model`);
    assert.equal(r.capability_id, ARITHMETIC_ID);
    assert.ok(r.steps.some((s) => s.step === 'verify' && s.result === 'agrees'), goal);
  }
});

test('the controller gives the same exact value as arithmetic.js, with no second parser', () => {
  for (const [goal] of KNOWN) {
    const r = solve(goal);
    assert.equal(formatRational(evaluate(r.expression)).replace(/\s/g, ''), r.result.replace(/\s/g, ''), goal);
  }
});

test('an exact fraction with no short decimal is shown as a fraction, never rounded', () => {
  assert.equal(solve('1 / 3').result, '1/3');
  assert.equal(solve('1 / 3 * 3').result, '1', 'the exact value, not a rounded decimal');
  assert.equal(exactText({ n: 1n, d: 3n }), '1/3');
  assert.equal(exactText({ n: 5n, d: 2n }), '2.5');
});

test('undefined problems return an error with a code, not an answer', () => {
  const zero = solve('5 / 0');
  assert.deepEqual([zero.status, zero.error], ['error', 'division_by_zero']);
  assert.equal(zero.result, undefined, 'no answer is invented');
  assert.equal(solve('2^100').error, 'exponent_too_large');
});

test('goals without a verified deterministic path are reported as needs_model, and no model is called', () => {
  for (const goal of ['write a poem about the sea', 'what is the capital of France', '']) {
    const r = solve(goal);
    assert.equal(r.status, 'needs_model', goal);
    assert.equal(r.model_calls, 0);
    assert.equal(r.result, undefined, 'no answer is invented');
  }
});

test('an arithmetic goal with no verified capability is not solved by the controller', () => {
  const r = solve('2+2', { registry: emptyRegistry() });
  assert.equal(r.status, 'needs_model');
  assert.match(r.reason, /not verified/);
});

test('a receipt traces the request: correlation id, route, capability, steps and latency', () => {
  const r = solve('12 × 17', { correlationId: 'test-corr-1' });
  assert.equal(r.correlation_id, 'test-corr-1');
  assert.equal(r.route, 'arithmetic');
  assert.equal(r.expression, '12 × 17');
  assert.equal(r.capability_version, 1);
  assert.equal(typeof r.latency_ms, 'number');
  assert.deepEqual(r.steps.map((s) => s.step), ['classify', 'select', 'exact', 'verify']);
});

test('classify admits only a bare sum; a sentence about maths goes to the model', () => {
  assert.equal(classify('what is 2 + 2?').kind, 'arithmetic');
  assert.equal(classify('Tell me about 12 times 17 in history').kind, 'unhandled');
  assert.equal(classify('x + 1').kind, 'unhandled');
});

test('answerForChat answers a sum with its receipt, and returns null for anything else', () => {
  const answer = answerForChat('CHE, what is 12 times 17?');
  assert.equal(answer.text, '204.');
  assert.equal(answer.status, 'verified');
  assert.equal(answer.receipt.model_calls, 0);
  assert.equal(answerForChat('What is the capital of Spain?'), null, 'no answer, so the model answers');
  assert.equal(answerForChat('5 / 0').text, 'Division by zero has no answer, sir.');
});
