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
  // CME index futures (Stooq daily, delayed). Micros track the same index,
  // so MES uses ES prices and MNQ uses NQ prices; only the dollars per point differ.
  es: 'es.f', mes: 'es.f', 'e-mini s&p': 'es.f', 'micro s&p': 'es.f',
  nq: 'nq.f', mnq: 'nq.f', 'e-mini nasdaq': 'nq.f', 'micro nasdaq': 'nq.f',
};

/// Dollars per one point, per contract, before commissions and slippage.
export const POINT_VALUE = { 'es.f': { full: 50, micro: 5, name: 'ES', microName: 'MES' }, 'nq.f': { full: 20, micro: 2, name: 'NQ', microName: 'MNQ' } };

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
    : { source: 'stooq', symbol, label: /\.f$/.test(symbol) ? `${symbol.replace(/\.f$/, '').toUpperCase()} futures` : symbol.replace(/\.us$/, '').toUpperCase() };
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
  // Prior-bar channels (Donchian), ATR(14) and RSI(2), all from closed bars only.
  const hh20 = new Array(len).fill(null);
  const hh55 = new Array(len).fill(null);
  const ll10 = new Array(len).fill(null);
  const ll20 = new Array(len).fill(null);
  const atr14 = new Array(len).fill(null);
  const rsi2 = new Array(len).fill(null);
  const extreme = (from, to, key, pick) => { let v = candles[from][key]; for (let j = from + 1; j < to; j++) v = pick(v, candles[j][key]); return v; };
  let atr = 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < len; i++) {
    if (i >= 20) { hh20[i] = extreme(i - 20, i, 'h', Math.max); ll20[i] = extreme(i - 20, i, 'l', Math.min); }
    if (i >= 55) hh55[i] = extreme(i - 55, i, 'h', Math.max);
    if (i >= 10) ll10[i] = extreme(i - 10, i, 'l', Math.min);
    const k = candles[i];
    const tr = Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c));
    atr = i <= 14 ? atr + tr / 14 : (atr * 13 + tr) / 14;
    if (i >= 14) atr14[i] = atr;
    const change = k.c - candles[i - 1].c;
    up = i <= 2 ? up + Math.max(change, 0) / 2 : (up + Math.max(change, 0)) / 2;
    down = i <= 2 ? down + Math.max(-change, 0) / 2 : (down + Math.max(-change, 0)) / 2;
    if (i >= 2) rsi2[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  }
  return { lastHigh, lastLow, sma20, sma50, hh20, hh55, ll10, ll20, atr14, rsi2 };
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

// ─── Trading skills: building blocks CHE combines and tests herself ──────
//
// A skill is one entry signal + one trend filter + one profit target in R.
// CHE tests every combination on each market's history and keeps only the
// ones that hold up on data they were never chosen on. Deterministic: no AI
// tokens, no guessing.

const SIGNALS = {
  'swing-breakout': { name: 'swing breakout', entry: (c, i, x) => { const r = STRATEGIES['swing-breakout'].entry(c, i, x); return r && { entry: r.entry, stop: r.stop, why: r.why }; } },
  'pullback-reversal': { name: 'pullback reversal', entry: (c, i, x) => { const r = STRATEGIES['pullback-reversal'].entry(c, i, x); return r && { entry: r.entry, stop: r.stop, why: r.why }; } },
  'trend-cross': { name: 'trend cross', entry: (c, i, x) => { const r = STRATEGIES['trend-cross'].entry(c, i, x); return r && { entry: r.entry, stop: r.stop, why: r.why }; } },
  'channel-20': {
    name: '20-day channel breakout',
    entry(c, i, x) {
      const hh = x.hh20[i]; const lo = x.ll10[i];
      if (hh == null || lo == null || i < 1 || !(c[i - 1].c <= hh && c[i].c > hh) || lo >= c[i].c) return null;
      return { entry: c[i].c, stop: lo, why: `closed above the 20-day high ${round(hh)}` };
    },
  },
  'channel-55': {
    name: '55-day channel breakout',
    entry(c, i, x) {
      const hh = x.hh55[i]; const lo = x.ll20[i];
      if (hh == null || lo == null || i < 1 || !(c[i - 1].c <= hh && c[i].c > hh) || lo >= c[i].c) return null;
      return { entry: c[i].c, stop: lo, why: `closed above the 55-day high ${round(hh)}` };
    },
  },
  'rsi2-dip': {
    name: 'short-term oversold dip',
    entry(c, i, x) {
      const rsi = x.rsi2[i]; const atr = x.atr14[i];
      if (rsi == null || atr == null || rsi >= 10) return null;
      return { entry: c[i].c, stop: c[i].c - 2 * atr, why: `2-day RSI at ${Math.round(rsi)}, oversold` };
    },
  },
  'inside-bar-break': {
    name: 'inside bar breakout',
    entry(c, i) {
      if (i < 2) return null;
      const mother = c[i - 2]; const inside = c[i - 1];
      if (!(inside.h < mother.h && inside.l > mother.l) || c[i].c <= inside.h || inside.l >= c[i].c) return null;
      return { entry: c[i].c, stop: inside.l, why: 'broke out of an inside bar' };
    },
  },
};

const FILTERS = {
  any: { name: 'any trend', ok: () => true },
  above50: { name: 'above the 50-day average', ok: (c, i, x) => x.sma50[i] != null && c[i].c > x.sma50[i] },
  rising20: { name: '20-day average rising', ok: (c, i, x) => i >= 5 && x.sma20[i] != null && x.sma20[i - 5] != null && x.sma20[i] > x.sma20[i - 5] },
};

const TARGETS = [1.5, 2, 3];

/// Every skill id: "signal|filter|targetR".
export const SKILL_IDS = Object.keys(SIGNALS).flatMap((sig) => Object.keys(FILTERS).flatMap((f) => TARGETS.map((r) => `${sig}|${f}|${r}`)));

function skill(id) {
  const [sig, f, r] = String(id || '').split('|');
  const signal = SIGNALS[sig]; const filter = FILTERS[f]; const R = Number(r);
  if (!signal || !filter || !TARGETS.includes(R)) return null;
  return {
    name: `${signal.name}, ${filter.name}, target ${R}R`,
    entry(c, i, x) {
      if (!filter.ok(c, i, x)) return null;
      const e = signal.entry(c, i, x);
      if (!e || !(e.stop < e.entry)) return null;
      return { ...e, target: e.entry + R * (e.entry - e.stop) };
    },
  };
}

export function strategyById(id) { return STRATEGIES[id] || skill(id); }
export function strategyName(id) { return strategyById(id)?.name || String(id || 'unknown'); }

/// Tests skills on one market with a three-way split, oldest to newest:
/// 60% to choose on, 20% to confirm, last 20% held back as the honest test.
/// A skill is "found" only if it makes money on the first two parts with a
/// real sample size. The held-back result is reported as it is, good or bad.
export function discoverSkills(candles, ids = SKILL_IDS) {
  const a = Math.floor(candles.length * 0.6);
  const b = Math.floor(candles.length * 0.8);
  const ctx = prepare(candles);
  return ids.map((id) => {
    const choose = backtest(candles, id, { to: a, ctx });
    const confirm = backtest(candles, id, { from: a, to: b, ctx });
    const test = backtest(candles, id, { from: b, ctx });
    // Many skills are tried, so a few would look good by luck alone: both
    // selection parts must clear a real edge (profit factor above 1.15). The
    // held-back part never decides or ranks anything; it is only reported.
    const found = choose.trades_count >= 20 && confirm.trades_count >= 6
      && [choose, confirm].every((part) => part.expectancy_r > 0 && part.profit_factor > 1.15);
    const brief = ({ trades, strategy, ...rest }) => rest;
    return { id, name: strategyName(id), found, choose: brief(choose), confirm: brief(confirm), test: brief(test) };
  });
}

const SKILLS_PER_TICK = 12;
const RETEST_DAYS = 30;

/// One learning step for one market: test the next batch of skills not yet
/// tested on it (all of them get re-tested every 30 days, because markets
/// change). Returns what is new.
export function learnStep(lab, candles, now = Date.now()) {
  const state = lab && typeof lab === 'object' ? lab : {};
  state.known = Array.isArray(state.known) ? state.known : [];
  if (!state.cycle_at || now - Date.parse(state.cycle_at) > RETEST_DAYS * 86400000) {
    state.cycle_at = new Date(now).toISOString();
    state.tested = [];
    state.results = {};
  }
  const next = SKILL_IDS.filter((id) => !state.tested.includes(id)).slice(0, SKILLS_PER_TICK);
  const newly = [];
  for (const r of discoverSkills(candles, next)) {
    state.results[r.id] = { found: r.found, test: r.test, confirm: r.confirm, choose: r.choose };
    state.tested.push(r.id);
    // A skill re-found in a later monthly cycle is not a new discovery.
    if (r.found && !state.known.includes(r.id)) { newly.push(r.id); state.known.push(r.id); }
  }
  // Ranked by the confirm part only, never by the held-back test.
  const found = Object.entries(state.results).filter(([, r]) => r.found)
    .sort((x, y) => y[1].confirm.expectancy_r - x[1].confirm.expectancy_r);
  state.best = found[0]?.[0] || null;
  state.found = found.map(([id]) => id);
  state.progress = `${state.tested.length} of ${SKILL_IDS.length}`;
  return { lab: state, newly };
}

/// Dollars for one contract (and one micro) of an index future, from points.
export function futuresDollars(symbol, points) {
  const pv = POINT_VALUE[symbol];
  if (!pv || !Number.isFinite(points)) return null;
  return { contract: pv.name, per_contract: Math.round(points * pv.full * 100) / 100, micro: pv.microName, per_micro: Math.round(points * pv.micro * 100) / 100 };
}

// ─── Backtest ─────────────────────────────────────────────────────────────

/// Walks forward bar by bar. One trade at a time. Stop is checked before
/// target inside a bar (the honest, worst-case assumption). Results in R
/// (multiples of the risk taken), so different markets compare fairly.
export function backtest(candles, strategyId, { from = 60, to = candles.length, ctx = prepare(candles) } = {}) {
  const strat = strategyById(strategyId);
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
const DEFAULT_WATCH = ['BTCUSDT', 'ETHUSDT', '^spx', 'es.f', 'nq.f'];

export async function readBook(storage) {
  const book = (await storage.get(BOOK)) || {};
  const watch = Array.isArray(book.watch) ? book.watch : [...DEFAULT_WATCH];
  // Index futures joined the default watch list later; add them once.
  if (!book.futures_added) for (const sym of ['es.f', 'nq.f']) if (!watch.includes(sym)) watch.push(sym);
  return {
    watch,
    futures_added: true,
    open: Array.isArray(book.open) ? book.open : [],
    closed: Array.isArray(book.closed) ? book.closed : [],
    learned: book.learned && typeof book.learned === 'object' ? book.learned : {},
    lab: book.lab && typeof book.lab === 'object' ? book.lab : {},
    discoveries: Array.isArray(book.discoveries) ? book.discoveries : [],
    last_tick: book.last_tick || null,
  };
}

async function saveBook(storage, book) {
  book.closed = book.closed.slice(-500);
  book.discoveries = book.discoveries.slice(-100);
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

function closeTrade(t, exit, closedAt) {
  const r = exit === t.stop ? -1 : round((t.target - t.entry) / (t.entry - t.stop));
  const dollars = futuresDollars(t.symbol, exit - t.entry);
  Object.assign(t, { exit, r, closed_at: closedAt }, dollars ? { dollars } : {});
}

/// One paper-trading pass, at most hourly: close trades that hit stop or
/// target, take the next learning step on every market (new skills tested,
/// found ones kept), then open paper trades from the best skill that is
/// still earning its place.
export async function paperTick(storage, { fetcher = fetch, force = false, now = Date.now() } = {}) {
  const book = await readBook(storage);
  if (!force && book.last_tick && now - Date.parse(book.last_tick) < 55 * 60_000) return book;
  book.last_tick = new Date(now).toISOString();
  for (const symbol of book.watch) {
    const data = await loadCandles(symbol, { fetcher });
    if (data.error || data.candles.length < 120) continue;
    const candles = data.candles;
    const last = candles[candles.length - 1];
    for (const t of book.open.filter((x) => x.symbol === symbol)) {
      for (const k of candles.filter((bar) => bar.t > t.opened_bar)) {
        // Stop first inside a bar: the honest, worst-case assumption.
        if (k.l <= t.stop) { closeTrade(t, t.stop, k.t); break; }
        if (k.h >= t.target) { closeTrade(t, t.target, k.t); break; }
      }
    }
    book.closed.push(...book.open.filter((x) => x.closed_at));
    book.open = book.open.filter((x) => !x.closed_at);
    const step = learnStep(book.lab[symbol], candles, now);
    book.lab[symbol] = step.lab;
    for (const id of step.newly) {
      book.discoveries.push({ at: new Date(now).toISOString(), symbol, label: data.label, id, name: strategyName(id), test: step.lab.results[id].test });
    }
    // Live results count too: a skill that loses 5 paper trades in a row on
    // this market is benched until its next re-test; the next found one trades.
    const benched = (id) => {
      const recent = book.closed.filter((x) => x.symbol === symbol && x.strategy === id).slice(-5);
      return recent.length === 5 && recent.every((x) => x.r < 0) && Date.parse(recent[4].closed_at) > Date.parse(step.lab.cycle_at);
    };
    const best = (step.lab.found || []).find((id) => !benched(id)) || null;
    book.learned[symbol] = { at: step.lab.cycle_at, best, progress: step.lab.progress, found: (step.lab.found || []).length };
    if (!best || book.open.some((x) => x.symbol === symbol)) continue;
    const setup = strategyById(best)?.entry(candles, candles.length - 1, prepare(candles));
    if (setup) {
      book.open.push({ id: crypto.randomUUID(), symbol, label: data.label, strategy: best, ...setup, entry: round(setup.entry), stop: round(setup.stop), target: round(setup.target), opened_at: new Date(now).toISOString(), opened_bar: last.t, data: data.data });
    }
  }
  await saveBook(storage, book);
  return book;
}

/// When the next learning tick is due (ms), so the alarm keeps it hourly.
export async function nextTradingTickAt(storage) {
  const last = Date.parse((await storage.get(BOOK))?.last_tick || '');
  return Number.isFinite(last) ? last + 60 * 60_000 : Date.now() + 60_000;
}

/// What CHE has learned about trading, said aloud: skills found per market
/// with their held-back test numbers, newest discoveries, and paper results
/// (with dollars per contract for index futures).
export function speakLearning(book) {
  const lines = ['Trading learning, paper only, no real money.'];
  const markets = Object.entries(book.lab || {});
  if (!markets.length) return `${lines[0]} I have not finished a learning pass yet. I test new skills every hour.`;
  for (const [symbol, lab] of markets) {
    const label = resolveSymbol(symbol)?.label || symbol;
    const best = lab.found?.[0];
    const t = best ? lab.results[best].test : null;
    lines.push(best
      ? `${label}: ${lab.found.length} skill${lab.found.length === 1 ? '' : 's'} found after testing ${lab.progress}. Best: ${strategyName(best)}. On held-back data it never saw while choosing: ${t.trades_count} trades, ${t.win_rate}% wins, ${t.expectancy_r}R per trade${t.expectancy_r > 0 ? '' : ', so it did not hold up there; paper trading will show whether it is real'}.`
      : `${label}: no skill has held up yet after testing ${lab.progress}. I will not trade it until one does.`);
  }
  const fresh = (book.discoveries || []).slice(-3);
  if (fresh.length) lines.push(`Newest skills learned: ${fresh.map((d) => `${strategyName(d.id)} on ${d.label}`).join('; ')}.`);
  for (const [symbol, pv] of Object.entries(POINT_VALUE)) {
    const done = (book.closed || []).filter((x) => x.symbol === symbol && x.dollars);
    if (!done.length) continue;
    const s = stats(done);
    const micro = Math.round(done.reduce((sum, x) => sum + x.dollars.per_micro, 0));
    lines.push(`${pv.name} paper trades: ${s.trades_count}, ${s.win_rate}% wins, ${s.total_r}R, about $${micro} on one ${pv.microName} contract before commissions and slippage.`);
  }
  lines.push('Futures here use free daily data, delayed, so these are swing trades, not intraday.');
  return lines.join('\n');
}

export function speakBook(book) {
  const s = stats(book.closed);
  const open = book.open.map((t) => `${t.label} (${strategyName(t.strategy)}) from ${t.entry}, stop ${t.stop}, target ${t.target}`);
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
  if (/\b(?:what (?:have|did) you (?:learn|learned)|trading (?:skills?|lessons?|learning)|learn(?:ed|ing)? (?:about )?trading|new (?:trading )?(?:skills?|strateg(?:y|ies)))\b/i.test(text) && /\b(?:trad|market|futures|stocks?|crypto)/i.test(text)) return { kind: 'learning' };
  if (/\bbacktest/i.test(text) && !/\b(?:code|app|feature|function)\b/i.test(text)) return { kind: 'backtest', symbol: pick() || 'BTCUSDT' };
  if (/\b(?:paper trade|watch)\b[\s\S]{0,30}/i.test(text) && /\b(?:paper|trade|market)\b/i.test(text)) return { kind: 'watch', symbol: pick() };
  if (/\b(?:swing (?:highs?|lows?)|entry points?|entries|candlestick|scan|analy[sz]e)\b/i.test(text) && /\b(?:chart|market|stock|crypto|bitcoin|btc|eth|ethereum|solana|s&p|nasdaq|dow|swing|entry|entries|candlestick|ticker|price action)\b/i.test(text)) {
    return { kind: 'analyze', symbol: pick() || 'BTCUSDT' };
  }
  return null;
}
