// Universal market universe (owner, 2026-10-24): pairs discovered from the exchanges, Coinbase first
// with Kraken as the fallback, honest feed labels, intervals built only from closed finer bars, and
// 15/30-second bars reported unavailable instead of faked. Offline: every exchange is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TICKERS, FUTURES_CATALOG, buildBars, cryptoSpotCandles, describeFeed, liveness, marketUniverse, offeredTimeframes, parseCoinbaseProducts, parseKrakenPairs, resolveTicker, searchUniverse, universeCandles } from './market_universe.js';

const NOW = Date.parse('2026-10-24T15:00:20Z');
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function memoryStorage() {
  const m = new Map();
  return { get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, map: m };
}

const COINBASE_PRODUCTS = [
  { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online', trading_disabled: false },
  { id: 'BTC-USDT', base_currency: 'BTC', quote_currency: 'USDT', status: 'online', trading_disabled: false },
  { id: 'ETH-USD', base_currency: 'ETH', quote_currency: 'USD', status: 'online', trading_disabled: false },
  { id: 'DOGE-USD', base_currency: 'DOGE', quote_currency: 'USD', status: 'online', trading_disabled: false },
  { id: 'SOL-USD', base_currency: 'SOL', quote_currency: 'USD', status: 'online', trading_disabled: false },
  { id: 'OLD-USD', base_currency: 'OLD', quote_currency: 'USD', status: 'delisted', trading_disabled: true },
  { id: 'ETH-JPY', base_currency: 'ETH', quote_currency: 'JPY', status: 'online', trading_disabled: false },
];
const KRAKEN_PAIRS = {
  XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', status: 'online' },
  XDGUSD: { altname: 'XDGUSD', wsname: 'XDG/USD', status: 'online' },
  KASUSD: { altname: 'KASUSD', wsname: 'KAS/USD', status: 'online' },
  KASJPY: { altname: 'KASJPY', wsname: 'KAS/JPY', status: 'online' },
};

// Closed 1-minute Coinbase rows ([time, low, high, open, close, volume], newest first) ending at `end`.
function coinbaseRows(minutes, end = Date.parse('2026-10-24T15:00:00Z'), g = 60) {
  const rows = [];
  for (let i = 1; i <= minutes; i++) { const t = end / 1000 - i * g; rows.push([t, 99, 102, 100, 101, 2]); }
  return rows;
}

test('Coinbase and Kraken discovery: online pairs in supported quotes, Kraken spellings normalized', () => {
  const cb = parseCoinbaseProducts(COINBASE_PRODUCTS);
  assert.deepEqual(cb.map((i) => i.id), ['coinbase:BTC-USD', 'coinbase:BTC-USDT', 'coinbase:ETH-USD', 'coinbase:DOGE-USD', 'coinbase:SOL-USD']);
  assert.equal(cb[1].market, 'Coinbase Exchange spot BTC/USDT');
  assert.equal(cb[0].name, 'Bitcoin');
  const kr = parseKrakenPairs(KRAKEN_PAIRS);
  assert.deepEqual(kr.map((i) => i.symbol), ['BTC-USD', 'DOGE-USD', 'KAS-USD']);
  assert.equal(kr[0].provider_symbol, 'XBTUSD');
  assert.equal(kr[0].provider_key, 'XXBTZUSD');
});

test('universe: Coinbase first, Kraken-only pairs added, cached 6 hours, failures reported', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetcher = async (url) => { calls++; return String(url).includes('coinbase') ? ok(COINBASE_PRODUCTS) : ok({ error: [], result: KRAKEN_PAIRS }); };
  const u = await marketUniverse(storage, { fetcher, now: NOW });
  assert.deepEqual(u.crypto.map((i) => i.id), ['coinbase:BTC-USD', 'coinbase:BTC-USDT', 'coinbase:ETH-USD', 'coinbase:DOGE-USD', 'coinbase:SOL-USD', 'kraken:KAS-USD']);
  assert.equal(u.futures.length, FUTURES_CATALOG.length);
  assert.equal(u.futures.length, 25);
  assert.deepEqual(u.problems, []);
  assert.equal(calls, 2);
  await marketUniverse(storage, { fetcher, now: NOW + 3_600_000 });
  assert.equal(calls, 2, 'served from the cache inside 6 hours');

  const down = async () => { throw new TypeError('fetch failed'); };
  const kept = await marketUniverse(storage, { fetcher: down, now: NOW + 7 * 3_600_000 });
  assert.equal(kept.crypto.length, 6, 'the last discovered list is kept');
  assert.ok(kept.problems.some((p) => /Coinbase products: fetch failed/.test(p)));
  assert.ok(kept.problems.includes('kept the last discovered list'));

  const empty = await marketUniverse(memoryStorage(), { fetcher: down, now: NOW });
  assert.deepEqual(empty.crypto, []);
  assert.equal(empty.futures.length, 25, 'futures are still listed when the exchanges are unreachable');
  assert.equal(empty.problems.length, 2);
});

test('futures: front-month contract, exchange named, research label, never executable', async () => {
  const u = await marketUniverse(memoryStorage(), { fetcher: async () => ok([]), now: NOW });
  const mnq = u.futures.find((f) => f.symbol === 'MNQ');
  assert.match(mnq.contract, /^MNQ[HMUZ]\d$/);
  assert.equal(mnq.exchange, 'CME');
  assert.match(mnq.market, /continuous front month \(research chart\)/);
  assert.match(mnq.data, /not an executable contract/);
  for (const root of ['MNQ', 'NQ', 'MES', 'ES', 'MYM', 'YM', 'M2K', 'RTY', 'CL', 'MCL', 'NG', 'GC', 'MGC', 'SI', '6E', '6B', '6J', 'BTC', 'MBT', 'ETH', 'MET', 'ZN', 'ZB', 'ZC', 'ZS']) {
    assert.ok(u.futures.some((f) => f.symbol === root), root);
  }
});

test('search and resolve: defaults first, ticker and name matches, USD before other quotes', async () => {
  const fetcher = async (url) => (String(url).includes('coinbase') ? ok(COINBASE_PRODUCTS) : ok({ result: KRAKEN_PAIRS }));
  const u = await marketUniverse(memoryStorage(), { fetcher, now: NOW });
  assert.deepEqual(searchUniverse(u, '').slice(0, 8).map((i) => i.id), DEFAULT_TICKERS);
  const btc = searchUniverse(u, 'btc');
  assert.equal(btc[0].id, 'futures:BTC', 'exact ticker');
  assert.deepEqual(searchUniverse(u, 'btc', { category: 'crypto' }).map((i) => i.id), ['coinbase:BTC-USD', 'coinbase:BTC-USDT']);
  assert.equal(searchUniverse(u, 'bitcoin', { category: 'crypto' })[0].id, 'coinbase:BTC-USD');
  assert.equal(searchUniverse(u, 'gold')[0].id, 'futures:GC');
  assert.deepEqual(searchUniverse(u, 'zzzz'), []);
  assert.equal(resolveTicker(u, 'coinbase:eth-usd').id, 'coinbase:ETH-USD');
  assert.equal(resolveTicker(u, 'doge').id, 'coinbase:DOGE-USD');
  assert.equal(resolveTicker(u, 'MNQ').id, 'futures:MNQ');
  assert.equal(resolveTicker(u, 'kas').id, 'kraken:KAS-USD');
  assert.equal(resolveTicker(u, ''), null);
  assert.equal(resolveTicker(u, 'nothing'), null);
});

test('buildBars: closed buckets only, no partial oldest or forming newest bucket', () => {
  const bars = [];
  for (let m = 1; m <= 7; m++) bars.push({ t: new Date(Date.parse('2026-10-24T14:00:00Z') + m * 60_000).toISOString(), o: m, h: m + 1, l: m - 1, c: m + 0.5, v: 1 });
  // 14:01..14:07 → 2m buckets 14:00 (partial, dropped), 14:02, 14:04, 14:06 (forming at 14:07:30, dropped).
  const built = buildBars(bars, 120, Date.parse('2026-10-24T14:07:30Z'));
  assert.deepEqual(built.map((b) => b.t), ['2026-10-24T14:02:00.000Z', '2026-10-24T14:04:00.000Z']);
  assert.deepEqual(built[0], { t: '2026-10-24T14:02:00.000Z', o: 2, h: 4, l: 1, c: 3.5, v: 2 });
});

test('buildBars: a missing source bar inside the range drops that bucket instead of building it from half the data', () => {
  const bars = [];
  for (let m = 0; m <= 7; m++) if (m !== 3) bars.push({ t: new Date(Date.parse('2026-10-24T14:00:00Z') + m * 60_000).toISOString(), o: m, h: m + 1, l: m - 1, c: m + 0.5, v: 1 });
  // 14:00..14:07 without 14:03 → 14:00 complete, 14:02 only has 14:02 (dropped), 14:04 complete, 14:06 forming (dropped).
  const built = buildBars(bars, 120, Date.parse('2026-10-24T14:07:30Z'));
  assert.deepEqual(built.map((b) => b.t), ['2026-10-24T14:00:00.000Z', '2026-10-24T14:04:00.000Z']);
  assert.deepEqual(built[1], { t: '2026-10-24T14:04:00.000Z', o: 4, h: 6, l: 3, c: 5.5, v: 2 });
  assert.deepEqual(buildBars(bars.slice(0, 1), 120, Date.parse('2026-10-24T15:00:00Z')), [], 'one source bar cannot prove a complete bucket');
});

test('buildBars: a bucket missing its opening bar is never complete, even when every gap is equal', () => {
  // 1m bars at 14:01, 14:03, 14:05: the smallest gap is 2 minutes, which once made the 14:00 2m bucket look complete.
  const bars = ['14:01', '14:03', '14:05'].map((hm, i) => ({ t: `2026-10-24T${hm}:00.000Z`, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
  const now = Date.parse('2026-10-24T15:00:00Z');
  assert.deepEqual(buildBars(bars, 120, now, 60), [], 'with the known 1m source, every 2m bucket lacks its opening bar');
  assert.deepEqual(buildBars(bars, 120, now), [], 'without it, the opening-bar check still drops them');
  const full = ['14:00', '14:01', '14:02', '14:03'].map((hm, i) => ({ t: `2026-10-24T${hm}:00.000Z`, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
  assert.deepEqual(buildBars(full, 120, now, 60).map((b) => b.t), ['2026-10-24T14:00:00.000Z', '2026-10-24T14:02:00.000Z']);
  assert.deepEqual(buildBars(full.filter((_, i) => i !== 0), 120, now, 60).map((b) => b.t), ['2026-10-24T14:02:00.000Z'], 'a missing 14:00 drops only the 14:00 bucket');
});

test('liveness: live, delayed, disconnected', () => {
  const bar = (t) => [{ t }];
  assert.equal(liveness([], 60, NOW).status, 'DISCONNECTED');
  assert.equal(liveness(bar('2026-10-24T14:59:00Z'), 60, NOW).status, 'LIVE');
  assert.equal(liveness(bar('2026-10-24T14:45:00Z'), 60, NOW).status, 'DELAYED');
  const old = liveness(bar('2026-10-24T13:00:00Z'), 60, NOW);
  assert.equal(old.status, 'DISCONNECTED');
  assert.match(old.reason, /minutes ago/);
});

test('crypto candles: Coinbase primary, Kraken fallback labelled, both down is UNAVAILABLE', async () => {
  const urls = [];
  const coinbaseUp = async (url) => { urls.push(String(url)); return ok(coinbaseRows(30)); };
  const live = await universeCandles(memoryStorage(), { id: 'coinbase:BTC-USD', provider: 'coinbase', symbol: 'BTC-USD', base: 'BTC', quote: 'USD', category: 'crypto', exchange: 'Coinbase Exchange' }, '1m', { fetcher: coinbaseUp, now: NOW });
  assert.equal(live.feed.status, 'LIVE');
  assert.equal(live.feed.provider, 'Coinbase Exchange');
  assert.equal(live.fallback, false);
  assert.equal(live.bars.length, 30);
  assert.ok(live.bars[0].t < live.bars.at(-1).t, 'oldest first');
  assert.match(urls[0], /api\.exchange\.coinbase\.com\/products\/BTC-USD\/candles\?granularity=60/);
  assert.equal(describeFeed(live), 'Coinbase Exchange BTC-USD, 1m candles, live.');

  const krakenOnly = async (url) => {
    if (String(url).includes('coinbase')) return new Response('{"message":"blocked"}', { status: 403 });
    assert.match(String(url), /OHLC\?pair=XBTUSD&interval=1$/);
    const rows = []; for (let i = 30; i >= 1; i--) { const t = Date.parse('2026-10-24T15:00:00Z') / 1000 - i * 60; rows.push([t, '100', '102', '99', '101', '100.5', '3', 9]); }
    return ok({ error: [], result: { XXBTZUSD: rows, last: 0 } });
  };
  const fb = await cryptoSpotCandles('BTC', '1m', { fetcher: krakenOnly, now: NOW });
  assert.equal(fb.provider, 'Kraken');
  assert.equal(fb.fallback, true);
  assert.equal(fb.status, 'LIVE');
  assert.equal(fb.candles.length, 30);
  assert.equal(fb.candles[0].h, 102);

  const down = await universeCandles(memoryStorage(), { id: 'coinbase:ETH-USD', provider: 'coinbase', symbol: 'ETH-USD', base: 'ETH', quote: 'USD', category: 'crypto', exchange: 'Coinbase Exchange' }, '5m', { fetcher: async () => { throw new TypeError('fetch failed'); }, now: NOW });
  assert.equal(down.feed.status, 'UNAVAILABLE');
  assert.deepEqual(down.bars, []);
  assert.equal(down.feed.attempts.length, 2);
  assert.match(describeFeed(down), /unavailable: coinbase: fetch failed; kraken: fetch failed/);
});

test('crypto 4h and 2m are built from hourly and 1-minute bars, never from Coinbase 6-hour candles', async () => {
  const urls = [];
  const fetcher = async (url) => { urls.push(String(url)); const g = Number(new URL(String(url)).searchParams.get('granularity')); return ok(coinbaseRows(g === 3600 ? 48 : 60, Date.parse('2026-10-24T15:00:00Z'), g)); };
  const item = { id: 'coinbase:SOL-USD', provider: 'coinbase', symbol: 'SOL-USD', base: 'SOL', quote: 'USD', category: 'crypto', exchange: 'Coinbase Exchange' };
  const four = await universeCandles(memoryStorage(), item, '4h', { fetcher, now: NOW });
  assert.match(urls[0], /granularity=3600$/);
  assert.equal(four.built_from, '1h');
  assert.ok(four.bars.length >= 10);
  assert.ok(four.bars.every((b) => Date.parse(b.t) % (4 * 3_600_000) === 0));
  assert.match(describeFeed(four), /\(built from 1h bars\)/);
  const two = await universeCandles(memoryStorage(), item, '2m', { fetcher, now: NOW });
  assert.match(urls[1], /granularity=60$/);
  assert.equal(two.built_from, '1m');
  assert.ok(!urls.some((u) => /granularity=21600/.test(u)));
});

test('15s and 30s are unavailable with a reason; offered timeframes say so up front', async () => {
  const item = { id: 'coinbase:BTC-USD', provider: 'coinbase', symbol: 'BTC-USD', base: 'BTC', quote: 'USD', category: 'crypto', exchange: 'Coinbase Exchange' };
  let called = false;
  const v = await universeCandles(memoryStorage(), item, '15s', { fetcher: async () => { called = true; return ok([]); }, now: NOW });
  assert.equal(called, false);
  assert.equal(v.feed.status, 'UNAVAILABLE');
  assert.match(v.feed.reason, /trade stream/);
  assert.deepEqual(offeredTimeframes(item), ['1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']);
  assert.deepEqual(offeredTimeframes({ category: 'futures' }), ['1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']);
  assert.equal((await universeCandles(memoryStorage(), item, '3m', { now: NOW })).ok, false);
  assert.equal((await universeCandles(memoryStorage(), null, '1m', { now: NOW })).ok, false);
});

test('futures candles are DELAYED from Yahoo, UNAVAILABLE when Yahoo fails, never LIVE', async () => {
  const u = await marketUniverse(memoryStorage(), { fetcher: async () => ok([]), now: NOW });
  const es = u.futures.find((f) => f.symbol === 'ES');
  const ts = []; for (let i = 30; i >= 2; i--) ts.push(Date.parse('2026-10-24T15:00:00Z') / 1000 - i * 60);
  const yahoo = async (url) => {
    assert.match(String(url), /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/ES%3DF\?interval=1m/);
    return ok({ chart: { result: [{ meta: { regularMarketTime: NOW / 1000 - 600, exchangeDataDelayedBy: 10 }, timestamp: ts, indicators: { quote: [{ open: ts.map(() => 5000), high: ts.map(() => 5002), low: ts.map(() => 4999), close: ts.map(() => 5001), volume: ts.map(() => 5) }] } }] } });
  };
  const v = await universeCandles(memoryStorage(), es, '1m', { fetcher: yahoo, now: NOW });
  assert.equal(v.feed.status, 'DELAYED');
  assert.equal(v.feed.delayed_by_min, 10);
  assert.equal(v.feed.contract, es.contract);
  assert.ok(v.bars.length > 0);
  assert.match(describeFeed(v), new RegExp(`^CME ES \\(front month ${es.contract}\\), 1m candles, delayed about 10 minutes\\.$`));

  const bad = await universeCandles(memoryStorage(), es, '1m', { fetcher: async () => new Response('', { status: 429 }), now: NOW });
  assert.equal(bad.feed.status, 'UNAVAILABLE');
  assert.match(bad.feed.reason, /HTTP 429/);
});
