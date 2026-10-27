import test from 'node:test';
import assert from 'node:assert/strict';
import { planFuturesRisk } from './trading_risk_sizing.js';

test('MNQ long: tick value and friction limit whole-contract quantity', () => {
  const x = planFuturesRisk({ symbol: 'MNQ', side: 'long', entry: 20000, stop: 19990, accountEquity: 10000, riskPercent: 1, commissionRoundTrip: 4, slippageTicksRoundTrip: 2 });
  assert.equal(x.ok, true);
  assert.equal(x.tickValue, 0.5);
  assert.equal(x.stopRiskPerContract, 20);
  assert.equal(x.riskPerContract, 25);
  assert.equal(x.maxContracts, 4);
  assert.equal(x.mode, 'PAPER_PLANNING_ONLY');
});

test('ES short: caps budget and sizes by point value', () => {
  const x = planFuturesRisk({ symbol: 'ES', side: 'short', entry: 6000, stop: 6002, accountEquity: 50000, riskPercent: 2, maxRiskDollars: 350 });
  assert.equal(x.ok, true);
  assert.equal(x.riskBudget, 350);
  assert.equal(x.riskPerContract, 100);
  assert.equal(x.maxContracts, 3);
});

test('MES sizing uses $5 per point', () => {
  const x = planFuturesRisk({ symbol: 'MES', side: 'long', entry: 6000, stop: 5995, accountEquity: 5000, riskPercent: 1 });
  assert.equal(x.riskPerContract, 25);
  assert.equal(x.maxContracts, 2);
});

test('rejects inverted stops, unknown symbols, misaligned ticks and invalid assumptions', () => {
  const base = { symbol: 'NQ', side: 'long', entry: 20000, stop: 19999, accountEquity: 10000, riskPercent: 1 };
  for (const change of [
    { stop: 20001 }, { symbol: 'BTC' }, { entry: 20000.1 }, { riskPercent: 101 },
    { accountEquity: -1 }, { commissionRoundTrip: -1 }, { slippageTicksRoundTrip: NaN },
  ]) assert.equal(planFuturesRisk({ ...base, ...change }).ok, false);
});

test('does not force a trade when one contract exceeds budget', () => {
  const x = planFuturesRisk({ symbol: 'NQ', side: 'long', entry: 20000, stop: 19990, accountEquity: 1000, riskPercent: 1 });
  assert.equal(x.maxContracts, 0);
  assert.equal(x.blocked, true);
});
