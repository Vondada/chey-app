// Intraday NQ / MNQ market data for CHE's forward paper trading (owner, 2026-10-18).
//
// Sources, in order, each labelled with what it really is:
//   LIVE     Tradovate market data with the owner's own sign-in and CME entitlement.
//            Not connected yet: CHE says so and names the owner step.
//   DELAYED  Yahoo Finance's public chart data for the continuous front month (MNQ=F,
//            NQ=F). CME data there is delayed; the delay is measured from the last bar.
//            It is research and paper-trading evidence only, never execution evidence.
//   REPLAY   recorded bars played back, said as replay.
// No price, bar or connection is ever invented: a source that does not answer is
// reported as unavailable with its reason.

export const FEED_ROOTS = Object.freeze({
  MNQ: { yahoo: 'MNQ=F', name: 'Micro E-mini Nasdaq-100' },
  NQ: { yahoo: 'NQ=F', name: 'E-mini Nasdaq-100' },
});
const MONTH_CODES = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

// Third Friday of a month (UTC date), when the quarterly equity index futures expire.
function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + 14));
}

/**
 * The front-month contract by the CME roll calendar: quarterly (H, M, U, Z), rolled
 * eight days before the third-Friday expiry, as CME's equity roll does.
 */
export function frontMonth(root = 'MNQ', now = Date.now()) {
  const d = new Date(now);
  for (let k = 0; k < 6; k++) {
    const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + k * 3) / 12);
    const quarter = Math.ceil((((d.getUTCMonth() + k * 3) % 12) + 1) / 3) * 3;
    const expiry = thirdFriday(y, quarter);
    const roll = new Date(expiry.getTime() - 8 * 86_400_000);
    if (now < roll.getTime()) {
      return { code: `${root}${MONTH_CODES[quarter]}${String(y).slice(-1)}`, month: quarter, year: y, expires: expiry.toISOString().slice(0, 10), rolls: roll.toISOString().slice(0, 10) };
    }
  }
  return null;
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/**
 * CME Globex equity index hours: Sunday 18:00 to Friday 17:00 New York, with a daily
 * break 17:00–18:00. (Exchange holidays are not modelled; a holiday shows as no new bars.)
 */
export function cmeSession(now = Date.now()) {
  const p = ET.formatToParts(new Date(now)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const day = p.weekday;
  if (day === 'Sat') return { open: false, state: 'weekend' };
  if (day === 'Sun') return mins >= 1080 ? { open: true, state: 'open' } : { open: false, state: 'weekend' };
  if (day === 'Fri' && mins >= 1020) return { open: false, state: 'weekend' };
  if (mins >= 1020 && mins < 1080) return { open: false, state: 'daily break' };
  return { open: true, state: 'open' };
}

/** Yahoo chart JSON → closed 1-minute bars and the provider's own delay. */
export function parseYahooChart(json, now = Date.now(), barMs = 60_000) {
  const result = json?.chart?.result?.[0];
  if (!result) return { error: json?.chart?.error?.description || 'no chart in the answer' };
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const meta = result.meta || {};
  const lastTrade = Number(meta.regularMarketTime) * 1000 || 0;
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i];
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const start = ts[i] * 1000;
    // The newest bar is still forming while the last trade falls inside it: never used.
    if (start + barMs > Math.min(now, lastTrade || now)) continue;
    candles.push({ t: new Date(start).toISOString(), o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number(q.volume?.[i]) || 0 });
  }
  return {
    candles,
    delayed_by_min: Number(meta.exchangeDataDelayedBy) || null,
    last_trade_time: lastTrade ? new Date(lastTrade).toISOString() : null,
    exchange: meta.exchangeName || meta.fullExchangeName || '',
    provider_symbol: meta.symbol || '',
  };
}

/** Closed bars of `minutes` from closed 1-minute bars; a bucket still forming is left out. */
export function aggregate(bars, minutes, now = Date.now()) {
  const size = minutes * 60_000;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = Date.parse(b.t);
    const start = Math.floor(t / size) * size;
    if (!cur || cur.start !== start) {
      if (cur) out.push(cur);
      cur = { start, t: new Date(start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1, last: t, contiguous: true };
    } else {
      cur.contiguous &&= t === cur.last + 60000; cur.last = t;
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.n += 1;
    }
  }
  if (cur) out.push(cur);
  const last = bars.length ? Date.parse(bars[bars.length - 1].t) + 60_000 : 0;
  return out.filter((b) => b.n === minutes && b.contiguous && b.start + size <= Math.min(now, last)).map(({ start, n, last: finalTime, contiguous, ...bar }) => bar);
}

/**
 * Closed 1-minute bars for MNQ or NQ, with the feed's status for the dashboard.
 * Status is DELAYED for Yahoo (CME delayed data), UNAVAILABLE when it did not answer.
 */
export async function loadIntraday(root = 'MNQ', { fetcher = fetch, now = Date.now(), range = '5d', interval = '1m' } = {}) {
  const spec = FEED_ROOTS[root];
  const contract = frontMonth(root, now);
  const base = {
    root, contract: contract?.code || '', contract_detail: contract, provider: 'Yahoo Finance chart (public)',
    provider_symbol: spec?.yahoo || '', session: cmeSession(now), checked_at: new Date(now).toISOString(),
  };
  if (!spec) return { ...base, status: 'UNAVAILABLE', error: `unknown root ${root}` };
  const started = Date.now();
  try {
    const barMs = interval === '5m' ? 300_000 : 60_000;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.yahoo)}?interval=${interval === '5m' ? '5m' : '1m'}&range=${range}&includePrePost=true`;
    const ask = (target) => fetcher(target, { headers: { 'User-Agent': 'Mozilla/5.0 (CHE paper-trading research)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    let res = await ask(url);
    // Yahoo serves the same chart from a second host; one retry there before giving up.
    if (!res.ok) res = await ask(url.replace('query1.', 'query2.'));
    if (!res.ok) return { ...base, status: 'UNAVAILABLE', error: `Yahoo answered HTTP ${res.status}`, fetch_ms: Date.now() - started };
    const parsed = parseYahooChart(await res.json(), now, barMs);
    if (parsed.error) return { ...base, status: 'UNAVAILABLE', error: parsed.error, fetch_ms: Date.now() - started };
    const last = parsed.candles[parsed.candles.length - 1];
    const lagS = last ? Math.round((now - Date.parse(last.t) - barMs) / 1000) : null;
    return {
      ...base,
      status: parsed.candles.length ? 'DELAYED' : 'UNAVAILABLE',
      ...(parsed.candles.length ? {} : { error: 'no closed bars in the answer' }),
      interval: interval === '5m' ? '5m' : '1m',
      candles: parsed.candles,
      last_bar_time: last?.t || null,
      latency_s: lagS,
      delayed_by_min: parsed.delayed_by_min,
      last_trade_time: parsed.last_trade_time,
      exchange: parsed.exchange,
      fetch_ms: Date.now() - started,
      note: 'Delayed CME data from a public source: paper-trading research only, never execution evidence.',
    };
  } catch (error) {
    return { ...base, status: 'UNAVAILABLE', error: String(error?.name === 'TimeoutError' ? 'Yahoo did not answer within 10 seconds' : error?.message || error).slice(0, 160), fetch_ms: Date.now() - started };
  }
}

/** Account prerequisites; a signed-in account alone is never live-delivery evidence. */
export function liveFeedBlocker({ tradovateConnected = false } = {}) {
  return tradovateConnected
    ? 'Tradovate is signed in. Real-time CME entries remain blocked until matching authenticated quote/chart subscriptions and fresh timestamps are verified. Check the feed status and existing CME/API entitlements.'
    : 'LIVE CME data needs your Tradovate (NinjaTrader) sign-in in CHE Connections and a CME real-time market data subscription with API access on that account. Until then prices are DELAYED.';
}

// Outgoing provider socket transport. URLs are fixed by the trusted adapters below,
// credentials stay in their private configuration, and no order operation is exposed.
export async function connectMarketSocket(url) {
  if (!['wss://md.tradovateapi.com/v1/websocket', 'wss://stream.data.alpaca.markets/v2/iex', 'wss://stream.data.alpaca.markets/v2/sip', 'wss://stream.data.alpaca.markets/v2/delayed_sip', 'wss://paper-api.alpaca.markets/stream'].includes(url)) throw new Error('Unsupported market socket');
  const response = await fetch(url.replace('wss:', 'https:'), { headers: { Upgrade: 'websocket' }, redirect: 'manual' });
  if (response.status !== 101 || !response.webSocket) throw new Error('Provider socket upgrade unavailable');
  return response.webSocket;
}

export class ManagedMarketStream {
  #configuration = null;
  constructor({ socketFactory = connectMarketSocket, now = Date.now, onChange = () => {}, wanted = () => true } = {}) {
    Object.assign(this, { socketFactory, now, onChange, wanted });
    this.generation = 0; this.phase = 'DISCONNECTED'; this.retry = 0; this.lastMessage = 0;
  }
  async connect(url, configuration) {
    const fingerprint = JSON.stringify(configuration);
    if (this.#configuration?.fingerprint === fingerprint && this.socket && !this.stopped) return;
    this.stop();
    this.#configuration = { url, value: configuration, fingerprint };
    this.stopped = false;
    await this.reconnect();
  }
  async reconnect() {
    if (this.stopped || !this.wanted()) return;
    const generation = ++this.generation;
    this.phase = 'CONNECTING'; this.error = ''; this.reset();
    try {
      const socket = await this.socketFactory(this.#configuration.url);
      if (generation !== this.generation || this.stopped) { socket.close(); return; }
      this.socket = socket; this.lastMessage = this.now(); this.phase = 'UNVERIFIED';
      let pending = Promise.resolve();
      socket.addEventListener('message', (event) => {
        pending = pending.then(async () => {
          if (generation !== this.generation || this.stopped) return;
          let data = event.data;
          if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
          if (typeof data !== 'string' || data.length > 2000000) return;
          this.lastMessage = this.now();
          try { await this.process(data, this.#configuration.value); }
          catch (_) { this.error = 'Provider sent an invalid market-data frame.'; this.emit({ type: 'connection' }); this.closeTransport(); this.scheduleReconnect(); }
        });
      });
      const lost = () => {
        if (generation !== this.generation || this.stopped) return;
        this.phase = 'DISCONNECTED'; this.emit({ type: 'connection' }); this.closeTransport(); this.scheduleReconnect();
      };
      socket.addEventListener('close', lost); socket.addEventListener('error', lost);
      socket.accept?.(); this.opened(this.#configuration.value);
      this.timer = setInterval(() => {
        if (!this.wanted()) { this.stop(); return; }
        if (this.now() - this.lastMessage > 20000) { lost(); return; }
        this.heartbeat();
      }, 5000);
      this.timer.unref?.();
    } catch (_) {
      if (generation !== this.generation || this.stopped) return;
      this.phase = 'UNAVAILABLE'; this.error = 'Market-data connection failed; no live delivery verified.';
      this.emit({ type: 'connection' }); this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.stopped || this.refused || this.reconnectTimer) return;
    const wait = Math.min(60000, 1000 * 2 ** Math.min(6, this.retry++));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.reconnect(); }, wait);
    this.reconnectTimer.unref?.();
  }
  closeTransport() { clearInterval(this.timer); this.timer = null; const socket = this.socket; this.socket = null; socket?.close(); }
  stop() {
    this.stopped = true; this.generation++; this.phase = 'DISCONNECTED';
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.closeTransport();
  }
  refuse(code) { this.refused = true; this.error = `Provider refused authentication/subscription (${Number(code) || 'unknown status'}). Check existing account permissions; no subscription was purchased.`; this.phase = 'UNAVAILABLE'; this.emit({ type: 'connection' }); this.closeTransport(); }
  send(value) { this.socket?.send(value); }
  opened() {}
  heartbeat() {}
  reset() { this.refused = false; }
  emit(event) { this.onChange({ ...event, provider: this.provider, received_at: new Date(this.now()).toISOString() }); }
}

const validMarketBar = (b) => b && Number.isFinite(Date.parse(b.t)) && [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite)
  && b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c) && b.v >= 0;
export function marketBar(b) { return validMarketBar(b) ? { ...b, t: new Date(b.t).toISOString() } : null; }

/** Tradovate SockJS framing and subscription correlation, per official Market Data Request Reference. */
export class TradovateMarketStream extends ManagedMarketStream {
  provider = 'Tradovate CME';
  async start({ token, root, symbol, contract_id, expires_at }) {
    if (!['MNQ', 'NQ'].includes(root) || !new RegExp(`^${root}[HMUZ]\\d{1,2}$`).test(symbol) || !Number.isSafeInteger(contract_id) || !(expires_at > this.now()) || !token) throw new Error('Verified contract and current Tradovate authorization required');
    this.root = root; this.symbol = symbol; this.contractId = contract_id; this.expiresAt = expires_at;
    await this.connect('wss://md.tradovateapi.com/v1/websocket', { token, root, symbol, contract_id, expires_at });
  }
  reset() { super.reset(); this.authenticated = false; this.quoteAck = false; this.chartIds = []; this.bars = new Map(); this.quote = null; }
  heartbeat() { this.send('[]'); }
  async process(text, config) {
    if (text === 'o') { this.send(`authorize\n1\n\n${config.token}`); return; }
    if (text === 'h') { this.send('[]'); return; }
    if (!text.startsWith('a')) return;
    const messages = JSON.parse(text.slice(1));
    for (let message of messages) {
      if (typeof message === 'string') message = JSON.parse(message);
      if (message?.e === 'shutdown') { this.refuse(429); continue; }
      if (message?.i && (message.s !== 200 || message.d?.errorText)) { this.refuse(message.s); continue; }
      if (message?.i === 1 && message.s === 200) {
        this.authenticated = true; this.retry = 0;
        this.send(`md/subscribeQuote\n2\n\n${JSON.stringify({ symbol: config.symbol })}`);
        this.send(`md/getChart\n3\n\n${JSON.stringify({ symbol: config.symbol, chartDescription: { underlyingType: 'MinuteBar', elementSize: 5, elementSizeUnit: 'UnderlyingUnits', withHistogram: false }, timeRange: { asMuchAsElements: 480 } })}`);
      }
      if (!this.authenticated) continue;
      if (message?.i === 2 && message.s === 200) this.quoteAck = true;
      if (message?.i === 3 && message.s === 200 && Number.isSafeInteger(message.d?.historicalId) && Number.isSafeInteger(message.d?.realtimeId)) this.chartIds = [message.d.historicalId, message.d.realtimeId];
      for (const chart of message.e === 'chart' ? message.d?.charts || [] : []) {
        if (!this.chartIds.includes(chart.id)) continue;
        for (const b of chart.bars || []) {
          const bar = marketBar({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: Number(b.upVolume || 0) + Number(b.downVolume || 0) });
          if (bar && Date.parse(bar.t) % 300000 === 0 && Date.parse(bar.t) + 300000 <= this.now()) this.bars.set(bar.t, bar);
        }
        this.bars = new Map([...this.bars].sort(([a], [b]) => a.localeCompare(b)).slice(-480));
        this.emit({ type: 'bars', root: this.root });
      }
      for (const q of message.e === 'md' ? message.d?.quotes || [] : []) {
        const time = Date.parse(q.timestamp);
        if (q.contractId !== this.contractId || !Number.isFinite(time) || time > this.now() + 5000 || time < (Date.parse(this.quote?.t) || 0)) continue;
        const price = q.entries?.Trade?.price;
        if (Number.isFinite(price)) { this.quote = { t: new Date(time).toISOString(), price }; this.emit({ type: 'quote', root: this.root, symbol: this.symbol, quote: this.quote }); }
      }
    }
  }
  snapshot() {
    const candles = [...(this.bars?.values() || [])]; const lag = this.quote ? this.now() - Date.parse(this.quote.t) : Infinity;
    const verified = this.authenticated && this.quoteAck && this.chartIds?.length === 2 && candles.length && this.phase === 'UNVERIFIED' && !this.error;
    const status = this.error ? 'UNAVAILABLE' : this.stopped || this.phase === 'DISCONNECTED' ? 'DISCONNECTED' : !verified ? 'UNVERIFIED' : this.now() - Date.parse(candles.at(-1)?.t) - 300000 > 90000 || lag > 15000 || this.now() - this.lastMessage > 15000 || this.now() >= this.expiresAt ? 'STALE' : 'LIVE';
    return { status, provider: this.provider, provider_symbol: this.symbol, root: this.root, contract: this.symbol, contract_id: this.contractId,
      interval: '5m', checked_at: new Date(this.now()).toISOString(), last_bar_time: candles.at(-1)?.t || null,
      latency_s: Number.isFinite(lag) ? Math.max(0, Math.round(lag / 1000)) : null,
      entitlement: this.quoteAck ? 'provider accepted the quote subscription; fresh timestamp and chart required' : 'unverified',
      authenticated: Boolean(this.authenticated), subscription_verified: Boolean(verified), quote: this.quote || null, candles,
      error: this.error || null, note: 'CME delivery is live only while the authenticated matching quote/chart subscriptions and timestamps remain valid; this does not authorize orders.' };
  }
}
