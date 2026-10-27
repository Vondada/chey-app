import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS, findProgram, drawdownRoom, dailyAllowance, evaluationState, orderAllowed } from './prop_rules.js';

const fy = findProgram('fundyouredge-prime-25k');
const withLimit = { ...fy, daily_loss_limit: 500, min_trading_days: 3 };

test('every program carries an explicit verification status and a source', () => {
  for (const p of PROGRAMS) {
    assert.ok(['unverified', 'verified'].includes(p.verification.status));
    assert.match(p.verification.source_url, /^https:\/\//);
  }
});

test('a program that is not verified is never reported as verified', () => {
  assert.equal(evaluationState(fy, { balance: 25000 }).verification, 'unverified');
});

test('an end-of-day trailing drawdown follows the highest end-of-day balance', () => {
  const d = drawdownRoom(fy, { balance: 25500, peak: 26000 });
  assert.equal(d.floor, 25000);
  assert.equal(d.room, 500);
});

test('a static drawdown is measured from the starting balance', () => {
  const d = drawdownRoom({ ...fy, drawdown_type: 'static' }, { balance: 25800, peak: 26500 });
  assert.equal(d.floor, 24000);
  assert.equal(d.room, 1800);
});

test('an intraday trailing drawdown uses the day low when it is higher than the peak floor', () => {
  const d = drawdownRoom({ ...fy, drawdown_type: 'trailing_intraday' }, { balance: 25200, peak: 25600, day_low: 25300 });
  assert.equal(d.floor, 24300);
  assert.equal(d.room, 900);
});

test('the profit target remaining counts down and reaches zero at the target', () => {
  assert.equal(evaluationState(fy, { balance: 25400 }).profit_target_remaining, 1100);
  assert.equal(evaluationState(fy, { balance: 26500 }).profit_target_remaining, 0);
});

test('breaching the drawdown is a failed evaluation with no trading left', () => {
  const e = evaluationState(fy, { balance: 24000, peak: 25000 });
  assert.equal(e.trading_allowed, false);
  assert.match(e.blockers[0], /failed/);
});

test('a daily loss limit reduces today\'s allowance and stops trading when used up', () => {
  assert.deepEqual(dailyAllowance(withLimit, { day_pnl: -200 }), { limited: true, allowance: 500, left: 300 });
  assert.equal(evaluationState(withLimit, { balance: 25300, peak: 25300, day_pnl: -500 }).trading_allowed, false);
});

test('no daily limit is reported as unlimited, not as zero', () => {
  assert.equal(dailyAllowance(fy, { day_pnl: -900 }).limited, false);
});

test('a passed evaluation needs the target and the minimum trading days', () => {
  assert.equal(evaluationState(withLimit, { balance: 26500, peak: 26500, trading_days: 2 }).passed, false);
  assert.equal(evaluationState(withLimit, { balance: 26500, peak: 26500, trading_days: 3 }).passed, true);
});

test('an order is refused when its stop is more than the drawdown room or today\'s allowance', () => {
  const state = { balance: 25600, peak: 25600, day_pnl: -100 };
  assert.equal(orderAllowed(withLimit, state, { risk_dollars: 200 }).ok, true);
  assert.match(orderAllowed(withLimit, state, { risk_dollars: 450 }).reason, /today's/);
  assert.match(orderAllowed(fy, { balance: 24400, peak: 25100 }, { risk_dollars: 350 }).reason, /drawdown room/);
});
