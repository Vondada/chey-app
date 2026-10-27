// "Why are there no new trades appearing?" from stored records only: five facts, one count per market entry across
// variants, delayed and verified-live kept apart, and the blocked reason taken from the last scheduler run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { newTradesIntent, tradingStatus } from './trading_status.js';
import { LIVE_FEED, LIVE_RUNS, LIVE_STATE } from './trading_live.js';
import { RECORD_PREFIX } from './trading_evidence.js';

const storeWith = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    get: async (k) => map.get(k),
    put: async (k, v) => map.set(k, v),
    list: async ({ prefix = '' } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
};
// One closed paper trade, shaped like the journal's records (fields the summary reads).
const trade = (id, { variant = 'any', time = '2026-10-21T14:05:00Z', pnl = 40, feed = 'LIVE', strategy = 'ema-pullback-5m' } = {}) => [
  `${RECORD_PREFIX}${id}`, {
    id, strategy, filter: variant, side: 'long', environment: 'paper', net_pnl: pnl, r_net: pnl / 20,
    costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 },
    entry: { time, price: 21000 }, exit: { time: '2026-10-21T14:30:00Z', reason: 'target' },
    params: { target_r: 2 }, data: { resolution: '5m', entry_feed: { status: feed, authenticated: feed === 'LIVE', subscription_verified: feed === 'LIVE' } },
  }];

test('the owner\'s exact question routes to the trading status, and a strategy analysis does not', () => {
  assert.deepEqual(newTradesIntent('Why are there no new trades appearing?'), { kind: 'why_no_trades' });
  assert.deepEqual(newTradesIntent('CHE, why aren\'t you taking any new trades?'), { kind: 'why_no_trades' });
  assert.equal(newTradesIntent('Analyze EMA Pullback New York morning versus overnight'), null);
});

test('with paper trading off, the answer says so and gives the reason, with no invented trade', async () => {
  const out = await tradingStatus(storeWith({ [LIVE_STATE]: { enabled: false } }));
  assert.equal(out.ok, true);
  assert.match(out.text, /^Why no new trades, sir\./);
  assert.match(out.text, /5\. Blocked because: Paper trading is off/);
  assert.match(out.text, /2\. Trades: 0 distinct market entries/);
});

test('a variant that took the same market entry is counted once, in the trade count and in P&L', async () => {
  const store = storeWith({
    [LIVE_STATE]: { enabled: true },
    ...Object.fromEntries([trade('a', { variant: 'any' }), trade('b', { variant: 'trend' })]),
  });
  const out = await tradingStatus(store);
  assert.match(out.text, /2\. Trades: 1 distinct market entries \(1 variant record of the same entries counted once\)/);
  assert.match(out.text, /3\. P&L: \$40\.00 net across those entries\./);
  assert.equal(out.trades, 1);
});

test('delayed-paper and verified live-forward entries are reported apart, never added together', async () => {
  const store = storeWith({
    [LIVE_STATE]: { enabled: true },
    ...Object.fromEntries([trade('live', { time: '2026-10-21T14:05:00Z', feed: 'LIVE' }), trade('late', { time: '2026-10-21T15:05:00Z', feed: 'DELAYED' })]),
  });
  const out = await tradingStatus(store);
  assert.match(out.text, /Delayed-paper entries: 1\. Verified live-forward entries: 1\./);
  assert.match(out.text, /2\. Trades: 2 distinct market entries/);
});

test('the blocked reason is the last scheduler run\'s own gate and feed, with its time', async () => {
  const store = storeWith({
    [LIVE_STATE]: { enabled: true },
    [LIVE_RUNS]: [{ at: '2026-10-21T16:00:00Z', ok: false, entries_allowed: false, entry_quality: null,
      entry_blocker: 'New forward-paper entries need delayed or real-time CME bars. Stale, replayed or unavailable data cannot open positions.' }],
    [LIVE_FEED]: { status: 'UNAVAILABLE', checked_at: '2026-10-21T15:59:00Z' },
  });
  const out = await tradingStatus(store);
  assert.match(out.text, /5\. Blocked because: The last scheduler run at 2026-10-21 16:00 UTC opened no entries\. New forward-paper entries need delayed or real-time CME bars/);
  assert.match(out.text, /The feed then was UNAVAILABLE \(checked 2026-10-21 15:59 UTC\)\./);
});

test('a last run that failed says it failed, with its error', async () => {
  const store = storeWith({
    [LIVE_STATE]: { enabled: true },
    [LIVE_RUNS]: [{ at: '2026-10-21T16:00:00Z', ok: false, error: 'data refused: bar gap' }],
  });
  const out = await tradingStatus(store);
  assert.match(out.text, /The last scheduler run at 2026-10-21 16:00 UTC failed: data refused: bar gap/);
});
