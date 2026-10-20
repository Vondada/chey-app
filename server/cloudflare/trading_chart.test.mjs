// The Trading Room chart (owner, 2026-10-20, Build 1): bars and feed health per account and
// timeframe, markers by source (never merged, never duplicated), the entry gate, saved drawings,
// the paper ticket preview and cancel, and the owner's chart words through /api/chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { chartMarkers, chartView, drawingProblems, futuresOrderIntent, readDrawings, saveDrawings } from './trading_chart.js';
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

async function owner({ model = () => 'Here is the answer, sir.' } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', 
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
    return { status: res.status, reply, done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const seedMemory = async (records) => {
    await say('Hello CHE.');
    const data = saved.get('che');
    data.memory_records = [...(data.memory_records || []), ...records];
    saved.set('che', data);
  };
  const api = async (path, method = 'GET', payload) => (await worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env)).json();
  return { say, seedMemory, saved, api };
}



const memStorage = () => { const m = new Map(); return { saved: m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k), list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))) }; };
const ENV = { CHE_ALPACA_PAPER_KEY_ID: 'PKTEST1234', CHE_ALPACA_PAPER_SECRET: 'secret' };
const NOW = Date.parse('2026-10-20T15:00:00Z');
function fakeAlpaca({ lastBar = '2026-10-20T14:55:00Z', calls = [] } = {}) {
  const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method || 'GET'} ${u.pathname}`);
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
  const mnq = await che.say('Buy 1 MNQ at 21,400.');
  assert.equal(mnq.route, 'che_trading_chart');
  assert.equal(mnq.done.order_sent, false);
  assert.match(mnq.reply, /no futures paper broker is connected[\s\S]*Nothing was sent/);
  const open = await che.say('Open Alpaca chart.');
  assert.deepEqual(open.done.chart, { section: 'chart', account: 'alpaca_paper', symbol: null, filter: null });
  const ema = await che.say('CHE, show EMA trades.');
  assert.deepEqual(ema.done.chart.filter, { strategy: 'ema' });
  const progress = await che.say('Show strategy progress.');
  assert.equal(progress.done.chart.section, 'strategies');
  const alpaca = await che.say('show me my Alpaca trades');
  assert.equal(alpaca.done.open_view, 'alpaca_paper', 'the Alpaca dashboard keeps its route');
});
