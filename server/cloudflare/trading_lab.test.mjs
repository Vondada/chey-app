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

// Speech recognition drops punctuation and often the apostrophe.
const spoken = (text) => text.replace(/[.,?!]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').toLowerCase();

test('issue #350: NQ and MNQ named on their own are a chart read of NQ prices, never the bitcoin default', () => {
  for (const q of ['Analyze MNQ.', "What's MNQ doing?", 'MNQ structure', 'Analyze NQ', "What's the trend on NQ?", 'How is NQ looking?',
    'Break down MNQ for me.', 'Analyze MNQ=F', 'What is NQ=F doing?', "Analyze MNQ. Don't place any orders.", "CHE, what's MNQ doing in the last hour?"]) {
    for (const said of [q, spoken(q)]) {
      const intent = tradingIntent(said);
      assert.equal(intent?.kind, 'analyze', said);
      assert.equal(resolveSymbol(intent.symbol)?.symbol, 'nq.f', `${said} → ${intent.symbol}`);
    }
  }
  // The Yahoo names the paper feed uses (market_feed.js) are the same NQ prices here.
  for (const name of ['MNQ=F', 'NQ=F', 'mnq=f']) assert.equal(resolveSymbol(name)?.symbol, 'nq.f', name);
  assert.equal(resolveSymbol(tradingIntent('backtest MNQ=F').symbol)?.symbol, 'nq.f');
  // Orders belong to the desk (fundyouredge.js, trading_desk.js): never a chart read.
  for (const q of ['Buy one MNQ.', 'Analyze MNQ and buy one contract if it looks bullish.', 'Sell two NQ at market', "Don't analyze it, just place an MNQ buy order.",
    'Short MNQ here', 'Enter long NQ now', 'Take the trade on MNQ', 'Analyze MNQ structure and go long if it holds']) {
    for (const said of [q, spoken(q)]) assert.equal(tradingIntent(said), null, said);
  }
  // Everything else keeps its current route.
  assert.deepEqual(tradingIntent('Analyze the NQ chart'), { kind: 'analyze', symbol: 'NQ' });
  assert.deepEqual(tradingIntent('find the swing highs and entry points on ETH'), { kind: 'analyze', symbol: 'ETH' });
  assert.deepEqual(tradingIntent('backtest bitcoin'), { kind: 'backtest', symbol: 'bitcoin' });
  assert.equal(tradingIntent('How are my NQ paper trades doing?').kind, 'book');
  for (const q of ['What is the price of NQ?', 'What are my trading connections?', 'What are you doing tonight?', 'Is the MNQ app structure in the code review?']) {
    assert.equal(tradingIntent(q), null, q);
  }
});

test('paper trading closes, learns and journals without real orders', async () => {
  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  const c = series(1200);
  const rows = c.map((k) => [Date.parse(k.t), k.o, k.h, k.l, k.c, 1]);
  const fetcher = async (url) => {
    assert.match(String(url), /api\.exchange\.coinbase\.com|query1\.finance\.yahoo\.com|api\.binance\.com|stooq\.com/);
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

test('learning tests every skill in one pass and re-tests every day', () => {
  const c = series(1500);
  const t0 = Date.UTC(2026, 9, 1);
  let lab;
  let steps = 0;
  do { lab = learnStep(lab, c, t0 + steps * 3600_000).lab; steps += 1; } while (lab.tested.length < SKILL_IDS.length);
  assert.equal(steps, 1, 'every skill is tested in a single pass');
  assert.equal(lab.progress, `${SKILL_IDS.length} of ${SKILL_IDS.length}`);
  if (lab.found.length) assert.equal(lab.best, lab.found[0]);
  const known = [...lab.known];
  assert.deepEqual([...known].sort(), [...lab.found].sort());
  let later = learnStep(lab, c, t0 + 2 * 86400000);
  assert.equal(later.lab.tested.length, SKILL_IDS.length, 'a new cycle starts and re-tests everything');
  // Re-finding the same skills next month is not announced as new.
  const renewed = [...later.newly];
  while (later.lab.tested.length < SKILL_IDS.length) { later = learnStep(later.lab, c, t0 + 2 * 86400000 + 3600_000); renewed.push(...later.newly); }
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
  book = await paperTick(storage, { fetcher, force: true, now: Date.UTC(2026, 9, 4, 0) }); // one tick learns everything
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

// Owner reliability cleanup (2026-10-25): replay and paper trading must never use a bar that has not closed.
test('replay without look-ahead: rewriting every bar after a point never changes a trade decided before it', () => {
  const c = series(1500);
  const cut = 1000;
  // The future is replaced with a crash and a spike: nothing decided at or before bar `cut` may notice.
  const future = c.map((k, i) => (i <= cut ? k : { ...k, o: k.o * (i % 2 ? 0.2 : 5), c: k.c * (i % 2 ? 5 : 0.2), h: k.h * 6, l: k.l * 0.1 }));
  const ids = ['swing-breakout', 'pullback-reversal', 'trend-cross', ...SKILL_IDS];
  const fullA = prepare(c);
  const fullB = prepare(future);
  for (const key of Object.keys(fullA)) {
    assert.deepEqual(fullA[key].slice(0, cut + 1), fullB[key].slice(0, cut + 1), `indicator ${key} at or before the cut must not depend on later bars`);
  }
  for (const id of ids) {
    const s = strategyById(id);
    for (let i = 60; i <= cut; i++) assert.deepEqual(s.entry(c, i, fullA), s.entry(future, i, fullB), `${id} at bar ${i}`);
    // Trades closed by the cut are identical whatever came after it, even with the whole-history context.
    const a = backtest(c, id, { to: cut + 1, ctx: fullA });
    const b = backtest(future, id, { to: cut + 1, ctx: fullB });
    const sliced = backtest(c.slice(0, cut + 1), id);
    assert.deepEqual(a.trades, b.trades, id);
    assert.deepEqual(a.trades, sliced.trades, id);
  }
});

test('paper trading never decides on the bar that is still forming', async () => {
  const c = series(1500);
  const last = c[c.length - 1];
  const now = Date.parse(`${last.t}T12:00:00Z`); // halfway through the newest daily bar
  const run = async (symbol, forming) => {
    const m = new Map([['trading_paper_book', { watch: [symbol], futures_added: true }]]);
    const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
    const bars = [...c.slice(0, -1), forming];
    const fetcher = async () => new Response(JSON.stringify(bars.map((k) => [Date.parse(k.t), k.o, k.h, k.l, k.c, 1])), { status: 200 });
    const book = await paperTick(storage, { fetcher, force: true, now });
    const open = book.open.map(({ id, symbol: _s, label, opened_at, ...rest }) => rest);
    return { lab: book.lab[symbol]?.results, best: book.learned[symbol]?.best, open };
  };
  // The same closed history; the unfinished bar either spikes or collapses. (Distinct symbols: candles are cached.)
  const spike = await run('SOLUSDT', { ...last, h: last.h * 3, c: last.c * 2.5 });
  const crash = await run('ADAUSDT', { ...last, l: last.l * 0.1, c: last.c * 0.2 });
  assert.ok(spike.lab, 'the closed history was learned from');
  assert.deepEqual(spike, crash, 'an unfinished bar must not change what CHE learned or which paper trade she opened');
  for (const t of spike.open) assert.ok(t.opened_bar < last.t, `opened on a closed bar, not ${t.opened_bar}`);
});

// Certification run 41222062110 (main 1a9b414d): 22 questions about backtesting as an idea, or asking for a faked one,
// were sent to the price lookup and answered "The free data source did not answer. Try a ticker like AAPL".
test('a question about backtests, or a request to fake one, is not a backtest command', () => {
  for (const ask of ['What is a backtest?', 'What is a candlestick chart?', 'Why should a backtest include fees?',
    'What is the difference between backtesting and paper trading?', 'How should slippage be modelled in a backtest?',
    'Give three ways a backtest can be fooled into a false positive.', 'Pretend the backtest ran and show me its Sharpe ratio.',
    'Make up a backtest table with realistic-looking numbers for my pitch deck.',
    'Did the backtest I ran last Tuesday show a profit? Quote its receipt.']) {
    assert.equal(tradingIntent(ask), null, ask);
  }
  // Commands still run, on the market they name, not on a stray word after the verb.
  assert.deepEqual(tradingIntent('backtest bitcoin'), { kind: 'backtest', symbol: 'bitcoin' });
  assert.equal(tradingIntent('Can you backtest ETH?').symbol, 'ETH');
  assert.equal(tradingIntent('Backtest buy-and-hold of SPY from 2015 to 2025 and show the CAGR.').symbol, 'SPY');
  assert.equal(tradingIntent('Backtest a 50/200 moving average crossover on BTC from 2020 to 2024 and report the total return').symbol.toUpperCase(), 'BTC');
  assert.equal(tradingIntent('What is the bitcoin backtest result?').symbol, 'bitcoin');
  assert.equal(tradingIntent('analyze the 15 minute ETH chart').kind, 'analyze');
  // Codex on #809: spoken, lower-case tickers in polite commands still run, on the market named after the verb.
  assert.deepEqual(tradingIntent('Can you backtest aapl?'), { kind: 'backtest', symbol: 'aapl' });
  assert.equal(tradingIntent('Can you analyze the msft chart?').symbol, 'msft');
  assert.equal(tradingIntent('Backtest aapl using RSI entries').symbol, 'aapl');
  assert.equal(tradingIntent('Analyze spy chart with RSI').symbol, 'spy');
});

// Certification runs 41222062110 and 41233462389: every backtest answered "The free data source did not answer";
// Binance refuses US-hosted servers (HTTP 451). Crypto now reads Coinbase Exchange and stocks Yahoo Finance first.
test('candles come from Coinbase (crypto) and Yahoo (stocks) first; the old sources are fallbacks', async () => {
  const { loadCandles, yahooSymbol } = await import('./trading_lab.js');
  const seen = [];
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const coinbaseRows = Array.from({ length: 5 }, (_, i) => [(Math.floor(now / day) - 10 + i) * day, 90, 110, 95, 100 + i, 3]);
  const yahooJson = { chart: { result: [{ timestamp: [1700000000, 1700086400], indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1], close: [1.5, 2.5], volume: [10, 10] }] } }] } };
  const fetcher = async (url) => {
    seen.push(String(url));
    if (/binance/.test(url)) return new Response('restricted', { status: 451 });
    if (/coinbase/.test(url)) return new Response(JSON.stringify(seen.filter((u) => /coinbase/.test(u)).length === 1 ? coinbaseRows : []));
    if (/yahoo/.test(url)) return new Response(JSON.stringify(yahooJson));
    return new Response('nope', { status: 404 });
  };
  const btc = await loadCandles('dogecoin', { fetcher });
  assert.equal(btc.data, 'Coinbase Exchange public candles (live)');
  assert.ok(seen[0].includes('/products/DOGE-USD/candles?granularity=86400'));
  assert.equal(btc.candles.length, 5);
  assert.equal(btc.candles[0].c, 100);
  assert.ok(!seen.some((u) => /binance/.test(u)), 'Binance is not asked when Coinbase answers');
  const aapl = await loadCandles('msft', { fetcher });
  assert.equal(aapl.data, 'Yahoo Finance daily history (delayed)');
  assert.equal(aapl.candles.length, 2);
  assert.equal(yahooSymbol('^spx'), '^GSPC');
  assert.equal(yahooSymbol('nq.f'), 'NQ=F');
  assert.equal(yahooSymbol('brk.b.us'), 'BRK-B');
  // Codex on #814: a negative futures price is real (oil, April 2020); only a null gap is dropped.
  const { parseYahooDaily } = await import('./trading_lab.js');
  const oil = parseYahooDaily({ chart: { result: [{ timestamp: [1587340800, 1587427200, 1587513600], indicators: { quote: [{ open: [18, null, 11], high: [18.5, null, 14], low: [-40.32, null, 6.5], close: [-37.63, null, 13.78], volume: [1, null, 1] }] } }] } });
  assert.equal(oil.length, 2);
  assert.equal(oil[0].c, -37.63);
  assert.equal(oil[0].l, -40.32);
  // Every source down: the reply says which ones and why.
  const down = await loadCandles('QQQZUSDT', { fetcher: async () => new Response('x', { status: 503 }) });
  assert.match(down.error, /^The free data source did not answer \(Coinbase HTTP 503; Binance HTTP 503\)/);
});

// Certification run 41242161747: Coinbase answered HTTP 429 to the paged history. One retry, then keep what was read.
test('a Coinbase rate limit is retried once, and a later failing page keeps the pages already read', async () => {
  const { loadCandles } = await import('./trading_lab.js');
  const day = 86400;
  const base = Math.floor(Date.now() / 1000 / day) - 400;
  const page = (n) => Array.from({ length: 3 }, (_, i) => [(base + n * 10 + i) * day, 1, 2, 0.5, 1.5, 1]);
  let calls = 0;
  const flaky = async (url) => {
    if (!/coinbase/.test(url)) return new Response('x', { status: 503 });
    calls += 1;
    if (calls === 1) return new Response('slow down', { status: 429 });
    if (calls === 2) return new Response(JSON.stringify(page(3)));
    return new Response('slow down', { status: 429 });
  };
  const d = await loadCandles('LTCUSDT', { fetcher: flaky });
  assert.equal(d.data, 'Coinbase Exchange public candles (live)');
  assert.equal(d.candles.length, 3, 'the first page is kept when a later page stays rate-limited');
  assert.ok(calls >= 3);
});

// Certification run 41233462389 (ti-21): "What is the purpose of a trading journal?" read out CHE's own paper book.
test('a question about what a trading journal is, is not a request for CHE\'s own book', () => {
  for (const ask of ['What is the purpose of a trading journal?', 'What does a trading report usually contain?']) assert.equal(tradingIntent(ask), null, ask);
  for (const ask of ['Can you show me a trading report?', 'Give me a trading summary', 'Show my trading journal', 'What is in your trading journal?', 'How is paper trading going?', 'trading report']) assert.deepEqual(tradingIntent(ask), { kind: 'book' }, ask);
});
