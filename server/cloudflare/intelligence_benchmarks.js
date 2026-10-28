// CHE's failed intelligence benchmarks, kept with the evidence. A record holds the original response, the corrected result,
// the root cause and the retest outcome. A record never marks CHE as having learned: learning needs a later independent
// test that the answer now passes, and that test result is recorded separately.

import { solve } from './problem_controller.js';

export const INTELLIGENCE_TEST_1 = Object.freeze({
  id: 'intelligence-test-1-periodic-production',
  question: 'A machine produces 3 parts every 4 seconds. After every 12 parts, it stops for 5 seconds. Starting with no parts and no initial delay, what is the minimum time to produce exactly 100 parts?',
  original_response: { text: '301 seconds', verdict: 'failed' },
  corrected: {
    batched: '176 seconds (parts come out at the end of each batch of 3)',
    continuous: '173.33 seconds, exactly 520/3 (parts come out at a steady rate)',
    ambiguity: 'The two readings differ. The answer must state which assumption it uses.',
  },
  root_cause: [
    'The problem is not handled by the deterministic controller before this change, so the chat route sent it to the model. The model had no check, and its answer 301 treats each 3-part batch as a 9-second cycle.',
    'The owner\'s reading of the time as 176 seconds was not reproduced by any test, so the error could not be caught before it reached the owner.',
  ],
  fix: 'server/cloudflare/periodic_production.js solves the problem by simulation and by a closed form, and reports both readings when they agree. problem_controller.js routes the problem to it, so the model does not answer it.',
  regression_tests: ['periodic_production.test.mjs', 'problem_controller_route.test.mjs (periodic production)'],
  learned: false,
  learning_claim: 'None. The controller answers this question deterministically. CHE\'s model has not been retested on it, so no learning is claimed.',
});

/**
 * Retests the benchmark through the controller, recalculating the answer rather than repeating a stored result. Returns
 * the outcome for the record. The model is not retested here (no model is available offline), so that stays pending.
 */
export function retestIntelligenceTest1(record = INTELLIGENCE_TEST_1) {
  const receipt = solve(record.question);
  const expectedBatched = '176';
  const expectedContinuous = '173.33';
  const controller = receipt.status === 'verified'
    && receipt.production.batched.seconds === expectedBatched
    && receipt.production.continuous.seconds === expectedContinuous;
  return {
    controller: controller ? 'passed' : 'failed',
    controller_status: receipt.status,
    batched: receipt.production?.batched.seconds ?? null,
    continuous: receipt.production?.continuous.seconds ?? null,
    model: 'pending (no model call offline)',
    independent_test_for_learning: 'none recorded',
    learned: false,
  };
}
