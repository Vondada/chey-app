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

/** The live-data route CHE does not have yet, said plainly for the Trading Room. */
export function liveFeedBlocker({ tradovateConnected = false } = {}) {
  return tradovateConnected
    ? 'Tradovate is signed in, but CHE does not yet read its market data; prices stay DELAYED until that is built and your CME real-time entitlement is confirmed.'
    : 'LIVE CME data needs your Tradovate (NinjaTrader) sign-in in CHE Connections and a CME real-time market data subscription with API access on that account. Until then prices are DELAYED.';
}
