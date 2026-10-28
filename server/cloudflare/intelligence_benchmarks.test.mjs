// CHE's failed intelligence benchmark record: the retest recalculates through the controller, and the record never
// claims learning without a later independent test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { INTELLIGENCE_TEST_1, retestIntelligenceTest1 } from './intelligence_benchmarks.js';

test('the record keeps the failed response and the corrected result, and claims no learning', () => {
  assert.equal(INTELLIGENCE_TEST_1.original_response.text, '301 seconds');
  assert.equal(INTELLIGENCE_TEST_1.original_response.verdict, 'failed');
  assert.equal(INTELLIGENCE_TEST_1.learned, false);
  assert.match(INTELLIGENCE_TEST_1.corrected.batched, /^176 seconds/);
  assert.match(INTELLIGENCE_TEST_1.corrected.continuous, /173\.33/);
  assert.ok(INTELLIGENCE_TEST_1.root_cause.length >= 1);
});

test('the controller retest recalculates the answer: it passes with 176 and 173.33, and the model stays pending', () => {
  const r = retestIntelligenceTest1();
  assert.equal(r.controller, 'passed');
  assert.equal(r.controller_status, 'verified');
  assert.equal(r.batched, '176');
  assert.equal(r.continuous, '173.33');
  assert.match(r.model, /pending/);
  assert.equal(r.learned, false);
});

test('a retest of a changed record fails when the recalculated answer differs', () => {
  const wrong = { ...INTELLIGENCE_TEST_1, question: INTELLIGENCE_TEST_1.question.replace('100 parts', '99 parts') };
  const r = retestIntelligenceTest1(wrong);
  assert.equal(r.batched !== '176' || r.continuous !== '173.33', true);
  assert.equal(r.learned, false);
});
