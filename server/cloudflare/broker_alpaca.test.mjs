import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPACA_PAPER, alpacaPaperOrders, alpacaStatus, placeAlpacaPaperOrder, removeAlpacaPaperKeys, saveAlpacaPaperKeys } from './broker_alpaca.js';
import { storedKeys } from './resilience.js';
import { TRADOVATE_PREREQUISITES, alpacaOptions, speakConnections, speakTradovateSteps, tradingConnections } from './trading_connections.js';

const memory = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k, v) => m.set(k, structuredClone(v)), map: m };
};
const PAPER = { CHE_ALPACA_PAPER_KEY_ID: 'PKTESTKEY1234567890', CHE_ALPACA_PAPER_SECRET: 'x'.repeat(40) };
const alpaca = (reply = () => ({ status: 200, body: {} })) => {
  const calls = [];
  return {
    calls,
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : null });
      const { status, body } = reply(String(url), init);
      return new Response(JSON.stringify(body), { status });
    },
  };
};

test('Alpaca: every request goes to the paper host, and a live-shaped key never reaches the network', async () => {
  assert.equal((await alpacaStatus({})).state, 'not_configured');
  const none = alpaca();
  const s = memory();
  assert.match((await saveAlpacaPaperKeys(s, { key_id: 'AKLIVEKEY1234567890', secret: 'y'.repeat(40) }, { fetcher: none.fetcher })).detail, /LIVE key.*nothing was saved/);
  assert.match((await placeAlpacaPaperOrder({ ...PAPER, CHE_ALPACA_PAPER_KEY_ID: 'AKLIVEKEY1234567890' }, s, { symbol: 'AAPL', qty: 1, side: 'buy', client_order_id: 'order-0001' }, { fetcher: none.fetcher })).detail, /LIVE key.*no order was sent/);
  assert.equal((await alpacaStatus({ ...PAPER, CHE_ALPACA_PAPER_KEY_ID: 'AKLIVEKEY1234567890' }, { fetcher: none.fetcher })).state, 'refused');
  assert.equal(none.calls.length, 0);

  const ok = alpaca(() => ({ status: 200, body: { account_number: 'PA9876543', status: 'ACTIVE', buying_power: '200000', cash: '100000', equity: '100000', options_approved_level: 1 } }));
  const saved = await saveAlpacaPaperKeys(s, { key_id: PAPER.CHE_ALPACA_PAPER_KEY_ID, secret: PAPER.CHE_ALPACA_PAPER_SECRET }, { fetcher: ok.fetcher });
  assert.equal(saved.ok, true);
  assert.equal(saved.key_last4, '7890');
  assert.equal(saved.account.account_last4, '6543');
  assert.equal(saved.account.options_approved_level, 1, 'the options level is what Alpaca says, never assumed');
  assert.equal((await storedKeys(s)).CHE_ALPACA_PAPER_KEY_ID, PAPER.CHE_ALPACA_PAPER_KEY_ID);
  const status = await alpacaStatus(PAPER, { fetcher: ok.fetcher });
  assert.equal(status.state, 'verified');
  assert.ok(ok.calls.every((c) => c.url.startsWith(`${ALPACA_PAPER}/`)), ok.calls.map((c) => c.url).join());
  assert.equal(ok.calls[0].headers['APCA-API-KEY-ID'], PAPER.CHE_ALPACA_PAPER_KEY_ID);

  const rejected = alpaca(() => ({ status: 401, body: { message: 'unauthorized.' } }));
  const s2 = memory();
  assert.match((await saveAlpacaPaperKeys(s2, { key_id: 'PKWRONGKEY1234567890', secret: 'z'.repeat(40) }, { fetcher: rejected.fetcher })).detail, /rejected that key pair, so nothing was saved/);
  assert.equal((await storedKeys(s2)).CHE_ALPACA_PAPER_KEY_ID, undefined);
  assert.equal((await alpacaStatus(PAPER, { fetcher: rejected.fetcher })).state, 'rejected');
  assert.equal((await alpacaStatus(PAPER, { fetcher: async () => { throw new TypeError('fetch failed'); } })).state, 'unavailable');

  assert.deepEqual(await removeAlpacaPaperKeys(s), { ok: true, removed: true });
  assert.equal((await storedKeys(s)).CHE_ALPACA_PAPER_KEY_ID, undefined);
});

test('Alpaca paper orders: validated, sent once per request id, receipts as Alpaca reports them', async () => {
  const s = memory();
  const broker = alpaca((url, init) => (init.method === 'POST'
    ? { status: 200, body: { id: 'ord-1', client_order_id: JSON.parse(init.body).client_order_id, symbol: 'AAPL', qty: '2', filled_qty: '0', side: 'buy', type: 'market', status: 'accepted', submitted_at: '2026-10-19T13:31:00Z' } }
    : { status: 200, body: [{ id: 'ord-1', client_order_id: 'order-0001', symbol: 'AAPL', qty: '2', filled_qty: '2', filled_avg_price: '231.5', side: 'buy', type: 'market', status: 'filled' }] }));
  for (const [order, why] of [
    [{ symbol: 'AAPL261218C00250000', qty: 1, side: 'buy', client_order_id: 'order-0009' }, /stock symbols only/],
    [{ symbol: 'AAPL', qty: 0, side: 'buy', client_order_id: 'order-0009' }, /1 to 1,000 shares/],
    [{ symbol: 'AAPL', qty: 1, side: 'short', client_order_id: 'order-0009' }, /buy or sell/],
    [{ symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', client_order_id: 'order-0009' }, /limit price/],
    [{ symbol: 'AAPL', qty: 1, side: 'buy' }, /no request id/],
  ]) assert.match((await placeAlpacaPaperOrder(PAPER, s, order, { fetcher: broker.fetcher })).detail, why);
  assert.equal(broker.calls.length, 0, 'an invalid order never reaches Alpaca');

  const first = await placeAlpacaPaperOrder(PAPER, s, { symbol: 'aapl', qty: 2, side: 'buy', client_order_id: 'order-0001' }, { fetcher: broker.fetcher });
  assert.equal(first.ok, true);
  assert.equal(first.receipt.status, 'accepted', 'accepted, not filled: CHE says what the receipt says');
  assert.equal(first.receipt.money_at_risk, false);
  assert.deepEqual(broker.calls[0].body, { symbol: 'AAPL', qty: '2', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: 'order-0001' });
  const again = await placeAlpacaPaperOrder(PAPER, s, { symbol: 'AAPL', qty: 2, side: 'buy', client_order_id: 'order-0001' }, { fetcher: broker.fetcher });
  assert.equal(again.repeated, true);
  assert.equal(broker.calls.length, 1, 'a repeated tap is the same order, sent once');
  const listed = await alpacaPaperOrders(PAPER, { fetcher: broker.fetcher });
  assert.equal(listed.orders[0].status, 'filled');
  assert.equal(listed.orders[0].filled_avg_price, 231.5);
  assert.ok(broker.calls.every((c) => c.url.startsWith(`${ALPACA_PAPER}/`)));

  const refusing = alpaca(() => ({ status: 403, body: { message: 'insufficient buying power' } }));
  assert.match((await placeAlpacaPaperOrder(PAPER, memory(), { symbol: 'AAPL', qty: 1, side: 'buy', client_order_id: 'order-0002' }, { fetcher: refusing.fetcher })).detail, /did not accept the order: insufficient buying power\. Nothing was placed/);
});

test('trading connections: each card says its real state; nothing reads connected until proven', () => {
  const desk = { mode: 'paper', account: { sim: '', live: '' }, risk_limits: null };
  const view = tradingConnections({
    paper: { state: { enabled: true }, feed: { status: 'DELAYED', provider: 'Yahoo Finance chart (public)', provider_symbol: 'MNQ=F', last_bar_time: '2026-10-18T22:12:00Z', latency_s: 660 }, contract: 'MNQZ6', portfolios: 24 },
    desk,
    tradovate: { configured: false, conn: { connected: false } },
    alpaca: { state: 'not_configured' },
  });
  assert.deepEqual(view.cards.map((c) => [c.id, c.state, c.mode]), [['che_paper', 'on', 'PAPER'], ['tradovate', 'not_configured', 'PAPER'], ['alpaca', 'not_configured', 'PAPER'], ['fundyouredge', 'unsupported', null]]);
  assert.equal(view.cards[0].data.label, 'DELAYED');
  assert.equal(view.cards[0].data.lag_minutes, 11);
  assert.equal(view.cards[1].blocked_by.length, 4);
  assert.equal(view.permissions.live_orders, 'off');
  assert.match(speakConnections(view), /^Your trading connections, sir: 1, CHE Paper: on, delayed Yahoo Finance chart \(public\) MNQ=F data\. 2, Tradovate \(NinjaTrader\): not set up\. 3, Alpaca \(stock paper\): not set up\. 4, FundYourEdge \(Rithmic\): not supported\. Trading mode: PAPER\. Live orders are off\.$/);
  // Live orders open only with live mode, a signed-in broker, limits and a chosen account.
  const live = tradingConnections({ desk: { mode: 'live', account: { sim: '', live: 'L1' }, risk_limits: { maxContracts: 1, maxRiskDollars: 100 } }, tradovate: { configured: true, conn: { connected: true } }, alpaca: null });
  assert.equal(live.permissions.live_orders, 'each order needs your approval of that exact order');
  assert.equal(tradingConnections({ desk: { mode: 'live', account: { sim: '', live: 'L1' }, risk_limits: null }, tradovate: { configured: true, conn: { connected: true } } }).permissions.live_orders, 'off');
});

test('Alpaca: a redirect is never followed, and an unclear order result is looked up, not guessed (review of #348)', async () => {
  const moved = alpaca(() => ({ status: 302, body: {} }));
  const status = await alpacaStatus(PAPER, { fetcher: moved.fetcher });
  assert.equal(status.state, 'refused');
  assert.match(status.error, /redirected the request elsewhere/);
  assert.equal(moved.calls.length, 1);
  assert.equal(moved.calls[0].redirect, 'manual');

  // A 500 on submit, then Alpaca has the order under its request id: CHE reports Alpaca's record.
  const found = alpaca((url, init) => (init.method === 'POST' ? { status: 500, body: { message: 'internal error' } }
    : { status: 200, body: { id: 'ord-9', client_order_id: 'order-0500', symbol: 'AAPL', qty: '1', side: 'buy', type: 'market', status: 'accepted' } }));
  const s = memory();
  const placed = await placeAlpacaPaperOrder(PAPER, s, { symbol: 'AAPL', qty: 1, side: 'buy', client_order_id: 'order-0500' }, { fetcher: found.fetcher });
  assert.equal(placed.ok, true);
  assert.equal(placed.confirmed_after_error, true);
  assert.equal(placed.receipt.id, 'ord-9');
  assert.match(found.calls[1].url, /\/v2\/orders:by_client_order_id\?client_order_id=order-0500$/);
  assert.equal(found.calls.filter((c) => c.method === 'POST').length, 1, 'never sent twice');

  const missing = alpaca((url, init) => (init.method === 'POST' ? { status: 503, body: { message: 'unavailable' } } : { status: 404, body: { message: 'order not found' } }));
  assert.match((await placeAlpacaPaperOrder(PAPER, memory(), { symbol: 'AAPL', qty: 1, side: 'buy', client_order_id: 'order-0503' }, { fetcher: missing.fetcher })).detail, /no order with this request id, so nothing was placed/);

  let n = 0;
  const silent = async () => { n += 1; throw new TypeError('fetch failed'); };
  const unknown = await placeAlpacaPaperOrder(PAPER, memory(), { symbol: 'AAPL', qty: 1, side: 'buy', client_order_id: 'order-0504' }, { fetcher: silent });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /cannot confirm whether Alpaca placed that paper order.*will not send it again/);
  assert.equal(n, 2, 'one submit and one lookup, never a resend');
});

test('Alpaca options readiness is read only, exactly as GET /v2/account reports it; Tradovate\'s steps read aloud (issue #344)', async () => {
  const ok = alpaca(() => ({ status: 200, body: { account_number: 'PA9876543', status: 'ACTIVE', buying_power: '200000', options_approved_level: 3, options_trading_level: 2 } }));
  const status = await alpacaStatus(PAPER, { fetcher: ok.fetcher });
  assert.deepEqual([status.account.options_approved_level, status.account.options_trading_level], [3, 2]);
  assert.deepEqual(ok.calls.map((c) => `${c.method} ${c.url}`), [`GET ${ALPACA_PAPER}/v2/account`], 'one read, nothing placed');
  const view = tradingConnections({ desk: { mode: 'paper', account: { sim: '', live: '' }, risk_limits: null }, tradovate: { configured: false }, alpaca: status });
  const card = view.cards.find((c) => c.id === 'alpaca');
  assert.deepEqual([card.options.approved_level, card.options.trading_level, card.options.orders], [3, 2, 'off']);
  assert.equal(card.options.detail, 'Options, read only: Alpaca approved level 3 (level 2 plus call and put spreads); trading level 2 (level 1 plus buying calls and puts). CHE places no option orders yet.');
  assert.match(speakConnections(view), /3, Alpaca \(stock paper\): verified, options level 3, read only\./);
  assert.match(alpacaOptions({}).detail, /did not report an options level/, 'no level is never read as approved');
  assert.equal(alpacaOptions({ options_approved_level: 0 }).approved_level, 0);
  assert.equal(tradingConnections({ desk: view.cards && { mode: 'paper', account: {}, risk_limits: null }, alpaca: { state: 'not_configured' } }).cards[2].options, null);

  const tradovate = view.cards.find((c) => c.id === 'tradovate');
  assert.deepEqual(tradovate.blocked_by, TRADOVATE_PREREQUISITES);
  assert.deepEqual(tradovate.worker_secrets, ['CHE_TRADOVATE_OAUTH_CLIENT_ID', 'CHE_TRADOVATE_OAUTH_CLIENT_SECRET']);
  assert.match(tradovate.blocked_note, /demo and live orders stay blocked/);
  // Voice-readable: no symbols or secret names in the steps a screen reader or CHE speaks.
  for (const step of TRADOVATE_PREREQUISITES) assert.doesNotMatch(step, /[_$|•]|CHE_TRADOVATE/, step);
  const spoken = speakTradovateSteps({ redirect: 'https://che.example/broker/tradovate/callback' });
  assert.match(spoken, /^Tradovate requires these steps before CHE can use its API, sir: 1, A funded Tradovate live account with more than 1,000 dollars in it\. 2, .* 3, .* 4, .*\. Tradovate registers the app with this redirect address: https:\/\/che\.example\/broker\/tradovate\/callback\. Until Tradovate approves API access/);
  assert.doesNotMatch(spoken, /deposit now|buy the add-on now|tap/i);
  const set = tradingConnections({ desk: { mode: 'paper', account: { sim: '', live: '' }, risk_limits: null }, tradovate: { configured: true, conn: { connected: false } } }).cards[1];
  assert.deepEqual([set.blocked_by, set.blocked_note], [[], undefined], 'once set up, nothing reads as blocked');
});
