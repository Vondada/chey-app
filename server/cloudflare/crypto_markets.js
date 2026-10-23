// Orion's crypto desk (owner master mission, 2026-10-23, Phases 5–7): BTC and ETH researched and paper-traded
// around the clock, weekends included, from verified public exchange candles.
//
// This is not a second trading engine. Every strategy, fill, cost, journal record and pause decision comes from the
// existing evidence engine (trading_evidence.js), forward journal (appendTrades) and strategy governor; this module
// only feeds them crypto bars and keeps the crypto records labelled `market: 'crypto'` so no futures view mixes them.
//
// Deterministic code only: no model is called, no exchange account or key exists, and nothing here can place an
// order anywhere. The loop runs on the Durable Object's alarm (the same pass as forward paper), so it keeps going
// while the app is closed. A daily request budget caps what it may fetch, and the owner can pause it by voice.
import {
  CRYPTO_CONTRACTS, INTRADAY_CANDIDATES, MIN_TRADES, appendTrades, candleProblems, evaluateWalkForward, intradayContext,
  newPortfolio, readTrades, sessionOf, stepPortfolio, summarize, validateTradeRecord,
} from './trading_evidence.js';
import { governedGate, pausedUnits, runGovernor } from './strategy_governor.js';
import { readControls } from './trading_controls.js';
import { postTradeReview } from './trading_live.js';
import { queueRoomEvent } from './room_events.js';

export const CRYPTO_SOURCE = 'che_crypto';
export const CRYPTO_STATE = 'crypto_state';
export const CRYPTO_RUNS = 'crypto_runs';
export const CRYPTO_BUDGET = 'crypto_budget';
export const CRYPTO_RESEARCH = 'crypto_research';
const barsKey = (coin, tf) => `crypto_bars:${coin}:${tf}`;
const pfKey = (coin, tf) => `crypto_pf:${coin}:${tf}`;

export const COINS = Object.freeze({
  BTC: { product: 'BTC-USD', kraken: 'XBTUSD', krakenKey: 'XXBTZUSD', name: 'Bitcoin', qty: 0.01 },
  ETH: { product: 'ETH-USD', kraken: 'ETHUSD', krakenKey: 'XETHZUSD', name: 'Ethereum', qty: 0.25 },
});
export const TIMEFRAMES = Object.freeze({ '5m': 300, '15m': 900, '1h': 3600 });
// Bars kept per series: about 7 days of 5-minute, 14 days of 15-minute and 60 days of hourly bars.
const KEEP = Object.freeze({ '5m': 2016, '15m': 1344, '1h': 1440 });
const PAGE = 300;                    // Coinbase Exchange serves at most 300 candles per request
export const DAILY_REQUEST_LIMIT = 3000;
const PASS_REQUEST_LIMIT = 6;        // per alarm pass, so the rest of the pass keeps its own subrequests
const PUBLISH_GRACE_MS = 20_000;     // a bucket is fetched 20 s after it closes, once the exchange has published it
const RESEARCH_EVERY_MS = 6 * 3_600_000;
const RUN_LIMIT = 200;
const STEP_WINDOW = 600;

// Assumed costs, stored on every portfolio and trade. Fees: Coinbase Exchange's lowest published tier, 0.60% taker
// and 0.40% maker (Coinbase's retail app and lower Advanced tiers can charge more). Spread and slippage are planning
// numbers for a small order on the deepest USD books. A change of costs is a new strategy version.
export const CRYPTO_COSTS = Object.freeze({
  BTC: Object.freeze({ spreadTicks: 100, slippageTicks: 200, commissionPerSide: 0, feePerSide: 0, takerPct: 0.006, makerPct: 0.004 }),
  ETH: Object.freeze({ spreadTicks: 10, slippageTicks: 10, commissionPerSide: 0, feePerSide: 0, takerPct: 0.006, makerPct: 0.004 }),
});

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (now) => iso(now).slice(0, 10);

/** One portfolio per strategy (no trend-filter copies), each coin and timeframe. */
export function cryptoSpecs() {
  return Object.keys(INTRADAY_CANDIDATES).map((c) => ({ c, f: 'any', target_r: c === 'rsi-revert-5m' ? 1.5 : 2 }));
}
const seriesLabel = (coin, tf, status) => `Coinbase Exchange ${COINS[coin].product} ${tf} (${status})`;
function freshPortfolio(coin, tf, spec, source = 'paper') {
  const pf = newPortfolio(spec.c, spec.f, { contract: coin, qty: COINS[coin].qty, source, resolution: tf, priceSeries: seriesLabel(coin, tf, 'LIVE'), costs: CRYPTO_COSTS[coin], params: { target_r: spec.target_r } });
  pf.signals = [];
  pf.skips = [];
  return pf;
}

// ─── State, budget, schedule ──────────────────────────────────────────────

export async function readCryptoState(storage) {
  const saved = await storage.get(CRYPTO_STATE);
  if (saved) return saved;
  // On unless the owner pauses it: the master mission makes crypto a primary 24/7 paper market.
  return { enabled: true, started_by: 'owner master mission, 2026-10-23: research BTC and ETH and paper trade them around the clock', started_at: null, fetched: {} };
}

/** Pause or resume by the owner. Pausing keeps every record; an open position is voided, never closed at a later price. */
export async function setCryptoPaper(storage, enabled, now = Date.now()) {
  const state = await readCryptoState(storage);
  const voided = [];
  if (!enabled) {
    for (const coin of Object.keys(COINS)) {
      for (const tf of Object.keys(TIMEFRAMES)) {
        const saved = await storage.get(pfKey(coin, tf));
        if (!saved) continue;
        for (const pf of Object.values(saved)) {
          if (pf.open) voided.push({ portfolio: pf.key, strategy: pf.candidate, open: pf.open });
          pf.open = null; pf.pending = null;
        }
        await storage.put(pfKey(coin, tf), saved);
      }
    }
  } else if (!state.enabled) {
    // Resuming starts at the newest bar, so the paused period is never traded.
    for (const coin of Object.keys(COINS)) {
      for (const tf of Object.keys(TIMEFRAMES)) {
        const saved = await storage.get(pfKey(coin, tf));
        if (!saved) continue;
        for (const pf of Object.values(saved)) { pf.last_bar_time = null; pf.open = null; pf.pending = null; }
        await storage.put(pfKey(coin, tf), saved);
      }
    }
  }
  const next = enabled
    ? { ...state, enabled: true, resumed_at: iso(now), paused_at: null, started_at: state.started_at || iso(now) }
    : { ...state, enabled: false, paused_at: iso(now) };
  await storage.put(CRYPTO_STATE, next);
  return { state: next, voided: voided.length };
}

async function spend(storage, now, n = 1) {
  const day = dayOf(now);
  const b = (await storage.get(CRYPTO_BUDGET)) || {};
  const used = b.day === day ? b.requests : 0;
  if (used + n > DAILY_REQUEST_LIMIT) return false;
  await storage.put(CRYPTO_BUDGET, { day, requests: used + n, limit: DAILY_REQUEST_LIMIT });
  return true;
}
export async function readBudget(storage, now = Date.now()) {
  const b = (await storage.get(CRYPTO_BUDGET)) || {};
  return { day: dayOf(now), requests: b.day === dayOf(now) ? b.requests : 0, limit: DAILY_REQUEST_LIMIT };
}

/** The newest bucket of `tf` that has closed and been published by `now`, as its start time in ms. */
const lastClosedStart = (tf, now) => Math.floor((now - PUBLISH_GRACE_MS) / (TIMEFRAMES[tf] * 1000)) * TIMEFRAMES[tf] * 1000 - TIMEFRAMES[tf] * 1000;

/** When the next pass is due: the next 5-minute close plus the publish grace. Null while paused. */
export async function nextCryptoTickAt(storage, now = Date.now()) {
  const state = await readCryptoState(storage);
  if (!state.enabled) return null;
  const g = TIMEFRAMES['5m'] * 1000;
  const due = lastClosedStart('5m', now) + 2 * g + PUBLISH_GRACE_MS;
  return Math.max(now + 1000, due);
}

// ─── Exchange data ────────────────────────────────────────────────────────

const HEADERS = { 'User-Agent': 'CHE-Orion/1.0 (paper research; no account)', Accept: 'application/json' };

/** Coinbase Exchange public candles, oldest first, closed buckets only. Throws on an HTTP or shape error. */
export async function fetchCoinbaseCandles(coin, tf, { fetcher = fetch, now = Date.now(), end = null } = {}) {
  const g = TIMEFRAMES[tf];
  let url = `https://api.exchange.coinbase.com/products/${COINS[coin].product}/candles?granularity=${g}`;
  if (end) url += `&start=${iso(end - PAGE * g * 1000)}&end=${iso(end)}`;
  const res = await fetcher(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Coinbase answered HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Coinbase answered ${String(rows?.message || 'an unexpected shape').slice(0, 80)}`);
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 6)
    .map((r) => ({ t: iso(Number(r[0]) * 1000), o: Number(r[3]), h: Number(r[2]), l: Number(r[1]), c: Number(r[4]), v: Number(r[5]) }))
    .filter((b) => Date.parse(b.t) + g * 1000 <= now)
    .sort((a, b) => a.t.localeCompare(b.t));
}

/** Kraken public OHLC, used only to cross-check Coinbase's newest closed bar. The forming bar is dropped. */
export async function fetchKrakenCandles(coin, tf, { fetcher = fetch, now = Date.now() } = {}) {
  const g = TIMEFRAMES[tf];
  const res = await fetcher(`https://api.kraken.com/0/public/OHLC?pair=${COINS[coin].kraken}&interval=${g / 60}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Kraken answered HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error?.length) throw new Error(`Kraken answered ${String(body.error[0]).slice(0, 80)}`);
  const rows = body?.result?.[COINS[coin].krakenKey];
  if (!Array.isArray(rows)) throw new Error('Kraken answered an unexpected shape');
  return rows
    .map((r) => ({ t: iso(Number(r[0]) * 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]) }))
    .filter((b) => Date.parse(b.t) + g * 1000 <= now);
}

/**
 * LIVE: the newest closed, published bucket is present. DELAYED: the newest bar closed within 30 minutes but newer
 * buckets are missing. DISCONNECTED: nothing usable. Only LIVE bars may open a paper position.
 */
export function feedStatus(bars, tf, now = Date.now()) {
  if (!bars.length) return { status: 'DISCONNECTED', reason: 'no bars were returned' };
  const newest = Date.parse(bars[bars.length - 1].t);
  const expected = lastClosedStart(tf, now);
  const closedAt = newest + TIMEFRAMES[tf] * 1000;
  const age_s = Math.max(0, Math.round((now - closedAt) / 1000));
  if (newest >= expected) return { status: 'LIVE', age_s };
  if (now - closedAt <= 30 * 60_000) return { status: 'DELAYED', age_s, reason: `the exchange has not published the newest ${tf} bars yet` };
  return { status: 'DISCONNECTED', age_s, reason: `the newest bar closed ${Math.round(age_s / 60)} minutes ago` };
}

function merge(stored, fresh, keep) {
  const map = new Map(stored.map((b) => [b.t, b]));
  for (const b of fresh) map.set(b.t, b);
  return [...map.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-keep);
}

// ─── One pass ─────────────────────────────────────────────────────────────

function ownerGate(controls) {
  // The owner's global switches apply to crypto too. The futures account limits (dollars, contracts) do not:
  // crypto has its own fixed coin size and its own unit in the governor.
  return (pf) => {
    const s = controls.strategies?.[pf.candidate] || {};
    if (controls.emergency) return 'Emergency Stop is on';
    if (controls.stop_new_entries) return 'new entries are stopped';
    if (controls.paused_all) return 'all strategies are paused';
    if (s.disabled) return 'this strategy is disabled';
    if (s.paused) return 'this strategy is paused';
    return null;
  };
}

function cryptoReview(t) {
  const review = postTradeReview(t);
  review.facts = review.facts.map((f) => f.replace('flat before the CME daily break', 'flat by 16:55 New York, the daily research cutoff CHE uses for every market'));
  return review;
}

/** Which series are due: a new bucket has closed since the last fetch. 5-minute first, so the budget favours it. */
function dueSeries(state, now) {
  const out = [];
  for (const tf of Object.keys(TIMEFRAMES)) {
    for (const coin of Object.keys(COINS)) {
      const last = state.fetched?.[`${coin}:${tf}`] || 0;
      if (lastClosedStart(tf, now) > lastClosedStart(tf, last)) out.push({ coin, tf });
    }
  }
  return out;
}

/**
 * One crypto pass: fetch the series whose bucket closed, step their paper portfolios on closed LIVE bars, journal
 * closed trades through the shared journal, let the governor re-judge, and log the run. Never throws.
 */
export async function cryptoTick(storage, { fetcher = fetch, now = Date.now(), force = false } = {}) {
  const state = await readCryptoState(storage);
  if (!state.enabled && !force) return { skipped: 'Orion crypto research is paused' };
  const run = { at: iso(now), ok: true, series: [], requests: 0, closed: 0, signals: 0 };
  const due = force ? Object.keys(TIMEFRAMES).flatMap((tf) => Object.keys(COINS).map((coin) => ({ coin, tf }))) : dueSeries(state, now);
  if (!due.length) return { skipped: 'no new bar has closed yet' };
  const controls = await readControls(storage);
  const paused = await pausedUnits(storage);
  const gate = governedGate(ownerGate(controls), paused);
  const fetched = { ...(state.fetched || {}) };
  const closedAll = [];
  for (const { coin, tf } of due) {
    if (run.requests >= PASS_REQUEST_LIMIT) { run.series.push({ coin, tf, skipped: 'this pass reached its request limit; the next pass continues' }); continue; }
    if (!(await spend(storage, now))) { run.series.push({ coin, tf, skipped: `today's request budget of ${DAILY_REQUEST_LIMIT} is used` }); run.budget_exhausted = true; continue; }
    run.requests += 1;
    const row = { coin, tf, product: COINS[coin].product, source: 'Coinbase Exchange' };
    const stored = (await storage.get(barsKey(coin, tf))) || { bars: [] };
    try {
      const fresh = await fetchCoinbaseCandles(coin, tf, { fetcher, now });
      let bars = merge(stored.bars || [], fresh, KEEP[tf]);
      // Backfill one older page per pass until the series holds its full window (budget permitting).
      if (bars.length < KEEP[tf] && bars.length && run.requests < PASS_REQUEST_LIMIT && (await spend(storage, now))) {
        run.requests += 1;
        try { bars = merge(await fetchCoinbaseCandles(coin, tf, { fetcher, now, end: Date.parse(bars[0].t) }), bars, KEEP[tf]); }
        catch (error) { row.backfill_error = String(error?.message || error).slice(0, 120); }
      }
      const problems = candleProblems(bars);
      const feed = feedStatus(bars, tf, now);
      Object.assign(row, { status: problems.length ? 'DISCONNECTED' : feed.status, reason: problems.length ? `data refused: ${problems.join('; ')}` : feed.reason || null,
        last_bar: bars.at(-1)?.t || null, last_close: bars.at(-1)?.c ?? null, bars: bars.length, age_s: feed.age_s ?? null });
      fetched[`${coin}:${tf}`] = now;
      await storage.put(barsKey(coin, tf), { bars, status: row.status, reason: row.reason, checked_at: iso(now), source: 'Coinbase Exchange', product: COINS[coin].product, cross_check: stored.cross_check || null });
      if (!problems.length) {
        // The newest 600 bars are plenty for every indicator (50 EMA, swings, the previous day) and keep a pass cheap.
        const res = stepSeries(await readPortfolios(storage, coin, tf), coin, tf, bars.slice(-STEP_WINDOW), row.status, gate);
        await storage.put(pfKey(coin, tf), Object.fromEntries(res.portfolios.map((pf) => [pf.key, pf])));
        row.signals = res.signals; row.open = res.portfolios.filter((pf) => pf.open).length;
        run.signals += res.signals;
        closedAll.push(...res.closed);
      }
    } catch (error) {
      Object.assign(row, { status: 'DISCONNECTED', reason: String(error?.message || error).slice(0, 160) });
      await storage.put(barsKey(coin, tf), { ...stored, status: 'DISCONNECTED', reason: row.reason, checked_at: iso(now) });
    }
    run.series.push(row);
  }
  // Cross-check the 5-minute close against Kraken once per pass when budget allows (BTC and ETH alternate).
  const check = Object.keys(COINS)[Math.floor(now / 300_000) % 2];
  if (run.requests < PASS_REQUEST_LIMIT && due.some((d) => d.tf === '5m') && (await spend(storage, now))) {
    run.requests += 1;
    run.cross_check = await crossCheck(storage, check, { fetcher, now });
  }
  // Journal: the same validated, append-only journal as MNQ, labelled crypto.
  const valid = []; const rejected = [];
  for (const t of closedAll) {
    t.market = 'crypto';
    t.symbol = COINS[t.contract].product;
    t.review = cryptoReview(t);
    const p = validateTradeRecord(t);
    (p.length ? rejected : valid).push(p.length ? { portfolio: t.portfolio, entry: t.entry.time, problems: p } : t);
  }
  if (valid.length) {
    run.journal = await appendTrades(storage, valid);
    run.closed = run.journal.written;
    try { run.governor = (await runGovernor(storage, { now })).changes.map((c) => `${c.action} ${c.strategy} ${c.market} ${c.timeframe}`); } catch (error) { run.governor_error = String(error?.message || error).slice(0, 160); }
    if (run.closed) await queueRoomEvent(storage, { room: 'trading', kind: 'journal_trades', key: `crypto:${run.at}`, title: `${run.closed} crypto paper trade${run.closed === 1 ? '' : 's'} closed`, body: `Orion's crypto paper journal closed ${run.closed} simulated trade${run.closed === 1 ? '' : 's'} at ${run.at} on Coinbase Exchange bars. Paper only; no order was sent anywhere.`, status: 'verified', evidence: [`crypto_runs ${run.at}`], refs: { ledger: 'forward_paper_journal', market: 'crypto', run_at: run.at } }).catch(() => null);
  }
  if (rejected.length) run.rejected = rejected.slice(0, 3);
  run.ok = run.series.some((s) => s.status === 'LIVE' || s.status === 'DELAYED');
  await storage.put(CRYPTO_STATE, { ...state, fetched, started_at: state.started_at || (state.enabled ? run.at : null), last_run_at: run.at, last_ok_at: run.ok ? run.at : state.last_ok_at || null });
  const runs = (await storage.get(CRYPTO_RUNS)) || [];
  await storage.put(CRYPTO_RUNS, [...runs, run].slice(-RUN_LIMIT));
  // Research refresh, one series per pass, at most every six hours each (no network: stored bars only).
  run.research = await researchStep(storage, now).catch((error) => ({ error: String(error?.message || error).slice(0, 120) }));
  return run;
}

async function readPortfolios(storage, coin, tf) {
  const saved = (await storage.get(pfKey(coin, tf))) || {};
  return cryptoSpecs().map((spec) => {
    const fresh = freshPortfolio(coin, tf, spec);
    return saved[fresh.key] ? { signals: [], skips: [], ...saved[fresh.key] } : fresh;
  });
}

/** Steps every portfolio of one series forward. Entries need LIVE bars; open positions are always managed to their exit. */
export function stepSeries(portfolios, coin, tf, bars, status, gate = null) {
  const ctx = intradayContext(bars);
  const newest = bars[bars.length - 1].t;
  const allowEntries = status === 'LIVE';
  const blockReason = allowEntries ? null : `the ${COINS[coin].product} ${tf} feed is ${status}, not LIVE`;
  const closed = [];
  let signals = 0;
  for (const pf of portfolios) {
    // Forward only: a new portfolio starts at the newest closed bar, so history is never journalled as paper.
    if (pf.last_bar_time == null) Object.assign(pf, { last_bar_time: newest, started_from: newest });
    pf.price_series = seriesLabel(coin, tf, status);
    pf.feed = { status, provider: 'Coinbase Exchange', provider_symbol: COINS[coin].product, last_bar_time: newest, authenticated: false, subscription_verified: false };
    const before = pf.counts.signals;
    closed.push(...stepPortfolio(pf, bars, ctx, gate, { allowEntries, blockReason }));
    signals += pf.counts.signals - before;
    pf.signals = (pf.signals || []).slice(-15);
    pf.skips = (pf.skips || []).slice(-15);
  }
  return { portfolios, closed, signals };
}

async function crossCheck(storage, coin, { fetcher, now }) {
  const stored = (await storage.get(barsKey(coin, '5m'))) || { bars: [] };
  try {
    const kraken = await fetchKrakenCandles(coin, '5m', { fetcher, now });
    const k = new Map(kraken.map((b) => [b.t, b]));
    const pair = [...stored.bars].reverse().find((b) => k.has(b.t));
    const result = pair
      ? { coin, at: iso(now), bar: pair.t, coinbase: pair.c, kraken: k.get(pair.t).c, diff_pct: r4((Math.abs(pair.c - k.get(pair.t).c) / pair.c) * 100) }
      : { coin, at: iso(now), error: 'no common closed bar to compare' };
    result.agrees = result.diff_pct != null ? result.diff_pct <= 0.5 : null;
    await storage.put(barsKey(coin, '5m'), { ...stored, cross_check: result });
    return result;
  } catch (error) {
    const result = { coin, at: iso(now), error: String(error?.message || error).slice(0, 120), agrees: null };
    await storage.put(barsKey(coin, '5m'), { ...stored, cross_check: result });
    return result;
  }
}

// ─── Research: regimes, liquidity, sessions, backtest with out-of-sample ─────

const ATR_N = 14;
function atrPct(bars) {
  const out = [];
  let atr = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    atr = atr == null ? tr : (atr * (ATR_N - 1) + tr) / ATR_N;
    if (i >= ATR_N) out.push((atr / bars[i].c) * 100);
  }
  return out;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const utcBlock = (t) => { const h = new Date(t).getUTCHours(); return h < 8 ? 'Asia (00–08 UTC)' : h < 13 ? 'Europe (08–13 UTC)' : h < 21 ? 'US (13–21 UTC)' : 'Late US (21–24 UTC)'; };
const isWeekend = (t) => { const d = new Date(t).getUTCDay(); return d === 0 || d === 6; };

/** Market structure measured from stored bars only. */
export function marketStudy(bars, tf) {
  const atr = atrPct(bars);
  const now = atr.at(-1) ?? null;
  const med = median(atr);
  const regime = now == null || med == null ? 'unknown' : now > med * 1.5 ? 'high volatility' : now < med * 0.67 ? 'low volatility' : 'normal volatility';
  const rets = bars.slice(1).map((b, i) => Math.log(b.c / bars[i].c));
  const perYear = (365 * 86400) / TIMEFRAMES[tf];
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / (rets.length - 1)) : null;
  const dayBars = 86400 / TIMEFRAMES[tf];
  const last24 = bars.slice(-dayBars);
  const dollarVolume24h = last24.reduce((s, b) => s + b.c * b.v, 0);
  const groups = (keyOf) => {
    const g = {};
    for (const b of bars) {
      const k = keyOf(b.t);
      (g[k] ||= { bars: 0, range_pct: 0, dollar_volume: 0 });
      g[k].bars += 1; g[k].range_pct += ((b.h - b.l) / b.c) * 100; g[k].dollar_volume += b.c * b.v;
    }
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { bars: v.bars, avg_range_pct: r4(v.range_pct / v.bars), avg_dollar_volume: Math.round(v.dollar_volume / v.bars) }]));
  };
  return {
    from: bars[0]?.t || null, to: bars.at(-1)?.t || null, bars: bars.length,
    volatility: { atr_pct_now: now == null ? null : r4(now), atr_pct_median: med == null ? null : r4(med), regime, realized_annualized_pct: sd == null ? null : r2(sd * Math.sqrt(perYear) * 100) },
    liquidity: { dollar_volume_24h: Number.isFinite(dollarVolume24h) ? Math.round(dollarVolume24h) : null, passes_screen: dollarVolume24h >= 50_000_000, screen: 'at least $50 million traded on Coinbase in the last 24 hours' },
    by_session: groups(utcBlock),
    by_new_york_session: groups((t) => sessionOf(t, tf)),
    weekend_vs_weekday: groups((t) => (isWeekend(t) ? 'weekend' : 'weekday')),
  };
}

/** Every strategy on the stored bars: in-sample (first 70%) and out-of-sample (last 30%), net of the crypto costs. */
export function backtestSeries(coin, tf, bars) {
  const ctx = intradayContext(bars);
  const split = bars[Math.floor(bars.length * 0.7)]?.t;
  return cryptoSpecs().map((spec) => {
    const pf = freshPortfolio(coin, tf, spec, 'backtest');
    pf.price_series = seriesLabel(coin, tf, 'HISTORICAL');
    const trades = stepPortfolio(pf, bars, ctx).map((t) => ({ ...t, market: 'crypto', symbol: COINS[coin].product }));
    const all = summarize(trades);
    const oos = summarize(trades.filter((t) => t.entry.time >= split));
    const wf = evaluateWalkForward(trades, { barTimes: bars.map((b) => b.t) });
    return {
      strategy: spec.c, name: INTRADAY_CANDIDATES[spec.c].name, trades: all.trades, expectancy_r: all.expectancy_r, profit_factor: all.profit_factor,
      net_pnl: all.net_pnl, win_rate: all.win_rate, oos_from: split, oos_trades: oos.trades, oos_expectancy_r: oos.expectancy_r,
      folds: wf.folds_total, folds_positive: wf.folds_positive, enough_data: all.trades >= MIN_TRADES,
    };
  }).sort((a, b) => (b.oos_trades ? b.oos_expectancy_r : -9) - (a.oos_trades ? a.oos_expectancy_r : -9));
}

async function researchStep(storage, now) {
  const research = (await storage.get(CRYPTO_RESEARCH)) || { series: {} };
  const keys = Object.keys(COINS).flatMap((coin) => Object.keys(TIMEFRAMES).map((tf) => `${coin}:${tf}`));
  const stale = keys.find((k) => !research.series[k] || now - Date.parse(research.series[k].at) >= RESEARCH_EVERY_MS);
  if (!stale) return { skipped: 'research is fresh' };
  const [coin, tf] = stale.split(':');
  const { bars = [] } = (await storage.get(barsKey(coin, tf))) || {};
  if (bars.length < 300 || candleProblems(bars).length) {
    research.series[stale] = { at: iso(now), coin, tf, ok: false, reason: `only ${bars.length} verified bars stored so far; research needs at least 300` };
  } else {
    research.series[stale] = { at: iso(now), coin, tf, ok: true, data: `${seriesLabel(coin, tf, 'HISTORICAL')}, ${bars.length} bars`, study: marketStudy(bars, tf), strategies: backtestSeries(coin, tf, bars) };
  }
  await storage.put(CRYPTO_RESEARCH, research);
  return { updated: stale, ok: research.series[stale].ok };
}

// ─── Views and speech ─────────────────────────────────────────────────────

/** Everything the owner can ask about, from stored records only. */
export async function cryptoView(storage, now = Date.now()) {
  const state = await readCryptoState(storage);
  const runs = (await storage.get(CRYPTO_RUNS)) || [];
  const feeds = [];
  for (const coin of Object.keys(COINS)) {
    for (const tf of Object.keys(TIMEFRAMES)) {
      const s = (await storage.get(barsKey(coin, tf))) || null;
      const last = s?.bars?.at(-1) || null;
      feeds.push({ coin, tf, product: COINS[coin].product, source: 'Coinbase Exchange', status: s ? (s.status || 'DISCONNECTED') : 'NOT STARTED', reason: s?.reason || null,
        last_bar: last?.t || null, last_close: last?.c ?? null, checked_at: s?.checked_at || null, bars: s?.bars?.length || 0, cross_check: s?.cross_check || null,
        chart: tf === '5m' ? (s?.bars || []).slice(-120) : undefined });
    }
  }
  const open = [];
  for (const coin of Object.keys(COINS)) {
    for (const tf of Object.keys(TIMEFRAMES)) {
      const saved = (await storage.get(pfKey(coin, tf))) || {};
      for (const pf of Object.values(saved)) if (pf.open) open.push({ coin, tf, strategy: pf.candidate, side: pf.open.side, entry_time: pf.open.entry_time, entry: pf.open.entry?.price, stop: pf.open.stop, target: pf.open.target, qty: pf.qty });
    }
  }
  const trades = await readTrades(storage, (t) => t.environment === 'paper', { market: 'crypto' });
  const byStrategy = {};
  for (const t of trades) (byStrategy[`${t.strategy}|${t.contract}|${t.data?.resolution}`] ||= []).push(t);
  const performance = Object.entries(byStrategy).map(([k, list]) => {
    const [strategy, coin, tf] = k.split('|');
    const s = summarize(list);
    return { strategy, name: INTRADAY_CANDIDATES[strategy]?.name || strategy, coin, tf, trades: s.trades, net_pnl: s.net_pnl, expectancy_r: s.expectancy_r, win_rate: s.win_rate, enough_data: s.trades >= MIN_TRADES };
  }).sort((a, b) => b.trades - a.trades);
  const total = summarize(trades);
  const research = (await storage.get(CRYPTO_RESEARCH)) || { series: {} };
  const budget = await readBudget(storage, now);
  return {
    market: 'crypto', desk: 'Orion', enabled: Boolean(state.enabled), started_at: state.started_at || null, paused_at: state.paused_at || null,
    schedule: { runs_on: 'the Worker alarm, every 5-minute close plus 20 seconds, with the app open or closed', next_at: state.enabled ? iso(await nextCryptoTickAt(storage, now)) : null,
      last_run_at: state.last_run_at || null, last_ok_at: state.last_ok_at || null, runs_recorded: runs.length, model_calls: 0 },
    budget,
    feeds,
    simulated: { open_positions: open, closed_trades: trades.length, wins: total.wins ?? null, losses: total.losses ?? null, net_pnl: total.net_pnl ?? 0, expectancy_r: trades.length ? total.expectancy_r : null, enough_data: trades.length >= MIN_TRADES,
      recent: trades.slice(-10).reverse().map((t) => ({ coin: t.contract, tf: t.data?.resolution, strategy: t.strategy, side: t.side, entry_time: t.entry.time, entry: t.entry.fill, exit_time: t.exit.time, exit: t.exit.fill, reason: t.exit.reason, net_pnl: t.net_pnl, costs: t.costs, why: t.signal?.why })) },
    performance,
    research: Object.values(research.series),
    funding: { status: 'MISSING', why: 'No free funding-rate source has been verified yet; BTC and ETH here are spot, which has no funding.' },
    costs: CRYPTO_COSTS, sizes: Object.fromEntries(Object.entries(COINS).map(([c, v]) => [c, v.qty])),
    live_trading: 'disabled: no exchange account, key or order path exists',
  };
}

const money = (x) => `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toFixed(2)}`;
const ago = (t, now) => { const m = Math.round((now - Date.parse(t)) / 60000); return m < 1 ? 'under a minute ago' : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`; };

export function speakCrypto(v, { now = Date.now(), action = null } = {}) {
  const parts = [];
  if (action === 'paused') parts.push('Orion\'s crypto research and paper trading are paused. Every record is kept; nothing fetches or trades until you say resume.');
  else if (action === 'resumed') parts.push('Orion\'s crypto research and paper trading are on: BTC and ETH, 5-minute, 15-minute and hourly bars, around the clock including the weekend.');
  else parts.push(v.enabled ? 'Orion\'s crypto desk is on: BTC and ETH paper trading and research, around the clock including the weekend.' : 'Orion\'s crypto desk is paused. Say "resume Orion crypto research" to start it.');
  parts.push('Paper only: no exchange account, no key and no order path exist.');
  if (v.schedule.last_run_at) parts.push(`Last pass ${ago(v.schedule.last_run_at, now)}; ${v.schedule.runs_recorded} passes recorded, no AI model used.`);
  else parts.push(v.enabled ? 'No pass has run yet; the first one runs on the next 5-minute close.' : 'No pass has run yet.');
  const five = v.feeds.filter((f) => f.tf === '5m');
  parts.push(five.map((f) => f.last_bar
    ? `${f.coin} 5-minute: ${f.status} from Coinbase Exchange, last close ${f.last_close} at ${f.last_bar}${f.cross_check?.diff_pct != null ? `, within ${f.cross_check.diff_pct}% of Kraken` : ''}.`
    : `${f.coin} 5-minute: ${f.status === 'NOT STARTED' ? 'not read yet' : `${f.status}${f.reason ? ` (${f.reason})` : ''}`}.`).join(' '));
  const s = v.simulated;
  parts.push(`Simulated trades closed: ${s.closed_trades}; open positions: ${s.open_positions.length}.`);
  if (s.closed_trades) parts.push(`Net ${money(s.net_pnl)} after fees and slippage${s.enough_data ? `, ${s.expectancy_r} R per trade` : `. That is not enough data: ${s.closed_trades} of the 30 trades needed before any result counts`}.`);
  const best = v.research.filter((r) => r.ok).flatMap((r) => r.strategies.filter((x) => x.oos_trades >= MIN_TRADES).map((x) => ({ ...x, coin: r.coin, tf: r.tf })))
    .sort((a, b) => b.oos_expectancy_r - a.oos_expectancy_r)[0];
  const researched = v.research.filter((r) => r.ok).length;
  if (!researched) parts.push('Strategy comparison: not enough stored history yet; it needs 300 verified bars per series.');
  else if (!best) parts.push(`Strategy comparison on ${researched} series: no strategy has 30 out-of-sample trades yet, so none is ranked.`);
  else parts.push(`Best out-of-sample backtest so far: ${best.name} on ${best.coin} ${best.tf}, ${best.oos_trades} trades, ${best.oos_expectancy_r} R per trade after fees. ${best.oos_expectancy_r > 0 ? 'It is a backtest, not a promise.' : 'Even the best is negative after fees.'}`);
  parts.push(`Fees assumed: 0.6% taker and 0.4% maker on each side. Requests today: ${v.budget.requests} of ${v.budget.limit}.`);
  return parts.join(' ');
}

// ─── Chat intent ──────────────────────────────────────────────────────────

const CRYPTO_WORD = /\b(?:crypto(?:currency|currencies)?|bitcoin|btc|ethereum|eth|ether)\b/;
const DESK_WORD = /\b(?:research|paper|trad(?:e|es|ing)|strateg(?:y|ies)|backtest|journal|desk|weekend|24\/7|around the clock|positions?|p\s*&\s*l|pnl|results?|status|performance|doing|going)\b/;

/** Owner phrasing about Orion's crypto desk. Plain price questions and anything without a desk word are left alone. */
export function cryptoIntent(message) {
  const t = String(message || '').replace(/[’']/g, "'").toLowerCase();
  const orion = /\borion\b/.test(t);
  if (!CRYPTO_WORD.test(t) && !(orion && /\bcrypto|weekend\b/.test(t))) return null;
  if (!DESK_WORD.test(t)) return null;
  if (/\b(?:pause|stop|halt|turn off|switch off|disable)\b/.test(t) && !/\bstop(?:s|ped)?\s+(?:loss|out)\b/.test(t)) return { kind: 'pause' };
  if (/\b(?:resume|restart|start|turn on|switch on|enable|continue|keep)\b/.test(t)) return { kind: 'resume' };
  return { kind: 'status' };
}
