// The universal problem controller, first slice: deterministic answers are exact and cross-checked, and anything
// without a verified path is reported as needs_model, never answered from a guess.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARITHMETIC_ID, classify, evaluate, seedRegistry, solve } from './problem_controller.js';
import { emptyRegistry, serving } from './capability_registry.js';

// Hand-checked expected answers, one per problem. Each comes from school arithmetic, not from this code.
const KNOWN = [
  ['12 × 17', '204'],
  ['17 x 23', '391'],
  ['(7+8)*(9-4)', '75'],
  ['2+3*4', '14'],
  ['-2^2 + 5', '1'],
  ['2^-1', '1/2'],
  ['2^10 - 1', '1023'],
  ['1/3 + 1/6', '1/2'],
  ['0.1 + 0.2', '3/10'],
  ['100 / 8', '25/2'],
  ['3.5 * 4', '14'],
  ['2^64', '18446744073709551616'],
];

test('the seeded arithmetic capability is verified only through the registry promotion gate', () => {
  const registry = seedRegistry();
  assert.ok(serving(registry, ARITHMETIC_ID), 'a promoted capability serves');
  assert.equal(serving(emptyRegistry(), ARITHMETIC_ID), null, 'an unregistered capability never serves');
});

test('exact answers match hand-checked results and are cross-checked', () => {
  const registry = seedRegistry();
  for (const [goal, expected] of KNOWN) {
    const r = solve(goal, { registry });
    assert.equal(r.status, 'verified', goal);
    assert.equal(r.result, expected, goal);
    assert.equal(r.model_calls, 0, `${goal} must not call a model`);
    assert.equal(r.capability_id, ARITHMETIC_ID);
    assert.ok(r.steps.some((s) => s.step === 'float_cross_check' && s.result === 'agrees'), goal);
  }
});

test('precedence follows school arithmetic, including unary minus below power', () => {
  assert.equal(solve('-2^2').result, '-4');
  assert.equal(solve('2^3^2').result, '512', 'power is right-associative: 2^(3^2)');
  assert.equal(solve('10-4-3').result, '3', 'subtraction is left-associative');
});

test('undefined or malformed problems return an error, not an answer', () => {
  assert.deepEqual([solve('1/0').status, solve('1/0').error], ['error', 'division_by_zero']);
  assert.equal(solve('2^100').error, 'exponent_too_large');
  assert.equal(solve('(1+2').error, 'bad_expression');
  assert.equal(solve('1.2.3+1').error, 'bad_expression');
});

test('goals without a verified deterministic path are reported as needs_model and no model is called', () => {
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

test('a receipt traces the request: correlation id, route, selected capability and latency', () => {
  const r = solve('12 × 17', { correlationId: 'test-corr-1' });
  assert.equal(r.correlation_id, 'test-corr-1');
  assert.equal(r.route, 'arithmetic');
  assert.equal(r.expression, '12 * 17');
  assert.equal(r.capability_version, 1);
  assert.equal(typeof r.latency_ms, 'number');
  assert.deepEqual(r.steps.map((s) => s.step), ['classify', 'select', 'exact', 'float_cross_check']);
});

test('classify only admits plain arithmetic', () => {
  assert.equal(classify('what is 2 + 2?').kind, 'arithmetic');
  assert.equal(classify('2 + two').kind, 'unhandled');
  assert.equal(classify('x + 1').kind, 'unhandled');
});

test('evaluate runs the same parser over an exact and a float arithmetic', () => {
  const ops = {
    num: Number,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => a / b,
    pow: (a, b) => a ** b,
    neg: (a) => -a,
  };
  assert.equal(evaluate('(1+2)*3', ops), 9);
});
