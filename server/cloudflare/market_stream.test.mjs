// Adapter boundaries use deliberately controlled sockets, never invented runtime evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TradovateMarketStream } from './market_feed.js';
import { AlpacaStockStream } from './broker_alpaca.js';
class Socket extends EventTarget {
  sent = []; closed = false;
  send(text) { this.sent.push(text); }
  close() { this.closed = true; }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('Tradovate cannot report live without auth, matching subscriptions, contract and fresh timestamps', async () => {
  let now = Date.parse('2026-10-20T15:05:10Z'); const socket = new Socket();
  const feed = new TradovateMarketStream({ socketFactory: async () => socket, now: () => now });
  await feed.start({ token: 'private-token', root: 'MNQ', symbol: 'MNQZ6', contract_id: 123, expires_at: now + 60000 });
  socket.message('o'); await tick();
  assert.match(socket.sent[0], /^authorize\n1\n\nprivate-token$/);
  socket.message('a[{"i":1,"s":200}]'); await tick();
  assert.equal(feed.snapshot().status, 'UNVERIFIED');
  socket.message('a[{"i":2,"s":200},{"i":3,"s":200,"d":{"historicalId":4,"realtimeId":5}}]');
  socket.message('a[{"e":"chart","d":{"charts":[{"id":4,"bars":[{"timestamp":"2026-10-20T15:00:00Z","open":20000,"high":20010,"low":19998,"close":20005,"upVolume":2,"downVolume":3}]}]}}]');
  socket.message('a[{"e":"md","d":{"quotes":[{"contractId":999,"timestamp":"2026-10-20T15:05:10Z","entries":{"Trade":{"price":20005}}}]}}]'); await tick();
  assert.notEqual(feed.snapshot().status, 'LIVE', 'a different contract is not evidence');
  socket.message('a[{"e":"md","d":{"quotes":[{"contractId":123,"timestamp":"2026-10-20T15:05:10Z","entries":{"Trade":{"price":20005}}}]}}]'); await tick();
  assert.equal(feed.snapshot().status, 'LIVE');
  assert.equal(feed.snapshot().candles.length, 1);
  assert.ok(!JSON.stringify(feed.snapshot()).includes('private-token'));
  now += 60000;
  assert.equal(feed.snapshot().status, 'STALE');
  feed.stop();
});

test('Alpaca authenticates only on the official feed, labels IEX coverage, and waits for subscription acceptance', async () => {
  let now = Date.parse('2026-10-20T15:05:10Z'); const socket = new Socket(); let url;
  const feed = new AlpacaStockStream({ socketFactory: async (u) => { url = u; return socket; }, now: () => now });
  await feed.start({ keys: { id: 'PK-fixture', secret: 'private-secret' }, symbols: ['AAPL'], feed: 'iex' });
  assert.equal(url, 'wss://stream.data.alpaca.markets/v2/iex');
  socket.message('[{"T":"success","msg":"connected"}]'); await tick();
  assert.deepEqual(JSON.parse(socket.sent[0]), { action: 'auth', key: 'PK-fixture', secret: 'private-secret' });
  socket.message('[{"T":"success","msg":"authenticated"}]'); await tick();
  socket.message('[{"T":"q","S":"AAPL","bp":100,"ap":101,"t":"2026-10-20T15:05:10Z"}]'); await tick();
  assert.notEqual(feed.snapshot().status, 'LIVE');
  socket.message('[{"T":"subscription","quotes":["AAPL"],"bars":["AAPL"],"trades":["AAPL"]}]'); await tick();
  assert.equal(feed.snapshot().status, 'LIVE');
  assert.match(feed.snapshot().coverage, /single.exchange|IEX/i);
  assert.ok(!JSON.stringify(feed.snapshot()).includes('private-secret'));
  socket.message('[{"T":"error","code":403,"msg":"no permission"}]'); await tick();
  assert.notEqual(feed.snapshot().status, 'LIVE');
  assert.equal(feed.snapshot().feed, 'iex', 'no silent SIP upgrade or feed substitution');
  feed.stop();
});

test('missing Tradovate owner setup is an actionable blocker and makes no market request', async () => {
  const { marketDataAccess } = await import('./broker_tradovate.js'); let calls = 0;
  const result = await marketDataAccess({ get: async () => null }, {}, 'MNQ', 'MNQZ6', { fetcher: async () => { calls++; throw Error('must not call'); } });
  assert.equal(result.ok, false); assert.equal(result.state, 'app_setup_required');
  assert.match(result.detail, /OAuth|CME/); assert.equal(calls, 0);
});

test('broker fill events require authenticated subscription and valid filled quantities', async () => {
  const { AlpacaOrderStream } = await import('./broker_alpaca.js');
  const socket = new Socket(); const updates = [];
  const stream = new AlpacaOrderStream({ socketFactory: async () => socket, onOrder: (r) => updates.push(r) });
  await stream.start({ keys: { id: 'PK-fixture', secret: 'secret-fixture' } });
  const order = { id: 'broker-id', symbol: 'AAPL', side: 'buy', qty: '3', filled_qty: '1', status: 'partially_filled', filled_avg_price: '100', client_order_id: 'owner-request-id', updated_at: new Date().toISOString() };
  const event = JSON.stringify({ stream: 'trade_updates', data: { event: 'partial_fill', order } });
  socket.message(event); await tick(); assert.equal(updates.length, 0);
  socket.message('{"stream":"authorization","data":{"status":"authorized"}}');
  socket.message('{"stream":"listening","data":{"streams":["trade_updates"]}}');
  await tick(); socket.message(new TextEncoder().encode(event).buffer); await tick();
  assert.equal(updates[0].filled_qty, 1);
  assert.equal(updates[0].environment, 'alpaca_paper');
  socket.message(JSON.stringify({ stream: 'trade_updates', data: { order: { ...order, filled_qty: '0', updated_at: '2020-01-01T00:00:00Z' } } })); await tick();
  assert.equal(updates.length, 1, 'an older event cannot regress broker state');
  socket.message(JSON.stringify({ stream: 'trade_updates', data: { order: { ...order, status: 'filled', filled_qty: '0' } } })); await tick();
  assert.equal(updates.length, 1, 'a contradictory provider event is not a verified fill');
  stream.stop();
});

test('stock history and positions preserve official sources without placing orders or assuming a strategy', async () => {
  const { alpacaStockBars, alpacaPaperPositions, alpacaPaperEquity } = await import('./broker_alpaca.js');
  const env = { CHE_ALPACA_PAPER_KEY_ID: 'PK-fixture', CHE_ALPACA_PAPER_SECRET: 'secret-fixture' };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, method: options.method || 'GET' });
    if (url.includes('/bars?')) return Response.json({ bars: [{ t: '2026-10-20T14:00:00Z', o: 100, h: 103, l: 99, c: 102, v: 10 }] });
    if (url.endsWith('/positions')) return Response.json([{ symbol: 'AAPL', qty: '2', avg_entry_price: '100', current_price: '102', unrealized_pl: '4' }]);
    return Response.json({ timestamp: [1792497600], equity: [10000], profit_loss: [20] });
  };
  const bars = await alpacaStockBars(env, { symbol: 'AAPL', feed: 'iex', fetcher, now: Date.parse('2026-10-20T15:00:00Z') });
  assert.equal(bars.ok, true); assert.equal(bars.status, 'HISTORICAL'); assert.match(bars.coverage, /IEX/);
  const positions = await alpacaPaperPositions(env, { fetcher }); assert.equal(positions.positions[0].strategy, null);
  assert.equal(positions.positions[0].unrealized_pl, 4);
  assert.equal((await alpacaPaperEquity(env, { fetcher })).points[0].equity, 10000);
  assert.ok(requests.every((r) => r.method === 'GET'));
  assert.ok(requests.every((r) => r.url.startsWith('https://data.alpaca.markets/') || r.url.startsWith('https://paper-api.alpaca.markets/')));
});

test('two stock views share one socket per feed subscribed to both symbols, and removed keys close it (review on #383)', async () => {
  const { readFileSync, unlinkSync, writeFileSync } = await import('node:fs');
  const generated = new URL('./.market_stream.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ), 'utf8');
  let CheState;
  try { ({ CheState } = await import(generated.href + '?t=' + Date.now())); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { ALPACA_KEY_ENV, ALPACA_SECRET_ENV } = await import('./broker_alpaca.js');
  const sockets = [];
  const self = {
    keyEnv: { [ALPACA_KEY_ENV]: 'PK-fixture', [ALPACA_SECRET_ENV]: 'private-secret' },
    marketSocketFactory: async (url) => { const s = new Socket(); s.url = url; sockets.push(s); return s; },
    ctx: { storage: { get: async () => null, put: async () => {} } },
    marketEvent() {},
  };
  for (const name of ['stockViewSymbols', 'stopStockStreams', 'ensureStockStreams', 'stockSnapshotFor']) self[name] = CheState.prototype[name].bind(self);
  self._stockViews = new Map([[{}, { symbol: 'AAPL', feed: 'iex' }]]);
  await self.ensureStockStreams(['AAPL'], 'iex');
  self._stockViews.set({}, { symbol: 'MSFT', feed: 'iex' });
  await self.ensureStockStreams(['MSFT'], 'iex');
  const stream = self._stockStreams.get('iex');
  assert.deepEqual(stream.symbols, ['AAPL', 'MSFT'], 'the second view adds its symbol instead of replacing the first');
  assert.equal(self._stockStreams.size, 1);
  assert.equal(self.stockSnapshotFor('MSFT', 'iex', null).symbols[0], 'MSFT');
  self.keyEnv = {};
  const answer = await self.ensureStockStreams(['AAPL'], 'iex');
  assert.equal(answer.status, 'UNAVAILABLE');
  assert.equal(self._stockStreams.size, 0, 'removed keys close every stock socket');
  assert.equal(stream.stopped, true);
  assert.equal(self._stockOrderStream, null);
});
