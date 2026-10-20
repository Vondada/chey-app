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
async function call(keys, path, { method = 'GET', body = null, fetcher = fetch } = {}) {
  const url = new URL(path, ALPACA_PAPER);
  if (url.origin !== ALPACA_PAPER) return { ok: false, state: 'refused', error: 'CHE sends Alpaca requests to the paper host only.' };
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
export async function placeAlpacaPaperOrder(env, storage, order = {}, { fetcher = fetch, now = Date.now() } = {}) {
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

// Official market-data endpoints are distinct from the PAPER order host; no live order URL is added.
import { ManagedMarketStream, marketBar } from './market_feed.js';
const STOCK_DATA = 'https://data.alpaca.markets';
export const ALPACA_STOCK_FEEDS = Object.freeze({ iex: 'IEX single-exchange coverage; not consolidated SIP/NBBO', sip: 'Consolidated SIP coverage', delayed_sip: 'SIP delayed by 15 minutes; not real-time' });
const stockSymbol = (s) => /^[A-Z]{1,5}(?:\.[A-Z])?$/.test(s);

export class AlpacaStockStream extends ManagedMarketStream {
  provider = 'Alpaca stock data';
  async start({ keys, symbols, feed = 'iex' }) {
    if (!keys?.id || !keys?.secret || liveKeyProblem(keys.id)) throw new Error('Existing Alpaca PAPER keys required');
    if (!ALPACA_STOCK_FEEDS[feed] || !Array.isArray(symbols) || !symbols.length || symbols.length > 10 || !symbols.every(stockSymbol)) throw new Error('Unsupported symbols or stock data feed');
    this.feed = feed; this.symbols = [...new Set(symbols)].sort();
    await this.connect(`wss://stream.data.alpaca.markets/v2/${feed}`, { keys, symbols: this.symbols, feed });
  }
  reset() { super.reset(); this.authenticated = false; this.subscription = false; this.authSent = false; this.quotes = {}; this.bars = {}; }
  opened(config) { if (!this.authSent) { this.authSent = true; this.send(JSON.stringify({ action: 'auth', key: config.keys.id, secret: config.keys.secret })); } }
  heartbeat() {
    if (this.authenticated && this.now() - (this.lastBeat || 0) >= 15000) {
      this.lastBeat = this.now(); this.send(JSON.stringify({ action: 'subscribe', quotes: this.symbols, bars: this.symbols, updatedBars: this.symbols, trades: this.symbols }));
    }
  }
  async process(text, config) {
    for (const m of JSON.parse(text)) {
      if (m.T === 'error') { this.refuse(m.code); continue; }
      if (m.T === 'success' && m.msg === 'connected') this.opened(config);
      if (m.T === 'success' && m.msg === 'authenticated') {
        this.authenticated = true; this.retry = 0;
        this.send(JSON.stringify({ action: 'subscribe', quotes: config.symbols, bars: config.symbols, updatedBars: config.symbols, trades: config.symbols }));
      }
      if (!this.authenticated) continue;
      if (m.T === 'subscription') this.subscription = config.symbols.every((s) => m.quotes?.includes(s) && m.bars?.includes(s));
      if (!config.symbols.includes(m.S)) continue;
      const time = Date.parse(m.t);
      if (!Number.isFinite(time) || time > this.now() + 5000) continue;
      if (m.T === 'q' && [m.bp, m.ap].every(Number.isFinite) && m.bp <= m.ap && time >= (Date.parse(this.quotes[m.S]?.t) || 0)) {
        this.quotes[m.S] = { t: new Date(time).toISOString(), bid: m.bp, ask: m.ap };
        this.emit({ type: 'quote', symbol: m.S, feed: config.feed, quote: this.quotes[m.S] });
      }
      if (m.T === 'b' || m.T === 'u') {
        const bar = marketBar({ t: m.t, o: m.o, h: m.h, l: m.l, c: m.c, v: m.v });
        if (bar && time % 60000 === 0 && time + 60000 <= this.now()) {
          const bars = new Map((this.bars[m.S] || []).map((b) => [b.t, b])); bars.set(bar.t, bar);
          this.bars[m.S] = [...bars.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-400);
          this.emit({ type: 'bar', symbol: m.S, feed: config.feed, bar });
        }
      }
    }
  }
  snapshot() {
    const oldest = Math.min(...(this.symbols || []).map((s) => Date.parse(this.quotes?.[s]?.t) || 0));
    const verified = this.authenticated && this.subscription && !this.error;
    const status = this.error ? 'UNAVAILABLE' : this.stopped || this.phase === 'DISCONNECTED' ? 'DISCONNECTED' : !verified ? 'UNVERIFIED' : this.feed === 'delayed_sip' ? 'DELAYED' : this.now() - oldest > 15000 || this.now() - this.lastMessage > 15000 ? 'STALE' : 'LIVE';
    return { status, provider: this.provider, feed: this.feed, coverage: ALPACA_STOCK_FEEDS[this.feed],
      authenticated: Boolean(this.authenticated), subscription_verified: Boolean(this.subscription), symbols: this.symbols || [],
      checked_at: new Date(this.now()).toISOString(), quotes: { ...this.quotes }, symbol_status: Object.fromEntries((this.symbols || []).map((s) => [s, this.now() - (Date.parse(this.quotes?.[s]?.t) || 0) > 15000 ? 'STALE' : status])), bars: { ...this.bars }, error: this.error || null };
  }
}

async function stockData(env, path, { fetcher = fetch } = {}) {
  const keys = alpacaKeys(env);
  if (!keys || liveKeyProblem(keys.id)) return { ok: false, state: 'not_configured', error: 'Existing Alpaca PAPER keys are required.' };
  try {
    const url = new URL(path, STOCK_DATA);
    if (url.origin !== STOCK_DATA) return { ok: false, state: 'refused', error: 'Unsupported stock data host.' };
    const response = await fetcher(url.toString(), { headers: { 'APCA-API-KEY-ID': keys.id, 'APCA-API-SECRET-KEY': keys.secret, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, state: response.status === 403 ? 'entitlement_required' : 'unavailable', error: `Alpaca stock data answered HTTP ${response.status}. No paid service was activated.` };
    return { ok: true, data: await response.json() };
  } catch (_) { return { ok: false, state: 'unavailable', error: 'Alpaca stock data could not be verified.' }; }
}

export async function alpacaStockBars(env, { symbol = 'AAPL', feed = 'iex', fetcher = fetch, now = Date.now() } = {}) {
  if (!stockSymbol(symbol) || !ALPACA_STOCK_FEEDS[feed]) return { ok: false, error: 'Unsupported stock symbol/feed.' };
  const start = new Date(now - 7 * 86400000).toISOString();
  const answer = await stockData(env, `/v2/stocks/${encodeURIComponent(symbol)}/bars?feed=${feed}&timeframe=5Min&start=${encodeURIComponent(start)}&limit=400&sort=desc&adjustment=raw`, { fetcher });
  if (!answer.ok) return { ...answer, symbol, feed, coverage: ALPACA_STOCK_FEEDS[feed], bars: [] };
  if (!Array.isArray(answer.data?.bars)) return { ok: false, symbol, feed, error: 'Alpaca returned no valid bar list.', bars: [] };
  const bars = answer.data.bars.map((b) => marketBar({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })).filter((b) => b && Date.parse(b.t) % 300000 === 0 && Date.parse(b.t) + 300000 <= now).sort((a, b) => a.t.localeCompare(b.t));
  return { ok: true, symbol, feed, coverage: ALPACA_STOCK_FEEDS[feed], interval: '5m', bars, checked_at: new Date(now).toISOString(), last_bar: bars.at(-1)?.t || null, status: feed === 'delayed_sip' ? 'DELAYED' : 'HISTORICAL', note: 'Historical candles are not proof of a current live quote.' };
}

export async function alpacaPaperPositions(env, options = {}) {
  const keys = alpacaKeys(env); if (!keys || liveKeyProblem(keys.id)) return { ok: false, state: 'not_configured', positions: [] };
  const answer = await call(keys, '/v2/positions', options);
  if (!answer.ok || !Array.isArray(answer.data)) return { ok: false, state: answer.state || 'unavailable', error: answer.error || 'Invalid broker position list.', positions: [] };
  return { ok: true, environment: 'alpaca_paper', positions: answer.data.map((p) => ({ symbol: p.symbol, qty: money(p.qty), side: p.side, avg_entry_price: money(p.avg_entry_price), current_price: money(p.current_price), market_value: money(p.market_value), unrealized_pl: money(p.unrealized_pl), cost_basis: money(p.cost_basis), strategy: null, attribution: 'not verified by this broker position record' })) };
}

export async function alpacaPaperEquity(env, options = {}) {
  const keys = alpacaKeys(env); if (!keys || liveKeyProblem(keys.id)) return { ok: false, state: 'not_configured', points: [] };
  const answer = await call(keys, '/v2/account/portfolio/history?period=1M&timeframe=1D', options);
  if (!answer.ok || !Array.isArray(answer.data?.timestamp) || !Array.isArray(answer.data?.equity)) return { ok: false, state: answer.state || 'unavailable', points: [] };
  return { ok: true, environment: 'alpaca_paper', points: answer.data.timestamp.map((t, i) => ({ time: Number.isFinite(t) && Number.isFinite(new Date(t * 1000).getTime()) ? new Date(t * 1000).toISOString() : null, equity: money(answer.data.equity[i]), profit_loss: money(answer.data.profit_loss?.[i]) })).filter((p) => p.time && p.equity != null), note: 'Broker account equity includes all strategies and manual activity; it is not a strategy win rate.' };
}

/** Broker-confirmed order/fill changes; a fill is never inferred from a model or quote. */
export class AlpacaOrderStream extends ManagedMarketStream {
  provider = 'Alpaca PAPER trade_updates';
  constructor(options = {}) { super(options); this.onOrder = options.onOrder || (() => {}); }
  async start({ keys }) {
    if (!keys?.id || !keys?.secret || liveKeyProblem(keys.id)) throw new Error('Existing PAPER credentials required');
    await this.connect('wss://paper-api.alpaca.markets/stream', { keys });
  }
  reset() { super.reset(); this.authenticated = false; this.subscription = false; this.lastOrders = new Map(); }
  opened(config) { this.send(JSON.stringify({ action: 'auth', key: config.keys.id, secret: config.keys.secret })); }
  heartbeat() {
    if (this.authenticated) this.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
  }
  async process(text) {
    const messages = JSON.parse(text);
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (m.stream === 'authorization') {
        if (m.data?.status !== 'authorized') { this.refuse(401); continue; }
        this.authenticated = true; this.retry = 0; this.heartbeat();
      }
      if (m.stream === 'listening') this.subscription = m.data?.streams?.includes('trade_updates') === true;
      if (m.stream !== 'trade_updates' || !this.authenticated || !this.subscription) continue;
      const order = m.data?.order;
      if (!order?.id || !stockSymbol(order.symbol) || !['buy', 'sell'].includes(order.side)) { this.emit({ type: 'reconcile_required' }); continue; }
      const qty = money(order.qty); const filled = money(order.filled_qty);
      if (!(qty > 0 && filled >= 0 && filled <= qty) || (order.status === 'filled' && filled !== qty)) { this.emit({ type: 'reconcile_required' }); continue; }
      const eventTime = Date.parse(m.data?.timestamp || order.updated_at || order.filled_at || order.created_at);
      const previous = this.lastOrders.get(order.id);
      if (!Number.isFinite(eventTime) || eventTime > this.now() + 5000 ||
          (previous && (eventTime < previous.time || filled < previous.filled))) {
        this.emit({ type: 'reconcile_required' }); continue;
      }
      this.lastOrders.set(order.id, { time: eventTime, filled });
      if (this.lastOrders.size > 500) this.lastOrders.delete(this.lastOrders.keys().next().value);
      const verified = { ...receipt(order), event_at: new Date(eventTime).toISOString(), observed_at: new Date(this.now()).toISOString(), source: this.provider };
      await this.onOrder(verified);
      this.emit({ type: 'broker_order', order: verified });
    }
  }
  snapshot() { return { provider: this.provider, status: this.error ? 'UNAVAILABLE' : this.stopped ? 'DISCONNECTED' : this.authenticated && this.subscription && this.now() - this.lastMessage <= 20000 ? 'CONNECTED' : 'UNVERIFIED', authenticated: Boolean(this.authenticated), subscription_verified: Boolean(this.subscription), error: this.error || null }; }
}
