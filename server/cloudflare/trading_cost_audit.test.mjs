// Cost arithmetic on journal records. FIXTURES below are labelled test data, built from the same formulas the engine
// uses (settleTrade in trading_evidence.js and the crypto rates in crypto_markets.js), so each expected value is derived
// here, not copied from the engine's output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { costExamples, explainTrade } from './trading_audit.js';

// FIXTURE: a BTC forward-paper crypto record, qty 0.01 coin, entry 60,000, stop 59,700 (0.5% away), stopped out.
// Spread: half of 100 ticks of 0.01 per side = 0.50 per coin per side. Slippage: 200 ticks = 2.00 per coin per side.
// Fees: taker 0.6% of each leg's value (both legs are market orders on a stop).
const qty = 0.01;
const btc = {
  id: 'fixture-btc-1', strategy: 'fixture-crypto', side: 'long', environment: 'paper', qty,
  entry: { time: '2026-10-20T14:05:00Z', raw: 60000, fill: 60000 }, exit: { time: '2026-10-20T14:40:00Z', raw: 59700, reason: 'stop' },
  stop: 59700, risk_dollars: 3.0, gross_before_costs: -3.0,
  costs: { spread: 0.01, slippage: 0.04, commissions: 0, fees: 7.18 }, net_pnl: -10.23, r_net: -3.41,
  data: { resolution: '5m' }, market: 'crypto', symbol: 'BTC',
};
// FIXTURE: an MNQ paper record, 12-point stop, one contract: $24 risk against about $5.50 of costs.
const mnq = {
  id: 'fixture-mnq-1', strategy: 'fixture-futures', side: 'long', environment: 'paper', qty: 1,
  entry: { time: '2026-10-20T14:05:00Z', raw: 21000, fill: 21000 }, exit: { time: '2026-10-20T14:40:00Z', raw: 20988, reason: 'stop' },
  stop: 20988, risk_dollars: 24, gross_before_costs: -24, costs: { spread: 0.5, slippage: 1, commissions: 3, fees: 1 }, net_pnl: -29.5, r_net: -1.23,
  data: { resolution: '5m' }, contract: 'MNQ',
};

test('the BTC fixture: risk, costs and cost per R are derived from the stop and the stored costs', () => {
  const e = explainTrade(btc);
  // stop distance 300 points of price; risk = 300 × 1 × 0.01 = $3.00
  assert.match(e.steps[0], /risk = 300 × 1 × 0\.01 = \$3\.00 \(stored \$3\.00\)/);
  // costs = 0.01 + 0.04 + 0 + 7.18 = 7.23
  assert.match(e.steps[1], /= \$7\.23/);
  // fee share: 7.18 ÷ ((60000 + 59700) × 0.01) ≈ 0.6% per leg, so about 0.6% of both legs' value
  assert.match(e.steps[2], /= 0\.600%/);
  // net = −3.00 − 7.23 = −10.23, which matches the stored net
  assert.match(e.steps[3], /net = gross -\$3\.00 − costs \$7\.23 = -\$10\.23 \(stored -\$10\.23; matches\)/);
  // cost per R = 7.23 ÷ 3.00 = 2.41R
  assert.equal(e.cost_r, 2.41);
  assert.match(e.steps[4], /cost per R = costs \$7\.23 ÷ risk \$3\.00 = 2\.410R/);
});

test('the MNQ fixture: its costs are a fraction of its risk, so it is not an examples case', () => {
  const e = explainTrade(mnq);
  assert.equal(e.market, 'futures');
  assert.ok(e.cost_r < 1, `MNQ cost per R is ${e.cost_r}, under one R`);
  assert.deepEqual(costExamples([mnq]), []);
});

test('examples are only records whose costs exceed their whole risk, spread across that range', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...btc, id: `btc-${i}`, costs: { spread: 0.01, slippage: 0.04, commissions: 0, fees: 1 + i } }));
  const picks = costExamples([mnq, ...many], 5);
  assert.equal(picks.length, 5);
  assert.ok(picks.every((p) => p.cost_r > 1));
  assert.ok(picks[0].cost_r < picks[4].cost_r, 'the examples run from the smallest to the largest cost per R');
});
