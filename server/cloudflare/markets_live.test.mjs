import assert from 'node:assert/strict';
import test from 'node:test';
import { chartPage, parseStooqQuote, quote, stooqQuoteSymbol } from './markets.js';

test('live chart page: validated symbol and interval inside the TradingView widget config, strict CSP', async () => {
  const res = chartPage('https://che.example/markets/chart?symbol=CME_MINI:ES1!&interval=5');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /embed-widget-advanced-chart\.js/);
  assert.match(html, /"symbol":"CME_MINI:ES1!"/);
  assert.match(html, /"interval":"5"/);
  assert.match(html, /"allow_symbol_change":true/);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src https:\/\/s3\.tradingview\.com/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('live chart page rejects injection and unknown intervals', async () => {
  for (const bad of ['symbol=ES"</script><script>alert(1)</script>', 'symbol=AAPL&interval=7', 'symbol=a%20b', `symbol=${'A'.repeat(50)}`]) {
    assert.equal(chartPage(`https://che.example/markets/chart?${bad}`).status, 400, bad);
  }
  assert.equal(chartPage('https://che.example/markets/chart?symbol=nasdaq:aapl&interval=d').status, 200, 'case-insensitive');
});

test('spoken quote: futures, crypto and stock symbols map to the delayed source; unknown is refused', () => {
  assert.equal(stooqQuoteSymbol('es'), 'es.f');
  assert.equal(stooqQuoteSymbol('NQ'), 'nq.f');
  assert.equal(stooqQuoteSymbol('BTC'), 'btcusd');
  assert.equal(stooqQuoteSymbol('TSLA'), 'tsla.us');
  assert.equal(stooqQuoteSymbol('BRK.B'), 'brk-b.us');
  assert.equal(stooqQuoteSymbol('../etc'), '');
});

test('spoken quote parses the source and never invents a price', async () => {
  assert.deepEqual(parseStooqQuote('Symbol,Date,Time,Open,High,Low,Close\nES.F,2026-10-03,22:59:00,6700,6725.5,6690,6712.25'),
    { symbol: 'ES.F', date: '2026-10-03', time: '22:59:00', open: 6700, high: 6725.5, low: 6690, close: 6712.25 });
  assert.equal(parseStooqQuote('Symbol,Date,Time,Open,High,Low,Close\nXX.US,N/D,N/D,N/D,N/D,N/D,N/D'), null);
  const ok = await quote('ES', async () => new Response('Symbol,Date,Time,Open,High,Low,Close\nES.F,2026-10-03,22:59:00,6700,6725.5,6690,6712.25'));
  assert.equal(ok.price, 6712.25);
  assert.match(ok.source, /delayed/);
  const missing = await quote('ZZZZ', async () => new Response('Symbol,Date,Time,Open,High,Low,Close\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D'));
  assert.equal(missing.price, undefined);
  assert.match(missing.error, /No price/);
  const down = await quote('NVDA', async () => { throw new Error('offline'); });
  assert.match(down.error, /unavailable/);
});
