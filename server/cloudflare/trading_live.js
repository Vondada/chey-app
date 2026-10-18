// Forward paper trading on intraday NQ/MNQ bars (owner, 2026-10-18): the same evidence
// engine as the daily research (trading_evidence.js), stepped every minute on the
// Worker's alarm while paper trading is on, so closing the iPhone does not stop it.
//
// Paper only: nothing here can reach a broker. Every portfolio is a research source
// ('paper' or 'backtest'), which newPortfolio refuses to change, and no broker module is
// imported. Every number shown is computed from the journal; a trade is reported only
// once its record exists.
import { aggregate, cmeSession, frontMonth, liveFeedBlocker, loadIntraday } from './market_feed.js';
import {
  CONTRACTS, COSTS, INTRADAY_CANDIDATES, INTRADAY_COMMON_RULES, INTRADAY_FILTERS, MIN_TRADES, appendTrades, breakdown, candleProblems,
  evaluateWalkForward, intradayContext, newPortfolio, readTrades, stepPortfolio, summarize, validateTradeRecord,
} from './trading_evidence.js';

export const LIVE_STATE = 'live_paper_state';
export const LIVE_PORTFOLIOS = 'live_paper_portfolios';
export const LIVE_RUNS = 'live_paper_runs';
export const LIVE_FEED = 'live_paper_feed';
export const LIVE_BACKTEST = 'live_paper_backtest';
// Records that never count as forward results but are never thrown away: a closed trade the
// journal refused, and a position voided because paper trading was stopped while it was open.
export const LIVE_EXCLUDED = 'live_paper_excluded';
const EXCLUDED_LIMIT = 500;
export const RESOLUTION = '5m';
const ROOT = 'MNQ';
const RUN_LIMIT = 120;
const CHART_BARS = 180;
const r2 = (x) => Math.round(x * 100) / 100;

// The portfolio grid: every intraday strategy with and without the trend filter, plus
// different targets for two of them, each in its own isolated portfolio.
export function liveSpecs() {
  const out = [];
  for (const c of Object.keys(INTRADAY_CANDIDATES)) {
    for (const f of Object.keys(INTRADAY_FILTERS)) out.push({ c, f, target_r: c === 'rsi-revert-5m' ? 1.5 : 2 });
  }
  for (const c of ['fvg-retest-5m', 'sweep-mss-5m']) for (const target_r of [1.5, 3]) out.push({ c, f: 'any', target_r });
  return out;
}

const seriesName = (source) => `Yahoo ${source === 'backtest' ? 'MNQ=F 5-minute history' : 'MNQ=F 1-minute bars to 5 minutes'} (DELAYED)`;
function freshPortfolio(spec, source = 'paper') {
  const pf = newPortfolio(spec.c, spec.f, { contract: 'MNQ', qty: 1, source, resolution: RESOLUTION, priceSeries: seriesName(source), params: { target_r: spec.target_r } });
  pf.signals = [];
  return pf;
}

export async function readLivePortfolios(storage) {
  const saved = (await storage.get(LIVE_PORTFOLIOS)) || {};
  return liveSpecs().map((spec) => {
    const fresh = freshPortfolio(spec);
    return saved[fresh.key] ? { signals: [], ...saved[fresh.key] } : fresh;
  });
}

async function exclude(storage, entries) {
  if (!entries.length) return;
  const list = (await storage.get(LIVE_EXCLUDED)) || [];
  await storage.put(LIVE_EXCLUDED, [...list, ...entries].slice(-EXCLUDED_LIMIT));
}

/**
 * Paper trading on or off, by the owner. Stopping keeps every record; an open position is
 * voided at that moment with its reason (it is never closed later at a price from after the
 * stop). Starting again begins at the newest bar, so the stopped period is never traded.
 */
export async function setLivePaper(storage, enabled, now = Date.now()) {
  const state = (await storage.get(LIVE_STATE)) || {};
  const saved = (await storage.get(LIVE_PORTFOLIOS)) || null;
  if (saved && (!enabled || !state.enabled)) {
    const voided = [];
    for (const pf of Object.values(saved)) {
      if (!enabled && pf.open) voided.push({ kind: 'voided', at: new Date(now).toISOString(), portfolio: pf.key, strategy: pf.candidate, open: pf.open, reason: 'paper trading was stopped while this position was open; it was not closed at a market price and is not a result' });
      if (!enabled) { pf.open = null; pf.pending = null; }
      if (enabled) { pf.last_bar_time = null; pf.pending = null; pf.open = null; }
    }
    await exclude(storage, voided);
    await storage.put(LIVE_PORTFOLIOS, saved);
  }
  const next = enabled
    ? { ...state, enabled: true, started_at: state.enabled ? state.started_at : new Date(now).toISOString(), stopped_at: null }
    : { ...state, enabled: false, stopped_at: new Date(now).toISOString() };
  await storage.put(LIVE_STATE, next);
  return next;
}

/** When the next minute pass is due, or null when paper trading is off. */
export async function nextLiveTickAt(storage, now = Date.now()) {
  const state = await storage.get(LIVE_STATE);
  if (!state?.enabled) return null;
  return now + (cmeSession(now).open ? 60_000 : 15 * 60_000);
}

// Facts measured from the bars after a closed trade; anything about *why* price moved is
// labelled a hypothesis. Written once, when the trade closes, and never rewritten.
export function postTradeReview(t) {
  const facts = [];
  const hypotheses = [];
  const risk = t.risk_points || 0;
  facts.push(`Entry rule: ${t.signal.why}. Filled at ${t.entry.fill} (bar open ${t.entry.raw}) at ${t.entry.time}.`);
  facts.push(t.exit.reason === 'target' ? `The target ${t.target} was reached.` : t.exit.reason === 'stop' ? `The stop ${t.stop} was hit.`
    : t.exit.note ? `Closed at ${t.exit.raw} at ${t.exit.time}: ${t.exit.note}.` : `Closed on the time rule at ${t.exit.raw} (flat before the CME daily break).`);
  facts.push(`Best move in favour ${t.mfe_points} points (${t.mfe_r} R); worst against ${t.mae_points} points (${t.mae_r} R).`);
  const costs = t.costs.spread + t.costs.slippage + t.costs.commissions + t.costs.fees;
  facts.push(`Costs ${r2(costs)} dollars on ${t.qty} ${t.contract}; gross ${t.gross_before_costs}, net ${t.net_pnl}.`);
  if (t.same_bar_both_touched) facts.push('One bar touched both stop and target; the stop was assumed first (conservative).');
  if (t.result === 'loss' && t.mfe_r >= 1) hypotheses.push('Price moved at least 1 R in favour before reversing: a closer target or a break-even stop may have kept a winner (to be tested, not assumed).');
  if (t.result === 'loss' && t.mfe_r < 0.3) hypotheses.push('Price went against the entry almost at once: the setup may have been early or against the larger trend.');
  if (Math.abs(t.gross_before_costs) > 0 && costs >= Math.abs(t.gross_before_costs) * 0.5) hypotheses.push('Costs were half or more of the gross move: a wider stop and target, or NQ instead of MNQ, would change this result.');
  if (t.condition?.volatility === 'high-vol') hypotheses.push('Volatility was high when the signal formed.');
  return { complied: true, compliance: 'Entered and exited by the engine from the written rules, with no manual change.', rule_summary: INTRADAY_CANDIDATES[t.strategy]?.rules || '', facts, hypotheses, risk_points: risk, written_at: t.exit.time };
}

const feedOf = (feed) => ({ status: feed.status, provider: feed.provider, provider_symbol: feed.provider_symbol, contract: feed.contract, latency_s: feed.latency_s ?? null, last_bar_time: feed.last_bar_time ?? null });

/**
 * One forward-paper pass: newest closed bars, each portfolio stepped from where it
 * stopped, closed trades journalled (validated, append-only), state saved, run logged.
 */
export async function liveTick(storage, { fetcher = fetch, now = Date.now(), force = false, load = loadIntraday } = {}) {
  const state = (await storage.get(LIVE_STATE)) || {};
  if (!state.enabled && !force) return { skipped: 'paper trading is off' };
  const runs = (await storage.get(LIVE_RUNS)) || [];
  const last = runs[runs.length - 1];
  const session = cmeSession(now);
  const gap = session.open ? 50_000 : 14 * 60_000;
  if (!force && last && now - Date.parse(last.at) < gap) return { ...last, skipped: 'ran recently' };
  const run = { at: new Date(now).toISOString(), session: session.state, ok: false };
  try {
    const feed = await load(ROOT, { fetcher, now });
    run.feed = feedOf(feed);
    if (feed.status === 'UNAVAILABLE') {
      run.error = feed.error;
      await storage.put(LIVE_FEED, { ...feedOf(feed), error: feed.error, checked_at: feed.checked_at, session, bars: ((await storage.get(LIVE_FEED)) || {}).bars || [] });
    } else {
      const bars = aggregate(feed.candles, 5, now);
      const problems = candleProblems(bars);
      if (problems.length) {
        run.error = `data refused: ${problems.join('; ')}`;
      } else {
        const ctx = intradayContext(bars);
        const portfolios = await readLivePortfolios(storage);
        const newest = bars[bars.length - 1].t;
        // Forward only: a new portfolio starts at the newest closed bar, so history is never journalled as paper.
        for (const pf of portfolios) if (pf.last_bar_time == null) Object.assign(pf, { last_bar_time: newest, started_from: newest });
        const closed = [];
        for (const pf of portfolios) {
          pf.feed = feedOf(feed);
          const before = pf.counts.signals;
          closed.push(...stepPortfolio(pf, bars, ctx));
          run.signals = (run.signals || 0) + pf.counts.signals - before;
        }
        const valid = [];
        const rejected = [];
        for (const t of closed) {
          t.review = postTradeReview(t);
          const p = validateTradeRecord(t);
          if (p.length) rejected.push({ portfolio: t.portfolio, entry: t.entry.time, problems: p, trade: t });
          else valid.push(t);
        }
        run.journal = await appendTrades(storage, valid);
        // A closed trade the journal refused is kept with its reason, never silently dropped.
        await exclude(storage, rejected.map((r) => ({ kind: 'rejected', at: run.at, ...r })));
        await storage.put(LIVE_PORTFOLIOS, Object.fromEntries(portfolios.map((pf) => [pf.key, pf])));
        await storage.put(LIVE_FEED, { ...feedOf(feed), checked_at: feed.checked_at, session, delayed_by_min: feed.delayed_by_min ?? null, note: feed.note, bars: bars.slice(-CHART_BARS) });
        Object.assign(run, { ok: true, bars: bars.length, last_bar: newest, closed: closed.length, rejected: rejected.length, rejections: rejected.slice(0, 3).map(({ trade, ...r }) => r), open_positions: portfolios.filter((pf) => pf.open).length });
      }
    }
  } catch (error) {
    run.error = String(error?.message || error).slice(0, 200);
  }
  await storage.put(LIVE_RUNS, [...runs, run].slice(-RUN_LIMIT));
  if (!state.first_run_at && run.ok) await storage.put(LIVE_STATE, { ...state, first_run_at: run.at });
  return run;
}

const isLive = (t) => t.environment === 'paper' && t.data?.resolution === RESOLUTION;

/** Historical baseline on Yahoo's 5-minute history: same rules, same fills, out-of-sample folds. */
export async function liveBacktest(storage, { fetcher = fetch, now = Date.now(), load = loadIntraday } = {}) {
  const feed = await load(ROOT, { fetcher, now, range: '30d', interval: '5m' });
  if (feed.status === 'UNAVAILABLE' || !feed.candles?.length) {
    const failed = { at: new Date(now).toISOString(), ok: false, error: feed.error || 'no history' };
    await storage.put(LIVE_BACKTEST, failed);
    return failed;
  }
  const bars = feed.interval === '5m' ? feed.candles : aggregate(feed.candles, 5, now);
  const ctx = intradayContext(bars);
  const rows = [];
  for (const spec of liveSpecs()) {
    const pf = freshPortfolio(spec, 'backtest');
    const trades = stepPortfolio(pf, bars, ctx);
    const s = summarize(trades);
    const wf = evaluateWalkForward(trades, { folds: 4, minTrain: 0.4 });
    rows.push({ portfolio: pf.key, strategy: spec.c, filter: spec.f, target_r: spec.target_r, name: INTRADAY_CANDIDATES[spec.c].name,
      family: INTRADAY_CANDIDATES[spec.c].family, stats: s, oos: wf.oos ? summarize(wf.oos) : null, folds_positive: wf.folds_positive, folds: wf.folds_total,
      sample: trades.slice(-3).map((t) => ({ side: t.side, entry: t.entry.time, exit: t.exit.time, reason: t.exit.reason, net: t.net_pnl })) });
  }
  rows.sort((a, b) => b.stats.expectancy_r - a.stats.expectancy_r);
  const result = { at: new Date(now).toISOString(), ok: true, data: `${feed.provider} ${feed.provider_symbol}, ${bars.length} five-minute bars ${bars[0].t} to ${bars[bars.length - 1].t} (DELAYED public data)`, costs: COSTS, rows };
  await storage.put(LIVE_BACKTEST, result);
  return result;
}

function unrealized(pf, lastClose) {
  const o = pf.open;
  if (!o || !Number.isFinite(lastClose)) return null;
  const pv = CONTRACTS[pf.contract].pointValue * pf.qty;
  const pts = o.side === 'short' ? o.entry.price - lastClose : lastClose - o.entry.price;
  return r2(pts * pv);
}

/** Everything the Trading Room shows, from records only. */
export async function liveDashboard(storage, { now = Date.now(), tradovateConnected = false } = {}) {
  const [state, feed, runs, portfolios, backtest] = await Promise.all([
    storage.get(LIVE_STATE), storage.get(LIVE_FEED), storage.get(LIVE_RUNS), readLivePortfolios(storage), storage.get(LIVE_BACKTEST),
  ]);
  const trades = await readTrades(storage, isLive);
  const lastClose = feed?.bars?.length ? feed.bars[feed.bars.length - 1].c : null;
  const positions = portfolios.filter((pf) => pf.open).map((pf) => ({
    portfolio: pf.key, strategy: pf.candidate, name: INTRADAY_CANDIDATES[pf.candidate]?.name, filter: pf.filter, side: pf.open.side,
    entry_time: pf.open.entry_time, entry: pf.open.entry.price, stop: pf.open.stop, target: pf.open.target, why: pf.open.signal_why,
    unrealized: unrealized(pf, lastClose), contract: pf.contract, qty: pf.qty,
  }));
  const signals = portfolios.flatMap((pf) => (pf.signals || []).map((s) => ({ ...s, strategy: pf.candidate, portfolio: pf.key }))).sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(-60);
  const byStrategy = Object.entries(breakdown(trades, (t) => `${t.strategy}|${t.filter}|${t.params?.target_r}`)).map(([key, s]) => {
    const [strategy, filter, target] = key.split('|');
    return { strategy, filter, target_r: Number(target), name: INTRADAY_CANDIDATES[strategy]?.name || strategy, family: INTRADAY_CANDIDATES[strategy]?.family || '', ranked: s.trades >= MIN_TRADES, ...s };
  }).sort((a, b) => b.expectancy_r - a.expectancy_r);
  const counts = portfolios.reduce((o, pf) => ({ signals: o.signals + pf.counts.signals, filled: o.filled + pf.counts.filled, skipped: o.skipped + pf.counts.gap_skipped }), { signals: 0, filled: 0, skipped: 0 });
  return {
    account: 'PAPER',
    isolation: 'Paper portfolios are research records only. No broker module is reachable from this engine, and live orders stay disabled.',
    state: state || { enabled: false },
    session: cmeSession(now),
    contract: frontMonth(ROOT, now),
    feed: feed ? { ...feed, bars: undefined } : null,
    feed_blocker: liveFeedBlocker({ tradovateConnected }),
    bars: feed?.bars || [],
    signals,
    positions,
    trades: trades.slice(-200).reverse(),
    totals: summarize(trades),
    counts,
    by_strategy: byStrategy,
    by_session: breakdown(trades, (t) => t.session),
    by_day: breakdown(trades, (t) => String(t.entry.time).slice(0, 10)),
    strategies: Object.entries(INTRADAY_CANDIDATES).map(([id, c]) => ({ id, name: c.name, family: c.family, rules: c.rules })),
    common_rules: INTRADAY_COMMON_RULES,
    excluded: ((await storage.get(LIVE_EXCLUDED)) || []).slice(-20).reverse().map(({ trade, open, ...e }) => ({ ...e, strategy: e.strategy || trade?.strategy })),
    portfolios: portfolios.length,
    runs: (runs || []).slice(-10).reverse(),
    backtest: backtest || null,
    min_trades: MIN_TRADES,
  };
}
