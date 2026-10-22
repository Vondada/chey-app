// CHE Historical Trading Intelligence (owner, 2026-10-22): decades of real Nasdaq-100 history,
// tested with the same evidence engine as the paper desk, so every number can be recomputed.
//
// Data, free and public only. Nothing is bought, subscribed to or invented:
//   MNQ  Yahoo Finance MNQ=F daily, the continuous front month, from its first bar (May 2019).
//   NQ   Yahoo Finance NQ=F daily, from its first bar. NQ began on 21 June 1999; the public
//        series starts later, and the missing span is reported, never filled in.
//   NDX  Yahoo Finance ^NDX daily, the Nasdaq-100 cash index from 1985. An index cannot be traded:
//        it is a labelled PROXY, priced with the NQ point value and NQ costs.
// Every dataset records its provider, symbol, contract, range, adjustment, resolution, time zone,
// gaps and a SHA-256 checksum of the exact bars tested. Futures are unadjusted: roll jumps are kept.
//
// Testing: trading_evidence.js stepPortfolio, unchanged. A signal is read on a closed bar and
// fills at the next bar's open with spread, slippage, commission and fees; a stop is checked
// before a target inside one bar. A leakage audit reruns each rule with every later bar removed
// and again with every later bar changed: earlier trades must come out identical.
// Ranking uses out-of-sample walk-forward results only. Daily bars can rank an idea, never
// promote one to live trading. Paper signals are journalled; no order is ever sent.
import { parseYahooChart } from './market_feed.js';
import {
  CANDIDATES, COSTS, ENGINE_VERSION, FILTERS, MIN_TRADES, candleProblems, causalContext,
  evaluateWalkForward, newPortfolio, promotionVerdict, readTrades, stepPortfolio, summarize,
} from './trading_evidence.js';

export const HI_VERSION = 'hist-1';
export const HI_STATE = 'hist_state';
export const HI_SIGNALS = 'hist_signals';
const DATA_PREFIX = 'hist_ds:';
const RESULT_PREFIX = 'hist_result:';
const LIVE_BACKTEST = 'live_paper_backtest';   // trading_live.js: the existing five-minute research
const CHUNK_BARS = 1000;
const SIGNAL_LIMIT = 500;
const RERUN_MS = 24 * 3600_000;
const DAY_MS = 86_400_000;
export const TARGETS = Object.freeze([1.5, 2, 3]);
export const FOLDS = 5;
export const MIN_TRAIN = 0.4;

export const DATASETS = Object.freeze({
  MNQ: {
    id: 'MNQ', label: 'Micro E-mini Nasdaq-100 futures (MNQ)', provider: 'Yahoo Finance chart (public, free)', provider_symbol: 'MNQ=F',
    requested_from: '2019-05-06', contract: 'MNQ', kind: 'futures', proxy: null,
    series: 'continuous front month', adjustment: 'none: unadjusted front-month prices; roll jumps are kept and counted',
  },
  NQ: {
    id: 'NQ', label: 'E-mini Nasdaq-100 futures (NQ)', provider: 'Yahoo Finance chart (public, free)', provider_symbol: 'NQ=F',
    requested_from: '1999-06-21', contract: 'NQ', kind: 'futures', proxy: null,
    series: 'continuous front month', adjustment: 'none: unadjusted front-month prices; roll jumps are kept and counted',
  },
  NDX: {
    id: 'NDX', label: 'Nasdaq-100 index (proxy)', provider: 'Yahoo Finance chart (public, free)', provider_symbol: '^NDX',
    requested_from: '1985-10-01', contract: 'NQ', kind: 'index', proxy: 'The cash index is not tradable. It stands in for Nasdaq-100 futures before they existed, priced with the NQ point value and NQ costs. No futures basis, roll or overnight session.',
    series: 'cash index', adjustment: 'price index: no dividends, no futures basis',
  },
});
// MNQ and NQ are the same Nasdaq-100 futures: each is reported on its own and never added together.
export const DATASET_ORDER = Object.freeze(['MNQ', 'NQ', 'NDX']);

// Existing strategies, and why some are not in the daily study.
export const NOT_TESTED_DAILY = Object.freeze([
  { name: 'VWAP, opening range breakout, EMA pullback, RSI reversal and the ICT 5-minute rules (Silver Bullet, sweeps, order blocks, fair value gaps)', why: 'They need intraday bars. Free 5-minute history covers about 60 days, so they are tested by the existing five-minute research, whose latest result is included here as it is.' },
  { name: 'Dirty Trez', why: 'CHE has no written rules for Dirty Trez anywhere in its code or notes. Nothing is guessed: once you give the entry, stop, target and timeframe rules, up to 33 variants per timeframe can be tested the same way.' },
]);

const r2 = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();

// ─── Ingestion and verification ──────────────────────────────────────────

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

// One line per bar, fixed field order: the checksum names exactly the bars that were tested.
export const canonicalBars = (candles) => candles.map((b) => `${b.t},${b.o},${b.h},${b.l},${b.c},${b.v ?? 0}`).join('\n');

export async function fetchDaily(spec, { fetcher = fetch, now = Date.now() } = {}) {
  const from = Math.floor(Date.parse(`${spec.requested_from}T00:00:00Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.provider_symbol)}?interval=1d&period1=${from}&period2=${Math.floor(now / 1000)}`;
  const ask = (target) => fetcher(target, { headers: { 'User-Agent': 'Mozilla/5.0 (CHE historical research)', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  try {
    let res = await ask(url);
    if (!res.ok) res = await ask(url.replace('query1.', 'query2.'));
    if (!res.ok) return { error: `${spec.provider} answered HTTP ${res.status}` };
    // A daily bar is used only once its day is over.
    const parsed = parseYahooChart(await res.json(), now, DAY_MS);
    if (parsed.error) return { error: parsed.error };
    return { candles: parsed.candles, url };
  } catch (error) {
    return { error: String(error?.name === 'TimeoutError' ? `${spec.provider} did not answer within 15 seconds` : error?.message || error).slice(0, 160) };
  }
}

/**
 * Checks a daily series and describes it. Refused: an impossible bar, a repeated or out-of-order
 * time (candleProblems). Recorded, never repaired: calendar gaps over four days, and opening jumps
 * over 4% (a futures roll or real news; they are not removed).
 */
export async function verifyDataset(spec, candles, { now = Date.now() } = {}) {
  const problems = candleProblems(candles);
  const gaps = [];
  const jumps = [];
  for (let i = 1; i < (problems.length ? 0 : candles.length); i++) {
    const days = (Date.parse(candles[i].t) - Date.parse(candles[i - 1].t)) / DAY_MS;
    if (days > 4.5) gaps.push({ after: candles[i - 1].t.slice(0, 10), before: candles[i].t.slice(0, 10), days: Math.round(days) });
    const jump = Math.abs(candles[i].o / candles[i - 1].c - 1);
    if (jump > 0.04) jumps.push({ at: candles[i].t.slice(0, 10), pct: r2(jump * 100) });
  }
  const first = candles[0]?.t || null;
  const last = candles.at(-1)?.t || null;
  const missingStart = first ? Math.round((Date.parse(first) - Date.parse(`${spec.requested_from}T00:00:00Z`)) / DAY_MS) : null;
  const manifest = {
    id: spec.id, label: spec.label, provider: spec.provider, provider_symbol: spec.provider_symbol, contract: spec.contract,
    kind: spec.kind, proxy: spec.proxy, series: spec.series, adjustment: spec.adjustment,
    resolution: '1 day', timezone: 'Exchange trading dates; bar times are UTC as the provider sends them',
    requested_from: spec.requested_from, from: first, to: last, bars: candles.length,
    start_note: missingStart > 10 ? `The provider's first bar is ${first.slice(0, 10)}, ${missingStart} days after ${spec.requested_from}. That span is not covered by this dataset and nothing was filled in.` : null,
    gaps: { count: gaps.length, largest: [...gaps].sort((a, b) => b.days - a.days).slice(0, 5) },
    jumps: { count: jumps.length, largest: [...jumps].sort((a, b) => b.pct - a.pct).slice(0, 5) },
    checksum_sha256: candles.length ? await sha256Hex(canonicalBars(candles)) : null,
    verified_at: iso(now), ok: problems.length === 0 && candles.length > 0,
    problems,
  };
  return manifest;
}

async function saveBars(storage, id, candles) {
  const old = await storage.list({ prefix: `${DATA_PREFIX}${id}:c` });
  if (old.size) await storage.delete([...old.keys()]);
  const puts = {};
  for (let i = 0, k = 0; i < candles.length; i += CHUNK_BARS, k++) {
    puts[`${DATA_PREFIX}${id}:c${String(k).padStart(4, '0')}`] = candles.slice(i, i + CHUNK_BARS).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v ?? 0]);
  }
  const entries = Object.entries(puts);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
}

export async function loadBars(storage, id) {
  const chunks = await storage.list({ prefix: `${DATA_PREFIX}${id}:c` });
  return [...chunks.keys()].sort().flatMap((k) => chunks.get(k)).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

export async function ingestDataset(storage, id, { fetcher = fetch, now = Date.now(), load = fetchDaily } = {}) {
  const spec = DATASETS[id];
  const got = await load(spec, { fetcher, now });
  if (got.error) return { id, ok: false, error: got.error, label: spec.label, provider: spec.provider, provider_symbol: spec.provider_symbol, verified_at: iso(now) };
  const manifest = await verifyDataset(spec, got.candles, { now });
  if (!manifest.ok) return { ...manifest, error: `data refused: ${manifest.problems.join('; ')}` };
  // Re-verified on read: the stored bars must give the same checksum as the bars fetched.
  await saveBars(storage, id, got.candles);
  const back = await loadBars(storage, id);
  if (await sha256Hex(canonicalBars(back)) !== manifest.checksum_sha256) return { ...manifest, ok: false, error: 'stored bars do not match the checksum of the fetched bars' };
  return manifest;
}

// ─── Regimes (causal: each bar's regime uses that bar and earlier bars only) ─

export function regimes(candles, ctx = causalContext(candles)) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  const atrPct = [];
  for (let i = 0; i < n; i++) {
    sum += candles[i].c;
    if (i >= 200) sum -= candles[i - 200].c;
    const sma200 = i >= 199 ? sum / 200 : null;
    const trend = sma200 == null ? 'trend unknown' : candles[i].c > sma200 ? 'bull (above 200-day)' : 'bear (below 200-day)';
    const v = ctx.atr14[i] == null ? null : ctx.atr14[i] / candles[i].c;
    if (v != null) atrPct.push(v);
    let vol = 'volatility unknown';
    if (v != null && atrPct.length >= 60) {
      const window = atrPct.slice(-252);
      const rank = window.filter((x) => x < v).length / window.length;
      vol = rank < 1 / 3 ? 'low volatility' : rank > 2 / 3 ? 'high volatility' : 'normal volatility';
    }
    out[i] = { trend, vol };
  }
  return out;
}

// ─── Zero look-ahead: the leakage audit ──────────────────────────────────

const tradeKey = (t) => `${t.side}|${t.entry.time}|${t.entry.fill}|${t.exit.time}|${t.exit.fill}|${t.exit.reason}`;

/**
 * `run(candles)` returns closed trades. Trades that closed before the cut must be identical when
 * every bar from the cut on is removed, and when those bars are changed (up and down) the trades
 * entered before the cut must be too. A rule that reads a future bar changes its earlier trades and fails.
 */
export function leakageAudit(candles, run, { cutShare = 0.7 } = {}) {
  const cut = Math.floor(candles.length * cutShare);
  if (cut < 2 || cut >= candles.length) return { ok: false, reason: 'too few bars to audit' };
  const cutTime = candles[cut].t;
  const closedBefore = (trades) => trades.filter((t) => t.exit.time < cutTime).map(tradeKey);
  const enteredBefore = (trades) => trades.filter((t) => t.entry.time < cutTime).map((t) => `${t.side}|${t.entry.time}|${t.entry.fill}`);
  // Later bars changed, once up and once down: prices scaled, every bar still a valid bar. A rule that
  // peeks at the next close sees it rise in one copy and fall in the other, so one of them flips it.
  const scaled = (f) => candles.map((b, i) => (i < cut ? b : { ...b, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f }));
  const full = run(candles);
  const truncated = run(candles.slice(0, cut));
  const variants = [run(scaled(1.31)), run(scaled(0.77))];
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const ok = same(closedBefore(full), closedBefore(truncated))
    && variants.every((v) => same(closedBefore(full), closedBefore(v)) && same(enteredBefore(full), enteredBefore(v)));
  return {
    ok, cut_at: cutTime, trades_checked: enteredBefore(full).length,
    reason: ok ? 'earlier trades are identical with later bars removed or changed' : 'earlier trades changed when later bars changed: the rule reads the future',
  };
}

// ─── The study ───────────────────────────────────────────────────────────

export function configs() {
  const out = [];
  for (const c of Object.keys(CANDIDATES)) for (const f of Object.keys(FILTERS)) for (const target_r of TARGETS) out.push({ c, f, target_r });
  return out;
}

const runOne = (spec, cfg, priceSeries) => (candles, ctx = causalContext(candles)) => {
  const pf = newPortfolio(cfg.c, cfg.f, { contract: spec.contract, qty: 1, source: 'backtest', resolution: 'daily', priceSeries, params: { target_r: cfg.target_r } });
  const trades = stepPortfolio(pf, candles, ctx);
  return { pf, trades };
};

const brief = (s) => ({
  trades: s.trades, sample: s.sample, win_rate: s.win_rate, win_rate_95ci: s.win_rate_95ci, expectancy_r: s.expectancy_r,
  expectancy_r_95ci: s.expectancy_r_95ci, profit_factor: s.profit_factor, net_pnl: s.net_pnl, max_drawdown: s.max_drawdown,
  max_drawdown_r: s.max_drawdown_r, costs_paid: s.costs_paid,
});

function groupBy(trades, keyOf) {
  const groups = {};
  for (const t of trades) (groups[keyOf(t)] ||= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => {
    const s = summarize(list);
    return [k, { trades: s.trades, win_rate: s.win_rate, expectancy_r: s.expectancy_r, net_pnl: s.net_pnl }];
  }));
}

/** Tests every configuration on one verified dataset. Pure: the same bars always give the same result. */
export function studyDataset(spec, manifest, candles, { recentYear = new Date().getUTCFullYear() } = {}) {
  const ctx = causalContext(candles);
  const regime = regimes(candles, ctx);
  const indexOf = new Map(candles.map((b, i) => [b.t, i]));
  const barTimes = candles.map((b) => b.t);
  const priceSeries = `${manifest.provider} ${manifest.provider_symbol} daily, ${manifest.from?.slice(0, 10)} to ${manifest.to?.slice(0, 10)}, sha256 ${manifest.checksum_sha256?.slice(0, 16)}`;
  const leakage = {};
  for (const c of Object.keys(CANDIDATES)) {
    const run = runOne(spec, { c, f: 'any', target_r: 2 }, priceSeries);
    leakage[c] = leakageAudit(candles, (bars) => run(bars).trades);
  }
  const rows = [];
  const kept = {};
  for (const cfg of configs()) {
    const { pf, trades } = runOne(spec, cfg, priceSeries)(candles, ctx);
    const wf = evaluateWalkForward(trades, { folds: FOLDS, minTrain: MIN_TRAIN, barTimes });
    const split = barTimes[Math.floor(barTimes.length * MIN_TRAIN)];
    const inSample = trades.filter((t) => t.exit.time < split);
    const verdict = promotionVerdict(wf.oos, { resolution: 'daily', foldsPositive: wf.folds_positive, folds: wf.folds_total });
    const recent = trades.filter((t) => t.entry.time.startsWith(String(recentYear)));
    const regimeOf = (t) => regime[indexOf.get(t.signal.time)] || { trend: 'trend unknown', vol: 'volatility unknown' };
    const key = `${cfg.c}|${cfg.f}|${cfg.target_r}`;
    const oos = summarize(wf.oos);
    rows.push({
      key, strategy: cfg.c, name: CANDIDATES[cfg.c].name, family: 'ICT / smart money (daily)', filter: cfg.f, filter_name: FILTERS[cfg.f].name,
      target_r: cfg.target_r, strategy_version: pf.strategy_version, counts: pf.counts,
      all: brief(summarize(trades)), in_sample: brief(summarize(inSample)), oos: brief(oos),
      folds: wf.folds, folds_positive: wf.folds_positive, folds_total: wf.folds_total,
      recent: { year: recentYear, ...brief(summarize(recent)) },
      regimes: { trend: groupBy(trades, (t) => regimeOf(t).trend), volatility: groupBy(trades, (t) => regimeOf(t).vol) },
      by_year: groupBy(trades, (t) => t.entry.time.slice(0, 4)),
      leakage_ok: leakage[cfg.c].ok,
      rankable: leakage[cfg.c].ok && oos.trades >= MIN_TRADES,
      edge_shown: leakage[cfg.c].ok && oos.trades >= MIN_TRADES && oos.expectancy_r_95ci.low > 0,
      promotable: false,
      verdict_reasons: verdict.reasons,
      pending_signal: pf.pending ? { side: pf.pending.side || 'long', time: pf.pending.signal_time, ref: pf.pending.ref, stop: pf.pending.stop, target: pf.pending.target, why: pf.pending.why } : null,
    });
    kept[key] = trades;
  }
  // Ranked on out-of-sample results only: the low end of the 95% range of expectancy in R, then its mean.
  const ranked = rows.filter((r) => r.rankable).sort((a, b) => b.oos.expectancy_r_95ci.low - a.oos.expectancy_r_95ci.low || b.oos.expectancy_r - a.oos.expectancy_r);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const top = ranked.slice(0, 5).map((r) => r.key);
  const trades = Object.fromEntries(top.map((k) => [k, kept[k].map((t) => ({
    side: t.side, signal: t.signal.time, entry: t.entry.time, entry_fill: t.entry.fill, exit: t.exit.time, exit_fill: t.exit.fill,
    reason: t.exit.reason, stop: t.stop, target: t.target, net_pnl: t.net_pnl, r_net: t.r_net, same_bar_both: t.same_bar_both_touched,
  }))]));
  return {
    dataset: spec.id, manifest, engine_version: ENGINE_VERSION, version: HI_VERSION, configs: rows.length,
    leakage, rows, ranking: ranked.map((r) => r.key), trades,
  };
}

// ─── Comparison with recorded paper trades (deduplicated) ────────────────

const dedupeKey = (t) => `${t.environment}|${t.strategy}|${t.filter}|${t.side}|${t.entry?.time}`;

/** Paper journal trades, each counted once even when two portfolio versions recorded the same entry. */
export function dedupeTrades(trades) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const t of trades) {
    const k = dedupeKey(t);
    if (seen.has(k)) { duplicates += 1; continue; }
    seen.add(k);
    out.push(t);
  }
  return { trades: out, duplicates };
}

export async function compareWithPaper(storage, results, { year = new Date().getUTCFullYear() } = {}) {
  const paper = await readTrades(storage, (t) => t.environment === 'paper');
  const { trades, duplicates } = dedupeTrades(paper);
  const thisYear = trades.filter((t) => String(t.entry?.time || '').startsWith(String(year)));
  const byStrategy = {};
  for (const t of thisYear) (byStrategy[t.strategy] ||= []).push(t);
  const rows = Object.entries(byStrategy).map(([strategy, list]) => {
    const s = summarize(list);
    const hist = results.flatMap((r) => r.rows.filter((x) => x.strategy === strategy && x.rankable).map((x) => ({ dataset: r.dataset, key: x.key, oos_expectancy_r: x.oos.expectancy_r, oos_trades: x.oos.trades })));
    return { strategy, paper_trades: s.trades, paper_expectancy_r: s.expectancy_r, paper_net_pnl: s.net_pnl, resolution: [...new Set(list.map((t) => t.data?.resolution || 'daily'))], historical: hist.slice(0, 6) };
  });
  return { year, paper_trades: thisYear.length, duplicates_removed: duplicates, rows };
}

// ─── Paper signals (journalled, never ordered) ───────────────────────────

export async function journalSignals(storage, result, { now = Date.now(), top = 5 } = {}) {
  const list = (await storage.get(HI_SIGNALS)) || [];
  const seen = new Set(list.map((s) => s.id));
  const added = [];
  for (const key of result.ranking.slice(0, top)) {
    const row = result.rows.find((r) => r.key === key);
    if (!row?.pending_signal) continue;
    const id = `${result.dataset}|${key}|${row.pending_signal.time}`;
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({
      id, created_at: iso(now), dataset: result.dataset, strategy: row.strategy, name: row.name, filter: row.filter, target_r: row.target_r,
      ...row.pending_signal, fills: 'next daily open, paper only',
      evidence: { rank: row.rank, oos_trades: row.oos.trades, oos_expectancy_r: row.oos.expectancy_r, oos_expectancy_r_95ci: row.oos.expectancy_r_95ci },
      status: row.edge_shown
        ? 'Paper signal. Its daily out-of-sample result is positive, but daily bars cannot promote a strategy: no order is placed.'
        : 'Paper signal for research. This strategy has not shown an edge out of sample: no order is placed.',
    });
  }
  if (added.length) await storage.put(HI_SIGNALS, [...list, ...added].slice(-SIGNAL_LIMIT));
  return added;
}

// ─── The run: resumable steps, so no single call does too much ───────────

export async function readState(storage) {
  return (await storage.get(HI_STATE)) || { status: 'never run', runs: 0 };
}

export async function startStudy(storage, { now = Date.now(), who = 'owner' } = {}) {
  const state = await readState(storage);
  if (state.status === 'running') return { started: false, state };
  const next = {
    status: 'running', run_id: `hist-${iso(now)}`, started_at: iso(now), started_by: who, runs: (state.runs || 0) + 1,
    queue: [...DATASET_ORDER.map((id) => `ingest:${id}`), ...DATASET_ORDER.map((id) => `test:${id}`), 'compare'],
    done: [], datasets: {}, errors: [], last_finished_at: state.last_finished_at || null,
  };
  await storage.put(HI_STATE, next);
  return { started: true, state: next };
}

async function step(storage, state, { fetcher, now, load }) {
  const job = state.queue[0];
  const [kind, id] = job.split(':');
  if (kind === 'ingest') {
    const manifest = await ingestDataset(storage, id, { fetcher, now, load });
    state.datasets[id] = manifest;
    if (!manifest.ok) state.errors.push(`${id}: ${manifest.error}`);
  } else if (kind === 'test') {
    const manifest = state.datasets[id];
    if (manifest?.ok) {
      const bars = await loadBars(storage, id);
      const result = studyDataset(DATASETS[id], manifest, bars, { recentYear: new Date(now).getUTCFullYear() });
      await storage.put(`${RESULT_PREFIX}${id}`, { ...result, run_id: state.run_id, at: iso(now) });
      if (id === 'MNQ') state.signals_added = (await journalSignals(storage, result, { now })).length;
    }
  } else if (kind === 'compare') {
    const results = await readResults(storage);
    await storage.put(`${RESULT_PREFIX}compare`, await compareWithPaper(storage, results, { year: new Date(now).getUTCFullYear() }));
  }
  state.queue.shift();
  state.done.push(job);
}

/** Runs queued steps until done or the time budget is spent. Safe to call again: it resumes. */
export async function studyStep(storage, { fetcher = fetch, now = Date.now(), budgetMs = 20_000, load = fetchDaily } = {}) {
  const state = await readState(storage);
  if (state.status !== 'running') return state;
  const started = Date.now();
  const doneBefore = state.done.length;
  // At least one step per call, so a short budget still makes progress.
  while (state.queue.length && (state.done.length === doneBefore || Date.now() - started < budgetMs)) {
    try { await step(storage, state, { fetcher, now, load }); }
    catch (error) {
      state.errors.push(`${state.queue[0]}: ${String(error?.message || error).slice(0, 160)}`);
      state.done.push(state.queue.shift());
    }
    await storage.put(HI_STATE, state);
  }
  if (!state.queue.length) {
    state.status = 'complete';
    state.finished_at = iso(now);
    state.last_finished_at = state.finished_at;
    await storage.put(HI_STATE, state);
  }
  return state;
}

/** The Worker alarm: finishes a study in progress, and refreshes a finished one once a day. No model, no money. */
export async function studyAlarm(storage, { fetcher = fetch, now = Date.now() } = {}) {
  const state = await readState(storage);
  if (state.status === 'never run') return null;
  if (state.status !== 'running') {
    if (state.last_finished_at && now - Date.parse(state.last_finished_at) < RERUN_MS) return null;
    await startStudy(storage, { now, who: 'daily refresh' });
  }
  return studyStep(storage, { fetcher, now, budgetMs: 10_000 });
}

export async function readResults(storage) {
  const out = [];
  for (const id of DATASET_ORDER) {
    const r = await storage.get(`${RESULT_PREFIX}${id}`);
    if (r) out.push(r);
  }
  return out;
}

// ─── Dashboard view and the auditable report ─────────────────────────────

const rowView = (r) => r && ({
  key: r.key, rank: r.rank ?? null, name: r.name, strategy: r.strategy, filter: r.filter_name, target_r: r.target_r,
  oos: r.oos, all: r.all, recent: r.recent, folds_positive: r.folds_positive, folds_total: r.folds_total,
  edge_shown: r.edge_shown, rankable: r.rankable, regimes: r.regimes,
});

export async function intelligenceView(storage) {
  const state = await readState(storage);
  const results = await readResults(storage);
  const compare = (await storage.get(`${RESULT_PREFIX}compare`)) || null;
  const intraday = await storage.get(LIVE_BACKTEST);
  const signals = ((await storage.get(HI_SIGNALS)) || []).slice(-10).reverse();
  return {
    version: HI_VERSION, engine_version: ENGINE_VERSION,
    state: { status: state.status, run_id: state.run_id || null, started_at: state.started_at || null, finished_at: state.finished_at || null, done: state.done?.length || 0, total: (state.done?.length || 0) + (state.queue?.length || 0), errors: state.errors || [] },
    datasets: DATASET_ORDER.map((id) => state.datasets?.[id] || { id, label: DATASETS[id].label, provider_symbol: DATASETS[id].provider_symbol, ok: false, error: 'not fetched yet' }),
    results: results.map((r) => ({
      dataset: r.dataset, at: r.at, configs: r.configs, ranked: r.ranking.length,
      edge_shown: r.rows.filter((x) => x.edge_shown).length,
      leakage: Object.fromEntries(Object.entries(r.leakage).map(([k, v]) => [k, v.ok])),
      top: r.ranking.slice(0, 5).map((k) => rowView(r.rows.find((x) => x.key === k))),
    })),
    intraday: intraday?.ok ? { at: intraday.at, data: intraday.data, bars: intraday.bars, top: (intraday.rows || []).slice(0, 5).map((x) => ({ name: x.name, family: x.family, filter: x.filter, target_r: x.target_r, trades: x.stats?.trades, oos_trades: x.oos?.trades, oos_expectancy_r: x.oos?.expectancy_r })) } : null,
    compare, signals, not_tested: NOT_TESTED_DAILY,
    safety: 'Research and paper only. No order is sent, nothing is bought, and real-money trading stays disabled.',
  };
}

export async function intelligenceReport(storage) {
  const view = await intelligenceView(storage);
  const results = await readResults(storage);
  return {
    title: 'CHE historical trading intelligence report',
    ...view,
    method: {
      engine: `trading_evidence.js stepPortfolio (${ENGINE_VERSION}), unchanged`,
      fills: 'Signal on a closed daily bar; market fill at the next open with half the spread and slippage; stop checked before target inside one bar; a plan whose next open is already past its stop or target is skipped.',
      costs: COSTS,
      leakage: 'Each rule rerun with every bar after the 70% point removed, and again with those bars changed; trades closed before that point must be identical.',
      walk_forward: `Anchored: first ${MIN_TRAIN * 100}% of bars train, then ${FOLDS} consecutive out-of-sample windows. Rules and parameters are fixed in code before the run; nothing is fitted.`,
      ranking: `Out-of-sample only: the low end of the 95% range of expectancy in R, with at least ${MIN_TRADES} out-of-sample trades and a passing leakage audit. Daily evidence can rank, never promote.`,
      multiple_testing: `${configs().length} configurations per dataset are tried, so some will look good by luck. "Edge shown" means the 95% range of out-of-sample expectancy stays above zero, which is still not proof.`,
      datasets: 'MNQ and NQ are the same Nasdaq-100 futures and are never added together. NDX is a labelled index proxy.',
    },
    results: results.map((r) => ({ ...r, trades: r.trades })),
  };
}

// ─── Questions, by voice or typing, answered from stored tests only ──────

export function intelligenceIntent(message) {
  const text = String(message || '');
  const history = /\b(?:historical(?:ly)?|history|since (?:19|20)\d\d|decades?|trading intelligence|dirty\s*trez)\b/i;
  // Method words alone are a general question ("is walk forward testing better than..."): the Knowledge Atlas
  // answers those. They reach the study only when asked about CHE's own results.
  const method = /\b(?:walk[\s-]*forward|out[\s-]*of[\s-]*sample|regimes?|look[\s-]*ahead|leakage)\b/i.test(text) && /\b(?:your|you|che'?s)\b/i.test(text);
  const trading = /\b(?:strateg\w*|nq|mnq|nasdaq|trad\w*|ict|smart money|vwap|orb|opening range|ema|backtest\w*|signals?|dirty\s*trez)\b/i;
  if (!(history.test(text) || method) || !trading.test(text)) return null;
  if (/\bdirty\s*trez\b/i.test(text)) return { kind: 'dirty' };
  if (/\b(?:run|start|begin|refresh|update|redo|re-?run|kick off)\b[\s\S]{0,40}\b(?:study|test\w*|backtest\w*|analysis|intelligence|history)\b/i.test(text)) return { kind: 'run' };
  if (/\bsignals?\b/i.test(text)) return { kind: 'signals' };
  if (/\b(?:report|audit|checksums?|data ?sets?|sources?)\b/i.test(text)) return { kind: 'report' };
  if (/\bregimes?\b/i.test(text)) return { kind: 'regimes' };
  return { kind: 'summary' };
}

const R = (x) => `${x >= 0 ? '' : 'minus '}${Math.abs(x).toFixed(2)} R`;

export function speakIntelligence(view, kind = 'summary') {
  const lines = [];
  if (kind === 'dirty') {
    return `${NOT_TESTED_DAILY[1].why} No Dirty Trez result exists, sir.`;
  }
  if (view.state.status === 'never run') {
    return 'No historical study has run yet, sir. Say "run the historical study" and I will fetch the free Nasdaq-100 histories, verify them and test every daily strategy. It costs nothing and places no orders.';
  }
  if (view.state.status === 'running') lines.push(`The historical study is running: ${view.state.done} of ${view.state.total} steps done.`);
  else lines.push(`The last historical study finished ${view.state.finished_at?.slice(0, 10) || 'recently'}.`);
  if (kind === 'report') {
    for (const d of view.datasets) {
      lines.push(d.ok
        ? `${d.label}: ${d.bars} daily bars from ${d.from.slice(0, 10)} to ${d.to.slice(0, 10)}, ${d.provider_symbol}, ${d.adjustment}; ${d.gaps.count} gaps and ${d.jumps.count} large opening jumps recorded; checksum ${d.checksum_sha256.slice(0, 12)}.${d.start_note ? ` ${d.start_note}` : ''}`
        : `${d.label}: not verified (${d.error || 'unknown'}).`);
    }
  }
  if (kind === 'signals') {
    if (!view.signals.length) lines.push('No paper signal has been journalled yet.');
    view.signals.slice(0, 5).forEach((s, i) => lines.push(`${i + 1}, ${s.name} (${s.filter}, ${s.target_r} R): ${s.side} from the ${s.time.slice(0, 10)} close, stop ${s.stop}, target ${s.target}. ${s.status}`));
    return lines.join('\n');
  }
  for (const r of view.results) {
    const d = view.datasets.find((x) => x.id === r.dataset);
    const leaks = Object.entries(r.leakage).filter(([, ok]) => !ok).map(([k]) => k);
    lines.push(`${d?.label || r.dataset}: ${r.configs} configurations tested${d?.ok ? ` on ${d.bars} days from ${d.from.slice(0, 4)}` : ''}. ${leaks.length ? `Leakage audit failed for ${leaks.join(', ')}, so they are not ranked.` : 'Every rule passed the look-ahead audit.'} ${r.ranked} had enough out-of-sample trades to rank; ${r.edge_shown ? `${r.edge_shown} showed an out-of-sample edge` : 'none showed an out-of-sample edge'}.`);
    const best = r.top[0];
    if (best) {
      lines.push(`  Best measured: ${best.name}, ${best.filter}, ${best.target_r} R: ${best.oos.trades} out-of-sample trades, ${R(best.oos.expectancy_r)} per trade (95% range ${R(best.oos.expectancy_r_95ci.low)} to ${R(best.oos.expectancy_r_95ci.high)}), ${best.folds_positive} of ${best.folds_total} windows profitable.`);
      if (kind === 'regimes') {
        for (const [name, g] of Object.entries({ ...best.regimes.trend, ...best.regimes.volatility })) lines.push(`    ${name}: ${g.trades} trades, ${R(g.expectancy_r)} per trade.`);
      }
    }
  }
  if (view.intraday) lines.push(`Intraday rules (VWAP, opening range, EMA, ICT 5-minute) come from the five-minute research of ${view.intraday.at.slice(0, 10)}: about 60 days of free data, a small sample.`);
  if (view.compare) lines.push(`This year's paper journal holds ${view.compare.paper_trades} trades after removing ${view.compare.duplicates_removed} duplicates.`);
  lines.push('No strategy is promoted from daily history, and nothing is traded with real money.');
  return lines.join('\n');
}
