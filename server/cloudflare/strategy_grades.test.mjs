// Strategy Matrix grades (owner, 2026-10-27): no Good or Strong without a passed look-ahead audit and a positive
// whole-history expectancy; a valid strategy never becomes Weak or Good on invented numbers. Synthetic units only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matrixState } from './trading_research.js';

const unit = (all, oos, extra = {}) => ({
  ok: true, strategy_id: 'demo', market: 'MNQ', timeframe: '15m',
  all: { trades: 200, expectancy_r: 0.05, win_rate: 0.5, pf: 1.1, max_dd_r: 10, ...all },
  oos: { trades: 20, expectancy_r: 0.1, pf: 1.4, ...oos },
  recent: { trades: 40, expectancy_r: 0.05 }, folds_total: 5, folds_positive: 3, look_ahead: 'passed', ...extra,
});

test('a strategy that loses money over its whole history is never Good, even with a winning unseen slice', () => {
  assert.notEqual(matrixState(unit({ expectancy_r: -0.12, pf: 0.8 }, { expectancy_r: 0.1 })), 'Good');
  assert.notEqual(matrixState(unit({ expectancy_r: -0.12, pf: 0.8 }, { expectancy_r: 0.1 })), 'Strong');
  assert.equal(matrixState(unit({ expectancy_r: -0.12, pf: 0.8 }, { expectancy_r: 0.1 })), 'Fair');
});

test('a strategy whose look-ahead audit did not run is never Good or Strong', () => {
  assert.equal(matrixState(unit({}, { expectancy_r: 0.4, pf: 2 }, { look_ahead: 'not enough bars' })), 'Learning');
});

test('a validated, profitable strategy is still Good or Strong', () => {
  assert.equal(matrixState(unit({ expectancy_r: 0.05 }, { expectancy_r: 0.1, pf: 1.4 })), 'Good');
  assert.equal(matrixState(unit({ expectancy_r: 0.05 }, { expectancy_r: 0.4, pf: 2 })), 'Strong');
});

test('a losing unseen result is Weak, and a small loss is Fair (not a labelled win)', () => {
  assert.equal(matrixState(unit({ expectancy_r: -0.2 }, { trades: 20, expectancy_r: -0.2 })), 'Weak');
  assert.equal(matrixState(unit({ expectancy_r: -0.04 }, { trades: 50, expectancy_r: -0.04 })), 'Fair');
});

test('a failed look-ahead audit is shown as failed, never as a grade', () => {
  assert.equal(matrixState(unit({}, {}, { look_ahead: 'FAILED' })), 'Audit failed');
});
