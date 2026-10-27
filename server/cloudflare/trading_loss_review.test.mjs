// Why paper trades lost, from recorded trades. FIXTURES below are labelled test data, not the owner's journal: each
// shape (a streak, a loss flipped by costs, a too-quick re-entry, a variant of the same entry) is built on purpose.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lossIntent, lossReply, mainPattern, reviewLosses } from './trading_loss_review.js';

const S = 'ema-pullback-5m';
// A closed paper trade, shaped like the journal's records (only the fields the review reads).
const trade = (id, { at = '2026-10-21T14:05:00Z', exitAt = '2026-10-21T14:30:00Z', net = -10, gross = null, reason = 'stop', strategy = S, filter = 'any', feed = 'DELAYED' } = {}) => ({
  id, strategy, filter, side: 'long', environment: 'paper', net_pnl: net, r_net: net / 10,
  costs: { spread: 1, slippage: 1, commissions: 1, fees: 0 }, gross_before_costs: gross ?? net + 3,
  entry: { time: at, raw: 21000, fill: 21001 }, exit: { time: exitAt, reason },
  data: { resolution: '5m', entry_feed: { status: feed, authenticated: feed === 'LIVE', subscription_verified: feed === 'LIVE' } },
});
const name = (id) => (id === S ? 'EMA pullback' : id);

test('three losses in a row from one setup are a streak, and a win ends it', () => {
  const r = reviewLosses([
    trade('a', { at: '2026-10-21T14:05:00Z' }), trade('b', { at: '2026-10-21T15:05:00Z' }),
    trade('c', { at: '2026-10-21T16:05:00Z' }), trade('d', { at: '2026-10-21T17:05:00Z', net: 20, reason: 'target' }),
  ], { name });
  assert.equal(r.streaks.length, 1);
  assert.equal(r.streaks[0].length, 3);
  assert.deepEqual(r.streaks[0].ids, ['a', 'b', 'c']);
  assert.equal(r.losses, 3);
  assert.equal(r.wins, 1);
});

test('a loss that was profitable before costs is counted as flipped by costs, with its record id', () => {
  const r = reviewLosses([trade('cost', { net: -2, gross: 3 }), trade('real', { at: '2026-10-21T16:05:00Z', net: -20, gross: -17 })], { name });
  assert.equal(r.flipped_by_costs.count, 1);
  assert.deepEqual(r.flipped_by_costs.ids, ['cost']);
});

test('a re-entry within 30 minutes of a stop-out from the same setup is a too-quick re-entry', () => {
  const r = reviewLosses([
    trade('stopped', { at: '2026-10-21T14:05:00Z', exitAt: '2026-10-21T14:20:00Z' }),
    trade('again', { at: '2026-10-21T14:35:00Z' }),
    trade('later', { at: '2026-10-21T18:00:00Z' }),
  ], { name });
  assert.equal(r.quick_reentries.length, 1);
  assert.equal(r.quick_reentries[0].id, 'again');
  assert.equal(r.quick_reentries[0].after, 'stopped');
});

test('a variant that took the same market entry is counted once, as in the status answer', () => {
  const r = reviewLosses([trade('v1', { filter: 'any' }), trade('v2', { filter: 'trend' })], { name });
  assert.equal(r.entries, 1);
  assert.equal(r.losses, 1);
});

test('a strategy with fewer than 10 entries has no recent-versus-prior trend yet', () => {
  const r = reviewLosses([trade('x')], { name });
  assert.equal(r.strategies[0].trend, 'not enough entries to compare a recent stretch');
});

test('the owner question routes to the right loss answer, and unrelated questions do not', () => {
  assert.deepEqual(lossIntent('CHE, why are you losing so many trades?'), { kind: 'why_losing' });
  assert.deepEqual(lossIntent('Why were you losing more trades than winning?'), { kind: 'why_losing' });
  assert.deepEqual(lossIntent('What was your biggest trading mistake?'), { kind: 'mistake' });
  assert.deepEqual(lossIntent('Why did you keep taking losing trades?'), { kind: 'repeat' });
  assert.deepEqual(lossIntent('Which strategy was hurting you the most?'), { kind: 'worst' });
  assert.deepEqual(lossIntent('Which strategy is likely to do better?'), { kind: 'best' });
  assert.equal(lossIntent('Analyze EMA Pullback New York morning versus overnight'), null);
  assert.equal(lossIntent('Tell me a joke about traffic'), null);
  // Single-trade and market-specific questions keep their own routes.
  assert.equal(lossIntent('explain why that trade lost'), null);
  assert.equal(lossIntent('help me understand which strategy is performing best on MNQ'), null);
  assert.equal(lossIntent('How many paper trades have you won and lost so far, which strategy is performing best, and is paper trading still on?'), null);
});

test('the spoken answer cites the recorded counts, names the pattern, and says what is not measured', () => {
  const review = { market: 'futures', ...reviewLosses([
    trade('cost', { net: -2, gross: 3 }),
    trade('a', { at: '2026-10-21T15:05:00Z' }), trade('b', { at: '2026-10-21T16:05:00Z' }), trade('c', { at: '2026-10-21T17:05:00Z' }),
  ], { name }) };
  const why = lossReply('why_losing', review);
  assert.match(why, /From the futures paper journal, 4 distinct entries, 0 won and 4 lost/);
  // Four losses in a row from one setup outweigh the single loss that costs flipped: the streak is the clearer pattern.
  assert.match(why, /The clearest pattern is streaks: 1 run of three or more losses in a row from one setup, the longest 4 losses from EMA pullback\./);
  assert.equal(review.flipped_by_costs.count, 1);
  assert.match(why, /Not measured from these records: market direction and choppy conditions\./);
  assert.match(lossReply('repeat', review), /I see 1 losing streak of three or more from one setup/);
  assert.match(lossReply('best', review), /No strategy has 30 entries yet/);
});

test('an empty journal says so, and invents no loss', () => {
  const review = { market: 'futures', ...reviewLosses([], { name }) };
  assert.equal(lossReply('why_losing', review), 'No paper trades are recorded in this journal yet, sir, so there are no losses to explain.');
  assert.equal(mainPattern(review), null);
});
