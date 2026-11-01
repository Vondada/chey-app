// Hypothetical trade expectancy: the figures a message supplies, calculated exactly. Expected values are worked out by
// hand in the comments. Several scenarios are used so no single example is hardcoded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTradeFigures, tradeExpectancy } from './trade_expectancy.js';

const OWNER = "A paper trading strategy made 100 trades: 70 wins averaging $4 each and 30 losses averaging $15 each. It has a 70% win rate. Should I keep running it? Calculate its expected profit per trade, identify what the win rate hides, and explain what additional evidence you need.";

test('the owner example: 70 x $4 - 30 x $15 = -$170, so -$1.70 per trade before costs', () => {
  const r = tradeExpectancy(OWNER);
  assert.equal(r.status, 'verified');
  assert.equal(r.expectancy, '-$1.70');
  assert.equal(r.total, '-$170.00');
  assert.equal(r.profitable, false);
  assert.equal(r.win_rate_pct, '70%');
  // break-even win rate = 15 / (4 + 15) = 1500/19 %
  assert.match(r.break_even_pct, /78\.95% \(exactly 1500\/19%\)/);
  assert.match(r.text, /Not on these figures/);
  assert.match(r.text, /What the win rate hides/);
  assert.match(r.text, /Evidence still needed/);
});

test('a different scenario: 20 wins of $10 and 20 losses of $6 is +$2 per trade, +$80 over 40 trades', () => {
  const r = tradeExpectancy('A strategy made 40 trades: 20 wins averaging $10 each and 20 losses averaging $6 each. What is the expected profit per trade?');
  assert.equal(r.status, 'verified');
  assert.equal(r.expectancy, '$2.00');
  assert.equal(r.total, '$80.00');
  assert.equal(r.break_even_pct, '37.5%');
  assert.equal(r.profitable, true);
});

test('win rate versus profitability: a 60% win rate with $10 wins and $4 losses is profitable, and 40% can be too', () => {
  // 0.6 x 10 - 0.4 x 4 = 6 - 1.6 = +4.40 ; break-even = 4 / 14 = 200/7 %
  const a = tradeExpectancy('Suppose a strategy has a 60% win rate, wins $10 and loses $4. What is the expectancy per trade?');
  assert.equal(a.expectancy, '$4.40');
  assert.equal(a.profitable, true);
  // 0.4 x 10 - 0.6 x 4 = 4 - 2.4 = +1.60 : a win rate below half can still make money
  const b = tradeExpectancy('A strategy has a 40% win rate, wins $10 and loses $4. Should I keep running it?');
  assert.equal(b.expectancy, '$1.60');
  assert.equal(b.profitable, true);
});

test('a high win rate can lose money: 70% with $4 wins and $15 losses (the owner example without the counts)', () => {
  const r = tradeExpectancy('A strategy has a 70% win rate, wins $4 and loses $15. Is it worth running?');
  assert.equal(r.expectancy, '-$1.70');
  assert.equal(r.profitable, false);
});

test('conflicting counts are refused, not calculated: 70 wins and 25 losses do not make 100 trades', () => {
  const r = tradeExpectancy('A strategy made 100 trades: 70 wins averaging $4 and 25 losses averaging $15. Expected profit?');
  assert.equal(r.status, 'conflict');
  assert.match(r.text, /make 95 trades, not 100/);
  assert.equal(r.expectancy, undefined);
});

test('a stated win rate that contradicts the counts is refused', () => {
  const r = tradeExpectancy('A strategy made 100 trades: 60 wins averaging $4 and 40 losses averaging $6. Win rate 70%. Expectancy?');
  assert.equal(r.status, 'conflict');
  assert.match(r.text, /60\.0%, not the 70% stated/);
});

test('a missing amount is asked for, never invented', () => {
  const r = tradeExpectancy('A strategy has a 70% win rate and wins $4. What is its expectancy?');
  assert.equal(r.status, 'needs_inputs');
  assert.ok(r.missing.some((m) => /average loss/.test(m)));
});

test('the owner\'s own records are not hypothetical: "my expectancy" goes to the journal routes', () => {
  assert.equal(tradeExpectancy("What's my expectancy so far?"), null);
  assert.equal(tradeExpectancy('What is my win rate in the paper journal?'), null);
  assert.equal(tradeExpectancy('how many paper trades today?'), null);
});

test('a message with no trade figures is not a hypothetical calculation', () => {
  assert.equal(tradeExpectancy('Explain expectancy in trading.'), null);
  assert.equal(tradeExpectancy('What is a good win rate?'), null);
});

test('figures are read literally, with no inference', () => {
  const f = parseTradeFigures('A paper trading strategy made 100 trades: 70 wins averaging $4 each and 30 losses averaging $15 each.');
  assert.deepEqual(f, { trades: 100, winCount: 70, winAvg: 4, lossCount: 30, lossAvg: 15, winRatePct: null });
});

// The owner's hypothetical no longer reaches the paper-journal evidence report; the owner's own questions still do.
import { evidenceIntent } from './trading_evidence_runner.js';
test('the evidence intent does not take a hypothetical with figures; it keeps the owner\'s own paper-trade questions', () => {
  assert.equal(evidenceIntent(OWNER), null);
  assert.deepEqual(evidenceIntent('how many paper trades today?'), { kind: 'evidence' });
  assert.deepEqual(evidenceIntent('what is my win rate?'), { kind: 'evidence' });
});

// Mixed-scope reporting: every dataset carries its own time range, taken from its own records.
import { entryRange } from './atlas_trading.js';
test('a dataset\'s time range comes from its own entry dates; an undated set says so', () => {
  assert.equal(entryRange([]), 'has no dated entries');
  assert.equal(entryRange([{ entry: { time: '2026-10-03T14:05:00Z' } }]), 'is 2026-10-03');
  assert.equal(entryRange([
    { entry: { time: '2026-10-09T10:00:00Z' } },
    { entry: { time: '2026-10-02T09:30:00Z' } },
    { entry: { time: 'not a date' } },
  ]), 'runs 2026-10-02 to 2026-10-09');
});

// Stable certification failure ti-25: "wins 60% of trades" was read as a $60 average win, so CHE asked for figures the
// message already gave. A percentage next to "of trades" or "of the time" is a win (or loss) rate, never an amount.
test('a percentage of trades or of the time is a rate, never a money amount', () => {
  const a = parseTradeFigures('This setup is right 45 percent of the time; winners average $3 and losers average $2. What is the expected value per trade?');
  assert.equal(a.winRatePct, 45);
  assert.equal(a.winAvg, 3);
  assert.equal(a.lossAvg, 2);
  const b = tradeExpectancy('This setup is right 45 percent of the time; winners average $3 and losers average $2. What is the expected value per trade?');
  assert.equal(b.status, 'verified');
  assert.equal(b.expectancy, '$0.25');
  const c = parseTradeFigures('A system loses 30% of its trades, wins $2 and loses $5.');
  assert.deepEqual([c.winRatePct, c.winAvg, c.lossAvg], [70, 2, 5]);
  const d = tradeExpectancy('A method wins 40% of the time with an average win of 3 and an average loss of 2. What is the expectancy?');
  assert.equal(d.expectancy, '$0.00');
  assert.match(d.text, /zero: it breaks even/);
  assert.match(d.text, /sits exactly on it/);
  // The figures of a money amount still read as before.
  const e = parseTradeFigures('A $4 average win and a $15 average loss at a 70% win rate.');
  assert.deepEqual([e.winRatePct, e.winAvg, e.lossAvg], [70, 4, 15]);
});
