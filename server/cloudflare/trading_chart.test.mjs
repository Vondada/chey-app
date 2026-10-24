// The Trading Room chart (owner, 2026-10-20, Build 1): bars and feed health per account and
// timeframe, markers by source (never merged, never duplicated), the entry gate, saved drawings,
// the paper ticket preview and cancel, and the owner's chart words through /api/chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { cancelConfirmation, cancelOrderIntent, chartMarkers, chartView, drawingProblems, futuresOrderIntent, marketOrderFeedProblem, readDrawings, saveDrawings } from './trading_chart.js';
import { cancelAlpacaPaperOrder, previewAlpacaPaperOrder } from './broker_alpaca.js';

const generated = new URL('./.trading_chart.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ model = () => 'Here is the answer, sir.', env: extraEnv = {} } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extraEnv,
    AI: { run: async (_model, opts = {}) => { calls += 1; return { response: model(opts) }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  // RAGDBG=1 prints each turn (route and reply) while measuring before/after.
  const say = async (message, { as = token } = {}) => { const r = await say0(message, { as }); if (process.env.RAGDBG) console.error("DBG", JSON.stringify({ message, route: r.route, reply: r.reply.slice(0, 900) })); return r; };
  const say0 = async (message, { as = token } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history: history.slice(-8) }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { status: res.status, raw, reply, done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const seedMemory = async (records) => {
    await say('Hello CHE.');
    const data = saved.get('che');
    data.memory_records = [...(data.memory_records || []), ...records];
    saved.set('che', data);
  };
  const api = async (path, method = 'GET', payload) => (await worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env)).json();
  const raw = (path, method, payload, as = token) => worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${as}` } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env);
  // A guest: a private device enrolled into a family tenant by the owner, so it reaches routing but is not the owner.
  let guestToken = '';
  const guest = async (message) => {
    if (!guestToken) {
      const tenant = await (await send('/api/platform/tenants', { name: 'Guest', role: 'family' }, token)).json();
      const invite = await (await send('/api/platform/enrollments', { access: 'private', tenant_id: tenant.tenant.id }, token)).json();
      guestToken = (await (await send('/api/enroll', { enrollment_token: invite.enrollment.token, device_name: 'guest' })).json()).device_token;
    }
    const res = await send('/api/chat', { message, history: [] }, guestToken);
    const text = await res.text();
    while (pending.length) await pending.shift();
    const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { status: res.status, raw: text, reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join('') || (events[0]?.reply ?? ''), done, route: done.source || 'none' };
  };
  return { say, seedMemory, saved, api, raw, guest };
}



const memStorage = () => { const m = new Map(); return { saved: m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k), list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))) }; };
const ENV = { CHE_ALPACA_PAPER_KEY_ID: 'PKTEST1234', CHE_ALPACA_PAPER_SECRET: 'secret' };
const NOW = Date.parse('2026-10-20T15:00:00Z');
function fakeAlpaca({ lastBar = '2026-10-20T14:55:00Z', calls = [], failAccount = false, failTrade = false, open = null } = {}) {
  const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/v2/account' && failAccount) return new Response(JSON.stringify({ message: 'access key verification failed' }), { status: 403 });
    if (/\/trades\/latest$/.test(u.pathname) && failTrade) return new Response(JSON.stringify({ message: 'subscription does not permit querying recent SIP data' }), { status: 403 });
    if (u.pathname === '/v2/orders' && open && u.searchParams.get('status') === 'open') {
      const sym = u.searchParams.get('symbols');
      return ok(open.filter((o) => ['new', 'accepted'].includes(o.status) && (!sym || o.symbol === sym)));
    }
    if (open && /^\/v2\/orders\/[^/]+$/.test(u.pathname)) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      const o = open.find((x) => x.id === id);
      if (!o) return new Response(JSON.stringify({ message: 'order not found' }), { status: 404 });
      if (init.method === 'DELETE') { o.status = 'canceled'; return new Response(null, { status: 204 }); }
      return ok(o);
    }
    if (u.pathname === '/v2/account') return ok({ account_number: 'PA1234', status: 'ACTIVE', cash: '1000', buying_power: '2000', equity: '1500', last_equity: '1500' });
    if (u.pathname === '/v2/positions') return ok([]);
    if (u.pathname === '/v2/orders' && (init.method || 'GET') === 'GET') return ok([
      { id: 'o-lim-0001', symbol: 'AAPL', side: 'buy', qty: '2', type: 'limit', limit_price: '200', status: 'new', submitted_at: '2026-10-20T14:40:00Z' },
      { id: 'o-fil-0001', symbol: 'AAPL', side: 'buy', qty: '1', type: 'market', status: 'filled', filled_qty: '1', filled_avg_price: '201', submitted_at: '2026-10-20T14:30:00Z', filled_at: '2026-10-20T14:30:01Z' },
    ]);
    if (u.pathname === '/v2/account/activities/FILL') return ok([{ id: 'f-1', order_id: 'o-fil-0001', symbol: 'AAPL', side: 'buy', qty: '1', price: '201', transaction_time: '2026-10-20T14:30:01Z', type: 'fill' }]);
    if (u.pathname === '/v2/account/portfolio/history') return ok({ timestamp: [], equity: [] });
    if (/\/bars$/.test(u.pathname)) return ok({ bars: [{ t: '2026-10-20T14:50:00Z', o: 200, h: 202, l: 199, c: 201, v: 10 }, { t: lastBar, o: 201, h: 203, l: 200, c: 202, v: 12 }] });
    if (/\/trades\/latest$/.test(u.pathname)) return ok({ trade: { p: 202.5, t: '2026-10-20T14:59:00Z' } });
    if (/^\/v2\/orders\/o-lim-0001$/.test(u.pathname) && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (/^\/v2\/orders\/o-lim-0001$/.test(u.pathname)) return ok({ id: 'o-lim-0001', symbol: 'AAPL', side: 'buy', qty: '2', type: 'limit', limit_price: '200', status: 'canceled' });
    return new Response('{}', { status: 404 });
  };
}

test('markers keep every source apart and show each record once', () => {
  const journal = [{ portfolio: 'ema|any', symbol: 'MNQ', strategy: 'ema-pullback-5m', filter: 'any', side: 'long', entry: { time: '2026-10-20T14:05:00Z', raw: 21400 }, exit: { time: '2026-10-20T14:20:00Z', raw: 21420, reason: 'target' }, net_pnl: 38, stop: 21390, target: 21420 }];
  const sim = [{ id: 'ema|MNQ|t1', strategy: 'ema', symbol: 'MNQ', entry_t: '2026-10-20T14:05:00Z', entry_raw: 21400, exit_t: '2026-10-20T14:25:00Z', exit_raw: 21410, exit_reason: 'target' }];
  const markers = chartMarkers({ journal: [...journal, ...journal], simTrades: [...sim, ...sim], symbol: 'MNQ' });
  assert.equal(markers.filter((m) => m.source === 'che_forward').length, 2, 'entry and exit, once each');
  assert.equal(markers.filter((m) => m.source === 'che_sim').length, 2, 'the simulation trade at the same minute and price stays a separate source');
  assert.ok(markers.every((m) => m.time && m.price != null && m.source));
  const exit = markers.find((m) => m.source === 'che_forward' && m.kind === 'exit');
  assert.equal(exit.net_pnl, 38);
  assert.equal(exit.strategy, 'ema-pullback-5m');
  const broker = chartMarkers({ orders: [{ id: 'o1', symbol: 'AAPL', side: 'buy', limit_price: 200, status: 'new', status_group: 'submitted', submitted_at: 't1' }, { id: 'o2', symbol: 'AAPL', side: 'buy', status: 'filled', status_group: 'filled', submitted_at: 't0' }],
    fills: [{ id: 'f1', order_id: 'o2', symbol: 'AAPL', side: 'buy', price: 201, qty: 1, time: 't0' }, { id: 'f1', order_id: 'o2', symbol: 'AAPL', side: 'buy', price: 201, qty: 1, time: 't0' }], symbol: 'AAPL' });
  assert.deepEqual(broker.map((m) => `${m.source}:${m.id}`).sort(), ['alpaca_fill:f1', 'alpaca_order:o1'], 'a filled order is drawn by its fill, a duplicated fill once');
});

test('Alpaca chart: bars at the timeframe asked, feed health, orders and fills as their own markers; old bars block market orders', async () => {
  const calls = [];
  const v = await chartView(memStorage(), ENV, { account: 'alpaca_paper', symbol: 'AAPL', tf: '15m', now: NOW, fetcher: fakeAlpaca({ calls }) });
  assert.equal(v.state, 'verified');
  assert.equal(v.mode, 'PAPER');
  assert.equal(v.live_orders, 'disabled');
  assert.ok(calls.some((c) => /\/v2\/stocks\/AAPL\/bars/.test(c)));
  assert.equal(v.bars.length, 2);
  assert.equal(v.feed.stale, false);
  assert.equal(v.market_orders_allowed, true);
  assert.deepEqual(v.markers.map((m) => m.source).sort(), ['alpaca_fill', 'alpaca_order']);
  const old = await chartView(memStorage(), ENV, { account: 'alpaca_paper', symbol: 'AAPL', tf: '5m', now: NOW, fetcher: fakeAlpaca({ lastBar: '2026-10-19T19:55:00Z' }) });
  assert.equal(old.feed.stale, true);
  assert.equal(old.market_orders_allowed, false);
  assert.match(old.entries_blocked_reason, /market orders are blocked, limit orders queue/);
  const none = await chartView(memStorage(), {}, { account: 'alpaca_paper', symbol: 'AAPL', now: NOW });
  assert.equal(none.state, 'not_configured');
  assert.equal(none.entries_allowed, false);
  assert.deepEqual(none.bars, []);
});

test('futures chart: CHE\'s stored DELAYED bars and records; manual futures orders are refused', async () => {
  const storage = memStorage();
  storage.saved.set('live_paper_feed', { status: 'DELAYED', provider: 'Yahoo', last_bar_time: '2026-10-20T14:50:00Z', bars: [0, 1, 2, 3, 4, 5].map((k) => ({ t: new Date(Date.parse('2026-10-20T14:25:00Z') + k * 300_000).toISOString(), o: 21400, h: 21405, l: 21395, c: 21402, v: 5 })) });
  const v = await chartView(storage, {}, { account: 'futures_paper', tf: '5m', now: NOW });
  assert.equal(v.symbol, 'MNQ');
  assert.equal(v.bars.length, 6);
  assert.equal(v.feed.delayed, true);
  assert.equal(v.entries_allowed, false);
  assert.match(v.entries_blocked_reason, /No futures paper broker is connected/);
  const v15 = await chartView(storage, {}, { account: 'futures_paper', tf: '15m', now: NOW });
  assert.ok(v15.bars.length < 6 && v15.bars.length >= 1, 'built from the 5-minute bars');
  assert.equal(futuresOrderIntent('Buy 1 MNQ at 21,400.').kind, 'futures_order');
  assert.equal(futuresOrderIntent('buy 10 shares of AAPL on alpaca paper'), null);
});

test('drawings: validated, saved per account and symbol, and returned', async () => {
  const storage = memStorage();
  assert.match(drawingProblems([{ kind: 'circle', points: [] }])[0], /kind must be/);
  assert.match(drawingProblems([{ kind: 'line', points: [{ price: 1 }] }])[0], /needs 2 points/);
  const saved = await saveDrawings(storage, 'futures_paper', 'MNQ', [{ kind: 'hline', points: [{ price: 21450 }] }, { kind: 'text', text: 'support', points: [{ price: 21400, time: '2026-10-20T14:00:00Z' }] }]);
  assert.equal(saved.ok, true);
  assert.equal((await readDrawings(storage, 'futures_paper', 'MNQ')).length, 2);
  assert.deepEqual(await readDrawings(storage, 'alpaca_paper', 'MNQ'), [], 'kept apart by account');
});

test('ticket preview: cost against buying power and the owner\'s controls; nothing sent. Cancel reads Alpaca back', async () => {
  const calls = [];
  const p = await previewAlpacaPaperOrder(ENV, { symbol: 'aapl', qty: 3, side: 'buy', type: 'market' }, { fetcher: fakeAlpaca({ calls }) });
  assert.equal(p.ok, true);
  assert.equal(p.account, 'Alpaca PAPER');
  assert.equal(p.estimated_cost, 607.5);
  assert.equal(p.buying_power_after, 1392.5);
  assert.equal(p.blocked, '');
  assert.ok(!calls.some((c) => c.startsWith('POST')), 'a preview sends nothing');
  const stopped = await previewAlpacaPaperOrder(ENV, { symbol: 'AAPL', qty: 3, side: 'buy', type: 'limit', limit_price: 200 }, { fetcher: fakeAlpaca(), problem: async () => 'Emergency Stop is on, so no new paper order was sent.' });
  assert.match(stopped.blocked, /Emergency Stop/);
  const c = await cancelAlpacaPaperOrder(ENV, 'o-lim-0001', { fetcher: fakeAlpaca() });
  assert.equal(c.ok, true);
  assert.equal(c.receipt.status, 'canceled');
});

test('the owner\'s chart words through /api/chat', sqlite, async () => {
  const che = await owner();
  const draw = await che.say('Draw a line at 21,450.');
  assert.equal(draw.route, 'che_trading_chart');
  assert.equal(draw.modelCalls, 0);
  assert.match(draw.reply, /level at 21,450 on the MNQ paper futures chart/);
  assert.equal(draw.done.open_view, 'trading_chart');
  const chart = await che.api('/api/trading/chart?account=futures_paper&tf=5m');
  assert.deepEqual(chart.drawings.map((d) => d.points[0].price), [21450], 'the drawing comes back with the chart');
  // A futures order is money: the owner's gate (#356) holds it first; only after his yes does
  // the chart route answer, and it still sends nothing because no futures paper broker is connected.
  const held = await che.say('Buy 1 MNQ at 21,400.');
  assert.match(JSON.parse(held.raw).reply, /I need your yes/, 'the money gate holds it');
  assert.equal(held.modelCalls, 0);
  const mnq = await che.say('Yes.');
  assert.equal(mnq.route, 'che_trading_chart');
  assert.equal(mnq.done.order_sent, false);
  assert.match(mnq.reply, /no futures paper broker is connected[\s\S]*Nothing was sent/);
  const open = await che.say('Open Alpaca chart.');
  assert.deepEqual(open.done.chart, { section: 'chart', account: 'alpaca_paper', symbol: null, filter: null });
  const ema = await che.say('CHE, show EMA trades.');
  assert.deepEqual(ema.done.chart.filter, { strategy: 'ema' });
  // The strategy learning report (#382) answers it, and the Trading Room opens on STRATEGIES.
  const progress = await che.say('Show strategy progress.');
  assert.equal(progress.route, 'che_trading_live');
  assert.equal(progress.done.open_screen, 'trading_room');
  assert.equal(progress.done.chart.section, 'strategies');
  const alpaca = await che.say('show me my Alpaca trades');
  assert.equal(alpaca.done.open_view, 'alpaca_paper', 'the Alpaca dashboard keeps its route');
  // Side by side (owner, 2026-10-23): the room opens on SIDE BY SIDE by voice, and nothing is sent.
  for (const phrase of ['Open side by side.', 'Show my trades next to CHE\'s.', 'Compare my trade with CHE\'s trade.', 'Open the live order preview.']) {
    const sbs = await che.say(phrase);
    assert.equal(sbs.route, 'che_trading_chart', phrase);
    assert.equal(sbs.done.open_view, 'trading_chart', phrase);
    assert.equal(sbs.done.chart.section, 'compare', phrase);
    assert.equal(sbs.modelCalls, 0, phrase);
    assert.match(sbs.reply, /Live orders stay disabled/, phrase);
  }
  // The CHE PAPER ACCOUNT lives on the phone: the Worker opens it and proposes the change; it never claims the balance changed.
  const bal = await che.say('Set CHE paper balance to 500');
  assert.equal(bal.route, 'che_trading_chart');
  assert.equal(bal.modelCalls, 0);
  assert.equal(bal.done.open_view, 'trading_chart');
  assert.deepEqual(bal.done.chart, { section: 'che_trades' });
  assert.equal(bal.done.paper_balance, 500);
  assert.match(bal.reply, /balance change to \$500\.00 for you to confirm[\s\S]*Nothing changes until you confirm/);
  const pos = await che.say('Show CHE positions');
  assert.equal(pos.route, 'che_trading_chart');
  assert.equal(pos.done.paper_balance, undefined);
  assert.match(pos.reply, /CHE PAPER ACCOUNT positions[\s\S]*simulated account, separate from yours/);
});

test('a market order needs a current Alpaca price; limit orders still queue (Build 1: block entries on a stale feed)', async () => {
  const fresh = fakeAlpaca();
  assert.equal(await marketOrderFeedProblem(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market' }, { fetcher: fresh, now: NOW }), '');
  const later = NOW + 3 * 3600_000; // the latest trade is now three hours old: the market is shut
  assert.match(await marketOrderFeedProblem(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market' }, { fetcher: fresh, now: later }), /market orders are blocked.*181 minutes old.*Use a limit order.*Nothing was sent/);
  assert.equal(await marketOrderFeedProblem(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', limit_price: 200 }, { fetcher: fresh, now: later }), '');
});

// ─── Codex review of #387 ─────────────────────────────────────────────────────────────────────

test('PUT /api/trading/chart/drawings saves through the real Worker, and GET /api/trading/chart returns them', sqlite, async () => {
  const che = await owner();
  await che.say('Hello CHE.');
  const drawings = [{ kind: 'hline', points: [{ price: 21500 }] }, { kind: 'line', points: [{ price: 21400, time: '2026-10-20T14:00:00Z' }, { price: 21450, time: '2026-10-20T14:30:00Z' }] }];
  const put = await che.raw('/api/trading/chart/drawings', 'PUT', { account: 'futures_paper', symbol: 'MNQ', drawings });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.drawings.length, 2);
  const chart = await che.api('/api/trading/chart?account=futures_paper&tf=5m');
  assert.deepEqual(chart.drawings.map((d) => d.kind), ['hline', 'line']);
  assert.deepEqual(chart.drawings[1].points.map((p) => p.price), [21400, 21450]);
  const bad = await che.raw('/api/trading/chart/drawings', 'PUT', { account: 'futures_paper', symbol: 'MNQ', drawings: [{ kind: 'circle', points: [] }] });
  assert.equal(bad.status, 400, 'an invalid body is read and refused, not taken as empty');
  const guest = await che.raw('/api/trading/chart/drawings', 'PUT', { account: 'futures_paper', symbol: 'MNQ', drawings: [] }, '');
  assert.notEqual(guest.status, 200);
  assert.equal((await che.api('/api/trading/chart?account=futures_paper&tf=5m')).drawings.length, 2, 'a guest changes nothing');
});

test('futures never offer 1m: a 1m request answers with the 5-minute bars, labelled 5m', async () => {
  const storage = memStorage();
  storage.saved.set('live_paper_feed', { status: 'DELAYED', provider: 'Yahoo', last_bar_time: '2026-10-20T14:50:00Z', bars: [0, 1, 2].map((k) => ({ t: new Date(Date.parse('2026-10-20T14:40:00Z') + k * 300_000).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 1 })) });
  const v = await chartView(storage, {}, { account: 'futures_paper', tf: '1m', now: NOW });
  assert.equal(v.timeframe, '5m');
  assert.ok(!v.timeframes.includes('1m'));
  assert.deepEqual(v.timeframes, ['5m', '15m', '1h', '1d']);
  assert.equal(v.bars.length, 3);
  const stocks = await chartView(memStorage(), ENV, { account: 'alpaca_paper', symbol: 'AAPL', tf: '1m', now: NOW, fetcher: fakeAlpaca() });
  assert.equal(stocks.timeframe, '1m', 'Alpaca stocks keep 1-minute bars');
  assert.ok(stocks.timeframes.includes('1m'));
});

test('ticket preview fails with Alpaca\'s error when the account or the latest trade cannot be read; a market order is then blocked', async () => {
  const acct = await previewAlpacaPaperOrder(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', limit_price: 200 }, { fetcher: fakeAlpaca({ failAccount: true }) });
  assert.equal(acct.ok, false);
  assert.equal(acct.upstream_error, true);
  assert.match(acct.error, /access key verification failed/);
  assert.match(acct.detail, /account could not be read: access key verification failed/);
  const trade = await previewAlpacaPaperOrder(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market' }, { fetcher: fakeAlpaca({ failTrade: true }) });
  assert.equal(trade.ok, false);
  assert.match(trade.error, /SIP data/);
  assert.match(trade.detail, /latest AAPL price could not be read/);
  const limit = await previewAlpacaPaperOrder(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', limit_price: 200 }, { fetcher: fakeAlpaca({ failTrade: true }) });
  assert.equal(limit.ok, true, 'a limit order is priced by its limit, so a missing trade does not fail it');
  assert.equal(limit.estimated_cost, 200);
  assert.match(await marketOrderFeedProblem(ENV, { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market' }, { fetcher: fakeAlpaca({ failTrade: true }), now: NOW }), /market orders are blocked: .*could not be read.*Nothing was sent/);
});

const OPEN_ORDERS = () => [
  { id: 'o-aapl-0001', symbol: 'AAPL', side: 'buy', qty: '2', type: 'limit', limit_price: '109', status: 'new', submitted_at: '2026-10-20T14:40:00Z' },
  { id: 'o-msft-0001', symbol: 'MSFT', side: 'sell', qty: '1', type: 'limit', limit_price: '420', status: 'accepted', submitted_at: '2026-10-20T14:41:00Z' },
];

test('cancel endpoint: without confirm it sends nothing and answers 409 with the open order; with confirm it cancels', sqlite, async () => {
  const che = await owner({ env: ENV });
  await che.say('Hello CHE.');
  const open = OPEN_ORDERS();
  const calls = [];
  const prior = globalThis.fetch;
  globalThis.fetch = fakeAlpaca({ open, calls });
  try {
    const ask = await che.raw('/api/trading/alpaca/order/cancel', 'POST', { id: 'o-aapl-0001' });
    assert.equal(ask.status, 409);
    const body = await ask.json();
    assert.equal(body.ok, false);
    assert.equal(body.needs_confirmation, true);
    assert.equal(body.order.id, 'o-aapl-0001');
    assert.equal(body.order.symbol, 'AAPL');
    assert.equal(body.order.status, 'new');
    assert.equal(body.detail, 'Cancel BUY 2 AAPL limit 109? Say yes to cancel; nothing was cancelled.');
    assert.ok(!calls.some((c) => c.startsWith('DELETE')), 'nothing was sent to Alpaca');
    const no = await che.raw('/api/trading/alpaca/order/cancel', 'POST', { id: 'o-aapl-0001', confirm: 'yes' });
    assert.equal(no.status, 409, 'only confirm: true confirms');
    assert.ok(!calls.some((c) => c.startsWith('DELETE')));
    const done = await (await che.raw('/api/trading/alpaca/order/cancel', 'POST', { id: 'o-aapl-0001', confirm: true })).json();
    assert.equal(done.ok, true);
    assert.equal(done.receipt.status, 'canceled');
    assert.ok(calls.includes('DELETE /v2/orders/o-aapl-0001'));
    const gone = await che.raw('/api/trading/alpaca/order/cancel', 'POST', { id: 'o-aapl-0001' });
    assert.equal(gone.status, 400, 'an order no longer open is not offered for cancelling');
    assert.match((await gone.json()).detail, /as canceled, so there is nothing open to cancel/);
  } finally { globalThis.fetch = prior; }
  const direct = await cancelConfirmation(ENV, 'o-msft-0001', { fetcher: fakeAlpaca({ open: OPEN_ORDERS() }) });
  assert.equal(direct.detail, 'Cancel SELL 1 MSFT limit 420? Say yes to cancel; nothing was cancelled.');
});

test('cancel words: only an order cancel that names a stock, Alpaca, paper or stock', () => {
  assert.deepEqual(cancelOrderIntent('Cancel my AAPL order.'), { kind: 'cancel_order', symbol: 'AAPL' });
  assert.deepEqual(cancelOrderIntent('cancel the open Alpaca order'), { kind: 'cancel_order', symbol: '' });
  assert.deepEqual(cancelOrderIntent('CHE, cancel my paper order'), { kind: 'cancel_order', symbol: '' });
  assert.equal(cancelOrderIntent('cancel my pizza order'), null);
  assert.equal(cancelOrderIntent('cancel my Amazon order'), null);
  assert.equal(cancelOrderIntent('cancel the meeting'), null);
  assert.equal(cancelOrderIntent('cancel my AAPL order and delete my notes'), null, 'only a whole sentence that is one cancel');
});

test('cancel by voice through /api/chat: one match is read back and cancelled on yes; several are listed and nothing is cancelled; a guest is refused', sqlite, async () => {
  const che = await owner({ env: ENV });
  await che.say('Hello CHE.');
  const open = OPEN_ORDERS();
  const calls = [];
  const prior = globalThis.fetch;
  globalThis.fetch = fakeAlpaca({ open, calls });
  const deletes = () => calls.filter((c) => c.startsWith('DELETE'));
  try {
    // Several matches: a numbered list, nothing cancelled.
    const many = await che.say('Cancel my paper order.');
    assert.equal(many.route, 'che_trading_chart');
    assert.equal(many.modelCalls, 0);
    assert.match(many.reply, /2 open PAPER orders, sir: 1\. BUY 2 AAPL limit 109\. 2\. SELL 1 MSFT limit 420\. Which one should I cancel\? Say its number\. Nothing was cancelled\./);
    assert.equal(many.done.order_cancelled, false);
    assert.deepEqual(deletes(), []);
    // Anything else drops the list; a later yes cancels nothing.
    await che.say('Draw a line at 21,450.');
    const stray = await che.say('Yes.');
    assert.notEqual(stray.done.order_cancelled, true);
    assert.deepEqual(deletes(), [], 'a yes after another turn cancels nothing');
    // One match: read back and held for yes; "no" leaves it open.
    const one = await che.say('Cancel my AAPL order.');
    assert.equal(one.route, 'che_trading_chart');
    assert.equal(one.modelCalls, 0);
    assert.equal(one.reply, 'Cancel BUY 2 AAPL limit 109? Say yes to cancel.');
    assert.equal(one.done.needs_confirmation, true);
    assert.deepEqual(deletes(), [], 'the gate did not swallow it and nothing was cancelled yet');
    const kept = await che.say('No.');
    assert.match(kept.reply, /Nothing was cancelled/);
    assert.deepEqual(deletes(), []);
    await che.say('Cancel my AAPL order.');
    const yes = await che.say('Yes.');
    assert.equal(yes.route, 'che_trading_chart');
    assert.equal(yes.modelCalls, 0);
    assert.equal(yes.done.order_cancelled, true);
    assert.equal(yes.reply, 'Cancelled, sir. Alpaca now reports BUY 2 AAPL limit 109 as canceled.');
    assert.deepEqual(deletes(), ['DELETE /v2/orders/o-aapl-0001']);
    // A pick from the list: "number 2" reads that order back; it still waits for yes.
    open.push({ id: 'o-msft-0002', symbol: 'MSFT', side: 'buy', qty: '3', type: 'limit', limit_price: '400', status: 'new', submitted_at: '2026-10-20T14:42:00Z' });
    const two = await che.say('Cancel the open Alpaca order.');
    assert.match(two.reply, /1\. SELL 1 MSFT limit 420\. 2\. BUY 3 MSFT limit 400\./);
    const picked = await che.say('Number 2.');
    assert.equal(picked.reply, 'Cancel BUY 3 MSFT limit 400? Say yes to cancel.');
    assert.equal(deletes().length, 1, 'a pick alone cancels nothing');
    const none = await che.say('Cancel my TSLA order.');
    assert.match(none.reply, /no open PAPER order for TSLA.*Nothing was cancelled/);
    // A guest is refused and nothing is sent.
    const guest = await che.guest('Cancel my MSFT order.');
    assert.match(guest.reply, /Only the CHE owner can cancel Alpaca PAPER orders\. Nothing was cancelled\./);
    assert.equal(deletes().length, 1);
  } finally { globalThis.fetch = prior; }
});

test('POST /api/trading/rithmic/candles stores the iPhone\'s closed Rithmic minutes; GET reads them; guests change nothing', sqlite, async () => {
  const che = await owner();
  await che.say('Hello CHE.');
  const t = new Date(Math.floor((Date.now() - 10 * 60000) / 60000) * 60000).toISOString();
  const candle = { t, symbol: 'MNQZ6', exchange: 'CME', o: 21000, h: 21004, l: 20998, c: 21002, v: 9, trades: 5, buy_volume: 5, sell_volume: 4, delta: 1, source: 'rithmic' };
  const post = await che.raw('/api/trading/rithmic/candles', 'POST', { candles: [candle, { ...candle, source: 'yahoo' }] });
  assert.equal(post.status, 200);
  const saved = await post.json();
  assert.deepEqual([saved.stored, saved.refused], [1, 1]);
  const read = await che.api('/api/trading/rithmic/candles?symbol=MNQZ6');
  assert.equal(read.candles.length, 1);
  assert.equal(read.candles[0].source, 'rithmic');
  assert.equal(read.candles[0].delta, 1);
  const guest = await che.raw('/api/trading/rithmic/candles', 'POST', { candles: [{ ...candle, t: new Date(Date.parse(t) + 60000).toISOString() }] }, '');
  assert.notEqual(guest.status, 200);
  assert.equal((await che.api('/api/trading/rithmic/candles?symbol=MNQZ6')).candles.length, 1);
});

test('CHE paper account by voice: opens the phone account; a balance change is only proposed for confirmation', async () => {
  const { paperAccountIntent } = await import('./trading_chart.js');
  assert.deepEqual(paperAccountIntent('Set CHE paper balance to 500'), { kind: 'paper_balance', amount: 500 });
  assert.deepEqual(paperAccountIntent("CHE, change your paper balance to $2,500"), { kind: 'paper_balance', amount: 2500 });
  assert.deepEqual(paperAccountIntent("set che's paper balance to 50k"), { kind: 'paper_balance', amount: 50000 });
  assert.deepEqual(paperAccountIntent('Show CHE positions'), { kind: 'paper_open' });
  assert.deepEqual(paperAccountIntent("open CHE's paper account"), { kind: 'paper_open' });
  for (const other of ['show my Alpaca paper balance', 'set my paper balance to 500', 'show my positions', 'what is CHE', 'open the MNQ chart', 'paper trading is on?']) {
    assert.equal(paperAccountIntent(other), null, other);
  }
});

test('market chart: any universe ticker on public data, honest feed label, research only', async () => {
  const end = Date.parse('2026-10-20T15:00:00Z');
  const fetcher = async (url) => {
    const u = String(url);
    if (u.endsWith('/products')) return new Response(JSON.stringify([{ id: 'ETH-USD', base_currency: 'ETH', quote_currency: 'USD', status: 'online' }]), { status: 200 });
    if (u.includes('AssetPairs')) return new Response(JSON.stringify({ error: [], result: {} }), { status: 200 });
    if (u.includes('/products/ETH-USD/candles?granularity=300')) return new Response(JSON.stringify(Array.from({ length: 20 }, (_, i) => [end / 1000 - (i + 1) * 300, 2990, 3010, 3000, 3005, 4])), { status: 200 });
    throw new TypeError(`unexpected ${u}`);
  };
  const v = await chartView(memStorage(), {}, { account: 'market', symbol: 'COINBASE:ETH-USD', tf: '5m', now: Date.parse('2026-10-20T15:00:20Z'), fetcher });
  assert.equal(v.ok, true);
  assert.equal(v.ticker.id, 'coinbase:ETH-USD');
  assert.equal(v.feed.status, 'LIVE');
  assert.equal(v.feed.stale, false);
  assert.equal(v.bars.length, 20);
  assert.equal(v.spoken, 'Coinbase Exchange ETH-USD, 5m candles, live.');
  assert.equal(v.entries_allowed, false);
  assert.match(v.entries_blocked_reason, /places no orders/);
  assert.ok(v.timeframes.includes('4h') && !v.timeframes.includes('15s'));

  const offline = await chartView(memStorage(), {}, { account: 'market', symbol: 'DOGE', tf: '5m', now: NOW, fetcher: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(offline.ticker.id, 'futures:MNQ', 'an unknown ticker (nothing discovered) falls back to the MNQ default');
  assert.equal(offline.feed.status, 'UNAVAILABLE');
  assert.equal(offline.feed.stale, true);
  assert.ok(offline.universe_problems.length >= 2);
});

test('GET /api/markets/universe and the market chart through the real Worker; guests refused; never LIVE offline', sqlite, async () => {
  const che = await owner();
  await che.say('Hello CHE.');
  const u = await che.api('/api/markets/universe');
  assert.equal(u.ok, true);
  assert.equal(u.counts.futures, 25);
  assert.deepEqual(u.results.slice(0, 4).map((i) => i.id), ['futures:MNQ', 'futures:NQ', 'futures:ES', 'futures:MES']);
  assert.ok(u.problems.some((p) => /Coinbase/.test(p)), 'offline discovery is reported');
  assert.ok(u.intervals.includes('15s'));
  const gold = await che.api('/api/markets/universe?q=gold');
  assert.equal(gold.results[0].id, 'futures:GC');
  const chart = await che.api('/api/trading/chart?account=market&symbol=futures:ES&tf=15m');
  assert.equal(chart.ticker.id, 'futures:ES');
  assert.notEqual(chart.feed.status, 'LIVE');
  assert.equal(chart.entries_allowed, false);
  assert.equal((await che.api('/api/markets/universe')).last_ticker, 'futures:ES', 'the last ticker is remembered');
  const put = await che.raw('/api/trading/chart/drawings', 'PUT', { account: 'market', symbol: 'futures:ES', drawings: [{ kind: 'hline', points: [{ price: 5000 }] }] });
  assert.equal(put.status, 200);
  assert.equal((await che.api('/api/trading/chart?account=market&symbol=futures:ES&tf=15m')).drawings.length, 1);
  assert.notEqual((await che.raw('/api/markets/universe', 'GET', null, '')).status, 200);
});
