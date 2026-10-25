// Trading Room v3 (owner, 2026-10-25): the dashboard's account records, the unified ALL | FUTURES | CRYPTO P&L
// calendar (New York time, futures on the CME trading date) and the "is the feed live" answers. Stored records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsView, instrumentOf, speakUnified, tradeDateOf, unifiedCalendar } from './trading_accounts.js';
import { tradingCalendar } from './che_calendars.js';
import { feedLiveIntent, speakFeedLive, tradingConnections } from './trading_connections.js';
import { deskIntent } from './trading_desk.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const memStorage = (m = new Map()) => ({
  saved: m,
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
  put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
  delete: async (k) => m.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
});

// A forward paper record shaped like trading_evidence closeAt (che_calendars.test.mjs uses the same shape).
function rec({ strategy = 'ema-pullback-5m', entry, exit, raw = 21000, exitRaw = 21010, reason = 'target', crypto = false, env = 'paper' } = {}) {
  const pv = crypto ? 0.01 : 2;
  const gross = Math.round((exitRaw - raw) * pv * 100) / 100;
  const costs = { spread: 0.5, slippage: 0.5, commissions: crypto ? 0 : 3, fees: 1 };
  const net = Math.round((gross - 5 + (crypto ? 3 : 0)) * 100) / 100;
  return {
    source: env, environment: env, portfolio: `${strategy}|any@v1|2`, symbol: crypto ? 'BTC-USD' : 'MNQ', contract: crypto ? 'BTC' : 'MNQ', qty: 1, ...(crypto ? { market: 'crypto' } : {}),
    strategy, filter: 'any', strategy_version: 'v1', params: { target_r: 2 }, side: 'long', session: 'x',
    signal: { time: entry, why: 'test', ref: raw },
    entry: { time: entry, raw, fill: raw, spread: 0.25, slippage: 0.25, basis: 'next_bar_open' },
    stop: raw - 10, target: raw + 20, risk_points: 10,
    exit: { time: exit, raw: exitRaw, fill: exitRaw, reason },
    gross_before_costs: gross, costs, net_pnl: net, r_net: Math.round((net / (10 * pv)) * 10000) / 10000, risk_dollars: 10 * pv,
    data: { resolution: '5m', label: 'intraday 5m' }, cost_assumptions: {}, result: net > 0 ? 'win' : net < 0 ? 'loss' : 'flat',
  };
}
const put = (m, r) => m.set(`evr:${r.environment}:${r.portfolio}:${r.entry.time}:${r.contract}`, r);
const simTrade = (strategy, symbol, entry, exit, r) => ({ id: `${strategy}|${symbol}|${entry}`, strategy, symbol, label: symbol, entry_t: entry, entry_raw: 100, entry: 100, stop: 99, target: 102, exit_t: exit, exit_raw: 100 + r, exit: 100 + r, exit_reason: r > 0 ? 'target' : 'stop', r });
const putSim = (m, trades) => { m.set('strategy_sim_state', { trades: { first: 0, last: 0, tail: trades.length, stored: trades.length, dropped: 0 }, symbols: {} }); m.set('strategy_sim_trades:0', trades); };

function seeded() {
  const m = new Map();
  // Oct 21 day session, MNQ: +15 and −25.
  put(m, rec({ entry: '2026-10-21T14:05:00Z', exit: '2026-10-21T14:30:00Z', exitRaw: 21010 }));
  put(m, rec({ strategy: 'vwap-5m', entry: '2026-10-21T15:05:00Z', exit: '2026-10-21T15:20:00Z', exitRaw: 20990, reason: 'stop' }));
  // Overnight MNQ: opened 7:30 PM New York Oct 21, closed 1:15 AM Oct 22. CME trading date Oct 22.
  put(m, rec({ strategy: 'orb-5m', entry: '2026-10-21T23:30:00Z', exit: '2026-10-22T05:15:00Z', exitRaw: 21020 }));
  // A 6:30 PM New York exit on Oct 22 counts on the CME trading date Oct 23.
  put(m, rec({ strategy: 'orb-5m', entry: '2026-10-22T22:05:00Z', exit: '2026-10-22T22:30:00Z', exitRaw: 21005 }));
  // BTC crypto paper closed 9 PM New York Oct 22 (01:00Z Oct 23): New York calendar date Oct 22.
  put(m, rec({ strategy: 'orb-btc', entry: '2026-10-23T00:10:00Z', exit: '2026-10-23T01:00:00Z', raw: 80000, exitRaw: 80300, crypto: true }));
  // A backtest record: never in any account or calendar.
  put(m, rec({ strategy: 'bt', entry: '2026-10-21T16:00:00Z', exit: '2026-10-21T16:30:00Z', exitRaw: 22000, env: 'backtest' }));
  putSim(m, [simTrade('rsi2', 'ETH-USD', '2026-10-21T14:00:00Z', '2026-10-21T14:09:00Z', 1.5), simTrade('rsi2', 'BTC-USD', '2026-10-21T18:00:00Z', '2026-10-21T18:09:00Z', -1)]);
  return memStorage(m);
}

test('instruments are named the owner\'s way and sorted into futures and crypto', () => {
  assert.deepEqual(instrumentOf({ symbol: 'MNQ=F' }), { instrument: 'MNQ', market: 'futures' });
  assert.deepEqual(instrumentOf({ symbol: 'MNQZ6' }), { instrument: 'MNQ', market: 'futures' });
  assert.deepEqual(instrumentOf({ symbol: 'NQ' }), { instrument: 'NQ', market: 'futures' });
  assert.deepEqual(instrumentOf({ symbol: 'ESZ6' }), { instrument: 'ES', market: 'futures' });
  assert.deepEqual(instrumentOf({ symbol: 'BTC-USD' }), { instrument: 'BTC', market: 'crypto' });
  assert.deepEqual(instrumentOf({ symbol: 'coinbase:ETH-USD' }), { instrument: 'ETH', market: 'crypto' });
  assert.deepEqual(instrumentOf({ symbol: 'MNQ', market: 'crypto', contract: 'ETH' }).market, 'crypto');
});

test('trading dates: futures on the CME trading date, crypto on the New York calendar date, across both DST changes', () => {
  // Overnight futures trade: 1:15 AM New York Oct 22 → CME date Oct 22; 6:30 PM New York Oct 22 → Oct 23.
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-10-22T05:15:00Z' }), '2026-10-22');
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-10-22T22:30:00Z' }), '2026-10-23');
  assert.equal(tradeDateOf({ symbol: 'BTC-USD', exit_time: '2026-10-22T22:30:00Z' }), '2026-10-22');
  // Spring forward (Sunday March 8, 2026, EDT from 2 AM): 6:00 PM EDT is 22:00Z; one minute before is 21:59Z.
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-03-08T22:00:00Z' }), '2026-03-09');
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-03-08T21:59:00Z' }), '2026-03-08');
  // Fall back (Sunday November 1, 2026, EST from 2 AM): 6:00 PM EST is 23:00Z, so 22:30Z is still 5:30 PM.
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-11-01T23:00:00Z' }), '2026-11-02');
  assert.equal(tradeDateOf({ symbol: 'MNQ', exit_time: '2026-11-01T22:30:00Z' }), '2026-11-01');
  // Crypto at 11:30 PM New York across the change: EDT before (03:30Z next day), EST after (04:30Z next day).
  assert.equal(tradeDateOf({ symbol: 'ETH-USD', exit_time: '2026-10-31T03:30:00Z' }), '2026-10-30');
  assert.equal(tradeDateOf({ symbol: 'ETH-USD', exit_time: '2026-11-02T04:30:00Z' }), '2026-11-01');
  assert.equal(tradeDateOf({ symbol: 'MNQ' }), null);
});

test('accounts view: futures paper, crypto paper and simulation stay apart; backtests are never included', async () => {
  const v = await accountsView(seeded(), { now: Date.parse('2026-10-23T15:00:00Z') });
  assert.equal(v.ok, true);
  assert.deepEqual(v.excluded, ['historical_backtest']);
  const [fut, cry, sim] = v.accounts;
  assert.equal(fut.id, 'forward_paper_futures');
  assert.equal(fut.trades.length, 4);
  assert.ok(fut.trades.every((t) => t.market === 'futures' && t.unit === 'USD'));
  assert.ok(!fut.trades.some((t) => t.strategy === 'bt'), 'the backtest record is not a paper trade');
  assert.equal(cry.trades.length, 1);
  assert.equal(cry.trades[0].symbol, 'BTC');
  assert.equal(sim.unit, 'R');
  assert.equal(sim.trades.length, 2);
  assert.ok(sim.trades.every((t) => t.net === null && Number.isFinite(t.r)), 'the simulation has R only, never dollars');
  assert.equal(fut.updated_at, '2026-10-22T22:30:00Z');
  // Reached through the calendar route the app calls.
  const viaRoute = await tradingCalendar(seeded(), { view: 'accounts', now: '1792767600000' });
  assert.equal(viaRoute.accounts.length, 3);
});

test('an empty store reads as no records, never as zero results', async () => {
  const v = await accountsView(memStorage(), { now: Date.parse('2026-10-23T15:00:00Z') });
  for (const a of v.accounts) {
    assert.deepEqual(a.trades, []);
    assert.equal(a.updated_at, null);
  }
  const cal = await unifiedCalendar(memStorage(), { month: '2026-10' });
  assert.equal(cal.empty, true);
  assert.equal(cal.totals.trades, 0);
  assert.match(speakUnified(cal), /No trade closed/);
});

test('unified calendar: each day\'s totals are the sum of its trades, kinds never added, futures and crypto filters over the same dates', async () => {
  const s = seeded();
  const all = await unifiedCalendar(s, { month: '2026-10', market: 'all' });
  assert.equal(all.time_zone, 'America/New_York');
  const days = Object.fromEntries(all.weeks.flatMap((w) => w.days).map((d) => [d.date, d]));
  // Oct 21: two MNQ paper trades (+15, −25) and two simulation trades (+1.5 R, −1 R), kept apart.
  assert.equal(days['2026-10-21'].kinds.forward_paper.trades, 2);
  assert.equal(days['2026-10-21'].kinds.forward_paper.net, 15 - 25);
  assert.equal(days['2026-10-21'].kinds.simulation.net, 0.5);
  assert.equal(days['2026-10-21'].kinds.simulation.unit, 'R');
  assert.deepEqual(days['2026-10-21'].instruments, ['BTC', 'ETH', 'MNQ']);
  // Oct 22: the overnight MNQ trade (CME date) and the BTC trade that closed 9 PM New York.
  assert.deepEqual(days['2026-10-22'].instruments, ['BTC', 'MNQ']);
  assert.equal(days['2026-10-23'].trades, 1, 'the 6:30 PM New York exit counts on the next CME trading date');
  // Every day's paper net equals the sum of that day's own rows.
  for (const d of Object.values(days).filter((x) => x.trades)) {
    const list = await unifiedCalendar(s, { day: d.date });
    const sum = list.trades.filter((t) => t.kind === 'forward_paper').reduce((a, t) => a + t.net, 0);
    if (d.kinds.forward_paper) assert.equal(d.kinds.forward_paper.net, Math.round(sum * 100) / 100, d.date);
    assert.equal(list.trades.length, d.trades);
  }
  const fut = await unifiedCalendar(s, { month: '2026-10', market: 'futures' });
  const cry = await unifiedCalendar(s, { month: '2026-10', market: 'crypto' });
  assert.equal(fut.totals.trades + cry.totals.trades, all.totals.trades);
  assert.deepEqual(cry.totals.instruments, ['BTC', 'ETH']);
  assert.ok(!fut.totals.instruments.includes('BTC'));
  assert.deepEqual(fut.weeks.map((w) => w.days.map((d) => d.date)), all.weeks.map((w) => w.days.map((d) => d.date)), 'the same dates under every filter');
  const day = await unifiedCalendar(s, { day: '2026-10-22', market: 'all' });
  const overnight = day.trades.find((t) => t.strategy === 'orb-5m');
  assert.equal(overnight.date_basis, 'CME trading date');
  assert.equal(overnight.replay, true);
  assert.match(speakUnified(day), /CHE forward paper: 2 trades/);
});

test('"is the feed live" is recognized in the owner\'s words and nothing else', () => {
  assert.deepEqual(feedLiveIntent('is the mnq data live'), { kind: 'connections', feed: 'futures' });
  assert.deepEqual(feedLiveIntent('Is the crypto feed live?'), { kind: 'connections', feed: 'crypto' });
  assert.deepEqual(feedLiveIntent('is the bitcoin chart real time'), { kind: 'connections', feed: 'crypto' });
  assert.deepEqual(deskIntent('is the MNQ feed live'), { kind: 'connections', feed: 'futures' });
  assert.equal(feedLiveIntent('show me the mnq chart'), null);
  assert.equal(feedLiveIntent('is the new build live'), null);
  assert.equal(feedLiveIntent('go live'), null);
});

test('MNQ is called live only for a fresh Rithmic minute; signing in alone or delayed bars never are', async () => {
  const now = Date.parse('2026-10-23T15:00:30Z');
  const none = await speakFeedLive(memStorage(new Map([['live_paper_feed', { provider: 'Yahoo MNQ=F', status: 'DELAYED', last_bar_time: '2026-10-23T14:40:00Z' }]])), 'futures', { now, futuresOpen: true });
  assert.match(none, /^No, sir, there is no live MNQ data: no Rithmic minute has been recorded yet/);
  assert.match(none, /delayed data is never called live/);
  const m = new Map([['rithmic_1m_index:MNQZ6', ['2026-10-23T14']], ['rithmic_1m:MNQZ6:2026-10-23T14', { symbol: 'MNQZ6', candles: { 59: { t: '2026-10-23T14:59:00Z', c: 21090.25 } } }]]);
  const fresh = await speakFeedLive(memStorage(m), 'futures', { now, futuresOpen: true });
  assert.match(fresh, /^Yes, sir: live Rithmic data\. The newest MNQZ6 minute your iPhone recorded closed under a minute ago, at 21090\.25/);
  const old = await speakFeedLive(memStorage(m), 'futures', { now: now + 30 * 60_000, futuresOpen: false });
  assert.match(old, /^No, sir, the MNQ data is not live\. .*closed Oct 23, 11:00 AM New York time, 31 minutes ago/);
  assert.match(old, /CME futures are closed right now/);
});

test('the crypto answer is public Coinbase candles with no account, never called a live stream', async () => {
  const feeds = [{ coin: 'BTC', tf: '5m', status: 'LIVE', last_bar: '2026-10-23T14:55:00Z', last_close: 67250.5 }, { coin: 'ETH', tf: '5m', status: 'NOT STARTED' }];
  const said = await speakFeedLive(memStorage(), 'crypto', { now: Date.parse('2026-10-23T15:01:00Z'), cryptoFeeds: feeds });
  assert.match(said, /^Not a live stream on my side, sir\. BTC: newest 5-minute candle is current, closed Oct 23, 10:55 AM New York time \(6 minutes ago\), last price 67250\.5\. ETH: not started/);
  assert.match(said, /no trading account/);
  assert.match(await speakFeedLive(memStorage(), 'crypto', { cryptoFeeds: [] }), /^No crypto market data has been read yet/);
});

test('connections: Coinbase public data is its own card; Rithmic market data and Rithmic orders are told apart', () => {
  const v = tradingConnections({ desk: { mode: 'paper', account: {}, risk_limits: null } });
  const coinbase = v.cards.find((c) => c.id === 'coinbase');
  assert.equal(coinbase.state, 'public');
  assert.match(coinbase.detail, /^Public market data — no trading account/);
  const fye = v.cards.find((c) => c.id === 'fundyouredge');
  assert.match(fye.detail, /^Orders: not supported/);
  assert.match(fye.detail, /your iPhone reads Rithmic prices itself/);
  assert.doesNotMatch(fye.detail, /CHE has no Rithmic connection/);
});
