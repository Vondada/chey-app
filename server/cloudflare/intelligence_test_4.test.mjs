// Intelligence Test 4 record: the failure is kept, the retest uses a different scenario, and no learning is claimed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { INTELLIGENCE_TEST_4, retestIntelligenceTest4 } from './intelligence_test_4.js';

test('the record keeps the failed response and the correct figures, and claims no learning', () => {
  assert.equal(INTELLIGENCE_TEST_4.original_response.verdict, 'failed');
  assert.match(INTELLIGENCE_TEST_4.original_response.text, /zero trades/);
  assert.match(INTELLIGENCE_TEST_4.original_response.text, /376 closed trades/);
  assert.equal(INTELLIGENCE_TEST_4.corrected.expectancy_per_trade, '-$1.70 before costs');
  assert.equal(INTELLIGENCE_TEST_4.learned, false);
  assert.ok(INTELLIGENCE_TEST_4.root_cause.length >= 2);
});

test('the retest on a different scenario passes through the controller, and the model stays pending', () => {
  const r = retestIntelligenceTest4();
  assert.equal(r.controller, 'passed');
  assert.equal(r.expectancy, '$1.60');
  assert.match(r.model, /pending/);
  assert.equal(r.learned, false);
});
