// CHE's forward-recorded Rithmic minutes (owner, 2026-10-23): only self-consistent closed candles are kept, the first
// version of a minute wins, nothing is filled in, and storage is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_DAYS, candleProblem, readRithmicCandles, storeRithmicCandles } from './rithmic_dataset.js';

function memory() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
  };
}

const now = Date.parse('2026-10-23T15:00:00Z');
const candle = (minute, extra = {}) => ({
  t: new Date(Date.parse('2026-10-23T14:00:00Z') + minute * 60000).toISOString(), symbol: 'MNQZ6', exchange: 'CME',
  o: 21000, h: 21010, l: 20990, c: 21005, v: 12, trades: 7, buy_volume: 7, sell_volume: 5, delta: 2, source: 'rithmic', ...extra,
});

test('a closed, self-consistent Rithmic candle is accepted; anything else says why', () => {
  assert.equal(candleProblem(candle(0), now), '');
  assert.match(candleProblem(candle(0, { source: 'yahoo' }), now), /source must be rithmic/);
  assert.match(candleProblem(candle(0, { t: '2026-10-23T14:00:30Z' }), now), /whole UTC minute/);
  assert.match(candleProblem(candle(60), now), /only after its minute has closed/);
  assert.match(candleProblem(candle(0, { h: 21000 }), now), /contain open and close/);
  assert.match(candleProblem(candle(0, { trades: 0 }), now), /at least one trade/);
  assert.match(candleProblem(candle(0, { delta: 5 }), now), /delta must equal/);
  assert.equal(candleProblem(candle(0, { delta: null, buy_volume: 0, sell_volume: 0 }), now), '', 'unknown delta is allowed');
  assert.match(candleProblem(candle(0, { symbol: 'MNQ' }), now), /futures contract/);
});

test('store, dedupe, conflict and read back with honest coverage', async () => {
  const s = memory();
  const first = await storeRithmicCandles(s, [candle(0), candle(1), candle(3), candle(0, { o: 1 })], { now });
  assert.deepEqual([first.stored, first.duplicates, first.conflicts, first.refused], [3, 0, 0, 1]);
  const again = await storeRithmicCandles(s, [candle(1), candle(3, { c: 21009, h: 21010 })], { now });
  assert.deepEqual([again.stored, again.duplicates, again.conflicts], [0, 1, 1], 'closed candles are final; a different resend is a conflict');
  const read = await readRithmicCandles(s, { symbol: 'MNQZ6', from: '2026-10-23T13:00:00Z', to: '2026-10-23T15:00:00Z', now });
  assert.equal(read.ok, true);
  assert.deepEqual(read.candles.map((c) => c.t.slice(11, 16)), ['14:00', '14:01', '14:03']);
  assert.equal(read.candles[2].c, 21005, 'the first stored version stands');
  assert.equal(read.candles[0].source, 'rithmic');
  assert.equal(read.candles[0].recorded_by, 'owner iPhone');
  assert.deepEqual([read.coverage.minutes_recorded, read.coverage.minutes_in_span, read.coverage.minutes_missing], [3, 4, 1]);
});

test('storage stays bounded: hours older than the kept window are dropped when new data arrives', async () => {
  const s = memory();
  const old = { ...candle(0), t: '2026-01-01T10:00:00.000Z' };
  await storeRithmicCandles(s, [old], { now: Date.parse('2026-01-01T11:00:00Z') });
  assert.ok(s.m.has('rithmic_1m:MNQZ6:2026-01-01T10'));
  await storeRithmicCandles(s, [candle(0)], { now });
  assert.ok(!s.m.has('rithmic_1m:MNQZ6:2026-01-01T10'), `older than ${KEEP_DAYS} days is dropped`);
  assert.deepEqual(await s.get('rithmic_1m_index:MNQZ6'), ['2026-10-23T14']);
});

test('a batch that is not a list or too large is refused whole', async () => {
  assert.equal((await storeRithmicCandles(memory(), null, { now })).ok, false);
  assert.equal((await storeRithmicCandles(memory(), Array.from({ length: 501 }, () => candle(0)), { now })).ok, false);
});
