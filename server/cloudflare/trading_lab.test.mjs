import test from 'node:test';
import assert from 'node:assert/strict';
import { swings, patternsAt, backtest, backtestAll, analyze, resolveSymbol, tradingIntent, paperTick, readBook, speakBook, prepare, stats } from './trading_lab.js';

// Deterministic wavy uptrend: real swings, some breakouts.
function series(n = 1500) {
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const noise = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.8;
    const drift = Math.sin(i / 9) * 1.8 + Math.sin(i / 37) * 0.9 + 0.06 + noise;
    const o = price;
    const c = Math.max(1, price + drift);
    out.push({ t: new Date(Date.UTC(2010, 0, 1) + i * 86400000).toISOString().slice(0, 10), o, c, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.6, v: 1 });
    price = c;
  }
  return out;
}

test('swing highs and lows are real pivots', () => {
  const c = series(600);
  const { highs, lows } = swings(c, 3);
  assert.ok(highs.length > 5 && lows.length > 5, `${highs.length}/${lows.length}`);
  for (const s of highs) for (let j = s.i - 3; j <= s.i + 3; j++) if (j !== s.i) assert.ok(j < s.i ? c[j].h < s.price : c[j].h <= s.price);
});

test('candlestick patterns', () => {
  const bullEngulf = [{ o: 10, c: 9, h: 10.2, l: 8.9 }, { o: 8.8, c: 10.5, h: 10.6, l: 8.7 }];
  assert.ok(patternsAt(bullEngulf, 1).includes('bullish engulfing'));
  const hammer = [{ o: 10, c: 10, h: 10, l: 10 }, { o: 10, c: 10.2, h: 10.25, l: 9 }];
  assert.ok(patternsAt(hammer, 1).includes('hammer'));
});

test('backtest has no look-ahead: future bars do not change past trades', () => {
  const c = series(4000);
  const a = backtest(c.slice(0, 3000), 'swing-breakout');
  const b = backtest(c, 'swing-breakout', { to: 3000, ctx: prepare(c.slice(0, 3000)) });
  assert.equal(a.trades_count, b.trades_count);
  assert.ok(a.trades_count > 10, 'enough trades to judge');
  assert.ok(Number.isFinite(a.expectancy_r));
});

test('backtestAll splits learn/unseen and reports honest stats', () => {
  const results = backtestAll(series(2000));
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok('learn' in r && 'unseen' in r && typeof r.passes === 'boolean');
    assert.ok(r.unseen.max_drawdown_r >= 0);
  }
  assert.deepEqual(stats([]).trades_count, 0);
});

test('analyze reports trend, swings and entries', () => {
  const a = analyze({ label: 'TEST', data: 'test', live: false, candles: series(400) });
  assert.ok(a.trend && Array.isArray(a.swing_highs) && Array.isArray(a.entries));
});

test('symbols and voice intents', () => {
  assert.equal(resolveSymbol('bitcoin').symbol, 'BTCUSDT');
  assert.equal(resolveSymbol('AAPL').symbol, 'aapl.us');
  assert.equal(resolveSymbol('s&p').symbol, '^spx');
  assert.equal(tradingIntent('CHE, how are the trades doing?').kind, 'book');
  assert.equal(tradingIntent('backtest bitcoin').kind, 'backtest');
  assert.equal(tradingIntent('backtest bitcoin').symbol, 'bitcoin');
  assert.equal(tradingIntent('find the swing highs and entry points on ETH').kind, 'analyze');
  assert.equal(tradingIntent('what time is it'), null);
  assert.equal(tradingIntent('analyze my CV for typos'), null);
});

test('paper trading closes, learns and journals without real orders', async () => {
  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  const c = series(1200);
  const rows = c.map((k) => [Date.parse(k.t), k.o, k.h, k.l, k.c, 1]);
  const fetcher = async (url) => {
    assert.match(String(url), /api\.binance\.com|stooq\.com/);
    if (String(url).includes('binance')) return new Response(JSON.stringify(rows), { status: 200 });
    return new Response('Date,Open,High,Low,Close,Volume\n' + c.map((k) => [k.t, k.o, k.h, k.l, k.c, 1].join(',')).join('\n'), { status: 200 });
  };
  const book = await paperTick(storage, { fetcher, force: true });
  assert.ok(Object.keys(book.learned).length >= 1, 'learned which strategy works per market');
  const again = await readBook(storage);
  assert.ok(again.last_tick);
  assert.match(speakBook(again), /Paper trading, no real money/);
});
