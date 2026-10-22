import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIMEFRAMES, costPoints, resample, calendarBars, runStrategy, summarize, evaluateCell, buildMatrix,
  loadMatrixBars, speakMatrix, nyHour, byHour, matrixIntent, runMatrix, readMatrix, MATRIX_KEY,
} from './backtest_matrix.js';
import { intelligenceIntent } from './historical_intelligence.js';
import { prepare } from './trading_lab.js';
import { MIN_TRADES } from './trading_evidence.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

// A trending, swinging series: rising drift plus a slow wave, so breakouts and pullbacks both happen.
function series(n, stepMs, startMs = Date.UTC(2026, 0, 5, 14, 0)) {
  const out = [];
  let prev = 20000;
  for (let i = 0; i < n; i++) {
    const mid = 20000 + i * 0.6 + 120 * Math.sin(i / 9) + 40 * Math.sin(i / 2.3);
    const o = prev;
    const c = mid;
    out.push({ t: new Date(startMs + i * stepMs).toISOString(), o, h: Math.max(o, c) + 6, l: Math.min(o, c) - 6, c, v: 100 + (i % 7) });
    prev = c;
  }
  return out;
}

test('MNQ round-trip cost: spread, slippage on entry (and on a stop exit), commission and fees', () => {
  // 1 tick spread (0.25) + 1 tick entry slippage (0.25) + $4 commission+fees / $2 a point (2.0)
  assert.equal(costPoints(false), 2.5);
  // a stop exit pays one more tick of slippage
  assert.equal(costPoints(true), 2.75);
});

test('resample: complete buckets only; a gap never makes a bar', () => {
  const base = series(6, 5 * MIN, Date.UTC(2026, 0, 5, 14, 0));
  const out = resample(base, 5 * MIN, 15 * MIN);
  assert.equal(out.length, 2);
  assert.equal(out[0].o, base[0].o);
  assert.equal(out[0].c, base[2].c);
  assert.equal(out[0].h, Math.max(...base.slice(0, 3).map((b) => b.h)));
  const gapped = [...base.slice(0, 2), ...base.slice(3)];
  assert.equal(resample(gapped, 5 * MIN, 15 * MIN).length, 1, 'the bucket with a missing bar is dropped');
});

test('calendar bars: months from daily bars, the still-forming month left out', () => {
  const daily = [];
  for (let d = 0; d < 70; d++) {
    const t = Date.UTC(2026, 0, 1) + d * 24 * HOUR;
    daily.push({ t: new Date(t).toISOString(), o: 100 + d, h: 101 + d, l: 99 + d, c: 100.5 + d, v: 1 });
  }
  const now = Date.UTC(2026, 2, 11); // March is still forming
  const months = calendarBars(daily, 'month', now);
  assert.deepEqual(months.map((m) => m.t.slice(0, 7)), ['2026-01', '2026-02']);
  assert.equal(months[0].o, 100);
  assert.equal(months[0].c, 130.5); // Jan 31 close
});

test('every trade is recorded with its entry time and pays costs', () => {
  const bars = series(1200, HOUR);
  const trades = runStrategy(bars, 'channel-20|any|2', prepare(bars));
  assert.ok(trades.length > 0);
  for (const t of trades) {
    assert.ok(Date.parse(t.in) > 0);
    assert.ok(t.r < t.r_gross, 'net R is below gross R');
  }
});

test('a cell under 30 trades is marked not enough and is never ranked', () => {
  const tf = TIMEFRAMES.find((t) => t.id === '1h');
  const bars = series(130, HOUR);
  const cell = evaluateCell(bars, { id: 'channel-20|any|2', name: 'x', signal: 'channel-20' }, { ...tf, barMs: HOUR });
  assert.ok(cell.all.trades < MIN_TRADES);
  assert.equal(cell.enough, false);
  const m = buildMatrix({ '1h': bars }, { now: Date.UTC(2026, 5, 1) });
  assert.equal(m.ranking.length, 0);
});

test('session rules are not run on daily and longer bars', () => {
  const cell = evaluateCell(series(200, 24 * HOUR), { id: 'vwap-reclaim|any|2', name: 'VWAP', signal: 'vwap-reclaim' }, { id: '1d', barMs: 24 * HOUR });
  assert.equal(cell.applicable, false);
});

test('15 seconds is reported as unavailable, never estimated; a missing source says why', () => {
  const m = buildMatrix({ '1h': series(1500, HOUR) }, { now: Date.UTC(2026, 5, 1) });
  const s15 = m.timeframes.find((t) => t.id === '15s');
  assert.equal(s15.available, false);
  assert.match(s15.why, /no sub-minute/i);
  const m1 = m.timeframes.find((t) => t.id === '1m');
  assert.equal(m1.available, false);
  assert.match(m1.why, /No bars/);
  const h1 = m.timeframes.find((t) => t.id === '1h');
  assert.equal(h1.available, true);
  assert.equal(h1.cells.length, 10);
  const h4 = m.timeframes.find((t) => t.id === '4h');
  assert.ok(h4.bars > 0, '4h is built from the 1h bars');
});

test('enough history ranks cells by the unseen part and gives the best New York hour', () => {
  const m = buildMatrix({ '1h': series(6000, HOUR) }, { now: Date.UTC(2027, 0, 1) });
  assert.ok(m.ranking.length > 0);
  for (const r of m.ranking) {
    assert.ok(r.trades >= MIN_TRADES);
    assert.ok(r.unseen_trades >= 10);
  }
  for (let i = 1; i < m.ranking.length; i++) assert.ok(m.ranking[i - 1].unseen_expectancy_r >= m.ranking[i].unseen_expectancy_r);
  const cell = m.timeframes.find((t) => t.id === '1h').cells.find((c) => c.applicable && c.hours?.length);
  for (const h of cell.hours) assert.ok(h.hour >= 0 && h.hour <= 23);
});

test('New York hour accounts for daylight time', () => {
  assert.equal(nyHour('2026-01-15T14:30:00Z'), 9);  // EST
  assert.equal(nyHour('2026-07-15T13:30:00Z'), 9);  // EDT
  const hours = byHour([{ in: '2026-01-15T14:30:00Z', r: 1 }, { in: '2026-01-15T14:45:00Z', r: -1 }]);
  assert.deepEqual(hours.map((h) => [h.hour, h.trades]), [[9, 2]]);
});

test('summary statistics: win rate with its interval, expectancy, drawdown', () => {
  const s = summarize([{ r: 2 }, { r: -1 }, { r: -1 }, { r: 2 }]);
  assert.equal(s.trades, 4);
  assert.equal(s.win_rate, 0.5);
  assert.ok(s.win_low < 0.5 && s.win_high > 0.5);
  assert.equal(s.expectancy_r, 0.5);
  assert.equal(s.max_drawdown_r, 2);
  assert.equal(summarize([]).win_rate, null);
});

test('loader: one failed source is reported and the others still load', async () => {
  const yahoo = (bars) => ({ chart: { result: [{ timestamp: bars.map((b) => Date.parse(b.t) / 1000), meta: { regularMarketTime: 2e9 }, indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] } }] } });
  const seen = [];
  const fetcher = async (url) => {
    seen.push(String(url));
    if (/stooq/.test(url)) return new Response('Date,Open,High,Low,Close,Volume\n2026-01-02,1,2,0.5,1.5,10\n2026-01-05,1.5,2.5,1,2,10\n');
    if (/interval=1m/.test(url)) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify(yahoo(series(5, HOUR))), { headers: { 'content-type': 'application/json' } });
  };
  const { bars, errors } = await loadMatrixBars({ fetcher, now: 2e12 });
  assert.match(errors['1m'], /503/);
  assert.equal(bars['5m'].length, 5);
  assert.equal(bars['1h'].length, 5);
  assert.equal(bars['1d'].length, 2);
  assert.ok(seen.every((u) => !/15s/.test(u)), 'no request is made for 15-second bars');
});

test('spoken summary names what was not tested and makes no promise', () => {
  const m = buildMatrix({ '1h': series(6000, HOUR) }, { now: Date.UTC(2027, 0, 1) });
  const text = speakMatrix(m);
  assert.match(text, /15 seconds/);
  assert.match(text, /not a promise/);
  assert.doesNotMatch(text, /guarantee|will make|sure thing/i);
  assert.equal(speakMatrix(null), 'The backtest matrix has not been run yet.');
});

test('intent: timeframe and time-of-day questions; decades-of-history questions stay with the historical study', () => {
  assert.deepEqual(matrixIntent('Backtest all the strategies on every timeframe'), { kind: 'run' });
  assert.deepEqual(matrixIntent('/trade-matrix run the timeframe backtest'), { kind: 'run' });
  assert.deepEqual(matrixIntent('Which strategy works best on which timeframe for NQ?'), { kind: 'summary' });
  assert.deepEqual(matrixIntent('What is the best time of day to trade NQ?'), { kind: 'summary' });
  assert.equal(matrixIntent('What time is it?'), null);
  assert.equal(matrixIntent('How did your strategies do historically on NQ since 1999?'), null);
  assert.ok(intelligenceIntent('How did your strategies do historically on NQ since 1999?'));
});

class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return structuredClone(this.map.get(k)); }
  async put(k, v) {
    const size = JSON.stringify(v).length;
    assert.ok(size < 128 * 1024, `${k} is ${size} bytes: over the Durable Object value limit`);
    this.map.set(k, structuredClone(v));
  }
}

test('run and read back: one stored value per timeframe, each under the storage limit; failed sources say why', async () => {
  const yahoo = (bars) => ({ chart: { result: [{ timestamp: bars.map((b) => Date.parse(b.t) / 1000), meta: { regularMarketTime: 2e9 }, indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] } }] } });
  const fetcher = async (url) => {
    if (/stooq/.test(url)) return new Response('busy', { status: 503 });
    if (/interval=1h/.test(url)) return new Response(JSON.stringify(yahoo(series(6000, HOUR))));
    return new Response('{}', { status: 500 });
  };
  const storage = new MemoryStorage();
  const m = await runMatrix(storage, { fetcher, now: Date.UTC(2027, 0, 1) });
  assert.ok(m.ranking.length > 0);
  const back = await readMatrix(storage);
  assert.equal(back.timeframes.length, 10);
  assert.equal(back.ranking.length, m.ranking.length);
  assert.match(back.timeframes.find((t) => t.id === '1m').why, /did not answer/);
  assert.ok(storage.map.has(`${MATRIX_KEY}:1h`));
  assert.equal(await readMatrix(new MemoryStorage()), null);
});
