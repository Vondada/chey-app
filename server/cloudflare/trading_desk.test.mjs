import test from 'node:test';
import assert from 'node:assert/strict';
import { deskIntent, deskTick, readDesk, setMode, setSize, takeAnnouncement, takeTrade, skipTrade, pendingAlert } from './trading_desk.js';
import { connectLink, handleCallback, placeBracket, connection, renewToken, accountBalance } from './broker_tradovate.js';

const store = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => m.set(k, structuredClone(v)), delete: async (k) => m.delete(k) };
};
const paperBook = (id = 'p1', symbol = 'es.f') => ({ open: [{ id, symbol, label: 'ES futures', strategy: 'channel-20|any|2', entry: 5820, stop: 5805, target: 5850, why: 'closed above the 20-day high 5815' }] });

test('voice: switch, connect, take, skip, size, alerts, status', () => {
  assert.deepEqual(deskIntent('CHE, switch to live trading'), { kind: 'mode', mode: 'live' });
  assert.deepEqual(deskIntent('switch over to my live account'), { kind: 'mode', mode: 'live' });
  assert.deepEqual(deskIntent('switch to sim trading'), { kind: 'mode', mode: 'sim' });
  assert.deepEqual(deskIntent('go to the simulated account'), { kind: 'mode', mode: 'sim' });
  assert.deepEqual(deskIntent('switch back to paper trading'), { kind: 'mode', mode: 'paper' });
  assert.equal(deskIntent('connect my NinjaTrader account').kind, 'connect');
  assert.equal(deskIntent('Take the trade').kind, 'take');
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

test('live mode: nothing is placed until the owner says take the trade; skip and expiry place nothing', async () => {
  const s = store();
  await setMode(s, 'live');
  let placed = [];
  const place = async (_st, mode, a) => { placed.push(mode); return { ok: true, order_id: 9, account: 'LIVE1', symbol: 'MESZ6', entry: a.entry, stop: a.stop, target: a.target, qty: a.qty }; };
  const t0 = Date.UTC(2026, 9, 5, 14);
  await deskTick(s, paperBook(), { place, now: t0 });
  assert.deepEqual(placed, [], 'no live order without a yes');
  assert.match(await takeAnnouncement(s, t0), /LIVE account.*Real money\. Say "take the trade"/);
  const taken = await takeTrade(s, { place, now: t0 + 60_000 });
  assert.equal(taken.ok, true);
  assert.deepEqual(placed, ['live']);
  assert.match(taken.reply, /Placed on your LIVE account LIVE1.*order 9/);
  assert.match((await takeTrade(s, { place, now: t0 + 120_000 })).reply, /no open trade alert/, 'one yes places once');
  // Skip.
  await deskTick(s, paperBook('p2'), { place, now: t0 });
  assert.match(await skipTrade(s, t0), /Skipped.*Nothing was placed/);
  // Expired alerts cannot be taken.
  await deskTick(s, paperBook('p3'), { place, now: t0 });
  assert.equal(pendingAlert(await readDesk(s), t0 + 21 * 3600_000), null);
  assert.match((await takeTrade(s, { place, now: t0 + 21 * 3600_000 })).reply, /no open trade alert/);
  assert.deepEqual(placed, ['live']);
});

test('taking a trade in paper mode sends nothing; a failed order is reported as not placed', async () => {
  const s = store();
  await setMode(s, 'live');
  await deskTick(s, paperBook(), { place: async () => ({ ok: true }) });
  await setMode(s, 'paper');
  assert.match((await takeTrade(s, { place: async () => { throw new Error('must not place'); } })).reply, /paper trading.*Nothing was placed/);
  await setMode(s, 'live');
  const failed = await takeTrade(s, { place: async () => ({ error: 'Tradovate rejected the order: Insufficient margin.' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reply, /NOT placed.*Insufficient margin/);
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

const ENV = { CHE_TRADOVATE_CLIENT_ID: '123', CHE_TRADOVATE_CLIENT_SECRET: 'sec' };

test('NinjaTrader sign-in: one-time state, token stored, password never involved', async () => {
  const s = store();
  assert.equal((await connectLink(s, {}, 'https://che.example')).error, 'not_configured');
  const { url } = await connectLink(s, ENV, 'https://che.example');
  assert.match(url, /^https:\/\/trader\.tradovate\.com\/oauth\?response_type=code&client_id=123&redirect_uri=https%3A%2F%2Fche\.example%2Fbroker%2Ftradovate%2Fcallback&state=[0-9a-f]{48}$/);
  const state = new URL(url).searchParams.get('state');
  let sent;
  const fetcher = async (u, init) => { sent = { u, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ access_token: 'tok', expires_in: 4800 }), { status: 200 }); };
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

function tradovate({ failure } = {}) {
  const calls = [];
  const fetcher = async (u, init = {}) => {
    calls.push({ u, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith('/account/list')) return ok([{ id: 5, name: 'DEMO123', active: true }]);
    if (u.includes('/contract/suggest')) return ok([{ id: 1, name: 'MESZ6' }, { id: 2, name: 'MESH7' }]);
    if (u.endsWith('/order/placeoso')) return ok(failure ? { failureReason: 'RiskCheck', failureText: failure } : { orderId: 42, oso1Id: 43, oso2Id: 44 });
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
  const live = tradovate();
  await placeBracket(s, 'live', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher: live.fetcher });
  assert.ok(live.calls.every((c) => c.u.startsWith('https://live.tradovateapi.com/v1')), 'live goes to the live server');
});

test('orders: rejections, bad brackets, missing sign-in and size limits are refused honestly', async () => {
  const s = store();
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 })).error, /not connected/);
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() + 3600_000 });
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 1, entry: 5820, stop: 5830, target: 5850 })).error, /stop must be below/);
  assert.match((await placeBracket(s, 'sim', { root: 'MES', qty: 11, entry: 5820, stop: 5805, target: 5850 })).error, /1 to 10/);
  assert.match((await placeBracket(s, 'paper', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 })).error, /simulated or the live/);
  const { fetcher } = tradovate({ failure: 'Insufficient margin' });
  assert.match((await placeBracket(s, 'live', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher })).error, /rejected the order: Insufficient margin/);
  await s.put('tradovate_auth', { access_token: 'tok', expires_at: Date.now() - 1 });
  assert.match((await placeBracket(s, 'live', { root: 'MES', qty: 1, entry: 5820, stop: 5805, target: 5850 }, { fetcher })).error, /expired/);
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
