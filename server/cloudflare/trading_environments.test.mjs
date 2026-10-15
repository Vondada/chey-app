import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENTS, ledgerFor, fundedLimitsProblems, guardSubmit } from './trading_environments.js';

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
  const g = guardSubmit('funded', { ...order, account_kind: 'simulation' }, { approval, limits, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /funded account/);
});

test('funded orders are never unattended, even with approval', () => {
  const g = guardSubmit('funded', order, { approval, limits, unattended: true, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /never unattended/);
});

test('funded orders need owner-set risk limits', () => {
  assert.deepEqual(fundedLimitsProblems(null), ['owner has not set funded risk limits']);
  assert.deepEqual(fundedLimitsProblems({ maxContracts: 1 }), ['maxRiskDollars must be set']);
  assert.deepEqual(fundedLimitsProblems(limits), []);
  const g = guardSubmit('funded', order, { approval, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /owner has not set/);
});

test('funded orders need an approval for this exact order that has not expired', () => {
  assert.match(guardSubmit('funded', order, { limits, now: NOW }).reason, /no owner approval/);
  const expired = { ...approval, expires_at: NOW - 1 };
  assert.match(guardSubmit('funded', order, { approval: expired, limits, now: NOW }).reason, /expired/);
});

test('an approval for one order does not authorise a different one', () => {
  for (const key of ['account', 'contract', 'qty', 'entry', 'stop', 'target']) {
    const other = { ...order, [key]: key === 'account' || key === 'contract' ? 'OTHER' : order[key] + 1 };
    const g = guardSubmit('funded', other, { approval, limits, now: NOW });
    assert.equal(g.allowed, false, key);
    assert.match(g.reason, new RegExp(key));
  }
});

test('an approved order is still refused above the owner size or risk limits', () => {
  const big = { ...order, qty: 3 };
  assert.match(guardSubmit('funded', big, { approval: { ...approval, qty: 3 }, limits, now: NOW }).reason, /above the owner limit of 2/);
  const risky = { ...order, stop: 19950, pointValue: 2 };
  const riskApproval = { ...approval, stop: 19950 };
  const g = guardSubmit('funded', risky, { approval: riskApproval, limits, now: NOW });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /above the owner limit of \$50/);
});

test('an order that matches an unexpired approval and sits within limits is allowed', () => {
  const g = guardSubmit('funded', order, { approval, limits, now: NOW });
  assert.equal(g.allowed, true);
  assert.match(g.reason, /approved by the owner/);
});

test('an unknown environment is refused', () => {
  assert.equal(guardSubmit('sandbox', order).allowed, false);
});
