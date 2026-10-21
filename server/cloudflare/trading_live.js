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
  evaluateWalkForward, intradayContext, newPortfolio, readTrades, stepPortfolio, summarize, validateTradeRecord, tradeDayOf,
} from './trading_evidence.js';
import { makeEntryGate, readControls } from './trading_controls.js';
import { readDelayedTraining, resetDelayedTraining, runDelayedTraining } from './trading_delayed_training.js';

export const LIVE_STATE = 'live_paper_state';
export const LIVE_PORTFOLIOS = 'live_paper_portfolios';
export const LIVE_RUNS = 'live_paper_runs';
export const LIVE_FEED = 'live_paper_feed';
export const LIVE_BACKTEST = 'live_paper_backtest';
export const LIVE_RESEARCH_PREFIX = 'live_research_run:';
const RESEARCH_LAST = 'live_research_last_success';
const RESEARCH_ATTEMPT = 'live_research_attempt';
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
  pf.skips = [];
  return pf;
}

export async function readLivePortfolios(storage) {
  const saved = (await storage.get(LIVE_PORTFOLIOS)) || {};
  return liveSpecs().map((spec) => {
    const fresh = freshPortfolio(spec);
    return saved[fresh.key] ? { signals: [], skips: [], ...saved[fresh.key] } : fresh;
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
  if (Boolean(state.enabled) !== Boolean(enabled)) await resetDelayedTraining(storage, { now });
  return next;
}

/** When the next minute pass is due, or null when paper trading is off. */
/**
 * Emergency Stop and Flatten on the forward-paper portfolios. Emergency Stop cancels every order
 * that has not filled (a pending signal) and lists the positions that stay open with their stops
 * and targets; Flatten (owner-confirmed) also closes the open positions as voided records, never
 * at an invented price. Nothing is deleted: each cancelled or voided item is kept with its reason.
 */
export async function haltLivePaper(storage, { flatten = false, now = Date.now(), reason = 'Emergency Stop' } = {}) {
  const saved = (await storage.get(LIVE_PORTFOLIOS)) || {};
  const at = new Date(now).toISOString();
  const cancelled = []; const voided = []; const open = [];
  for (const pf of Object.values(saved)) {
    if (pf.pending) {
      cancelled.push({ kind: 'cancelled', at, portfolio: pf.key, strategy: pf.candidate, pending: pf.pending, reason: `${reason}: the order had not filled` });
      pf.pending = null;
    }
    if (pf.open && flatten) {
      voided.push({ kind: 'voided', at, portfolio: pf.key, strategy: pf.candidate, open: pf.open, reason: 'flattened by the owner; closed without a market price, so it is not a result' });
      pf.open = null;
    } else if (pf.open) {
      open.push({ portfolio: pf.key, strategy: pf.candidate, filter: pf.filter, side: pf.open.side, entry: pf.open.entry?.raw ?? null, stop: pf.open.stop, target: pf.open.target, qty: pf.qty, contract: pf.contract });
    }
  }
  await exclude(storage, [...cancelled, ...voided]);
  if (cancelled.length || voided.length) await storage.put(LIVE_PORTFOLIOS, saved);
  return { cancelled: cancelled.length, flattened: voided.length, open };
}

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

const feedOf = (feed) => ({ authenticated: Boolean(feed.authenticated), subscription_verified: Boolean(feed.subscription_verified), status: feed.status, provider: feed.provider, provider_symbol: feed.provider_symbol, contract: feed.contract, latency_s: feed.latency_s ?? null, last_bar_time: feed.last_bar_time ?? null });

// Closed 5-minute bars for the engine. A verified provider stream already delivers closed 5-minute
// bars (Tradovate MinuteBar, elementSize 5), kept only once their 5 minutes are over; Yahoo's
// 1-minute bars are summed into 5 minutes, volume included.
function closedFiveMinuteBars(feed, now) {
  if (feed.interval === RESOLUTION) return feed.candles.filter((b) => Date.parse(b.t) + 300000 <= now);
  const bars = aggregate(feed.candles, 5, now);
  return bars;
}

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
      const bars = closedFiveMinuteBars(feed, now);
      const problems = candleProblems(bars);
      if (problems.length) {
        run.error = `data refused: ${problems.join('; ')}`;
      } else {
        const ctx = intradayContext(bars);
        const portfolios = await readLivePortfolios(storage);
        const newest = bars[bars.length - 1].t;
        // Forward only: a new portfolio starts at the newest closed bar, so history is never journalled as paper.
        for (const pf of portfolios) if (pf.last_bar_time == null) Object.assign(pf, { last_bar_time: newest, started_from: newest });
        // Two entry gates, both required: the real-time evidence gate (a delayed, replayed, stale or
        // unsubscribed feed opens nothing) and the owner's controls (trading_controls.js).
        const barAge = now - Date.parse(newest) - 300000;
        const allowEntries = barAge >= 0 && barAge <= 90000 && feed.status === 'LIVE' && feed.authenticated === true && feed.subscription_verified === true && Number.isFinite(feed.latency_s) && feed.latency_s <= 15;
        run.entries_allowed = allowEntries;
        run.entry_blocker = allowEntries ? null : 'New forward-paper entries require fresh authenticated and subscribed real-time CME delivery. Delayed/replay/stale data cannot open positions.';
        // The owner's controls (trading_controls.js) decide whether a valid signal may enter.
        const controls = await readControls(storage);
        const today = tradeDayOf(now);
        const realizedToday = (await readTrades(storage, isLive))
          .filter((t) => tradeDayOf(t.exit?.time || 0) === today).reduce((sum, t) => sum + (Number(t.net_pnl) || 0), 0);
        const gate = makeEntryGate(controls, { realized_today: realizedToday, open_positions: portfolios.filter((pf) => pf.open || pf.pending).length });
        const closed = [];
        run.missed_windows = portfolios.filter((pf) => pf.last_bar_time && pf.last_bar_time < bars[0].t).length;
        for (const pf of portfolios) {
          pf.feed = feedOf(feed);
          // A size change applies from the next entry, never to an open position or a placed order.
          if (!pf.open && !pf.pending) pf.qty = controls.strategies[pf.candidate]?.qty || pf.qty;
          const before = pf.counts.signals;
          pf.price_series = `${feed.provider} ${feed.provider_symbol} ${RESOLUTION} (${feed.status})`;
          closed.push(...stepPortfolio(pf, bars, ctx, gate, { allowEntries }));
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
        // Separate chronological DELAYED-bar research: never loosen verified LIVE
        // entry eligibility or mix hypothetical delayed fills with the forward journal.
        if (feed.status === 'DELAYED') {
          try {
            run.delayed_training = await runDelayedTraining(storage, { feed, bars, specs: liveSpecs(), controls, now });
          } catch (error) {
            run.delayed_training = { ok: false, error: String(error?.message || error).slice(0,180) };
          }
        }
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

// One existing research operation at a time; interrupted leases expire without deleting evidence.
export async function liveBacktest(storage, options = {}) {
  const now = options.now ?? Date.now();
  const token = crypto.randomUUID();
  const update = (fn) => storage.transaction ? storage.transaction(fn) : fn(storage);
  const acquired = await update(async (tx) => {
    const lock = await tx.get('live_research_lock');
    if (lock?.token && now - lock.at < 15 * 60000) return false;
    await tx.put('live_research_lock', { token, at: now }); return true;
  });
  if (!acquired) return { ok: false, error: 'Historical research is already running; no duplicate run dispatched.' };
  try {
    await storage.put(RESEARCH_ATTEMPT, { at: new Date(now).toISOString(), status: 'running' });
    const old = await storage.get(LIVE_BACKTEST);
    if (old?.at && !old.id) {
      const key = `${LIVE_RESEARCH_PREFIX}legacy:${old.at}`;
      if (!(await storage.get(key))) await storage.put(key, old);
    }
    const result = await historicalReplay(storage, options);
    // Inside the lease, so no replay is writing chunks while unreferenced ones are removed.
    await pruneResearch(storage, { now }).catch((error) => console.error('Research retention failed:', error?.message || error));
    await storage.put(RESEARCH_ATTEMPT, { at: new Date(now).toISOString(), status: result.ok ? 'complete' : 'failed', experiment_id: result.id || null, reused: Boolean(result.reused), error: result.error || null });
    return result;
  }
  finally { await update(async (tx) => { if ((await tx.get('live_research_lock'))?.token === token) await tx.put('live_research_lock', { token: null, at: now, finished_at: new Date().toISOString() }); }); }
}

// Accelerated historical replay uses the same fixed-timeframe engine, never the forward journal.
// Every dataset/configuration has an immutable archive; rerunning it is not new evidence.
async function historicalReplay(storage, { fetcher = fetch, now = Date.now(), load = loadIntraday } = {}) {
  const at = new Date(now).toISOString();
  const fail = async (error) => {
    const result = { at, ok: false, error };
    await storage.put(`${LIVE_RESEARCH_PREFIX}failed:${at}`, result);
    await storage.put(LIVE_BACKTEST, result);
    return result;
  };
  let feed;
  try { feed = await load(ROOT, { fetcher, now, range: '60d', interval: RESOLUTION }); }
  catch (error) { return fail(String(error?.message || error)); }
  if (feed.status === 'UNAVAILABLE' || !feed.candles?.length) return fail(feed.error || 'no history');
  if (feed.interval !== RESOLUTION) return fail('Research requires genuine 5-minute history; no timeframe substitution.');
  const bars = feed.candles;
  const problems = candleProblems(bars);
  if (bars.some((b) => Date.parse(b.t) % 300000 !== 0 || Date.parse(b.t) + 300000 > now)) problems.push('unaligned or forming five-minute bar');
  if (problems.length) return fail(`data refused: ${problems.join('; ')}`);
  const specs = liveSpecs();
  // Explicit parameter experiments: baseline and target-R alternatives, same 5-minute rules.
  for (const c of Object.keys(INTRADAY_CANDIDATES)) for (const target_r of [1.5, 2, 3]) {
    if (!specs.some((x) => x.c === c && x.f === 'any' && x.target_r === target_r)) specs.push({ c, f: 'any', target_r });
  }
  const hex = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (x) => x.toString(16).padStart(2, '0')).join('');
  const dataset_hash = await hex({ provider: feed.provider, symbol: feed.provider_symbol, resolution: RESOLUTION, bars });
  const id = await hex({ dataset_hash, versions: specs.map((spec) => freshPortfolio(spec, 'backtest').strategy_version) });
  const previous = await storage.get(`${LIVE_RESEARCH_PREFIX}${id}`);
  if (previous) { await storage.put(LIVE_BACKTEST, previous); return { ...previous, reused: true }; }
  // Stable six-hour content-addressed chunks reuse the unchanged part of a rolling window.
  // Preserve every experiment and never duplicate its full 60-day candle/outcome payload.
  const chunkRecords = async (records, timeOf, prefix, size) => {
    const groups = new Map();
    for (const record of records) {
      const slot = Math.floor(Date.parse(timeOf(record)) / (6 * 3600000));
      const group = groups.get(slot) || []; group.push(record); groups.set(slot, group);
    }
    const refs = [];
    for (const group of groups.values()) for (let i = 0; i < group.length; i += size) {
      const part = group.slice(i, i + size);
      const key = `${prefix}:${await hex({ provider: feed.provider, symbol: feed.provider_symbol, records: part })}`;
      if (!(await storage.get(key))) await storage.put(key, part);
      refs.push(key);
    }
    return refs;
  };
  if (bars.length > 18000) return fail('Historical data exceeds the bounded 60-day five-minute research window.');
  const dayKey = `live_research_budget:${tradeDayOf(at)}`;
  const budget = (await storage.get(dayKey)) || [];
  if (budget.length >= 2) return fail('Two distinct historical datasets were already studied this research day. Reuse the archived results; no repeated data or forced trades added.');
  const dataset_refs = await chunkRecords(bars, (b) => b.t, 'live_research_data', 72);
  const prior = await storage.get(RESEARCH_LAST);
  const priorBars = prior?.provider === feed.provider && prior?.dataset_refs
    ? (await Promise.all(prior.dataset_refs.map((key) => storage.get(key)))).flat() : [];
  const incremental = priorBars.length > 0 && priorBars.length < bars.length && priorBars.every((bar, i) => JSON.stringify(bar) === JSON.stringify(bars[i]));
  const ctx = intradayContext(bars);
  const rows = [];
  for (const spec of specs) {
    let pf = freshPortfolio(spec, 'backtest');
    let carried = [];
    const earlier = incremental ? prior.rows.find((r) => r.strategy_version === pf.strategy_version) : null;
    if (earlier?.checkpoint_ref && earlier?.outcome_index_ref) {
      const checkpoint = await storage.get(earlier.checkpoint_ref);
      const refs = await storage.get(earlier.outcome_index_ref);
      if (checkpoint && Array.isArray(refs)) {
        pf = checkpoint;
        carried = (await Promise.all(refs.map((key) => storage.get(key)))).flat();
      }
    }
    const trades = [...carried, ...stepPortfolio(pf, bars, ctx)];
    const checkpoint_ref = `live_research_checkpoint:${id}:${pf.strategy_version}`;
    await storage.put(checkpoint_ref, pf);
    const invalid = trades.flatMap((t) => validateTradeRecord(t));
    if (invalid.length) return fail(`experiment records refused: ${invalid.join('; ')}`);
    const wf = evaluateWalkForward(trades, { folds: 4, minTrain: 0.4, barTimes: bars.map((b) => b.t) });
    const split = bars[Math.floor(bars.length * 0.4)]?.t;
    const training = trades.filter((t) => t.exit.time < split);
    // Chunks keep complete provenance/outcomes without exceeding a Durable Object value limit.
    let new_outcomes = 0;
    // Batch evidence I/O; a changed window or target sweep never re-counts a version/entry.
    const keys = await Promise.all(trades.map(async (t) => `live_research_seen:${pf.strategy_version}:${await hex(entryIdentity(t))}`));
    for (let i = 0; i < keys.length; i += 64) {
      const batch = [...new Set(keys.slice(i, i + 64))];
      const existing = await storage.get(batch);
      const additions = Object.fromEntries(batch.filter((key) => !existing.has(key)).map((key) => [key, { first_seen: at, dataset_hash }]));
      new_outcomes += Object.keys(additions).length;
      if (Object.keys(additions).length) await storage.put(additions);
    }
    const studies = await storage.list({ prefix: `live_research_seen:${pf.strategy_version}:` });
    const studied_today = [...studies.values()].filter((v) => tradeDayOf(v.first_seen) === tradeDayOf(at)).length;
    const refs = await chunkRecords(trades, (t) => t.entry.time, 'live_research_trade_chunk', 32);
    const outcome_index_ref = `live_research_outcomes:${id}:${pf.strategy_version}`;
    await storage.put(outcome_index_ref, refs);
    rows.push({ portfolio: pf.key, strategy: spec.c, filter: spec.f, target_r: spec.target_r,
      strategy_version: pf.strategy_version, params: pf.params, counts: pf.counts,
      name: INTRADAY_CANDIDATES[spec.c].name, family: INTRADAY_CANDIDATES[spec.c].family,
      stats: summarize(trades), training: summarize(training), oos: summarize(wf.oos),
      walk_forward: wf.folds, folds_positive: wf.folds_positive, folds: wf.folds_total,
      new_outcomes, studied_today, outcome_index_ref, checkpoint_ref, open_at_end: Boolean(pf.open),
      sample: trades.slice(-3).map((t) => ({ side: t.side, entry: t.entry.time, exit: t.exit.time, reason: t.exit.reason, net: t.net_pnl })) });
  }
  rows.sort((a, b) => b.stats.expectancy_r - a.stats.expectancy_r);
  const result = { id, at, ok: true, dataset_hash, dataset_refs, incremental, resolution: RESOLUTION, target_per_strategy: MIN_TRADES,
    provider: feed.provider, data_quality: feed.status, bars: bars.length, from: bars[0].t, to: bars.at(-1).t,
    data: `${feed.provider} ${feed.provider_symbol}, ${bars.length} five-minute bars ${bars[0].t} to ${bars.at(-1).t} (historical research only)`,
    split_rule: 'First 40% of bars train; four consecutive held-out time windows. Trades crossing fold boundaries excluded from OOS. Parameters fixed before replay; all alternatives retained, not independent samples.',
    costs: COSTS, rows };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 120000) return fail('Research metadata exceeds its bounded record size; no success was recorded.');
  await storage.put(`${LIVE_RESEARCH_PREFIX}${id}`, result);
  await storage.put(dayKey, [...budget, id]);
  await storage.put(RESEARCH_LAST, result);
  await storage.put(LIVE_BACKTEST, result);
  return result;
}

// Retention (bounded storage): the newest RESEARCH_KEEP experiments keep their full candle,
// checkpoint and outcome chunks; older experiments keep their metadata (id, dataset SHA-256,
// parameters, per-version stats) with dataset_retained: false, so results stay auditable and a
// rerun of the same dataset_hash stays reproducible from the provider. Failure logs, daily budgets
// and seen-entry identities that can no longer fall inside the 60-day window are bounded too.
export const RESEARCH_KEEP = 10;
const FAILED_KEEP = 50;
const SEEN_DAYS = 90;
const BUDGET_DAYS = 7;
export async function pruneResearch(storage, { now = Date.now(), keep = RESEARCH_KEEP } = {}) {
  const at = new Date(now).toISOString();
  const drop = async (keys) => { for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128)); };
  const runs = [...(await storage.list({ prefix: LIVE_RESEARCH_PREFIX })).entries()];
  const retained = runs.filter(([, v]) => v?.ok && Array.isArray(v.dataset_refs) && v.dataset_retained !== false)
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)));
  const kept = retained.slice(0, keep).map(([, v]) => v);
  for (const [key, v] of retained.slice(keep)) {
    await storage.put(key, { ...v, dataset_refs: [], dataset_retained: false, data_pruned_at: at,
      rows: (v.rows || []).map((r) => ({ ...r, outcome_index_ref: null, checkpoint_ref: null })) });
  }
  const failed = runs.filter(([key]) => key.startsWith(`${LIVE_RESEARCH_PREFIX}failed:`)).map(([key]) => key).sort();
  await drop(failed.slice(0, Math.max(0, failed.length - FAILED_KEEP)));
  // Everything a kept experiment, the incremental baseline or the shown result still points to.
  const live = [...kept, await storage.get(RESEARCH_LAST), await storage.get(LIVE_BACKTEST)].filter((v) => v?.ok);
  const referenced = new Set();
  for (const v of live) {
    for (const ref of v.dataset_refs || []) referenced.add(ref);
    for (const r of v.rows || []) {
      if (r.checkpoint_ref) referenced.add(r.checkpoint_ref);
      if (r.outcome_index_ref) {
        referenced.add(r.outcome_index_ref);
        for (const ref of (await storage.get(r.outcome_index_ref)) || []) referenced.add(ref);
      }
    }
  }
  let removed = 0;
  for (const prefix of ['live_research_data:', 'live_research_trade_chunk:', 'live_research_outcomes:', 'live_research_checkpoint:']) {
    const stale = [...(await storage.list({ prefix })).keys()].filter((key) => !referenced.has(key));
    await drop(stale); removed += stale.length;
  }
  // An entry first seen 90+ days ago has an entry time older than any 60-day window, so it cannot be re-counted.
  const seen = [...(await storage.list({ prefix: 'live_research_seen:' })).entries()]
    .filter(([, v]) => v?.first_seen && now - Date.parse(v.first_seen) > SEEN_DAYS * 86400000).map(([key]) => key);
  const oldestDay = tradeDayOf(new Date(now - BUDGET_DAYS * 86400000).toISOString());
  const budgets = [...(await storage.list({ prefix: 'live_research_budget:' })).keys()].filter((key) => key.slice('live_research_budget:'.length) < oldestDay);
  await drop([...seen, ...budgets]);
  return { kept: kept.length, pruned_experiments: Math.max(0, retained.length - keep), removed_chunks: removed, removed_failures: Math.max(0, failed.length - FAILED_KEEP) };
}

/** Daily deterministic research on the existing hourly alarm, only while forward paper is on. */
export async function researchDue(storage, { now = Date.now(), ...options } = {}) {
  const state = await storage.get(LIVE_STATE);
  if (!state?.enabled) return { skipped: 'paper research is off' };
  const last = await storage.get(RESEARCH_ATTEMPT);
  const today = tradeDayOf(new Date(now).toISOString());
  if (((await storage.get(`live_research_budget:${today}`)) || []).length >= 2) return { skipped: 'daily research dataset budget reached' };
  if (last?.status === 'complete' && tradeDayOf(last.at) === today) return { skipped: 'research already recorded this research day' };
  if (last?.at && now - Date.parse(last.at) < 3600000) return { skipped: 'research retry cooldown' };
  return liveBacktest(storage, { now, ...options });
}

function unrealized(pf, lastClose) {
  const o = pf.open;
  if (!o || !Number.isFinite(lastClose)) return null;
  const pv = CONTRACTS[pf.contract].pointValue * pf.qty;
  const pts = o.side === 'short' ? o.entry.price - lastClose : lastClose - o.entry.price;
  return r2(pts * pv);
}

/** The engine's on/off state and feed label without its trades (for the connections view). */
export async function livePaperSummary(storage, now = Date.now()) {
  const [state, feed, portfolios] = await Promise.all([storage.get(LIVE_STATE), storage.get(LIVE_FEED), readLivePortfolios(storage)]);
  return { state: state || { enabled: false }, feed: feed ? { ...feed, bars: undefined } : null, contract: frontMonth(ROOT, now), portfolios: portfolios.length };
}

/** Everything the Trading Room shows, from records only. */
export async function liveDashboard(storage, { now = Date.now(), tradovateConnected = false } = {}) {
  const [state, feed, runs, portfolios, backtest] = await Promise.all([
    storage.get(LIVE_STATE), storage.get(LIVE_FEED), storage.get(LIVE_RUNS), readLivePortfolios(storage), storage.get(LIVE_BACKTEST),
  ]);
  const trades = await readTrades(storage, isLive);
  const delayedTraining = await readDelayedTraining(storage, { enabled: Boolean(state?.enabled) });
  const verifiedLive = trades.filter((t) => t.data?.entry_feed?.status === 'LIVE'
    && t.data.entry_feed.authenticated === true && t.data.entry_feed.subscription_verified === true);
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
    delayed_training: delayedTraining,
    verified_live_forward: { trades: verifiedLive.length, ...summarize(verifiedLive), source: 'authenticated subscribed LIVE CME at entry' },
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
    learning: await strategyLearning(storage, { now }),
  };
}
// Strategy evidence is projected from immutable records; it is never an order permission.
const entryIdentity = (t) => [t.contract, t.data?.resolution, t.strategy, t.side, t.entry?.time].join('|');
const outcomeIdentity = (t) => JSON.stringify([t.entry?.fill, t.exit?.time, t.exit?.fill, t.exit?.reason, t.net_pnl, t.r_net]);
const ordered = (list) => [...list].sort((a, b) => String(a.exit.time).localeCompare(String(b.exit.time)));
const emptySummary = () => summarize([]);

/** Learning cards keep one predeclared baseline per strategy; parameter experiments are never pooled. */
export async function strategyLearning(storage, { now = Date.now() } = {}) {
  const [records, state, feed, runs, portfolios, latest, lastSuccess, attempt] = await Promise.all([
    readTrades(storage, isLive), storage.get(LIVE_STATE), storage.get(LIVE_FEED), storage.get(LIVE_RUNS),
    readLivePortfolios(storage), storage.get(LIVE_BACKTEST), storage.get(RESEARCH_LAST), storage.get(RESEARCH_ATTEMPT),
  ]);
  const history = latest?.ok ? latest : lastSuccess;
  const today = tradeDayOf(new Date(now).toISOString());
  const current = cmeSession(now);
  const strategies = [];
  for (const [id, spec] of Object.entries(INTRADAY_CANDIDATES)) {
    const primary = freshPortfolio({ c: id, f: 'any', target_r: id === 'rsi-revert-5m' ? 1.5 : 2 });
    const all = records.filter((t) => t.strategy === id);
    const baseline = ordered(all.filter((t) => t.filter === 'any' && t.strategy_version === primary.strategy_version));
    const seen = new Set();
    const unique = baseline.filter((t) => { const key = entryIdentity(t); if (seen.has(key)) return false; seen.add(key); return true; });
    const forward = summarize(unique);
    const groups = new Map();
    for (const t of all) { const key = entryIdentity(t); const group = groups.get(key) || []; group.push(t); groups.set(key, group); }
    const duplicates = [...groups.values()].reduce((n, group) => n + group.length - new Set(group.map(outcomeIdentity)).size, 0);
    const correlated = [...groups.values()].filter((g) => new Set(g.map(outcomeIdentity)).size > 1).length;
    const daily = unique.filter((t) => tradeDayOf(t.exit.time) === today);
    const before = unique.filter((t) => tradeDayOf(t.exit.time) < today);
    const old = summarize(before);
    const research = (history?.rows || []).find((r) => r.strategy === id && r.filter === 'any' && r.strategy_version === primary.strategy_version);
    const hist = research?.stats || null; const oos = research?.oos || null;
    const historicalOk = hist?.trades >= MIN_TRADES && hist.expectancy_r > 0;
    const oosOk = oos?.trades >= MIN_TRADES && oos.expectancy_r_95ci?.low > 0 && (oos.profit_factor > 1.2 || (!oos.losses && oos.wins > 0)) && research.folds_positive / research.folds >= 0.6;
    const forwardOk = forward.trades >= MIN_TRADES && forward.expectancy_r_95ci.low > 0;
    const milestones = [
      { id: 'historical', label: 'Historical validation', status: historicalOk ? 'review' : 'blocked', detail: hist ? `${hist.trades} baseline historical outcomes; ${historicalOk ? 'positive result needs independent review' : '30 outcomes and positive after-cost expectancy not yet established'}` : 'No version-matched historical run recorded.' },
      { id: 'oos', label: 'Out-of-sample', status: oosOk ? 'review' : 'blocked', detail: oos ? `${oos.trades} held-out outcomes; ${research.folds_positive}/${research.folds} positive time folds. Parameter sweeps are exploratory; untouched holdout review is required.` : 'No purged time-split evaluation recorded.' },
      { id: 'forward', label: 'Forward paper', status: forwardOk ? 'review' : 'blocked', detail: `${forward.trades}/${MIN_TRADES} unique baseline trades. Reaching 30 alone never establishes readiness.` },
      { id: 'feed', label: 'Data and feed quality', status: 'blocked', detail: `${feed?.status || 'UNKNOWN'} feed; real-time entitlement, gaps and execution-grade prices must be verified.` },
      { id: 'risk', label: 'Drawdown and risk controls', status: 'blocked', detail: 'Owner risk budget, maximum tolerated drawdown, sizing, kill switch and broker risk tests need approval; no risk limit is invented.' },
      { id: 'broker', label: 'Broker compatibility', status: 'blocked', detail: 'MNQ execution integration and contract permissions are not certified. Alpaca stock paper orders do not qualify MNQ.' },
      { id: 'owner', label: 'Owner approval', status: 'blocked', detail: 'No live permission granted by this dashboard. Exact live orders require explicit owner approval.' },
    ];
    const statsToday = summarize(daily);
    let eq = 0;
    const equity = unique.map((t) => ({ time: t.exit.time, value: r2(eq += t.net_pnl) }));
    const pfs = portfolios.filter((p) => p.candidate === id);
    const counts = pfs.reduce((a, p) => ({ bars: a.bars + p.counts.bars, signals: a.signals + p.counts.signals, filled: a.filled + p.counts.filled, gap_skipped: a.gap_skipped + p.counts.gap_skipped }), { bars: 0, signals: 0, filled: 0, gap_skipped: 0 });
    strategies.push({ id, name: spec.name, rules: spec.rules, resolution: RESOLUTION, strategy_version: primary.strategy_version, params: primary.params,
      featured: id === 'ema-pullback-5m', secondary: id === 'vwap-revert-5m', forward, historical: hist, out_of_sample: oos,
      broker_paper: { status: 'not_attributed', trades: null, detail: 'Broker paper receipts are a separate ledger; no strategy attribution is assumed.' },
      live_execution: { status: 'disabled', trades: null },
      progress: { completed: forward.trades, target: MIN_TRADES, fraction: Math.min(1, forward.trades / MIN_TRADES) },
      stage: !forward.trades ? 'Awaiting forward setups' : forward.trades < MIN_TRADES ? 'Collecting forward evidence' : 'Sample reached; validation pending',
      live_ready: false, milestones, next_milestone: milestones.find((m) => m.status === 'blocked')?.label || 'Independent review',
      raw_records: all.length, duplicates, correlated_entries: correlated, excluded_from_baseline: all.length - baseline.length,
      variants: Object.entries(breakdown(all, (t) => `${t.filter}@${t.strategy_version}|${t.params?.target_r}R`)).map(([version, stats]) => ({ version, ...stats })),
      today: { ...statsToday, expectancy_change_r: before.length && daily.length ? r2(forward.expectancy_r - old.expectancy_r) : null,
        studied: history && tradeDayOf(history.at) === today ? research?.studied_today || 0 : 0 },
      equity: equity.slice(-200), recent_trades: unique.slice(-12).reverse(), counts,
      data_quality: [...new Set(unique.map((t) => t.data?.feed?.status || t.data?.label || 'UNKNOWN'))],
    });
  }
  strategies.sort((a, b) => (a.featured ? -2 : a.secondary ? -1 : 0) - (b.featured ? -2 : b.secondary ? -1 : 0) || a.name.localeCompare(b.name));
  const eligible = strategies.filter((r) => r.forward.trades >= MIN_TRADES).sort((a, b) => b.forward.expectancy_r - a.forward.expectancy_r);
  const last = runs?.at(-1);
  const diagnostics = { enabled: Boolean(state?.enabled), session: current, resolution: RESOLUTION,
    poll_seconds: current.open ? 60 : 900, last_run: last || null,
    scheduler: !state?.enabled ? 'off' : !last ? 'no recorded pass' : current.open && now - Date.parse(last.at) > 5 * 60000 ? 'overdue: inspect alarm or errors' : 'recent pass recorded',
    feed: feed ? { ...feed, bars: undefined } : null, errors: (runs || []).filter((r) => !r.ok).slice(-5),
    explanation: 'Only closed complete five-minute bars count. Delayed feeds, quiet setups, risk-size filters, session windows, one open position per portfolio and gap skips can limit growth. Signals are portfolio counts, not independent evidence.',
  };
  const research = { last_attempt: attempt?.at || latest?.at || null, attempt_status: attempt?.status || null, reused: Boolean(attempt?.reused), error: attempt?.status === 'failed' ? attempt.error : latest?.ok === false ? latest.error : null, last_success: history?.at || null,
    id: history?.id || null, dataset_hash: history?.dataset_hash || null, data: history?.data || null,
    target_per_strategy: MIN_TRADES, quota_met: strategies.every((r) => r.today.studied >= MIN_TRADES),
    note: 'Daily target, not a quota: no forced entries, timeframe changes or duplicate experiment samples. Historical and OOS overlap and are never summed. Public data availability/usage rights limit research.',
  };
  return { paper_only: true, day: today, timezone: 'CME research day, America/New_York 18:00 boundary', strategies, research, diagnostics,
    leader: eligible[0] ? { id: eligible[0].id, metric: 'forward baseline expectancy after costs', provisional: true } : null,
    daily_report: `${today}: ${strategies.reduce((n, r) => n + r.today.trades, 0)} unique baseline forward trades closed; ${strategies.reduce((n, r) => n + r.today.studied, 0)} outcomes in today's latest historical baseline. ${eligible[0] ? `Provisional forward expectancy leader: ${eligible[0].name}.` : 'No strategy has the minimum forward sample for a ranking.'} Live trading remains disabled.` };
}
