// CHE Futures Paper Simulator (futures_paper.js, futures_paper_desk.js). Owner, 2026-11-04: manual paper trading of MNQ,
// NQ, MES and ES with Buy, Sell, Stop Loss, Take Profit, Cancel and Flatten, verified acknowledgments, fills, positions
// and P&L, and end-to-end tests of connection loss, rejected and duplicate orders, stop execution and emergency flatten.
// Prices here are recorded-shape delayed bars (the Yahoo chart answer the Worker really parses); nothing reaches a broker.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { boundHistory, emptyState, feedReading, flatten, ledgerBook, placeOrder, reconcile, workOrders, cancelOrder, ROOTS, DAILY_LOSS_LIMIT } from './futures_paper.js';
import { futuresPaperApi, futuresPaperIntent, locked, PROBE_STATE_KEY } from './futures_paper_desk.js';

const T0 = Date.parse('2026-11-04T15:00:00Z'); // a Wednesday, CME open
const bar = (min, o, h, l, c) => ({ t: new Date(T0 + min * 60_000).toISOString(), o, h, l, c, v: 100 });
const reading = (root, candles, now, extra = {}) => feedReading(root, { status: 'DELAYED', provider: 'Yahoo Finance chart (public)', contract: `${root}Z6`, session: { open: true, state: 'open' }, candles, ...extra }, now);

test('a market order is acknowledged and filled at the latest delayed price plus one tick, with commission and P&L', () => {
  const s = emptyState(T0);
  const now = T0 + 11 * 60_000;
  const out = placeOrder(s, { root: 'MNQ', side: 'buy', qty: 2, type: 'market' }, reading('MNQ', [bar(9, 21000, 21002, 20998, 21001)], now), now);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.status, 'success');
  assert.equal(out.receipt.order_status, 'filled');
  assert.equal(out.fill.price, 21001.25);
  assert.equal(out.fill.commission, 1.24);
  assert.deepEqual(s.positions.MNQ, { qty: 2, avg: 21001.25 });
  // Sell back 10 points higher: 10 * 2 contracts * $2 = $40, less commissions.
  const later = T0 + 13 * 60_000;
  const close = placeOrder(s, { root: 'MNQ', side: 'sell', qty: 2, type: 'market' }, reading('MNQ', [bar(11, 21011, 21012, 21010, 21011.5)], later), later);
  assert.equal(close.fill.price, 21011.25);
  assert.equal(close.fill.realized, 40);
  assert.equal(s.realized, 40);
  assert.equal(s.cash, 50_000 + 40 - 2.48);
  assert.equal(reconcile(s, later).status, 'success');
});

test('a bracket: entry fills, its stop loss and take profit work, and a bar touching both fills the stop first (worst case)', () => {
  const s = emptyState(T0);
  const now = T0;
  const entry = placeOrder(s, { root: 'ES', side: 'buy', qty: 1, type: 'limit', price: 5000, stop_loss: 4990, take_profit: 5020 }, reading('ES', [bar(-12, 5005, 5006, 5004, 5005)], now), now);
  assert.equal(entry.receipt.status, 'accepted');
  // A bar from before the order was placed never fills it.
  workOrders(s, 'ES', [bar(-1, 5001, 5002, 4999, 5000)], now);
  assert.equal(entry.order.status, 'working');
  workOrders(s, 'ES', [bar(1, 5002, 5003, 4999.5, 5000.5)], now);
  assert.equal(entry.order.status, 'filled');
  assert.equal(entry.order.fill_price, 5000);
  const legs = s.orders.filter((o) => o.parent_id === entry.order.id);
  assert.deepEqual(legs.map((o) => [o.role, o.type, o.side, o.price, o.status]), [['stop_loss', 'stop', 'sell', 4990, 'working'], ['take_profit', 'limit', 'sell', 5020, 'working']]);
  // One wild bar reaches both: the stop fills (one tick worse) and cancels the target.
  workOrders(s, 'ES', [bar(3, 5000, 5021, 4989, 5010)], now);
  const [stop, target] = legs;
  assert.equal(stop.status, 'filled');
  assert.equal(stop.fill_price, 4989.75);
  assert.equal(target.status, 'cancelled');
  assert.match(target.cancel_reason, /bracket partner/);
  assert.equal(s.positions.ES.qty, 0);
  assert.equal(s.realized, (4989.75 - 5000) * 50);
  assert.equal(reconcile(s, now).status, 'success');
});

test('a take profit fills at its price; a stop gaps through at the open', () => {
  const s = emptyState(T0);
  placeOrder(s, { root: 'MES', side: 'sell', qty: 1, type: 'market', take_profit: 4980, stop_loss: 5010 }, reading('MES', [bar(-11, 5000, 5000, 5000, 5000)], T0), T0);
  workOrders(s, 'MES', [bar(1, 4985, 4986, 4979, 4981)], T0);
  assert.equal(s.positions.MES.qty, 0);
  assert.equal(s.fills.at(-1).price, 4980);
  const g = emptyState(T0);
  placeOrder(g, { root: 'NQ', side: 'buy', qty: 1, type: 'stop', price: 21100 }, reading('NQ', [bar(-11, 21050, 21050, 21050, 21050)], T0), T0);
  workOrders(g, 'NQ', [bar(1, 21120, 21130, 21115, 21125)], T0);
  assert.equal(g.fills[0].price, 21120.25, 'a buy stop gapped through fills at the open plus a tick');
});

test('rejected orders: no current price, connection loss, wrong tick, over the limit, a bracket on the wrong side', () => {
  const s = emptyState(T0);
  const stale = reading('MNQ', [bar(-60, 21000, 21000, 21000, 21000)], T0);
  assert.match(placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market' }, stale, T0).text, /no current MNQ price \(the latest delayed bar is \d+ minutes old\)/);
  const down = feedReading('MNQ', { status: 'UNAVAILABLE', error: 'Yahoo did not answer within 10 seconds' }, T0);
  assert.match(placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market' }, down, T0).text, /the feed is unavailable: Yahoo did not answer within 10 seconds/);
  // A resting order is still accepted while the feed is down; it waits for prices.
  assert.equal(placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'limit', price: 20900 }, down, T0).receipt.status, 'accepted');
  const fresh = reading('MNQ', [bar(-11, 21000, 21000, 21000, 21000)], T0);
  assert.match(placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'limit', price: 21000.1 }, fresh, T0).text, /not on MNQ's 0.25-point tick/);
  assert.match(placeOrder(s, { root: 'NQ', side: 'buy', qty: 3, type: 'market' }, reading('NQ', [bar(-11, 21000, 21000, 21000, 21000)], T0), T0).text, /over the 2-contract paper limit/);
  assert.match(placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market', stop_loss: 21010 }, fresh, T0).text, /stop loss must be below its entry/);
  assert.match(placeOrder(s, { root: 'GC', side: 'buy', qty: 1, type: 'market' }, fresh, T0).text, /I trade only MNQ, NQ, MES, ES on paper/);
  const rejected = s.orders.filter((o) => o.status === 'rejected');
  assert.equal(rejected.length, 6);
  assert.ok(rejected.every((o) => o.reject_reason));
  assert.equal(s.fills.length, 0);
});

test('duplicates: the same client id never places twice, and an identical order within five seconds is refused', () => {
  const s = emptyState(T0);
  const fresh = reading('MNQ', [bar(-11, 21000, 21000, 21000, 21000)], T0);
  const a = placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market', client_id: 'tap-1' }, fresh, T0);
  const b = placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market', client_id: 'tap-1' }, fresh, T0 + 30_000);
  assert.equal(b.duplicate, true);
  assert.equal(b.order.id, a.order.id);
  const c = placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'market' }, fresh, T0 + 2_000);
  assert.equal(c.duplicate, true);
  assert.equal(s.fills.length, 1);
  assert.equal(s.positions.MNQ.qty, 1);
});

test('cancel and emergency flatten: working orders cancelled, positions closed even on a stale price, ledger reconciled', () => {
  const s = emptyState(T0);
  const fresh = (root) => reading(root, [bar(-11, root === 'NQ' ? 21000 : 5000, root === 'NQ' ? 21000 : 5000, root === 'NQ' ? 21000 : 5000, root === 'NQ' ? 21000 : 5000)], T0);
  placeOrder(s, { root: 'NQ', side: 'buy', qty: 1, type: 'market', stop_loss: 20950 }, fresh('NQ'), T0);
  placeOrder(s, { root: 'MES', side: 'sell', qty: 2, type: 'market' }, fresh('MES'), T0);
  const limit = placeOrder(s, { root: 'MES', side: 'buy', qty: 1, type: 'limit', price: 4900 }, fresh('MES'), T0 + 10_000);
  assert.equal(cancelOrder(s, limit.order.id, T0).receipt.status, 'success');
  assert.equal(cancelOrder(s, limit.order.id, T0).ok, false, 'a cancelled order cannot be cancelled again');
  // The feed then goes stale (connection loss): flatten still closes on the last delayed prices, and says they are stale.
  const later = T0 + 90 * 60_000;
  const stale = { NQ: { ...fresh('NQ'), fresh: false, age_s: 5400 }, MES: { ...fresh('MES'), fresh: false, age_s: 5400 } };
  const out = flatten(s, stale, {}, later);
  assert.equal(out.receipt.status, 'success');
  assert.equal(out.closed.length, 2);
  assert.ok(out.closed.every((c) => c.stale));
  assert.match(out.text, /stale delayed price/);
  assert.ok(s.orders.filter((o) => o.role === 'stop_loss').every((o) => o.status === 'cancelled'));
  assert.equal(Object.values(s.positions).filter((p) => p.qty).length, 0);
  assert.equal(reconcile(s, later).status, 'success');
  // A tampered book is caught.
  s.positions.NQ = { qty: 1, avg: 21000 };
  assert.match(reconcile(s, later).diffs.join(' '), /NQ: stored 1 @ 21000, ledger 0 @ 0/);
});

test('past the daily loss limit only reducing orders are accepted', () => {
  const s = emptyState(T0);
  const at = (p, m) => reading('NQ', [bar(m, p, p, p, p)], T0 + (m + 11) * 60_000);
  placeOrder(s, { root: 'NQ', side: 'buy', qty: 1, type: 'market' }, at(21000, 0), T0 + 11 * 60_000);
  // A 30-point fall is $600 on NQ, past the $500 limit.
  placeOrder(s, { root: 'NQ', side: 'sell', qty: 1, type: 'market' }, at(20970, 2), T0 + 13 * 60_000);
  assert.ok(s.realized < -DAILY_LOSS_LIMIT);
  assert.match(placeOrder(s, { root: 'NQ', side: 'buy', qty: 1, type: 'market' }, at(20970, 4), T0 + 15 * 60_000).text, /daily limit; only orders that reduce a position are accepted/);
});

test('the ledger alone recomputes the book', () => {
  const book = ledgerBook([
    { root: 'MNQ', side: 'buy', qty: 2, price: 100, commission: 1.24 },
    { root: 'MNQ', side: 'sell', qty: 3, price: 110, commission: 1.86 },
  ]);
  assert.deepEqual(book.positions.MNQ, { qty: -1, avg: 110 });
  assert.equal(book.realized, 40);
  assert.equal(book.cash, 50_000 + 40 - 3.1);
  assert.equal(ROOTS.ES.pointValue, 50);
});

test('chat requests are read exactly; live wording is refused; stock orders are left to the stock desk', () => {
  assert.deepEqual(futuresPaperIntent('Buy 1 NQ stop 21500 with a stop loss at 21450 and target 21600'), { action: 'order', side: 'buy', qty: 1, root: 'NQ', type: 'stop', price: 21500, stop_loss: 21450, take_profit: 21600 });
  assert.equal(futuresPaperIntent('Jay, sell 3 MES at 5,000.').price, 5000);
  assert.equal(futuresPaperIntent('Buy 1 MNQ at market.').type, 'market');
  assert.equal(futuresPaperIntent('Buy 1 MNQ live with real money.').action, 'live_refused');
  assert.equal(futuresPaperIntent('Emergency flatten now').action, 'flatten');
  assert.equal(futuresPaperIntent('Close all my futures positions').action, 'flatten');
  assert.equal(futuresPaperIntent('Cancel order O-00012').id, 'O-00012');
  for (const q of ['Buy 10 shares of AAPL', 'What is MNQ?', 'Should I buy MNQ?']) assert.equal(futuresPaperIntent(q), null, q);
});

// ─── Codex review on #925 ───

test('working entries count toward the contract limit, and a fill is checked again at execution', () => {
  const s = emptyState(T0);
  const r = reading('ES', [bar(-11, 5000, 5000, 5000, 5000)], T0);
  assert.equal(placeOrder(s, { root: 'ES', side: 'buy', qty: 2, type: 'limit', price: 4990 }, r, T0).receipt.status, 'accepted');
  assert.match(placeOrder(s, { root: 'ES', side: 'buy', qty: 2, type: 'limit', price: 4980 }, r, T0 + 10_000).text, /up to 4 ES with the working orders, over the 2-contract paper limit/);
  // An order accepted before a position grew is refused when it would fill past the limit.
  const t = emptyState(T0);
  placeOrder(t, { root: 'ES', side: 'buy', qty: 2, type: 'limit', price: 4990 }, r, T0);
  t.positions.ES = { qty: 1, avg: 5000 };
  workOrders(t, 'ES', [bar(1, 4991, 4992, 4989, 4990)], T0);
  assert.equal(t.orders[0].status, 'rejected');
  assert.match(t.orders[0].reject_reason, /filling it would hold 3 ES/);
});

test('a bracket\'s exits are reduce-only: closing the position by hand cancels them, so they cannot reopen it', () => {
  const s = emptyState(T0);
  const r = (m, p) => reading('ES', [bar(m, p, p, p, p)], T0 + (m + 11) * 60_000);
  placeOrder(s, { root: 'ES', side: 'buy', qty: 1, type: 'market', stop_loss: 4990 }, r(-11, 5000), T0);
  placeOrder(s, { root: 'ES', side: 'sell', qty: 1, type: 'market' }, r(1, 5005), T0 + 12 * 60_000);
  const stop = s.orders.find((o) => o.role === 'stop_loss');
  assert.equal(stop.status, 'cancelled');
  assert.match(stop.cancel_reason, /position it protected is closed/);
  workOrders(s, 'ES', [bar(14, 4995, 4996, 4980, 4985)], T0 + 30 * 60_000);
  assert.equal(s.positions.ES.qty, 0, 'no stale stop reverses the flat position');
});

test('a bracket entry that fills in a bar that also runs through its stop is stopped out in that bar (worst case)', () => {
  const s = emptyState(T0);
  placeOrder(s, { root: 'ES', side: 'buy', qty: 1, type: 'limit', price: 5000, stop_loss: 4990, take_profit: 5050 }, reading('ES', [bar(-11, 5005, 5005, 5005, 5005)], T0), T0);
  workOrders(s, 'ES', [bar(1, 5003, 5004, 4985, 4988)], T0);
  assert.deepEqual(s.fills.map((f) => f.price), [5000, 4989.75]);
  assert.equal(s.positions.ES.qty, 0);
  assert.equal(s.orders.find((o) => o.role === 'take_profit').status, 'cancelled');
});

test('bounded history keeps every working order, and old fills fold into a base the ledger still rebuilds from', () => {
  const s = emptyState(T0);
  const r = (p) => reading('MNQ', [bar(-11, p, p, p, p)], T0);
  placeOrder(s, { root: 'MNQ', side: 'buy', qty: 1, type: 'limit', price: 100, client_id: 'keep' }, r(21000), T0);
  for (let i = 0; i < 1100; i++) placeOrder(s, { root: 'MNQ', side: i % 2 ? 'sell' : 'buy', qty: 1, type: 'market', client_id: `m${i}` }, r(21000 + (i % 2 ? 10 : 0)), T0);
  boundHistory(s);
  assert.ok(s.orders.some((o) => o.client_id === 'keep' && o.status === 'working'), 'the old working order survives the trim');
  assert.equal(s.fills.length, 1000);
  assert.ok(s.base, 'the dropped fills are an accounting base');
  assert.equal(reconcile(s, T0).status, 'success', reconcile(s, T0).diffs.join('; '));
});

test('one account change at a time: two overlapping requests both keep their orders', async () => {
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const slow = (delay, p) => async (root) => { await new Promise((res) => setTimeout(res, delay)); return { status: 'DELAYED', provider: 'Yahoo', session: { open: true }, candles: [{ t: new Date(Date.now() - 11 * 60_000).toISOString(), o: p, h: p, l: p, c: p, v: 1 }] }; };
  const [a, b] = await Promise.all([
    futuresPaperApi('/api/futures/paper/order', 'POST', { root: 'MNQ', side: 'buy', qty: 1, type: 'limit', price: 20000, client_id: 'a' }, storage, { load: slow(40, 21000) }),
    futuresPaperApi('/api/futures/paper/order', 'POST', { root: 'MES', side: 'buy', qty: 1, type: 'limit', price: 4000, client_id: 'b' }, storage, { load: slow(5, 5000) }),
  ]);
  assert.notEqual(a.body.order.id, b.body.order.id);
  const orders = saved.get('futures_paper_v1').orders.map((o) => o.client_id).sort();
  assert.deepEqual(orders, ['a', 'b']);
  // The lock runs callers in order and survives a failure.
  const seen = [];
  await Promise.all([locked('k', async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(1); }), locked('k', async () => { seen.push(2); throw new Error('x'); }).catch(() => null), locked('k', async () => seen.push(3))]);
  assert.deepEqual(seen, [1, 2, 3]);
});

// Through the real Worker: /api/chat, the app's /api/futures/paper routes and the deploy's probe route, with a Yahoo
// stand-in that answers the chart JSON shape the Worker parses.
const generated = new URL('./.futures_paper.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let yahooUp = true;
const yahooPrice = { 'MNQ=F': 21000, 'NQ=F': 21000, 'MES=F': 5000, 'ES=F': 5000 };
globalThis.fetch = async (url) => {
  const u = String(url?.url || url);
  const m = /finance\/chart\/([^?]+)/.exec(u);
  if (m) {
    if (!yahooUp) return new Response('{}', { status: 503 });
    const sym = decodeURIComponent(m[1]);
    const nowS = Math.floor(Date.now() / 1000);
    const start = Math.floor(nowS / 60) * 60 - 11 * 60;
    const ts = [start - 60, start];
    const p = yahooPrice[sym];
    return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: sym, regularMarketTime: start + 61, exchangeDataDelayedBy: 10, exchangeName: 'CME' }, timestamp: ts, indicators: { quote: [{ open: [p, p], high: [p, p], low: [p, p], close: [p, p], volume: [1, 1] }] } }] } }), { status: 200 });
  }
  return new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
};

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat and /api/futures/paper: order, ack, fill, position, connection loss, flatten and reconcile end to end', { skip: (() => { const d = new Date(); const day = d.getUTCDay(); const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d)); return day === 6 || (day === 0 && d.getUTCHours() < 23) || (day === 5 && d.getUTCHours() >= 21) || etHour === 17; })() && 'the CME session is closed now (weekend or the 5–6 pm New York daily break), so market orders are correctly rejected' }, async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, method, body, token) => worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await call('/api/pair', 'POST', { code: '123456' })).json()).device_token;
  const once = async (message) => {
    const frames = (await (await call('/api/chat', 'POST', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { text: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') || frames[0]?.reply || '', done: frames.find((f) => f.type === 'done') || {}, held: frames[0]?.held_for_owner === true };
  };
  // An order, a flatten or a cancel in chat is held for the owner's yes first (review #356); his yes runs it.
  const say = async (message) => {
    const first = await once(message);
    if (!first.held) return first;
    assert.match(first.text, /I need your yes/);
    return once('Yes.');
  };
  const buy = await say('Buy 1 MNQ at market with a stop loss at 20950 and take profit 21100.');
  assert.equal(buy.done.source, 'che_futures_paper');
  assert.equal(buy.done.execution_receipt.status, 'success');
  assert.equal(buy.done.execution_receipt.fill_price, 21000.25);
  assert.match(buy.text, /Paper order O-00001 filled, sir: buy 1 MNQ at 21000.25[\s\S]*stop loss 20950 and take profit 21100 are working/);
  // The app's account view reads the same ledger.
  const view = await (await call('/api/futures/paper?root=MNQ', 'GET', null, token)).json();
  assert.deepEqual(view.positions.map((p) => [p.root, p.qty, p.avg]), [['MNQ', 1, 21000.25]]);
  assert.equal(view.working.length, 2);
  assert.equal(view.feeds.MNQ.status, 'DELAYED');
  // Connection loss: a new market order is rejected, working orders stay, and flatten still closes on paper.
  yahooUp = false;
  const blocked = await (await call('/api/futures/paper/order', 'POST', { root: 'MNQ', side: 'buy', qty: 1, type: 'market', client_id: 'tap-2' }, token)).json();
  assert.equal(blocked.receipt.status, 'rejected');
  assert.match(blocked.text, /feed is unavailable/);
  const flat = await say('Emergency flatten now');
  assert.equal(flat.done.execution_receipt.status, 'success');
  assert.match(flat.text, /closed long 1 MNQ at 20999.75/);
  yahooUp = true;
  const rec = await say('Reconcile my futures paper account.');
  assert.equal(rec.done.execution_receipt.status, 'success');
  assert.equal(rec.done.execution_receipt.positions.MNQ.qty, 0);
  // The deploy's probe route trades the separate test account only.
  const probeEnv = { ...env, CHE_VOICE_PROBE_TOKEN: 'p'.repeat(40) };
  const probe = await worker.fetch(new Request('https://che.example/api/probe/futures-paper/order', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'p'.repeat(40)}` }, body: JSON.stringify({ root: 'MES', side: 'buy', qty: 1, type: 'market', client_id: 'probe-1' }) }), probeEnv);
  const probed = await probe.json();
  assert.equal(probe.status, 200, JSON.stringify(probed).slice(0, 300));
  assert.equal(probed.receipt.status, 'success');
  assert.ok(storage.saved.get(PROBE_STATE_KEY).fills.length === 1);
  assert.equal((await storage.get('futures_paper_v1')).fills.length, 2, 'the owner\'s ledger is untouched by the probe');
  // Live wording never places anything.
  const live = await say('Buy 1 MNQ live with real money.');
  assert.match(live.text, /^Live trading is turned off/);
});
