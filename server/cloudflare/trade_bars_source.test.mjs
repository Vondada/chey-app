// Which bars a trade's replay uses (owner, 2026-10-27): an intraday forward-paper trade is drawn from the iPhone's
// recorded Rithmic minutes when every minute of its candles was recorded. The delayed Yahoo feed is used only when
// the minutes do not cover the trade, and it is labelled DELAYED. Nothing is made up: a missing minute means no candle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_FEED } from './trading_live.js';
import { storeRithmicCandles } from './rithmic_dataset.js';
import { tradeBars } from './trade_evidence.js';

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

const NOW = Date.parse('2026-10-20T16:00:00.000Z');
const START = Date.parse('2026-10-20T13:30:00.000Z');
const MINUTES = 150; // 13:30 to 16:00 UTC

// A recorded Rithmic minute, exactly as the iPhone sends it (see rithmic_dataset.js candleProblem).
function minute(i, skip = false) {
  if (skip) return null;
  const t = new Date(START + i * 60_000).toISOString();
  const base = 21000 + (i % 7);
  return { source: 'rithmic', symbol: 'MNQZ6', t, o: base, h: base + 2, l: base - 2, c: base + 1, v: 40, trades: 40, buy_volume: 22, sell_volume: 18, delta: 4, exchange: 'CME' };
}

function recorded(skipMinute = null) {
  const out = [];
  for (let i = 0; i < MINUTES; i++) { const c = minute(i, i === skipMinute); if (c) out.push(c); }
  return out;
}

// The delayed Yahoo feed the forward engine stores, as 5-minute bars (the existing LIVE_FEED shape).
function delayedFeed() {
  const bars = [];
  for (let i = 0; i < MINUTES; i += 5) bars.push({ t: new Date(START + i * 60_000).toISOString(), o: 20990, h: 21010, l: 20980, c: 21000, v: 500 });
  return { provider: 'Yahoo MNQ=F', bars };
}

// A 5-minute trade whose signal, entry and exit sit inside the seeded minutes.
const TRADE = {
  id: 'orb|MNQ|2026-10-20T14:02:00.000Z', strategy: 'orb', symbol: 'MNQ', timeframe: '5m', signal_time: '2026-10-20T14:01:00.000Z',
  entry_time: '2026-10-20T14:02:00.000Z', exit_time: '2026-10-20T14:20:00.000Z', feed: 'LIVE',
};

async function seeded({ skipMinute = null, lastMinute = null } = {}) {
  const storage = memStorage();
  const minutes = recorded(skipMinute).filter((c) => lastMinute == null || Date.parse(c.t) <= Date.parse(lastMinute));
  await storeRithmicCandles(storage, minutes, { now: NOW });
  await storage.put(LIVE_FEED, delayedFeed());
  return storage;
}

test('a 5-minute trade is drawn from the recorded Rithmic minutes, never the delayed feed', async () => {
  const storage = await seeded();
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.equal(r.source.kind, 'rithmic_recorded');
  assert.equal(r.source.data_type, 'live-recorded');
  assert.match(r.source.label, /^Rithmic MNQZ6 1-minute, recorded by your iPhone, built into 5m candles$/);
  assert.ok(r.bars.length > 0, 'the trade has candles');
  for (const b of r.bars) {
    assert.ok(!/DELAYED/.test(r.source.label));
    assert.equal(Date.parse(b.t) % 300_000, 0, 'each candle starts on a 5-minute boundary');
  }
});

test('a recorded 5-minute candle is built only from its five minutes, and the open and close match them', async () => {
  const storage = await seeded();
  const r = await tradeBars(storage, TRADE, { now: NOW });
  const entryBucket = Math.floor(Date.parse(TRADE.entry_time) / 300_000) * 300_000;
  const bar = r.bars.find((b) => Date.parse(b.t) === entryBucket);
  assert.ok(bar, 'the entry bucket is present');
  const minutes = recorded().filter((c) => Date.parse(c.t) >= entryBucket && Date.parse(c.t) < entryBucket + 300_000);
  assert.equal(minutes.length, 5);
  assert.equal(bar.o, minutes[0].o, 'open is the first minute open');
  assert.equal(bar.c, minutes.at(-1).c, 'close is the last minute close');
  assert.equal(bar.h, Math.max(...minutes.map((m) => m.h)));
  assert.equal(bar.l, Math.min(...minutes.map((m) => m.l)));
});

test('a missing minute inside the trade bucket means no Rithmic candle: the delayed feed is used and labelled DELAYED', async () => {
  const entryMinute = Math.round((Date.parse(TRADE.entry_time) - START) / 60_000) + 1;
  const storage = await seeded({ skipMinute: entryMinute });
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.notEqual(r.source?.kind, 'rithmic_recorded', 'a bucket with a missing minute is never built');
  assert.equal(r.source?.kind, 'forward_feed');
  assert.equal(r.source?.data_type, 'delayed');
  assert.match(r.source.label, /\(DELAYED\)$/);
});

test('with no recorded minutes, the delayed feed is the only source and it says so', async () => {
  const storage = memStorage();
  await storage.put(LIVE_FEED, delayedFeed());
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.equal(r.source?.kind, 'forward_feed');
  assert.match(r.source.label, /DELAYED/);
});

test('a 1-minute trade still reads the recorded minutes as before', async () => {
  const storage = await seeded();
  const r = await tradeBars(storage, { ...TRADE, timeframe: '1m' }, { now: NOW });
  assert.equal(r.source?.kind, 'rithmic_recorded');
  assert.match(r.source.label, /^Rithmic MNQZ6 1-minute, recorded by your iPhone$/);
});

// Review of #674: a recording that stopped after entry and before exit must not end the replay early.
test('recorded minutes that stop before the exit are not used: the delayed feed covers the whole trade', async () => {
  const storage = await seeded({ lastMinute: '2026-10-20T14:04:00.000Z' });
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.notEqual(r.source?.kind, 'rithmic_recorded');
  assert.equal(r.source?.kind, 'forward_feed');
  const exitBucket = Math.floor(Date.parse(TRADE.exit_time) / 300_000) * 300_000;
  assert.ok(r.bars.some((b) => Date.parse(b.t) === exitBucket), 'the replay reaches the exit candle');
});

test('a missing minute between entry and exit also sends the trade to the delayed feed', async () => {
  const storage = await seeded({ skipMinute: Math.round((Date.parse('2026-10-20T14:11:00.000Z') - START) / 60_000) });
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.equal(r.source?.kind, 'forward_feed');
});

test('recorded minutes that cover entry through exit still win, and the replay reaches the exit', async () => {
  const storage = await seeded({ lastMinute: '2026-10-20T14:24:00.000Z' });
  const r = await tradeBars(storage, TRADE, { now: NOW });
  assert.equal(r.source?.kind, 'rithmic_recorded');
  const exitBucket = Math.floor(Date.parse(TRADE.exit_time) / 300_000) * 300_000;
  assert.ok(r.bars.some((b) => Date.parse(b.t) === exitBucket));
});
