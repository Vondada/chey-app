// The desk cards (owner, 2026-10-24): Analyze Markets, Backtesting Lab and Custom Indicators showed CONNECT because
// they read only CHE_MARKET_DATA_URL / CHE_BACKTEST_URL. They now run CHE's own engines on real bars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { ema, tradingCapabilities } from './trading_capabilities.js';

function memStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : (m.has(k) ? structuredClone(m.get(k)) : undefined)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
  };
}
const NOW = Date.parse('2026-10-24T18:00:00Z');
const wave = (i) => 100 + 10 * Math.sin(i / 6) + i * 0.05;
// Coinbase's answer shape for the newest closed buckets, newest first.
function coinbaseFetcher(now = NOW) {
  return async (url) => {
    const g = Number(new URL(String(url)).searchParams.get('granularity'));
    const last = Math.floor(now / 1000 / g) * g - g;
    return new Response(JSON.stringify(Array.from({ length: 200 }, (_, i) => { const p = wave(i); return [last - (199 - i) * g, p - 1, p + 1, p - 0.3, p, 5]; }).reverse()));
  };
}
const offline = async (url) => { throw new TypeError(`offline: ${new URL(String(url)).host}`); };
const bars5 = (n, from) => Array.from({ length: n }, (_, i) => { const p = 20000 + 30 * Math.sin(i / 5) + i; return { t: new Date(Date.parse(from) + i * 300_000).toISOString(), o: p - 2, h: p + 4, l: p - 4, c: p, v: 100 }; });

test('no CHE_MARKET_DATA_URL or CHE_BACKTEST_URL: the cards are AVAILABLE from CHE\'s own engines on live data', async () => {
  const storage = memStorage();
  await storage.put('trd_ds:NQ:5m', { market: 'NQ', timeframe: '5m', provider: 'Yahoo Finance chart (public, free, delayed)', bars: 400, first: '2026-09-01T13:00:00Z', last: '2026-09-02T22:15:00Z', chunks: 1 });
  await storage.put('trd_ds:NQ:5m:0', bars5(400, '2026-09-01T13:00:00Z'));
  const v = await tradingCapabilities(storage, {}, { fetcher: coinbaseFetcher(), now: NOW });
  for (const id of ['analyze_markets', 'backtesting_lab', 'custom_indicators']) assert.notEqual(v.cards[id].state, 'CONNECT', id);
  assert.equal(v.cards.analyze_markets.state, 'AVAILABLE', v.cards.analyze_markets.reason);
  assert.match(v.cards.analyze_markets.reason, /^Ran just now on live BTC-USD 5m \(Coinbase Exchange BTC-USD 5m candles/);
  assert.equal(v.cards.backtesting_lab.state, 'AVAILABLE', v.cards.backtesting_lab.reason);
  assert.match(v.cards.backtesting_lab.reason, /^Ran just now on 400 of 400 stored NQ 5m bars \(Yahoo Finance chart \(public, free, delayed\), historical\): \d+ trades for /);
  assert.equal(v.cards.custom_indicators.state, 'AVAILABLE');
  assert.ok(Number.isFinite(v.cards.custom_indicators.check.ema20));
  // The statuses stay apart: backtest, paper and live are never merged, and live is disabled.
  assert.deepEqual(Object.keys(v.cards.backtesting_lab.modes), ['backtest', 'paper', 'live']);
  assert.equal(v.cards.backtesting_lab.modes.live.state, 'disabled');
  assert.equal(v.live_orders, 'disabled');
  // Live CME data is its own line, never the delayed research data.
  assert.equal(v.data.cme_live.status, 'NOT CONNECTED');
  assert.equal(v.data.crypto.status, 'LIVE');
  assert.deepEqual([v.cards.analyze_markets.opens.section, v.cards.backtesting_lab.opens.section, v.cards.custom_indicators.opens.section], ['chart', 'strategies', 'chart']);
  assert.match(v.speech, /^Analyze Markets is available\./);
});

test('only the delayed futures feed answers: LIMITED, saying it is delayed data; the probe is cached five minutes', async () => {
  const storage = memStorage();
  await storage.put('live_paper_feed', { provider: 'Yahoo MNQ=F', status: 'DELAYED', delayed_by_min: 10, bars: bars5(120, '2026-10-24T08:00:00Z') });
  let calls = 0;
  const failing = async (url) => { calls += 1; return offline(url); };
  const v = await tradingCapabilities(storage, {}, { fetcher: failing, now: NOW });
  assert.equal(v.cards.analyze_markets.state, 'LIMITED');
  assert.equal(v.cards.analyze_markets.reason, 'It ran on MNQ 5m from Yahoo MNQ=F (DELAYED), not on live data.');
  assert.equal(v.cards.custom_indicators.state, 'LIMITED');
  assert.equal(v.cards.backtesting_lab.state, 'LIMITED');
  assert.match(v.cards.backtesting_lab.reason, /^No stored research history yet, so it ran only on 120 recent MNQ 5m bars\./);
  assert.equal(v.data.futures_research.status, 'DELAYED');
  assert.equal(v.data.crypto.status, 'UNAVAILABLE');
  const before = calls;
  await tradingCapabilities(storage, {}, { fetcher: failing, now: NOW + 60_000 });
  assert.equal(calls, before, 'no second exchange call inside five minutes');
});

test('no data at all: UNAVAILABLE with the reason, never CONNECT and never a made-up result', async () => {
  const v = await tradingCapabilities(memStorage(), {}, { fetcher: offline, now: NOW });
  for (const id of ['analyze_markets', 'backtesting_lab', 'custom_indicators']) {
    assert.equal(v.cards[id].state, 'UNAVAILABLE', id);
    assert.match(v.cards[id].reason, /^No market data answered just now: Coinbase and Kraken: .*no stored futures bars; no stored research dataset\.$/);
    assert.equal(v.cards[id].check, undefined);
  }
});

test('an owner engine URL is named as an extra, not required', async () => {
  const v = await tradingCapabilities(memStorage(), { CHE_BACKTEST_URL: 'https://example.invalid' }, { fetcher: coinbaseFetcher(), now: NOW });
  assert.match(v.cards.backtesting_lab.reason, /Your own engine \(CHE_BACKTEST_URL\) is also configured\.$/);
});

test('ema matches a hand computation', () => {
  assert.equal(ema([1, 2, 3], 5), null);
  assert.equal(ema([2, 4, 6, 8], 2), ((8 * (2 / 3)) + (((6 * (2 / 3)) + (3 * (1 / 3))) * (1 / 3))));
});

test('GET /api/trading/capabilities: owner only', async () => {
  const generated = new URL('./.trading_capabilities.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const storage = { ...memStorage(), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' };
  const state = new CheState({ id: { name: 'owner' }, storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const original = globalThis.fetch;
  globalThis.fetch = offline;
  try {
    const guest = await worker.fetch(new Request('https://che.example/api/trading/capabilities'), env);
    assert.ok([401, 403].includes(guest.status), String(guest.status));
    const pair = await (await worker.fetch(new Request('https://che.example/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456', device_name: 'iPhone' }) }), env)).json();
    const token = pair.token || pair.device_token;
    assert.ok(token, JSON.stringify(pair).slice(0, 200));
    const res = await worker.fetch(new Request('https://che.example/api/trading/capabilities', { headers: { Authorization: `Bearer ${token}` } }), env);
    const v = await res.json();
    assert.equal(res.status, 200, JSON.stringify(v).slice(0, 300));
    assert.equal(v.cards.analyze_markets.state, 'UNAVAILABLE');
  } finally { globalThis.fetch = original; }
});
