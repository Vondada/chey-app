import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmLive, confirmStockOrder, deskIntent, deskTick, dropStockOrder, readDesk, requestLive, requestStockOrder, setMode, setRiskLimits, setSize, speakDeskStatus, speakStockOrder, speakStockReceipt, stockOrderIntent, takeAnnouncement, takeTrade, skipTrade, pendingAlert, rememberListed, chooseAccount } from './trading_desk.js';
import { connectLink, handleCallback, placeBracket, connection, renewToken, accountBalance, pickAccount, tradovateApi } from './broker_tradovate.js';
import { LIVE_TRADING_OFF } from './trading_environments.js';

const store = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => m.set(k, structuredClone(v)), delete: async (k) => m.delete(k) };
};
const LIMITS = { maxContracts: 2, maxRiskDollars: 500 };
test('the spoken status says what the live limits are, or that none are set', async () => {
  const s = store();
  assert.match(speakDeskStatus(await readDesk(s), null), /Live limits are not set, so no live order can be sent\./);
  await setRiskLimits(s, LIMITS);
  assert.match(speakDeskStatus(await readDesk(s), null), /Live limits: at most 2 contracts and 500 dollars at risk per order\./);
});

const paperBook = (id = 'p1', symbol = 'es.f') =>({ open: [{ id, symbol, label: 'ES futures', strategy: 'channel-20|any|2', entry: 5820, stop: 5805, target: 5850, why: 'closed above the 20-day high 5815' }] });

test('voice: switch, connect, take, skip, size, alerts, status', () => {
  assert.deepEqual(deskIntent('CHE, switch to live trading'), { kind: 'mode', mode: 'live' });
  assert.deepEqual(deskIntent('switch over to my live account'), { kind: 'mode', mode: 'live' });
  assert.deepEqual(deskIntent('switch to sim trading'), { kind: 'mode', mode: 'sim' });
  assert.deepEqual(deskIntent('go to the simulated account'), { kind: 'mode', mode: 'sim' });
  assert.deepEqual(deskIntent('switch back to paper trading'), { kind: 'mode', mode: 'paper' });
  assert.equal(deskIntent('connect my NinjaTrader account').kind, 'connect');
  assert.equal(deskIntent('Take the trade').kind, 'take_unconfirmed', 'a bare take phrase is answered, never placed');
  assert.equal(deskIntent('Yes, take the trade').kind, 'take');
  assert.equal(deskIntent('yes, place it').kind, 'take');
  assert.equal(deskIntent('skip it').kind, 'skip');
  assert.deepEqual(deskIntent('trade 2 micro contracts'), { kind: 'size', qty: 2, contract: 'micro' });
  assert.equal(deskIntent('any trade alerts?').kind, 'alerts');
  assert.equal(deskIntent("what's my trading mode").kind, 'status');
  assert.equal(deskIntent('how much money is in my NinjaTrader account').kind, 'balance');
  for (const no of ['what is live trading?', 'I like to take the train', 'skip to the next song', 'how are the trades doing', 'backtest bitcoin', 'yes']) {
    assert.equal(deskIntent(no), null, no);
  }
});

test('paper mode: entries become spoken alerts only; nothing is sent', async () => {
  const s = store();
  let placed = 0;
  await deskTick(s, paperBook(), { place: async () => { placed++; return { ok: true }; } });
  assert.equal(placed, 0);
  const said = await takeAnnouncement(s);
  assert.match(said, /paper only/);
  assert.match(said, /buy 1 MES at 5820, stop 5805, target 5850/);
  assert.equal(await takeAnnouncement(s), '', 'said once');
  await deskTick(s, paperBook(), { place: async () => { placed++; return { ok: true }; } });
  assert.equal((await readDesk(s)).alerts.length, 1, 'one alert per paper trade');
});

test('sim mode: CHE places the entry on the simulated account herself and reports the real result', async () => {
  const s = store();
  await setMode(s, 'sim');
  const calls = [];
  await deskTick(s, paperBook(), { place: async (_st, mode, a) => { calls.push([mode, a.root, a.qty]); return { ok: true, order_id: 77, account: 'DEMO123', symbol: 'MESZ6', entry: 5820, stop: 5805, target: 5850, qty: 1 }; } });
  assert.deepEqual(calls, [['sim', 'MES', 1]]);
  assert.match(await takeAnnouncement(s), /placed it on your simulated account DEMO123: buy 1 MESZ6 limit 5820.*order 77/);
  await deskTick(s, paperBook('p2'), { place: async () => ({ error: 'Tradovate answered 401.' }) });
  assert.match(await takeAnnouncement(s), /it failed: Tradovate answered 401/);
});

test('live kill switch: the desk cannot reach live mode, a desk saved as live reads paper, and take places nothing', async () => {
  const s = store();
  const changed = await setMode(s, 'live');
  assert.equal(changed.mode, 'paper');
  assert.match(changed.error, /^Live trading is turned off in CHE's code until you separately approve it and it is verified, sir\. You stay on paper trading.*Nothing changed\.$/);
  assert.equal((await readDesk(s)).mode, 'paper');
  // A desk saved as live by an older build is read as paper: no live alert, no live order.
  await s.put('trading_desk', { mode: 'live', account: { live: 'LIVE1' }, risk_limits: LIMITS, alerts: [] });
  assert.equal((await readDesk(s)).mode, 'paper');
  const placed = [];
  const place = async (_st, mode) => { placed.push(mode); return { ok: true }; };
  const t0 = Date.UTC(2026, 9, 5, 14);
  await deskTick(s, paperBook(), { place, now: t0 });
  assert.equal((await readDesk(s)).alerts[0].status, 'info', 'an entry is information only');
  assert.match((await takeTrade(s, { place, now: t0 + 60_000 })).reply, /no open trade alert/);
  // A pending live alert left by an older build: the take answers paper and sends nothing.
  await s.put('trading_desk', { mode: 'live', account: { live: 'LIVE1' }, risk_limits: LIMITS, alerts: [{ id: 'old', status: 'pending', root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, mode: 'live', expires_at: new Date(t0 + 3600_000).toISOString() }] });
  assert.match((await takeTrade(s, { place, now: t0 + 60_000 })).reply, /^That alert was for your live account, sir, and live trading is off in CHE's code\. Nothing was placed\.$/);
  assert.match(await takeAnnouncement(s, t0), /It was for your live account, and live trading is off in CHE's code\. Nothing was placed\./);
  assert.deepEqual(placed, []);
});

test('taking a trade in paper mode sends nothing; a failed order is reported as not placed; skip and expiry place nothing', async () => {
  const s = store();
  const t0 = Date.UTC(2026, 9, 5, 14);
  const pending = (id) => ({ id, paper_id: id, at: new Date(t0).toISOString(), expires_at: new Date(t0 + 20 * 3600_000).toISOString(), root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, status: 'pending', announced: true, mode: 'sim' });
  const mustNot = async () => { throw new Error('must not place'); };
  await s.put('trading_desk', { mode: 'paper', alerts: [pending('a1')] });
  assert.match((await takeTrade(s, { now: t0, place: mustNot })).reply, /paper trading.*Nothing was placed/);
  await s.put('trading_desk', { mode: 'sim', account: { sim: 'DEMO123' }, alerts: [pending('a2')] });
  const failed = await takeTrade(s, { now: t0, place: async () => ({ error: 'Tradovate rejected the order: Insufficient margin.' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reply, /NOT placed.*Insufficient margin/);
  await s.put('trading_desk', { mode: 'sim', account: { sim: 'DEMO123' }, alerts: [pending('a3')] });
  assert.match(await skipTrade(s, t0), /Skipped.*Nothing was placed/);
  await s.put('trading_desk', { mode: 'sim', account: { sim: 'DEMO123' }, alerts: [pending('a4')] });
  assert.equal(pendingAlert(await readDesk(s), t0 + 21 * 3600_000), null);
  assert.match((await takeTrade(s, { now: t0 + 21 * 3600_000, place: mustNot })).reply, /no open trade alert/);
});

test('size: micro by default, owner can choose full-size and 1-10 contracts', async () => {
  const s = store();
  assert.ok((await setSize(s, 11)).error);
  await setSize(s, 2, 'full');
  await deskTick(s, paperBook('x', 'nq.f'));
  const a = (await readDesk(s)).alerts[0];
  assert.equal(a.root, 'NQ');
  assert.equal(a.qty, 2);
});

// ─── Tradovate connector ─────────────────────────────────────────────────

const ENV = { CHE_TRADOVATE_OAUTH_CLIENT_ID: '123', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'sec' };

test('NinjaTrader sign-in: one-time state, token stored, password never involved', async () => {
  const s = store();
  assert.equal((await connectLink(s, {}, 'https://che.example')).error, 'not_configured');
  const { url } = await connectLink(s, ENV, 'https://che.example');
  assert.match(url, /^https:\/\/trader\.tradovate\.com\/oauth\?response_type=code&client_id=123&redirect_uri=https%3A%2F%2Fche\.example%2Fbroker%2Ftradovate%2Fcallback&state=[0-9a-f]{48}$/);
  const state = new URL(url).searchParams.get('state');
  let sent;
  const fetcher = async (u, init) => { sent = { u, body: Object.fromEntries(new URLSearchParams(init.body)) }; return new Response(JSON.stringify({ access_token: 'tok', expires_in: 4800 }), { status: 200 }); };
  const bad = await handleCallback(s, ENV, `https://che.example/broker/tradovate/callback?code=c&state=wrong`, fetcher);
  assert.equal(bad.ok, false, 'wrong state refused');
  const { url: again } = await connectLink(s, ENV, 'https://che.example');
  const good = await handleCallback(s, ENV, `https://che.example/broker/tradovate/callback?code=c&state=${new URL(again).searchParams.get('state')}`, fetcher);
  assert.equal(good.ok, true);
  assert.equal(sent.body.grant_type, 'authorization_code');
  assert.equal(sent.body.code, 'c');
  assert.ok(!('password' in sent.body));
  assert.equal((await connection(s)).connected, true);
  const replay = await handleCallback(s, ENV, `https://che.example/broker/tradovate/callback?code=c&state=${new URL(again).searchParams.get('state')}`, fetcher);
  assert.equal(replay.ok, false, 'a state works once');
  assert.notEqual(state, new URL(again).searchParams.get('state'));
});

function tradovate({ failure, success } = {}) {
  const calls = [];
  const fetcher = async (u, init = {}) => {
    calls.push({ u, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith('/account/list')) return ok([{ id: 5, name: 'DEMO123', active: true }]);
    if (u.includes('/contract/suggest')) return ok([{ id: 1, name: 'MESZ6' }, { id: 2, name: 'MESH7' }]);
    if (u.endsWith('/order/placeoso')) return ok(failure ? { failureReason: 'RiskCheck', failureText: failure } : success ? { orderId: 42, failureReason: 'Success' } : { orderId: 42, oso1Id: 43, oso2Id: 44 });
    if (u.endsWith('/cashBalance/getcashbalancesnapshot')) return ok({ totalCashValue: 50000.5, netLiq: 50120.25, openPnL: 119.75 });
    if (u.endsWith('/auth/renewaccesstoken')) return ok({ accessToken: 'tok2', expirationTime: '2026-10-05T16:00:00Z' });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetcher };
}

test('orders: limit entry with stop and target attached, on the right server, rounded to ticks', async () => {
  const s = store();
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() + 3600_000 });
  const { calls, fetcher } = tradovate();
  const r = await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820.1, stop: 5805.13, target: 5850.4 }, { fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.order_id, 42);
  const order = calls.find((c) => c.u.endsWith('/order/placeoso'));
  assert.ok(order.u.startsWith('https://demo.tradovateapi.com/v1'), 'sim goes to the demo server');
  assert.equal(order.auth, 'Bearer tok');
  assert.deepEqual(order.body, {
    accountSpec: 'DEMO123', accountId: 5, action: 'Buy', symbol: 'MESZ6', orderQty: 1, orderType: 'Limit', price: 5820, timeInForce: 'Day', isAutomated: true,
    bracket1: { action: 'Sell', orderType: 'Limit', price: 5850.5, timeInForce: 'GTC' },
    bracket2: { action: 'Sell', orderType: 'Stop', stopPrice: 5805.25, timeInForce: 'GTC' },
  });
  // Live: refused by the kill switch before any request, not even an account read.
  const live = tradovate();
  assert.equal((await placeBracket(s, 'live', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, account: 'DEMO123', approval: { account: 'DEMO123', contract: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, expires_at: Date.now() + 3600_000 }, limits: LIMITS }, { fetcher: live.fetcher })).error, LIVE_TRADING_OFF);
  assert.deepEqual(live.calls, [], 'nothing reached the live server');
});

test('orders: rejections, bad brackets, missing sign-in and size limits are refused honestly', async () => {
  const s = store();
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 })).error, /not connected/);
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() + 3600_000 });
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5830, target: 5850 })).error, /stop must be below/);
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 11, entry: 5820, stop: 5805, target: 5850 })).error, /1 to 10/);
  assert.match((await placeBracket(s, 'paper', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 })).error, /simulated or the live/);
  const { fetcher } = tradovate({ failure: 'Insufficient margin' });
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher })).error, /rejected the order: Insufficient margin/);
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() - 1 });
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher })).error, /sign-in expired/);
});

test('balance and token renewal', async () => {
  const s = store();
  const now = Date.UTC(2026, 9, 5, 14);
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: now + 20 * 60_000 });
  const { fetcher } = tradovate();
  const renewed = await renewToken(s, fetcher, now);
  assert.equal(renewed.access_token, 'tok2');
  const bal = await accountBalance(s, 'sim', '', { fetcher, now });
  assert.deepEqual(bal, { account: 'DEMO123', cash: 50000.5, net_liq: 50120.25, open_pnl: 119.75, realized_pnl: null });
});

test('old paper trades are never called as entries (no stale orders after a restart or deploy)', async () => {
  const s = store();
  await setMode(s, 'sim');
  let placed = 0;
  const now = Date.UTC(2026, 9, 5, 14);
  const old = { open: [{ ...paperBook().open[0], opened_at: new Date(now - 3 * 3600_000).toISOString() }] };
  await deskTick(s, old, { now, place: async () => { placed++; return { ok: true }; } });
  assert.equal(placed, 0);
  assert.equal((await readDesk(s)).alerts.length, 0);
  const fresh = { open: [{ ...paperBook('n').open[0], opened_at: new Date(now - 60_000).toISOString() }] };
  await deskTick(s, fresh, { now, place: async () => { placed++; return { ok: true, order_id: 1, account: 'D', symbol: 'MESZ6', entry: 1, stop: 0, target: 2, qty: 1 }; } });
  assert.equal(placed, 1);
});

test('review fixes: Success response, named live account, forged callbacks, one yes = one order', async () => {
  const s = store();
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() + 3600_000 });
  // Tradovate's documented accepted response carries failureReason "Success".
  const ok = tradovate({ success: true });
  assert.equal((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher: ok.fetcher })).ok, true);
  // Live money never goes to "the first account in the list".
  assert.match((await pickAccount(s, 'live', '', { fetcher: ok.fetcher })).error, /Choose which live account/);
  assert.match((await pickAccount(s, 'live', 'OTHER', { fetcher: ok.fetcher })).error, /not active/);
  assert.equal((await pickAccount(s, 'live', 'demo123', { fetcher: ok.fetcher })).account.name, 'DEMO123');
  // A forged callback does not cancel the owner's real sign-in link.
  const { url } = await connectLink(s, ENV, 'https://che.example');
  const state = new URL(url).searchParams.get('state');
  await handleCallback(s, ENV, 'https://che.example/broker/tradovate/callback?code=x&state=forged', ok.fetcher);
  assert.equal((await s.get('tradovate_oauth_state')).state, state, 'real state survives a forged attempt');
  // Two overlapping "take the trade": the alert is claimed first, one order only.
  await s.put('trading_desk', { mode: 'sim', account: { sim: 'DEMO123' }, alerts: [{ id: 'race', paper_id: 'race', at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, status: 'pending', announced: true, mode: 'sim' }] });
  let orders = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const place = async (_st, _m, a) => { orders++; await gate; return { ok: true, order_id: 1, account: a.account, symbol: 'MESZ6', entry: 1, stop: 0, target: 2, qty: 1 }; };
  const first = takeTrade(s, { place });
  await new Promise((r) => setTimeout(r, 0));
  const second = await takeTrade(s, { place });
  release();
  assert.equal((await first).ok, true);
  assert.match(second.reply, /no open trade alert/);
  assert.equal(orders, 1);
});

// The environment guard, through the one function every broker order passes.
const brokerStore = async () => {
  const s = store();
  await s.put('tradovate_auth', { access_token: 'token', expires_at: Date.now() + 3600_000 });
  return s;
};
const fakeBroker = (calls) => async (url) => {
  const u = String(url);
  calls.push(u);
  const body = u.includes('/account/list') ? [{ id: 7, name: 'DEMO123', active: true }]
    : u.includes('/contract/suggest') ? [{ name: 'MESZ6' }] : { orderId: 42, failureReason: 'Success' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const order = (over = {}) => ({ root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, account: 'DEMO123', ...over });
const approval = (over = {}) => ({ account: 'DEMO123', contract: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850, expires_at: Date.now() + 3600_000, ...over });

test('live kill switch: a live order is refused with no request at all, whatever approval, limits or account it carries', async () => {
  const s = await brokerStore();
  const calls = [];
  const fetcher = fakeBroker(calls);
  for (const o of [order({ limits: LIMITS }), order({ approval: approval(), limits: LIMITS }), order({ approval: approval() }), order({ qty: 3, approval: approval({ qty: 3 }), limits: LIMITS })]) {
    const r = await placeBracket(s, 'live', o, { fetcher, env: { CHE_LIVE_TRADING_APPROVED: 'owner-approved-2026-10-24' } });
    assert.equal(r.error, LIVE_TRADING_OFF);
    assert.equal(r.live_disabled, true);
  }
  // Defense in depth: the request layer itself refuses a live order path, even if a caller skipped placeBracket.
  for (const path of ['/order/placeoso', '/order/placeorder', '/order/liquidateposition', '/orderStrategy/startorderstrategy']) {
    assert.equal((await tradovateApi(s, 'live', path, { method: 'POST', body: {}, fetcher, env: { CHE_LIVE_TRADING_APPROVED: 'owner-approved-2026-10-24' } })).error, LIVE_TRADING_OFF, path);
  }
  assert.deepEqual(calls, [], 'nothing was sent to the broker');
  // Reads on the live server (accounts, contracts) and simulated orders are unchanged.
  assert.equal((await tradovateApi(s, 'live', '/account/list', { fetcher })).data[0].name, 'DEMO123');
  assert.equal((await placeBracket(s, 'sim', order(), { fetcher })).ok, true);
  assert.ok(!calls.some((u) => u.includes('live.tradovateapi.com') && u.includes('/order')));
});

test('a simulated order needs no approval, and goes only to the simulated (demo) service', async () => {
  const s = await brokerStore();
  const calls = [];
  const r = await placeBracket(s, 'sim', order(), { fetcher: fakeBroker(calls) });
  assert.equal(r.ok, true);
  assert.ok(calls.some((u) => u.startsWith('https://demo.tradovateapi.com') && u.includes('/order/placeoso')));
  assert.ok(!calls.some((u) => u.includes('live.tradovateapi.com')), 'a simulated run never touches the live service');
});

test('a live order in a contract CHE has no point value for is refused before anything is sent', async () => {
  const s = await brokerStore();
  const calls = [];
  const r = await placeBracket(s, 'live', { root: 'ZZ', qty: 1, entry: 100, stop: 99, target: 102, account: 'DEMO123', approval: approval(), limits: LIMITS }, { fetcher: fakeBroker(calls) });
  assert.ok(r.error, 'refused');
  assert.ok(!calls.some((u) => u.includes('/order/placeoso')));
});

test('"set my live risk limit to 2 contracts and 300 dollars" sets the limits by voice; bad limits are refused', async () => {
  assert.deepEqual(deskIntent('set my live risk limit to 2 contracts and 300 dollars'), { kind: 'limits', maxContracts: 2, maxRiskDollars: 300 });
  assert.deepEqual(deskIntent('set the limits to 1 contract and 150.50 dollars'), { kind: 'limits', maxContracts: 1, maxRiskDollars: 150.5 });
  assert.equal(deskIntent('trade 2 micro contracts').kind, 'size', 'sizing is not a limit');
  const s = store();
  assert.match((await setRiskLimits(s, { maxContracts: 11, maxRiskDollars: 100 })).error, /1 to 10 contracts/);
  assert.match((await setRiskLimits(s, { maxContracts: 1, maxRiskDollars: 0 })).error, /at least 1 dollar/);
  assert.deepEqual((await setRiskLimits(s, { maxContracts: 2, maxRiskDollars: 300 })).limits, { maxContracts: 2, maxRiskDollars: 300 });
  assert.deepEqual((await readDesk(s)).risk_limits, { maxContracts: 2, maxRiskDollars: 300 });
});

test('live kill switch: the whole spoken chain to a live order ends with no request to any live host', async () => {
  const s = store();
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() + 3600_000 });
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response('[]', { status: 200 }); };
  try {
    const t0 = Date.now();
    assert.deepEqual(deskIntent('switch to live trading'), { kind: 'mode', mode: 'live' });
    const asked = await requestLive(s, t0);
    assert.equal(asked.disabled, true);
    assert.equal(asked.meta.ok, false);
    assert.equal(asked.meta.live_confirmation_needed, undefined);
    assert.match(asked.reply, /^Live trading is turned off in CHE's code until you separately approve it and it is verified, sir\. You stay on paper trading.*Nothing changed\.$/);
    assert.deepEqual(deskIntent('confirm live trading'), { kind: 'confirm_live' });
    assert.match((await confirmLive(s, t0 + 1000)).error, /turned off in CHE's code.*Nothing changed/);
    await setRiskLimits(s, deskIntent('set my live risk limit to 1 contract and 100 dollars'));
    await rememberListed(s, 'live', ['LIVE1']);
    await chooseAccount(s, { number: 1 });
    await deskTick(s, paperBook('chain'), { now: t0 + 2000 });
    assert.deepEqual(deskIntent('yes, take the trade'), { kind: 'take', place: true, live: true });
    const taken = await takeTrade(s, { now: t0 + 3000 });
    assert.notEqual(taken.ok, true);
    assert.match(taken.reply, /Nothing was placed/);
    assert.equal((await readDesk(s)).mode, 'paper', 'paper stays paper');
    // A direct broker call with an exact approval and limits is refused as well.
    assert.equal((await placeBracket(s, 'live', order({ account: 'LIVE1', approval: approval({ account: 'LIVE1' }), limits: LIMITS }))).error, LIVE_TRADING_OFF);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(urls.filter((u) => /live\.tradovateapi\.com/.test(u)), []);
  assert.deepEqual(urls, [], 'no network request at all');
});

test('going live is refused while the kill switch is off: no request is recorded and the mode stays where it was', async () => {
  assert.deepEqual(deskIntent('confirm live trading'), { kind: 'confirm_live' });
  assert.deepEqual(deskIntent('yes, confirm the switch to live trading'), { kind: 'confirm_live' });
  assert.deepEqual(deskIntent('what are my trading connections'), { kind: 'connections' });
  assert.deepEqual(deskIntent('which brokers are connected?'), { kind: 'connections' });
  assert.deepEqual(deskIntent('connect my Alpaca paper account'), { kind: 'alpaca_setup' });
  for (const no of ['I never want to confirm live trading without seeing the order first', 'my connection is slow', 'the alpaca at the zoo']) assert.equal(deskIntent(no)?.kind === 'confirm_live' || deskIntent(no)?.kind === 'alpaca_setup', false, no);
  const s = store();
  const t0 = Date.parse('2026-10-19T14:00:00Z');
  assert.match((await confirmLive(s, t0)).error, /^Live trading is turned off in CHE's code/);
  assert.equal((await requestLive(s, t0)).disabled, true);
  assert.equal((await readDesk(s)).live_request_at, 0, 'the request is not even recorded');
  assert.match((await confirmLive(s, t0 + 1000)).error, /turned off in CHE's code.*Nothing changed/);
  assert.equal((await readDesk(s)).mode, 'paper');
  await setMode(s, 'sim');
  assert.match((await requestLive(s, t0 + 2000)).reply, /You stay on your NinjaTrader simulated account\. Nothing changed\.$/);
  assert.equal((await confirmLive(s, t0 + 3000)).disabled, true);
  assert.equal((await readDesk(s)).mode, 'sim', 'sim stays sim');
});

test('trading intents need the whole request: questions and ordinary sentences are not commands (review of #348)', () => {
  for (const no of ['confirm live trading is disabled', 'confirm live trading hours for the NYSE', 'confirm live trading is still off?',
    'add alpaca to the list of stocks I watch', 'link me an article about alpaca wool', 'set up a meeting about the alpaca farm',
    'my trading connection keeps dropping on wifi', 'write an essay about broker status in Europe']) {
    assert.equal(deskIntent(no), null, no);
  }
  assert.deepEqual(deskIntent('confirm live trading.'), { kind: 'confirm_live' });
  assert.deepEqual(deskIntent('remove my Alpaca keys'), { kind: 'alpaca_remove' });
  assert.deepEqual(deskIntent('broker status'), { kind: 'connections' });
  assert.deepEqual(deskIntent('check my trading connections'), { kind: 'connections' });
  assert.deepEqual(deskIntent('connect alpaca'), { kind: 'alpaca_setup' });
  assert.deepEqual(deskIntent('how do I connect Alpaca?'), { kind: 'alpaca_setup' });
});

test('comprehension audit: short mode switches and mode questions reach the desk; going live still waits for the confirmation', () => {
  assert.deepEqual(deskIntent('switch to paper'), { kind: 'mode', mode: 'paper' });
  assert.deepEqual(deskIntent('che, go back to paper trading.'), { kind: 'mode', mode: 'paper' });
  for (const text of ['go live on trading.', "turn on live trading but don't place any orders.", 'switch to live trading.']) {
    assert.deepEqual(deskIntent(text), { kind: 'mode', mode: 'live' }, text);
  }
  for (const text of ['is live trading on?', 'are we trading live or paper right now?', 'am i on live']) {
    assert.deepEqual(deskIntent(text), { kind: 'status' }, text);
  }
  for (const text of ["don't go live yet, just tell me what it takes.", 'should i go live', 'go to paper towels aisle']) {
    assert.equal(deskIntent(text), null, text);
  }
});

// ─── Alpaca PAPER stock orders by voice (issue #344) ────────────────────

const stockOrder = (message) => stockOrderIntent(message)?.order;

test('stock orders: the owner\'s phrasings and their unpunctuated voice forms read as one exact order', () => {
  const aapl = { symbol: 'AAPL', name: '', side: 'buy', qty: 10, type: 'market', limit_price: null };
  for (const said of ['buy 10 shares of AAPL on Alpaca paper', 'Buy 10 shares of AAPL on Alpaca paper.', 'buy 10 shares of aapl on alpaca paper', 'CHE, buy 10 AAPL in my Alpaca paper account', 'I want to buy 10 shares of AAPL on alpaca paper at market', 'buy 10 shares of a a p l on alpaca paper', "buy 10 shares of AAPL on Alpaca paper but don't place it yet", 'buy ten shares of aapl on alpaca paper and just read it back']) {
    assert.deepEqual(stockOrder(said), aapl, said);
  }
  const msft = { symbol: 'MSFT', name: '', side: 'sell', qty: 5, type: 'limit', limit_price: 410 };
  for (const said of ['sell 5 MSFT paper at limit 410', 'sell 5 msft paper at limit 410', 'Sell 5 shares of MSFT on Alpaca paper with a limit of $410', 'sell five msft on alpaca paper limit price 410 dollars']) {
    assert.deepEqual(stockOrder(said), msft, said);
  }
  assert.deepEqual(stockOrder('buy ten shares of apple on alpaca paper'), { ...aapl, name: 'Apple' }, 'a company name said aloud is read back with its ticker');
  assert.equal(stockOrder('buy a hundred shares of TSLA on alpaca paper').qty, 100);
  assert.equal(stockOrder('buy 1 share of BRK.B on alpaca paper').symbol, 'BRK.B');
  assert.equal(stockOrder('sell 10 shares of CL on alpaca paper').symbol, 'CL', 'CL with shares is Colgate, not crude oil');
  assert.equal(stockOrderIntent('buy 10 shares of AAPL on Alpaca paper').paper, true);
  assert.deepEqual(deskIntent('buy 10 shares of AAPL on Alpaca paper').kind, 'stock_order');
});

test('stock orders: options, crypto, futures, live, fractions and stops are refused with the reason; other buys keep their routes', () => {
  for (const [said, why, paper] of [
    ['buy 1 AAPL call on alpaca paper', /option orders/, true],
    ['buy 2 SPY 450 puts expiring friday on alpaca paper', /option orders/, true],
    ['buy 1 AAPL261218C00250000 on alpaca paper', /option orders/, true],
    ['buy 1 bitcoin on alpaca paper', /not crypto/, true],
    ['buy 0.1 BTC on alpaca paper', /not crypto/, true],
    ['buy 2 MNQ on alpaca paper', /does not trade futures/, true],
    ['buy 1 ES contract on alpaca paper', /does not trade futures/, true],
    ['buy 10 shares of AAPL on alpaca live', /only to your Alpaca PAPER account/, false],
    ['buy 10 shares of AAPL on my alpaca account with real money', /only to your Alpaca PAPER account/, false],
    ['buy 0.5 shares of AAPL on alpaca paper', /whole shares only/, true],
    ['buy 5000 shares of AAPL on alpaca paper', /1 to 1,000 shares/, true],
    ['buy 10 shares of AAPL on alpaca paper with a stop at 180', /market or limit orders for one trading day only/, true],
    ['buy 10 shares of AAPL on alpaca paper and pay my electric bill', /not all of it \("and pay my electric bill"\)/, false],
    ['buy 1 bitcoin on alpaca paper and then pay rent', /not crypto/, false],
    ['buy some apple on alpaca', /How many shares of which stock/, false],
    ['buy 10 shares of it on alpaca paper', /How many shares of which stock/, false],
  ]) {
    const intent = stockOrderIntent(said);
    assert.match(intent.refuse, why, said);
    assert.match(intent.refuse, /Nothing was sent\.$/, said);
    assert.equal(intent.order, undefined, said);
    assert.equal(intent.paper, paper, `${said}: only a turn that cannot be real money skips the money hold`);
  }
  for (const other of ['buy 10 shares of AAPL', 'buy paper towels', 'buy 10 paper towels', 'paper trade Apple', 'what is alpaca paper trading?', 'sell my old couch', 'yes', 'buy the tickets']) {
    assert.equal(stockOrderIntent(other), null, other);
  }
});

test('stock orders: the read-back names the exact order and the account; the receipt says a fill only when it records one', () => {
  assert.equal(speakStockOrder({ order: { symbol: 'MSFT', name: '', side: 'sell', qty: 5, type: 'limit', limit_price: 410 } }),
    'Alpaca PAPER order, sir, no real money: sell 5 shares of MSFT, limit order at $410.00, good for one trading day. Account: Alpaca PAPER. To send it, say "yes, place it" within two minutes; say "no" to drop it. Nothing has been sent yet.');
  assert.doesNotMatch(speakStockOrder({ order: stockOrder('buy 1 share of AAPL on alpaca paper') }), /do you want me to/i, 'the read-back is not a plain yes question');
  assert.match(speakStockReceipt({ id: 'abc-123', symbol: 'AAPL', qty: 10, filled_qty: 0, side: 'buy', type: 'market', status: 'accepted' }), /status accepted\. No fill yet/);
  assert.match(speakStockReceipt({ id: 'abc-123', symbol: 'AAPL', qty: 10, filled_qty: 4, filled_avg_price: 231.5, side: 'buy', type: 'market', status: 'partially_filled' }), /Partly filled so far: 4 of 10 at \$231\.50\./);
  assert.match(speakStockReceipt({ id: 'abc-123', symbol: 'AAPL', qty: 10, filled_qty: 10, filled_avg_price: 231.5, side: 'buy', type: 'market', status: 'filled' }), /Filled: 10 at \$231\.50\.$/);
  assert.doesNotMatch(speakStockReceipt({ id: 'x', symbol: 'AAPL', qty: 10, filled_qty: null, side: 'buy', type: 'market', status: 'new' }), /\bFilled\b/);
  assert.deepEqual(['yes, place it', 'yes place it', 'yes, please place the order'].map((m) => deskIntent(m)), Array(3).fill({ kind: 'take', place: true, live: false }), 'paper-only yes');
  assert.deepEqual(['place it', 'place the order'].map((m) => deskIntent(m)), Array(2).fill({ kind: 'place_unconfirmed' }), 'a bare "place it" has no yes, so it places nothing (B1)');
  assert.deepEqual(['no', "no, don't place it", 'dont place it', 'cancel it', 'drop it'].map((m) => deskIntent(m)?.kind), Array(5).fill('stock_no'));
  assert.equal(deskIntent('yes'), null, 'a bare yes is never an order confirmation by itself');
  for (const m of ['check my Alpaca paper orders', 'what are my alpaca paper orders', 'did my paper order fill?']) assert.equal(deskIntent(m)?.kind, 'alpaca_orders', m);
  for (const m of ['what do I need for Tradovate?', 'tradovate steps', 'how do I get Tradovate API access']) assert.equal(deskIntent(m)?.kind, 'tradovate_steps', m);
});

test('B1 regression: a bare "place it" is never a place-take; only "yes, place it" is', () => {
  for (const said of ['place it', 'place the order', 'please place it now', 'place my order']) {
    assert.deepEqual(deskIntent(said), { kind: 'place_unconfirmed' }, said);
  }
  // A paper-only yes: it takes a live alert only through the take refusal in the worker (blocker 1).
  for (const said of ['yes, place it', 'yes place it', 'Yes, please place it.', 'yes, place the order']) {
    assert.deepEqual(deskIntent(said), { kind: 'take', place: true, live: false }, said);
  }
  // The live alert's own approval: the only yes phrases that may take a live alert.
  for (const said of ['yes, take the trade', 'yes, place the trade', 'yes, take it']) {
    assert.deepEqual(deskIntent(said), { kind: 'take', place: true, live: true }, said);
  }
  // "Take the trade" keeps its own explicit words; it is not a place-take and does not change.
  assert.deepEqual(deskIntent('take the trade'), { kind: 'take_unconfirmed' }, 'a bare take phrase is never a place-take');
  assert.deepEqual(deskIntent('yes, take the trade'), { kind: 'take', place: true, live: true }, 'the explicit yes is the place-take');
});

test('B4 regression: shopping sentences and dictionary words are never Alpaca stock orders', () => {
  for (const said of ['buy 10 reams paper', 'buy 10 boxes paper', 'Buy 10 rolls of paper towels on Amazon', 'buy 10 reams of paper on alpaca paper', 'buy 3 cost paper', 'buy 10 rolls paper', 'buy 10 apple paper towels']) {
    const intent = stockOrderIntent(said);
    assert.ok(intent === null || (intent.refuse && !intent.order), `${said}: must not become an order (${JSON.stringify(intent)})`);
    assert.ok(!intent || !/I heard an Alpaca paper order/.test(intent.refuse || ''), `${said}: not answered as a half-heard Alpaca order`);
  }
  // Without a shares, stock or Alpaca signal, a sentence with a paper venue is not a broker order at all.
  for (const said of ['buy 10 reams paper', 'buy 10 boxes paper', 'buy 10 rolls of paper towels on Amazon']) assert.equal(stockOrderIntent(said), null, said);
  // A dictionary word with the stock signal is refused by name, never read back as an order.
  assert.equal(stockOrderIntent('buy 10 shares of reams on alpaca paper').order, undefined);
  assert.match(stockOrderIntent('buy 10 shares of reams on alpaca paper').refuse, /I don't know a stock called REAMS/);
  assert.equal(stockOrderIntent('buy 10 boxes on alpaca paper').order, undefined);
  // The ticker list and the company names still read back exactly.
  assert.equal(stockOrder('buy 10 shares of aapl on alpaca paper').symbol, 'AAPL');
  assert.equal(stockOrder('buy 10 shares of google on alpaca paper').symbol, 'GOOGL');
  assert.equal(stockOrder('buy 10 shares of AMD on alpaca paper').symbol, 'AMD');
});

test('B5 regression: only an explicit yes is a place-take; every trade phrase without it is take_unconfirmed', () => {
  for (const said of ['take the trade', 'place the trade now', 'place the trade', 'confirm the trade', 'enter the trade', 'send the trade', 'take the trade now', 'take the trade and pay my bill']) {
    assert.deepEqual(deskIntent(said), { kind: 'take_unconfirmed' }, said);
  }
  const explicit = {
    'yes, take the trade': true, 'yes take the trade': true, 'yes, place the trade': true, 'yes, take it': true,
    'yes, confirm the trade': false, 'yes, enter the trade': false, 'yes, send the trade': false, 'yes, place it': false,
  };
  for (const [said, live] of Object.entries(explicit)) {
    assert.deepEqual(deskIntent(said), { kind: 'take', place: true, live }, said);
  }
});

test('stock orders: sent once only after the yes within two minutes; expiry, no and failures send nothing more', async () => {
  const s = store();
  const t0 = Date.parse('2026-10-19T14:30:00Z');
  const sent = [];
  const place = async (o) => { sent.push(o); return { ok: true, receipt: { id: 'ord-0042', client_order_id: o.client_order_id, symbol: o.symbol, qty: o.qty, filled_qty: 0, side: o.side, type: o.type, status: 'accepted' } }; };
  assert.match((await confirmStockOrder(s, { now: t0, place })).reply, /no Alpaca paper order waiting/);
  const pending = await requestStockOrder(s, stockOrder('buy 10 shares of AAPL on alpaca paper'), t0);
  assert.match(pending.client_order_id, /^che-[0-9a-f-]{36}$/);
  assert.equal(sent.length, 0, 'the read-back sends nothing');
  const placed = await confirmStockOrder(s, { now: t0 + 60_000, place });
  assert.equal(placed.ok, true);
  assert.match(placed.reply, /^Sent to Alpaca PAPER, sir: buy 10 shares of AAPL, market order, good for one trading day\. Alpaca's receipt: order ending 0042/);
  assert.deepEqual(sent, [{ ...pending.order, client_order_id: pending.client_order_id }]);
  const again = await confirmStockOrder(s, { now: t0 + 61_000, place });
  assert.equal(again.repeated, true);
  assert.equal(sent.length, 1, 'a second yes is the same order, never a second one');
  assert.match((await dropStockOrder(s, t0 + 62_000)) && (await confirmStockOrder(s, { now: t0 + 63_000, place })).reply, /already sent/, 'a no after it was sent leaves the record');

  await requestStockOrder(s, stockOrder('sell 5 MSFT paper at limit 410'), t0);
  assert.match((await confirmStockOrder(s, { now: t0 + 121_000, place })).reply, /no Alpaca paper order waiting/, 'two minutes and the order is gone');
  await requestStockOrder(s, stockOrder('sell 5 MSFT paper at limit 410'), t0);
  assert.equal((await dropStockOrder(s, t0 + 1000)).dropped, true);
  assert.match((await confirmStockOrder(s, { now: t0 + 2000, place })).reply, /no Alpaca paper order waiting/);
  assert.equal(sent.length, 1);

  // A refusal from Alpaca is said as Alpaca said it, and a yes again does not resend it.
  const refusing = async () => ({ ok: false, detail: 'Alpaca\'s paper service did not accept the order: insufficient buying power. Nothing was placed, sir.' });
  await requestStockOrder(s, stockOrder('buy 900 shares of NVDA on alpaca paper'), t0);
  assert.match((await confirmStockOrder(s, { now: t0 + 1000, place: refusing })).reply, /insufficient buying power\. Nothing was placed/);
  let calls = 0;
  assert.match((await confirmStockOrder(s, { now: t0 + 2000, place: async () => { calls += 1; return { ok: true }; } })).reply, /insufficient buying power.*Ask me again for a new order/);
  assert.equal(calls, 0);
  // The desk's other state survives the stock order.
  await setMode(s, 'sim');
  assert.equal((await readDesk(s)).mode, 'sim');
  assert.equal((await readDesk(s)).stock_order.status, 'failed');
});
