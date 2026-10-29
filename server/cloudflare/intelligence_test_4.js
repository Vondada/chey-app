// Intelligence Test 4: hypothetical trading expectancy. The record keeps the failed response, the correct figures, the
// root cause and a retest on a different scenario. It never marks CHE as having learned: learning needs a later
// independent test that CHE passes on its own model, and none is recorded here.

import { tradeExpectancy } from './trade_expectancy.js';

export const INTELLIGENCE_TEST_4 = Object.freeze({
  id: 'intelligence-test-4-hypothetical-expectancy',
  question: 'A paper trading strategy made 100 trades: 70 wins averaging $4 each and 30 losses averaging $15 each. It has a 70% win rate. Should I keep running it? Calculate its expected profit per trade, identify what the win rate hides, and explain what additional evidence you need.',
  original_response: {
    text: 'CHE answered from paper-journal status: zero trades in one evidence pass, and 376 closed trades across 22 portfolios. It did not use the supplied figures.',
    verdict: 'failed',
  },
  corrected: {
    expectancy_per_trade: '-$1.70 before costs',
    total: '-$170.00 (70 x $4 - 30 x $15)',
    break_even_win_rate: '78.95% (1500/19 %)',
    point: 'A 70% win rate loses money here because the losses are larger than the wins.',
  },
  root_cause: [
    'evidenceIntent() in trading_evidence_runner.js matched "paper", "trading", "strategy", "win rate" and "profit" in the owner\'s message, and the chat route returned the paper-journal report before any hypothetical calculation could run.',
    'The paper-journal report printed two scopes under one heading (the daily evidence pass with 0 trades, and the forward-paper journal with 376 trades) and did not explain that they measure different things.',
  ],
  fix: 'trade_expectancy.js calculates from the figures the message supplies, and the controller routes it before any journal route. evidenceIntent() returns null for a message that supplies figures. The report names each scope.',
  regression_tests: ['trade_expectancy.test.mjs', 'problem_controller_route.test.mjs (hypothetical trade figures)', 'atlas_audit.test.mjs and trading_live.test.mjs (scope labels)'],
  learned: false,
  learning_claim: 'None. The figures are now calculated deterministically. CHE\'s model has not been retested on this wording, so no learning is claimed.',
});

/**
 * Retests on a different scenario, so the record is not a copy of the owner's example. Expected values are worked out
 * in the comments: 0.4 x $10 - 0.6 x $4 = +$1.60 per trade; break-even = 4 / 14 = 28.57%.
 */
export function retestIntelligenceTest4() {
  const r = tradeExpectancy('A strategy has a 40% win rate, wins $10 and loses $4. Should I keep running it?');
  const passed = r.status === 'verified' && r.expectancy === '$1.60' && r.break_even_pct === '28.57% (exactly 200/7%)';
  return {
    controller: passed ? 'passed' : 'failed',
    controller_status: r.status,
    expectancy: r.expectancy,
    break_even_pct: r.break_even_pct,
    model: 'pending (no model call offline)',
    independent_test_for_learning: 'none recorded',
    learned: false,
  };
}
