import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPACA_DATA, ALPACA_PAPER, alpacaPaperDashboard, alpacaPaperOrders, orderStatusGroup, realizedFromFills, speakAlpacaDashboard, alpacaStatus, placeAlpacaPaperOrder, removeAlpacaPaperKeys, saveAlpacaPaperKeys } from './broker_alpaca.js';
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
  assert.deepEqual(view.cards.map((c) => [c.id, c.state, c.mode]), [['che_paper', 'on', 'PAPER'], ['tradovate', 'not_configured', 'PAPER'], ['alpaca', 'not_configured', 'PAPER'], ['fundyouredge', 'unsupported', null], ['coinbase', 'public', null]]);
  assert.equal(view.cards[0].data.label, 'DELAYED');
  assert.equal(view.cards[0].data.lag_minutes, 11);
  assert.equal(view.cards[1].blocked_by.length, 4);
  assert.equal(view.permissions.live_orders, 'off');
  assert.match(speakConnections(view), /^Your trading connections, sir: 1, CHE Paper: on, delayed Yahoo Finance chart \(public\) MNQ=F data\. 2, Tradovate \(NinjaTrader\): not set up\. 3, Alpaca \(stock paper\): not set up\. 4, FundYourEdge \(Rithmic\): orders not supported\. 5, Coinbase \(public market data\): public data, no account\. Trading mode: PAPER\. Live orders are off\.$/);
  // The live kill switch: live orders read off even with live mode, a signed-in broker, limits and a chosen account.
  const live = tradingConnections({ desk: { mode: 'live', account: { sim: '', live: 'L1' }, risk_limits: { maxContracts: 1, maxRiskDollars: 100 } }, tradovate: { configured: true, conn: { connected: true } }, alpaca: null });
  assert.equal(live.permissions.live_orders, 'off');
  assert.match(speakConnections(live), /Live orders are off\.$/);
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

// ─── The Alpaca PAPER dashboard (owner, 2026-10-20) ────────────────────────────────────────────
const DASH = {
  '/v2/account': { account_number: 'PA9876543', status: 'ACTIVE', buying_power: '198000', cash: '99000', equity: '100250.5', last_equity: '100000', portfolio_value: '100250.5' },
  '/v2/positions': [{ symbol: 'AAPL', side: 'long', qty: '5', avg_entry_price: '200', current_price: '202', market_value: '1010', cost_basis: '1000', unrealized_pl: '10', unrealized_plpc: '0.01' }],
  '/v2/orders': [
    { id: 'o-filled', client_order_id: 'c1', symbol: 'AAPL', qty: '5', filled_qty: '5', filled_avg_price: '200', side: 'buy', type: 'market', status: 'filled', submitted_at: '2026-10-19T14:00:00Z', filled_at: '2026-10-19T14:00:02Z' },
    { id: 'o-partial', client_order_id: 'c2', symbol: 'AAPL', qty: '10', filled_qty: '4', filled_avg_price: '201', side: 'buy', type: 'limit', limit_price: '201', status: 'partially_filled', submitted_at: '2026-10-19T15:00:00Z' },
    { id: 'o-new', client_order_id: 'c3', symbol: 'MSFT', qty: '2', filled_qty: '0', side: 'buy', type: 'limit', limit_price: '300', status: 'new', submitted_at: '2026-10-19T16:00:00Z' },
    { id: 'o-acc', client_order_id: 'c4', symbol: 'MSFT', qty: '2', filled_qty: '0', side: 'buy', type: 'limit', limit_price: '299', status: 'accepted', submitted_at: '2026-10-19T16:01:00Z' },
    { id: 'o-can', client_order_id: 'c5', symbol: 'TSLA', qty: '1', filled_qty: '0', side: 'sell', type: 'limit', limit_price: '400', status: 'canceled', submitted_at: '2026-10-18T14:00:00Z', canceled_at: '2026-10-18T15:00:00Z' },
    { id: 'o-rej', client_order_id: 'c6', symbol: 'TSLA', qty: '1', filled_qty: '0', side: 'buy', type: 'market', status: 'rejected', submitted_at: '2026-10-18T14:30:00Z' },
    { id: 'o-exp', client_order_id: 'c7', symbol: 'NVDA', qty: '1', filled_qty: '0', side: 'buy', type: 'limit', limit_price: '100', status: 'expired', submitted_at: '2026-10-17T14:00:00Z', expired_at: '2026-10-17T20:00:00Z' },
  ],
  '/v2/account/activities/FILL': [
    { id: 'f1', activity_type: 'FILL', order_id: 'o-filled', symbol: 'AAPL', side: 'buy', qty: '5', price: '200', transaction_time: '2026-10-19T14:00:02Z', type: 'fill', cum_qty: '5', leaves_qty: '0', order_status: 'filled' },
    { id: 'f2', activity_type: 'FILL', order_id: 'o-partial', symbol: 'AAPL', side: 'buy', qty: '4', price: '201', transaction_time: '2026-10-19T15:00:05Z', type: 'partial_fill', cum_qty: '4', leaves_qty: '6', order_status: 'partially_filled' },
  ],
  '/v2/account/portfolio/history': { timestamp: [1760832000, 1760918400], equity: [100000, 100250.5], profit_loss: [0, 250.5], base_value: 100000 },
};
const dashAlpaca = (over = {}) => alpaca((url) => {
  const u = new URL(url);
  if (u.origin === ALPACA_DATA) return { status: 200, body: { bars: [{ t: '2026-10-19T14:00:00Z', o: 199, h: 201, l: 198.5, c: 200.5, v: 1000 }, { t: '2026-10-19T14:05:00Z', o: 200.5, h: 202, l: 200, c: 201.5, v: 900 }] } };
  const key = Object.keys(DASH).find((k) => u.pathname === k);
  return key in over ? over[key] : { status: 200, body: DASH[key] };
});

test('Alpaca dashboard: account, positions, every order status, verified fills only, history and bars, read from the paper and data hosts', async () => {
  const a = dashAlpaca();
  const d = await alpacaPaperDashboard(PAPER, { fetcher: a.fetcher, now: Date.parse('2026-10-20T10:00:00Z') });
  assert.equal(d.state, 'verified');
  assert.equal(d.mode, 'paper');
  assert.equal(d.money_at_risk, false);
  assert.ok(a.calls.every((c) => c.method === 'GET'), 'the dashboard only reads');
  assert.ok(a.calls.every((c) => c.url.startsWith(ALPACA_PAPER) || c.url.startsWith(ALPACA_DATA)));
  assert.ok(a.calls.some((c) => c.url.startsWith(`${ALPACA_DATA}/v2/stocks/AAPL/bars`)), 'the newest filled symbol is charted');
  assert.equal(d.account.equity, 100250.5);
  assert.equal(d.account.day_change, 250.5);
  assert.deepEqual(d.order_counts, { submitted: 1, accepted: 1, partially_filled: 1, filled: 1, canceled: 1, rejected: 1, expired: 1, other: 0 });
  assert.equal(d.open_orders, 3);
  assert.equal(d.fills.length, 2, 'only FILL activities are executions');
  assert.ok(!d.fills.some((f) => ['o-new', 'o-acc', 'o-can', 'o-rej', 'o-exp'].includes(f.order_id)), 'no execution is drawn for an order Alpaca has not filled');
  assert.equal(d.positions[0].unrealized_pl, 10);
  assert.equal(d.unrealized_pl, 10);
  assert.equal(d.history.length, 2);
  assert.equal(d.chart.bars.length, 2);
  assert.match(d.realized.basis, /computed first-in first-out from the 2 fills/);
  assert.deepEqual(d.separate_from, ['MNQ/NQ futures paper simulations (CHE\'s own engine)', 'Tradovate data']);
  const said = speakAlpacaDashboard(d);
  assert.match(said, /Alpaca PAPER account, read just now: equity \$100,250\.50/);
  assert.match(said, /Orders: 1 filled, 1 partially filled, 2 waiting, 1 canceled, 1 rejected, 1 expired\./);
  assert.match(said, /separate from CHE's MNQ futures paper simulations/);
});

test('Alpaca dashboard: an empty paper account is shown honestly, and an unreadable part gives no numbers', async () => {
  const empty = dashAlpaca({ '/v2/positions': { status: 200, body: [] }, '/v2/orders': { status: 200, body: [] }, '/v2/account/activities/FILL': { status: 200, body: [] } });
  const d = await alpacaPaperDashboard(PAPER, { fetcher: empty.fetcher });
  assert.equal(d.state, 'verified');
  assert.equal(d.fills.length, 0); assert.equal(d.orders.length, 0);
  assert.equal(d.chart.symbol, null);
  assert.match(speakAlpacaDashboard(d), /No open positions\. No orders on this account yet\. No fills confirmed by Alpaca yet\./);
  assert.equal((await alpacaPaperDashboard({})).state, 'not_configured');
  const down = dashAlpaca({ '/v2/account': { status: 503, body: { message: 'maintenance' } } });
  const bad = await alpacaPaperDashboard(PAPER, { fetcher: down.fetcher });
  assert.notEqual(bad.state, 'verified');
  assert.match(speakAlpacaDashboard(bad), /could not read the Alpaca paper account.*no numbers/);
  const live = alpaca();
  assert.equal((await alpacaPaperDashboard({ ...PAPER, CHE_ALPACA_PAPER_KEY_ID: 'AKLIVEKEY1234567890' }, { fetcher: live.fetcher })).state, 'refused');
  assert.equal(live.calls.length, 0, 'a live key never reaches the network');
});

test('Alpaca status groups and realized P&L from fills', () => {
  assert.equal(orderStatusGroup('pending_new'), 'submitted');
  assert.equal(orderStatusGroup('done_for_day'), 'canceled');
  assert.equal(orderStatusGroup('weird'), 'other');
  const r = realizedFromFills([
    { symbol: 'AAPL', side: 'buy', qty: 10, price: 100, time: '1' },
    { symbol: 'AAPL', side: 'sell', qty: 4, price: 110, time: '2' },
    { symbol: 'AAPL', side: 'sell', qty: 6, price: 95, time: '3' },
  ]);
  assert.equal(r.realized_pl, 10); // +40 - 30
  assert.equal(r.winning_closes, 1); assert.equal(r.losing_closes, 1);
});
