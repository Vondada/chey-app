// Why paper trades lost, from recorded trades. FIXTURES below are labelled test data, not the owner's journal: each
// shape (a streak, a loss flipped by costs, a too-quick re-entry, a variant of the same entry) is built on purpose.
import assert from 'node:assert/strict';
import test from 'node:test';
import { improvementPlan, lossAnswer, lossIntent, lossReply, mainPattern, reviewLosses } from './trading_loss_review.js';
import { appendTrades } from './trading_evidence.js';
import { LEARNED_EXCLUSIONS } from './strategy_governor.js';

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

test('the owner\'s October look-back routes to a review: the month, the causes and what changed (run 42171612444)', () => {
  const now = Date.parse('2026-11-06T04:00:00Z');
  const owner = "Okay, is Che able to like tell me like what she did wrong from the past, like last month, the whole entire month of October, why she was trading so badly? And and what she's gonna do to improve.";
  assert.deepEqual(lossIntent(owner, now), { kind: 'review', month: 9 });
  assert.deepEqual(lossIntent('What did you do wrong trading in October, the whole month? Why were you trading so badly, and what are you going to do to improve?', now), { kind: 'review', month: 9 });
  assert.deepEqual(lossIntent('what did she do wrong last month in her trading', now), { kind: 'review', month: 9 }, 'last month is October on 6 November');
  assert.deepEqual(lossIntent('How will you improve your trading?', now), { kind: 'review', month: null });
  assert.equal(lossIntent('What went wrong with the music player?', now), null, 'not a trading question');
  assert.equal(lossIntent('Why are you losing so many trades?', now).kind, 'why_losing', 'the narrower question keeps its answer');
});

test('the improvement plan is read from the rules in force, says nothing is proven yet, and invents no number', () => {
  const plan = improvementPlan((id) => id);
  assert.match(plan, /^What I changed:/);
  for (const id of Object.keys(LEARNED_EXCLUSIONS)) assert.ok(plan.includes(id), id);
  assert.match(plan, /more than 0\.25 R of the risk or a winning trade would net under 1 R, checked again at the fill/);
  assert.match(plan, /wait 30 minutes after a stop-out/);
  assert.match(plan, /paused after 8 losses in a row, or once 15 trades show it losing/);
  assert.match(plan, /None of the setups I still trade has yet shown a profit after costs/);
  assert.match(plan, /paper trading is on and real money stays off/);
  assert.match(improvementPlan((id) => id, { halted: true }), /new paper entries are paused right now/);
});

test('a month review reads only that month\'s journal entries', async () => {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
  };
  const rec = (i, month) => ({
    source: 'paper', environment: 'paper', portfolio: `ema-pullback-5m|any@v1`, symbol: 'MNQ', contract: 'MNQ', qty: 1, strategy: 'ema-pullback-5m', filter: 'any',
    strategy_version: 'v1', params: { target_r: 2 }, side: 'long', session: 'mid-morning', signal: { time: `2026-${month}-0${i + 1}T14:00:00.000Z`, why: 'x', ref: 21000 },
    entry: { time: `2026-${month}-0${i + 1}T14:05:00.000Z`, raw: 21000, fill: 21000.5, spread: 0.125, slippage: 0.25, basis: 'next_bar_open' },
    stop: 20990, target: 21020, risk_points: 10, exit: { time: `2026-${month}-0${i + 1}T14:30:00.000Z`, raw: 20990, fill: 20989.5, reason: 'stop' },
    same_bar_both_touched: false, gross_before_costs: -20, costs: { spread: 0.5, slippage: 1, commissions: 3, fees: 1 }, net_pnl: -25.5, r_net: -1.27, r_gross: -1, risk_dollars: 20,
    mfe_points: 1, mae_points: 10, mfe_r: 0.1, mae_r: 1, data: { resolution: '5m', price_series: 'test', label: 'intraday 5m bars' }, cost_assumptions: {}, result: 'loss',
  });
  await appendTrades(storage, [rec(0, '09'), rec(1, '10'), rec(2, '10')]);
  const text = await lossAnswer(storage, 'What did you do wrong trading in October and how will you improve?');
  assert.match(text, /^For October: From the futures paper journal, 2 distinct entries, 0 won and 2 lost/, text.slice(0, 200));
  assert.match(text, /What I changed:/);
});
