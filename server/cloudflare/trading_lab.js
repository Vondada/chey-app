// CHE Trading Lab: the Office crew's real trading desk.
//
// Free data only, no account needed:
//   - Crypto: Binance public candles (live, to the minute).
//   - Stocks, ETFs, indices, forex: Stooq daily history (decades of data,
//     delayed, end-of-day style).
// Everything here is analysis and PAPER trading. No real orders are ever
// placed; real money always needs the owner.
//
// What the crew does with it:
//   - marks swing highs and swing lows (pivots)
//   - spots candlestick patterns (engulfing, hammer, shooting star, doji, inside bar)
//   - finds entry points from three rule-based strategies
//   - backtests each strategy on the full history, split into a training part
//     and an unseen part, and reports honest numbers (sample size, win rate,
//     expectancy in R, max drawdown)
//   - paper-trades the best strategy per symbol, journals every trade, and
//     keeps learning which strategy actually works on which market.

const UA = { 'User-Agent': 'CHE-trading-lab/1.0', Accept: '*/*' };
const cache = new Map();

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  if (!value?.error) cache.set(key, { at: Date.now(), value });
  return value;
}

async function getText(url, fetcher, timeoutMs = 9000) {
  const response = await fetcher(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const NAMES = {
  bitcoin: 'BTCUSDT', btc: 'BTCUSDT', ethereum: 'ETHUSDT', eth: 'ETHUSDT', solana: 'SOLUSDT', sol: 'SOLUSDT',
  xrp: 'XRPUSDT', doge: 'DOGEUSDT', dogecoin: 'DOGEUSDT',
  's&p': '^spx', 'sp500': '^spx', 's&p 500': '^spx', spx: '^spx', nasdaq: '^ndq', dow: '^dji',
  gold: 'xauusd', silver: 'xagusd', oil: 'cl.f', euro: 'eurusd',
};

// "bitcoin", "AAPL", "tesla stock", "spy" → a data source + symbol.
export function resolveSymbol(input) {
  const raw = String(input || '').trim();
  const low = raw.toLowerCase();
  if (NAMES[low]) return route(NAMES[low]);
  if (/^[a-z]{2,10}usdt$/i.test(raw)) return route(raw.toUpperCase());
  if (/^\^[a-z]{2,5}$/i.test(raw) || /^[a-z]{6}$/i.test(raw) && /usd|eur|jpy|gbp/i.test(raw)) return route(low);
  if (/^[a-z]{1,5}$/i.test(raw)) return route(`${low}.us`);
  if (/^[a-z0-9.^]{2,12}$/i.test(raw)) return route(low);
  return null;
}

function route(symbol) {
  return /USDT$/.test(symbol)
    ? { source: 'binance', symbol, label: symbol.replace(/USDT$/, '/USD') }
    : { source: 'stooq', symbol, label: symbol.replace(/\.us$/, '').toUpperCase() };
}

export function parseStooq(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close/i.test(lines[0])) return [];
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { t: date, o: +open, h: +high, l: +low, c: +close, v: +(volume || 0) };
  }).filter((k) => k.t && [k.o, k.h, k.l, k.c].every(Number.isFinite));
}

export function parseBinance(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    t: new Date(Number(r[0])).toISOString(), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
  })).filter((k) => [k.o, k.h, k.l, k.c].every(Number.isFinite));
}

/// Candles for a symbol. interval: '1d' (default), '4h', '1h', '15m' (crypto only for intraday).
export async function loadCandles(input, { interval = '1d', fetcher = fetch } = {}) {
  const sym = typeof input === 'string' ? resolveSymbol(input) : input;
  if (!sym) return { error: 'I did not recognize that symbol.' };
  const ttl = interval === '1d' ? 30 * 60_000 : 60_000;
  return cached(`${sym.source}:${sym.symbol}:${interval}`, ttl, async () => {
    try {
      if (sym.source === 'binance') {
        const text = await getText(`https://api.binance.com/api/v3/klines?symbol=${sym.symbol}&interval=${interval}&limit=1000`, fetcher);
        const candles = parseBinance(JSON.parse(text));
        return candles.length ? { ...sym, interval, candles, live: true, data: 'Binance public candles (live)' } : { ...sym, error: 'No candles returned.' };
      }
      if (interval !== '1d') return { ...sym, error: 'Intraday stock data needs a market data key; daily history is free.' };
      const candles = parseStooq(await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.symbol)}&i=d`, fetcher));
      return candles.length ? { ...sym, interval, candles, live: false, data: 'Stooq daily history (delayed)' } : { ...sym, error: 'No history returned for that symbol.' };
    } catch (_) {
      return { ...sym, error: 'The free data source did not answer. Try again in a minute.' };
    }
  });
}

// ─── Market structure ─────────────────────────────────────────────────────

/// Swing highs/lows: a bar whose high (low) is the highest (lowest) of the
/// `n` bars on each side.
export function swings(candles, n = 3) {
  const highs = [];
  const lows = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      // Ties go to the first bar of a flat top/bottom.
      if (j < i ? candles[j].h >= candles[i].h : candles[j].h > candles[i].h) isHigh = false;
      if (j < i ? candles[j].l <= candles[i].l : candles[j].l < candles[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, t: candles[i].t, price: candles[i].h });
    if (isLow) lows.push({ i, t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

export function trend({ highs, lows }) {
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (!h1 || !h2 || !l1 || !l2) return 'unclear';
  if (h2.price > h1.price && l2.price > l1.price) return 'uptrend (higher highs, higher lows)';
  if (h2.price < h1.price && l2.price < l1.price) return 'downtrend (lower highs, lower lows)';
  return 'range (mixed swings)';
}

/// Candlestick patterns on bar i.
export function patternsAt(candles, i) {
  const k = candles[i];
  const p = candles[i - 1];
  if (!k) return [];
  const body = Math.abs(k.c - k.o);
  const range = k.h - k.l || 1e-9;
  const upper = k.h - Math.max(k.o, k.c);
  const lower = Math.min(k.o, k.c) - k.l;
  const out = [];
  if (body / range < 0.1) out.push('doji');
  if (lower >= 2 * body && upper <= body * 0.6 && body / range > 0.1) out.push('hammer');
  if (upper >= 2 * body && lower <= body * 0.6 && body / range > 0.1) out.push('shooting star');
  if (p) {
    const pBull = p.c > p.o;
    const kBull = k.c > k.o;
    if (!pBull && kBull && k.c >= p.o && k.o <= p.c) out.push('bullish engulfing');
    if (pBull && !kBull && k.o >= p.c && k.c <= p.o) out.push('bearish engulfing');
    if (k.h < p.h && k.l > p.l) out.push('inside bar');
  }
  return out;
}

// Everything the strategies need, computed once per history in one pass, so
// a backtest over decades of bars stays fast. A swing is only "known" once
// its n confirming bars have closed, so there is no look-ahead.
export function prepare(candles, n = 3) {
  const len = candles.length;
  const lastHigh = new Array(len).fill(null);
  const lastLow = new Array(len).fill(null);
  const sma20 = new Array(len).fill(null);
  const sma50 = new Array(len).fill(null);
  const { highs, lows } = swings(candles, n);
  let hi = 0;
  let lo = 0;
  let curHigh = null;
  let curLow = null;
  let s20 = 0;
  let s50 = 0;
  for (let i = 0; i < len; i++) {
    while (hi < highs.length && highs[hi].i + n <= i) curHigh = highs[hi++].price;
    while (lo < lows.length && lows[lo].i + n <= i) curLow = lows[lo++].price;
    lastHigh[i] = curHigh;
    lastLow[i] = curLow;
    s20 += candles[i].c;
    s50 += candles[i].c;
    if (i >= 20) s20 -= candles[i - 20].c;
    if (i >= 50) s50 -= candles[i - 50].c;
    if (i >= 19) sma20[i] = s20 / 20;
    if (i >= 49) sma50[i] = s50 / 50;
  }
  return { lastHigh, lastLow, sma20, sma50 };
}

// ─── Strategies (long-only, rule based, no look-ahead) ───────────────────

export const STRATEGIES = {
  'swing-breakout': {
    name: 'Swing breakout',
    about: 'Buy when price closes above the last swing high; stop under the last swing low; target 2R.',
    entry(candles, i, ctx) {
      const hi = ctx.lastHigh[i];
      const lo = ctx.lastLow[i];
      if (hi == null || lo == null || i < 1) return null;
      const k = candles[i];
      if (!(candles[i - 1].c <= hi && k.c > hi) || lo >= k.c) return null;
      return { entry: k.c, stop: lo, target: k.c + 2 * (k.c - lo), why: `closed above swing high ${round(hi)}` };
    },
  },
  'pullback-reversal': {
    name: 'Pullback reversal',
    about: 'In an uptrend (price above 50-day average), buy a bullish engulfing or hammer near the last swing low; stop under the candle; target 2R.',
    entry(candles, i, ctx) {
      const k = candles[i];
      const slow = ctx.sma50[i];
      const lo = ctx.lastLow[i];
      if (slow == null || k.c < slow || lo == null || i < 1) return null;
      const pats = patternsAt(candles, i);
      if (!pats.includes('bullish engulfing') && !pats.includes('hammer')) return null;
      if (Math.abs(k.l - lo) / lo > 0.03) return null;
      const stop = Math.min(k.l, candles[i - 1].l);
      if (stop >= k.c) return null;
      return { entry: k.c, stop, target: k.c + 2 * (k.c - stop), why: `${pats.join(' + ')} at swing-low support` };
    },
  },
  'trend-cross': {
    name: 'Trend cross',
    about: 'Buy when the 20-day average crosses above the 50-day; stop under the last swing low; target 3R.',
    entry(candles, i, ctx) {
      if (i < 1) return null;
      const f = ctx.sma20[i];
      const s = ctx.sma50[i];
      const pf = ctx.sma20[i - 1];
      const ps = ctx.sma50[i - 1];
      if (f == null || s == null || pf == null || ps == null || !(pf <= ps && f > s)) return null;
      const k = candles[i];
      const lo = ctx.lastLow[i];
      const stop = lo != null && lo < k.c ? lo : k.c * 0.95;
      return { entry: k.c, stop, target: k.c + 3 * (k.c - stop), why: '20-day average crossed above the 50-day' };
    },
  },
};

const round = (x) => (Math.abs(x) >= 100 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000);

// ─── Backtest ─────────────────────────────────────────────────────────────

/// Walks forward bar by bar. One trade at a time. Stop is checked before
/// target inside a bar (the honest, worst-case assumption). Results in R
/// (multiples of the risk taken), so different markets compare fairly.
export function backtest(candles, strategyId, { from = 60, to = candles.length, ctx = prepare(candles) } = {}) {
  const strat = STRATEGIES[strategyId];
  if (!strat) return { error: 'Unknown strategy.' };
  const trades = [];
  let open = null;
  for (let i = Math.max(from, 51); i < to; i++) {
    const k = candles[i];
    if (open) {
      if (k.l <= open.stop) { trades.push({ ...open, exit: open.stop, r: -1, out: k.t }); open = null; }
      else if (k.h >= open.target) { trades.push({ ...open, exit: open.target, r: (open.target - open.entry) / (open.entry - open.stop), out: k.t }); open = null; }
      continue;
    }
    const e = strat.entry(candles, i, ctx);
    if (e) open = { ...e, in: k.t };
  }
  return { strategy: strategyId, ...stats(trades), trades: trades.slice(-20) };
}

export function stats(trades) {
  const n = trades.length;
  if (!n) return { trades_count: 0, win_rate: 0, expectancy_r: 0, total_r: 0, max_drawdown_r: 0, profit_factor: 0 };
  let equity = 0;
  let peak = 0;
  let dd = 0;
  let won = 0;
  let gross = 0;
  let loss = 0;
  for (const t of trades) {
    equity += t.r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    if (t.r > 0) { won++; gross += t.r; } else loss -= t.r;
  }
  return {
    trades_count: n,
    win_rate: Math.round((won / n) * 1000) / 10,
    expectancy_r: Math.round((equity / n) * 100) / 100,
    total_r: Math.round(equity * 100) / 100,
    max_drawdown_r: Math.round(dd * 100) / 100,
    profit_factor: loss ? Math.round((gross / loss) * 100) / 100 : gross ? 99 : 0,
  };
}

/// Every strategy on the full history: first 70% to learn, last 30% unseen.
/// A strategy only "passes" when it also holds up on the unseen part with a
/// real sample size.
export function backtestAll(candles) {
  const split = Math.floor(candles.length * 0.7);
  const ctx = prepare(candles);
  return Object.keys(STRATEGIES).map((id) => {
    const learn = backtest(candles, id, { to: split, ctx });
    const unseen = backtest(candles, id, { from: split, ctx });
    const passes = learn.trades_count >= 20 && unseen.trades_count >= 8 && learn.expectancy_r > 0 && unseen.expectancy_r > 0;
    return { id, name: STRATEGIES[id].name, about: STRATEGIES[id].about, learn, unseen, passes };
  }).sort((a, b) => b.unseen.expectancy_r - a.unseen.expectancy_r);
}

// ─── Live read of a market ────────────────────────────────────────────────

export function analyze(data) {
  const candles = data.candles;
  const last = candles[candles.length - 1];
  const sw = swings(candles, 3);
  const ctx = prepare(candles);
  const signals = Object.entries(STRATEGIES)
    .map(([id, s]) => ({ id, name: s.name, setup: s.entry(candles, candles.length - 1, ctx) }))
    .filter((x) => x.setup);
  return {
    symbol: data.label,
    data: data.data,
    live: data.live,
    as_of: last.t,
    price: last.c,
    trend: trend(sw),
    swing_highs: sw.highs.slice(-3).map((s) => ({ t: s.t, price: round(s.price) })),
    swing_lows: sw.lows.slice(-3).map((s) => ({ t: s.t, price: round(s.price) })),
    patterns: patternsAt(candles, candles.length - 1),
    entries: signals.map((x) => ({ strategy: x.name, entry: round(x.setup.entry), stop: round(x.setup.stop), target: round(x.setup.target), why: x.setup.why })),
  };
}

export function speakAnalysis(a) {
  const lines = [
    `${a.symbol} at ${round(a.price)}${a.live ? ', live' : `, as of ${String(a.as_of).slice(0, 10)}`}.`,
    `Trend: ${a.trend}.`,
  ];
  if (a.swing_highs.length) lines.push(`Last swing high ${a.swing_highs[a.swing_highs.length - 1].price}. Last swing low ${a.swing_lows.length ? a.swing_lows[a.swing_lows.length - 1].price : 'none yet'}.`);
  if (a.patterns.length) lines.push(`Latest candle: ${a.patterns.join(', ')}.`);
  lines.push(a.entries.length
    ? a.entries.map((e) => `Entry (${e.strategy}): ${e.entry}, stop ${e.stop}, target ${e.target}. Why: ${e.why}.`).join(' ')
    : 'No entry from my rules right now. Waiting is a position.');
  return lines.join('\n');
}

export function speakBacktest(label, years, results) {
  const best = results[0];
  const lines = results.map((r) => `- ${r.name}: ${r.unseen.trades_count} unseen trades, ${r.unseen.win_rate}% wins, ${r.unseen.expectancy_r}R per trade, worst drawdown ${r.unseen.max_drawdown_r}R${r.passes ? ' (passes)' : ''}.`);
  return [
    `Backtest on ${label}, about ${years} years of data. Last 30% kept unseen as the real test.`,
    ...lines,
    best?.passes ? `Best so far: ${best.name}. Paper trading only until it proves itself.` : 'None of the strategies passed on unseen data yet. I will not trust them with money.',
  ].join('\n');
}

// ─── Paper trading + learning ─────────────────────────────────────────────

const BOOK = 'trading_paper_book';

export async function readBook(storage) {
  const book = (await storage.get(BOOK)) || {};
  return {
    watch: Array.isArray(book.watch) ? book.watch : ['BTCUSDT', 'ETHUSDT', '^spx'],
    open: Array.isArray(book.open) ? book.open : [],
    closed: Array.isArray(book.closed) ? book.closed : [],
    learned: book.learned && typeof book.learned === 'object' ? book.learned : {},
    last_tick: book.last_tick || null,
  };
}

async function saveBook(storage, book) {
  book.closed = book.closed.slice(-500);
  await storage.put(BOOK, book);
}

export async function watchSymbol(storage, input) {
  const sym = resolveSymbol(input);
  if (!sym) return { error: 'I did not recognize that symbol.' };
  const book = await readBook(storage);
  if (!book.watch.includes(sym.symbol)) book.watch.push(sym.symbol);
  book.watch = book.watch.slice(-15);
  await saveBook(storage, book);
  return { ok: true, symbol: sym.label };
}

/// One paper-trading pass: close trades that hit stop/target, refresh what
/// works per symbol (re-learned from backtests), open new paper trades from
/// the best passing strategy.
export async function paperTick(storage, { fetcher = fetch, force = false } = {}) {
  const book = await readBook(storage);
  if (!force && book.last_tick && Date.now() - Date.parse(book.last_tick) < 55 * 60_000) return book;
  book.last_tick = new Date().toISOString();
  for (const symbol of book.watch) {
    const data = await loadCandles(symbol, { fetcher });
    if (data.error || data.candles.length < 120) continue;
    const candles = data.candles;
    const last = candles[candles.length - 1];
    for (const t of book.open.filter((x) => x.symbol === symbol)) {
      const after = candles.filter((k) => k.t > t.opened_bar);
      for (const k of after) {
        if (k.l <= t.stop) { Object.assign(t, { exit: t.stop, r: -1, closed_at: k.t }); break; }
        if (k.h >= t.target) { Object.assign(t, { exit: t.target, r: round((t.target - t.entry) / (t.entry - t.stop)), closed_at: k.t }); break; }
      }
    }
    const done = book.open.filter((x) => x.closed_at);
    book.closed.push(...done);
    book.open = book.open.filter((x) => !x.closed_at);
    const learnedAt = book.learned[symbol]?.at;
    if (!learnedAt || Date.now() - Date.parse(learnedAt) > 7 * 86400000) {
      const results = backtestAll(candles);
      book.learned[symbol] = { at: new Date().toISOString(), best: results.find((r) => r.passes)?.id || null, results: results.map((r) => ({ id: r.id, passes: r.passes, unseen: r.unseen })) };
    }
    // Live results count too: a strategy losing 5 paper trades in a row on
    // this symbol is benched until the next re-learn.
    const best = book.learned[symbol].best;
    const recent = book.closed.filter((x) => x.symbol === symbol && x.strategy === best).slice(-5);
    const benched = recent.length === 5 && recent.every((x) => x.r < 0);
    if (!best || benched || book.open.some((x) => x.symbol === symbol)) continue;
    const setup = STRATEGIES[best].entry(candles, candles.length - 1, prepare(candles));
    if (setup) {
      book.open.push({ id: crypto.randomUUID(), symbol, label: data.label, strategy: best, ...setup, entry: round(setup.entry), stop: round(setup.stop), target: round(setup.target), opened_at: new Date().toISOString(), opened_bar: last.t });
    }
  }
  await saveBook(storage, book);
  return book;
}

export function speakBook(book) {
  const s = stats(book.closed);
  const open = book.open.map((t) => `${t.label} (${STRATEGIES[t.strategy]?.name || t.strategy}) from ${t.entry}, stop ${t.stop}, target ${t.target}`);
  return [
    `Paper trading, no real money. Watching ${book.watch.length} markets.`,
    s.trades_count
      ? `${s.trades_count} closed trades: ${s.win_rate}% wins, ${s.total_r}R total, ${s.expectancy_r}R per trade, worst drawdown ${s.max_drawdown_r}R.`
      : 'No closed paper trades yet.',
    open.length ? `Open: ${open.join('; ')}.` : 'No open trades right now.',
  ].join('\n');
}

// ─── Voice intents ────────────────────────────────────────────────────────

const SYMBOL_HINT = /\b(?:on|for|of|in|trade|scan|backtest|analy[sz]e|watch)\s+(?:the\s+)?([a-z^&][a-z0-9.^& ]{0,14}?)(?=[\s?.!,]|$)/i;

export function tradingIntent(message) {
  const text = String(message || '').trim();
  if (/\bhow(?:'s| is| are)\b[\s\S]{0,20}\b(?:trades?|trading|paper)\b|\b(?:trading|paper) (?:report|summary|journal)\b/i.test(text)) return { kind: 'book' };
  const pick = () => {
    const m = SYMBOL_HINT.exec(text.replace(/\b(?:swing (?:highs?|lows?)|entry points?|entries|candles?|patterns?|the chart)\b/gi, ' '));
    return m ? m[1].trim() : '';
  };
  if (/\bbacktest/i.test(text) && !/\b(?:code|app|feature|function)\b/i.test(text)) return { kind: 'backtest', symbol: pick() || 'BTCUSDT' };
  if (/\b(?:paper trade|watch)\b[\s\S]{0,30}/i.test(text) && /\b(?:paper|trade|market)\b/i.test(text)) return { kind: 'watch', symbol: pick() };
  if (/\b(?:swing (?:highs?|lows?)|entry points?|entries|candlestick|scan|analy[sz]e)\b/i.test(text) && /\b(?:chart|market|stock|crypto|bitcoin|btc|eth|ethereum|solana|s&p|nasdaq|dow|swing|entry|entries|candlestick|ticker|price action)\b/i.test(text)) {
    return { kind: 'analyze', symbol: pick() || 'BTCUSDT' };
  }
  return null;
}
