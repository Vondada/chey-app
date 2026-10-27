// Owner audit (2026-10-24): a blank gray chart, and strategies labelled as evaluating signals while no data arrives.
// The futures chart now draws Yahoo's delayed candles (labelled DELAYED) when the forward engine stored none, or says
// why it cannot; a strategy reads "running" only while the forward engine really evaluates fresh bars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartView } from './trading_chart.js';
import { controlsView, engineDataState, readControls } from './trading_controls.js';

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
const NOW = Date.parse('2026-10-23T15:00:00Z'); // a Friday, CME open
const offline = async (url) => { throw new TypeError(`offline: ${new URL(String(url)).host}`); };

// Yahoo's chart answer for MNQ=F, 5-minute bars, the newest closed 10 minutes ago (delayed).
function yahoo(now = NOW) {
  const end = Math.floor((now - 10 * 60_000) / 300_000) * 300_000;
  const ts = Array.from({ length: 40 }, (_, i) => (end - (39 - i) * 300_000) / 1000);
  const px = ts.map((_, i) => 21000 + i);
  return async (url) => {
    const u = String(url);
    if (!u.includes('finance.yahoo.com')) throw new TypeError(`offline: ${new URL(u).host}`);
    return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: 'MNQ=F', regularMarketTime: (end + 300_000) / 1000, exchangeDataDelayedBy: 10 }, timestamp: ts, indicators: { quote: [{ open: px, high: px.map((p) => p + 3), low: px.map((p) => p - 3), close: px.map((p) => p + 1), volume: px.map(() => 10) }] } }] } }));
  };
}

test('blank chart: with no stored forward bars, the futures chart draws Yahoo\'s delayed MNQ candles, labelled DELAYED', async () => {
  const v = await chartView(memStorage(), {}, { account: 'futures_paper', tf: '5m', now: NOW, fetcher: yahoo() });
  assert.equal(v.state, 'verified');
  assert.ok(v.bars.length > 30, String(v.bars.length));
  assert.equal(v.feed.status, 'DELAYED');
  assert.equal(v.feed.delayed, true);
  assert.match(v.feed.provider, /Yahoo/);
  assert.ok(v.feed.last_bar_time, 'a timestamp for freshness');
  assert.match(v.bars_source, /^Yahoo delayed MNQ=F/);
  assert.equal(v.no_data_reason, undefined);
  assert.equal(v.entries_allowed, false);
});

test('blank chart: when no source answers, the chart says why and draws nothing', async () => {
  const v = await chartView(memStorage(), {}, { account: 'futures_paper', tf: '5m', now: NOW, fetcher: offline });
  assert.equal(v.state, 'no_data');
  assert.deepEqual(v.bars, []);
  assert.match(v.no_data_reason, /^CHE's forward paper engine has stored no MNQ bars yet, and Yahoo's delayed MNQ=F chart could not be read.*No candle was made up\.$/);
  assert.equal(v.error, v.no_data_reason, 'the app shows it in the empty chart');
  assert.equal(v.feed.status, 'UNAVAILABLE');
});

test('watcher honesty: "running" only while the forward engine evaluates fresh bars; delayed data is said to be delayed', async () => {
  const controls = await readControls(memStorage());
  const bars = (lastIso) => [{ t: lastIso, o: 1, h: 1, l: 1, c: 1 }];
  const fresh = { status: 'DELAYED', provider: 'Yahoo MNQ=F', delayed_by_min: 10, last_bar_time: new Date(NOW - 12 * 60_000).toISOString(), bars: bars(new Date(NOW - 12 * 60_000).toISOString()) };
  const on = controlsView(controls, [], NOW, { enabled: true, feed: fresh });
  assert.ok(on.length > 0);
  for (const r of on) {
    assert.equal(r.state, 'running', r.id);
    assert.equal(r.evaluating, true);
    assert.equal(r.data_label, 'DELAYED: Yahoo MNQ=F, about 10 minutes behind. Research and forward paper testing only, not live data.');
    assert.doesNotMatch(r.data_label, /^LIVE/);
  }
  const stale = controlsView(controls, [], NOW, { enabled: true, feed: { ...fresh, last_bar_time: new Date(NOW - 3 * 3600_000).toISOString() } });
  assert.ok(stale.every((r) => r.state === 'waiting for data' && r.evaluating === false));
  assert.match(stale[0].state_reason, /^The newest bar from Yahoo MNQ=F, about 10 minutes behind closed 180 minutes ago .*No signal is being evaluated until new bars arrive\.$/);
  const none = controlsView(controls, [], NOW, { enabled: true, feed: null });
  assert.ok(none.every((r) => r.state === 'waiting for data'));
  const off = controlsView(controls, [], NOW, { enabled: false, feed: fresh });
  assert.ok(off.every((r) => r.state === 'engine off' && /forward paper engine is off/.test(r.state_reason)));
  // A paused strategy stays "paused": the data state never overrides the owner's own switch.
  controls.strategies[on[0].id].paused = true;
  const paused = controlsView(controls, [], NOW, { enabled: true, feed: null });
  assert.equal(paused.find((r) => r.id === on[0].id).state, 'paused');
  assert.equal(paused.find((r) => r.id === on[0].id).state_reason, '');
  assert.equal(engineDataState({ enabled: true, feed: { status: 'UNAVAILABLE', error: 'Yahoo answered HTTP 429' } }, NOW).reason, 'The forward feed has no bars: Yahoo answered HTTP 429. No signal is being evaluated.');
});
