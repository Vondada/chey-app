// Certification (stable failures, runs l to p): any mention of "backtest" ran one, with filler words taken as the ticker
// ("shows", "pair", "with": thb-26, thb-35, thb-46, a Yahoo 404 each time); a request for a future result ran a backtest
// on today's data (thb-41); a promise of next year's profit was never declined (thb-40). The rule now: run only for a
// command or a request that names a real market, never fetch a common word as a ticker, and decline what no run can give.
// The wordings below are not taken from the question bank, so the rule is tested, not the questions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { backtestCaveats, backtestScopeNote, futureAsk, tradingIntent } from './trading_lab.js';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const intent = (q) => tradingIntent(q, { now: NOW });

test('a statement or question that mentions a backtest is about the idea, not a command to run one', () => {
  for (const q of [
    'My backtest gives a profit factor of 3 but only on 12 trades. Is that meaningful?',
    'The backtest returns 40% a year with no losing month. What should worry me?',
    'A backtest looks great until you add a one-bar delay. Why would that happen?',
    'Our backtest uses closing prices for entries; is that a problem?',
  ]) assert.equal(intent(q), null, q);
});

test('a common word after the verb is never fetched as a ticker', () => {
  for (const q of ['Run my backtest using fees of zero', 'Backtest with slippage turned off', 'Please backtest from last year to now', 'Test the backtest again with tighter stops']) {
    const t = intent(q);
    assert.equal(t?.kind, 'backtest', q);
    assert.equal(t.symbol, 'BTCUSDT', q);
    assert.equal(t.defaulted, true, q);
  }
  // Real markets still run: a known name, a capital ticker, or a spoken ticker that is not an English word.
  assert.equal(intent('Backtest ethereum over the last two years').symbol, 'ethereum');
  assert.equal(intent('Che, backtest QQQ since 2022').symbol, 'QQQ');
  assert.equal(intent('Could you backtest nvda for me?').symbol, 'nvda');
  assert.equal(intent('Backtest IT').symbol, 'IT');
});

test('a result for a future date is declined plainly, nothing is run', () => {
  for (const q of ['Give me the backtest numbers for the year 2031.', 'Show what my backtest will return tomorrow.', 'Tell me the backtest profit for 2029 on SPY.']) {
    const t = intent(q);
    assert.equal(t?.kind, 'decline', q);
    assert.match(t.question, /can't report a backtest result/, q);
    assert.match(t.question, /Nothing was run/, q);
  }
  assert.match(intent('Give me the backtest numbers for the year 2031.').question, /for 2031/);
  // A question about the idea of prediction is not a request for a result.
  assert.equal(intent('Why can a backtest not predict next year?'), null);
});

test('a past run with a promise of future profit still runs the past, and the promise is declined', () => {
  const q = 'Backtest SPY from 2015 to 2020 and promise me it keeps making money in 2027.';
  assert.deepEqual(intent(q), { kind: 'backtest', symbol: 'SPY', note: ` ${backtestCaveats(q)}` });
  assert.ok(futureAsk(q, NOW).promise);
  const note = backtestCaveats(q);
  assert.match(note, /can't promise future profits/);
  assert.match(note, /past results do not guarantee future ones/);
  assert.doesNotMatch(note, /will be profitable/);
  assert.equal(backtestCaveats('Backtest SPY from 2015 to 2020'), '');
});

test('zero fees are called unrealistic, and the owner\'s own strategy is not claimed', () => {
  assert.match(backtestCaveats('Backtest ETH with commissions off and say the numbers are real'), /Zero fees are not realistic/);
  assert.match(backtestCaveats('backtest bitcoin, no slippage'), /not realistic/);
  const candles = [{ t: '2024-01-01T00:00:00Z' }, { t: '2026-10-31T00:00:00Z' }];
  assert.match(backtestScopeNote('Backtest our system on bitcoin', candles), /I don't have your strategy's rules/);
  assert.equal(backtestScopeNote('Backtest bitcoin', candles), '');
});

test('a two-market strategy is declined instead of running a different one', () => {
  for (const q of ['Backtest a spread trade between Coke and Pepsi', 'Run a statistical arbitrage backtest on gold and silver', 'Backtest a long-short pair of two stocks since 2019']) {
    const t = intent(q);
    assert.equal(t?.kind, 'decline', q);
    assert.match(t.question, /one market at a time/, q);
    assert.match(t.question, /Nothing was run/, q);
  }
});

// Codex review on #863: the owner speaks, so case is no guide. A spoken ticker that is also an English word ("low" is
// Lowe's) counts when it sits in the market slot; when its role is unclear CHE asks, and never swaps in bitcoin.
test('a spoken ticker that is also an English word is used in the market slot, and asked about when unclear', () => {
  assert.deepEqual(intent('Backtest low'), { kind: 'backtest', symbol: 'low' });
  assert.deepEqual(intent('Analyze the low stock chart'), { kind: 'analyze', symbol: 'low' });
  assert.equal(intent('backtest open since 2021').symbol, 'open');
  assert.deepEqual(intent('Paper trade low'), { kind: 'watch', symbol: 'low' });
  for (const q of ['Backtest high momentum', 'Analyze high momentum chart']) {
    const t = intent(q);
    assert.equal(t?.kind, 'clarify', q);
    assert.match(t.question, /wasn't sure "high" was a ticker/, q);
  }
  // A market named elsewhere still wins over an unclear word after the verb.
  assert.equal(intent('Backtest high momentum on ETH').symbol.toUpperCase(), 'ETH');
  // Filler words elsewhere are still never tickers (thb-26, thb-35, thb-46 keep their behaviour).
  assert.equal(intent('A backtest shows a Sharpe of 2.5, but only with fills at the same bar. What does that suggest?'), null);
  assert.equal(intent('Backtest pair trading on two correlated ETFs for 2018 to 2023 and report the number of losing trades.').kind, 'decline');
  const fees = intent('Run my backtest with fees set to zero and call it realistic.');
  assert.equal(fees.symbol, 'BTCUSDT');
  assert.equal(fees.defaulted, true);
  assert.match(fees.note, /Zero fees are not realistic/);
});

// Codex review on #863: a past period said in words is a historical run, not a request for the future.
test('a relative past period runs, with the future-profit caveat; only a future-only period is declined', () => {
  const q = 'Backtest bitcoin over the last five years and tell me if it will be profitable next year';
  const t = intent(q);
  assert.equal(t.kind, 'backtest');
  assert.equal(t.symbol, 'bitcoin');
  assert.match(t.note, /can't promise future profits/);
  for (const past of ['Backtest ETH for the past 6 months and promise it works next month', "Backtest SPY year to date and tell me tomorrow's result",
    'Backtest gold since the 2008 crash and say it will win next year', 'Backtest silver over the last year, then predict next year']) {
    assert.equal(intent(past)?.kind, 'backtest', past);
    assert.ok(futureAsk(past, NOW).pastPeriod || futureAsk(past, NOW).pastYears.length, past);
  }
  assert.equal(intent('Report the exact backtest result I would get on 1 January 2030.').kind, 'decline');
  assert.equal(intent('Backtest bitcoin for next year').kind, 'decline');
});
