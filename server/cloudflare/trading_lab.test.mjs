import test from 'node:test';
import assert from 'node:assert/strict';
import { swings, patternsAt, backtest, backtestAll, analyze, resolveSymbol, tradingIntent, paperTick, readBook, speakBook, prepare, stats, nextTradingTickAt, SKILL_IDS, discoverSkills, learnStep, strategyById, futuresDollars, speakLearning } from './trading_lab.js';

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

test('skills: every combination is a valid, look-ahead-free strategy', () => {
  assert.equal(SKILL_IDS.length, 63);
  const c = series(1500);
  const ctx = prepare(c);
  for (const id of SKILL_IDS) {
    const s = strategyById(id);
    assert.ok(s, id);
    for (let i = 60; i < c.length; i += 37) {
      const e = s.entry(c, i, ctx);
      if (e) assert.ok(e.stop < e.entry && e.target > e.entry, id);
    }
  }
  // Truncating the future does not change what a skill sees today.
  const id = 'channel-20|any|2';
  const full = backtest(c, id, { to: 1000 });
  const cut = backtest(c.slice(0, 1000), id);
  assert.deepEqual(full.trades, cut.trades);
});

test('discovery keeps only skills that hold up on all three parts of history', () => {
  const r = discoverSkills(series(1500));
  for (const x of r.filter((y) => y.found)) {
    for (const part of [x.choose, x.confirm]) assert.ok(part.expectancy_r > 0 && part.profit_factor > 1.15, x.id);
  }
  // The held-back part never decides: same choose/confirm, any test result.
  for (const x of r) {
    const decides = x.choose.trades_count >= 20 && x.confirm.trades_count >= 6
      && [x.choose, x.confirm].every((p) => p.expectancy_r > 0 && p.profit_factor > 1.15);
    assert.equal(x.found, decides, x.id);
  }
  // A flat, noisy market with no edge yields (almost) nothing.
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let p = 100;
  const noise = Array.from({ length: 3000 }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.03; return { t: String(i).padStart(6, '0'), o, c: p, h: Math.max(o, p) * (1 + rnd() * 0.01), l: Math.min(o, p) * (1 - rnd() * 0.01), v: 1 }; });
  assert.ok(discoverSkills(noise).filter((x) => x.found).length <= 3);
});

test('learning works through every skill in batches and re-tests after 30 days', () => {
  const c = series(1500);
  const t0 = Date.UTC(2026, 9, 1);
  let lab;
  let steps = 0;
  do { lab = learnStep(lab, c, t0 + steps * 3600_000).lab; steps += 1; } while (lab.tested.length < SKILL_IDS.length);
  assert.equal(steps, Math.ceil(SKILL_IDS.length / 12));
  assert.equal(lab.progress, `${SKILL_IDS.length} of ${SKILL_IDS.length}`);
  if (lab.found.length) assert.equal(lab.best, lab.found[0]);
  const known = [...lab.known];
  assert.deepEqual([...known].sort(), [...lab.found].sort());
  let later = learnStep(lab, c, t0 + 31 * 86400000);
  assert.equal(later.lab.tested.length, 12, 'a new cycle starts');
  // Re-finding the same skills next month is not announced as new.
  const renewed = [...later.newly];
  while (later.lab.tested.length < SKILL_IDS.length) { later = learnStep(later.lab, c, t0 + 31 * 86400000 + 3600_000); renewed.push(...later.newly); }
  assert.deepEqual(renewed, []);
  if (later.lab.found.length > 1) {
    const ranks = later.lab.found.map((id) => later.lab.results[id].confirm.expectancy_r);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'ranked by confirm, not by the held-back test');
  }
});

test('futures: ES/NQ and micros, dollars per contract, voice', () => {
  assert.equal(resolveSymbol('ES').symbol, 'es.f');
  assert.equal(resolveSymbol('MNQ').symbol, 'nq.f');
  assert.equal(resolveSymbol('nq').label, 'NQ futures');
  assert.deepEqual(futuresDollars('es.f', 10), { contract: 'ES', per_contract: 500, micro: 'MES', per_micro: 50 });
  assert.deepEqual(futuresDollars('nq.f', -25), { contract: 'NQ', per_contract: -500, micro: 'MNQ', per_micro: -50 });
  assert.equal(futuresDollars('BTCUSDT', 10), null);
  assert.equal(tradingIntent('CHE, what have you learned about trading?').kind, 'learning');
  assert.equal(tradingIntent('any new trading skills?').kind, 'learning');
  assert.equal(tradingIntent('learn a new skill for the app'), null);
});

test('paper ticks keep learning, journal discoveries and add index futures once', async () => {
  const m = new Map([['trading_paper_book', { watch: ['BTCUSDT'] }]]);
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  const c = series(1500);
  const fetcher = async (url) => {
    if (String(url).includes('binance')) return new Response(JSON.stringify(c.map((k) => [Date.parse(k.t), k.o, k.h, k.l, k.c, 1])), { status: 200 });
    return new Response('Date,Open,High,Low,Close,Volume\n' + c.map((k) => [k.t, k.o, k.h, k.l, k.c, 1].join(',')).join('\n'), { status: 200 });
  };
  let book;
  for (let h = 0; h < 6; h++) book = await paperTick(storage, { fetcher, force: true, now: Date.UTC(2026, 9, 4, h) });
  assert.deepEqual(book.watch, ['BTCUSDT', 'es.f', 'nq.f']);
  for (const sym of book.watch) assert.equal(book.lab[sym].tested.length, SKILL_IDS.length);
  assert.equal(book.discoveries.length, book.watch.reduce((n, sym) => n + book.lab[sym].found.length, 0));
  // The owner removing a futures symbol later is respected.
  book.watch = ['BTCUSDT'];
  m.set('trading_paper_book', book);
  assert.deepEqual((await readBook(storage)).watch, ['BTCUSDT']);
  const said = speakLearning(book);
  assert.match(said, /paper only, no real money/);
  assert.match(said, /delayed/);
  assert.doesNotMatch(said, /undefined|NaN/);
});

test('the next learning tick is due an hour after the last one', async () => {
  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  const soon = await nextTradingTickAt(storage);
  assert.ok(soon - Date.now() <= 60_000);
  m.set('trading_paper_book', { last_tick: '2026-10-04T10:00:00.000Z' });
  assert.equal(await nextTradingTickAt(storage), Date.parse('2026-10-04T11:00:00.000Z'));
});
