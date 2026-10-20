// CHE's Alpaca connection: stock PAPER trading only (owner directive, issue #344).
//
// Every request goes to Alpaca's paper host. This module has no live host, so a key pair can
// only ever reach paper, and a key shaped like a live key (Alpaca live key IDs start with AK,
// paper ones with PK) is refused before any network call. The pair is kept like CHE's engine
// keys: in the Durable Object, never returned to the phone, logged or spoken beyond its last
// four characters. A paper order is a research record with no money at risk; it still needs
// the owner's own request each time, and CHE reports only what Alpaca's receipt says.

import { setStoredKeys, storedKeys } from './resilience.js';

export const ALPACA_PAPER = 'https://paper-api.alpaca.markets';
// Alpaca's market-data host: read only (bars), never orders. The same paper key pair reads it.
export const ALPACA_DATA = 'https://data.alpaca.markets';
export const ALPACA_KEY_ENV = 'CHE_ALPACA_PAPER_KEY_ID';
export const ALPACA_SECRET_ENV = 'CHE_ALPACA_PAPER_SECRET';
const ORDERS = 'alpaca_paper_orders';
const last4 = (value) => String(value || '').slice(-4);

export function alpacaKeys(env) {
  const id = String(env?.[ALPACA_KEY_ENV] || '').trim();
  const secret = String(env?.[ALPACA_SECRET_ENV] || '').trim();
  return id && secret ? { id, secret } : null;
}

export function liveKeyProblem(id) {
  return /^AK/i.test(String(id || '').trim())
    ? 'That is an Alpaca LIVE key (live key IDs start with AK). CHE takes paper keys only, which start with PK, so nothing was saved.'
    : '';
}

// One request to the paper host. The answer says what happened; it never throws.
async function call(keys, path, { method = 'GET', body = null, fetcher = fetch, host = ALPACA_PAPER } = {}) {
  const url = new URL(path, host);
  // Orders go to the paper host only; the data host is read for bars with GET and nothing else.
  if (!(url.origin === ALPACA_PAPER || (url.origin === ALPACA_DATA && method === 'GET'))) return { ok: false, state: 'refused', error: 'CHE sends Alpaca requests to the paper host only.' };
  let response;
  try {
    response = await fetcher(url.toString(), {
      method,
      headers: {
        'APCA-API-KEY-ID': keys.id,
        'APCA-API-SECRET-KEY': keys.secret,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // A redirect would carry the key pair (and an order) to another host, so none is followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { ok: false, unclear: true, state: 'unavailable', error: `Alpaca's paper service did not answer (${String(error?.message || error).slice(0, 80)}).` };
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return { ok: false, state: 'refused', error: 'Alpaca\'s paper service redirected the request elsewhere, so CHE did not follow it.' };
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, status: response.status, data };
  return { ok: false, status: response.status, unclear: response.status >= 500 || response.status === 422, state: response.status === 401 ? 'rejected' : 'unavailable', error: String(data?.message || `Alpaca answered HTTP ${response.status}`).slice(0, 160) };
}

const money = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

function accountSummary(a = {}) {
  return {
    account_last4: last4(a.account_number),
    status: String(a.status || 'unknown'),
    currency: String(a.currency || 'USD'),
    cash: money(a.cash),
    buying_power: money(a.buying_power),
    equity: money(a.equity),
    blocked: Boolean(a.trading_blocked || a.account_blocked),
    // What Alpaca itself says about options on this paper account; CHE never assumes a level.
    options_approved_level: a.options_approved_level ?? null,
    options_trading_level: a.options_trading_level ?? null,
  };
}

/** The connection as Alpaca reports it now: not set up, verified, rejected or unavailable. */
export async function alpacaStatus(env, { fetcher = fetch } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { provider: 'alpaca', mode: 'paper', state: 'not_configured' };
  if (liveKeyProblem(keys.id)) return { provider: 'alpaca', mode: 'paper', state: 'refused', key_last4: last4(keys.id), error: liveKeyProblem(keys.id) };
  const answer = await call(keys, '/v2/account', { fetcher });
  if (!answer.ok) {
    return { provider: 'alpaca', mode: 'paper', state: answer.status === 403 ? 'rejected' : answer.state, key_last4: last4(keys.id), error: answer.error };
  }
  return { provider: 'alpaca', mode: 'paper', state: 'verified', key_last4: last4(keys.id), account: accountSummary(answer.data) };
}

/** Saves a paper key pair only after Alpaca's paper host accepts it. */
export async function saveAlpacaPaperKeys(storage, { key_id, secret } = {}, { fetcher = fetch } = {}) {
  const id = String(key_id || '').trim();
  const pass = String(secret || '').trim();
  if (!/^[A-Za-z0-9]{16,40}$/.test(id) || !/^\S{20,100}$/.test(pass)) {
    return { ok: false, detail: 'That does not look like an Alpaca key ID and secret, sir. Nothing was saved.' };
  }
  const live = liveKeyProblem(id);
  if (live) return { ok: false, detail: live };
  const answer = await call({ id, secret: pass }, '/v2/account', { fetcher });
  if (!answer.ok) {
    const why = answer.status === 401 || answer.status === 403 ? 'Alpaca\'s paper service rejected that key pair' : answer.error;
    return { ok: false, detail: `${why}, so nothing was saved, sir.` };
  }
  await setStoredKeys(storage, { [ALPACA_KEY_ENV]: id, [ALPACA_SECRET_ENV]: pass });
  return { ok: true, key_last4: last4(id), account: accountSummary(answer.data) };
}

/** Removes the stored pair (a Worker secret pair, if any, is not touched). */
export async function removeAlpacaPaperKeys(storage) {
  const keys = await storedKeys(storage);
  const had = Boolean(keys[ALPACA_KEY_ENV] || keys[ALPACA_SECRET_ENV]);
  await setStoredKeys(storage, { [ALPACA_KEY_ENV]: null, [ALPACA_SECRET_ENV]: null });
  return { ok: true, removed: had };
}

function receipt(o = {}) {
  return {
    id: String(o.id || ''),
    client_order_id: String(o.client_order_id || ''),
    symbol: String(o.symbol || ''),
    qty: money(o.qty),
    filled_qty: money(o.filled_qty),
    filled_avg_price: money(o.filled_avg_price),
    side: String(o.side || ''),
    type: String(o.type || o.order_type || ''),
    limit_price: money(o.limit_price),
    status: String(o.status || 'unknown'),
    submitted_at: o.submitted_at || null,
    filled_at: o.filled_at || null,
    environment: 'alpaca_paper',
    money_at_risk: false,
  };
}

/** The newest paper orders, as Alpaca reports them. */
export async function alpacaPaperOrders(env, { limit = 20, fetcher = fetch } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { ok: false, state: 'not_configured', orders: [] };
  const answer = await call(keys, `/v2/orders?status=all&direction=desc&limit=${Math.max(1, Math.min(50, Number(limit) || 20))}`, { fetcher });
  if (!answer.ok) return { ok: false, state: answer.state, error: answer.error, orders: [] };
  return { ok: true, orders: (Array.isArray(answer.data) ? answer.data : []).map(receipt) };
}

/**
 * One paper stock order the owner asked for. The phone's client_order_id makes a repeated tap
 * or a retried request the same order: Alpaca refuses a second order with that id, and CHE
 * refuses it before the network when its own journal already holds it. Option orders are
 * refused here until the owner's paper options level is wired in.
 */
export async function placeAlpacaPaperOrder(env, storage, order = {}, { fetcher = fetch, now = Date.now(), guard = null } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { ok: false, detail: 'Alpaca paper is not set up yet, sir, so no order was sent.' };
  const live = liveKeyProblem(keys.id);
  if (live) return { ok: false, detail: live.replace('so nothing was saved', 'so no order was sent') };
  const symbol = String(order.symbol || '').trim().toUpperCase();
  const qty = Number(order.qty);
  const side = String(order.side || '').toLowerCase();
  const type = String(order.type || 'market').toLowerCase();
  const limit = order.limit_price == null ? null : Number(order.limit_price);
  const clientId = String(order.client_order_id || '').trim();
  if (!/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(symbol)) return { ok: false, detail: 'CHE sends Alpaca paper orders for stock symbols only for now, sir. Nothing was sent.' };
  if (!(Number.isInteger(qty) && qty >= 1 && qty <= 1000)) return { ok: false, detail: 'Choose 1 to 1,000 shares, sir. Nothing was sent.' };
  if (!['buy', 'sell'].includes(side)) return { ok: false, detail: 'Say buy or sell, sir. Nothing was sent.' };
  if (!['market', 'limit'].includes(type)) return { ok: false, detail: 'Use a market or a limit order, sir. Nothing was sent.' };
  if (type === 'limit' && !(limit > 0)) return { ok: false, detail: 'A limit order needs its limit price, sir. Nothing was sent.' };
  if (!/^[A-Za-z0-9-]{8,48}$/.test(clientId)) return { ok: false, detail: 'This order has no request id, so it could be sent twice. Nothing was sent.' };
  const journal = (await storage.get(ORDERS).catch(() => null)) || [];
  const earlier = journal.find((r) => r.client_order_id === clientId);
  if (earlier) return { ok: true, repeated: true, receipt: earlier };
  // The owner's Strategy Control Center limits (trading_controls.js stockOrderProblem), checked before the network.
  if (guard) {
    const buyingPower = type === 'limit' && side === 'buy' ? money((await call(keys, '/v2/account', { fetcher })).data?.buying_power) : null;
    const problem = await guard({ symbol, qty, side, type, limit_price: limit }, { journal, buyingPower, now });
    if (problem) return { ok: false, blocked: true, detail: problem };
  }
  const answer = await call(keys, '/v2/orders', {
    method: 'POST',
    fetcher,
    body: { symbol, qty: String(qty), side, type, time_in_force: 'day', client_order_id: clientId, ...(type === 'limit' ? { limit_price: String(limit) } : {}) },
  });
  if (!answer.ok && answer.unclear) {
    // No answer, a server error or "that request id is taken": the order may exist, so CHE asks
    // Alpaca for it by its request id and reports only what Alpaca says.
    const found = await call(keys, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`, { fetcher });
    if (found.ok && found.data?.id) {
      const made = { ...receipt(found.data), recorded_at: new Date(now).toISOString() };
      await storage.put(ORDERS, [...journal, made].slice(-50));
      return { ok: true, receipt: made, confirmed_after_error: true };
    }
    if (found.status === 404) return { ok: false, detail: `Alpaca's paper service did not accept the order: ${answer.error}. Alpaca has no order with this request id, so nothing was placed, sir.` };
    return { ok: false, unclear: true, detail: `I cannot confirm whether Alpaca placed that paper order, sir (${answer.error}). I will not send it again; ask me for your Alpaca paper orders to check.` };
  }
  if (!answer.ok) return { ok: false, detail: `Alpaca's paper service did not accept the order: ${answer.error}. Nothing was placed, sir.` };
  const made = { ...receipt(answer.data), recorded_at: new Date(now).toISOString() };
  await storage.put(ORDERS, [...journal, made].slice(-50));
  return { ok: true, receipt: made };
}

/**
 * Emergency Stop on the paper account: cancel every order Alpaca still holds open (not filled), one
 * DELETE per order, and report what Alpaca confirmed and which positions remain open. Nothing is
 * placed. Flatten (owner-confirmed) also asks Alpaca to close every paper position.
 */
export async function haltAlpacaPaper(env, { flatten = false, fetcher = fetch } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { state: 'not_configured', cancelled: [], failed: [], positions: [], closed: [] };
  if (liveKeyProblem(keys.id)) return { state: 'refused', cancelled: [], failed: [], positions: [], closed: [] };
  const open = await call(keys, '/v2/orders?status=open&limit=100', { fetcher });
  if (!open.ok) return { state: open.state, error: open.error, cancelled: [], failed: [], positions: [], closed: [] };
  const cancelled = []; const failed = [];
  for (const o of Array.isArray(open.data) ? open.data : []) {
    const r = await call(keys, `/v2/orders/${encodeURIComponent(o.id)}`, { method: 'DELETE', fetcher });
    (r.ok ? cancelled : failed).push({ id: String(o.id), symbol: String(o.symbol || ''), side: String(o.side || ''), qty: money(o.qty), ...(r.ok ? {} : { error: r.error }) });
  }
  const closed = [];
  if (flatten) {
    const r = await call(keys, '/v2/positions?cancel_orders=true', { method: 'DELETE', fetcher });
    for (const x of Array.isArray(r.data) ? r.data : []) closed.push({ symbol: String(x.symbol || ''), status: Number(x.status) || null });
    if (!r.ok) failed.push({ id: 'positions', error: r.error });
  }
  const pos = await call(keys, '/v2/positions', { fetcher });
  const positions = (pos.ok && Array.isArray(pos.data) ? pos.data : []).map((x) => ({ symbol: String(x.symbol || ''), qty: money(x.qty), side: String(x.side || ''), unrealized_pl: money(x.unrealized_pl) }));
  return { state: 'verified', cancelled, failed, closed, positions, positions_read: pos.ok };
}

/**
 * What a paper stock order would do, before it is sent: the account it goes to, the estimated
 * cost against buying power (limit price, else the latest trade), and the owner's controls.
 * Nothing is sent.
 */
export async function previewAlpacaPaperOrder(env, order = {}, { fetcher = fetch, problem = null } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { ok: false, detail: 'Alpaca PAPER is not connected.' };
  if (liveKeyProblem(keys.id)) return { ok: false, detail: liveKeyProblem(keys.id) };
  const symbol = String(order.symbol || '').trim().toUpperCase();
  const qty = Number(order.qty);
  const side = String(order.side || '').toLowerCase();
  const type = String(order.type || 'market').toLowerCase();
  const limit = order.limit_price == null ? null : Number(order.limit_price);
  if (!/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(symbol) || !(Number.isInteger(qty) && qty >= 1 && qty <= 1000) || !['buy', 'sell'].includes(side) || !['market', 'limit'].includes(type) || (type === 'limit' && !(limit > 0))) {
    return { ok: false, detail: 'The ticket needs a stock symbol, 1 to 1,000 shares, buy or sell, and a limit price for a limit order.' };
  }
  const [account, trade] = await Promise.all([
    call(keys, '/v2/account', { fetcher }),
    call(keys, `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`, { fetcher, host: ALPACA_DATA }),
  ]);
  const last = money(trade.data?.trade?.p);
  const price = type === 'limit' ? limit : last;
  const buyingPower = money(account.data?.buying_power);
  const cost = price == null ? null : Math.round(price * qty * 100) / 100;
  const blocked = problem ? await problem({ symbol, qty, side, type, limit_price: limit }, { buyingPower }) : '';
  return {
    ok: true, account: 'Alpaca PAPER', mode: 'PAPER', money_at_risk: false, symbol, qty, side, type, limit_price: limit,
    last_trade: last, last_trade_time: trade.data?.trade?.t || null, estimated_cost: cost, buying_power: buyingPower,
    buying_power_after: side === 'buy' && cost != null && buyingPower != null ? Math.round((buyingPower - cost) * 100) / 100 : buyingPower,
    blocked: blocked || '', confirm_with: 'yes',
  };
}

/** Cancel one open paper order by its Alpaca id; the answer is Alpaca's record of it afterwards. */
export async function cancelAlpacaPaperOrder(env, orderId, { fetcher = fetch } = {}) {
  const keys = alpacaKeys(env);
  if (!keys) return { ok: false, detail: 'Alpaca PAPER is not connected.' };
  const id = String(orderId || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { ok: false, detail: 'That is not an Alpaca order id.' };
  const del = await call(keys, `/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE', fetcher });
  const after = await call(keys, `/v2/orders/${encodeURIComponent(id)}`, { fetcher });
  const r = after.ok ? receipt(after.data) : null;
  if (!del.ok && !r) return { ok: false, detail: `Alpaca did not cancel it: ${del.error}.` };
  return { ok: del.ok || ['canceled', 'pending_cancel'].includes(r?.status), receipt: r, detail: del.ok ? 'Alpaca accepted the cancel.' : `Alpaca refused the cancel: ${del.error}.` };
}

// ─── The Alpaca PAPER dashboard (owner, 2026-10-20) ────────────────────────────────────────────
// Everything here is read from Alpaca's paper account as Alpaca reports it now: the account, open
// positions, orders in every status, FILL activities and portfolio history, plus 5-minute bars for
// the chart. An execution is drawn only from a FILL activity Alpaca returned; an order that has not
// filled is shown by its status and never as an execution. Read only: nothing here orders.

// Alpaca's order statuses, grouped the way the owner reads them.
export const ORDER_STATUS_GROUPS = Object.freeze({
  submitted: ['pending_new', 'new'],
  accepted: ['accepted', 'accepted_for_bidding', 'calculated', 'pending_replace', 'replaced'],
  partially_filled: ['partially_filled'],
  filled: ['filled'],
  canceled: ['canceled', 'pending_cancel', 'done_for_day', 'stopped', 'suspended'],
  rejected: ['rejected'],
  expired: ['expired'],
});
export function orderStatusGroup(status) {
  const s = String(status || '').toLowerCase();
  for (const [group, list] of Object.entries(ORDER_STATUS_GROUPS)) if (list.includes(s)) return group;
  return 'other';
}
const OPEN_GROUPS = new Set(['submitted', 'accepted', 'partially_filled']);

function positionOf(p = {}) {
  return {
    symbol: String(p.symbol || ''), side: String(p.side || 'long'), qty: money(p.qty),
    avg_entry_price: money(p.avg_entry_price), current_price: money(p.current_price), market_value: money(p.market_value),
    cost_basis: money(p.cost_basis), unrealized_pl: money(p.unrealized_pl), unrealized_plpc: money(p.unrealized_plpc),
    unrealized_intraday_pl: money(p.unrealized_intraday_pl),
  };
}
function fillOf(a = {}) {
  return {
    id: String(a.id || ''), order_id: String(a.order_id || ''), symbol: String(a.symbol || ''), side: String(a.side || ''),
    qty: money(a.qty), price: money(a.price), time: a.transaction_time || null, kind: String(a.type || 'fill'),
    cum_qty: money(a.cum_qty), leaves_qty: money(a.leaves_qty), order_status: String(a.order_status || ''),
  };
}
// Realized P&L from the fills Alpaca returned, first in first out per symbol. Labelled as computed
// from those fills: a position opened before the oldest returned fill is not in it.
export function realizedFromFills(fills) {
  const lots = {}; let realized = 0; let closes = 0; let wins = 0; let losses = 0;
  for (const f of [...fills].filter((x) => x.qty > 0 && x.price > 0).sort((a, b) => String(a.time).localeCompare(String(b.time)))) {
    const book = (lots[f.symbol] ||= []);
    const sign = f.side === 'buy' ? 1 : -1;
    let qty = f.qty;
    while (qty > 0 && book.length && Math.sign(book[0].qty) === -sign) {
      const lot = book[0];
      const take = Math.min(qty, Math.abs(lot.qty));
      const pnl = (f.price - lot.price) * take * (lot.qty > 0 ? 1 : -1);
      realized += pnl; closes += 1; if (pnl > 0) wins += 1; else if (pnl < 0) losses += 1;
      lot.qty += sign * take; qty -= take;
      if (lot.qty === 0) book.shift();
    }
    if (qty > 0) book.push({ qty: sign * qty, price: f.price });
  }
  return { realized_pl: Math.round(realized * 100) / 100, closing_fills: closes, winning_closes: wins, losing_closes: losses };
}

// The chart's timeframes: Alpaca's name for each and how many days back to read.
const BAR_FRAMES = { '1m': ['1Min', 1], '5m': ['5Min', 5], '15m': ['15Min', 10], '1h': ['1Hour', 30], '1d': ['1Day', 365] };

export async function alpacaPaperDashboard(env, { symbol = '', fetcher = fetch, now = Date.now(), timeframe = '5m' } = {}) {
  const keys = alpacaKeys(env);
  const base = { provider: 'alpaca', mode: 'paper', source: 'Alpaca PAPER stock account', fetched_at: new Date(now).toISOString(), money_at_risk: false };
  if (!keys) return { ...base, state: 'not_configured' };
  if (liveKeyProblem(keys.id)) return { ...base, state: 'refused', error: liveKeyProblem(keys.id) };
  const [account, positions, orders, fills, history] = await Promise.all([
    call(keys, '/v2/account', { fetcher }),
    call(keys, '/v2/positions', { fetcher }),
    call(keys, '/v2/orders?status=all&direction=desc&limit=100&nested=true', { fetcher }),
    call(keys, '/v2/account/activities/FILL?direction=desc&page_size=100', { fetcher }),
    call(keys, '/v2/account/portfolio/history?period=1M&timeframe=1D', { fetcher }),
  ]);
  if (!account.ok) return { ...base, state: account.status === 401 || account.status === 403 ? 'rejected' : account.state, error: account.error };
  const orderList = (orders.ok && Array.isArray(orders.data) ? orders.data : []).flatMap((o) => [o, ...(Array.isArray(o.legs) ? o.legs : [])])
    .map((o) => { const r = receipt(o); return { ...r, status_group: orderStatusGroup(r.status), canceled_at: o.canceled_at || null, expired_at: o.expired_at || null, failed_at: o.failed_at || null, stop_price: money(o.stop_price), time_in_force: String(o.time_in_force || '') }; });
  const fillList = (fills.ok && Array.isArray(fills.data) ? fills.data : []).map(fillOf).filter((f) => f.order_id && f.price != null && f.qty > 0);
  const positionList = (positions.ok && Array.isArray(positions.data) ? positions.data : []).map(positionOf);
  const h = history.ok ? history.data || {} : {};
  const curve = (Array.isArray(h.timestamp) ? h.timestamp : []).map((t, i) => ({ t: new Date(Number(t) * 1000).toISOString(), equity: money(h.equity?.[i]), profit_loss: money(h.profit_loss?.[i]) })).filter((p) => p.equity != null);
  const counts = Object.fromEntries([...Object.keys(ORDER_STATUS_GROUPS), 'other'].map((g) => [g, orderList.filter((o) => o.status_group === g).length]));
  // The chart's symbol: the one asked for, else the newest filled or ordered symbol, else an open position.
  const chartSymbol = String(symbol || fillList[0]?.symbol || orderList[0]?.symbol || positionList[0]?.symbol || '').toUpperCase();
  let bars = { ok: false, error: chartSymbol ? '' : 'no symbol to chart yet' };
  if (/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(chartSymbol)) {
    const [frame, days] = BAR_FRAMES[timeframe] || BAR_FRAMES['5m'];
    const start = new Date(now - days * 86400_000).toISOString();
    const got = await call(keys, `/v2/stocks/${encodeURIComponent(chartSymbol)}/bars?timeframe=${frame}&start=${encodeURIComponent(start)}&limit=1000&feed=iex`, { fetcher, host: ALPACA_DATA });
    bars = got.ok ? { ok: true, list: (got.data?.bars || []).map((b) => ({ t: b.t, o: money(b.o), h: money(b.h), l: money(b.l), c: money(b.c), v: money(b.v) })).filter((b) => b.o != null).slice(-240) } : { ok: false, error: got.error };
  }
  const unrealized = positionList.reduce((sum, p) => sum + (p.unrealized_pl || 0), 0);
  const acct = accountSummary(account.data);
  return {
    ...base,
    state: 'verified',
    key_last4: last4(keys.id),
    account: { ...acct, last_equity: money(account.data?.last_equity), portfolio_value: money(account.data?.portfolio_value), long_market_value: money(account.data?.long_market_value), short_market_value: money(account.data?.short_market_value), day_change: acct.equity != null && money(account.data?.last_equity) != null ? Math.round((acct.equity - Number(account.data.last_equity)) * 100) / 100 : null },
    positions: positionList,
    unrealized_pl: Math.round(unrealized * 100) / 100,
    realized: { ...realizedFromFills(fillList), basis: `computed first-in first-out from the ${fillList.length} fill${fillList.length === 1 ? '' : 's'} Alpaca returned; a position opened before the oldest of them is not included` },
    orders: orderList,
    order_counts: counts,
    open_orders: orderList.filter((o) => OPEN_GROUPS.has(o.status_group)).length,
    fills: fillList,
    history: curve,
    chart: { symbol: chartSymbol || null, timeframe: (BAR_FRAMES[timeframe] || BAR_FRAMES['5m'])[0], feed: 'iex', bars: bars.ok ? bars.list : [], error: bars.ok ? null : bars.error || null },
    reads: { positions: positions.ok, orders: orders.ok, fills: fills.ok, history: history.ok, bars: bars.ok },
    separate_from: ['MNQ/NQ futures paper simulations (CHE\'s own engine)', 'Tradovate data'],
  };
}

/** The dashboard said aloud: short, by source, only what Alpaca reported. */
export function speakAlpacaDashboard(d) {
  if (d.state === 'not_configured') return 'Alpaca paper is not set up yet, sir. Add your Alpaca paper keys in Trading Connections and I will show its account, orders and fills.';
  if (d.state !== 'verified') return `I could not read the Alpaca paper account just now, sir (${d.error || d.state}). I show no numbers for it.`;
  const a = d.account;
  const m = (x) => (x == null ? 'unknown' : `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const parts = [`Alpaca PAPER account, read just now: equity ${m(a.equity)}, cash ${m(a.cash)}, buying power ${m(a.buying_power)}.`];
  parts.push(d.positions.length ? `${d.positions.length} open position${d.positions.length === 1 ? '' : 's'}: ${d.positions.slice(0, 5).map((p) => `${p.symbol} ${p.qty} shares, unrealized ${m(p.unrealized_pl)}`).join('; ')}.` : 'No open positions.');
  const c = d.order_counts;
  parts.push(d.orders.length ? `Orders: ${c.filled} filled, ${c.partially_filled} partially filled, ${c.submitted + c.accepted} waiting, ${c.canceled} canceled, ${c.rejected} rejected, ${c.expired} expired.` : 'No orders on this account yet.');
  parts.push(d.fills.length ? `${d.fills.length} fill${d.fills.length === 1 ? '' : 's'} confirmed by Alpaca; realized ${m(d.realized.realized_pl)} from those fills.` : 'No fills confirmed by Alpaca yet.');
  parts.push('This is paper money, separate from CHE\'s MNQ futures paper simulations.');
  return parts.join(' ');
}
