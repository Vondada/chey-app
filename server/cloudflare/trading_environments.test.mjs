import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, LIVE_TRADING_ENABLED, LIVE_TRADING_OFF, ledgerFor, fundedLimitsProblems, fundedOrderCheck, guardSubmit, liveOrderBlock, liveOrdersStatus, liveTradingEnabled } from './trading_environments.js';

const NOW = 1_000_000;
const order = {
  account_kind: 'funded', account: 'FYE-1', contract: 'MNQ', qty: 1, entry: 20000, stop: 19990, target: 20020, pointValue: 2,
};
const approval = { account: 'FYE-1', contract: 'MNQ', qty: 1, entry: 20000, stop: 19990, target: 20020, expires_at: NOW + 60_000 };
const limits = { maxContracts: 2, maxRiskDollars: 50 };

test('every environment is declared, and only broker environments can submit', () => {
  assert.deepEqual(Object.keys(ENVIRONMENTS).sort(), ['backtest', 'broker_sim', 'funded', 'paper']);
  assert.equal(ENVIRONMENTS.backtest.submitsOrders, false);
  assert.equal(ENVIRONMENTS.paper.submitsOrders, false);
  assert.equal(ENVIRONMENTS.broker_sim.submitsOrders, true);
  assert.equal(ENVIRONMENTS.funded.moneyAtRisk, true);
});

test('research ledgers are only backtest and paper', () => {
  assert.equal(ledgerFor('paper'), 'paper');
  assert.equal(ledgerFor('backtest'), 'backtest');
  assert.throws(() => ledgerFor('funded'), /no research ledger/);
  assert.throws(() => ledgerFor('broker_sim'), /no research ledger/);
});

test('backtest and paper runs never reach a broker, whatever the order says', () => {
  for (const env of ['backtest', 'paper']) {
    const g = guardSubmit(env, { ...order, account_kind: 'simulation' }, { approval, limits, now: NOW });
    assert.equal(g.allowed, false);
    assert.match(g.reason, /never submits/);
  }
});

test('a simulation run submits only to a simulation account', () => {
  assert.equal(guardSubmit('broker_sim', { ...order, account_kind: 'simulation' }).allowed, true);
  const g = guardSubmit('broker_sim', order);
  assert.equal(g.allowed, false);
  assert.match(g.reason, /simulation account/);
});

test('a funded run never submits to a simulation account', () => {
  const g = fundedOrderCheck({ ...order, account_kind: 'simulation' }, { approval, limits, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /funded account/);
});

test('funded orders are never unattended, even with approval', () => {
  const g = fundedOrderCheck(order, { approval, limits, unattended: true, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /never unattended/);
});

test('funded orders need owner-set risk limits', () => {
  assert.deepEqual(fundedLimitsProblems(null), ['owner has not set funded risk limits']);
  assert.deepEqual(fundedLimitsProblems({ maxContracts: 1 }), ['maxRiskDollars must be set']);
  assert.deepEqual(fundedLimitsProblems(limits), []);
  const g = fundedOrderCheck(order, { approval, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /owner has not set/);
});

test('funded orders need an approval for this exact order that has not expired', () => {
  assert.match(fundedOrderCheck(order, { limits, now: NOW }).reason, /no owner approval/);
  const expired = { ...approval, expires_at: NOW - 1 };
  assert.match(fundedOrderCheck(order, { approval: expired, limits, now: NOW }).reason, /expired/);
});

test('an approval for one order does not authorise a different one', () => {
  for (const key of ['account', 'contract', 'qty', 'entry', 'stop', 'target']) {
    const other = { ...order, [key]: key === 'account' || key === 'contract' ? 'OTHER' : order[key] + 1 };
    const g = fundedOrderCheck(other, { approval, limits, now: NOW });
    assert.equal(g.allowed, false, key);
    assert.match(g.reason, new RegExp(key));
  }
});

test('an approved order is still refused above the owner size or risk limits', () => {
  const big = { ...order, qty: 3 };
  assert.match(fundedOrderCheck(big, { approval: { ...approval, qty: 3 }, limits, now: NOW }).reason, /above the owner limit of 2/);
  const risky = { ...order, stop: 19950, pointValue: 2 };
  const riskApproval = { ...approval, stop: 19950 };
  const g = fundedOrderCheck(risky, { approval: riskApproval, limits, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /above the owner limit of \$50/);
});

test('an order that matches an unexpired approval and sits within limits passes the per-order checks', () => {
  const g = fundedOrderCheck(order, { approval, limits, now: NOW });
  assert.equal(g.allowed, true);
  assert.match(g.reason, /approved by the owner/);
});

// ─── Live kill switch (owner rule: no real-money trades until he separately approves and it is verified) ───

test('live trading is off in code: the constant is false and no env flag turns it on', () => {
  assert.equal(LIVE_TRADING_ENABLED, false);
  for (const env of [null, {}, { CHE_LIVE_TRADING_APPROVED: 'owner-approved-2026-10-24' }, { CHE_LIVE_TRADING_APPROVED: 'true' }, { CHE_LIVE_TRADING_APPROVED: '1' }]) {
    assert.equal(liveTradingEnabled(env), false, JSON.stringify(env));
    assert.equal(liveOrderBlock(env), LIVE_TRADING_OFF);
    assert.equal(liveOrdersStatus(env), 'disabled');
  }
  assert.equal(LIVE_TRADING_OFF, "Live trading is turned off in CHE's code until you separately approve it and it is verified; nothing was sent.");
});

test('guardSubmit refuses funded and live orders even with an exact approval, limits and the env flag', () => {
  const env = { CHE_LIVE_TRADING_APPROVED: 'owner-approved-2026-10-24' };
  for (const environment of ['funded', 'live']) {
    for (const opts of [{ approval, limits, now: NOW }, { approval, limits, now: NOW, env }, {}]) {
      const g = guardSubmit(environment, order, opts);
      assert.equal(g.allowed, false, environment);
      assert.equal(g.reason, LIVE_TRADING_OFF, environment);
    }
  }
});

test('the kill switch leaves simulation, paper and backtest exactly as they were', () => {
  assert.deepEqual(guardSubmit('broker_sim', { ...order, account_kind: 'simulation' }), { allowed: true, reason: 'simulation account' });
  assert.match(guardSubmit('paper', order).reason, /never submits/);
  assert.match(guardSubmit('backtest', order).reason, /never submits/);
});

test('an unknown environment is refused', () => {
  assert.equal(guardSubmit('sandbox', order).allowed, false);
});
