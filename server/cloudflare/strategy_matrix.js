// CHE Strategy Matrix (Trading Room V3, owner 2026-10-25): docs/CHE_TRADING_STRATEGY_V3.md.
//
// Every strategy × market × timeframe with its exact rules and its evidence: trades tested, out-of-sample samples,
// win rate, average win and loss, net P&L and expectancy after the stated costs, profit factor, drawdown, best and
// worst New York hours, data coverage and freshness, status (backtest / forward paper / live, and live is always
// disabled), confidence, and one plain sentence built from those numbers.
//
// A layer over the existing engine, never a second one: strategies are trading_evidence.INTRADAY_CANDIDATES plus
// V3_CANDIDATES, executed by stepPortfolio with its fills and costs; regimes and roll handling come from
// trading_research; the look-ahead audit is historical_intelligence.leakageAudit. The research runs on GitHub runners
// (tools/che_strategy_matrix.mjs) because this Worker's sandbox cannot reach the exchanges; the committed results
// (strategy_matrix_crypto.js, strategy_matrix_futures.js) are what the route serves. No number here is hand-written.
// Paper and research only: nothing in this file can place an order.
import { COSTS, etParts, intradayCandidate, intradayContext, newPortfolio, readTrades, stepPortfolio, summarize } from './trading_evidence.js';
import { classifyRegimes, rollGuard } from './trading_research.js';
import { leakageAudit } from './historical_intelligence.js';
import { MIN_SAMPLE, PAPER_LIMITS, SELECTION_LOG, rankStrategies, rowKey } from './paper_selection.js';
import CRYPTO_RESULTS from './strategy_matrix_crypto.js';
import FUTURES_RESULTS from './strategy_matrix_futures.js';

export const MATRIX_VERSION = 'matrix-v3.1';
export const TARGETS = Object.freeze([1.5, 2, 3]);
export const DEFAULT_TARGET = 2;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** The V3 strategy set: owner names → the engine's written rules. */
export const MATRIX_STRATEGIES = Object.freeze([
  { key: 'ema20-pullback', candidate: 'ema-pullback-5m', name: 'EMA 20 pullback', words: /\bema ?20\b|\b20 ?ema\b|pullback/ },
  { key: 'vwap-reversion', candidate: 'vwap-revert-5m', name: 'VWAP reversion', needs_volume: true, words: /vwap (?:reversion|revert|mean reversion)/ },
  { key: 'sweep-reclaim', candidate: 'sweep-reclaim-5m', name: 'Liquidity sweep and reclaim', words: /sweep|reclaim|liquidity/ },
  { key: 'opening-range-breakout', candidate: 'orb-15m', name: 'Opening range breakout', timeframes: ['5m', '15m'], words: /opening range|\borb\b/ },
  { key: 'breakout-retest', candidate: 'breakout-retest-5m', name: 'Trend breakout and retest', words: /retest/ },
  { key: 'momentum-continuation', candidate: 'momentum-cont-5m', name: 'Momentum continuation', words: /momentum continuation/ },
  { key: 'range-rejection', candidate: 'range-reject-5m', name: 'Range rejection', words: /range rejection|range reject/ },
  { key: 'volatility-squeeze', candidate: 'vol-squeeze-5m', name: 'Volatility contraction and expansion', words: /squeeze|volatility (?:expansion|contraction)|contraction (?:and|then) expansion/ },
]);
export const strategyByKey = (key) => MATRIX_STRATEGIES.find((s) => s.key === key) || null;

export const MARKETS = Object.freeze({
  BTC: { asset: 'crypto', name: 'Bitcoin (BTC-USD)', qty: 0.01, timeframes: ['5m', '15m', '1h'] },
  ETH: { asset: 'crypto', name: 'Ether (ETH-USD)', qty: 0.25, timeframes: ['5m', '15m', '1h'] },
  MNQ: { asset: 'futures', name: 'Micro E-mini Nasdaq-100 (MNQ)', qty: 1, timeframes: ['5m', '15m', '1h'] },
  NQ: { asset: 'futures', name: 'E-mini Nasdaq-100 (NQ)', qty: 1, timeframes: ['5m', '15m', '1h'] },
});

// Costs on every fill (trading_evidence.settleTrade). Futures: CHE's NORMAL profile per contract and side (1 tick of
// spread paid half per side, 1 tick of slippage on market orders and stops, commission and exchange/NFA fees); NQ adds
// the larger E-mini exchange fee. Crypto: Coinbase Exchange's lowest published tier, 0.60% taker on market orders and
// 0.40% maker on a resting target, plus spread and slippage (crypto_markets.CRYPTO_COSTS, repeated here so this module
// stays free of the paper desk). Planning numbers, not a broker statement: each result stores the model it used.
export const COST_MODELS = Object.freeze({
  MNQ: { ...COSTS, text: 'MNQ: 1 tick spread (0.25 pt = $0.50, half per side), 1 tick slippage per market order or stop, $1.50 commission + $0.50 exchange/NFA fees per side; about $5.50 per round turn.' },
  NQ: { ...COSTS, feePerSide: 1.4, text: 'NQ: 1 tick spread (0.25 pt = $5, half per side), 1 tick slippage per market order or stop, $1.50 commission + $1.40 exchange/NFA fees per side; about $20.80 per round turn.' },
  BTC: { spreadTicks: 100, slippageTicks: 200, commissionPerSide: 0, feePerSide: 0, takerPct: 0.006, makerPct: 0.004, text: 'BTC: Coinbase 0.60% taker on entries, stops and time exits, 0.40% maker on targets, $1 spread and $2 slippage per side (per coin).' },
  ETH: { spreadTicks: 10, slippageTicks: 10, commissionPerSide: 0, feePerSide: 0, takerPct: 0.006, makerPct: 0.004, text: 'ETH: Coinbase 0.60% taker on entries, stops and time exits, 0.40% maker on targets, $0.10 spread and $0.10 slippage per side (per coin).' },
});
const costsOf = (market) => { const { text, ...c } = COST_MODELS[market]; return c; };

// ─── Walk-forward windows ────────────────────────────────────────────────────

/**
 * Rolling walk-forward over bar times: `units` equal slices; each window trains on `train` consecutive slices and
 * tests on the next `test` slice; the window then moves forward by one test slice. Train always ends where its test
 * starts, so no bar is in both.
 */
export function rollingWindows(times, { units = 8, train = 3, test = 1 } = {}) {
  const n = times.length;
  const size = Math.floor(n / units);
  if (size < 2) return [];
  const out = [];
  for (let w = 0; w + train + test <= units; w++) {
    const a = w * size; const b = (w + train) * size; const c = Math.min(n, (w + train + test) * size);
    out.push({ window: w + 1, train_from: times[a], train_to: times[b], test_from: times[b], test_to: c >= n ? null : times[c] });
  }
  return out;
}
const inTrain = (t, w) => t.entry.time >= w.train_from && t.exit.time < w.train_to; // purged: a train trade must close before the test starts
const inTest = (t, w) => t.entry.time >= w.test_from && (w.test_to == null || t.entry.time < w.test_to);

/** The target chosen on a window's training trades only: highest expectancy with at least 10 trades, else the default. */
export function chooseTarget(byTarget, w) {
  let best = DEFAULT_TARGET; let bestE = -Infinity;
  for (const R of TARGETS) {
    const tr = byTarget[R].filter((t) => inTrain(t, w));
    if (tr.length < 10) continue;
    const e = tr.reduce((a, t) => a + t.r_net, 0) / tr.length;
    if (e > bestE + 1e-9) { bestE = e; best = R; }
  }
  return best;
}

// ─── Research on one series ─────────────────────────────────────────────────

const lite = (s) => ({
  trades: s.trades, win_rate: s.win_rate, avg_winner: s.avg_winner, avg_loser: s.avg_loser, risk_reward: s.risk_reward, net_pnl: s.net_pnl,
  expectancy_dollars: s.expectancy_dollars, expectancy_r: s.expectancy_r, expectancy_r_95ci: s.expectancy_r_95ci, profit_factor: s.profit_factor,
  max_drawdown: s.max_drawdown, max_drawdown_r: s.max_drawdown_r, costs_paid: s.costs_paid,
});
const etHour = (time) => Math.floor(etParts(time).mins / 60);
function hourTable(trades, min = 8) {
  const g = {};
  for (const t of trades) (g[etHour(t.entry.time)] ||= []).push(t.r_net);
  const rows = Object.entries(g).filter(([, rs]) => rs.length >= min).map(([h, rs]) => ({ hour: Number(h), trades: rs.length, expectancy_r: r4(rs.reduce((a, x) => a + x, 0) / rs.length) }));
  rows.sort((a, b) => b.expectancy_r - a.expectancy_r);
  return { best: rows[0] || null, worst: rows.length > 1 ? rows.at(-1) : null, min_trades: min };
}

/**
 * One strategy on one series. `bars` are closed, verified bars; `rolls` are futures roll dates (trades across a roll
 * are excluded). Parameters (the target in R) are chosen on each window's training part only; the out-of-sample
 * result is every test window's trades under the target chosen before that window.
 */
export function researchStrategy(spec, { market, tf, bars, ctx = null, regimes = null, rolls = [], audit = true }) {
  const base = { strategy: spec.key, candidate: spec.candidate, name: spec.name, rules: intradayCandidate(spec.candidate)?.rules || '', market, asset: MARKETS[market].asset, tf };
  if (spec.timeframes && !spec.timeframes.includes(tf)) return { ...base, status: 'not_applicable', reason: `${spec.name} is defined on ${spec.timeframes.join(' and ')} bars only: a ${tf} bar is longer than the 15-minute opening range` };
  if (spec.needs_volume) {
    const withVol = bars.filter((b) => Number(b.v) > 0).length / (bars.length || 1);
    if (withVol < 0.9) return { ...base, status: 'not_applicable', reason: `VWAP needs real traded volume: only ${Math.round(withVol * 100)}% of these bars carry volume` };
  }
  const x = ctx || intradayContext(bars);
  const g = regimes || classifyRegimes(bars);
  const run = (R, candles = bars, c = x) => {
    const pf = newPortfolio(spec.candidate, 'any', { contract: market, qty: MARKETS[market].qty, source: 'backtest', resolution: tf, priceSeries: `${market} ${tf} research`, costs: costsOf(market), params: { target_r: R } });
    const trades = stepPortfolio(pf, candles, c);
    return rolls.length ? rollGuard(trades, candles, { rolls: rolls.map((roll) => ({ roll })) }).kept : trades;
  };
  const byTarget = Object.fromEntries(TARGETS.map((R) => [R, run(R)]));
  const full = byTarget[DEFAULT_TARGET];
  const windows = rollingWindows(bars.map((b) => b.t));
  const oos = []; const wf = [];
  for (const w of windows) {
    const R = chooseTarget(byTarget, w);
    const test = byTarget[R].filter((t) => inTest(t, w));
    oos.push(...test);
    const s = summarize(test);
    wf.push({ ...w, chosen_target_r: R, train_trades: byTarget[R].filter((t) => inTrain(t, w)).length, test_trades: s.trades, test_expectancy_r: s.expectancy_r, test_net_pnl: s.net_pnl });
  }
  const so = summarize(oos);
  const index = new Map(bars.map((b, i) => [b.t, i]));
  const vol = {};
  for (const t of oos) (vol[g[index.get(t.signal.time)]?.volatility || 'unknown'] ||= []).push(t.r_net);
  const regimesOut = Object.entries(vol).map(([key, rs]) => ({ key, trades: rs.length, expectancy_r: r4(rs.reduce((a, v) => a + v, 0) / rs.length) }));
  const counted = regimesOut.filter((r) => r.key !== 'unknown' && r.trades >= 8);
  const recent = oos.slice(Math.floor(oos.length * 2 / 3));
  const rs = summarize(recent);
  const gross = oos.length ? r4(oos.reduce((a, t) => a + t.r_gross, 0) / oos.length) : null;
  let look = 'not run';
  if (audit) {
    const sample = bars.length > 4000 ? bars.slice(-4000) : bars;
    const res = leakageAudit(sample, (candles) => run(DEFAULT_TARGET, candles, intradayContext(candles)));
    look = res.ok ? 'passed' : res.reason === 'too few bars to audit' ? 'not enough bars' : 'FAILED';
  }
  const row = {
    ...base, status: 'ok', trades_tested: full.length, qualified_samples: so.trades,
    full: lite(summarize(full)), oos: lite(so), gross_expectancy_r: gross,
    walk_forward: { method: 'rolling: 8 equal slices, train 3, test the next 1, step 1; target chosen on train only (1.5R, 2R or 3R)', windows: wf, folds: wf.length, folds_positive: wf.filter((w) => w.test_trades && w.test_net_pnl > 0).length },
    hours: { ...hourTable(full), basis: `full period at ${DEFAULT_TARGET}R, entry hour in New York time` },
    regimes: regimesOut, regime_stability: counted.length ? r2(counted.filter((r) => r.expectancy_r > 0).length / counted.length) : null,
    recent_oos: { trades: rs.trades, expectancy_r: rs.expectancy_r }, look_ahead: look,
  };
  row.confidence = confidenceOf(row);
  return row;
}

/** high / moderate / low / insufficient sample, from out-of-sample evidence only. */
export function confidenceOf(row) {
  const o = row.oos;
  if (!(o?.trades >= MIN_SAMPLE)) return 'insufficient sample';
  const folds = row.walk_forward.folds ? row.walk_forward.folds_positive / row.walk_forward.folds : 0;
  if (o.trades >= 100 && o.expectancy_r_95ci?.low > 0 && folds >= 0.6 && row.look_ahead === 'passed' && (row.regime_stability ?? 0) >= 2 / 3) return 'high';
  if (o.expectancy_r > 0 && folds >= 0.5 && row.look_ahead !== 'FAILED') return 'moderate';
  return 'low';
}

/** Every V3 strategy on one series. */
export function researchSeries({ market, tf, bars, rolls = [], audit = true }) {
  const ctx = intradayContext(bars);
  const regimes = classifyRegimes(bars);
  return MATRIX_STRATEGIES.map((spec) => researchStrategy(spec, { market, tf, bars, ctx, regimes, rolls, audit }));
}

// ─── Plain language, from the numbers ────────────────────────────────────────

const TF_WORDS = { '5m': '5-minute', '15m': '15-minute', '1h': 'hourly' };
const hourWords = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const money = (x) => `${x < 0 ? 'minus ' : ''}$${Math.abs(x).toFixed(2)}`;
/** One sentence per row, generated only from the row's own numbers. */
export function sentenceFor(row) {
  const where = `${row.name} on ${row.market} ${TF_WORDS[row.tf] || row.tf} bars`;
  if (row.status !== 'ok') return `${where}: not tested. ${row.reason}.`;
  const o = row.oos;
  if (!(o.trades >= MIN_SAMPLE)) return `${where}: ${o.trades} out-of-sample trades from ${row.trades_tested} tested, an insufficient sample, so it is not ranked.`;
  const hrs = row.hours.best ? ` Best New York hour ${hourWords(row.hours.best.hour)} (${row.hours.best.expectancy_r}R)${row.hours.worst ? `, worst ${hourWords(row.hours.worst.hour)} (${row.hours.worst.expectancy_r}R)` : ''}.` : '';
  return `${where}: ${o.trades} out-of-sample trades after costs, ${o.win_rate}% winners, average win ${money(o.avg_winner)}, average loss ${money(Math.abs(o.avg_loser))}, net ${money(o.net_pnl)}, ${o.expectancy_r}R per trade, profit factor ${o.profit_factor ?? 'n/a'}, worst drawdown ${money(o.max_drawdown)}.${hrs} Confidence ${row.confidence}.`;
}

// ─── The matrix view (route and voice) ───────────────────────────────────────

function freshness(set, now) {
  if (!set?.generated_at) return { state: 'no run yet' };
  const ageH = (now - Date.parse(set.generated_at)) / 3_600_000;
  return { state: ageH <= 48 ? 'fresh' : ageH <= 24 * 8 ? 'aging' : 'stale', age_hours: Math.round(ageH), generated_at: set.generated_at };
}
function paperOf(trades) {
  const by = {};
  for (const t of trades) {
    const spec = MATRIX_STRATEGIES.find((s) => s.candidate === t.strategy);
    if (!spec || t.source !== 'paper') continue;
    (by[rowKey(spec.key, t.contract, t.data?.resolution || '5m')] ||= []).push(t);
  }
  return Object.fromEntries(Object.entries(by).map(([k, list]) => { const s = summarize(list); return [k, { trades: s.trades, expectancy_r: s.expectancy_r, expectancy_r_95ci: s.expectancy_r_95ci, net_pnl: s.net_pnl }]; }));
}

/**
 * The matrix as the route and the app read it. `sets` default to the committed research results; forward-paper
 * results come from the shared journal when `storage` is given. Live status is always "disabled".
 */
export async function strategyMatrixView(storage = null, { now = Date.now(), sets = [CRYPTO_RESULTS, FUTURES_RESULTS], market = null } = {}) {
  let paper = {};
  if (storage) {
    try { paper = paperOf(await readTrades(storage, () => true, { market: 'all' })); } catch (_) { paper = {}; }
  }
  const groups = sets.map((s, i) => ({ group: i === 0 ? 'crypto' : 'futures', set: s }));
  const ranked = rankStrategies(groups.flatMap((g) => g.set?.rows || []), paper);
  const rows = ranked.filter((r) => !market || r.row.market === market).map((r) => ({
    ...r.row, key: r.key, tier: r.tier, paper_priority: r.priority, score: r.score, reasons: r.reasons,
    status_detail: { backtest: 'tested', forward_paper: paper[r.key] ? `${paper[r.key].trades} paper trades, ${paper[r.key].expectancy_r}R per trade` : 'no paper trades yet', live: 'disabled' },
    paper: paper[r.key] || null, sentence: sentenceFor(r.row),
  }));
  const best = {};
  for (const m of Object.keys(MARKETS)) best[m] = rows.find((r) => r.market === m && r.tier === 'ranked' && r.oos.expectancy_r > 0)?.key || null;
  let log = [];
  if (storage) { try { log = ((await storage.get(SELECTION_LOG)) || []).slice(-40); } catch (_) { log = []; } }
  return {
    version: MATRIX_VERSION, paper_only: true, live: 'disabled',
    note: 'Research and paper only. Live trading is disabled and no order can be placed from this matrix. Past results do not promise future profit.',
    groups: groups.map(({ group, set }) => ({ group, run: set ? { generated_at: set.generated_at, run_id: set.run_id, run_url: set.run_url, commit: set.commit, engine: set.engine } : null, coverage: set?.coverage || [], freshness: freshness(set, now), pending: !set })),
    cost_models: Object.fromEntries(Object.entries(COST_MODELS).map(([m, c]) => [m, c.text])),
    strategies: MATRIX_STRATEGIES.map((s) => ({ key: s.key, name: s.name, rules: intradayCandidate(s.candidate)?.rules || '', timeframes: s.timeframes || ['5m', '15m', '1h'] })),
    limits: { ...PAPER_LIMITS, min_sample: MIN_SAMPLE },
    best, rows, selection_log: log,
  };
}

// ─── Voice ───────────────────────────────────────────────────────────────────

const MARKET_WORDS = [[/\b(?:btc|bitcoin)\b/, 'BTC'], [/\b(?:eth|ether|ethereum)\b/, 'ETH'], [/\bmnq\b|micro nasdaq/, 'MNQ'], [/\bnq\b|e-?mini nasdaq|nasdaq futures/, 'NQ']];
/** "What's the best strategy for BTC", "explain the EMA 20 pullback", "read the strategy matrix". Null otherwise. */
export function strategyMatrixIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^(?:hey |ok |okay )?(?:che|chey|chay)[,:]?\s*/, '').trim();
  if (/\b(?:read|show|open|what(?:'s| is) (?:in|on)) (?:me )?(?:the |my )?strategy matrix\b/.test(t)) return { kind: 'summary' };
  const best = /\b(?:best|top|strongest|most profitable) (?:trading )?strateg(?:y|ies)\b[^?]*?\b(?:for|on|in|with) (?:the )?([a-z0-9 -]{2,24})/.exec(t)
    || /\b(?:which|what) strateg(?:y|ies) (?:is|are|works?|performs?) (?:the )?best (?:for|on|in|with) (?:the )?([a-z0-9 -]{2,24})/.exec(t);
  if (best) {
    const words = best[1];
    const market = MARKET_WORDS.find(([re]) => re.test(words))?.[1] || null;
    if (market) return { kind: 'best', market };
    if (/\bcrypto\b/.test(words)) return { kind: 'best', group: 'crypto' };
    if (/\bfutures\b/.test(words)) return { kind: 'best', group: 'futures' };
  }
  const ex = /\b(?:explain|describe) (?:the )?(.{3,60}?)(?: strategy| setup)?\??$/.exec(t) || /\bhow does (?:the )?(.{3,60}?) (?:strategy |setup )?work\??$/.exec(t)
    || /\bwhat(?:'s| is) (?:the )?(.{3,60}?) (?:strategy|setup)\??$/.exec(t);
  if (ex) {
    const spec = MATRIX_STRATEGIES.find((s) => s.words.test(ex[1]));
    if (spec) return { kind: 'explain', key: spec.key, market: MARKET_WORDS.find(([re]) => re.test(ex[1]))?.[1] || null };
  }
  return null;
}

/** The spoken answer, from the matrix view only. */
export function speakStrategyMatrix(ask, view) {
  const pending = view.groups.filter((g) => g.pending).map((g) => g.group);
  const noRun = (what) => `No real research run has finished for ${what} yet, sir, so I have no verified numbers to rank. The research runs on GitHub with public data and its results arrive with the next run.`;
  if (ask.kind === 'explain') {
    const s = view.strategies.find((x) => x.key === ask.key);
    const rows = view.rows.filter((r) => r.strategy === ask.key && (!ask.market || r.market === ask.market) && r.status === 'ok');
    const tested = rows.filter((r) => r.tier === 'ranked').sort((a, b) => b.oos.expectancy_r - a.oos.expectancy_r);
    const evidence = tested.length ? ` Best tested: ${tested[0].sentence}` : rows.length ? ` ${rows.length} market and timeframe combinations were tested; none has the ${view.limits.min_sample} out-of-sample trades needed to rank yet.` : ' It has no research results yet.';
    return `${s.name}. Rules: ${s.rules}${evidence} Paper only; live trading is disabled.`;
  }
  if (ask.kind === 'best') {
    const group = ask.group || (MARKETS[ask.market]?.asset);
    if (pending.includes(group)) return noRun(ask.market || group);
    const pool = view.rows.filter((r) => (ask.market ? r.market === ask.market : r.asset === group));
    const top = pool.filter((r) => r.tier === 'ranked' && r.oos.expectancy_r > 0);
    if (!top.length) {
      const insufficient = pool.filter((r) => r.tier === 'insufficient sample').length;
      const demoted = pool.filter((r) => r.tier === 'demoted').length;
      return `No strategy on ${ask.market || group} has a positive out-of-sample result after costs with enough trades, sir. ${insufficient} combinations have an insufficient sample and ${demoted} are demoted by the written rules. I will keep paper testing; nothing is traded live.`;
    }
    const list = top.slice(0, 3).map((r, i) => `${i + 1}. ${r.sentence}`).join(' ');
    return `Best supported on ${ask.market || group}, ranked by out-of-sample expectancy after costs, drawdown, sample and stability, not win rate: ${list} Paper only; live trading is disabled.`;
  }
  const lines = ['Strategy matrix, paper and research only, live disabled.'];
  for (const g of view.groups) lines.push(g.pending ? `${g.group}: no real run yet.` : `${g.group}: run ${g.run.run_id} at ${g.run.generated_at}, ${g.freshness.state}.`);
  for (const [m, key] of Object.entries(view.best)) lines.push(key ? `${m}: best supported ${view.rows.find((r) => r.key === key).name} on ${key.split('|')[2]}.` : `${m}: no ranked strategy with a positive out-of-sample result.`);
  return lines.join(' ');
}
