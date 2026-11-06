// The hourly volatility test (owner, 2026-11-06: "Yes put them on paper"): inside bar and previous-day sweep on 1-hour
// MNQ bars with 2 ATR stops, forward only, journalled apart from the 5-minute desk.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readTrades } from './trading_evidence.js';
import { HOURLY_PORTFOLIOS, HOURLY_SPECS, hourlyRecord, hourlyTick, liveDashboard, readHourlyPortfolios, setLivePaper } from './trading_live.js';
import { haltState, learnedReason } from './strategy_governor.js';

haltState.halted = false;

function memoryStorage(saved = new Map()) {
  return {
    saved,
    get: async (key) => {
      if (Array.isArray(key)) return new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]));
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    put: async (key, value) => {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
  };
}

// Repeating inside-bar breakouts on hourly bars, Monday to Thursday, 13:00 to 19:00 UTC (9:00 to 15:00 New York).
const shape = [[0, 12, -12, 4], [4, 8, 0, 3], [3, 14, 2, 13], [13, 20, 8, 10], [10, 30, 6, 25], [25, 26, -5, -2], [-2, 4, -18, -10]];
function hourlyBars(days) {
  const out = [];
  let p = 20000; let i = 0;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const t = Date.UTC(2026, 9, 5 + d, h);
      const [o, hi, lo, c] = shape[i++ % shape.length];
      out.push({ t: new Date(t).toISOString(), o: p + o, h: p + hi, l: p + lo, c: p + c, v: 100 });
      if (i % shape.length === 0) p += 1;
    }
  }
  return out;
}
const feed = (bars, calls = []) => async (root, opts) => { calls.push(opts); return { status: 'DELAYED', interval: opts.interval, provider: 'test', provider_symbol: 'MNQ=F', contract: 'MNQZ6', candles: bars, checked_at: '' }; };
const after = (bars) => Date.parse(bars.at(-1).t) + 3_600_000 + 5 * 60_000;

test('the hourly desk trades only the two setups that passed, with 2 ATR stops on 1-hour bars', async () => {
  const pfs = await readHourlyPortfolios(memoryStorage());
  assert.deepEqual(pfs.map((pf) => pf.candidate), ['inside-bar-5m', 'pdhl-sweep-5m']);
  for (const pf of pfs) {
    assert.equal(pf.resolution, '1h');
    assert.equal(pf.source, 'paper');
    assert.equal(pf.params.stop_atr, 2);
    assert.ok(pf.params.quality, 'the trade-quality rules apply');
  }
  assert.equal(HOURLY_SPECS.length, 2);
});

test('the 5-minute exclusions do not block the hourly test, and still block the 5-minute desk', () => {
  assert.equal(learnedReason({ candidate: 'pdhl-sweep-5m', contract: 'MNQ', resolution: '1h' }), null);
  assert.match(learnedReason({ candidate: 'pdhl-sweep-5m', contract: 'MNQ', resolution: '5m' }), /learned from the backtests/);
});

test('forward only: the first pass starts at the newest bar; later bars are traded, journalled as 1h and kept apart', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, Date.UTC(2026, 9, 5));
  const all = hourlyBars(10);
  const first = all.slice(0, 24 * 3);
  const calls = [];
  const r1 = await hourlyTick(storage, { load: feed(first, calls), now: after(first) });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(calls[0].interval, '60m');
  assert.equal(r1.closed, 0, 'history is never journalled as paper');
  const r2 = await hourlyTick(storage, { load: feed(all, calls), now: after(all) });
  assert.equal(r2.ok, true, r2.error);
  const trades = await readTrades(storage, (t) => t.data?.resolution === '1h');
  assert.ok(trades.length > 0, 'the hourly desk closed paper trades');
  for (const t of trades) {
    assert.equal(t.environment, 'paper');
    assert.ok(t.entry.time > first.at(-1).t, 'only bars after the start are traded');
    assert.equal(t.params.stop_atr, 2);
  }
  const rec = await hourlyRecord(storage);
  assert.equal(rec.trades, trades.length);
  assert.equal(rec.started, first.at(-1).t);
  const dash = await liveDashboard(storage, { now: after(all) });
  assert.equal(dash.totals.trades, 0, 'the 5-minute desk record does not include hourly trades');
  assert.equal(dash.hourly.trades, trades.length);
  assert.ok((await storage.get(HOURLY_PORTFOLIOS)), 'portfolio state is saved');
});

test('Yahoo is asked only when a new hourly bar can have closed, and not while paper trading is off', async () => {
  const storage = memoryStorage();
  const bars = hourlyBars(3);
  const calls = [];
  assert.equal((await hourlyTick(storage, { load: feed(bars, calls), now: after(bars) })).skipped, 'paper trading is off');
  await setLivePaper(storage, true, Date.UTC(2026, 9, 5));
  await hourlyTick(storage, { load: feed(bars, calls), now: after(bars) });
  assert.equal(calls.length, 1);
  assert.equal((await hourlyTick(storage, { load: feed(bars, calls), now: after(bars) + 20 * 60_000 })).skipped, 'no new hourly bar yet');
  assert.equal(calls.length, 1);
});

test('a stale hourly bar is refused before anything is traded', async () => {
  const storage = memoryStorage();
  await setLivePaper(storage, true, Date.UTC(2026, 9, 5));
  const bars = hourlyBars(3);
  const r = await hourlyTick(storage, { load: feed(bars), now: after(bars) + 3 * 3_600_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /newest hourly bar closed/);
});

test('hourly signals reach the inbox with the 5-minute ones, marked as the hourly test, even on a throttled 5-minute pass', async () => {
  const { notifySignals } = await import('./trading_live.js');
  const sent = [];
  const sig = { strategy: 'inside-bar-5m', filter: 'any', contract: 'MNQ', timeframe: '1h', side: 'long', ref: 20000, stop: 19950, target: 20100, why: 'closed above the inside bar high' };
  await notifySignals({ skipped: 'ran recently', hourly: { ok: true, new_signals: [sig] } }, (a, b) => sent.push([a, b]));
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /1-hour volatility test/);
  assert.match(sent[0][1], /no real order was placed/);
  sent.length = 0;
  await notifySignals({ new_signals: [], hourly: { skipped: 'no new hourly bar yet', new_signals: [sig] } }, (a, b) => sent.push([a, b]));
  assert.equal(sent.length, 0, 'a skipped hourly pass sends nothing again');
});
