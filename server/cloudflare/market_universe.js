// Universal market universe for the Trading Room (owner, 2026-10-24): any supported cryptocurrency or
// futures ticker on one chart, with MNQ and NQ staying the defaults.
//
// Providers are modular and each answer says what it really is:
//   coinbase  Coinbase Exchange public candles (spot, no account, no deposit). Primary for crypto.
//             Pairs are discovered from /products, never hardcoded.
//   kraken    Kraken public OHLC. Fallback for crypto when Coinbase does not answer, and its own
//             market when the pair exists only there.
//   yahoo     Yahoo Finance public chart data for CME front months: DELAYED research data, never
//             execution evidence. Which roots exist is a catalog; whether a root has data is
//             only known once Yahoo answers.
//   rithmic   CHE's own 1-minute candles recorded by the owner's iPhone from real Rithmic trades
//             (rithmic_dataset.js). Shown as "recorded", not live.
// A timeframe an exchange does not serve is built only from closed finer bars of the same
// market (2m from 1m, 30m from 15m, 4h from 1h); 15-second and 30-second bars need a trade
// stream no free source offers, so they are reported unavailable, never faked.
import { frontMonth, parseYahooChart } from './market_feed.js';
import { readRithmicCandles } from './rithmic_dataset.js';

export const UNIVERSE_KEY = 'market_universe_v1';
const DISCOVERY_TTL_MS = 6 * 3_600_000;
const HEADERS = { 'User-Agent': 'CHE-TradingRoom/1.0 (public market data; no account)', Accept: 'application/json' };

export const DEFAULT_TICKERS = Object.freeze(['futures:MNQ', 'futures:NQ', 'futures:ES', 'futures:MES', 'coinbase:BTC-USD', 'coinbase:ETH-USD', 'coinbase:DOGE-USD', 'coinbase:SOL-USD']);

// Seconds per bar for each timeframe the chart offers, and where each one comes from per provider.
export const INTERVALS = Object.freeze({
  '15s': 15, '30s': 30, '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400,
});
// Coinbase also serves 21600 (6 hours), which is not 4h: 4h is built from hourly bars instead (see BUILT_FROM).
const COINBASE_NATIVE = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 });
const KRAKEN_NATIVE = Object.freeze({ '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 });
const YAHOO_NATIVE = Object.freeze({ '1m': ['1m', '5d'], '2m': ['2m', '5d'], '5m': ['5m', '5d'], '15m': ['15m', '5d'], '30m': ['30m', '5d'], '1h': ['60m', '30d'], '1d': ['1d', '1y'] });
const BUILT_FROM = Object.freeze({ '2m': '1m', '30m': '15m', '4h': '1h' });
const UNBUILDABLE = Object.freeze({ '15s': 'needs a trade stream; no free public source serves 15-second bars', '30s': 'needs a trade stream; no free public source serves 30-second bars' });

// CME futures the owner asked for. Yahoo's continuous front-month tickers; the exchange is named
// so a contract never looks like spot. Access is "delayed public data" until a licensed feed exists.
export const FUTURES_CATALOG = Object.freeze([
  { root: 'MNQ', name: 'Micro E-mini Nasdaq-100', group: 'Equity index', yahoo: 'MNQ=F', exchange: 'CME', tick: 0.25, pointValue: 2 },
  { root: 'NQ', name: 'E-mini Nasdaq-100', group: 'Equity index', yahoo: 'NQ=F', exchange: 'CME', tick: 0.25, pointValue: 20 },
  { root: 'MES', name: 'Micro E-mini S&P 500', group: 'Equity index', yahoo: 'MES=F', exchange: 'CME', tick: 0.25, pointValue: 5 },
  { root: 'ES', name: 'E-mini S&P 500', group: 'Equity index', yahoo: 'ES=F', exchange: 'CME', tick: 0.25, pointValue: 50 },
  { root: 'MYM', name: 'Micro E-mini Dow', group: 'Equity index', yahoo: 'MYM=F', exchange: 'CBOT', tick: 1, pointValue: 0.5 },
  { root: 'YM', name: 'E-mini Dow', group: 'Equity index', yahoo: 'YM=F', exchange: 'CBOT', tick: 1, pointValue: 5 },
  { root: 'M2K', name: 'Micro E-mini Russell 2000', group: 'Equity index', yahoo: 'M2K=F', exchange: 'CME', tick: 0.1, pointValue: 5 },
  { root: 'RTY', name: 'E-mini Russell 2000', group: 'Equity index', yahoo: 'RTY=F', exchange: 'CME', tick: 0.1, pointValue: 50 },
  { root: 'CL', name: 'Crude Oil', group: 'Energy', yahoo: 'CL=F', exchange: 'NYMEX', tick: 0.01, pointValue: 1000 },
  { root: 'MCL', name: 'Micro Crude Oil', group: 'Energy', yahoo: 'MCL=F', exchange: 'NYMEX', tick: 0.01, pointValue: 100 },
  { root: 'NG', name: 'Natural Gas', group: 'Energy', yahoo: 'NG=F', exchange: 'NYMEX', tick: 0.001, pointValue: 10000 },
  { root: 'GC', name: 'Gold', group: 'Metals', yahoo: 'GC=F', exchange: 'COMEX', tick: 0.1, pointValue: 100 },
  { root: 'MGC', name: 'Micro Gold', group: 'Metals', yahoo: 'MGC=F', exchange: 'COMEX', tick: 0.1, pointValue: 10 },
  { root: 'SI', name: 'Silver', group: 'Metals', yahoo: 'SI=F', exchange: 'COMEX', tick: 0.005, pointValue: 5000 },
  { root: '6E', name: 'Euro FX', group: 'Currencies', yahoo: '6E=F', exchange: 'CME', tick: 0.00005, pointValue: 125000 },
  { root: '6B', name: 'British Pound', group: 'Currencies', yahoo: '6B=F', exchange: 'CME', tick: 0.0001, pointValue: 62500 },
  { root: '6J', name: 'Japanese Yen', group: 'Currencies', yahoo: '6J=F', exchange: 'CME', tick: 0.0000005, pointValue: 12500000 },
  { root: 'BTC', name: 'Bitcoin futures', group: 'Crypto futures', yahoo: 'BTC=F', exchange: 'CME', tick: 5, pointValue: 5 },
  { root: 'MBT', name: 'Micro Bitcoin futures', group: 'Crypto futures', yahoo: 'MBT=F', exchange: 'CME', tick: 5, pointValue: 0.1 },
  { root: 'ETH', name: 'Ether futures', group: 'Crypto futures', yahoo: 'ETH=F', exchange: 'CME', tick: 0.5, pointValue: 50 },
  { root: 'MET', name: 'Micro Ether futures', group: 'Crypto futures', yahoo: 'MET=F', exchange: 'CME', tick: 0.5, pointValue: 0.1 },
  { root: 'ZN', name: '10-Year T-Note', group: 'Rates', yahoo: 'ZN=F', exchange: 'CBOT', tick: 0.015625, pointValue: 1000 },
  { root: 'ZB', name: '30-Year T-Bond', group: 'Rates', yahoo: 'ZB=F', exchange: 'CBOT', tick: 0.03125, pointValue: 1000 },
  { root: 'ZC', name: 'Corn', group: 'Agriculture', yahoo: 'ZC=F', exchange: 'CBOT', tick: 0.25, pointValue: 50 },
  { root: 'ZS', name: 'Soybeans', group: 'Agriculture', yahoo: 'ZS=F', exchange: 'CBOT', tick: 0.25, pointValue: 50 },
]);

// Asset names so "bitcoin" or "shiba" finds the pair; anything else is matched on its ticker.
const COIN_NAMES = Object.freeze({
  BTC: 'Bitcoin', ETH: 'Ethereum', DOGE: 'Dogecoin', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', AVAX: 'Avalanche', LINK: 'Chainlink',
  LTC: 'Litecoin', SHIB: 'Shiba Inu', DOT: 'Polkadot', MATIC: 'Polygon', POL: 'Polygon', BCH: 'Bitcoin Cash', UNI: 'Uniswap', ATOM: 'Cosmos',
  XLM: 'Stellar', ETC: 'Ethereum Classic', NEAR: 'NEAR Protocol', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', PEPE: 'Pepe', SUI: 'Sui',
  HBAR: 'Hedera', FIL: 'Filecoin', AAVE: 'Aave', ALGO: 'Algorand', USDT: 'Tether', USDC: 'USD Coin',
});
const QUOTES = new Set(['USD', 'USDT', 'USDC', 'EUR', 'GBP', 'BTC', 'ETH']);
const KRAKEN_ALIASES = Object.freeze({ XBT: 'BTC', XDG: 'DOGE' });

const iso = (ms) => new Date(ms).toISOString();
const r = (x) => (Number.isFinite(x) ? x : null);

// ─── Discovery ───────────────────────────────────────────────────────────

/** Coinbase Exchange products that trade online, as universe items. */
export function parseCoinbaseProducts(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && p.status === 'online' && !p.trading_disabled && QUOTES.has(String(p.quote_currency || '').toUpperCase()))
    .map((p) => item('coinbase', String(p.id).toUpperCase(), String(p.base_currency).toUpperCase(), String(p.quote_currency).toUpperCase()));
}

/** Kraken asset pairs as universe items; Kraken's XBT/XDG spellings become BTC/DOGE, the provider symbol stays Kraken's. */
export function parseKrakenPairs(result) {
  const out = [];
  for (const [key, p] of Object.entries(result && typeof result === 'object' ? result : {})) {
    if (!p || p.status && p.status !== 'online') continue;
    const ws = String(p.wsname || '');
    const [b, q] = ws.split('/');
    if (!b || !q) continue;
    const base = KRAKEN_ALIASES[b] || b;
    const quote = KRAKEN_ALIASES[q] || q;
    if (!QUOTES.has(quote)) continue;
    out.push({ ...item('kraken', `${base}-${quote}`, base, quote), provider_symbol: p.altname || key, provider_key: key });
  }
  return out;
}

function item(provider, symbol, base, quote) {
  const exchange = provider === 'coinbase' ? 'Coinbase Exchange' : 'Kraken';
  return { id: `${provider}:${symbol}`, provider, symbol, base, quote, name: COIN_NAMES[base] || base, category: 'crypto', exchange, market: `${exchange} spot ${base}/${quote}`, data: 'public exchange candles (no account)' };
}

function futuresItems(now) {
  return FUTURES_CATALOG.map((f) => {
    const fm = frontMonth(f.root, now);
    return { id: `futures:${f.root}`, provider: 'yahoo', symbol: f.root, base: f.root, quote: 'USD', name: f.name, group: f.group, category: 'futures', exchange: f.exchange,
      market: `${f.exchange} ${f.root} continuous front month (research chart)`, contract: fm?.code || null, expires: fm?.expires || null, tick: f.tick, point_value: f.pointValue,
      data: 'Yahoo Finance delayed CME data; not an executable contract until a licensed feed is connected' };
  });
}

/** Discovers crypto pairs (cached in storage for 6 hours) and lists the futures catalog. Discovery failures are reported, never hidden. */
export async function marketUniverse(storage, { fetcher = fetch, now = Date.now(), refresh = false } = {}) {
  let saved = null;
  try { saved = await storage.get(UNIVERSE_KEY); } catch (_) { saved = null; }
  const fresh = saved && !refresh && now - Date.parse(saved.at || 0) < DISCOVERY_TTL_MS;
  let crypto = fresh ? saved.crypto : [];
  const problems = fresh ? saved.problems || [] : [];
  if (!fresh) {
    const cb = await discover(() => fetcher('https://api.exchange.coinbase.com/products', { headers: HEADERS, signal: AbortSignal.timeout(10_000) }), parseCoinbaseProducts);
    const kr = await discover(() => fetcher('https://api.kraken.com/0/public/AssetPairs', { headers: HEADERS, signal: AbortSignal.timeout(10_000) }), (body) => parseKrakenPairs(body?.result));
    if (cb.error) problems.push(`Coinbase products: ${cb.error}`);
    if (kr.error) problems.push(`Kraken pairs: ${kr.error}`);
    // Coinbase first; a Kraken pair is listed as its own market only when Coinbase has no spot pair for the same base and quote.
    const seen = new Set(cb.items.map((i) => `${i.base}-${i.quote}`));
    crypto = [...cb.items, ...kr.items.filter((i) => !seen.has(`${i.base}-${i.quote}`))];
    if (crypto.length || !saved) {
      try { await storage.put(UNIVERSE_KEY, { at: iso(now), crypto, problems }); } catch (_) { /* a read-only storage still answers */ }
    } else if (saved) {
      crypto = saved.crypto; problems.push('kept the last discovered list');
    }
  }
  return { ok: true, discovered_at: fresh ? saved.at : iso(now), crypto, futures: futuresItems(now), problems, defaults: DEFAULT_TICKERS, intervals: Object.keys(INTERVALS) };
}

async function discover(call, parse) {
  try {
    const res = await call();
    if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
    return { items: parse(await res.json()) };
  } catch (error) {
    return { items: [], error: String(error?.name === 'TimeoutError' ? 'no answer within 10 seconds' : error?.message || error).slice(0, 120) };
  }
}

/** Search by ticker or name across crypto and futures; an empty query lists the defaults first. */
export function searchUniverse(universe, query = '', { category = '', limit = 40 } = {}) {
  const q = String(query || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const all = [...universe.futures, ...universe.crypto].filter((i) => !category || i.category === category);
  if (!q) {
    const byId = new Map(all.map((i) => [i.id, i]));
    const defaults = DEFAULT_TICKERS.map((id) => byId.get(id)).filter(Boolean);
    return [...defaults, ...all.filter((i) => !DEFAULT_TICKERS.includes(i.id))].slice(0, limit);
  }
  const score = (i) => {
    const sym = i.symbol.toUpperCase(); const base = i.base.toUpperCase(); const name = String(i.name).toUpperCase();
    if (sym === q || base === q) return 0;
    if (sym.startsWith(q) || base.startsWith(q)) return 1;
    if (name === q) return 2;
    if (name.startsWith(q)) return 3;
    if (sym.includes(q) || name.includes(q)) return 4;
    return null;
  };
  return all.map((i) => [score(i), i]).filter(([s]) => s != null)
    .sort((a, b) => a[0] - b[0] || (a[1].quote === 'USD' ? -1 : 1) - (b[1].quote === 'USD' ? -1 : 1) || a[1].symbol.localeCompare(b[1].symbol))
    .map(([, i]) => i).slice(0, limit);
}

/** "coinbase:BTC-USD", "BTC-USD", "btc", "MNQ", "futures:ES" → a universe item, or null. */
export function resolveTicker(universe, raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  const all = [...universe.futures, ...universe.crypto];
  return all.find((i) => i.id.toUpperCase() === s) || all.find((i) => i.symbol === s) || all.find((i) => i.category === 'crypto' && i.base === s && i.quote === 'USD')
    || all.find((i) => i.category === 'crypto' && i.symbol === `${s}-USD`) || all.find((i) => i.category === 'crypto' && i.base === s) || null;
}

// ─── Candles ─────────────────────────────────────────────────────────────

/** Buckets of `seconds` from closed finer bars. A bucket still forming at `now`, or one whose start is missing from the input, is left out. */
export function buildBars(bars, seconds, now = Date.now()) {
  const size = seconds * 1000;
  const out = [];
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / size) * size;
    const cur = out.at(-1);
    if (cur && cur.start === start) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v = (cur.v || 0) + (b.v || 0); }
    else out.push({ start, partial: t > start, t: iso(start), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
  }
  // Only the oldest bucket can be missing its opening bars (the request window began inside it).
  if (out[0]?.partial) out.shift();
  return out.filter((b) => b.start + size <= now).map(({ start, partial, ...bar }) => bar);
}

const parseCoinbase = (rows, g, now) => (Array.isArray(rows) ? rows : []).filter((x) => Array.isArray(x) && x.length >= 6)
  .map((x) => ({ t: iso(Number(x[0]) * 1000), o: Number(x[3]), h: Number(x[2]), l: Number(x[1]), c: Number(x[4]), v: Number(x[5]) }))
  .filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite) && Date.parse(b.t) + g * 1000 <= now).sort((a, b) => a.t.localeCompare(b.t));

const parseKraken = (body, key, g, now) => {
  const rows = body?.result?.[key] || Object.values(body?.result || {}).find(Array.isArray);
  return (Array.isArray(rows) ? rows : []).map((x) => ({ t: iso(Number(x[0]) * 1000), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[6]) }))
    .filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite) && Date.parse(b.t) + g * 1000 <= now);
};

async function getJson(fetcher, url) {
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** LIVE when the newest closed bucket is present, DELAYED within 30 minutes of it, else DISCONNECTED. */
export function liveness(bars, seconds, now = Date.now()) {
  if (!bars.length) return { status: 'DISCONNECTED', age_s: null, reason: 'no bars were returned' };
  const newest = Date.parse(bars[bars.length - 1].t);
  const closedAt = newest + seconds * 1000;
  const age_s = Math.max(0, Math.round((now - closedAt) / 1000));
  // One bucket of grace: the exchange publishes a bar a few seconds after it closes.
  if (now - closedAt <= seconds * 1000 + 30_000) return { status: 'LIVE', age_s };
  if (now - closedAt <= 30 * 60_000) return { status: 'DELAYED', age_s, reason: 'the newest bars have not been published yet' };
  return { status: 'DISCONNECTED', age_s, reason: `the newest bar closed ${Math.round(age_s / 60)} minutes ago` };
}

async function cryptoBars(item, tf, { fetcher, now }) {
  const seconds = INTERVALS[tf];
  const source = BUILT_FROM[tf] && !(item.provider === 'kraken' && KRAKEN_NATIVE[tf]) ? BUILT_FROM[tf] : tf;
  const attempts = [];
  const tryCoinbase = async (sym) => {
    const g = COINBASE_NATIVE[source];
    if (!g) throw new Error(`Coinbase has no ${source} candles`);
    const rows = await getJson(fetcher, `https://api.exchange.coinbase.com/products/${sym}/candles?granularity=${g}`);
    if (!Array.isArray(rows)) throw new Error(String(rows?.message || 'unexpected shape').slice(0, 80));
    return { bars: parseCoinbase(rows, g, now), provider: 'Coinbase Exchange', exchange: 'Coinbase Exchange' };
  };
  const tryKraken = async (sym, key) => {
    const m = KRAKEN_NATIVE[source];
    if (!m) throw new Error(`Kraken has no ${source} candles`);
    const body = await getJson(fetcher, `https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=${m}`);
    if (body?.error?.length) throw new Error(String(body.error[0]).slice(0, 80));
    return { bars: parseKraken(body, key, m * 60, now), provider: 'Kraken', exchange: 'Kraken' };
  };
  const order = item.provider === 'kraken'
    ? [['kraken', () => tryKraken(item.provider_symbol || item.symbol.replace('-', ''), item.provider_key)]]
    : [['coinbase', () => tryCoinbase(item.symbol)], ['kraken', () => tryKraken(`${KRAKEN_SPELL[item.base] || item.base}${item.quote}`, null)]];
  for (const [name, call] of order) {
    try {
      const got = await call();
      const bars = source === tf ? got.bars : buildBars(got.bars, seconds, now);
      return { ...got, bars, built_from: source === tf ? null : source, fallback: name === 'kraken' && item.provider === 'coinbase', attempts };
    } catch (error) {
      attempts.push(`${name}: ${String(error?.message || error).slice(0, 100)}`);
    }
  }
  return { bars: [], provider: item.exchange, exchange: item.exchange, attempts, error: attempts.join('; ') };
}
const KRAKEN_SPELL = Object.freeze({ BTC: 'XBT', DOGE: 'XDG' });

/** Closed spot candles for one coin against USD, Coinbase first then Kraken, for the strategy simulation and the lab. */
export async function cryptoSpotCandles(base, tf = '1m', { quote = 'USD', fetcher = fetch, now = Date.now() } = {}) {
  const b = String(base || '').toUpperCase(); const q = String(quote || 'USD').toUpperCase();
  const got = await cryptoBars(item('coinbase', `${b}-${q}`, b, q), tf, { fetcher, now });
  if (got.error) return { error: got.error, attempts: got.attempts };
  return { candles: got.bars, status: liveness(got.bars, INTERVALS[tf], now).status, source: `${got.provider} ${b}-${q} ${tf} candles (public, no account)`, provider: got.provider, fallback: got.fallback };
}

async function futuresBars(item, tf, { storage, fetcher, now }) {
  const spec = FUTURES_CATALOG.find((f) => f.root === item.symbol);
  const [interval, range] = YAHOO_NATIVE[tf] || YAHOO_NATIVE[BUILT_FROM[tf]] || [];
  if (!interval) return { bars: [], provider: 'Yahoo Finance (delayed)', error: `no ${tf} data` };
  const seconds = INTERVALS[tf];
  const srcSeconds = YAHOO_NATIVE[tf] ? seconds : INTERVALS[BUILT_FROM[tf]];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.yahoo)}?interval=${interval}&range=${range}&includePrePost=true`;
  try {
    let res = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0 (CHE paper-trading research)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) res = await fetcher(url.replace('query1.', 'query2.'), { headers: { 'User-Agent': 'Mozilla/5.0 (CHE paper-trading research)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { bars: [], provider: 'Yahoo Finance (delayed)', error: `Yahoo answered HTTP ${res.status}` };
    const parsed = parseYahooChart(await res.json(), now, srcSeconds * 1000);
    if (parsed.error) return { bars: [], provider: 'Yahoo Finance (delayed)', error: parsed.error };
    const bars = YAHOO_NATIVE[tf] ? parsed.candles : buildBars(parsed.candles, seconds, now);
    return { bars, provider: `Yahoo Finance ${spec.yahoo} (delayed)`, exchange: spec.exchange, delayed_by_min: parsed.delayed_by_min, built_from: YAHOO_NATIVE[tf] ? null : BUILT_FROM[tf], delayed: true };
  } catch (error) {
    return { bars: [], provider: 'Yahoo Finance (delayed)', error: String(error?.name === 'TimeoutError' ? 'Yahoo did not answer within 10 seconds' : error?.message || error).slice(0, 120) };
  }
}

/**
 * Candles for one universe item and timeframe, with an honest feed label. Futures prefer CHE's own
 * recorded Rithmic minutes when the phone recorded that root; otherwise Yahoo (DELAYED).
 */
export async function universeCandles(storage, item, tf = '5m', { fetcher = fetch, now = Date.now() } = {}) {
  if (!item) return { ok: false, error: 'Unknown ticker.' };
  if (!INTERVALS[tf]) return { ok: false, error: `Choose a timeframe: ${Object.keys(INTERVALS).join(', ')}.` };
  const seconds = INTERVALS[tf];
  const base = { ok: true, id: item.id, symbol: item.symbol, name: item.name, category: item.category, exchange: item.exchange, market: item.market, timeframe: tf, timeframes: offeredTimeframes(item) };
  if (UNBUILDABLE[tf]) return { ...base, bars: [], feed: { provider: item.exchange, status: 'UNAVAILABLE', reason: UNBUILDABLE[tf] }, entries_allowed: false };
  if (item.category === 'futures') {
    const recorded = item.contract ? await readRithmicCandles(storage, { symbol: item.contract, now }).catch(() => null) : null;
    if (recorded?.ok && Array.isArray(recorded.candles) && recorded.candles.length && seconds >= 60 && seconds <= 3600) {
      const bars = seconds === 60 ? recorded.candles : buildBars(recorded.candles, seconds, now);
      const live = liveness(bars, seconds, now);
      return { ...base, bars, built_from: seconds === 60 ? null : '1m', feed: { provider: 'Rithmic (recorded on the owner\'s iPhone)', status: live.status === 'LIVE' ? 'RECORDED' : live.status, age_s: live.age_s, reason: live.reason || 'CHE\'s own recorded minutes', contract: item.contract } };
    }
    const got = await futuresBars(item, tf, { storage, fetcher, now });
    const live = liveness(got.bars, seconds, now);
    return { ...base, bars: got.bars, built_from: got.built_from || null,
      feed: { provider: got.provider, status: got.error ? 'UNAVAILABLE' : live.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'DELAYED', age_s: live.age_s, delayed_by_min: got.delayed_by_min ?? null, reason: got.error || 'delayed CME data from a public source; research only', contract: item.contract, expires: item.expires } };
  }
  const got = await cryptoBars(item, tf, { fetcher, now });
  const live = liveness(got.bars, seconds, now);
  return { ...base, bars: got.bars, built_from: got.built_from || null, fallback: got.fallback || false,
    feed: { provider: got.provider, exchange: got.exchange, status: got.error ? 'UNAVAILABLE' : live.status, age_s: live.age_s, reason: got.error || live.reason || null, attempts: got.attempts?.length ? got.attempts : undefined } };
}

/** The timeframes a market can really show: nothing below one minute, and only what its source serves or can be built. */
export function offeredTimeframes(item) {
  if (item.category === 'futures') return Object.keys(INTERVALS).filter((tf) => YAHOO_NATIVE[tf] || (BUILT_FROM[tf] && YAHOO_NATIVE[BUILT_FROM[tf]]));
  if (item.provider === 'kraken') return Object.keys(INTERVALS).filter((tf) => KRAKEN_NATIVE[tf] || BUILT_FROM[tf]);
  return Object.keys(INTERVALS).filter((tf) => COINBASE_NATIVE[tf] || BUILT_FROM[tf]);
}

/** One sentence for the voice route and the chart header. */
export function describeFeed(view) {
  if (!view?.ok) return view?.error || 'No chart.';
  const f = view.feed || {};
  const where = view.category === 'futures' ? `${view.exchange} ${view.symbol}${f.contract ? ` (front month ${f.contract})` : ''}` : `${view.exchange} ${view.symbol}`;
  const status = f.status === 'LIVE' ? 'live' : f.status === 'DELAYED' ? `delayed${f.delayed_by_min ? ` about ${f.delayed_by_min} minutes` : ''}` : f.status === 'RECORDED' ? 'recorded on your phone' : f.status === 'DISCONNECTED' ? 'not updating' : 'unavailable';
  return `${where}, ${view.timeframe} candles, ${status}${view.built_from ? ` (built from ${view.built_from} bars)` : ''}${f.reason && f.status === 'UNAVAILABLE' ? `: ${f.reason}` : ''}.`;
}
